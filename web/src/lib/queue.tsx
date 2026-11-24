import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { addQueueItem, deleteQueueItem, listQueueItems, updateQueueItem, type QueueItem } from './db'
import { convertImage } from './image'
import { analyzeImage, type AnalyzeResult } from './api'

interface QueueContextValue {
  items: QueueItem[]
  processing: boolean
  lastResults: AnalyzeResult[]
  refresh: () => Promise<void>
  enqueue: (file: Blob, name: string, source: string) => Promise<void>
  remove: (id: string) => Promise<void>
  processNow: () => Promise<void>
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

  const processNow = useCallback(async () => {
    if (runningRef.current) return
    if (!navigator.onLine) return
    runningRef.current = true
    setProcessing(true)
    try {
      const attempted = new Set<string>()
      for (;;) {
        const list = await listQueueItems()
        setItems(list)
        const next = list.find((i) => i.status !== 'sending' && !attempted.has(i.id))
        if (!next) break
        attempted.add(next.id)
        const sending: QueueItem = { ...next, status: 'sending', error: undefined }
        await updateQueueItem(sending)
        try {
          const converted = await convertImage(next.blob)
          const result = await analyzeImage(converted, next.source || 'upload')
          await deleteQueueItem(next.id)
          setLastResults((prev) => [result, ...prev])
        } catch (e) {
          const failed: QueueItem = {
            ...next,
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
          }
          await updateQueueItem(failed)
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
    const timer = window.setInterval(() => {
      refresh().then(() => processNow())
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
