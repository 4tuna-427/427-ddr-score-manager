import { useEffect, useState } from 'react'
import { listScores, type Score } from '../lib/api'
import { ScoreList } from '../components/ScoreList'

export function HistoryPage() {
  const [items, setItems] = useState<Score[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listScores({ limit: 100 })
      .then((r) => {
        setItems(r.items)
        setTotal(r.total)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <h1>履歴（{total}件）</h1>
      {loading && <p className="muted">読み込み中…</p>}
      {error && <p className="warn">{error}</p>}
      <ScoreList items={items} />
    </div>
  )
}
