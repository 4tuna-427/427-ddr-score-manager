/**
 * Local error log (this device only). Send/analyze failures are recorded
 * here with their full detail so the UI itself can stay terse; the log is
 * viewable and deletable from the Settings screen. Entries older than
 * 30 days are dropped automatically and the log is capped at 100 entries.
 */
export interface ErrorLogEntry {
  id: string
  at: number
  context: string
  message: string
}

const KEY = 'ddr.errorlog'
const MAX_ENTRIES = 100
const MAX_AGE_MS = 30 * 24 * 3600 * 1000

function load(): ErrorLogEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function prune(entries: ErrorLogEntry[]): ErrorLogEntry[] {
  const cutoff = Date.now() - MAX_AGE_MS
  return entries.filter((e) => e.at >= cutoff).slice(0, MAX_ENTRIES)
}

function save(entries: ErrorLogEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    /* storage full/unavailable: the log is best-effort */
  }
}

export function addErrorLog(context: string, err: unknown) {
  const entry: ErrorLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    context,
    message: err instanceof Error ? err.message : String(err),
  }
  save(prune([entry, ...load()]))
}

export function listErrorLogs(): ErrorLogEntry[] {
  const entries = prune(load())
  save(entries)
  return entries
}

export function removeErrorLog(id: string) {
  save(load().filter((e) => e.id !== id))
}

export function clearErrorLogs() {
  save([])
}
