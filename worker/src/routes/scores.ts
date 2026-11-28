import { Hono } from "hono";
import {
  choosePlayer,
  evaluateScore,
  impliedMasterNotes,
  isDetailResult,
  parsePlayedAt,
  validateScorePatch,
  type Extraction,
} from "../lib";
import { extractFromImage, GeminiQuotaExhaustedError } from "../gemini";
import {
  applyChartLinkToScore,
  attachReviewDetails,
  buildFields,
  deleteReviewImage,
  fieldsToValues,
  findChartByTitle,
  genId,
  getChart,
  getScore,
  isPlayerUnresolved,
  learnJudgeSumDeficit,
  recheckChartScores,
  recomputeChecks,
  REVIEW_IMG_PREFIX,
  saveReviewImage,
  SCORE_COLUMNS,
  type Env,
} from "../db";

export const scoresRoutes = new Hono<{ Bindings: Env }>();

// ---- POST /api/analyze ----
scoresRoutes.post("/api/analyze", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !file || typeof file === "string") {
    return c.json({ error: "file is required (multipart/form-data)" }, 400);
  }
  const sourceRaw = form.get("source");
  const source = typeof sourceRaw === "string" && ["share", "upload", "manual"].includes(sourceRaw)
    ? sourceRaw
    : "share";

  const imageBytes = await (file as Blob).arrayBuffer();
  const imageHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", imageBytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  try {
    const dup = await c.env.DB
      .prepare("SELECT id FROM scores WHERE image_hash = ?")
      .bind(imageHash)
      .first<{ id: string }>();
    if (dup) return c.json({ error: "duplicate", score_id: dup.id }, 409);
  } catch {
    // image_hash column missing (migration 0002 not applied yet): skip check.
  }

  const bulk = form.get("bulk") === "1";
  let extraction: Extraction;
  try {
    extraction = await extractFromImage(c.env, file, { bulk });
  } catch (e) {
    if (e instanceof GeminiQuotaExhaustedError) {
      return c.json({ error: "quota_exhausted", detail: e.message }, 429);
    }
    return c.json({ error: `gemini extraction failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }

  const chosen = choosePlayer(extraction, c.env.MY_DANCER_NAME);
  if (!chosen) return c.json({ error: "no player found in extraction" }, 422);

  const playStyle = extraction.play_style ?? "SP";
  const difficulty = chosen.player.difficulty ?? "UNKNOWN";
  const { song, chart } = await findChartByTitle(c.env.DB, extraction.song_title, playStyle, difficulty);

  if (!isDetailResult(extraction, chosen.player, chart)) {
    return c.json({ skipped: true, reason: "not_detail_result", song_title: extraction.song_title }, 200);
  }

  let fields = buildFields(extraction, chosen.player, song, chart, chosen.unresolved);
  if (chart && fields.needs_review === 1) {
    const learned = await learnJudgeSumDeficit(c.env.DB, chosen.player, chart, {
      songLinked: !!song,
      playerUnresolved: chosen.unresolved,
    });
    if (learned) fields = buildFields(extraction, chosen.player, song, learned, chosen.unresolved);
  }

  let previous: { score: number; ex_score: number | null; diff: number; played_at: number } | null = null;
  if (fields.chart_id) {
    const prev = await c.env.DB
      .prepare("SELECT score, ex_score, played_at FROM scores WHERE chart_id = ? ORDER BY played_at DESC, created_at DESC LIMIT 1")
      .bind(fields.chart_id)
      .first<{ score: number; ex_score: number | null; played_at: number }>();
    if (prev) {
      previous = {
        score: prev.score,
        ex_score: prev.ex_score,
        diff: fields.score - prev.score,
        played_at: prev.played_at,
      };
    }
  }

  const id = genId();
  const now = Date.now();
  const playedAt = parsePlayedAt(form.get("played_at"), now) ?? now;
  const contentType = (file as File).type || "image/webp";
  const hasReviewImage = fields.needs_review === 1
    ? (await saveReviewImage(c.env, id, imageBytes, contentType) ? 1 : 0)
    : 0;
  const cols = ["id", ...SCORE_COLUMNS, "image_hash", "source", "raw_extraction", "has_review_image", "played_at", "created_at"];
  await c.env.DB
    .prepare(`INSERT INTO scores (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(id, ...fieldsToValues(fields), imageHash, source, JSON.stringify(extraction), hasReviewImage, playedAt, now)
    .run();

  const score = await getScore(c.env.DB, id);
  if (score) await attachReviewDetails(c.env.DB, [score as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score, previous }, 201);
});

// ---- POST /api/import ----
const IMPORT_COLUMNS = [
  "id", "chart_id", "song_id", "raw_title", "play_style", "difficulty", "level",
  "score", "ex_score", "rank", "clear_lamp", "flare_rank",
  "marvelous", "perfect", "great", "good", "ok", "miss",
  "fast_count", "slow_count", "max_combo",
  "ex_check", "judge_sum_check", "needs_review",
  "image_hash", "source", "raw_extraction", "played_at", "created_at",
] as const;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}
function isOptInt(v: unknown): boolean {
  return v == null || isInt(v);
}
function isOptStr(v: unknown): boolean {
  return v == null || typeof v === "string";
}

function validateImportRow(row: unknown): { ok: true; values: unknown[] } | { ok: false; reason: string } {
  if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false, reason: "not an object" };
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return { ok: false, reason: "id is required" };
  if (!isInt(r.score) || (r.score as number) < 0 || (r.score as number) > 1000000) {
    return { ok: false, reason: "score must be an integer 0..1000000" };
  }
  if (!isInt(r.played_at) || (r.played_at as number) <= 0) {
    return { ok: false, reason: "played_at must be a positive integer (epoch ms)" };
  }
  if (r.play_style !== "SP" && r.play_style !== "DP") return { ok: false, reason: "play_style must be SP or DP" };
  if (typeof r.difficulty !== "string" || !r.difficulty) return { ok: false, reason: "difficulty is required" };
  for (const k of ["ex_score", "level", "marvelous", "perfect", "great", "good", "ok", "miss",
    "fast_count", "slow_count", "max_combo"]) {
    if (!isOptInt(r[k])) return { ok: false, reason: `${k} must be an integer or null` };
  }
  for (const k of ["chart_id", "song_id", "raw_title", "rank", "clear_lamp", "flare_rank",
    "ex_check", "judge_sum_check", "image_hash", "source", "raw_extraction"]) {
    if (!isOptStr(r[k])) return { ok: false, reason: `${k} must be a string or null` };
  }
  if (r.needs_review != null && r.needs_review !== 0 && r.needs_review !== 1) {
    return { ok: false, reason: "needs_review must be 0 or 1" };
  }
  const createdAt = isInt(r.created_at) ? r.created_at : Date.now();
  const values = IMPORT_COLUMNS.map((col) => {
    if (col === "created_at") return createdAt;
    if (col === "source") return typeof r.source === "string" && r.source ? r.source : "share";
    if (col === "needs_review") return r.needs_review == null ? 0 : r.needs_review;
    const v = r[col];
    return v === undefined ? null : v;
  });
  return { ok: true, values };
}

