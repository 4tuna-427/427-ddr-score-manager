// Pure logic ported from Phase 0 (phase0/validate.py is the source of truth).

export interface PlayerExtraction {
dancer_name: string | null;
difficulty: string | null;
level: number | null;
score: number | null;
ex_score: number | null;
rank: string | null;
clear_lamp: string | null;
flare_rank: string | null;
flare_skill: number | null;
max_combo: number | null;
marvelous: number | null;
perfect: number | null;
great: number | null;
good: number | null;
ok: number | null;
miss: number | null;
fast_count: number | null;
slow_count: number | null;
}

export interface Extraction {
song_title: string | null;
play_style: string | null;
is_versus: boolean;
player_1: PlayerExtraction | null;
player_2: PlayerExtraction | null;
jacket_bbox: number[] | null;
}

export interface ChartLike {
notes: number | null;
freeze?: number | null;
shock: number | null;
level?: number | null;
max_ex?: number | null;
}

export type ReviewReasonCode =
  | "unlinked_song"
  | "difficulty_mismatch"
  | "level_mismatch"
  | "ex_mismatch"
  | "ex_invalid"
  | "judge_sum_mismatch"
  | "ok_exceeds_max"
  | "max_combo_exceeds_notes"
  | "player_unresolved";

export interface ReviewReason {
  code: ReviewReasonCode;
  detail?: Record<string, number | string | null>;
}

export type ExCheck = "match" | "mismatch" | "no_ex";
export type JudgeSumCheck = "match" | "check" | "no_master";

/** (play_style, difficulty) -> master notecounts/levels key. Mirrors DIFF_KEY in validate.py. */
export const DIFF_KEY: Record<string, string> = {
"SP|BEGINNER": "sp_beginner",
"SP|BASIC": "sp_basic",
"SP|DIFFICULT": "sp_difficult",
"SP|EXPERT": "sp_expert",
"SP|CHALLENGE": "sp_challenge",
"DP|BASIC": "dp_basic",
"DP|DIFFICULT": "dp_difficult",
"DP|EXPERT": "dp_expert",
"DP|CHALLENGE": "dp_challenge",
};

export function diffKey(playStyle: string, difficulty: string): string | null {
return DIFF_KEY[`${playStyle}|${difficulty}`]?? null;
}

export function chartId(songId: string, playStyle: string, difficulty: string): string {
return `${songId}|${playStyle}|${difficulty}`;
}

