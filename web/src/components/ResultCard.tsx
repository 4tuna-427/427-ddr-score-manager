import { Link } from 'react-router-dom'
import type { AnalyzeResult } from '../lib/api'
import { exRatePercent } from '../lib/stats'
import { JudgeBar } from './JudgeBar'
import { DiffBadge } from './DiffBadge'

export function ResultCard({ result }: { result: AnalyzeResult }) {
  const s = result.score
  const prev = result.previous
  const title = s.song_title || s.raw_title || '(曲名不明)'
  return (
    <div className="card result-card">
      <div className="result-head">
        <strong>{title}</strong>
        <DiffBadge style={s.play_style} difficulty={s.difficulty} level={s.level} />
      </div>
      <div className="result-score">{s.score.toLocaleString()}</div>
      {prev ? (
        <div className={prev.diff >= 0 ? 'diff up' : 'diff down'}>
          前回 {prev.score.toLocaleString()}（{prev.diff >= 0 ? '+' : ''}
          {prev.diff.toLocaleString()}）
        </div>
      ) : (
        <div className="muted">この譜面の初記録</div>
      )}
      {s.ex_score != null && (
        <div className="muted">
          EX {s.ex_score.toLocaleString()}
          {exRatePercent(s) != null && <> （達成率 {exRatePercent(s)}%）</>}
        </div>
      )}
      <JudgeBar score={s} />
      {s.needs_review === 1 && (
        <div className="warn">⚠ 要確認：読み取り値が検算と一致しませんでした。タップして確認・修正してください。</div>
      )}
      {!s.chart_id && <div className="warn">⚠ 曲を特定できませんでした。詳細から曲を検索して紐付けてください。</div>}
      <Link to={`/scores/${s.id}`}>詳細を見る</Link>
    </div>
  )
}
