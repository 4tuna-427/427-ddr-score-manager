import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useNavigationType } from 'react-router-dom'

interface CacheEntry<T = unknown> {
  version: number
  data: T
}

let dataVersion = 0
const listeners = new Set<() => void>()
const pageCache = new Map<string, CacheEntry>()
const scrollCache = new Map<string, number>()

export function getDataVersion(): number {
  return dataVersion
}

export function bumpDataVersion(): void {
  dataVersion += 1
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeDataVersion(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useDataVersion(): number {
  return useSyncExternalStore(subscribeDataVersion, getDataVersion)
}

export function getPageCache<T>(key: string): CacheEntry<T> | undefined {
  return pageCache.get(key) as CacheEntry<T> | undefined
}

export function setPageCache<T>(key: string, data: T, version: number = dataVersion): void {
  pageCache.set(key, { version, data })
}

export function clearDataCache(): void {
  pageCache.clear()
  scrollCache.clear()
  bumpDataVersion()
}

/**
 * Saves scrollY continuously via scroll listener (once initial restoration completes)
 * and restores it on POP navigation once content is ready.
 * On non-POP navigation (e.g. tab tap), resets scroll to top.
 */
export function useScrollRestore(key: string, ready: boolean): void {
  const navType = useNavigationType()
  const restoredRef = useRef(false)
  const canSaveRef = useRef(false)

  useEffect(() => {
    if (restoredRef.current || !ready) return
    restoredRef.current = true
    if (navType !== 'POP') {
      window.scrollTo(0, 0)
      scrollCache.set(key, 0)
      canSaveRef.current = true
      return
    }
    const y = scrollCache.get(key)
    if (y == null) {
      canSaveRef.current = true
      return
    }
    const id = requestAnimationFrame(() => {
      window.scrollTo(0, y)
      canSaveRef.current = true
    })
    return () => cancelAnimationFrame(id)
  }, [key, navType, ready])

  useEffect(() => {
    const onScroll = () => {
      if (canSaveRef.current) {
        scrollCache.set(key, window.scrollY)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
    }
  }, [key])
}

/**
 * Refetches paginated items up to at least `targetCount` in `pageSize` chunks.
 */
export async function fetchUpToCount<T>(
  fetchChunk: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  targetCount: number,
  pageSize = 50,
): Promise<{ items: T[]; total: number }> {
  const items: T[] = []
  let total = 0
  const goal = Math.max(pageSize, targetCount)
  for (let offset = 0; offset < goal; ) {
    const res = await fetchChunk(offset, pageSize)
    total = res.total
    if (res.items.length === 0) break
    items.push(...res.items)
    offset += res.items.length
    if (items.length >= total) break
  }
  return { items, total }
}