scoresRoutes.post("/api/import", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { scores?: unknown } | null;
  if (!body || !Array.isArray(body.scores)) {
    return c.json({ error: "body must be {scores: [...]} (the export JSON format)" }, 400);
  }
  const errors: { index: number; reason: string }[] = [];
  const valid: { id: string; image_hash: string | null; values: unknown[] }[] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  let skipped = 0;
  body.scores.forEach((row, index) => {
    const v = validateImportRow(row);
    if (!v.ok) {
      errors.push({ index, reason: v.reason });
      return;
    }
    const r = row as Record<string, unknown>;
    const id = r.id as string;
    const hash = typeof r.image_hash === "string" && r.image_hash ? r.image_hash : null;
    if (seenIds.has(id) || (hash && seenHashes.has(hash))) {
      skipped += 1;
      return;
    }
    seenIds.add(id);
    if (hash) seenHashes.add(hash);
    valid.push({ id, image_hash: hash, values: v.values });
  });

  const existingIds = new Set<string>();
  const existingHashes = new Set<string>();
  const ids = [...new Set(valid.map((v) => v.id))];
  const hashes = [...new Set(valid.map((v) => v.image_hash).filter((h): h is string => !!h))];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { results } = await c.env.DB
      .prepare(`SELECT id FROM scores WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const r of results) existingIds.add(r.id);
  }
  if (hashes.length > 0) {
    try {
      for (let i = 0; i < hashes.length; i += 100) {
        const chunk = hashes.slice(i, i + 100);
        const { results } = await c.env.DB
          .prepare(`SELECT image_hash FROM scores WHERE image_hash IN (${chunk.map(() => "?").join(", ")})`)
          .bind(...chunk)
          .all<{ image_hash: string }>();
        for (const r of results) existingHashes.add(r.image_hash);
      }
    } catch {
      // image_hash column missing
    }
  }

  const toInsert = valid.filter((v) => {
    if (existingIds.has(v.id)) {
      skipped += 1;
      return false;
    }
    if (v.image_hash && existingHashes.has(v.image_hash)) {
      skipped += 1;
      return false;
    }
    return true;
  });

  let imported = 0;
  const insertErrors: { index: number; reason: string }[] = [];
  if (toInsert.length > 0) {
    const stmt = c.env.DB.prepare(
      `INSERT INTO scores (${IMPORT_COLUMNS.join(", ")}) VALUES (${IMPORT_COLUMNS.map(() => "?").join(", ")})`,
    );
    const BATCH = 100;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH);
      try {
        await c.env.DB.batch(chunk.map((v) => stmt.bind(...v.values)));
        imported += chunk.length;
      } catch (e) {
        for (const v of chunk) {
          insertErrors.push({
            index: body.scores.findIndex((row) => (row as Record<string, unknown>)?.id === v.id),
            reason: `insert failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    }
  }
  return c.json({
    imported,
    skipped,
    errors: [...errors, ...insertErrors].slice(0, 20),
    error_count: errors.length + insertErrors.length,
  });
});

