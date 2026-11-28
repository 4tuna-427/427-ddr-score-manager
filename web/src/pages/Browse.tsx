import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { browseCharts, getBrowseFacets, type BrowseItem } from '../lib/api'
import { fetchUpToCount, getDataVersion, getPageCache, setPageCache, useScrollRestore } from '../lib/dataCache'
import { exRatePercent } from '../lib/stats'
import { fmtDate } from '../components/ScoreList'
import { DiffBadge } from '../components/DiffBadge'
import JacketThumb from '../components/JacketThumb'

const DIFFS = ['BEGINNER', 'BASIC', 'DIFFICULT', 'EXPERT', 'CHALLENGE']
const PAGE = 50

interface BrowseListCache {
  filterKey: string
  q: string
  items: BrowseItem[]
  total: number
}

/** One-tap level shortcuts: the user's main range (16-18) first. */
const QUICK_LEVELS = [16, 17, 18, 15, 19]

/**
 * Browse filters persist across visits (localStorage). First visit defaults
 * to Lv.16, the user's main range. The free-text query is not persisted.
 * A ?level= URL parameter (e.g. from the Stats flare targets) wins over the
 * saved level and is then remembered like any other change.
 */
const FILTER_KEY = 'ddr.browseFilters'
interface SavedFilters { style: string; difficulty: string; level: string; version: string; category: string; played: string; sort: string; dir: string }
const DEFAULT_FILTERS: SavedFilters = { style: '', difficulty: '', level: '16', version: '', category: '', played: '', sort: 'level', dir: 'asc' }

/** Default direction per sort key; the toggle button flips it. */
const SORT_DEFAULT_DIR: Record<string, 'asc' | 'desc'> = {
  level: 'asc', title: 'asc', notes: 'desc', bpm: 'desc', plays: 'desc', best: 'desc', recent: 'desc',
}
function loadFilters(): SavedFilters {
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (raw) return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<SavedFilters>) }
  } catch { /* storage unavailable: fall through to defaults */ }
  return DEFAULT_FILTERS
}

