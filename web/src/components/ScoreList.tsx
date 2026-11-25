import { Link } from 'react-router-dom'
import type { Score } from '../lib/api'
import { exRatePercent } from '../lib/stats'
import { DiffBadge } from './DiffBadge'

export function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

interface ScoreListProps {
  items: Score[]
  /** Review mode: show one-tap link candidates and a delete button per row. */
  onLinkCandidate?: (score: Score, chartId: string) => void
  onDelete?: (score: Score) => void
}

export function ScoreList({ items, onLinkCandidate, onDelete }: ScoreListProps) {
  if (items.length === 0) return <p className="muted">記録がありません。</p>
  return (
    <ul className="score-list">
      {items.map((s) => (
        <li key={s.id}>
          <Link to={`/scores/${s.id}`} className="score-row">
            <div className="score-row-main">
              <span className="score-row-title">{s.song_title || s.raw_title || '(曲名不明)'}</span>
              <span className="muted">
                <DiffBadge style={s.play_style} difficulty={s.difficulty} level={s.level} /> ・ {fmtDate(s.played_at)}
              </span>
            </div>
            <div className="score-row-right">
              <span className="score-row-score">{s.score.toLocaleString()}</span>
              {exRatePercent(s) != null && <span className="muted">EXスコア {exRatePercent(s)}%</span>}
              {s.needs_review === 1 && <span className="badge">要確認</span>}
            </div>
          </Link>
          {(onLinkCandidate || onDelete) && (
            <div className="review-actions">
              {onLinkCandidate && (s.candidates ?? []).map((cand) => (
                <button
                  key={cand.chart_id}
                  type="button"
                  onClick={() => onLinkCandidate(s, cand.chart_id)}
                >
                  候補：{cand.title}（一致度 {Math.round(cand.score * 100)}%）でリンク
                </button>
              ))}
              {onDelete && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => onDelete(s)}
                >
                  この記録を削除
                </button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