// ---- GET /api/export ----
scoresRoutes.get("/api/export", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist, charts.max_ex AS chart_max_ex
       FROM scores s LEFT JOIN songs ON songs.song_id = s.song_id
       LEFT JOIN charts ON charts.chart_id = s.chart_id
       ORDER BY s.played_at ASC`,
    )
    .all();
  const payload = {
    exported_at: new Date().toISOString(),
    count: results.length,
    scores: results,
  };
  c.header("Content-Type", "application/json");
  c.header("Content-Disposition", 'attachment; filename="ddr-scores-export.json"');
  return c.body(JSON.stringify(payload, null, 2));
});

// ---- GET /api/scores ----
scoresRoutes.get("/api/scores", async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 500);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const nr = c.req.query("needs_review");
  const where = nr === "0" || nr === "1" ? "WHERE s.needs_review = ?" : "";
  const binds: unknown[] = nr === "0" || nr === "1" ? [parseInt(nr, 10)] : [];
  const totalRow = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM scores s ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist,
              charts.level AS chart_level, charts.notes AS chart_notes,
              charts.freeze AS chart_freeze, charts.shock AS chart_shock,
              charts.max_ex AS chart_max_ex,
              charts.judge_sum_deficit AS chart_judge_sum_deficit
       FROM scores s LEFT JOIN songs ON songs.song_id = s.song_id
       LEFT JOIN charts ON charts.chart_id = s.chart_id
       ${where} ORDER BY s.played_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all();
  await attachReviewDetails(c.env.DB, results as Record<string, any>[], c.env.MY_DANCER_NAME);
  return c.json({ items: results, total: totalRow?.n ?? 0 });
});

// ---- GET /api/scores/:id ----
scoresRoutes.get("/api/scores/:id", async (c) => {
  const score = await getScore(c.env.DB, c.req.param("id"));
  if (!score) return c.json({ error: "not found" }, 404);
  await attachReviewDetails(c.env.DB, [score as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score });
});

// ---- GET /api/scores/:id/image ----
scoresRoutes.get("/api/scores/:id/image", async (c) => {
  const kv = c.env.JACKETS;
  if (!kv) return c.json({ error: "review image storage is not configured" }, 404);
  const id = c.req.param("id");
  const got = await kv.getWithMetadata<{ content_type?: string }>(`${REVIEW_IMG_PREFIX}${id}`, "arrayBuffer");
  if (!got.value) return c.json({ error: "review image not found" }, 404);
  return new Response(got.value, {
    headers: {
      "Content-Type": got.metadata?.content_type ?? "image/webp",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// ---- DELETE /api/scores/:id ----
scoresRoutes.delete("/api/scores/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("DELETE FROM scores WHERE id = ?").bind(id).run();
  await deleteReviewImage(c.env, id);
  return c.json({ ok: true });
});

// ---- PATCH /api/scores/:id ----
const PATCHABLE = [
  "score", "ex_score", "marvelous", "perfect", "great", "good", "ok", "miss",
  "rank", "clear_lamp", "flare_rank", "max_combo", "fast_count", "slow_count",
  "difficulty", "level", "review_status",
] as const;

scoresRoutes.patch("/api/scores/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const validationError = validateScorePatch(body);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }
  const merged: Record<string, any> = { ...row };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of PATCHABLE) {
    if (key in body) {
      merged[key] = body[key];
      sets.push(`${key} = ?`);
      values.push(body[key] ?? null);
    }
  }
  if (sets.length === 0) {
    await attachReviewDetails(c.env.DB, [row as Record<string, any>], c.env.MY_DANCER_NAME);
    return c.json({ score: row });
  }
  const chart = merged.chart_id ? await getChart(c.env.DB, String(merged.chart_id)) : null;
  const playerUnresolved = row.needs_review === 1 ? isPlayerUnresolved(merged, c.env.MY_DANCER_NAME) : false;
  const checks = recomputeChecks(merged, chart, { playerUnresolved });
  sets.push("ex_check = ?", "judge_sum_check = ?", "needs_review = ?");
  values.push(checks.ex_check, checks.judge_sum_check, checks.needs_review);
  if (checks.needs_review === 0) {
    if (!("review_status" in body)) {
      sets.push("review_status = NULL");
    } else {
      const idx = sets.indexOf("review_status = ?");
      if (idx !== -1) values[idx] = null;
    }
    sets.push("has_review_image = 0");
  }
  await c.env.DB
    .prepare(`UPDATE scores SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, id)
    .run();
  if (checks.needs_review === 0) {
    await deleteReviewImage(c.env, id);
  }
  const updated = await getScore(c.env.DB, id);
  if (updated) await attachReviewDetails(c.env.DB, [updated as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score: updated });
});

