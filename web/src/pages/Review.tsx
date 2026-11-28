import { useCallback, useEffect, useMemo, useState } from 'react'
import { listScores, relinkScores, type Score } from '../lib/api'
import { ReviewCard } from '../components/ReviewCard'

type FilterTab = 'all' | 'song' | 'score' | 'waiting'

function hasReason(score: Score, codes: string[]): boolean {
  return (score.review_reasons ?? []).some((r) => codes.includes(r.code))
}

function matchesTab(score: Score, tab: FilterTab): boolean {
  if (tab === 'all') return true
  if (tab === 'waiting') return score.review_status === 'waiting_master'
  if (tab === 'song') {
    return (
      score.review_status !== 'waiting_master' &&
      hasReason(score, ['unlinked_song', 'difficulty_mismatch', 'level_mismatch'])
    )
  }
  return (
    score.review_status !== 'waiting_master' &&
    hasReason(score, [
      'ex_mismatch',
      'ex_invalid',
      'judge_sum_mismatch',
      'ok_exceeds_max',
      'max_combo_exceeds_notes',
      'player_unresolved',
    ])
  )
}

export function ReviewPage() {
  const [items, setItems] = useState<Score[]>([])
  const [total, setTotal] = useState(0)
  const [tab, setTab] = useState<FilterTab>('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [relinkMsg, setRelinkMsg] = useState('')
  const [relinking, setRelinking] = useState(false)

  const load = useCallback(async (offset = 0, append = false) => {
    setLoading(true)
    try {
      const r = await listScores({ limit: 100, offset, needsReview: true })
      setItems((prev) => (append ? [...prev, ...r.items] : r.items))
      setTotal(r.total)
      window.dispatchEvent(new CustomEvent('ddr:review-changed', { detail: r.total }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(0, false) }, [load])

  const counts = useMemo(
    () => ({
      all: items.length,
      song: items.filter((i) => matchesTab(i, 'song')).length,
      score: items.filter((i) => matchesTab(i, 'score')).length,
      waiting: items.filter((i) => matchesTab(i, 'waiting')).length,
    }),
    [items],
  )

  const filtered = useMemo(() => items.filter((i) => matchesTab(i, tab)), [items, tab])

  const doRelink = async () => {
    setRelinking(true)
    setRelinkMsg('')
    try {
      const r = await relinkScores()
      setRelinkMsg(
        `再マッチング：${r.checked}件中 ${r.linked}件リンク（残り${r.remaining}件）／再検算：${r.rechecked ?? 0}件中 ${r.resolved ?? 0}件解決`,
      )
      await load(0, false)
    } catch (e) {
      setRelinkMsg(`再マッチング・再検算に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRelinking(false)
    }
  }

  return (
    <div>
      <div className="review-header">
        <h1>要確認 {total > 0 && <span className="badge">{total}件</span>}</h1>
        <button type="button" className="primary" onClick={doRelink} disabled={relinking}>
          {relinking ? '再マッチング・再検算中…' : '再マッチング・再検算'}
        </button>
      </div>
      <p className="muted">
        読み取りエラーや検算不一致の記録です。原因を確認し、ワンタップ修正または手動修正してください。
      </p>
      {relinkMsg && <p className="notice">{relinkMsg}</p>}
      {error && <p className="warn">{error}</p>}

      <div className="review-tabs" role="tablist" aria-label="要確認フィルタ">
        {([
          ['all', 'すべて', counts.all],
          ['song', '曲・難易度', counts.song],
          ['score', 'EX・判定', counts.score],
          ['waiting', 'マスタ更新待ち', counts.waiting],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`review-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label} <span className="review-tab-count">{count}</span>
          </button>
        ))}
      </div>

      {loading && items.length === 0 && <p className="muted">読み込み中…</p>}
      {!loading && filtered.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            {items.length === 0
              ? '要確認の記録はありません。'
              : 'このカテゴリの要確認記録はありません。'}
          </p>
        </div>
      )}

      {filtered.map((item) => (
        <ReviewCard key={item.id} score={item} onReload={() => load(0, false)} onError={setError} />
      ))}
      {items.length < total && (
        <button type="button" onClick={() => load(items.length, true)} disabled={loading}>
          {loading ? '読み込み中…' : `もっと見る（残り ${(total - items.length).toLocaleString()} 件）`}
        </button>
      )}
    </div>
  )
}
