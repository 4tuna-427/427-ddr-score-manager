import type {
  ChartLike,
  ExCheck,
  Extraction,
  JudgeSumCheck,
  PlayerExtraction,
  ReviewReason,
} from "./types";

/** Theoretical EX score. Returns null when any required judgment is missing. */
export function calcEx(p: Pick<PlayerExtraction, "marvelous" | "ok" | "perfect" | "great">): number | null {
  if (p.marvelous == null || p.ok == null || p.perfect == null || p.great == null) return null;
  return (p.marvelous + p.ok) * 3 + p.perfect * 2 + p.great * 1;
}

export function exCheck(p: Pick<PlayerExtraction, "marvelous" | "ok" | "perfect" | "great" | "ex_score">): ExCheck {
  const calc = calcEx(p);
  if (calc == null || p.ex_score == null) return "no_ex";
  return calc === p.ex_score ? "match" : "mismatch";
}

/** Sum of tap judgments (null counts as 0, same as validate.py). */
export function judgeSum(p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss">): number {
  return (p.marvelous ?? 0) + (p.perfect ?? 0) + (p.great ?? 0) + (p.good ?? 0) + (p.miss ?? 0);
}

/** Expected displayed judge sum for a full play of the chart. */
export function expectedJudgeSum(
  p: Pick<PlayerExtraction, "ok">,
  chart: ChartLike | null | undefined,
): number | null {
  if (!chart || chart.notes == null || chart.freeze == null || p.ok == null) return null;
  return chart.notes + chart.freeze + (chart.shock ?? 0) - p.ok - (chart.judge_sum_deficit ?? 0);
}

/** Master notes value that would make this play's judge-sum identity hold exactly. */
export function impliedMasterNotes(
  p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss" | "ok">,
  chart: ChartLike | null | undefined,
): number | null {
  if (!chart || chart.notes == null || chart.freeze == null || p.ok == null) return null;
  const implied = judgeSum(p) - chart.freeze - (chart.shock ?? 0) + p.ok + (chart.judge_sum_deficit ?? 0);
  return implied > 0 ? implied : null;
}

export function judgeSumCheck(
  p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss" | "ok">,
  chart: ChartLike | null | undefined,
): JudgeSumCheck {
  if (!chart || chart.notes == null) return "no_master";
  const expected = expectedJudgeSum(p, chart) ?? chart.notes;
  return judgeSum(p) === expected ? "match" : "check";
}

/** Simultaneous-freeze deficit P this play proves for the chart, or null. */
export function judgeSumDeficitToLearn(
  p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss" | "ok" | "ex_score">,
  chart: ChartLike | null | undefined,
  ev: { ex_check: ExCheck; reasons: ReviewReason[] },
): number | null {
  if (!chart || chart.judge_sum_deficit != null) return null;
  if (ev.ex_check !== "match") return null;
  if (ev.reasons.length !== 1 || ev.reasons[0].code !== "judge_sum_mismatch") return null;
  const expected = expectedJudgeSum(p, chart);
  if (expected == null) return null;
  const deficit = expected - judgeSum(p);
  return deficit > 0 ? deficit : null;
}

/** Whether the photo shows the detailed result tab (詳細リザルト). */
export function isDetailResult(
  ext: { result_tab?: string | null },
  p: PlayerExtraction,
  chart?: ChartLike | null,
): boolean {
  const judgments = [p.marvelous, p.perfect, p.great, p.good, p.miss];
  const missing = judgments.filter((v) => v == null).length;
  const complete = missing === 0 && p.ok != null && p.ex_score != null && p.max_combo != null;
  if (complete && exCheck(p) === "match" && (chart == null || judgeSumCheck(p, chart) !== "check")) {
    return true;
  }
  if (ext.result_tab != null) return ext.result_tab === "DETAIL";
  return !(p.ex_score == null && p.max_combo == null && missing >= 3);
}