/**
* Title normalization, ported from validate.py normalize():
* NFKC, strip zero-width chars, strip symbols/whitespace, lowercase.
*/
export function normalizeTitle(title: string | null | undefined): string {
if (!title) return "";
const t = title
.normalize("NFKC")
.replace(/​/g, "")
.replace(/﻿/g, "");
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

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function editRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

export interface TitleCandidate {
  song_id: string;
  title: string;
  score: number;
}

/**
 * Rank master songs by similarity to an extracted (possibly misread) title.
 * Exact normalized match = 1, bracket-stripped exact = 0.99, confusable-folded
 * exact = 0.97; otherwise the best Levenshtein ratio across the raw/stripped
 * and folded variants. Only candidates scoring >= 0.5 are returned.
 */
export function rankTitleCandidates(
  rawTitle: string | null | undefined,
  songs: { song_id: string; title: string; title_normalized: string }[],
  limit = 3,
): TitleCandidate[] {
  if (!rawTitle) return [];
  const norm = normalizeTitle(rawTitle);
  if (!norm) return [];
  const stripped = normalizeTitle(stripBracketSuffix(rawTitle));
  const loose = looseTitleKey(norm);
  const looseStripped = looseTitleKey(stripped);
  const out: TitleCandidate[] = [];
  for (const s of songs) {
    const sn = s.title_normalized;
    let score: number;
    if (sn === norm) score = 1;
    else if (sn === stripped) score = 0.99;
    else if (looseTitleKey(sn) === loose || looseTitleKey(sn) === looseStripped) score = 0.97;
    else {
      score = Math.max(
        editRatio(norm, sn),
        editRatio(stripped, sn),
        editRatio(loose, looseTitleKey(sn)),
      );
    }
    if (score >= 0.5) out.push({ song_id: s.song_id, title: s.title, score: Math.round(score * 1000) / 1000 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * Confident auto-match for an extracted title, or null. Requires a top
 * score >= 0.90 with a clear margin over the runner-up, so near-identical
 * distinct songs (remixes, series titles) are never guessed between.
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

/** Theoretical EX score. Returns null when any required judgment is missing. */
export function calcEx(p: Pick<PlayerExtraction, "marvelous" | "ok" | "perfect" | "great">): number | null {
if (p.marvelous == null || p.ok == null || p.perfect == null || p.great == null) return null;
return (p.marvelous + p.ok) * 3 + p.perfect * 2 + p.great * 1;
}

export function exCheck(p: Pick<PlayerExtraction, "marvelous" | "ok" | "perfect" | "great" | "ex_score">): ExCheck {
const calc = calcEx(p);
if (calc == null || p.ex_score == null) return "no_ex";
return calc === p.ex_score? "match": "mismatch";
}

/** Sum of tap judgments (null counts as 0, same as validate.py). */
export function judgeSum(p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss">): number {
return (p.marvelous?? 0) + (p.perfect?? 0) + (p.great?? 0) + (p.good?? 0) + (p.miss?? 0);
}

/**
 * Expected displayed judge sum for a full play of the chart.
 * On the result screen a dropped freeze (N.G.) and a hit shock arrow both
 * count toward the displayed Miss count, while held freezes and avoided
 * shocks count as O.K., so: judgeSum = notes + freeze + shock - ok.
 * Returns null when the identity cannot be applied (no master notes, or
 * freeze / ok unknown); callers then fall back to the plain notes value.
 */
export function expectedJudgeSum(
p: Pick<PlayerExtraction, "ok">,
chart: ChartLike | null | undefined,
): number | null {
if (!chart || chart.notes == null || chart.freeze == null || p.ok == null) return null;
return chart.notes + chart.freeze + (chart.shock ?? 0) - p.ok;
}

export function judgeSumCheck(
p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss" | "ok">,
chart: ChartLike | null | undefined,
): JudgeSumCheck {
if (!chart || chart.notes == null) return "no_master";
const expected = expectedJudgeSum(p, chart) ?? chart.notes;
return judgeSum(p) === expected? "match": "check";
}

export interface ScoreEvaluation {
ex_check: ExCheck;
judge_sum_check: JudgeSumCheck;
needs_review: boolean;
reasons: ReviewReason[];
}

export type ScoreCheckInput = Pick<
  PlayerExtraction,
  "marvelous" | "ok" | "perfect" | "great" | "good" | "miss" | "ex_score"
> & {
  score?: number | null;
  level?: number | null;
  max_combo?: number | null;
};

/**
 * Compute explicit review reasons for a score row against its linked song/chart.
 */
export function computeReviewReasons(
  p: ScoreCheckInput,
  chart: ChartLike | null | undefined,
  opts: { songLinked: boolean; chartLinked: boolean; playerUnresolved?: boolean },
): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (!opts.songLinked && !opts.chartLinked) {
    reasons.push({ code: "unlinked_song" });
  } else if (opts.songLinked && !opts.chartLinked) {
    reasons.push({ code: "difficulty_mismatch" });
  }
  if (opts.chartLinked && chart?.level != null && p.level != null && p.level !== chart.level) {
    reasons.push({
      code: "level_mismatch",
      detail: { extracted_level: p.level, master_level: chart.level },
    });
  }
  const ex = exCheck(p);
  if (ex === "mismatch") {
    const calc = calcEx(p);
    reasons.push({
      code: "ex_mismatch",
      detail: {
        ex_score: p.ex_score ?? null,
        calc_ex: calc,
        diff: p.ex_score != null && calc != null ? p.ex_score - calc : null,
      },
    });
  }
  if (chart?.max_ex != null && p.ex_score != null && p.ex_score > chart.max_ex) {
    reasons.push({
      code: "ex_invalid",
      detail: { reason: "exceeds_max_ex", ex_score: p.ex_score, max_ex: chart.max_ex },
    });
  } else if (p.ex_score != null && p.ex_score < 0) {
    reasons.push({
      code: "ex_invalid",
      detail: { reason: "negative", ex_score: p.ex_score },
    });
  } else if (p.score != null && p.score > 0 && (p.ex_score == null || p.ex_score === 0)) {
    reasons.push({
      code: "ex_invalid",
      detail: { reason: "missing_or_zero", score: p.score },
    });
  }
  const jsum = judgeSumCheck(p, chart);
  if (jsum === "check") {
    reasons.push({
      code: "judge_sum_mismatch",
      detail: {
        judge_sum: judgeSum(p),
        expected: expectedJudgeSum(p, chart) ?? chart?.notes ?? 0,
      },
    });
  }
  if (chart?.freeze != null && p.ok != null && p.ok > chart.freeze + (chart.shock ?? 0)) {
    const maxOk = chart.freeze + (chart.shock ?? 0);
    reasons.push({
      code: "ok_exceeds_max",
      detail: { ok: p.ok, max_ok: maxOk },
    });
  }
  if (chart?.notes != null && p.max_combo != null) {
    const maxCombo = chart.notes + (chart.shock ?? 0);
    if (p.max_combo > maxCombo) {
      reasons.push({
        code: "max_combo_exceeds_notes",
        detail: { max_combo: p.max_combo, max_notes: maxCombo },
      });
    }
  }
  if (opts.playerUnresolved) {
    reasons.push({ code: "player_unresolved" });
  }
  return reasons;
}

/**
 * Combined review decision used by analyze / PATCH / select-player / link.
 * needs_review when any review reason is present.
 * A 'no_master' judge check alone does not force review, because masters
 * synced from the v1 format carry no notecounts at all.
 */
export function evaluateScore(
  p: ScoreCheckInput,
  chart: ChartLike | null | undefined,
  opts: { chartLinked: boolean; songLinked?: boolean; playerUnresolved?: boolean },
): ScoreEvaluation {
  const ex_check = exCheck(p);
  const judge_sum_check = judgeSumCheck(p, chart);
  const reasons = computeReviewReasons(p, chart, {
    songLinked: opts.songLinked ?? opts.chartLinked,
    chartLinked: opts.chartLinked,
    playerUnresolved: opts.playerUnresolved,
  });
  const needs_review = reasons.length > 0;
  return { ex_check, judge_sum_check, needs_review, reasons };
}

function normalizeDancerName(name: string | null | undefined): string {
return (name?? "").trim().toLowerCase();
}

export interface ChosenPlayer {
player: PlayerExtraction;
index: 1 | 2;
matched: boolean;
unresolved: boolean;
}

/**
* Pick the user's own player from an extraction.
* Solo (only player_1) is always player_1. For versus, the player whose
* dancer_name matches MY_DANCER_NAME (trim + case-insensitive) wins.
* If neither matches, player_1 is tentatively chosen and flagged unresolved.
*/
export function choosePlayer(ext: Extraction, myDancerName: string | null | undefined): ChosenPlayer | null {
const p1 = ext.player_1;
const p2 = ext.player_2;
if (!p1 &&!p2) return null;
if (!p2) return { player: p1 as PlayerExtraction, index: 1, matched: true, unresolved: false};
if (!p1) return { player: p2, index: 2, matched: false, unresolved: true};
const mine = normalizeDancerName(myDancerName);
if (mine && normalizeDancerName(p1.dancer_name) === mine) {
return { player: p1, index: 1, matched: true, unresolved: false};
}
if (mine && normalizeDancerName(p2.dancer_name) === mine) {
return { player: p2, index: 2, matched: true, unresolved: false};
}
return { player: p1, index: 1, matched: false, unresolved: true};
}

// ---- Master data (sync) ----

export interface SongRow {
song_id: string;
title: string;
title_normalized: string;
artist: string | null;
version: string | null;
bpm: string | null;
phash_8: string | null;
phash_16: string | null;
availability: string | null;
deleted_at: string | null;
/** 1 when a jacket image is available in KV; null when the master does not carry the flag. */
has_jacket: number | null;
}

export interface ChartRow {
chart_id: string;
song_id: string;
play_style: string;
difficulty: string;
level: number | null;
notes: number | null;
freeze: number | null;
shock: number | null;
max_ex: number | null;
}

function toInt(v: unknown): number | null {
if (v == null || v === "") return null;
const n = typeof v === "number"? v: parseInt(String(v), 10);
return Number.isFinite(n)? n: null;
}

function toStr(v: unknown): string | null {
if (v == null || v === "") return null;
return String(v);
}

/** v2 = levels/notecounts objects; v1 = flat single_*_level / double_*_level fields. */
export function detectMasterFormat(song: Record<string, unknown>): "v1" | "v2" {
if (song && typeof song === "object") {
if (song.levels && typeof song.levels === "object") return "v2";
if (song.notecounts && typeof song.notecounts === "object") return "v2";
for (const k of Object.keys(song)) {
if (/^(single|double)_.+_level$/.test(k)) return "v1";
}
}
return "v2";
}

const V2_KEYMAP: Array<[string, string, string]> = [
["sp_beginner", "SP", "BEGINNER"],
["sp_basic", "SP", "BASIC"],
["sp_difficult", "SP", "DIFFICULT"],
["sp_expert", "SP", "EXPERT"],
["sp_challenge", "SP", "CHALLENGE"],
["dp_basic", "DP", "BASIC"],
["dp_difficult", "DP", "DIFFICULT"],
["dp_expert", "DP", "EXPERT"],
["dp_challenge", "DP", "CHALLENGE"],
];

const V1_KEYMAP: Array<[string, string, string]> = [
["single_beginner_level", "SP", "BEGINNER"],
["single_basic_level", "SP", "BASIC"],
["single_difficult_level", "SP", "DIFFICULT"],
["single_expert_level", "SP", "EXPERT"],
["single_challenge_level", "SP", "CHALLENGE"],
["double_beginner_level", "DP", "BEGINNER"],
["double_basic_level", "DP", "BASIC"],
["double_difficult_level", "DP", "DIFFICULT"],
["double_expert_level", "DP", "EXPERT"],
["double_challenge_level", "DP", "CHALLENGE"],
];

export function expandMasterSong(raw: Record<string, any>): { song: SongRow; charts: ChartRow[]} {
const format = detectMasterFormat(raw);
const songId = String(raw.id);
const song: SongRow = {
song_id: songId,
title: String(raw.title),
title_normalized: normalizeTitle(String(raw.title)),
artist: toStr(raw.artist),
version:
format === "v2"
? toStr(raw.version_current)?? toStr(raw.version_remy_first_ddr)?? toStr(raw.version)
: toStr(raw.version),
bpm: toStr(raw.bpm),
phash_8: toStr(raw.phash_8),
phash_16: toStr(raw.phash_16),
availability: toStr(raw.availability),
deleted_at: toStr(raw.deleted_at),
has_jacket: typeof raw.jacket === "boolean" ? (raw.jacket ? 1 : 0) : null,
};
const charts: ChartRow[] = [];
if (format === "v2") {
const levels = (raw.levels?? {}) as Record<string, unknown>;
const notecounts = (raw.notecounts?? {}) as Record<string, any>;
for (const [key, style, diff] of V2_KEYMAP) {
const level = toInt(levels[key]);
if (level == null) continue;
const nc = notecounts[key]?? {};
const notes = toInt(nc.notes);
const freeze = toInt(nc.freeze);
const shock = toInt(nc.shock);
const max_ex = notes!= null && freeze!= null? (notes + freeze + (shock?? 0)) * 3: null;
charts.push({
chart_id: chartId(songId, style, diff),
song_id: songId,
play_style: style,
difficulty: diff,
level,
notes,
freeze,
shock,
max_ex,
});
}
} else {
for (const [key, style, diff] of V1_KEYMAP) {
const level = toInt(raw[key]);
if (level == null) continue;
charts.push({
chart_id: chartId(songId, style, diff),
song_id: songId,
play_style: style,
difficulty: diff,
level,
notes: null,
freeze: null,
shock: null,
max_ex: null,
});
}
}
return { song, charts};
}

export function expandMaster(rawSongs: Array<Record<string, any>>): { songs: SongRow[]; charts: ChartRow[]} {
const songs: SongRow[] = [];
const charts: ChartRow[] = [];
for (const raw of rawSongs) {
const { song, charts: cs} = expandMasterSong(raw);
songs.push(song);
charts.push(...cs);
}
return { songs, charts};
}

/**
 * Diff the expanded master against the current DB rows so a sync only
 * writes what actually changed. This keeps the daily cron sync near-zero
 * writes (D1 free-tier write quota) and stops songs.updated_at from being
 * bumped when nothing changed. A null field in the master means "this
 * master format does not carry it" (e.g. v1 has no notecounts) and never
 * counts as a change by itself.
 */
export function planSync(
  existingSongs: SongRow[],
  existingCharts: ChartRow[],
  masterSongs: SongRow[],
  masterCharts: ChartRow[],
): { songUpserts: SongRow[]; chartUpserts: ChartRow[] } {
  const songById = new Map(existingSongs.map((s) => [s.song_id, s]));
  const songUpserts = masterSongs.filter((m) => {
    const e = songById.get(m.song_id);
    if (!e) return true;
    return (
      e.title !== m.title ||
      e.title_normalized !== m.title_normalized ||
      e.artist !== m.artist ||
      e.version !== m.version ||
      e.bpm !== m.bpm ||
      e.availability !== m.availability ||
      e.deleted_at !== m.deleted_at ||
      (m.phash_8 != null && e.phash_8 !== m.phash_8) ||
      (m.phash_16 != null && e.phash_16 !== m.phash_16) ||
      (m.has_jacket != null && e.has_jacket !== m.has_jacket)
    );
  });
  const chartById = new Map(existingCharts.map((ch) => [ch.chart_id, ch]));
  const chartUpserts = masterCharts.filter((m) => {
    const e = chartById.get(m.chart_id);
    if (!e) return true;
    if (e.level !== m.level) return true;
    // v2 masters carry notecounts; refresh them when they actually change.
    if (m.notes != null && (e.notes !== m.notes || e.freeze !== m.freeze || e.shock !== m.shock)) return true;
    return false;
  });
  return { songUpserts, chartUpserts };
}

/**
 * Validate a client-supplied capture time (ISO string from EXIF etc.).
 * Returns epoch ms (the unit scores.played_at uses), or null when
 * unusable: unparseable, before 2010, or more than 1 hour in the future
 * (clock-skew allowance).
 */
export function parsePlayedAt(input: unknown, nowMs: number): number | null {
  if (typeof input !== "string" || !input) return null;
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) return null;
  if (ms < 1262304000000) return null; // 2010-01-01
  if (ms > nowMs + 3600000) return null;
  return ms;
}

/** JST (UTC+9) calendar date "YYYY-MM-DD" for an epoch-ms timestamp. */
export function jstDateString(ms: number): string {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Epoch ms of 00:00 JST on the given "YYYY-MM-DD" date. */
export function jstDayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00+09:00`);
}

export interface DayScoreRow {
  id: string;
  chart_id: string | null;
  score: number;
  played_at: number;
}

export interface DayUpdate<T extends DayScoreRow> {
  row: T;
  prev_best: number | null;
  diff: number | null;
  is_new: boolean;
}

/**
 * From one day's scores (any order) and each chart's best score BEFORE
 * that day, compute which charts got a personal-best update that day.
 * A chart played several times counts once, with its best score of the day.
 */
export function computeDayUpdates<T extends DayScoreRow>(
  dayScores: T[],
  prevBestByChart: Map<string, number>,
): DayUpdate<T>[] {
  const bestByChart = new Map<string, T>();
  for (const s of dayScores) {
    if (!s.chart_id) continue;
    const cur = bestByChart.get(s.chart_id);
    if (!cur || s.score > cur.score || (s.score === cur.score && s.played_at > cur.played_at)) {
      bestByChart.set(s.chart_id, s);
    }
  }
  const updates: DayUpdate<T>[] = [];
  for (const [chartId, row] of bestByChart) {
    const prev = prevBestByChart.get(chartId);
    if (prev === undefined) {
      updates.push({ row, prev_best: null, diff: null, is_new: true });
    } else if (row.score > prev) {
      updates.push({ row, prev_best: prev, diff: row.score - prev, is_new: false });
    }
  }
  return updates.sort((a, b) => (b.diff ?? Number.MAX_SAFE_INTEGER) - (a.diff ?? Number.MAX_SAFE_INTEGER));
}

export type SongCategory = "CLASSIC" | "WHITE" | "GOLD";

/**
 * Song category by its version folder (the version the song belongs to,
 * i.e. its debut folder — NOT when a chart was added later):
 *   CLASSIC: 1st .. X3 VS 2ndMIX
 *   WHITE:   (2013) .. A
 *   GOLD:    A20 .. WORLD
 * Stored version strings come in two spellings (dataset: "X3 vs 2nd",
 * "Extreme", "MAX2"; RemyWiki: "X3", "EXTREME", "DDRMAX2"), so matching is
 * case-insensitive with synonyms. Unknown versions return null.
 */
const CATEGORY_BY_VERSION = new Map<string, SongCategory>([
  ...["1ST", "2ND", "3RD", "4TH", "5TH", "MAX", "DDRMAX", "MAX2", "DDRMAX2",
    "EXTREME", "SUPERNOVA", "SUPERNOVA2", "X", "X2", "X3", "X3 VS 2ND", "X3 VS 2NDMIX"]
    .map((v) => [v, "CLASSIC"] as [string, SongCategory]),
  ...["2013", "2014", "A"].map((v) => [v, "WHITE"] as [string, SongCategory]),
  ...["A20", "A20 PLUS", "A3", "WORLD"].map((v) => [v, "GOLD"] as [string, SongCategory]),
]);

export function songCategory(version: string | null | undefined): SongCategory | null {
  if (!version) return null;
  return CATEGORY_BY_VERSION.get(version.trim().toUpperCase()) ?? null;
}

/** Exact stored spellings per category, for SQL IN() filters on songs.version. */
export const CATEGORY_VERSION_SPELLINGS: Record<SongCategory, string[]> = {
  CLASSIC: ["1st", "2nd", "3rd", "4th", "5th", "MAX", "DDRMAX", "MAX2", "DDRMAX2",
    "Extreme", "EXTREME", "SuperNOVA", "SuperNOVA2", "X", "X2", "X3", "X3 vs 2nd"],
  WHITE: ["2013", "2014", "A"],
  GOLD: ["A20", "A20 PLUS", "A3", "WORLD"],
};

// ---- close calls ("あと少し" list) ----

/** Score needed for AAA. */
export const AAA_SCORE = 990000;
/** A best score within this many points of AAA counts as "almost there". */
export const CLOSE_CALL_SCORE_GAP = 10000;
/** A next lamp within this many judgments to fix counts as "almost there". */
export const CLOSE_CALL_LAMP_GAP = 5;

export interface CloseCallPlay {
  chart_id: string;
  score: number;
  rank: string | null;
  clear_lamp: string | null;
  marvelous: number | null;
  perfect: number | null;
  great: number | null;
  good: number | null;
  miss: number | null;
}

export interface LampGap {
  next_lamp: string;
  gap: number;
}

/**
 * Distance (in judgments to fix) from the current clear lamp to the next
 * one, or null when there is no next lamp (MFC, FAILED, unknown lamp) or
 * when the judgments needed for the distance are missing (null means the
 * value was not read — never treat it as 0, or missing data would look
 * like a zero-gap close call).
 * DDR combo rules: a Good does not break the combo, a Miss does; GFC
 * allows at most one Great and no Good/Miss; PFC allows no Great/Good/Miss;
 * MFC allows no Perfect either. FAILED has no lamp progression — clearing
 * the chart comes first, so it is not a close call.
 */
export function lampGap(
  p: Pick<CloseCallPlay, "clear_lamp" | "great" | "good" | "miss" | "perfect">,
): LampGap | null {
  const lamp = p.clear_lamp;
  if (!lamp) return null;
  const { great, good, miss, perfect } = p;
  switch (lamp) {
    case "CLEAR":
    case "LIFE4":
      if (miss == null) return null;
      return { next_lamp: "FC", gap: miss };
    case "FC":
      if (great == null || good == null) return null;
      return { next_lamp: "GFC", gap: Math.max(0, great + good - 1) };
    case "GFC":
      if (great == null || good == null) return null;
      return { next_lamp: "PFC", gap: great + good };
    case "PFC":
      if (perfect == null) return null;
      return { next_lamp: "MFC", gap: perfect };
    default:
      return null;
  }
}

export type CloseCallKind = "aaa" | "lamp";

export interface CloseCall {
  chart_id: string;
  kind: CloseCallKind;
  /** Score gap to AAA (kind "aaa") or judgment gap to the next lamp (kind "lamp"). */
  gap: number;
  next_lamp?: string;
  score: number;
  rank: string | null;
  clear_lamp: string | null;
}

/**
 * From each chart's best-score play, find the "almost there" charts:
 * best score within CLOSE_CALL_SCORE_GAP of AAA, and/or the next lamp
 * within CLOSE_CALL_LAMP_GAP judgments. A chart can appear twice (one
 * entry per kind). Lamp close calls come first, each group sorted by gap.
 */
export function computeCloseCalls(plays: CloseCallPlay[]): CloseCall[] {
  const out: CloseCall[] = [];
  for (const p of plays) {
    if (p.score >= AAA_SCORE - CLOSE_CALL_SCORE_GAP && p.score < AAA_SCORE) {
      out.push({
        chart_id: p.chart_id, kind: "aaa", gap: AAA_SCORE - p.score,
        score: p.score, rank: p.rank, clear_lamp: p.clear_lamp,
      });
    }
    const lg = lampGap(p);
    if (lg && lg.gap <= CLOSE_CALL_LAMP_GAP) {
      out.push({
        chart_id: p.chart_id, kind: "lamp", gap: lg.gap, next_lamp: lg.next_lamp,
        score: p.score, rank: p.rank, clear_lamp: p.clear_lamp,
      });
    }
  }
  const kindOrder = (k: CloseCallKind) => (k === "lamp" ? 0 : 1);
  return out.sort((a, b) =>
    kindOrder(a.kind) - kindOrder(b.kind) || a.gap - b.gap || a.chart_id.localeCompare(b.chart_id));
}


/** Clear-lamp strength. LIFE4 is a clear, not a full combo. */
export const LAMP_RANK: Record<string, number> = {
  FAILED: 0, CLEAR: 1, LIFE4: 2, FC: 3, GFC: 4, PFC: 5, MFC: 6,
};

/** Score-rank strength, weakest first. */
export const RANK_ORDER = [
  "E", "D", "D+", "C-", "C", "C+", "B-", "B", "B+",
  "A-", "A", "A+", "AA-", "AA", "AA+", "AAA",
];

export interface StatPlay {
  chart_id: string | null;
  score: number;
  rank: string | null;
  clear_lamp: string | null;
  played_at: number;
  ex_score?: number | null;
  flare_rank?: string | null;
  marvelous?: number | null;
  perfect?: number | null;
  great?: number | null;
  good?: number | null;
  ok?: number | null;
  miss?: number | null;
}

/** Flare rank strength (the hexagon badge on the result screen): I=1 .. IX=9, EX=10. */
export const FLARE_ORDER: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, EX: 10,
};

/** The user's current flare clear targets: chart level x minimum flare rank. */
export const FLARE_TARGETS: { level: number; min_rank: string }[] = [
  { level: 16, min_rank: "EX" },
  { level: 17, min_rank: "EX" },
  { level: 17, min_rank: "IX" },
  { level: 18, min_rank: "IX" },
];

export interface StatMasterChart {
  chart_id: string;
  play_style: string;
  level: number | null;
  category: SongCategory | null;
  max_ex?: number | null;
  title?: string | null;
}

export interface AchievementBucket {
  total_charts: number;
  played: number;
  clear: number;
  fc: number;
  gfc: number;
  pfc: number;
  mfc: number;
}

export interface StatsResult {
  totals: AchievementBucket & {
    plays: number;
    play_days: number;
    aaa: number;
    max_clear_level: number | null;
  };
  by_level: ({ play_style: string; level: number } & AchievementBucket)[];
  by_category: ({ category: SongCategory } & AchievementBucket)[];
  monthly: { month: string; plays: number; pb_updates: number; avg_ex_rate: number | null }[];
  /** Per-level average EX rate: each chart contributes its best EX rate (best ex_score / max_ex). */
  ex_rate_by_level: { play_style: string; level: number; avg_ex_rate: number | null; charts: number }[];
  /** Days with plays in the last 365 JST days (sparse; days without plays are omitted). */
  calendar: { date: string; plays: number }[];
  /** Per-chart best flare rank on a clear (strongest first), plus target progress. */
  flare: {
    by_rank: { flare_rank: string; charts: number }[];
    charts_with_flare: number;
    /**
     * Progress toward FLARE_TARGETS (level x minimum flare rank). A chart
     * counts as achieved when its best flare rank on a clear reaches the
     * target (an EX clear also satisfies an IX target). Candidates are
     * charts at that level already cleared below the target rank, closest
     * first. Lists are capped; counts are exact.
     */
    targets: {
      level: number;
      min_rank: string;
      achieved: { chart_id: string; title: string | null; play_style: string; flare_rank: string }[];
      achieved_count: number;
      candidates: { chart_id: string; title: string | null; play_style: string; best_flare_rank: string | null }[];
      candidate_count: number;
    }[];
  };
  /** Aggregates shaped for the Stats page graphs. */
  graphs: {
    /** Plays per level within each of the 12 monthly buckets (same months as `monthly`). */
    level_monthly: { month: string; level: number; plays: number }[];
    /** Judgment sums per JST play day (days without plays omitted, ascending). */
    judge_daily: {
      date: string; plays: number;
      marvelous: number; perfect: number; great: number; good: number; ok: number; miss: number;
    }[];
    /** Chart coverage per play style x level x difficulty (difficulty parsed from chart_id). */
    coverage: {
      play_style: string; level: number; difficulty: string;
      total: number; played: number; cleared: number;
    }[];
  };
}

const emptyBucket = (): AchievementBucket => ({
  total_charts: 0, played: 0, clear: 0, fc: 0, gfc: 0, pfc: 0, mfc: 0,
});

/**
 * Aggregate achievements and activity from the master chart list and ALL
 * plays (any order). Per chart, the best lamp and best rank are taken
 * across all its plays (not just the best-score play). Monthly PB updates
 * count strict score improvements on already-played charts, by JST month,
 * for the 12 months ending with nowMs's month. Plays without a chart_id
 * count toward totals.plays and monthly plays only.
 * EX rates use only plays/charts whose chart has a max_ex (notecounts):
 * monthly avg EX rate averages every qualifying play in the month, while
 * the per-level rate averages each chart's best EX rate once.
 */
export function computeStats(
  masterCharts: StatMasterChart[],
  plays: StatPlay[],
  nowMs: number,
): StatsResult {
  const sorted = [...plays].sort((a, b) => a.played_at - b.played_at);

  // Monthly buckets for the last 12 JST months (oldest first).
  const months: StatsResult["monthly"] = [];
  const monthIdx = new Map<string, number>();
  const monthExSum: number[] = [];
  const monthExCount: number[] = [];
  {
    const now = new Date(nowMs + 9 * 3600 * 1000); // JST wall clock
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth(); // 0-based
    const keys: string[] = [];
    for (let i = 0; i < 12; i++) {
      keys.unshift(`${y}-${String(m + 1).padStart(2, "0")}`);
      m -= 1;
      if (m < 0) { m = 11; y -= 1; }
    }
    for (const k of keys) {
      monthIdx.set(k, months.length);
      months.push({ month: k, plays: 0, pb_updates: 0, avg_ex_rate: null });
      monthExSum.push(0);
      monthExCount.push(0);
    }
  }

  const chartMaxEx = new Map<string, number>();
  for (const ch of masterCharts) {
    if (ch.max_ex != null) chartMaxEx.set(ch.chart_id, ch.max_ex);
  }

  const bestScore = new Map<string, number>();
  const bestLamp = new Map<string, number>();
  const bestRank = new Map<string, number>();
  const bestEx = new Map<string, number>();
  /** Best flare rank value per chart across CLEARED plays (0 = cleared without the flare gauge). */
  const bestFlare = new Map<string, number>();
  const playDays = new Set<string>();
  const playsByDay = new Map<string, number>();
  // Graph aggregates.
  const chartLevel = new Map<string, number | null>();
  for (const ch of masterCharts) chartLevel.set(ch.chart_id, ch.level);
  const levelMonthCounts = new Map<string, number>(); // `${monthIdx}|${level}` -> plays
  const judgeDaily = new Map<string, StatsResult["graphs"]["judge_daily"][number]>();

  for (const p of sorted) {
    const day = jstDateString(p.played_at);
    playDays.add(day);
    playsByDay.set(day, (playsByDay.get(day) ?? 0) + 1);
    const mi = monthIdx.get(day.slice(0, 7));
    if (mi !== undefined) months[mi].plays += 1;
    if (p.marvelous != null || p.perfect != null || p.great != null || p.good != null || p.ok != null || p.miss != null) {
      let jd = judgeDaily.get(day);
      if (!jd) {
        jd = { date: day, plays: 0, marvelous: 0, perfect: 0, great: 0, good: 0, ok: 0, miss: 0 };
        judgeDaily.set(day, jd);
      }
      jd.plays += 1;
      jd.marvelous += p.marvelous ?? 0;
      jd.perfect += p.perfect ?? 0;
      jd.great += p.great ?? 0;
      jd.good += p.good ?? 0;
      jd.ok += p.ok ?? 0;
      jd.miss += p.miss ?? 0;
    }
    if (!p.chart_id) continue;
    if (mi !== undefined) {
      const lv = chartLevel.get(p.chart_id);
      if (lv != null) {
        const key = `${mi}|${lv}`;
        levelMonthCounts.set(key, (levelMonthCounts.get(key) ?? 0) + 1);
      }
    }
    const prevBest = bestScore.get(p.chart_id);
    if (prevBest !== undefined && p.score > prevBest && mi !== undefined) {
      months[mi].pb_updates += 1;
    }
    if (prevBest === undefined || p.score > prevBest) bestScore.set(p.chart_id, p.score);
    const lamp = p.clear_lamp != null ? (LAMP_RANK[p.clear_lamp] ?? -1) : -1;
    if (lamp > (bestLamp.get(p.chart_id) ?? -1)) bestLamp.set(p.chart_id, lamp);
    const rank = p.rank != null ? RANK_ORDER.indexOf(p.rank) : -1;
    if (rank > (bestRank.get(p.chart_id) ?? -1)) bestRank.set(p.chart_id, rank);
    // "Highest flare gauge cleared" only counts plays with a clear lamp.
    // A badge-like read on a FAILED screen must not count as a clear.
    const cleared = p.clear_lamp != null && p.clear_lamp !== "FAILED";
    if (cleared) {
      const flare = p.flare_rank != null ? (FLARE_ORDER[p.flare_rank] ?? 0) : 0;
      if (flare > (bestFlare.get(p.chart_id) ?? -1)) bestFlare.set(p.chart_id, flare);
    }
    if (p.ex_score != null) {
      if (p.ex_score > (bestEx.get(p.chart_id) ?? -1)) bestEx.set(p.chart_id, p.ex_score);
      const mx = chartMaxEx.get(p.chart_id);
      if (mx && mi !== undefined) {
        monthExSum[mi] += p.ex_score / mx;
        monthExCount[mi] += 1;
      }
    }
  }
  for (let i = 0; i < months.length; i++) {
    months[i].avg_ex_rate = monthExCount[i] > 0
      ? Math.round((monthExSum[i] / monthExCount[i]) * 1000) / 10
      : null;
  }

  const applyTo = (b: AchievementBucket, chartId: string) => {
    b.total_charts += 1;
    if (!bestScore.has(chartId)) return;
    b.played += 1;
    const lamp = bestLamp.get(chartId) ?? -1;
    if (lamp >= LAMP_RANK.CLEAR) b.clear += 1;
    if (lamp >= LAMP_RANK.FC) b.fc += 1;
    if (lamp >= LAMP_RANK.GFC) b.gfc += 1;
    if (lamp >= LAMP_RANK.PFC) b.pfc += 1;
    if (lamp >= LAMP_RANK.MFC) b.mfc += 1;
  };

  const totals: StatsResult["totals"] = {
    ...emptyBucket(), plays: plays.length, play_days: playDays.size, aaa: 0, max_clear_level: null,
  };
  const levelMap = new Map<string, StatsResult["by_level"][number]>();
  const catMap = new Map<SongCategory, AchievementBucket>();
  for (const cat of ["GOLD", "WHITE", "CLASSIC"] as SongCategory[]) catMap.set(cat, emptyBucket());

  for (const ch of masterCharts) {
    applyTo(totals, ch.chart_id);
    if (bestRank.get(ch.chart_id) === RANK_ORDER.length - 1) totals.aaa += 1;
    if ((bestLamp.get(ch.chart_id) ?? -1) >= LAMP_RANK.CLEAR && ch.level != null) {
      totals.max_clear_level = Math.max(totals.max_clear_level ?? 0, ch.level);
    }
    if (ch.level != null) {
      const key = `${ch.play_style}|${ch.level}`;
      let row = levelMap.get(key);
      if (!row) {
        row = { play_style: ch.play_style, level: ch.level, ...emptyBucket() };
        levelMap.set(key, row);
      }
      applyTo(row, ch.chart_id);
    }
    if (ch.category) applyTo(catMap.get(ch.category)!, ch.chart_id);
  }

  const by_level = [...levelMap.values()].sort((a, b) =>
    a.play_style === b.play_style ? b.level - a.level : a.play_style === "SP" ? -1 : 1);
  const by_category = (["GOLD", "WHITE", "CLASSIC"] as SongCategory[])
    .map((category) => ({ category, ...catMap.get(category)! }));

  // Per-level average EX rate (each chart contributes its best EX rate once).
  const exByLevel = new Map<string, { sum: number; n: number }>();
  for (const ch of masterCharts) {
    if (ch.level == null) continue;
    const ex = bestEx.get(ch.chart_id);
    const mx = chartMaxEx.get(ch.chart_id);
    if (ex == null || !mx) continue;
    const key = `${ch.play_style}|${ch.level}`;
    const cur = exByLevel.get(key) ?? { sum: 0, n: 0 };
    cur.sum += ex / mx;
    cur.n += 1;
    exByLevel.set(key, cur);
  }
  const ex_rate_by_level = [...exByLevel.entries()]
    .map(([key, v]) => {
      const [play_style, level] = key.split("|");
      return {
        play_style,
        level: parseInt(level, 10),
        avg_ex_rate: Math.round((v.sum / v.n) * 1000) / 10,
        charts: v.n,
      };
    })
    .sort((a, b) =>
      a.play_style === b.play_style ? b.level - a.level : a.play_style === "SP" ? -1 : 1);

  // Play calendar: last 365 JST days ending today (sparse).
  const endDay = jstDateString(nowMs);
  const startMs = jstDayStartMs(endDay) - 364 * 86400000;
  const calendar = [...playsByDay.entries()]
    .filter(([date]) => {
      const ms = jstDayStartMs(date);
      return ms >= startMs && ms <= jstDayStartMs(endDay);
    })
    .map(([date, plays]) => ({ date, plays }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Flare: per-chart best flare rank, strongest first (EX, IX, ..., I).
  const flareCounts = new Map<number, number>();
  for (const ch of masterCharts) {
    const f = bestFlare.get(ch.chart_id);
    if (f != null && f > 0) flareCounts.set(f, (flareCounts.get(f) ?? 0) + 1);
  }

  // Flare clear targets (level x minimum rank): achieved charts and
  // already-cleared candidates below the target rank.
  const rankLabel = (v: number): string | null =>
    v <= 0 ? null : Object.keys(FLARE_ORDER).find((k) => FLARE_ORDER[k] === v) ?? null;
  const flareTargets: StatsResult["flare"]["targets"] = FLARE_TARGETS.map((t) => {
    const need = FLARE_ORDER[t.min_rank] ?? 0;
    const achieved: StatsResult["flare"]["targets"][number]["achieved"] = [];
    const candidates: (StatsResult["flare"]["targets"][number]["candidates"][number] & { v: number })[] = [];
    for (const ch of masterCharts) {
      if (ch.level !== t.level) continue;
      const best = bestFlare.get(ch.chart_id);
      if (best == null) continue; // never cleared
      if (best >= need) {
        achieved.push({
          chart_id: ch.chart_id,
          title: ch.title ?? null,
          play_style: ch.play_style,
          flare_rank: rankLabel(best)!,
        });
      } else {
        candidates.push({
          chart_id: ch.chart_id,
          title: ch.title ?? null,
          play_style: ch.play_style,
          best_flare_rank: rankLabel(best),
          v: best,
        });
      }
    }
    achieved.sort((a, b) => a.play_style.localeCompare(b.play_style) || (a.title ?? "").localeCompare(b.title ?? ""));
    candidates.sort((a, b) => b.v - a.v || (a.title ?? "").localeCompare(b.title ?? ""));
    return {
      level: t.level,
      min_rank: t.min_rank,
      achieved: achieved.slice(0, 50),
      achieved_count: achieved.length,
      candidates: candidates.slice(0, 20).map(({ v: _v, ...rest }) => rest),
      candidate_count: candidates.length,
    };
  });

  const flare = {
    by_rank: [...flareCounts.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([v, charts]) => ({
        flare_rank: Object.keys(FLARE_ORDER).find((k) => FLARE_ORDER[k] === v)!,
        charts,
      })),
    charts_with_flare: [...flareCounts.values()].reduce((a, b) => a + b, 0),
    targets: flareTargets,
  };

  // Graphs: level x month rows (12 monthly buckets), judgment days, coverage.
  const levelMonthly: StatsResult["graphs"]["level_monthly"] = [];
  for (const [key, plays] of levelMonthCounts) {
    const [mi, lv] = key.split("|");
    levelMonthly.push({ month: months[Number(mi)].month, level: Number(lv), plays });
  }
  levelMonthly.sort((a, b) => a.month.localeCompare(b.month) || a.level - b.level);
  const coverageMap = new Map<string, StatsResult["graphs"]["coverage"][number]>();
  for (const ch of masterCharts) {
    if (ch.level == null) continue;
    const difficulty = ch.chart_id.split("|")[2] ?? "";
    const key = `${ch.play_style}|${ch.level}|${difficulty}`;
    let cell = coverageMap.get(key);
    if (!cell) {
      cell = { play_style: ch.play_style, level: ch.level, difficulty, total: 0, played: 0, cleared: 0 };
      coverageMap.set(key, cell);
    }
    cell.total += 1;
    if (bestScore.has(ch.chart_id)) cell.played += 1;
    if ((bestLamp.get(ch.chart_id) ?? -1) >= LAMP_RANK.CLEAR) cell.cleared += 1;
  }
  const graphs: StatsResult["graphs"] = {
    level_monthly: levelMonthly,
    judge_daily: [...judgeDaily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    coverage: [...coverageMap.values()].sort(
      (a, b) => a.play_style.localeCompare(b.play_style) || b.level - a.level || a.difficulty.localeCompare(b.difficulty),
    ),
  };

  return { totals, by_level, by_category, monthly: months, ex_rate_by_level, calendar, flare, graphs };
}

// ---- versus history ----

export interface VersusRow {
  id: string;
  song_title: string | null;
  raw_extraction: string | null;
  played_at: number;
}

export type VersusResult = "win" | "loss" | "draw" | "unknown";

export interface VersusOpponent {
  name: string;
  plays: number;
  wins: number;
  losses: number;
  draws: number;
  last_played_at: number;
}

export interface VersusRecent {
  score_id: string;
  opponent: string;
  song_title: string | null;
  my_score: number | null;
  opp_score: number | null;
  result: VersusResult;
  played_at: number;
}

export interface VersusSummary {
  opponents: VersusOpponent[];
  recent: VersusRecent[];
}

/**
 * Versus history from the opponent's result stored inside each score row's
 * raw_extraction (the opponent only exists there). Rows are skipped when
 * the extraction is missing/corrupt, the play was not versus, neither
 * player matches myName (so the winner cannot be determined), or the
 * opponent has no dancer name. A missing score on either side counts as
 * a play with result "unknown" (not a win or a loss).
 */
export function computeVersus(rows: VersusRow[], myName: string | null | undefined): VersusSummary {
  const mine = (myName ?? "").trim().toLowerCase();
  const oppMap = new Map<string, VersusOpponent>();
  const recent: VersusRecent[] = [];
  for (const row of rows) {
    if (!row.raw_extraction) continue;
    let ext: Extraction;
    try {
      ext = JSON.parse(row.raw_extraction) as Extraction;
    } catch {
      continue; // corrupt extraction: skip safely
    }
    if (!ext.is_versus || !ext.player_1 || !ext.player_2) continue;
    const p1Name = (ext.player_1.dancer_name ?? "").trim().toLowerCase();
    const p2Name = (ext.player_2.dancer_name ?? "").trim().toLowerCase();
    let me: PlayerExtraction | null = null;
    let opp: PlayerExtraction | null = null;
    if (mine && p1Name === mine) {
      me = ext.player_1;
      opp = ext.player_2;
    } else if (mine && p2Name === mine) {
      me = ext.player_2;
      opp = ext.player_1;
    } else {
      continue; // cannot tell which side is mine
    }
    const oppName = (opp.dancer_name ?? "").trim();
    if (!oppName) continue;
    const myScore = me.score;
    const oppScore = opp.score;
    const result: VersusResult =
      myScore == null || oppScore == null ? "unknown"
      : myScore > oppScore ? "win"
      : myScore < oppScore ? "loss" : "draw";
    const cur = oppMap.get(oppName) ?? {
      name: oppName, plays: 0, wins: 0, losses: 0, draws: 0, last_played_at: 0,
    };
    cur.plays += 1;
    if (result === "win") cur.wins += 1;
    else if (result === "loss") cur.losses += 1;
    else if (result === "draw") cur.draws += 1;
    if (row.played_at > cur.last_played_at) cur.last_played_at = row.played_at;
    oppMap.set(oppName, cur);
    recent.push({
      score_id: row.id,
      opponent: oppName,
      song_title: row.song_title,
      my_score: myScore,
      opp_score: oppScore,
      result,
      played_at: row.played_at,
    });
  }
  const opponents = [...oppMap.values()].sort((a, b) =>
    b.plays - a.plays || b.last_played_at - a.last_played_at);
  recent.sort((a, b) => b.played_at - a.played_at);
  return { opponents, recent: recent.slice(0, 10) };
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

/**
 * Nearest songs by pHash hamming distance (closest first, at most `limit`,
 * only distances <= `maxDistance`). Songs without a valid phash_8 are skipped.
 * NOTE: verification on the 6 Phase 0 photos (2026-11-25) showed true
 * matches at distance 18-36 while unrelated songs match at 16-20, so a
 * small distance does NOT prove a match — treat candidates as suggestions
 * only, never as automatic links.
 */
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
