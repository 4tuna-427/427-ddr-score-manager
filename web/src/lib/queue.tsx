import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { addQueueItem, deleteQueueItem, listQueueItems, updateQueueItem, type QueueItem } from './db'
import { convertImage } from './image'
import { analyzeImage, ApiError, type AnalyzeResult } from './api'
import { addErrorLog } from './errorlog'
import { estimateCaptureDate } from './exif'

interface QueueContextValue {
  items: QueueItem[]
  processing: boolean
  lastResults: AnalyzeResult[]
  /** Labels (song title or file name) of uploads skipped as non-detail tabs. */
  lastSkips: string[]
  bulkMode: boolean
  setBulkMode: (v: boolean) => void
  refresh: () => Promise<void>
  enqueue: (file: Blob, name: string, source: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** manual=true (the retry button) may always resume 'quota' items;
   *  automatic runs leave them alone until the JST date changes. */
  processNow: (opts?: { includeErrors?: boolean; manual?: boolean }) => Promise<void>
  clearResults: () => void
}

const BULK_MODE_KEY = 'ddr.bulkMode'
const QUOTA_STOPPED_DATE_KEY = 'ddr.quotaStoppedDate'
/** Pause between items in bulk mode, to stay well under the RPM limit. */
const BULK_INTERVAL_MS = 6500

/** Today's date (YYYY-MM-DD) in JST (UTC+9, no DST). */
export function jstTodayString(now: number = Date.now()): string {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

function quotaStoppedToday(): boolean {
  try {
    return localStorage.getItem(QUOTA_STOPPED_DATE_KEY) === jstTodayString()
  } catch {
    return false
  }
}

function markQuotaStopped(): void {
  try {
    localStorage.setItem(QUOTA_STOPPED_DATE_KEY, jstTodayString())
  } catch {
    /* storage unavailable */
  }
}

const Ctx = createContext<QueueContextValue | null>(null)

export function useQueue(): QueueContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useQueue outside provider')
  return v
}

export function QueueProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<QueueItem[]>([])
  const [processing, setProcessing] = useState(false)
  const [lastResults, setLastResults] = useState<AnalyzeResult[]>([])
  const [lastSkips, setLastSkips] = useState<string[]>([])
  const [bulkMode, setBulkModeState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BULK_MODE_KEY) === '1'
    } catch {
      return false
    }
  })
  const runningRef = useRef(false)

  const setBulkMode = useCallback((v: boolean) => {
    setBulkModeState(v)
    try {
      localStorage.setItem(BULK_MODE_KEY, v ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      setItems(await listQueueItems())
    } catch {
      /* IndexedDB unavailable */
    }
  }, [])

  const processNow = useCallback(async (opts?: { includeErrors?: boolean; manual?: boolean }) => {
    if (runningRef.current) return
    if (!navigator.onLine) return
    const includeErrors = opts?.includeErrors ?? true
    runningRef.current = true
    setProcessing(true)
    try {
      const attempted = new Set<string>()
      // 'quota' items (stopped by today's free-quota exhaustion) are only
      // eligible on a manual run, or automatically once the JST date has
      // changed since the stop was recorded.
      const quotaEligible = opts?.manual === true || !quotaStoppedToday()
      const isEligible = (i: QueueItem) =>
        (i.status === 'pending' ||
          (includeErrors && i.status === 'error') ||
          (quotaEligible && i.status === 'quota')) &&
        !attempted.has(i.id)
      for (;;) {
        const list = await listQueueItems()
        setItems(list)
        const next = list.find(isEligible)
        if (!next) break
        attempted.add(next.id)
        const sending: QueueItem = { ...next, status: 'sending', error: undefined }
        await updateQueueItem(sending)
        let quotaStop = false
        try {
          // Capture time from the ORIGINAL photo (EXIF) before resizing,
          // because the resize step strips metadata.
          const captured = await estimateCaptureDate(next.blob, next.createdAt)
          const converted = await convertImage(next.blob)
          const result = await analyzeImage(converted, next.source || 'upload', captured.toISOString(), bulkMode)
          await deleteQueueItem(next.id)
          if ('skipped' in result) {
            // Not a detail-result photo: nothing registered, not an error.
            setLastSkips((prev) => [result.song_title ?? next.name, ...prev])
          } else {
            setLastResults((prev) => [result, ...prev])
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            // Same image already registered: park it, never auto-retry.
            const dup: QueueItem = { ...next, status: 'duplicate', error: '同じ画像が既に登録されています' }
            await updateQueueItem(dup)
          } else if (e instanceof ApiError && e.status === 429) {
            // Daily free quota exhausted on every model: park this item
            // as 'quota' and stop the whole run. Remaining items stay
            // untouched; automatic runs will not retry them today.
            addErrorLog(next.name, e)
            const stopped: QueueItem = {
              ...next,
              status: 'quota',
              error: '本日の無料枠を使い切りました（明日以降に自動再開します）',
            }
            await updateQueueItem(stopped)
            markQuotaStopped()
            quotaStop = true
          } else {
            // Keep the queue label generic; the full detail goes to the
            // error log (Settings screen) instead of the Home screen.
            addErrorLog(next.name, e)
            const failed: QueueItem = {
              ...next,
              status: 'error',
              error: '送信に失敗しました（詳細は設定画面のエラーログに記録）',
            }
            await updateQueueItem(failed)
          }
        }
        const after = await listQueueItems()
        setItems(after)
        if (quotaStop) break
        // Bulk mode: pace the sends (about 9/min at most, and each call
        // also spends a few seconds in Gemini). Skip the pause when
        // nothing eligible remains.
        if (bulkMode && after.some(isEligible)) {
          await new Promise((r) => setTimeout(r, BULK_INTERVAL_MS))
        }
      }
    } finally {
      runningRef.current = false
      setProcessing(false)
      refresh()
    }
  }, [refresh, bulkMode])

  useEffect(() => {
    refresh().then(() => processNow())
    const onOnline = () => processNow()
    window.addEventListener('online', onOnline)
    // Pick up items written by the Service Worker (share target) while the app is open.
    // Poll pending items only; error items wait for online recovery or manual retry.
    const timer = window.setInterval(() => {
      refresh().then(() => processNow({ includeErrors: false }))
    }, 5000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.clearInterval(timer)
    }
  }, [refresh, processNow])

  const enqueue = useCallback(
    async (file: Blob, name: string, source: string) => {
      await addQueueItem(file, name, source)
      await refresh()
      processNow()
    },
    [refresh, processNow],
  )

  const remove = useCallback(
    async (id: string) => {
      await deleteQueueItem(id)
      await refresh()
    },
    [refresh],
  )

  const clearResults = useCallback(() => {
    setLastResults([])
    setLastSkips([])
  }, [])

  return (
    <Ctx.Provider value={{ items, processing, lastResults, lastSkips, bulkMode, setBulkMode, refresh, enqueue, remove, processNow, clearResults }}>
      {children}
    </Ctx.Provider>
  )
}
