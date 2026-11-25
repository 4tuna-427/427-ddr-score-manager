import { useCallback, useEffect, useState } from 'react'
import { listScores, type Score } from '../lib/api'
import { ScoreList } from '../components/ScoreList'

const PAGE = 50

export function HistoryPage() {
  const [items, setItems] = useState<Score[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchPage = useCallback((offset: number, append: boolean) => {
    setLoading(true)
    setError('')
    listScores({ limit: PAGE, offset })
      .then((r) => {
        setItems((prev) => (append ? [...prev, ...r.items] : r.items))
        setTotal(r.total)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchPage(0, false)
  }, [fetchPage])

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
