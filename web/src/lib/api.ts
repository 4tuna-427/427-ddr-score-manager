// API client per docs/API.md. Base URL and token come from localStorage (Settings page).
import { bumpDataVersion, clearDataCache } from './dataCache'

const TOKEN_KEY = 'ddr.apiToken'
const BASE_KEY = 'ddr.apiBaseUrl'

export function getApiToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}
export function setApiToken(v: string): void {
  localStorage.setItem(TOKEN_KEY, v)
  clearJacketCache()
  clearDataCache()
}
export function getApiBaseUrl(): string {
  return localStorage.getItem(BASE_KEY) || ''
}
export function setApiBaseUrl(v: string): void {
  localStorage.setItem(BASE_KEY, v.replace(/\/$/, ''))
  clearJacketCache()
  clearDataCache()
}

export interface ReviewReason {
  code:
    | 'unlinked_song'
    | 'difficulty_mismatch'
    | 'level_mismatch'
    | 'ex_mismatch'
    | 'ex_invalid'
    | 'judge_sum_mismatch'
    | 'ok_exceeds_max'
    | 'max_combo_exceeds_notes'
    | 'player_unresolved'
  detail?: Record<string, number | string | null>
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
  review_status?: string | null
  has_review_image?: number
  review_reasons?: ReviewReason[]
  source: string
  raw_extraction: string | null
  played_at: number
  created_at: number
  song_title?: string | null
  artist?: string | null
  chart_level?: number | null
  chart_notes?: number | null
  chart_freeze?: number | null
  chart_shock?: number | null
  chart_max_ex?: number | null
  /** Ranked link candidates for unlinked records (attached by the API). */
  candidates?: LinkCandidate[]
  /** Charts belonging to the matched song (when song_id matched but chart_id did not). */
  song_charts?: { chart_id: string; play_style: string; difficulty: string; level: number | null }[]
}

export interface LinkCandidate {
  chart_id: string
  song_id: string
  title: string
  artist: string | null
  score: number
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

/** Returned (HTTP 200) when the photo shows a non-detail result tab and
 *  nothing was registered. */
export interface AnalyzeSkip {
  skipped: true
  reason: string
  song_title: string | null
}

export type AnalyzeOutcome = AnalyzeResult | AnalyzeSkip

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

async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
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
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    bumpDataVersion()
  }
  return res
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rawRequest(path, init)
  return (await res.json()) as T
}

export function analyzeImage(file: Blob, source: string, playedAtIso?: string, bulk?: boolean): Promise<AnalyzeOutcome> {
  const fd = new FormData()
  fd.append('file', file, 'result.webp')
  fd.append('source', source)
  if (playedAtIso) fd.append('played_at', playedAtIso)
  // Bulk import mode: the Worker reduces in-model retries for this call.
  if (bulk) fd.append('bulk', '1')
  return request<AnalyzeOutcome>('/api/analyze', { method: 'POST', body: fd })
}

const jacketUrlCache = new Map<string, Promise<string | null>>()

export function clearJacketCache(): void {
  for (const p of jacketUrlCache.values()) {
    void p.then((url) => { if (url) URL.revokeObjectURL(url) })
  }
  jacketUrlCache.clear()
}

/** Authenticated jacket image as an object URL (null when unavailable). Cached per song. */
export function fetchJacketObjectUrl(songId: string): Promise<string | null> {
  let p = jacketUrlCache.get(songId)
  if (!p) {
    p = (async () => {
      try {
        const base = getApiBaseUrl()
        const headers = new Headers()
        const token = getApiToken()
        if (token) headers.set('X-API-Token', token)
        const res = await fetch(`${base}/api/jackets/${encodeURIComponent(songId)}`, { headers })
        if (!res.ok) {
          jacketUrlCache.delete(songId)
          return null
        }
        return URL.createObjectURL(await res.blob())
      } catch {
        jacketUrlCache.delete(songId)
        return null
      }
    })()
    jacketUrlCache.set(songId, p)
  }
  return p
}

export async function fetchExportBlob(): Promise<Blob> {
  const res = await rawRequest('/api/export')
  return res.blob()
}

