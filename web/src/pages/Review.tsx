import { useEffect, useState } from 'react'
import { listScores, type Score } from '../lib/api'
import { ScoreList } from '../components/ScoreList'

export function ReviewPage() {
  const [items, setItems] = useState<Score[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listScores({ limit: 100, needsReview: true })
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <h1>要確認</h1>
      <p className="muted">検算が一致しなかった、または曲が特定できなかった記録です。タップして確認・修正してください。</p>
      {loading && <p className="muted">読み込み中…</p>}
      {error && <p className="warn">{error}</p>}
      <ScoreList items={items} />
    </div>
  )
}
