import { useCallback, useEffect, useState } from 'react'
import { listScores, type Score } from '../lib/api'
import { fetchUpToCount, getDataVersion, getPageCache, setPageCache, useScrollRestore } from '../lib/dataCache'
import { ScoreList } from '../components/ScoreList'

const PAGE = 50

interface HistoryCache {
  items: Score[]
  total: number
}

export function HistoryPage() {
  const [cached] = useState(() => getPageCache<HistoryCache>('history'))
  const [items, setItems] = useState<Score[]>(() => cached?.data.items ?? [])
  const [total, setTotal] = useState(() => cached?.data.total ?? 0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(!cached)

  useScrollRestore('history', items.length > 0)

  const fetchPage = useCallback((offset: number, append: boolean) => {
    setLoading(true)
    setError('')
    listScores({ limit: PAGE, offset })
      .then((r) => {
        setItems((prev) => {
          const next = append ? [...prev, ...r.items] : r.items
          setPageCache<HistoryCache>('history', { items: next, total: r.total })
          return next
        })
        setTotal(r.total)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!cached) {
      fetchPage(0, false)
      return
    }
    if (cached.version === getDataVersion()) return
    let alive = true
    const targetCount = Math.max(PAGE, cached.data.items.length)
    fetchUpToCount((offset, limit) => listScores({ limit, offset }), targetCount, PAGE)
      .then((r) => {
        if (!alive) return
        setItems(r.items)
        setTotal(r.total)
        setPageCache<HistoryCache>('history', { items: r.items, total: r.total })
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => { alive = false }
  }, [cached, fetchPage])

  return (
    <div>
      <h1>履歴（{total}件）</h1>
      {loading && items.length === 0 && <p className="muted">読み込み中…</p>}
      {error && <p className="warn">{error}</p>}
      <ScoreList items={items} />
      {items.length < total && (
        <button type="button" onClick={() => fetchPage(items.length, true)} disabled={loading}>
          {loading ? '読み込み中…' : `もっと見る（残り ${(total - items.length).toLocaleString()} 件）`}
        </button>
      )}
    </div>
  )
}
