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
    version?: string | null
    category?: string | null
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

export interface BrowseItem {
  chart_id: string
  song_id: string
  play_style: string
  difficulty: string
  level: number | null
  max_ex: number | null
  title: string
  artist: string | null
  version: string | null
  bpm: string | null
  best_score: number | null
  plays: number | null
  last_played: number | null
  best_ex_score?: number | null
  best_rank?: string | null
  best_lamp?: string | null
  category?: string | null
}

export function browseCharts(params: {
  q?: string; style?: string; difficulty?: string; level?: number
  version?: string; category?: string; played?: string; sort?: string; limit?: number; offset?: number
}): Promise<{ items: BrowseItem[]; total: number }> {
  const qs = new URLSearchParams()
  if (params.q) qs.set('q', params.q)
  if (params.style) qs.set('style', params.style)
  if (params.difficulty) qs.set('difficulty', params.difficulty)
  if (params.level != null) qs.set('level', String(params.level))
  if (params.version) qs.set('version', params.version)
  if (params.category) qs.set('category', params.category)
  if (params.played) qs.set('played', params.played)
  if (params.sort) qs.set('sort', params.sort)
  qs.set('limit', String(params.limit ?? 50))
  qs.set('offset', String(params.offset ?? 0))
  return request(`/api/browse?${qs.toString()}`)
}

export function getBrowseFacets(): Promise<{ versions: string[]; categories: Record<string, number> }> {
  return request('/api/browse/facets')
}

export function getLatestDaySummary(): Promise<LatestDaySummary> {
  return request('/api/summary/latest-day')
}

export interface AchievementBucket {
  total_charts: number
  played: number
  clear: number
  fc: number
  gfc: number
  pfc: number
  mfc: number
}

export interface StatsResponse {
  totals: AchievementBucket & {
    plays: number
    play_days: number
    aaa: number
    max_clear_level: number | null
  }
  by_level: (AchievementBucket & { play_style: string; level: number })[]
  by_category: (AchievementBucket & { category: string })[]
  monthly: { month: string; plays: number; pb_updates: number }[]
}

export function getStats(): Promise<StatsResponse> {
  return request('/api/stats')
}

export interface CloseCall {
  chart_id: string
  kind: 'aaa' | 'lamp'
  gap: number
  next_lamp?: string
  score: number
  rank: string | null
  clear_lamp: string | null
  song_title: string | null
  artist: string | null
  play_style: string
  difficulty: string
  level: number | null
}

export function getCloseCalls(): Promise<{ items: CloseCall[] }> {
  return request('/api/close-calls')
}

export interface ImportResult {
  imported: number
  skipped: number
  errors: { index: number; reason: string }[]
  error_count: number
}

export async function importScores(payload: unknown): Promise<ImportResult> {
  const base = getApiBaseUrl()
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const token = getApiToken()
  if (token) headers.set('X-API-Token', token)
  const res = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify(payload) })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body && body.error) msg = body.error
    } catch { /* keep default */ }
    throw new ApiError(res.status, msg)
  }
  return (await res.json()) as ImportResult
}

export function getChartHistory(chartId: string): Promise<ChartHistory> {
  return request(`/api/charts/${encodeURIComponent(chartId)}/history`)
}
