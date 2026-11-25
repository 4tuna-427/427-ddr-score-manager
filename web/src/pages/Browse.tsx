import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { browseCharts, getBrowseFacets, type BrowseItem } from '../lib/api'
import { exRatePercent } from '../lib/stats'
import { fmtDate } from '../components/ScoreList'
import { DiffBadge } from '../components/DiffBadge'
import JacketThumb from '../components/JacketThumb'

const DIFFS = ['BEGINNER', 'BASIC', 'DIFFICULT', 'EXPERT', 'CHALLENGE']
const PAGE = 50

export function BrowsePage() {
  const [q, setQ] = useState('')
  const [style, setStyle] = useState('')
  const [difficulty, setDifficulty] = useState('')
  const [level, setLevel] = useState('')
  const [version, setVersion] = useState('')
  const [category, setCategory] = useState('')
  const [played, setPlayed] = useState('')
  const [sort, setSort] = useState('level')
  const [versions, setVersions] = useState<string[]>([])
  const [items, setItems] = useState<BrowseItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const reqRef = useRef(0)

  useEffect(() => {
    getBrowseFacets().then((f) => setVersions(f.versions)).catch(() => setVersions([]))
  }, [])

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      const req = ++reqRef.current
      setLoading(true)
      setError('')
      try {
        const res = await browseCharts({
          q, style, difficulty,
          level: level ? Number(level) : undefined,
          version, category, played, sort,
          limit: PAGE, offset,
        })
        if (req !== reqRef.current) return
        setTotal(res.total)
        setItems((prev) => (append ? [...prev, ...res.items] : res.items))
      } catch (e) {
        if (req !== reqRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (req === reqRef.current) setLoading(false)
      }
    },
    [q, style, difficulty, level, version, category, played, sort],
  )

  // Refetch from the top whenever a filter changes (text input debounced).
  useEffect(() => {
    const t = window.setTimeout(() => fetchPage(0, false), 250)
    return () => window.clearTimeout(t)
  }, [fetchPage])

  return (
    <div>
      <h1>楽曲・譜面を探す</h1>
      <div className="card form browse-filters">
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
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="並び順">
            <option value="level">レベル順</option>
            <option value="title">曲名順</option>
            <option value="best">ベストスコア順</option>
            <option value="recent">最終プレイ順</option>
          </select>
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
                    {it.bpm ? ` ・ BPM ${it.bpm}` : ''}{it.version ? ` ・ ${it.version}` : ''}
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
                        {it.best_rank || ''}{it.best_lamp ? ` / ${it.best_lamp}` : ''}{rate != null ? ` ・ EX ${rate}%` : ''}
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
