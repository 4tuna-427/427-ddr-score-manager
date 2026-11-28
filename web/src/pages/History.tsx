import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listScores, type Score } from '../lib/api'
import { fcLabel, flareBadgeClass, highlightFlareRank } from '../lib/badges'
import { fetchUpToCount, getDataVersion, getPageCache, setPageCache, useScrollRestore } from '../lib/dataCache'
import { exRatePercent } from '../lib/stats'
import { DiffBadge } from '../components/DiffBadge'

const PAGE = 50

interface HistoryCache {
  date: string
  items: Score[]
  total: number
}

interface DayGroup {
  dateKey: string
  dateLabel: string
  items: Score[]
}

function toJstParts(ms: number): { dateKey: string; dateLabel: string; timeLabel: string } {
  const jst = new Date(ms + 9 * 3600 * 1000)
  const y = jst.getUTCFullYear()
  const m = jst.getUTCMonth() + 1
  const d = jst.getUTCDate()
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  const dateKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const dateLabel = `${y}/${m}/${d}`
  return { dateKey, dateLabel, timeLabel: `${hh}:${mm}` }
}

function groupByJstDate(items: Score[]): DayGroup[] {
  const groups: DayGroup[] = []
  let current: DayGroup | null = null
  for (const s of items) {
    const { dateKey, dateLabel } = toJstParts(s.played_at)
    if (!current || current.dateKey !== dateKey) {
      current = { dateKey, dateLabel, items: [] }
      groups.push(current)
    }
    current.items.push(s)
  }
  return groups
}

export function HistoryPage() {
  const [cached] = useState(() => getPageCache<HistoryCache>('history'))
  const [selectedDate, setSelectedDate] = useState<string>(() => cached?.data.date ?? '')
  const [items, setItems] = useState<Score[]>(() => cached?.data.items ?? [])
  const [total, setTotal] = useState(() => cached?.data.total ?? 0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!cached)
  const reqSeqRef = useRef(0)

  useScrollRestore('history', items.length > 0)

  const fetchPage = useCallback((offset: number, append: boolean, date: string) => {
    const seq = ++reqSeqRef.current
    setLoading(true)
    setError('')
    listScores({ limit: PAGE, offset, date: date || undefined })
      .then((r) => {
        if (seq !== reqSeqRef.current) return
        setItems((prev) => {
          const next = append ? [...prev, ...r.items] : r.items
          setPageCache<HistoryCache>('history', { date, items: next, total: r.total })
          return next
        })
        setTotal(r.total)
      })
      .catch((e) => {
        if (seq !== reqSeqRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (seq === reqSeqRef.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (!cached) {
      fetchPage(0, false, selectedDate)
      return
    }
    if (cached.version === getDataVersion()) return
    let alive = true
    const seq = ++reqSeqRef.current
    const date = cached.data.date
    const targetCount = Math.max(PAGE, cached.data.items.length)
    fetchUpToCount((offset, limit) => listScores({ limit, offset, date: date || undefined }), targetCount, PAGE)
      .then((r) => {
        if (!alive || seq !== reqSeqRef.current) return
        setItems(r.items)
        setTotal(r.total)
        setPageCache<HistoryCache>('history', { date, items: r.items, total: r.total })
      })
      .catch((e) => {
        if (alive && seq === reqSeqRef.current) setError(e instanceof Error ? e.message : String(e))
      })
    return () => { alive = false }
    // Initial mount sync only; date changes are handled in handleDateChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cached, fetchPage])

  const handleDateChange = (nextDate: string) => {
    setSelectedDate(nextDate)
    setItems([])
    setTotal(0)
    fetchPage(0, false, nextDate)
  }

  const dayGroups = useMemo(() => groupByJstDate(items), [items])

  return (
    <div>
      <h1>履歴（{total}件）</h1>
      <div className="history-filter-bar">
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => handleDateChange(e.target.value)}
          aria-label="日付で絞り込み"
        />
        {selectedDate && (
          <button type="button" onClick={() => handleDateChange('')}>
            クリア
          </button>
        )}
      </div>
      {loading && items.length === 0 && <p className="muted">読み込み中…</p>}
      {error && <p className="warn">{error}</p>}
      {!loading && !error && items.length === 0 && (
        <p className="muted">記録がありません。</p>
      )}
      {dayGroups.map((group) => (
        <div key={group.dateKey} className="card history-day-card">
          <div className="history-day-head">
            <h2>{group.dateLabel}</h2>
            <span className="muted history-day-count">{group.items.length}プレイ</span>
          </div>
          <ul className="update-list">
            {group.items.map((s) => {
              const fc = fcLabel(s.clear_lamp)
              const flare = highlightFlareRank(s.flare_rank, s.clear_lamp)
              const ex = exRatePercent(s)
              const { timeLabel } = toJstParts(s.played_at)
              return (
                <li key={s.id}>
                  <Link to={`/scores/${s.id}`} className="update-row">
                    <DiffBadge style={s.play_style} difficulty={s.difficulty} level={s.level} />
                    <span className="update-title">{s.song_title || s.raw_title || '(曲名不明)'}</span>
                    {fc && <span className={`badge fc-badge fc-${fc.toLowerCase()}`}>{fc}</span>}
                    {flare && <span className={`badge flare-badge ${flareBadgeClass(flare)}`}>{flare}</span>}
                    {s.needs_review === 1 && <span className="badge">要確認</span>}
                    <span className="history-row-right">
                      <span className="update-score-val">{s.score.toLocaleString()}</span>
                      {ex != null && <span className="muted update-score-ex">{ex}%</span>}
                      <span className="muted history-row-time">{timeLabel}</span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {items.length < total && (
        <button type="button" onClick={() => fetchPage(items.length, true, selectedDate)} disabled={loading}>
          {loading ? '読み込み中…' : `もっと見る（残り ${(total - items.length).toLocaleString()} 件）`}
        </button>
      )}
    </div>
  )
}
