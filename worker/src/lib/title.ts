/**
 * Title normalization, ported from validate.py normalize():
 * NFKC, strip zero-width chars, strip symbols/whitespace, lowercase.
 */
export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  const t = title
    .normalize("NFKC")
    .replace(/\u200B/g, "")
    .replace(/\uFEFF/g, "");
  return t.replace(/[\s\-_・.,!?'"“”‘’()（）\[\]/\\:：;；]/g, "").toLowerCase();
}

/** Remove trailing bracketed credits like 【ビートまりお】 / [artist] from a title. */
export function stripBracketSuffix(title: string): string {
  let t = title;
  for (;;) {
    const m = t.match(/^(.*?)\s*(?:【[^】]*】|\[[^\]]*\])\s*$/);
    if (!m || !m[1]) return t;
    t = m[1];
  }
}

/** Fold common OCR confusables (1/l/i, 0/o) in an already-normalized title. */
export function looseTitleKey(normalized: string): string {
  return normalized.replace(/[li]/g, "1").replace(/o/g, "0");
}

function levenshteinCapped(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  if (Math.abs(m - n) > cap) return cap + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[n];
}

function editRatioCapped(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const cap = Math.floor(max / 2) + 1;
  return 1 - levenshteinCapped(a, b, cap) / max;
}

function lengthPlausible(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  return max === 0 || Math.abs(a.length - b.length) * 2 <= max + 1;
}

function charCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length; i++) m.set(s[i], (m.get(s[i]) ?? 0) + 1);
  return m;
}

function histPlausible(
  aCounts: Map<string, number>,
  bCounts: Map<string, number>,
  lenA: number,
  lenB: number,
): boolean {
  let overlap = 0;
  for (const [ch, ca] of aCounts) overlap += Math.min(ca, bCounts.get(ch) ?? 0);
  return lenA + lenB - 2 * overlap <= Math.max(lenA, lenB) + 1;
}

export interface TitleCandidate {
  song_id: string;
  title: string;
  score: number;
}

export interface PreparedTitleEntry {
  song_id: string;
  title: string;
  norm: string;
  loose: string;
  counts: Map<string, number>;
  looseCounts: Map<string, number>;
}

export function prepareTitleIndex(
  songs: { song_id: string; title: string; title_normalized: string }[],
): PreparedTitleEntry[] {
  return songs.map((s) => {
    const loose = looseTitleKey(s.title_normalized);
    return {
      song_id: s.song_id,
      title: s.title,
      norm: s.title_normalized,
      loose,
      counts: charCounts(s.title_normalized),
      looseCounts: charCounts(loose),
    };
  });
}

export function rankTitleCandidates(
  rawTitle: string | null | undefined,
  songs: { song_id: string; title: string; title_normalized: string }[],
  limit = 3,
): TitleCandidate[] {
  return rankTitleCandidatesIndexed(rawTitle, prepareTitleIndex(songs), limit);
}

export function rankTitleCandidatesIndexed(
  rawTitle: string | null | undefined,
  index: PreparedTitleEntry[],
  limit = 3,
): TitleCandidate[] {
  if (!rawTitle) return [];
  const norm = normalizeTitle(rawTitle);
  if (!norm) return [];
  const stripped = normalizeTitle(stripBracketSuffix(rawTitle));
  const loose = looseTitleKey(norm);
  const looseStripped = looseTitleKey(stripped);
  const normCounts = charCounts(norm);
  const strippedCounts = charCounts(stripped);
  const looseCounts = charCounts(loose);
  const out: TitleCandidate[] = [];
  for (const s of index) {
    const sn = s.norm;
    let score: number;
    if (sn === norm) score = 1;
    else if (sn === stripped) score = 0.99;
    else if (s.loose === loose || s.loose === looseStripped) score = 0.97;
    else {
      const pairs: Array<{ q: string; qc: Map<string, number>; t: string; tc: Map<string, number> }> = [
        { q: norm, qc: normCounts, t: sn, tc: s.counts },
      ];
      if (stripped !== norm) pairs.push({ q: stripped, qc: strippedCounts, t: sn, tc: s.counts });
      if (loose !== norm || s.loose !== sn) pairs.push({ q: loose, qc: looseCounts, t: s.loose, tc: s.looseCounts });
      const plausible = pairs.some(
        (p) => lengthPlausible(p.q, p.t) && histPlausible(p.qc, p.tc, p.q.length, p.t.length),
      );
      if (!plausible) continue;
      score = Math.max(...pairs.map((p) => editRatioCapped(p.q, p.t)));
    }
    if (score >= 0.5) out.push({ song_id: s.song_id, title: s.title, score: Math.round(score * 1000) / 1000 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * Confident auto-match for an extracted title, or null. Requires a top
 * score >= 0.90 with a clear margin over the runner-up.
 */
export function bestTitleMatch(
  rawTitle: string | null | undefined,
  songs: { song_id: string; title: string; title_normalized: string }[],
): TitleCandidate | null {
  const top = rankTitleCandidates(rawTitle, songs, 2);
  if (top.length === 0 || top[0].score < 0.9) return null;
  if (top.length > 1 && top[1].score >= 0.9 && top[0].score - top[1].score < 0.03) return null;
  return top[0];
}

// ---- pHash matching (Phase 2.4) ----

/** A 64-bit pHash as stored in songs.phash_8: 16 lowercase hex chars. */
export function isValidPhash64(phash: string | null | undefined): phash is string {
  return typeof phash === "string" && /^[0-9a-f]{16}$/i.test(phash);
}

/** Hamming distance between two equal-length hex strings (assumes valid input). */
export function hammingDistanceHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export interface PhashCandidate<T> {
  song: T;
  distance: number;
}

/** Nearest songs by pHash hamming distance (suggestions only, never auto-link). */
export function findPhashCandidates<T extends { phash_8: string | null }>(
  phash: string,
  songs: T[],
  limit = 5,
  maxDistance = 20,
): PhashCandidate<T>[] {
  if (!isValidPhash64(phash)) return [];
  const out: PhashCandidate<T>[] = [];
  for (const s of songs) {
    if (!isValidPhash64(s.phash_8)) continue;
    const distance = hammingDistanceHex(phash, s.phash_8);
    if (distance <= maxDistance) out.push({ song: s, distance });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, limit);
}
