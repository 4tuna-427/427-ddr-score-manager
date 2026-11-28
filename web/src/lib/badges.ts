export type FcKind = 'MFC' | 'PFC' | 'GFC' | 'FC'

export function fcLabel(clearLamp: string | null | undefined): FcKind | null {
  if (!clearLamp) return null
  const v = clearLamp.trim().toUpperCase()
  if (v === 'MFC' || v === 'MARVELOUS FULL COMBO') return 'MFC'
  if (v === 'PFC' || v === 'PERFECT FULL COMBO') return 'PFC'
  if (v === 'GFC' || v === 'GREAT FULL COMBO') return 'GFC'
  if (v === 'FC' || v === 'FULL COMBO') return 'FC'
  return null
}

export function flareBadgeClass(rank: string): string {
  const r = rank.trim().toUpperCase()
  if (r === 'EX') return 'flare-ex'
  if (r === 'IX') return 'flare-ix'
  if (r === 'VII' || r === 'VIII') return 'flare-high'
  if (r === 'IV' || r === 'V' || r === 'VI') return 'flare-mid'
  return 'flare-low'
}

export function highlightFlareRank(
  rank: string | null | undefined,
  clearLamp: string | null | undefined,
): 'IX' | 'EX' | null {
  if (!rank || clearLamp === 'FAILED') return null
  const r = rank.trim().toUpperCase()
  return r === 'EX' || r === 'IX' ? r : null
}
