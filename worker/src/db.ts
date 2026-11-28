import {
  applyCorrections,
  bestTitleMatch,
  chartId as makeChartId,
  choosePlayer,
  correctOkValue,
  evaluateScore,
  expandMaster,
  findRedundantCorrections,
  judgeSumDeficitToLearn,
  normalizeTitle,
  planSync,
  prepareTitleIndex,
  rankTitleCandidatesIndexed,
  computeReviewReasons,
  type ChartCorrection,
  type ChartRow,
  type Extraction,
  type PlayerExtraction,
  type SongRow,
} from "./lib";

export interface Env {
  DB: D1Database;
  /** Jacket images (Workers KV). Optional: unset until the namespace is bound. */
  JACKETS?: KVNamespace;
  API_TOKEN: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_MODELS?: string;
  MASTER_URL?: string;
  MY_DANCER_NAME?: string;
}

export const DEFAULT_MASTER_URL = "https://4tuna-427.github.io/ddr-song-data/songs.json";
export const D1_IN_CHUNK = 90;
export const REVIEW_IMG_PREFIX = "review_img:";
export const REVIEW_IMG_TTL_SEC = 30 * 86400;

export function genId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}${rand}`;
}

export function chunkArray<T>(arr: T[], size = D1_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function saveReviewImage(
  env: Env,
  scoreId: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<boolean> {
  if (!env.JACKETS) return false;
  await env.JACKETS.put(`${REVIEW_IMG_PREFIX}${scoreId}`, bytes, {
    expirationTtl: REVIEW_IMG_TTL_SEC,
    metadata: { content_type: contentType || "image/webp" },
  });
  return true;
}

export async function deleteReviewImage(env: Env, scoreId: string): Promise<void> {
  if (!env.JACKETS) return;
  await env.JACKETS.delete(`${REVIEW_IMG_PREFIX}${scoreId}`).catch(() => {});
}

export interface ChartDbRow {
  chart_id: string;
  song_id: string;
  play_style: string;
  difficulty: string;
  level: number | null;
  notes: number | null;
  freeze: number | null;
  shock: number | null;
  max_ex: number | null;
  /** Learned simultaneous-freeze deficit P (migration 0009); null = not learned yet. */
  judge_sum_deficit?: number | null;
}

export interface ScoreFields {
  chart_id: string | null;
  song_id: string | null;
  raw_title: string | null;
  play_style: string;
  difficulty: string;
  level: number | null;
  score: number;
  ex_score: number | null;
  rank: string | null;
  clear_lamp: string | null;
  flare_rank: string | null;
  marvelous: number | null;
  perfect: number | null;
  great: number | null;
  good: number | null;
  ok: number | null;
  miss: number | null;
  fast_count: number | null;
  slow_count: number | null;
  max_combo: number | null;
  ex_check: string;
  judge_sum_check: string;
  needs_review: number;
}

export const SCORE_COLUMNS = [
  "chart_id", "song_id", "raw_title", "play_style", "difficulty", "level",
  "score", "ex_score", "rank", "clear_lamp", "flare_rank",
  "marvelous", "perfect", "great", "good", "ok", "miss",
  "fast_count", "slow_count", "max_combo",
  "ex_check", "judge_sum_check", "needs_review",
] as const;

export function fieldsToValues(f: ScoreFields): unknown[] {
  return SCORE_COLUMNS.map((col) => f[col]);
}

export async function findChartByTitle(
  db: D1Database,
  rawTitle: string | null,
  playStyle: string,
  difficulty: string,
): Promise<{ song: SongRow | null; chart: ChartDbRow | null }> {
  const norm = normalizeTitle(rawTitle);
  if (!norm) return { song: null, chart: null };
  const { results } = await db
    .prepare("SELECT * FROM songs WHERE title_normalized = ?")
    .bind(norm)
    .all<SongRow>();
  let song: SongRow | null = null;
  if (results.length === 1) {
    song = results[0];
  } else if (results.length === 0) {
    const { results: allSongs } = await db
      .prepare("SELECT song_id, title, title_normalized FROM songs")
      .all<{ song_id: string; title: string; title_normalized: string }>();
    const match = bestTitleMatch(rawTitle, allSongs);
    if (match) {
      song = await db
        .prepare("SELECT * FROM songs WHERE song_id = ?")
        .bind(match.song_id)
        .first<SongRow>();
    }
  }
  if (!song) return { song: null, chart: null };
  const chart = await db
    .prepare("SELECT * FROM charts WHERE chart_id = ?")
    .bind(makeChartId(song.song_id, playStyle, difficulty))
    .first<ChartDbRow>();
  return { song, chart: chart ?? null };
}

export async function attachCandidates<T extends Record<string, any>>(db: D1Database, rows: T[]): Promise<T[]> {
  const unlinked = rows.filter((r) => !r.chart_id && r.raw_title);
  if (unlinked.length === 0) return rows;
  const { results: allSongs } = await db
    .prepare("SELECT song_id, title, title_normalized, artist FROM songs")
    .all<{ song_id: string; title: string; title_normalized: string; artist: string | null }>();
  const artistById = new Map(allSongs.map((s) => [s.song_id, s.artist]));
  const titleIndex = prepareTitleIndex(allSongs);
  const byTitle = new Map<string, ReturnType<typeof rankTitleCandidatesIndexed>>();
  const MAX_CANDIDATE_TITLES = 20;
  const deadline = Date.now() + 40;
  for (const r of unlinked) {
    if (byTitle.has(r.raw_title)) continue;
    if (byTitle.size >= MAX_CANDIDATE_TITLES) break;
    if (byTitle.size > 0 && Date.now() > deadline) break;
    byTitle.set(r.raw_title, rankTitleCandidatesIndexed(r.raw_title, titleIndex, 3));
  }
  const songIds = [...new Set([...byTitle.values()].flat().map((cand) => cand.song_id))];
  const chartByKey = new Map<string, string>();
  for (const chunk of chunkArray(songIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const { results: charts } = await db
      .prepare(`SELECT chart_id, song_id, play_style, difficulty FROM charts WHERE song_id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ chart_id: string; song_id: string; play_style: string; difficulty: string }>();
    for (const ch of charts) chartByKey.set(`${ch.song_id}|${ch.play_style}|${ch.difficulty}`, ch.chart_id);
  }
  for (const r of unlinked) {
    const cands = (byTitle.get(r.raw_title) ?? [])
      .map((cand) => {
        const chart_id = chartByKey.get(`${cand.song_id}|${r.play_style}|${r.difficulty}`);
        return chart_id
          ? { chart_id, song_id: cand.song_id, title: cand.title, artist: artistById.get(cand.song_id) ?? null, score: cand.score }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    (r as Record<string, unknown>).candidates = cands;
  }
  return rows;
}

export function isPlayerUnresolved(row: Record<string, any>, myDancerName?: string): boolean {
  if (!row.raw_extraction) return false;
  try {
    const ext = JSON.parse(String(row.raw_extraction)) as Extraction & { _selected_player?: number };
    if (ext._selected_player) return false;
    const chosen = choosePlayer(ext, myDancerName);
    return !!chosen?.unresolved;
  } catch {
    return false;
  }
}

export async function fetchChartsBySongIds(
  db: D1Database,
  songIds: string[],
): Promise<Map<string, { chart_id: string; play_style: string; difficulty: string; level: number | null }[]>> {
  const bySong = new Map<string, { chart_id: string; play_style: string; difficulty: string; level: number | null }[]>();
  const uniqueIds = [...new Set(songIds)];
  for (const chunk of chunkArray(uniqueIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT chart_id, song_id, play_style, difficulty, level FROM charts WHERE song_id IN (${placeholders}) ORDER BY play_style, difficulty`)
      .bind(...chunk)
      .all<{ chart_id: string; song_id: string; play_style: string; difficulty: string; level: number | null }>();
    for (const ch of results) {
      const list = bySong.get(ch.song_id) ?? [];
      list.push({ chart_id: ch.chart_id, play_style: ch.play_style, difficulty: ch.difficulty, level: ch.level });
      bySong.set(ch.song_id, list);
    }
  }
  return bySong;
}

export async function attachReviewDetails<T extends Record<string, any>>(
  db: D1Database,
  rows: T[],
  myDancerName?: string,
): Promise<T[]> {
  await attachCandidates(db, rows);

  const songOnlyIds = rows.filter((r) => r.song_id && !r.chart_id).map((r) => String(r.song_id));
  const chartsBySong = await fetchChartsBySongIds(db, songOnlyIds);

  for (const r of rows) {
    if (r.song_id && !r.chart_id) {
      (r as Record<string, unknown>).song_charts = chartsBySong.get(String(r.song_id)) ?? [];
    }
    const chartLike = r.chart_id
      ? {
          notes: r.chart_notes ?? null,
          freeze: r.chart_freeze ?? null,
          shock: r.chart_shock ?? null,
          level: r.chart_level ?? null,
          max_ex: r.chart_max_ex ?? null,
          judge_sum_deficit: r.chart_judge_sum_deficit ?? null,
        }
      : null;
    const playerUnresolved = r.needs_review === 1 ? isPlayerUnresolved(r, myDancerName) : false;
    (r as Record<string, unknown>).review_reasons = computeReviewReasons(r as any, chartLike, {
      songLinked: !!r.song_id,
      chartLinked: !!r.chart_id,
      playerUnresolved,
    });
  }
  return rows;
}

export function buildFields(
  ext: Extraction,
  player: PlayerExtraction,
  song: SongRow | null,
  chart: ChartDbRow | null,
  playerUnresolved: boolean,
): ScoreFields {
  const playStyle = ext.play_style ?? "SP";
  const okFix = correctOkValue(player, chart);
  const effective = okFix.corrected ? { ...player, ok: okFix.ok } : player;
  const ev = evaluateScore(effective, chart, {
    songLinked: !!song,
    chartLinked: !!chart,
    playerUnresolved,
  });
  return {
    chart_id: chart ? chart.chart_id : null,
    song_id: song ? song.song_id : chart ? chart.song_id : null,
    raw_title: ext.song_title,
    play_style: playStyle,
    difficulty: player.difficulty ?? "UNKNOWN",
    level: player.level,
    score: player.score ?? 0,
    ex_score: player.ex_score,
    rank: player.rank,
    clear_lamp: player.clear_lamp,
    flare_rank: player.flare_rank,
    marvelous: player.marvelous,
    perfect: player.perfect,
    great: player.great,
    good: player.good,
    ok: effective.ok,
    miss: player.miss,
    fast_count: player.fast_count,
    slow_count: player.slow_count,
    max_combo: player.max_combo,
    ex_check: ev.ex_check,
    judge_sum_check: ev.judge_sum_check,
    needs_review: ev.needs_review ? 1 : 0,
  };
}

export async function getScore(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist,
              charts.level AS chart_level, charts.notes AS chart_notes,
              charts.freeze AS chart_freeze, charts.shock AS chart_shock,
              charts.max_ex AS chart_max_ex,
              charts.judge_sum_deficit AS chart_judge_sum_deficit
       FROM scores s
       LEFT JOIN songs ON songs.song_id = s.song_id
       LEFT JOIN charts ON charts.chart_id = s.chart_id
       WHERE s.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  return row ?? null;
}

export async function getChart(db: D1Database, id: string): Promise<ChartDbRow | null> {
  const row = await db.prepare("SELECT * FROM charts WHERE chart_id = ?").bind(id).first<ChartDbRow>();
  return row ?? null;
}

export function recomputeChecks(
  row: Record<string, any>,
  chart: ChartDbRow | null,
  opts?: { playerUnresolved?: boolean },
): { ex_check: string; judge_sum_check: string; needs_review: number } {
  const ev = evaluateScore(row as any, chart, {
    songLinked: !!row.song_id,
    chartLinked: !!chart,
    playerUnresolved: opts?.playerUnresolved,
  });
  return { ex_check: ev.ex_check, judge_sum_check: ev.judge_sum_check, needs_review: ev.needs_review ? 1 : 0 };
}

export async function applyChartLinkToScore(
  env: Env,
  row: Record<string, any>,
  chart: ChartDbRow,
  levelOverride?: number | null,
): Promise<void> {
  const level = levelOverride !== undefined ? levelOverride : chart.level;
  const merged: Record<string, any> = {
    ...row,
    chart_id: chart.chart_id,
    song_id: chart.song_id,
    play_style: chart.play_style,
    difficulty: chart.difficulty,
    level,
  };
  const playerUnresolved = row.needs_review === 1 ? isPlayerUnresolved(merged, env.MY_DANCER_NAME) : false;
  const checks = recomputeChecks(merged, chart, { playerUnresolved });
  await env.DB
    .prepare(
      `UPDATE scores SET chart_id = ?, song_id = ?, play_style = ?, difficulty = ?, level = ?,
       ex_check = ?, judge_sum_check = ?, needs_review = ?,
       review_status = NULL${checks.needs_review === 0 ? ", has_review_image = 0" : ""} WHERE id = ?`,
    )
    .bind(
      chart.chart_id,
      chart.song_id,
      chart.play_style,
      chart.difficulty,
      level,
      checks.ex_check,
      checks.judge_sum_check,
      checks.needs_review,
      row.id,
    )
    .run();
  if (checks.needs_review === 0) {
    await deleteReviewImage(env, String(row.id));
  }
}

export async function learnJudgeSumDeficit(
  db: D1Database,
  player: PlayerExtraction,
  chart: ChartDbRow,
  opts: { songLinked: boolean; playerUnresolved?: boolean },
): Promise<ChartDbRow | null> {
  const okFix = correctOkValue(player, chart);
  const effective = okFix.corrected ? { ...player, ok: okFix.ok } : player;
  const ev = evaluateScore(effective, chart, {
    songLinked: opts.songLinked,
    chartLinked: true,
    playerUnresolved: opts.playerUnresolved,
  });
  const deficit = judgeSumDeficitToLearn(effective, chart, ev);
  if (deficit == null) return null;
  await db
    .prepare("UPDATE charts SET judge_sum_deficit = ? WHERE chart_id = ? AND judge_sum_deficit IS NULL")
    .bind(deficit, chart.chart_id)
    .run();
  return { ...chart, judge_sum_deficit: deficit };
}

export async function syncMaster(
  db: D1Database,
  url: string,
): Promise<{ songs: number; charts: number; songWrites: number; chartWrites: number; redundantCorrections: string[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`master fetch failed: ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, any>>;
  if (!Array.isArray(raw)) throw new Error("master is not an array");
  const { songs, charts } = expandMaster(raw);
  let effectiveCharts = charts;
  let redundantCorrections: string[] = [];
  try {
    const { results: corrections } = await db
      .prepare("SELECT chart_id, notes, freeze, shock FROM chart_corrections")
      .all<ChartCorrection>();
    if (corrections.length > 0) {
      effectiveCharts = applyCorrections(charts, corrections);
      redundantCorrections = findRedundantCorrections(charts, corrections);
    }
  } catch {
    // chart_corrections not migrated yet
  }
  const now = Date.now();
  const { results: existingSongs } = await db
    .prepare(
      "SELECT song_id, title, title_normalized, artist, version, bpm, phash_8, phash_16, availability, deleted_at, has_jacket FROM songs",
    )
    .all<SongRow>();
  const { results: existingCharts } = await db
    .prepare("SELECT chart_id, song_id, play_style, difficulty, level, notes, freeze, shock, max_ex, judge_sum_deficit FROM charts")
    .all<ChartRow>();
  const { songUpserts, chartUpserts } = planSync(existingSongs, existingCharts, songs, effectiveCharts);

  const songStmt = db.prepare(
    `INSERT INTO songs (song_id, title, title_normalized, artist, version, bpm, phash_8, phash_16, availability, deleted_at, has_jacket, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET
       title = excluded.title, title_normalized = excluded.title_normalized,
       artist = excluded.artist, version = excluded.version, bpm = excluded.bpm,
       phash_8 = COALESCE(excluded.phash_8, songs.phash_8),
       phash_16 = COALESCE(excluded.phash_16, songs.phash_16),
       availability = excluded.availability, deleted_at = excluded.deleted_at,
       has_jacket = COALESCE(excluded.has_jacket, songs.has_jacket),
       updated_at = excluded.updated_at`,
  );
  const chartStmt = db.prepare(
    `INSERT INTO charts (chart_id, song_id, play_style, difficulty, level, notes, freeze, shock, max_ex)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chart_id) DO UPDATE SET
       level = excluded.level,
       notes = COALESCE(excluded.notes, charts.notes),
       freeze = COALESCE(excluded.freeze, charts.freeze),
       shock = COALESCE(excluded.shock, charts.shock),
       max_ex = COALESCE(excluded.max_ex, charts.max_ex)`,
  );

  const stmts: D1PreparedStatement[] = [];
  for (const s of songUpserts) {
    stmts.push(songStmt.bind(s.song_id, s.title, s.title_normalized, s.artist, s.version, s.bpm,
      s.phash_8, s.phash_16, s.availability, s.deleted_at, s.has_jacket, now));
  }
  for (const ch of chartUpserts) {
    stmts.push(chartStmt.bind(ch.chart_id, ch.song_id, ch.play_style, ch.difficulty, ch.level,
      ch.notes, ch.freeze, ch.shock, ch.max_ex));
  }
  const BATCH = 100;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await db.batch(stmts.slice(i, i + BATCH));
  }
  return { songs: songs.length, charts: effectiveCharts.length, songWrites: songUpserts.length, chartWrites: chartUpserts.length, redundantCorrections };
}

export async function relinkUnlinkedScores(
  env: Env,
): Promise<{ checked: number; linked: number; remaining: number }> {
  const { results: rows } = await env.DB
    .prepare("SELECT * FROM scores WHERE chart_id IS NULL")
    .all<Record<string, any>>();
  let linked = 0;
  for (const row of rows) {
    const { song, chart } = await findChartByTitle(
      env.DB, row.raw_title, row.play_style, row.difficulty,
    );
    if (!song || !chart) continue;
    await applyChartLinkToScore(env, row, chart);
    linked += 1;
  }
  return { checked: rows.length, linked, remaining: rows.length - linked };
}

export async function recheckScoreRow(
  env: Env,
  row: Record<string, any>,
  chart: ChartDbRow,
  opts: { learnDeficit: boolean },
): Promise<boolean> {
  const playerUnresolved = isPlayerUnresolved(row, env.MY_DANCER_NAME);
  let effectiveChart = chart;
  if (opts.learnDeficit) {
    const learned = await learnJudgeSumDeficit(env.DB, row as any, chart, {
      songLinked: !!row.song_id,
      playerUnresolved,
    });
    if (learned) effectiveChart = learned;
  }
  const checks = recomputeChecks(row, effectiveChart, { playerUnresolved });
  if (checks.needs_review === 0) {
    await env.DB
      .prepare(
        `UPDATE scores SET ex_check = ?, judge_sum_check = ?, needs_review = 0,
         review_status = NULL, has_review_image = 0 WHERE id = ?`,
      )
      .bind(checks.ex_check, checks.judge_sum_check, row.id)
      .run();
    await deleteReviewImage(env, String(row.id));
    return true;
  }
  if (checks.ex_check !== row.ex_check || checks.judge_sum_check !== row.judge_sum_check) {
    await env.DB
      .prepare("UPDATE scores SET ex_check = ?, judge_sum_check = ? WHERE id = ?")
      .bind(checks.ex_check, checks.judge_sum_check, row.id)
      .run();
  }
  return false;
}

export async function recheckLinkedNeedsReviewScores(
  env: Env,
): Promise<{ rechecked: number; resolved: number }> {
  const { results: rows } = await env.DB
    .prepare("SELECT * FROM scores WHERE chart_id IS NOT NULL AND needs_review = 1")
    .all<Record<string, any>>();
  let resolved = 0;
  for (const row of rows) {
    const chart = await getChart(env.DB, String(row.chart_id));
    if (!chart) continue;
    if (await recheckScoreRow(env, row, chart, { learnDeficit: true })) {
      resolved += 1;
    }
  }
  return { rechecked: rows.length, resolved };
}

export async function recheckChartScores(env: Env, chartId: string): Promise<number> {
  const chart = await getChart(env.DB, chartId);
  if (!chart) return 0;
  const { results: rows } = await env.DB
    .prepare("SELECT * FROM scores WHERE chart_id = ? AND needs_review = 1")
    .bind(chartId)
    .all<Record<string, any>>();
  let resolved = 0;
  for (const row of rows) {
    if (await recheckScoreRow(env, row, chart, { learnDeficit: false })) {
      resolved += 1;
    }
  }
  return resolved;
}
