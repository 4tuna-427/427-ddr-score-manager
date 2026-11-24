// IndexedDB send-queue. Same DB/store names as public/share-sw.js so files
// saved by the Service Worker (Share Target) appear in this queue.
export const DB_NAME = 'ddr-score-manager'
export const STORE = 'queue'

export interface QueueItem {
  id: string
  blob: Blob
  name: string
  type: string
  createdAt: number
  status: 'pending' | 'sending' | 'error' | 'duplicate'
  source: string
  error?: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export async function addQueueItem(blob: Blob, name: string, source: string): Promise<QueueItem> {
  const item: QueueItem = {
    id: newId(),
    blob,
    name,
    type: blob.type || 'image/jpeg',
    createdAt: Date.now(),
    status: 'pending',
    source,
  }
  await tx('readwrite', (s) => s.put(item))
  return item
}

export async function listQueueItems(): Promise<QueueItem[]> {
  const items = await tx<QueueItem[]>('readonly', (s) => s.getAll() as IDBRequest<QueueItem[]>)
  return (items || []).sort((a, b) => a.createdAt - b.createdAt)
}

export async function updateQueueItem(item: QueueItem): Promise<void> {
  await tx('readwrite', (s) => s.put(item))
}

export async function deleteQueueItem(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}
