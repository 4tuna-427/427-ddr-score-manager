import { Link } from 'react-router-dom'
import type { Score } from '../lib/api'

export function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ScoreList({ items }: { items: Score[] }) {
  if (items.length === 0) return <p className="muted">記録がありません。</p>
  return (
    <ul className="score-list">
      {items.map((s) => (
        <li key={s.id}>
          <Link to={`/scores/${s.id}`} className="score-row">
            <div className="score-row-main">
              <span className="score-row-title">{s.song_title || s.raw_title || '(曲名不明)'}</span>
              <span className="muted">
                {s.play_style} {s.difficulty} Lv.{s.level ?? '?'} ・ {fmtDate(s.played_at)}
              </span>
            </div>
            <div className="score-row-right">
              <span className="score-row-score">{s.score.toLocaleString()}</span>
              {s.needs_review === 1 && <span className="badge">要確認</span>}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
