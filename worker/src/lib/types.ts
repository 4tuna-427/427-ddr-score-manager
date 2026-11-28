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
  /** Result-screen tab the photo shows: DETAIL (詳細リザルト) / GRAPH / FLARE / OTHER. */
  result_tab?: string | null;
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
  /**
   * Learned simultaneous-freeze deficit P for this chart (see
   * judgeSumDeficitToLearn): the number of judge-sum events the chart
   * always falls short by because same-start freeze groups resolve as
   * one event in-game while the master counts arrows. Null = not learned
   * yet; 0 is never stored (a chart with no simultaneous freezes simply
   * stays null and the plain identity applies).
   */
  judge_sum_deficit?: number | null;
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
  return DIFF_KEY[`${playStyle}|${difficulty}`] ?? null;
}

export function chartId(songId: string, playStyle: string, difficulty: string): string {
  return `${songId}|${playStyle}|${difficulty}`;
}

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
  /** Learned simultaneous-freeze deficit P; null until learned. */
  judge_sum_deficit: number | null;
}

/** A user-registered correction to a chart's master notecounts (migration 0010). */
export interface ChartCorrection {
  chart_id: string;
  notes: number | null;
  freeze: number | null;
  shock: number | null;
}

export type SongCategory = "CLASSIC" | "WHITE" | "GOLD";

/** Clear-lamp strength. LIFE4 is a clear, not a full combo. */
export const LAMP_RANK: Record<string, number> = {
  FAILED: 0, CLEAR: 1, LIFE4: 2, FC: 3, GFC: 4, PFC: 5, MFC: 6,
};

/** Score-rank strength, weakest first. */
export const RANK_ORDER = [
  "E", "D", "D+", "C-", "C", "C+", "B-", "B", "B+",
  "A-", "A", "A+", "AA-", "AA", "AA+", "AAA",
];

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