/** Repair an O.K. trailing-digit misread when proven by both EX and judge-sum identities. */
export function correctOkValue(
  p: Pick<PlayerExtraction, "marvelous" | "perfect" | "great" | "good" | "miss" | "ok" | "ex_score">,
  chart: ChartLike | null | undefined,
): { ok: number | null; corrected: boolean } {
  const ok = p.ok;
  if (ok == null || ok < 10 || !chart || chart.notes == null || chart.freeze == null) {
    return { ok, corrected: false };
  }
  const maxOk = chart.freeze + (chart.shock ?? 0);
  const proves = (v: number): boolean => {
    if (v < 0 || v > maxOk) return false;
    if (judgeSum(p) !== expectedJudgeSum({ ...p, ok: v }, chart)) return false;
    const calc = calcEx({ marvelous: p.marvelous, perfect: p.perfect, great: p.great, ok: v });
    return calc != null && p.ex_score != null && calc === p.ex_score;
  };
  if (proves(ok)) return { ok, corrected: false };
  for (const divisor of [10, 100]) {
    const candidate = Math.floor(ok / divisor);
    if (candidate < ok && proves(candidate)) return { ok: candidate, corrected: true };
  }
  return { ok, corrected: false };
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

/** Compute explicit review reasons for a score row against its linked song/chart. */
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
    const implied = impliedMasterNotes(p, chart);
    reasons.push({
      code: "judge_sum_mismatch",
      detail: {
        judge_sum: judgeSum(p),
        expected: expectedJudgeSum(p, chart) ?? chart?.notes ?? 0,
        ...(implied != null && chart != null && chart.notes != null && implied > chart.notes
          ? { implied_notes: implied }
          : {}),
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

/** Combined review decision used by analyze / PATCH / select-player / link. */
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
  return { ex_check, judge_sum_check, needs_review: reasons.length > 0, reasons };
}

function normalizeDancerName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

export interface ChosenPlayer {
  player: PlayerExtraction;
  index: 1 | 2;
  matched: boolean;
  unresolved: boolean;
}

/** Pick the user's own player from an extraction. */
export function choosePlayer(ext: Extraction, myDancerName: string | null | undefined): ChosenPlayer | null {
  const p1 = ext.player_1;
  const p2 = ext.player_2;
  if (!p1 && !p2) return null;
  if (!p2) return { player: p1 as PlayerExtraction, index: 1, matched: true, unresolved: false };
  if (!p1) return { player: p2, index: 2, matched: false, unresolved: true };
  const mine = normalizeDancerName(myDancerName);
  if (mine && normalizeDancerName(p1.dancer_name) === mine) {
    return { player: p1, index: 1, matched: true, unresolved: false };
  }
  if (mine && normalizeDancerName(p2.dancer_name) === mine) {
    return { player: p2, index: 2, matched: true, unresolved: false };
  }
  return { player: p1, index: 1, matched: false, unresolved: true };
}

const VALID_PATCH_DIFFS = ["BEGINNER", "BASIC", "DIFFICULT", "EXPERT", "CHALLENGE"] as const;
const NON_NEG_INT_PATCH_FIELDS = [
  "ex_score", "marvelous", "perfect", "great", "good", "ok", "miss",
  "max_combo", "fast_count", "slow_count",
] as const;
const OPT_STR_PATCH_FIELDS = ["rank", "clear_lamp", "flare_rank"] as const;

/** Validate fields accepted by PATCH /api/scores/:id. Returns an error message or null. */
export function validateScorePatch(body: Record<string, unknown>): string | null {
  if ("review_status" in body && body.review_status !== null && body.review_status !== "waiting_master") {
    return "review_status must be null or 'waiting_master'";
  }
  if ("score" in body) {
    const v = body.score;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1000000) {
      return "score must be an integer 0..1000000";
    }
  }
  for (const k of NON_NEG_INT_PATCH_FIELDS) {
    if (k in body && body[k] != null) {
      const v = body[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        return `${k} must be a non-negative integer or null`;
      }
    }
  }
  if ("level" in body && body.level != null) {
    const v = body.level;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 20) {
      return "level must be an integer 1..20 or null";
    }
  }
  if ("difficulty" in body) {
    const v = body.difficulty;
    if (typeof v !== "string" || !(VALID_PATCH_DIFFS as readonly string[]).includes(v)) {
      return `difficulty must be one of ${VALID_PATCH_DIFFS.join(", ")}`;
    }
  }
  for (const k of OPT_STR_PATCH_FIELDS) {
    if (k in body && body[k] != null && typeof body[k] !== "string") {
      return `${k} must be a string or null`;
    }
  }
  return null;
}
