const DIFF_ORDER = ["BEGINNER", "BASIC", "DIFFICULT", "EXPERT", "CHALLENGE"] as const;
const DIFF_REGEX = /\b(BEGINNER|BASIC|DIFFICULT|EXPERT|CHALLENGE)\b/gi;
const DIFF_RANGE_REGEX =
  /\b(BEGINNER|BASIC|DIFFICULT|EXPERT|CHALLENGE)\s*(?:to|-|–|~|&rarr;|→)\s*(BEGINNER|BASIC|DIFFICULT|EXPERT|CHALLENGE)\b/gi;

const SIMPLE_BPM_RE = /^(\d+(?:\.\d+)?)(?:\s*[-~–]\s*(\d+(?:\.\d+)?))?$/;
const SEGMENT_RE = /(\d+(?:\.\d+)?(?:\s*[-~–]\s*\d+(?:\.\d+)?)?)\s*\(([^()]*)\)/g;

const DDR_MENTION_RE = /\b(?:DanceDanceRevolution|Dance Dance Revolution|DDR)\b/i;
const OTHER_BEMANI_RE = /\b(?:all\s+)?other\s+BEMANI\s+(?:games|series)\b/i;
const ALL_GAMES_EXCEPT_RE = /\ball\b.*\b(?:games|series)\b.*\bexcept\b/i;
const LEGACY_DDR_HINT_RE = /\b(?:ULTRAMIX\d*|UNIVERSE\d*|HOTTEST\s+PARTY|True\s+Style)\b/i;

function normalizeRange(raw: string): string {
  const m = raw.trim().match(SIMPLE_BPM_RE);
  if (!m) return raw.trim();
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

function extractDiffSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.matchAll(DIFF_RANGE_REGEX)) {
    const start = DIFF_ORDER.indexOf(m[1].toUpperCase() as (typeof DIFF_ORDER)[number]);
    const end = DIFF_ORDER.indexOf(m[2].toUpperCase() as (typeof DIFF_ORDER)[number]);
    if (start !== -1 && end !== -1) {
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      for (let i = lo; i <= hi; i++) set.add(DIFF_ORDER[i]);
    }
  }
  for (const m of text.matchAll(DIFF_REGEX)) {
    set.add(m[1].toUpperCase());
  }
  return set;
}

function styleMatches(clause: string, style?: string | null): boolean {
  const hasSingle = /\bSingle\b/i.test(clause);
  const hasDouble = /\bDouble\b/i.test(clause);
  if (!hasSingle && !hasDouble) return true;
  if (!style) return true;
  const s = style.toUpperCase();
  if (s === "SP") return hasSingle;
  if (s === "DP") return hasDouble;
  return true;
}

function styleBonus(clause: string, style?: string | null): number {
  if (!style) return 0;
  const s = style.toUpperCase();
  const hasSingle = /\bSingle\b/i.test(clause);
  const hasDouble = /\bDouble\b/i.test(clause);
  if ((s === "SP" && hasSingle) || (s === "DP" && hasDouble)) return 5;
  return 0;
}

function ddrVersionAdjustment(clause: string): number {
  if (/\bPresent\b/i.test(clause)) return 2;
  if (LEGACY_DDR_HINT_RE.test(clause)) return -2;
  return 0;
}

