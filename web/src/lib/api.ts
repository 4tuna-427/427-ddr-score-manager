// API client per docs/API.md. Base URL and token come from localStorage (Settings page).
const TOKEN_KEY = 'ddr.apiToken'
const BASE_KEY = 'ddr.apiBaseUrl'

export function getApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}
export function setApiToken(v: string): void {
  localStorage.setItem(TOKEN_KEY, v)
}
export function getApiBaseUrl(): string {
  return localStorage.getItem(BASE_KEY) || ''
}
export function setApiBaseUrl(v: string): void {
  localStorage.setItem(BASE_KEY, v.replace(/\/$/, ''))
}

export interface Score {
  id: string
  chart_id: string | null
  song_id: string | null
  raw_title: string | null
  play_style: string
  difficulty: string
  level: number | null
  score: number
  ex_score: number | null
  rank: string | null
  clear_lamp: string | null
  flare_rank: string | null
  marvelous: number | null
  perfect: number | null
  great: number | null
  good: number | null
  ok: number | null
  miss: number | null
  fast_count: number | null
  slow_count: number | null
  max_combo: number | null
  ex_check: string | null
  judge_sum_check: string | null
  needs_review: number
  source: string
  raw_extraction: string | null
  played_at: number
  created_at: number
  song_title?: string | null
  artist?: string | null
  chart_max_ex?: number | null
}

export interface PreviousScore {
  score: number
  ex_score: number | null
  diff: number
  played_at: number
}

export interface AnalyzeResult {
  score: Score
  previous: PreviousScore | null
}

export interface SongSearchItem {
  song_id: string
  title: string
  artist: string | null
  charts: { chart_id: string; play_style: string; difficulty: string; level: number | null }[]
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = getApiBaseUrl()
  const headers = new Headers(init.headers || {})
  const token = getApiToken()
  if (token) headers.set('X-API-Token', token)
  const res = await fetch(`${base}${path}`, { ...init, headers })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body && body.error) msg = body.error
    } catch { /* keep default */ }
    throw new ApiError(res.status, msg)
  }
  return (await res.json()) as T
}

export function analyzeImage(file: Blob, source: string, playedAtIso?: string): Promise<AnalyzeResult> {
  const fd = new FormData()
  fd.append('file', file, 'result.webp')
  fd.append('source', source)
  if (playedAtIso) fd.append('played_at', playedAtIso)
  return request<AnalyzeResult>('/api/analyze', { method: 'POST', body: fd })
}

export async function fetchExportBlob(): Promise<Blob> {
  const base = getApiBaseUrl()
  const headers = new Headers()
  const token = getApiToken()
  if (token) headers.set('X-API-Token', token)
  const res = await fetch(`${base}/api/export`, { headers })
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
  return res.blob()
}

export function listScores(params: { limit?: number; offset?: number; needsReview?: boolean } = {}): Promise<{ items: Score[]; total: number }> {
  const q = new URLSearchParams()
  q.set('limit', String(params.limit ?? 50))
  q.set('offset', String(params.offset ?? 0))
  if (params.needsReview) q.set('needs_review', '1')
  return request(`/api/scores?${q.toString()}`)
}

export function getScore(id: string): Promise<{ score: Score }> {
  return request(`/api/scores/${encodeURIComponent(id)}`)
}

export function patchScore(id: string, fields: Record<string, unknown>): Promise<{ score: Score }> {
  return request(`/api/scores/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
}

export function selectPlayer(id: string, player: 1 | 2): Promise<{ score: Score }> {
  return request(`/api/scores/${encodeURIComponent(id)}/select-player`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player }),
  })
}

export function linkChart(id: string, chartId: string): Promise<{ score: Score }> {
  return request(`/api/scores/${encodeURIComponent(id)}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chart_id: chartId }),
  })
}

export function searchSongs(q: string): Promise<{ items: SongSearchItem[] }> {
  return request(`/api/songs?q=${encodeURIComponent(q)}`)
}

export interface ChartHistory {
  chart: {
    chart_id: string
    song_id: string
    play_style: string
    difficulty: string
    level: number | null
    max_ex?: number | null
    title?: string | null
    song_title?: string | null
    artist?: string | null
  }
  items: Score[]
}

export interface DayUpdate extends Score {
  prev_best: number | null
  diff: number | null
  is_new: boolean
}

export interface LatestDaySummary {
  date: string | null
  total_plays: number
  unique_charts: number
  updates: DayUpdate[]
}

export function getLatestDaySummary(): Promise<LatestDaySummary> {
  return request('/api/summary/latest-day')
}

export function getChartHistory(chartId: string): Promise<ChartHistory> {
  return request(`/api/charts/${encodeURIComponent(chartId)}/history`)
}
