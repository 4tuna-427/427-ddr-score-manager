import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  chartId as makeChartId,
  choosePlayer,
  evaluateScore,
  expandMaster,
  normalizeTitle,
  parsePlayedAt,
  jstDateString,
  jstDayStartMs,
  computeDayUpdates,
  type ChartRow,
  type Extraction,
  type PlayerExtraction,
  type SongRow,
} from "./lib";
import { extractFromImage } from "./gemini";

export interface Env {
  DB: D1Database;
  API_TOKEN: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  MASTER_URL?: string;
  MY_DANCER_NAME?: string;
}

const DEFAULT_MASTER_URL = "https://4tuna-427.github.io/ddr-song-data/songs.json";

const app = new Hono<{ Bindings: Env }>();

// ---- CORS: the PWA is served from a different origin (pages.dev) ----
// Registered before auth so preflight OPTIONS requests (which carry no
// X-API-Token) are answered here. Auth uses a header token, not cookies,
// so a wildcard origin is safe for this personal app.
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-API-Token"],
    maxAge: 86400,
  }),
);

// ---- auth: every /api/* needs X-API-Token except GET /api/health ----
app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  if (c.req.path === "/api/health") return next();
  const token = c.req.header("X-API-Token");
  if (!c.env.API_TOKEN || !token || token !== c.env.API_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

// ---- helpers ----

function genId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}${rand}`;
}

interface ChartDbRow {
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

interface ScoreFields {
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

async function findChartByTitle(
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
  if (results.length !== 1) return { song: null, chart: null };
  const song = results[0];
  const chart = await db
    .prepare("SELECT * FROM charts WHERE chart_id = ?")
    .bind(makeChartId(song.song_id, playStyle, difficulty))
    .first<ChartDbRow>();
  return { song, chart: chart ?? null };
}

function buildFields(
  ext: Extraction,
  player: PlayerExtraction,
  song: SongRow | null,
  chart: ChartDbRow | null,
  playerUnresolved: boolean,
): ScoreFields {
  const playStyle = ext.play_style ?? "SP";
  const ev = evaluateScore(player, chart, {
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
    ok: player.ok,
    miss: player.miss,
    fast_count: player.fast_count,
    slow_count: player.slow_count,
    max_combo: player.max_combo,
    ex_check: ev.ex_check,
    judge_sum_check: ev.judge_sum_check,
    needs_review: ev.needs_review ? 1 : 0,
  };
}

const SCORE_COLUMNS = [
  "chart_id", "song_id", "raw_title", "play_style", "difficulty", "level",
  "score", "ex_score", "rank", "clear_lamp", "flare_rank",
  "marvelous", "perfect", "great", "good", "ok", "miss",
  "fast_count", "slow_count", "max_combo",
  "ex_check", "judge_sum_check", "needs_review",
] as const;

function fieldsToValues(f: ScoreFields): unknown[] {
  return SCORE_COLUMNS.map((col) => f[col]);
}

async function getScore(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist, charts.max_ex AS chart_max_ex
       FROM scores s
       LEFT JOIN songs ON songs.song_id = s.song_id
       LEFT JOIN charts ON charts.chart_id = s.chart_id
       WHERE s.id = ?`,
    )
    .bind(id)
    .first<Record<string, unknown>>();
  return row ?? null;
}

async function getChart(db: D1Database, id: string): Promise<ChartDbRow | null> {
  const row = await db.prepare("SELECT * FROM charts WHERE chart_id = ?").bind(id).first<ChartDbRow>();
  return row ?? null;
}

/** Recompute checks for an existing score row (after PATCH / link / select-player). */
function recomputeChecks(
  row: Record<string, any>,
  chart: ChartDbRow | null,
): { ex_check: string; judge_sum_check: string; needs_review: number } {
  const ev = evaluateScore(row as PlayerExtraction, chart, { chartLinked: !!chart });
  return { ex_check: ev.ex_check, judge_sum_check: ev.judge_sum_check, needs_review: ev.needs_review ? 1 : 0 };
}