// ---- POST /api/scores/:id/select-player ----
scoresRoutes.post("/api/scores/:id/select-player", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { player?: number };
  if (body.player !== 1 && body.player !== 2) {
    return c.json({ error: "player must be 1 or 2" }, 400);
  }
  if (!row.raw_extraction) return c.json({ error: "no raw_extraction stored" }, 400);
  const extraction = JSON.parse(String(row.raw_extraction)) as Extraction & { _selected_player?: number };
  const player = body.player === 1 ? extraction.player_1 : extraction.player_2;
  if (!player) return c.json({ error: "that player is not in the extraction" }, 400);

  const playStyle = extraction.play_style ?? "SP";
  const difficulty = player.difficulty ?? "UNKNOWN";
  const { song, chart } = await findChartByTitle(c.env.DB, extraction.song_title, playStyle, difficulty);
  const fields = buildFields(extraction, player, song, chart, false);
  const nextRaw = JSON.stringify({ ...extraction, _selected_player: body.player });
  const sets = [
    ...SCORE_COLUMNS.map((col) => `${col} = ?`),
    "raw_extraction = ?",
    ...(fields.needs_review === 0 ? ["review_status = NULL", "has_review_image = 0"] : []),
  ].join(", ");
  await c.env.DB
    .prepare(`UPDATE scores SET ${sets} WHERE id = ?`)
    .bind(...fieldsToValues(fields), nextRaw, id)
    .run();
  if (fields.needs_review === 0) {
    await deleteReviewImage(c.env, id);
  }
  const updated = await getScore(c.env.DB, id);
  if (updated) await attachReviewDetails(c.env.DB, [updated as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score: updated });
});

