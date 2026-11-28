import {
  FLARE_ORDER,
  FLARE_TARGETS,
  LAMP_RANK,
  RANK_ORDER,
  type Extraction,
  type PlayerExtraction,
  type SongCategory,
} from "./types";

/** Validate a client-supplied capture time (ISO string from EXIF etc.). */
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

/** From one day's scores and previous bests, compute which charts got a PB update. */
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

// ---- close calls ("あと少し" list) ----

export const AAA_SCORE = 990000;
export const CLOSE_CALL_SCORE_GAP = 10000;
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
  gap: number;
  next_lamp?: string;
  score: number;
  rank: string | null;
  clear_lamp: string | null;
}

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

// ---- statistics aggregation ----

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
  ex_rate_by_level: { play_style: string; level: number; avg_ex_rate: number | null; charts: number }[];
  calendar: { date: string; plays: number }[];
  flare: {
    by_rank: { flare_rank: string; charts: number }[];
    charts_with_flare: number;
    targets: {
      level: number;
      min_rank: string;
      achieved: { chart_id: string; title: string | null; play_style: string; flare_rank: string }[];
      achieved_count: number;
      candidates: { chart_id: string; title: string | null; play_style: string; best_flare_rank: string | null }[];
      candidate_count: number;
    }[];
  };
  graphs: {
    level_monthly: { month: string; level: number; plays: number }[];
    judge_daily: {
      date: string; plays: number;
      marvelous: number; perfect: number; great: number; good: number; ok: number; miss: number;
    }[];
    coverage: {
      play_style: string; level: number; difficulty: string;
      total: number; played: number; cleared: number;
    }[];
  };
}

const emptyBucket = (): AchievementBucket => ({
  total_charts: 0, played: 0, clear: 0, fc: 0, gfc: 0, pfc: 0, mfc: 0,
});

export function computeStats(
  masterCharts: StatMasterChart[],
  plays: StatPlay[],
  nowMs: number,
): StatsResult {
  const sorted = [...plays].sort((a, b) => a.played_at - b.played_at);

  const months: StatsResult["monthly"] = [];
  const monthIdx = new Map<string, number>();
  const monthExSum: number[] = [];
  const monthExCount: number[] = [];
  {
    const now = new Date(nowMs + 9 * 3600 * 1000);
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth();
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
  const bestFlare = new Map<string, number>();
  const playDays = new Set<string>();
  const playsByDay = new Map<string, number>();
  const chartLevel = new Map<string, number | null>();
  for (const ch of masterCharts) chartLevel.set(ch.chart_id, ch.level);
  const levelMonthCounts = new Map<string, number>();
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

  const endDay = jstDateString(nowMs);
  const startMs = jstDayStartMs(endDay) - 364 * 86400000;
  const calendar = [...playsByDay.entries()]
    .filter(([date]) => {
      const ms = jstDayStartMs(date);
      return ms >= startMs && ms <= jstDayStartMs(endDay);
    })
    .map(([date, plays]) => ({ date, plays }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const flareCounts = new Map<number, number>();
  for (const ch of masterCharts) {
    const f = bestFlare.get(ch.chart_id);
    if (f != null && f > 0) flareCounts.set(f, (flareCounts.get(f) ?? 0) + 1);
  }

  const rankLabel = (v: number): string | null =>
    v <= 0 ? null : Object.keys(FLARE_ORDER).find((k) => FLARE_ORDER[k] === v) ?? null;
  const flareTargets: StatsResult["flare"]["targets"] = FLARE_TARGETS.map((t) => {
    const need = FLARE_ORDER[t.min_rank] ?? 0;
    const achieved: StatsResult["flare"]["targets"][number]["achieved"] = [];
    const candidates: (StatsResult["flare"]["targets"][number]["candidates"][number] & { v: number })[] = [];
    for (const ch of masterCharts) {
      if (ch.level !== t.level) continue;
      const best = bestFlare.get(ch.chart_id);
      if (best == null) continue;
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
      continue;
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
      continue;
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