export function listScores(params: { limit?: number; offset?: number; needsReview?: boolean; date?: string } = {}): Promise<{ items: Score[]; total: number }> {
  const q = new URLSearchParams()
  q.set('limit', String(params.limit ?? 50))
  q.set('offset', String(params.offset ?? 0))
  if (params.needsReview) q.set('needs_review', '1')
  if (params.date) q.set('date', params.date)
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

export function resolveReview(id: string): Promise<{ score: Score }> {
  return request(`/api/scores/${encodeURIComponent(id)}/resolve-review`, {
    method: 'POST',
  })
}

export function deleteScore(id: string): Promise<{ ok: boolean }> {
  return request(`/api/scores/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function correctMasterNotes(
  id: string,
): Promise<{ chart_id: string; notes: number; max_ex: number | null; resolved: number }> {
  return request(`/api/scores/${encodeURIComponent(id)}/correct-master-notes`, { method: 'POST' })
}

export function relinkScores(): Promise<{
  checked: number
  linked: number
  remaining: number
  rechecked?: number
  resolved?: number
}> {
  return request('/api/admin/relink', { method: 'POST' })
}

export function searchSongs(q: string): Promise<{ items: SongSearchItem[] }> {
  return request(`/api/songs?q=${encodeURIComponent(q)}`)
}

export async function fetchReviewImageObjectUrl(scoreId: string): Promise<string | null> {
  try {
    const base = getApiBaseUrl()
    const headers = new Headers()
    const token = getApiToken()
    if (token) headers.set('X-API-Token', token)
    const res = await fetch(`${base}/api/scores/${encodeURIComponent(scoreId)}/image`, { headers })
    if (!res.ok) return null
    return URL.createObjectURL(await res.blob())
  } catch {
    return null
  }
}

export interface CustomSongPayload {
  title: string
  artist?: string
  play_style: 'SP' | 'DP'
  difficulty: string
  level?: number | null
  notes?: number | null
  freeze?: number | null
  shock?: number | null
  score_id?: string
}

export function createCustomSong(payload: CustomSongPayload): Promise<{
  song: { song_id: string; title: string }
  chart: { chart_id: string; play_style: string; difficulty: string; level: number | null }
  score: Score | null
}> {
  return request('/api/songs/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
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
    has_jacket?: number | null
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
  notes?: number | null
  title: string
  artist: string | null
  version: string | null
  bpm: string | null
  has_jacket?: number | null
  best_score: number | null
  plays: number | null
  last_played: number | null
  best_ex_score?: number | null
  best_rank?: string | null
  best_lamp?: string | null
  best_flare_rank?: string | null
  category?: string | null
}

export function browseCharts(params: {
  q?: string; style?: string; difficulty?: string; level?: number
  version?: string; category?: string; played?: string; sort?: string; dir?: string; limit?: number; offset?: number
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
  if (params.dir) qs.set('dir', params.dir)
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
  monthly: { month: string; plays: number; pb_updates: number; avg_ex_rate: number | null }[]
  ex_rate_by_level: { play_style: string; level: number; avg_ex_rate: number | null; charts: number }[]
  calendar: { date: string; plays: number }[]
  graphs: {
    level_monthly: { month: string; level: number; plays: number }[]
    judge_daily: {
      date: string; plays: number
      marvelous: number; perfect: number; great: number; good: number; ok: number; miss: number
    }[]
    coverage: {
      play_style: string; level: number; difficulty: string
      total: number; played: number; cleared: number
    }[]
  }
  flare: {
    by_rank: { flare_rank: string; charts: number }[]
    charts_with_flare: number
    targets: {
      level: number
      min_rank: string
      achieved: { chart_id: string; title: string | null; play_style: string; flare_rank: string }[]
      achieved_count: number
      candidates: { chart_id: string; title: string | null; play_style: string; best_flare_rank: string | null }[]
      candidate_count: number
    }[]
  }
}

export function getStats(): Promise<StatsResponse> {
  return request('/api/stats')
}

export interface VersusOpponent {
  name: string
  plays: number
  wins: number
  losses: number
  draws: number
  last_played_at: number
}

export interface VersusRecent {
  score_id: string
  opponent: string
  song_title: string | null
  my_score: number | null
  opp_score: number | null
  result: 'win' | 'loss' | 'draw' | 'unknown'
  played_at: number
}

export interface VersusResponse {
  opponents: VersusOpponent[]
  recent: VersusRecent[]
}

export function getVersus(): Promise<VersusResponse> {
  return request('/api/versus')
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

export function importScores(payload: unknown): Promise<ImportResult> {
  return request<ImportResult>('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function getChartHistory(chartId: string): Promise<ChartHistory> {
  return request(`/api/charts/${encodeURIComponent(chartId)}/history`)
}

export interface Target {
  chart_id: string
  target_score: number | null
  target_lamp: string | null
  updated_at: number
  play_style: string
  difficulty: string
  level: number | null
  song_title: string | null
  artist: string | null
  best_score: number | null
  best_lamp?: string | null
}

export function getTarget(chartId: string): Promise<{ target: Target | null }> {
  return request(`/api/targets?chart_id=${encodeURIComponent(chartId)}`)
}

export function getTargets(): Promise<{ items: Target[] }> {
  return request('/api/targets')
}

export function saveTarget(chartId: string, targetScore: number | null, targetLamp: string | null): Promise<{ target: Target }> {
  return request('/api/targets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chart_id: chartId, target_score: targetScore, target_lamp: targetLamp }),
  })
}

export function deleteTarget(chartId: string): Promise<{ deleted: boolean }> {
  return request(`/api/targets/${encodeURIComponent(chartId)}`, { method: 'DELETE' })
}
