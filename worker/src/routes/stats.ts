import { Hono } from "hono";
import {
  computeCloseCalls,
  computeDayUpdates,
  computeStats,
  computeVersus,
  jstDateString,
  jstDayStartMs,
  songCategory,
} from "../lib";
import { chunkArray, type Env } from "../db";

export const statsRoutes = new Hono<{ Bindings: Env }>();

// ---- GET /api/summary/latest-day ----
statsRoutes.get("/api/summary/latest-day", async (c) => {
  const latest = await c.env.DB
    .prepare("SELECT MAX(played_at) AS m FROM scores")
    .first<{ m: number | null }>();
  if (!latest?.m) return c.json({ date: null, total_plays: 0, unique_charts: 0, updates: [] });
  const date = jstDateString(latest.m);
  const start = jstDayStartMs(date);
  const end = start + 86400000;
  const { results: dayRows } = await c.env.DB
    .prepare(
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist, charts.max_ex AS chart_max_ex
       FROM scores s LEFT JOIN songs ON songs.song_id = s.song_id
       LEFT JOIN charts ON charts.chart_id = s.chart_id
       WHERE s.played_at >= ? AND s.played_at < ? ORDER BY s.played_at ASC`,
    )
    .bind(start, end)
    .all<Record<string, unknown> & { id: string; chart_id: string | null; score: number; played_at: number }>();
  const chartIds = [...new Set(dayRows.map((r) => r.chart_id).filter((x): x is string => !!x))];
  const prevBest = new Map<string, number>();
  for (const chunk of chunkArray(chartIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const { results: prevRows } = await c.env.DB
      .prepare(
        `SELECT chart_id, MAX(score) AS best FROM scores
         WHERE chart_id IN (${placeholders}) AND played_at < ? GROUP BY chart_id`,
      )
      .bind(...chunk, start)
      .all<{ chart_id: string; best: number }>();
    for (const r of prevRows) prevBest.set(r.chart_id, r.best);
  }
  const updates = computeDayUpdates(dayRows, prevBest)
    .map((u) => ({
      ...u.row,
      prev_best: u.prev_best,
      diff: u.diff,
      is_new: u.is_new,
    }))
    .sort((a, b) => (b.played_at as number) - (a.played_at as number));
  return c.json({
    date,
    total_plays: dayRows.length,
    unique_charts: chartIds.length,
    updates,
  });
});

// ---- GET /api/stats ----
statsRoutes.get("/api/stats", async (c) => {
  const { results: masterRows } = await c.env.DB
    .prepare(
      `SELECT ch.chart_id AS chart_id, ch.play_style AS play_style, ch.level AS level,
              ch.max_ex AS max_ex, s.version AS version, s.title AS title
       FROM charts ch JOIN songs s ON s.song_id = ch.song_id`,
    )
    .all<{ chart_id: string; play_style: string; level: number | null; max_ex: number | null; version: string | null; title: string | null }>();
  const { results: playRows } = await c.env.DB
    .prepare("SELECT chart_id, score, ex_score, rank, clear_lamp, flare_rank, played_at, marvelous, perfect, great, good, ok, miss FROM scores")
    .all<{ chart_id: string | null; score: number; ex_score: number | null; rank: string | null; clear_lamp: string | null; played_at: number; marvelous: number | null; perfect: number | null; great: number | null; good: number | null; ok: number | null; miss: number | null }>();
  const master = masterRows.map((r) => ({
    chart_id: r.chart_id,
    play_style: r.play_style,
    level: r.level,
    max_ex: r.max_ex,
    category: songCategory(r.version),
    title: r.title,
  }));
  return c.json(computeStats(master, playRows, Date.now()));
});

// ---- GET /api/versus ----
statsRoutes.get("/api/versus", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.id AS id, COALESCE(songs.title, s.raw_title) AS song_title, s.raw_extraction AS raw_extraction, s.played_at AS played_at
       FROM scores s LEFT JOIN songs ON songs.song_id = s.song_id
       WHERE s.raw_extraction IS NOT NULL ORDER BY s.played_at DESC`,
    )
    .all<{ id: string; song_title: string | null; raw_extraction: string | null; played_at: number }>();
  return c.json(computeVersus(results, c.env.MY_DANCER_NAME));
});

// ---- GET /api/close-calls ----
statsRoutes.get("/api/close-calls", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist, charts.max_ex AS chart_max_ex
       FROM scores s
       JOIN charts ON charts.chart_id = s.chart_id
       JOIN songs ON songs.song_id = s.song_id
       WHERE s.chart_id IS NOT NULL
         AND s.score = (SELECT MAX(score) FROM scores b WHERE b.chart_id = s.chart_id)
       ORDER BY s.played_at DESC`,
    )
    .all<Record<string, unknown> & {
      chart_id: string; score: number; rank: string | null; clear_lamp: string | null;
      marvelous: number | null; perfect: number | null; great: number | null;
      good: number | null; miss: number | null; song_title: string | null;
      artist: string | null; play_style: string; difficulty: string; level: number | null;
    }>();
  const seen = new Set<string>();
  const best: typeof results = [];
  for (const r of results) {
    if (seen.has(r.chart_id)) continue;
    seen.add(r.chart_id);
    best.push(r);
  }
  const byId = new Map(best.map((r) => [r.chart_id, r]));
  const items = computeCloseCalls(best).map((cc) => {
    const r = byId.get(cc.chart_id)!;
    return {
      ...cc,
      song_title: r.song_title,
      artist: r.artist,
      play_style: r.play_style,
      difficulty: r.difficulty,
      level: r.level,
    };
  });
  return c.json({ items });
});
