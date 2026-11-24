import type { Score } from '../lib/api'
import { judgeSlices, pfcRatePercent } from '../lib/stats'

/** Stacked judgment bar with a % legend, plus the Marvelous+Perfect rate. */
export function JudgeBar({ score }: { score: Score }) {
  const slices = judgeSlices(score)
  if (!slices) return null
  const pfc = pfcRatePercent(score)
  return (
    <div className="judge-bar-wrap">
      <div className="judge-bar" role="img" aria-label="判定割合">
        {slices
          .filter((x) => x.count > 0)
          .map((x) => (
            <div key={x.key} style={{ width: `${x.pct}%`, background: x.color }} title={`${x.label} ${x.count} (${x.pct}%)`} />
          ))}
      </div>
      <div className="judge-legend">
        {slices
          .filter((x) => x.count > 0)
          .map((x) => (
            <span key={x.key}>
              <i style={{ background: x.color }} /> {x.label} {x.pct}%
            </span>
          ))}
        {pfc != null && <span className="judge-pfc">PFC率 {pfc}%</span>}
      </div>
    </div>
  )
}