// ---- POST /api/analyze ----
app.post("/api/analyze", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !file || typeof file === "string") {
    return c.json({ error: "file is required (multipart/form-data)" }, 400);
  }
  const sourceRaw = form.get("source");
  const source = typeof sourceRaw === "string" && ["share", "upload", "manual"].includes(sourceRaw)
    ? sourceRaw
    : "share";

  // Duplicate check on the uploaded (resized) image bytes, before spending
  // a Gemini call. The hash is of the converted image the client sends,
  // so re-uploading the same photo from the same device matches.
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

  let extraction: Extraction;
  try {
    extraction = await extractFromImage(c.env, file);
  } catch (e) {
    return c.json({ error: `gemini extraction failed: ${e instanceof Error ? e.message : String(e)}` }, 502);
  }

  const chosen = choosePlayer(extraction, c.env.MY_DANCER_NAME);
  if (!chosen) return c.json({ error: "no player found in extraction" }, 422);

  const playStyle = extraction.play_style ?? "SP";
  const difficulty = chosen.player.difficulty ?? "UNKNOWN";
  const { song, chart } = await findChartByTitle(c.env.DB, extraction.song_title, playStyle, difficulty);
  const fields = buildFields(extraction, chosen.player, song, chart, chosen.unresolved);

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
  // played_at: prefer the photo's capture time sent by the client (EXIF),
  // validated by parsePlayedAt; fall back to upload time.
  const playedAt = parsePlayedAt(form.get("played_at"), now) ?? now;
  const cols = ["id", ...SCORE_COLUMNS, "image_hash", "source", "raw_extraction", "played_at", "created_at"];
  await c.env.DB
    .prepare(`INSERT INTO scores (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(id, ...fieldsToValues(fields), imageHash, source, JSON.stringify(extraction), playedAt, now)
    .run();

  const score = await getScore(c.env.DB, id);
  return c.json({ score, previous }, 201);
});

// ---- GET /api/scores ----
// ---- latest play day (JST) summary: plays + personal-best updates ----
app.get("/api/summary/latest-day", async (c) => {
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
  if (chartIds.length > 0) {
    const placeholders = chartIds.map(() => "?").join(", ");
    const { results: prevRows } = await c.env.DB
      .prepare(
        `SELECT chart_id, MAX(score) AS best FROM scores
         WHERE chart_id IN (${placeholders}) AND played_at < ? GROUP BY chart_id`,
      )
      .bind(...chartIds, start)
      .all<{ chart_id: string; best: number }>();
    for (const r of prevRows) prevBest.set(r.chart_id, r.best);
  }
  const updates = computeDayUpdates(dayRows, prevBest).map((u) => ({
    ...u.row,
    prev_best: u.prev_best,
    diff: u.diff,
    is_new: u.is_new,
  }));
  return c.json({
    date,
    total_plays: dayRows.length,
    unique_charts: chartIds.length,
    updates,
  });
});

// ---- export: full score history as a downloadable JSON backup ----
app.get("/api/export", async (c) => {
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
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="ddr-scores-export.json"',
      "Access-Control-Allow-Origin": "*",
    },
  });
});

app.get("/api/scores", async (c) => {
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
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist, charts.max_ex AS chart_max_ex
       FROM scores s LEFT JOIN songs ON songs.song_id = s.song_id
       LEFT JOIN charts ON charts.chart_id = s.chart_id
       ${where} ORDER BY s.played_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all();
  return c.json({ items: results, total: totalRow?.n ?? 0 });
});

// ---- GET /api/scores/:id ----
app.get("/api/scores/:id", async (c) => {
  const score = await getScore(c.env.DB, c.req.param("id"));
  if (!score) return c.json({ error: "not found" }, 404);
  return c.json({ score });
});

// ---- PATCH /api/scores/:id ----
const PATCHABLE = [
  "score", "ex_score", "marvelous", "perfect", "great", "good", "ok", "miss",
  "rank", "clear_lamp", "flare_rank", "max_combo", "fast_count", "slow_count",
  "difficulty", "level",
] as const;

app.patch("/api/scores/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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
  const chart = merged.chart_id ? await getChart(c.env.DB, String(merged.chart_id)) : null;
  const checks = recomputeChecks(merged, chart);
  sets.push("ex_check = ?", "judge_sum_check = ?", "needs_review = ?");
  values.push(checks.ex_check, checks.judge_sum_check, checks.needs_review);
  await c.env.DB
    .prepare(`UPDATE scores SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, id)
    .run();
  return c.json({ score: await getScore(c.env.DB, id) });
});