export function BrowsePage() {
  const [searchParams] = useSearchParams()
  const [saved] = useState<SavedFilters>(loadFilters)
  const urlLevel = (() => {
    const v = searchParams.get('level')
    return v != null && /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 19 ? v : null
  })()
  const [initialMatch] = useState(() => {
    const c = getPageCache<BrowseListCache>('browse:list')
    const initQ = urlLevel ? '' : (c?.data.q ?? '')
    const initKey = JSON.stringify({
      q: initQ,
      style: saved.style,
      difficulty: saved.difficulty,
      level: urlLevel ?? saved.level,
      version: saved.version,
      category: saved.category,
      played: saved.played,
      sort: saved.sort,
      dir: saved.dir === 'desc' ? 'desc' : 'asc',
    })
    return c && c.data.filterKey === initKey ? c : undefined
  })
  const [q, setQ] = useState(() => (urlLevel ? '' : initialMatch?.data.q ?? ''))
  const [style, setStyle] = useState(saved.style)
  const [difficulty, setDifficulty] = useState(saved.difficulty)
  const [level, setLevel] = useState(urlLevel ?? saved.level)
  const [version, setVersion] = useState(saved.version)
  const [category, setCategory] = useState(saved.category)
  const [played, setPlayed] = useState(saved.played)
  const [sort, setSort] = useState(saved.sort)
  const [dir, setDir] = useState<'asc' | 'desc'>(saved.dir === 'desc' ? 'desc' : 'asc')

  useEffect(() => {
    try {
      const data: SavedFilters = { style, difficulty, level, version, category, played, sort, dir }
      localStorage.setItem(FILTER_KEY, JSON.stringify(data))
    } catch { /* storage unavailable: persistence is best-effort */ }
  }, [style, difficulty, level, version, category, played, sort, dir])

  const changeSort = (v: string) => {
    setSort(v)
    setDir(SORT_DEFAULT_DIR[v] ?? 'asc')
  }
  const [versions, setVersions] = useState<string[]>(() => getPageCache<string[]>('browse:facets')?.data ?? [])
  const [items, setItems] = useState<BrowseItem[]>(() => initialMatch?.data.items ?? [])
  const [total, setTotal] = useState(() => initialMatch?.data.total ?? 0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const reqRef = useRef(0)
  const lastFetchedKeyRef = useRef<string | null>(initialMatch?.data.filterKey ?? null)

  useScrollRestore('browse', items.length > 0)

  useEffect(() => {
    const c = getPageCache<string[]>('browse:facets')
    if (c && c.version === getDataVersion()) return
    getBrowseFacets()
      .then((f) => {
        setVersions(f.versions)
        setPageCache('browse:facets', f.versions)
      })
      .catch(() => {
        if (!c) setVersions([])
      })
  }, [])

  const filterKey = JSON.stringify({ q, style, difficulty, level, version, category, played, sort, dir })

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      const req = ++reqRef.current
      setLoading(true)
      setError('')
      try {
        const res = await browseCharts({
          q, style, difficulty,
          level: level ? Number(level) : undefined,
          version, category, played, sort, dir,
          limit: PAGE, offset,
        })
        if (req !== reqRef.current) return
        lastFetchedKeyRef.current = filterKey
        setTotal(res.total)
        setItems((prev) => {
          const next = append ? [...prev, ...res.items] : res.items
          setPageCache<BrowseListCache>('browse:list', { filterKey, q, items: next, total: res.total })
          return next
        })
      } catch (e) {
        if (req !== reqRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (req === reqRef.current) setLoading(false)
      }
    },
    [q, style, difficulty, level, version, category, played, sort, dir, filterKey],
  )

  // Refetch from the top whenever a filter changes (text input debounced).
  useEffect(() => {
    if (filterKey === lastFetchedKeyRef.current) {
      const c = getPageCache<BrowseListCache>('browse:list')
      if (!c || c.version === getDataVersion()) return
      const req = ++reqRef.current
      const targetCount = Math.max(PAGE, c.data.items.length)
      fetchUpToCount(
        (offset, limit) =>
          browseCharts({
            q, style, difficulty,
            level: level ? Number(level) : undefined,
            version, category, played, sort, dir,
            limit, offset,
          }),
        targetCount,
        PAGE,
      )
        .then((res) => {
          if (req !== reqRef.current) return
          setTotal(res.total)
          setItems(res.items)
          setPageCache<BrowseListCache>('browse:list', { filterKey, q, items: res.items, total: res.total })
        })
        .catch((e) => {
          if (req !== reqRef.current) return
          setError(e instanceof Error ? e.message : String(e))
        })
      return
    }
    const t = window.setTimeout(() => fetchPage(0, false), 250)
    return () => window.clearTimeout(t)
  }, [fetchPage, filterKey, q, style, difficulty, level, version, category, played, sort, dir])

  return (
    <div>
      <h1>楽曲・譜面を探す</h1>
      <div className="card form browse-filters">
        <div className="level-quick" role="group" aria-label="レベル">
          {QUICK_LEVELS.map((n) => (
            <button
              key={n}
              type="button"
              className={level === String(n) ? 'level-quick-btn active' : 'level-quick-btn'}
              onClick={() => setLevel(String(n))}
            >
              Lv{n}
            </button>
          ))}
          <button
            type="button"
            className={level === '' ? 'level-quick-btn active' : 'level-quick-btn'}
            onClick={() => setLevel('')}
          >
            すべて
          </button>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="曲名・アーティストで検索" />
        <div className="filter-grid">
          <select value={style} onChange={(e) => setStyle(e.target.value)} aria-label="スタイル">
            <option value="">SP/DP すべて</option>
            <option value="SP">SP</option>
            <option value="DP">DP</option>
          </select>
          <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} aria-label="難易度">
            <option value="">難易度すべて</option>
            {DIFFS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="レベル">
            <option value="">レベルすべて</option>
            {Array.from({ length: 19 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Lv.{n}</option>)}
          </select>
          <select value={version} onChange={(e) => setVersion(e.target.value)} aria-label="バージョン">
            <option value="">バージョンすべて</option>
            {versions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="カテゴリ">
            <option value="">カテゴリすべて</option>
            <option value="CLASSIC">CLASSIC（〜X3）</option>
            <option value="WHITE">WHITE（2013〜A）</option>
            <option value="GOLD">GOLD（A20〜）</option>
          </select>
          <select value={played} onChange={(e) => setPlayed(e.target.value)} aria-label="プレイ状況">
            <option value="">プレイ状況すべて</option>
            <option value="played">プレイ済み</option>
            <option value="unplayed">未プレイ</option>
          </select>
          <select value={sort} onChange={(e) => changeSort(e.target.value)} aria-label="並び順">
            <option value="level">レベル順</option>
            <option value="title">曲名順</option>
            <option value="notes">ノーツ数順</option>
            <option value="bpm">BPM順</option>
            <option value="plays">プレイ回数順</option>
            <option value="best">ベストスコア順</option>
            <option value="recent">最終プレイ順</option>
          </select>
          <button
            type="button"
            className="sort-dir-btn"
            onClick={() => setDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
            aria-label="並び方向を切り替え"
          >
            {dir === 'asc' ? '昇順 ↑' : '降順 ↓'}
          </button>
        </div>
      </div>

      {error && <p className="warn">{error}</p>}
      <p className="muted">{total.toLocaleString()}譜面{loading && ' 読み込み中…'}</p>
      <ul className="score-list">
        {items.map((it) => {
          const rate = it.best_ex_score != null ? exRatePercent({ ex_score: it.best_ex_score, chart_max_ex: it.max_ex }) : null
          return (
            <li key={it.chart_id}>
              <Link to={`/charts/${encodeURIComponent(it.chart_id)}`} className="score-row">
                <JacketThumb songId={it.song_id} hasJacket={it.has_jacket} />
                <div className="score-row-main">
                  <span className="score-row-title">{it.title}</span>
                  <span className="muted">
                    {it.category && <span className={`badge cat-${it.category.toLowerCase()}`}>{it.category}</span>}{' '}
                    {it.artist || ''} ・ <DiffBadge style={it.play_style} difficulty={it.difficulty} level={it.level} />
                    {it.notes ? ` ・ ${it.notes}ノーツ` : ''}{it.bpm ? ` ・ BPM ${it.bpm}` : ''}{it.version ? ` ・ ${it.version}` : ''}
                  </span>
                  {it.plays != null && it.last_played != null && (
                    <span className="muted">{it.plays}プレイ ・ 最終 {fmtDate(it.last_played)}</span>
                  )}
                </div>
                <div className="score-row-right">
                  {it.best_score != null ? (
                    <>
                      <span className="score-row-score">{it.best_score.toLocaleString()}</span>
                      <span className="muted">
                        {it.best_rank || ''}{it.best_lamp ? ` / ${it.best_lamp}` : ''}{rate != null ? ` ・ EXスコア ${rate}%` : ''}{it.best_flare_rank ? ` ・ フレア ${it.best_flare_rank}` : ''}
                      </span>
                    </>
                  ) : (
                    <span className="muted">未プレイ</span>
                  )}
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
      {items.length < total && (
        <button type="button" onClick={() => fetchPage(items.length, true)} disabled={loading}>
          もっと見る（残り {(total - items.length).toLocaleString()} 件）
        </button>
      )}
    </div>
  )
}
