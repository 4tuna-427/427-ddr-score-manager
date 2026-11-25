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
  refresh: () => Promise<void>
  enqueue: (file: Blob, name: string, source: string) => Promise<void>
  remove: (id: string) => Promise<void>
  processNow: (opts?: { includeErrors?: boolean }) => Promise<void>
  clearResults: () => void
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
  const runningRef = useRef(false)

  const refresh = useCallback(async () => {
    try {
      setItems(await listQueueItems())
    } catch {
      /* IndexedDB unavailable */
    }
  }, [])

  const processNow = useCallback(async (opts?: { includeErrors?: boolean }) => {
    if (runningRef.current) return
    if (!navigator.onLine) return
    const includeErrors = opts?.includeErrors ?? true
    runningRef.current = true
    setProcessing(true)
    try {
      const attempted = new Set<string>()
      for (;;) {
        const list = await listQueueItems()
        setItems(list)
        const next = list.find(
          (i) => (i.status === 'pending' || (includeErrors && i.status === 'error')) && !attempted.has(i.id),
        )
        if (!next) break
        attempted.add(next.id)
        const sending: QueueItem = { ...next, status: 'sending', error: undefined }
        await updateQueueItem(sending)
        try {
          // Capture time from the ORIGINAL photo (EXIF) before resizing,
          // because the resize step strips metadata.
          const captured = await estimateCaptureDate(next.blob, next.createdAt)
          const converted = await convertImage(next.blob)
          const result = await analyzeImage(converted, next.source || 'upload', captured.toISOString())
          await deleteQueueItem(next.id)
          setLastResults((prev) => [result, ...prev])
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            // Same image already registered: park it, never auto-retry.
            const dup: QueueItem = { ...next, status: 'duplicate', error: '同じ画像が既に登録されています' }
            await updateQueueItem(dup)
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
        setItems(await listQueueItems())
      }
    } finally {
      runningRef.current = false
      setProcessing(false)
      refresh()
    }
  }, [refresh])

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

  const clearResults = useCallback(() => setLastResults([]), [])

  return (
    <Ctx.Provider value={{ items, processing, lastResults, refresh, enqueue, remove, processNow, clearResults }}>
      {children}
    </Ctx.Provider>
  )
}
