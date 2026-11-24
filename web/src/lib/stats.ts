import type { Score } from './api'

/** EX score rate (% of the chart's maximum EX), 1 decimal. Null when unknown. */
export function exRatePercent(s: Pick<Score, 'ex_score' | 'chart_max_ex'>): number | null {
  if (s.ex_score == null || !s.chart_max_ex) return null
  return Math.round((s.ex_score / s.chart_max_ex) * 1000) / 10
}

export interface JudgeSlice {
  key: 'marvelous' | 'perfect' | 'great' | 'good' | 'miss'
  label: string
  count: number
  pct: number
  color: string
}

const JUDGES: { key: JudgeSlice['key']; label: string; color: string }[] = [
  { key: 'marvelous', label: 'Marvelous', color: '#f2b705' },
  { key: 'perfect', label: 'Perfect', color: '#ff5d8f' },
  { key: 'great', label: 'Great', color: '#2fbf71' },
  { key: 'good', label: 'Good', color: '#3f8cff' },
  { key: 'miss', label: 'Miss', color: '#b9c0c7' },
]

/**
 * Judgment breakdown as percentages of all judged notes
 * (marvelous+perfect+great+good+miss; OK/freeze is counted separately in DDR,
 * so it is not part of the denominator). Null when no judgments recorded.
 */
export function judgeSlices(s: Score): JudgeSlice[] | null {
  const counts = JUDGES.map((j) => ({ ...j, count: (s[j.key] as number | null) ?? 0 }))
  const total = counts.reduce((a, b) => a + b.count, 0)
  if (total === 0) return null
  return counts.map((c) => ({ ...c, pct: Math.round((c.count / total) * 1000) / 10 }))
}

/** Marvelous+Perfect rate (%): the share of notes judged Perfect or better. */
export function pfcRatePercent(s: Score): number | null {
  const slices = judgeSlices(s)
  if (!slices) return null
  const mp = slices.filter((x) => x.key === 'marvelous' || x.key === 'perfect').reduce((a, b) => a + b.count, 0)
  const total = slices.reduce((a, b) => a + b.count, 0)
  return Math.round((mp / total) * 1000) / 10
}
