/** Difficulty pill in DDR's difficulty colors: SP/DP + difficulty + level. */
export function DiffBadge({ style, difficulty, level }: { style: string; difficulty: string; level: number | null }) {
  const cls = ['BEGINNER', 'BASIC', 'DIFFICULT', 'EXPERT', 'CHALLENGE'].includes(difficulty)
    ? `diff-${difficulty.toLowerCase()}`
    : 'diff-unknown'
  return (
    <span className={`diff-badge ${cls}`}>
      {style} {difficulty} Lv.{level ?? '?'}
    </span>
  )
}