// ---- POST /api/scores/:id/select-player ----
app.post("/api/scores/:id/select-player", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { player?: number };
  if (body.player !== 1 && body.player !== 2) {
    return c.json({ error: "player must be 1 or 2" }, 400);
  }
  if (!row.raw_extraction) return c.json({ error: "no raw_extraction stored" }, 400);
  const extraction = JSON.parse(String(row.raw_extraction)) as Extraction;
  const player = body.player === 1 ? extraction.player_1 : extraction.player_2;
  if (!player) return c.json({ error: "that player is not in the extraction" }, 400);

  const playStyle = extraction.play_style ?? "SP";
  const difficulty = player.difficulty ?? "UNKNOWN";
  const { song, chart } = await findChartByTitle(c.env.DB, extraction.song_title, playStyle, difficulty);
  const fields = buildFields(extraction, player, song, chart, false);
  const sets = SCORE_COLUMNS.map((col) => `${col} = ?`).join(", ");
  await c.env.DB
    .prepare(`UPDATE scores SET ${sets} WHERE id = ?`)
    .bind(...fieldsToValues(fields), id)
    .run();
  return c.json({ score: await getScore(c.env.DB, id) });
});

// ---- POST /api/scores/:id/link ----
app.post("/api/scores/:id/link", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { chart_id?: string };
  if (!body.chart_id) return c.json({ error: "chart_id is required" }, 400);
  const chart = await getChart(c.env.DB, body.chart_id);
  if (!chart) return c.json({ error: "chart not found" }, 404);

  const merged: Record<string, any> = {
    ...row,
    chart_id: chart.chart_id,
    song_id: chart.song_id,
    play_style: chart.play_style,
    difficulty: chart.difficulty,
    level: chart.level,
  };
  const checks = recomputeChecks(merged, chart);
  await c.env.DB
    .prepare(
      "UPDATE scores SET chart_id = ?, song_id = ?, play_style = ?, difficulty = ?, level = ?, ex_check = ?, judge_sum_check = ?, needs_review = ? WHERE id = ?",
    )
    .bind(chart.chart_id, chart.song_id, chart.play_style, chart.difficulty, chart.level,
      checks.ex_check, checks.judge_sum_check, checks.needs_review, id)
    .run();
  return c.json({ score: await getScore(c.env.DB, id) });
});

// ---- GET /api/songs?q= ----
app.get("/api/songs", async (c) => {
  const q = normalizeTitle(c.req.query("q") ?? "");
  const { results: songs } = await c.env.DB
    .prepare("SELECT * FROM songs WHERE title_normalized LIKE ? ESCAPE '\\' ORDER BY title LIMIT 20")
    .bind(`%${q.replace(/[%_\\]/g, "\\$&")}%`)
    .all<SongRow>();
  const items = [];
  for (const song of songs) {
    const { results: charts } = await c.env.DB
      .prepare("SELECT chart_id, play_style, difficulty, level FROM charts WHERE song_id = ? ORDER BY play_style, difficulty")
      .bind(song.song_id)
      .all();
    items.push({ song_id: song.song_id, title: song.title, artist: song.artist, charts });
  }
  return c.json({ items });
});

// ---- browse charts (master + personal bests) ----
app.get("/api/browse/facets", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT DISTINCT version FROM songs WHERE version IS NOT NULL AND version <> '' ORDER BY version")
    .all<{ version: string }>();
  return c.json({ versions: results.map((r) => r.version) });
});

