import { Hono } from "hono";
import { LAMP_RANK } from "../lib";
import { chunkArray, getChart, type Env } from "../db";

export const targetsRoutes = new Hono<{ Bindings: Env }>();

const TARGET_LAMPS = ["CLEAR", "LIFE4", "FC", "GFC", "PFC", "MFC"] as const;

async function getTargetWithChart(
  db: D1Database,
  chartId: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      `SELECT t.chart_id, t.target_score, t.target_lamp, t.updated_at,
              c.play_style, c.difficulty, c.level, s.title AS song_title, s.artist AS artist,
              (SELECT MAX(score) FROM scores WHERE chart_id = t.chart_id) AS best_score
       FROM targets t
       JOIN charts c ON c.chart_id = t.chart_id
       JOIN songs s ON s.song_id = c.song_id
       WHERE t.chart_id = ?`,
    )
    .bind(chartId)
    .first<Record<string, unknown>>();
  return row ?? null;
}

async function fetchBestLamps(db: D1Database, chartIds: string[]): Promise<Map<string, string>> {
  const best = new Map<string, string>();
  for (const chunk of chunkArray(chartIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT chart_id, clear_lamp FROM scores
         WHERE chart_id IN (${placeholders}) AND clear_lamp IS NOT NULL`,
      )
      .bind(...chunk)
      .all<{ chart_id: string; clear_lamp: string }>();
    for (const r of results) {
      const cur = best.get(r.chart_id);
      if (!cur || (LAMP_RANK[r.clear_lamp] ?? -1) > (LAMP_RANK[cur] ?? -1)) {
        best.set(r.chart_id, r.clear_lamp);
      }
    }
  }
  return best;
}

targetsRoutes.get("/api/targets", async (c) => {
  const chartId = c.req.query("chart_id");
  if (chartId) {
    const target = await getTargetWithChart(c.env.DB, chartId);
    if (target) {
      const lamps = await fetchBestLamps(c.env.DB, [chartId]);
      target.best_lamp = lamps.get(chartId) ?? null;
    }
    return c.json({ target });
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT t.chart_id, t.target_score, t.target_lamp, t.updated_at,
              c.play_style, c.difficulty, c.level, s.title AS song_title, s.artist AS artist,
              (SELECT MAX(score) FROM scores WHERE chart_id = t.chart_id) AS best_score
       FROM targets t
       JOIN charts c ON c.chart_id = t.chart_id
       JOIN songs s ON s.song_id = c.song_id
       ORDER BY s.title, c.play_style, c.level`,
    )
    .all<Record<string, unknown> & { chart_id: string }>();
  const lamps = await fetchBestLamps(c.env.DB, results.map((r) => r.chart_id));
  for (const r of results) r.best_lamp = lamps.get(r.chart_id) ?? null;
  return c.json({ items: results });
});

targetsRoutes.post("/api/targets", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    chart_id?: unknown;
    target_score?: unknown;
    target_lamp?: unknown;
  };
  if (typeof body.chart_id !== "string" || !body.chart_id) {
    return c.json({ error: "chart_id is required" }, 400);
  }
  const hasScore = body.target_score !== undefined && body.target_score !== null;
  const hasLamp = body.target_lamp !== undefined && body.target_lamp !== null;
  if (!hasScore && !hasLamp) {
    return c.json({ error: "target_score or target_lamp is required" }, 400);
  }
  if (hasScore && (typeof body.target_score !== "number" || !Number.isInteger(body.target_score) ||
      (body.target_score as number) < 0 || (body.target_score as number) > 1000000)) {
    return c.json({ error: "target_score must be an integer 0..1000000" }, 400);
  }
  if (hasLamp && (typeof body.target_lamp !== "string" ||
      !(TARGET_LAMPS as readonly string[]).includes(body.target_lamp as string))) {
    return c.json({ error: `target_lamp must be one of ${TARGET_LAMPS.join(", ")}` }, 400);
  }
  const chart = await getChart(c.env.DB, body.chart_id);
  if (!chart) return c.json({ error: "chart not found" }, 404);
  await c.env.DB
    .prepare(
      `INSERT INTO targets (chart_id, target_score, target_lamp, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chart_id) DO UPDATE SET
         target_score = excluded.target_score,
         target_lamp = excluded.target_lamp,
         updated_at = excluded.updated_at`,
    )
    .bind(
      body.chart_id,
      hasScore ? body.target_score : null,
      hasLamp ? body.target_lamp : null,
      Date.now(),
    )
    .run();
  const target = await getTargetWithChart(c.env.DB, body.chart_id);
  if (target) {
    const lamps = await fetchBestLamps(c.env.DB, [body.chart_id]);
    target.best_lamp = lamps.get(body.chart_id) ?? null;
  }
  return c.json({ target });
});

targetsRoutes.delete("/api/targets/:chart_id", async (c) => {
  const chartId = c.req.param("chart_id");
  const existing = await getTargetWithChart(c.env.DB, chartId);
  if (!existing) return c.json({ error: "target not found" }, 404);
  await c.env.DB.prepare("DELETE FROM targets WHERE chart_id = ?").bind(chartId).run();
  return c.json({ deleted: true });
});
