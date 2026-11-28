import { Hono } from "hono";
import {
  DEFAULT_MASTER_URL,
  getChart,
  recheckChartScores,
  recheckLinkedNeedsReviewScores,
  relinkUnlinkedScores,
  syncMaster,
  type Env,
} from "../db";

export const adminRoutes = new Hono<{ Bindings: Env }>();

// ---- POST /api/admin/relink ----
adminRoutes.post("/api/admin/relink", async (c) => {
  const relink = await relinkUnlinkedScores(c.env);
  const recheck = await recheckLinkedNeedsReviewScores(c.env);
  return c.json({ ...relink, ...recheck });
});

// ---- GET /api/corrections ----
adminRoutes.get("/api/corrections", async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT cc.chart_id, cc.notes, cc.freeze, cc.shock, cc.reason, cc.created_at, cc.updated_at,
                ch.play_style, ch.difficulty, ch.level, s.title AS song_title
         FROM chart_corrections cc
         LEFT JOIN charts ch ON ch.chart_id = cc.chart_id
         LEFT JOIN songs s ON s.song_id = ch.song_id
         ORDER BY cc.updated_at DESC`,
      )
      .all();
    return c.json({ corrections: results });
  } catch {
    return c.json({ corrections: [] });
  }
});

// ---- PUT /api/charts/:chart_id/correction ----
adminRoutes.put("/api/charts/:chart_id/correction", async (c) => {
  const chartId = c.req.param("chart_id");
  const chart = await getChart(c.env.DB, chartId);
  if (!chart) return c.json({ error: "chart not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const FIELDS = ["notes", "freeze", "shock"] as const;
  type CountField = (typeof FIELDS)[number];
  const updates = new Map<CountField, number | null>();
  for (const f of FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    if (v === null) updates.set(f, null);
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0) updates.set(f, v);
    else return c.json({ error: `${f} must be a non-negative integer or null` }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  if (updates.size === 0 && reason === undefined) {
    return c.json({ error: "nothing to update" }, 400);
  }
  let existing: { notes: number | null; freeze: number | null; shock: number | null; reason: string | null } | null = null;
  try {
    existing = await c.env.DB
      .prepare("SELECT notes, freeze, shock, reason FROM chart_corrections WHERE chart_id = ?")
      .bind(chartId)
      .first();
  } catch {
    return c.json({ error: "chart_corrections table is missing — apply migration 0010 first" }, 500);
  }
  const merged: Record<CountField, number | null> = {
    notes: updates.has("notes") ? updates.get("notes")! : existing?.notes ?? null,
    freeze: updates.has("freeze") ? updates.get("freeze")! : existing?.freeze ?? null,
    shock: updates.has("shock") ? updates.get("shock")! : existing?.shock ?? null,
  };
  const mergedReason = reason !== undefined ? reason : existing?.reason ?? null;
  const now = Date.now();
  const empty = merged.notes == null && merged.freeze == null && merged.shock == null;
  if (empty) {
    await c.env.DB.prepare("DELETE FROM chart_corrections WHERE chart_id = ?").bind(chartId).run();
  } else {
    await c.env.DB
      .prepare(
        `INSERT INTO chart_corrections (chart_id, notes, freeze, shock, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chart_id) DO UPDATE SET notes = excluded.notes, freeze = excluded.freeze,
           shock = excluded.shock, reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .bind(chartId, merged.notes, merged.freeze, merged.shock, mergedReason, now, now)
      .run();
  }
  let synced = true;
  try {
    await syncMaster(c.env.DB, c.env.MASTER_URL || DEFAULT_MASTER_URL);
  } catch {
    synced = false;
    const notes = merged.notes ?? chart.notes;
    const freeze = merged.freeze ?? chart.freeze;
    const shock = merged.shock ?? chart.shock;
    const maxEx = notes != null && freeze != null ? (notes + freeze + (shock ?? 0)) * 3 : chart.max_ex;
    await c.env.DB
      .prepare("UPDATE charts SET notes = ?, freeze = ?, shock = ?, max_ex = ? WHERE chart_id = ?")
      .bind(notes, freeze, shock, maxEx, chartId)
      .run();
  }
  const resolved = await recheckChartScores(c.env, chartId);
  return c.json({
    chart_id: chartId,
    correction: empty ? null : { ...merged, reason: mergedReason },
    synced,
    resolved,
  });
});

// ---- DELETE /api/charts/:chart_id/correction ----
adminRoutes.delete("/api/charts/:chart_id/correction", async (c) => {
  const chartId = c.req.param("chart_id");
  const chart = await getChart(c.env.DB, chartId);
  if (!chart) return c.json({ error: "chart not found" }, 404);
  try {
    await c.env.DB.prepare("DELETE FROM chart_corrections WHERE chart_id = ?").bind(chartId).run();
  } catch {
    return c.json({ error: "chart_corrections table is missing — apply migration 0010 first" }, 500);
  }
  let synced = true;
  try {
    await syncMaster(c.env.DB, c.env.MASTER_URL || DEFAULT_MASTER_URL);
  } catch {
    synced = false;
  }
  const resolved = await recheckChartScores(c.env, chartId);
  return c.json({ chart_id: chartId, correction: null, synced, resolved });
});

// ---- POST /api/admin/sync ----
adminRoutes.post("/api/admin/sync", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  const url = body.url || c.env.MASTER_URL || DEFAULT_MASTER_URL;
  try {
    const res = await syncMaster(c.env.DB, url);
    const hasWrites = res.songWrites > 0 || res.chartWrites > 0;
    const relink = hasWrites
      ? await relinkUnlinkedScores(c.env)
      : { checked: 0, linked: 0, remaining: 0 };
    const recheck = hasWrites
      ? await recheckLinkedNeedsReviewScores(c.env)
      : { rechecked: 0, resolved: 0 };
    return c.json({ ...res, relink, recheck });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