app.get("/api/browse", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const style = c.req.query("style") ?? "";
  const difficulty = c.req.query("difficulty") ?? "";
  const levelRaw = parseInt(c.req.query("level") ?? "", 10);
  const level = Number.isNaN(levelRaw) ? null : levelRaw;
  const version = c.req.query("version") ?? "";
  const played = c.req.query("played") ?? "";
  const sort = c.req.query("sort") ?? "level";
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push("(s.title_normalized LIKE ? OR s.artist LIKE ?)");
    binds.push(`%${normalizeTitle(q)}%`, `%${q}%`);
  }
  if (style === "SP" || style === "DP") { where.push("c.play_style = ?"); binds.push(style); }
  if (difficulty) { where.push("c.difficulty = ?"); binds.push(difficulty); }
  if (level != null) { where.push("c.level = ?"); binds.push(level); }
  if (version) { where.push("s.version = ?"); binds.push(version); }
  if (played === "played") where.push("pb.plays IS NOT NULL");
  if (played === "unplayed") where.push("pb.plays IS NULL");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const fromSql = `FROM charts c JOIN songs s ON s.song_id = c.song_id
    LEFT JOIN (SELECT chart_id, MAX(score) AS best_score, COUNT(*) AS plays, MAX(played_at) AS last_played
               FROM scores GROUP BY chart_id) pb ON pb.chart_id = c.chart_id`;

  const totalRow = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n ${fromSql} ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();

  const orderSql =
    sort === "best" ? "ORDER BY pb.best_score IS NULL, pb.best_score DESC, s.title" :
    sort === "recent" ? "ORDER BY pb.last_played IS NULL, pb.last_played DESC, s.title" :
    sort === "title" ? "ORDER BY s.title, c.play_style, c.level" :
    "ORDER BY c.level, s.title, c.play_style";
  const { results: rows } = await c.env.DB
    .prepare(
      `SELECT c.chart_id, c.song_id, c.play_style, c.difficulty, c.level, c.max_ex,
              s.title, s.artist, s.version, s.bpm,
              pb.best_score, pb.plays, pb.last_played
       ${fromSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<Record<string, unknown> & { chart_id: string; best_score: number | null }>();

  // Rank/lamp/EX of the personal-best play (latest row achieving the best score).
  const ids = rows.filter((r) => r.best_score != null).map((r) => r.chart_id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const { results: bestRows } = await c.env.DB
      .prepare(
        `SELECT chart_id, ex_score, rank, clear_lamp FROM scores
         WHERE chart_id IN (${placeholders}) ORDER BY score DESC, played_at DESC`,
      )
      .bind(...ids)
      .all<{ chart_id: string; ex_score: number | null; rank: string | null; clear_lamp: string | null }>();
    const picked = new Set<string>();
    const detail = new Map<string, { ex_score: number | null; rank: string | null; clear_lamp: string | null }>();
    for (const br of bestRows) {
      if (picked.has(br.chart_id)) continue;
      picked.add(br.chart_id);
      detail.set(br.chart_id, { ex_score: br.ex_score, rank: br.rank, clear_lamp: br.clear_lamp });
    }
    for (const r of rows) {
      const d = detail.get(r.chart_id);
      if (d) Object.assign(r, { best_ex_score: d.ex_score, best_rank: d.rank, best_lamp: d.clear_lamp });
    }
  }
  return c.json({ items: rows, total: totalRow?.n ?? 0 });
});

// ---- GET /api/charts/:chart_id/history ----
app.get("/api/charts/:chart_id/history", async (c) => {
  const chartId = c.req.param("chart_id");
  const chartRow = await c.env.DB
    .prepare(
      `SELECT charts.*, songs.title AS song_title, songs.artist AS artist
       FROM charts JOIN songs ON songs.song_id = charts.song_id WHERE charts.chart_id = ?`,
    )
    .bind(chartId)
    .first();
  if (!chartRow) return c.json({ error: "chart not found" }, 404);
  const { results } = await c.env.DB
    .prepare("SELECT * FROM scores WHERE chart_id = ? ORDER BY played_at ASC")
    .bind(chartId)
    .all();
  return c.json({ chart: chartRow, items: results });
});

// ---- POST /api/admin/sync ----
app.post("/api/admin/sync", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  const url = body.url || c.env.MASTER_URL || DEFAULT_MASTER_URL;
  const res = await fetch(url);
  if (!res.ok) return c.json({ error: `master fetch failed: ${res.status}` }, 502);
  const raw = (await res.json()) as Array<Record<string, any>>;
  if (!Array.isArray(raw)) return c.json({ error: "master is not an array" }, 502);
  const { songs, charts } = expandMaster(raw);
  const now = Date.now();

  const songStmt = c.env.DB.prepare(
    `INSERT INTO songs (song_id, title, title_normalized, artist, version, bpm, phash_8, phash_16, availability, deleted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET
       title = excluded.title, title_normalized = excluded.title_normalized,
       artist = excluded.artist, version = excluded.version, bpm = excluded.bpm,
       phash_8 = excluded.phash_8, phash_16 = excluded.phash_16,
       availability = excluded.availability, deleted_at = excluded.deleted_at,
       updated_at = excluded.updated_at`,
  );
  // v1 masters carry no notecounts: keep existing notes/freeze/shock/max_ex via COALESCE.
  const chartStmt = c.env.DB.prepare(
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
  for (const s of songs) {
    stmts.push(songStmt.bind(s.song_id, s.title, s.title_normalized, s.artist, s.version, s.bpm,
      s.phash_8, s.phash_16, s.availability, s.deleted_at, now));
  }
  for (const ch of charts) {
    stmts.push(chartStmt.bind(ch.chart_id, ch.song_id, ch.play_style, ch.difficulty, ch.level,
      ch.notes, ch.freeze, ch.shock, ch.max_ex));
  }
  const BATCH = 100;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await c.env.DB.batch(stmts.slice(i, i + BATCH));
  }
  return c.json({ songs: songs.length, charts: charts.length });
});

export default app;