function scoreClause(clause: string, difficulty?: string | null, style?: string | null): number {
  const diff = difficulty ? difficulty.toUpperCase() : null;
  const hasDdr = DDR_MENTION_RE.test(clause);

  // 1. Global "all games/series except ..." clause
  if (ALL_GAMES_EXCEPT_RE.test(clause)) {
    const afterExcept = clause.split(/\bexcept\b/i).slice(1).join("except");
    if (DDR_MENTION_RE.test(afterExcept)) {
      const excludedDiffs = extractDiffSet(afterExcept);
      if (excludedDiffs.size === 0) return 0; // All DDR excluded
      if (diff && excludedDiffs.has(diff) && styleMatches(afterExcept, style)) return 0;
      return 30;
    }
    return 30; // Other games excluded -> DDR included
  }

  // 2. Explicit DDR mention
  if (hasDdr) {
    if (!styleMatches(clause, style)) return 0;
    const adj = ddrVersionAdjustment(clause) + styleBonus(clause, style);

    if (/\bexcept\b/i.test(clause)) {
      const afterExcept = clause.split(/\bexcept\b/i).slice(1).join("except");
      const excluded = extractDiffSet(afterExcept);
      if (diff && excluded.has(diff)) return 0;
      return (diff ? 100 : 60) + adj;
    }

    if (/\bother\s+DanceDanceRevolution\s+(?:charts|difficulties)\b/i.test(clause)) {
      return 80 + adj;
    }

    const diffs = extractDiffSet(clause);
    if (diffs.size > 0) {
      if (!diff) return 60 + adj;
      return diffs.has(diff) ? 100 + adj : 0;
    }

    return 60 + adj;
  }

  // 3. Catch-all BEMANI clause
  if (OTHER_BEMANI_RE.test(clause)) {
    return 30;
  }

  // 4. Difficulty-only clause (DDR-only song without explicit game name)
  if (!styleMatches(clause, style)) return 0;
  if (/\bother\s+(?:charts|difficulties)\b/i.test(clause)) {
    return 40 + styleBonus(clause, style);
  }
  if (/\bexcept\b/i.test(clause)) {
    const afterExcept = clause.split(/\bexcept\b/i).slice(1).join("except");
    const excluded = extractDiffSet(afterExcept);
    if (excluded.size > 0) {
      if (diff && excluded.has(diff)) return 0;
      return 50 + styleBonus(clause, style);
    }
  }
  const diffs = extractDiffSet(clause);
  if (diffs.size > 0) {
    if (!diff) return 45 + styleBonus(clause, style);
    return diffs.has(diff) ? 50 + styleBonus(clause, style) : 0;
  }

  return 0;
}

/**
 * Extract the DDR BPM value (for the given difficulty/style when present)
 * from raw RemyWiki-style BPM strings that may include other BEMANI games.
 */
export function extractDdrBpm(
  rawBpm: string | null | undefined,
  difficulty?: string | null,
  style?: string | null,
): string | null {
  if (rawBpm == null) return null;
  const trimmed = rawBpm.trim();
  if (!trimmed) return null;

  if (SIMPLE_BPM_RE.test(trimmed)) {
    return normalizeRange(trimmed);
  }

  const segments: Array<{ value: string; score: number }> = [];
  for (const m of trimmed.matchAll(SEGMENT_RE)) {
    const value = normalizeRange(m[1]);
    const note = m[2];
    const clauses = note.split(",").map((c) => c.trim()).filter(Boolean);
    let bestScore = 0;
    for (const clause of clauses) {
      const s = scoreClause(clause, difficulty, style);
      if (s > bestScore) bestScore = s;
    }
    segments.push({ value, score: bestScore });
  }

  if (segments.length > 0) {
    let best = segments[0];
    for (const seg of segments) {
      if (seg.score > best.score) best = seg;
    }
    return best.value;
  }

  // Fallback: extract leading numeric range if non-standard formatting appears
  const leading = trimmed.match(/^(\d+(?:\.\d+)?(?:\s*[-~–]\s*\d+(?:\.\d+)?)?)/);
  return leading ? normalizeRange(leading[1]) : null;
}

/**
 * Return the numeric upper-bound BPM used for sorting cleaned BPM values.
 */
export function bpmSortValue(cleanBpm: string | null | undefined): number | null {
  if (!cleanBpm) return null;
  const m = cleanBpm.trim().match(/^(?:\d+(?:\.\d+)?\s*-\s*)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isFinite(num) ? num : null;
}
