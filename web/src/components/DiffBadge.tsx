/**
 * Compact DDR chart label in the notation players actually use:
 * difficulty initial + play side + level, e.g. "CSP 17" (SP CHALLENGE),
 * "bSP 5" (SP BEGINNER — lowercase b), "EDP 15" (DP EXPERT).
 */
const DIFF_INITIAL: Record<string, string> = {
  BEGINNER: 'b',
  BASIC: 'B',
  DIFFICULT: 'D',
  EXPERT: 'E',
  CHALLENGE: 'C',
}

export function diffLabel(style: string, difficulty: string, level: number | null): string {
  const initial = DIFF_INITIAL[difficulty]
  if (!initial) return `${style} ${difficulty} Lv.${level ?? '?'}`
  return `${initial}${style} ${level ?? '?'}`
}

/** Difficulty pill in DDR's difficulty colors. */
export function DiffBadge({ style, difficulty, level }: { style: string; difficulty: string; level: number | null }) {
  const cls = ['BEGINNER', 'BASIC', 'DIFFICULT', 'EXPERT', 'CHALLENGE'].includes(difficulty)
    ? `diff-${difficulty.toLowerCase()}`
    : 'diff-unknown'
  return (
    <span className={`diff-badge ${cls}`}>
      {diffLabel(style, difficulty, level)}
    </span>
  )
}