// ---- POST /api/scores/:id/link ----
scoresRoutes.post("/api/scores/:id/link", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { chart_id?: string };
  if (!body.chart_id) return c.json({ error: "chart_id is required" }, 400);
  const chart = await getChart(c.env.DB, body.chart_id);
  if (!chart) return c.json({ error: "chart not found" }, 404);

  await applyChartLinkToScore(c.env, row, chart);
  const updated = await getScore(c.env.DB, id);
  if (updated) await attachReviewDetails(c.env.DB, [updated as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score: updated });
});

// ---- POST /api/scores/:id/resolve-review ----
scoresRoutes.post("/api/scores/:id/resolve-review", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  if (!row.chart_id) {
    return c.json({ error: "cannot resolve review for unlinked score" }, 400);
  }
  await c.env.DB
    .prepare("UPDATE scores SET needs_review = 0, review_status = NULL, has_review_image = 0 WHERE id = ?")
    .bind(id)
    .run();
  await deleteReviewImage(c.env, id);
  const updated = await getScore(c.env.DB, id);
  if (updated) await attachReviewDetails(c.env.DB, [updated as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score: updated });
});

// ---- POST /api/scores/:id/correct-master-notes ----
scoresRoutes.post("/api/scores/:id/correct-master-notes", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare("SELECT * FROM scores WHERE id = ?")
    .bind(id)
    .first<Record<string, any>>();
  if (!row) return c.json({ error: "score not found" }, 404);
  if (!row.chart_id) return c.json({ error: "score is not linked to a chart" }, 400);
  const chart = await getChart(c.env.DB, String(row.chart_id));
  if (!chart) return c.json({ error: "chart not found" }, 400);
  const playerUnresolved = isPlayerUnresolved(row, c.env.MY_DANCER_NAME);
  const ev = evaluateScore(row as any, chart, {
    songLinked: !!row.song_id,
    chartLinked: true,
    playerUnresolved,
  });
  if (ev.ex_check !== "match") {
    return c.json({ error: "EX cross-check does not match; the read itself is suspect" }, 400);
  }
  if (!ev.reasons.some((r) => r.code === "judge_sum_mismatch")) {
    return c.json({ error: "no judge-sum mismatch on this score" }, 400);
  }
  const implied = impliedMasterNotes(row as any, chart);
  if (implied == null || chart.notes == null || implied <= chart.notes) {
    return c.json({ error: "a judge-sum shortfall cannot correct the master (freeze pairs explain it)" }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const reason =
    typeof body.reason === "string" && body.reason ? body.reason : `プレイ ${id} の判定合計（余り）から逆算`;
  const now = Date.now();
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO chart_corrections (chart_id, notes, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chart_id) DO UPDATE SET notes = excluded.notes,
           reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .bind(chart.chart_id, implied, reason, now, now)
      .run();
  } catch {
    return c.json({ error: "chart_corrections table is missing — apply migration 0010 first" }, 500);
  }
  const maxEx = chart.freeze != null ? (implied + chart.freeze + (chart.shock ?? 0)) * 3 : null;
  await c.env.DB
    .prepare("UPDATE charts SET notes = ?, max_ex = ? WHERE chart_id = ?")
    .bind(implied, maxEx, chart.chart_id)
    .run();
  const resolved = await recheckChartScores(c.env, chart.chart_id);
  return c.json({ chart_id: chart.chart_id, notes: implied, max_ex: maxEx, resolved });
});
