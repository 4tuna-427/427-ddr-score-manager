import { useCallback, useEffect, useState } from 'react'
import { deleteScore, linkChart, listScores, relinkScores, type Score } from '../lib/api'
import { ScoreList } from '../components/ScoreList'

export function ReviewPage() {
  const [items, setItems] = useState<Score[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [relinkMsg, setRelinkMsg] = useState('')
  const [relinking, setRelinking] = useState(false)

  const load = useCallback(() => {
    return listScores({ limit: 100, needsReview: true })
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const doRelink = async () => {
    setRelinking(true)
    setRelinkMsg('')
    try {
      const r = await relinkScores()
      setRelinkMsg(`再マッチングしました：${r.checked}件中 ${r.linked}件を自動でリンク、残り ${r.remaining}件`)
      await load()
    } catch (e) {
      setRelinkMsg(`再マッチングに失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRelinking(false)
    }
  }

  const onLinkCandidate = async (score: Score, chartId: string) => {
    try {
      await linkChart(score.id, chartId)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onDelete = async (score: Score) => {
    if (!window.confirm(`「${score.raw_title || score.song_title || '(曲名不明)'}」の記録を削除しますか？元に戻せません。`)) return
    try {
      await deleteScore(score.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <h1>要確認</h1>
      <p className="muted">検算が一致しなかった、または曲が特定できなかった記録です。タップして確認・修正してください。</p>
      <div className="card">
        <button type="button" className="primary" onClick={doRelink} disabled={relinking}>
          {relinking ? '再マッチング中…' : '未リンクの記録を再マッチング'}
        </button>
        <p className="muted">曲名の読み取りが少しずれた記録を、あいまい照合でもう一度自動で探します。</p>
        {relinkMsg && <p className="muted">{relinkMsg}</p>}
      </div>
      {loading && <p className="muted">読み込み中…</p>}
      {error && <p className="warn">{error}</p>}
      <ScoreList items={items} onLinkCandidate={onLinkCandidate} onDelete={onDelete} />
    </div>
  )
}
