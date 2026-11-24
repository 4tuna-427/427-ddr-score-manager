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

export function judgeSumCheck(
p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss">,
chart: ChartLike | null | undefined,
): JudgeSumCheck {
if (!chart || chart.notes == null) return "no_master";
const expected = chart.notes + (chart.shock?? 0);
return judgeSum(p) === expected? "match": "check";
}

export interface ScoreEvaluation {
ex_check: ExCheck;
judge_sum_check: JudgeSumCheck;
needs_review: boolean;
}

/**
* Combined review decision used by analyze / PATCH / select-player / link.
* needs_review when: no chart linked, the player could not be resolved,
* the EX cross-check mismatches, or the judge sum disagrees with the master.
* A 'no_master' judge check alone does not force review, because masters
* synced from the v1 format carry no notecounts at all.
*/
export function evaluateScore(
p: Pick<PlayerExtraction, "marvelous" | "ok" | "perfect" | "great" | "good" | "miss" | "ex_score">,
chart: ChartLike | null | undefined,
opts: { chartLinked: boolean; playerUnresolved?: boolean},
): ScoreEvaluation {
const ex_check = exCheck(p);
const judge_sum_check = judgeSumCheck(p, chart);
const needs_review =
!opts.chartLinked ||
!!opts.playerUnresolved ||
ex_check === "mismatch" ||
judge_sum_check === "check";
return { ex_check, judge_sum_check, needs_review};
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
