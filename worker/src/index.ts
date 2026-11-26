import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  chartId as makeChartId,
  choosePlayer,
  evaluateScore,
  expandMaster,
  planSync,
  normalizeTitle,
  parsePlayedAt,
  jstDateString,
  jstDayStartMs,
  computeDayUpdates,
  computeStats,
  rankTitleCandidates,
  bestTitleMatch,
  FLARE_ORDER,
  LAMP_RANK,
  computeCloseCalls,
  computeVersus,
  computeReviewReasons,
  findPhashCandidates,
  isValidPhash64,
  songCategory,
  CATEGORY_VERSION_SPELLINGS,
  type SongCategory,
  type ChartRow,
  type Extraction,
  type PlayerExtraction,
  type SongRow,
} from "./lib";
import { extractFromImage, GeminiQuotaExhaustedError } from "./gemini";

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
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

const D1_IN_CHUNK = 90;
const REVIEW_IMG_PREFIX = "review_img:";
const REVIEW_IMG_TTL_SEC = 30 * 86400;

async function saveReviewImage(
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

async function deleteReviewImage(env: Env, scoreId: string): Promise<void> {
  if (!env.JACKETS) return;
  await env.JACKETS.delete(`${REVIEW_IMG_PREFIX}${scoreId}`).catch(() => {});
}

function chunkArray<T>(arr: T[], size = D1_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
  let song: SongRow | null = null;
  if (results.length === 1) {
    song = results[0];
  } else if (results.length === 0) {
    // Fuzzy fallback for OCR misreads (dropped/substituted characters,
    // trailing artist credits like 【...】). Only a confident match links.
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

/**
 * For unlinked score rows, attach ranked link candidates (fuzzy title
 * matches whose song has a chart for the row's style/difficulty), so the
 * review UI can offer one-tap linking.
 */
async function attachCandidates<T extends Record<string, any>>(db: D1Database, rows: T[]): Promise<T[]> {
  const unlinked = rows.filter((r) => !r.chart_id && r.raw_title);
  if (unlinked.length === 0) return rows;
  const { results: allSongs } = await db
    .prepare("SELECT song_id, title, title_normalized, artist FROM songs")
    .all<{ song_id: string; title: string; title_normalized: string; artist: string | null }>();
  const artistById = new Map(allSongs.map((s) => [s.song_id, s.artist]));
  const byTitle = new Map<string, ReturnType<typeof rankTitleCandidates>>();
  for (const r of unlinked) {
    if (!byTitle.has(r.raw_title)) byTitle.set(r.raw_title, rankTitleCandidates(r.raw_title, allSongs, 3));
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

function isPlayerUnresolved(row: Record<string, any>, myDancerName?: string): boolean {
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

async function attachReviewDetails<T extends Record<string, any>>(
  db: D1Database,
  rows: T[],
  myDancerName?: string,
): Promise<T[]> {
  await attachCandidates(db, rows);

  // For rows where song matched but chart didn't (difficulty mismatch), attach available charts of that song.
  const songOnlyIds = [...new Set(
    rows.filter((r) => r.song_id && !r.chart_id).map((r) => String(r.song_id)),
  )];
  const chartsBySong = new Map<string, { chart_id: string; play_style: string; difficulty: string; level: number | null }[]>();
  for (const chunk of chunkArray(songOnlyIds)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const { results: songCharts } = await db
      .prepare(`SELECT chart_id, song_id, play_style, difficulty, level FROM charts WHERE song_id IN (${placeholders}) ORDER BY play_style, difficulty`)
      .bind(...chunk)
      .all<{ chart_id: string; song_id: string; play_style: string; difficulty: string; level: number | null }>();
    for (const ch of songCharts) {
      const list = chartsBySong.get(ch.song_id) ?? [];
      list.push({ chart_id: ch.chart_id, play_style: ch.play_style, difficulty: ch.difficulty, level: ch.level });
      chartsBySong.set(ch.song_id, list);
    }
  }

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

function buildFields(
  ext: Extraction,
  player: PlayerExtraction,
  song: SongRow | null,
  chart: ChartDbRow | null,
  playerUnresolved: boolean,
): ScoreFields {
  const playStyle = ext.play_style ?? "SP";
  const ev = evaluateScore(player, chart, {
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
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist,
              charts.level AS chart_level, charts.notes AS chart_notes,
              charts.freeze AS chart_freeze, charts.shock AS chart_shock,
              charts.max_ex AS chart_max_ex
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
  opts?: { playerUnresolved?: boolean },
): { ex_check: string; judge_sum_check: string; needs_review: number } {
  const ev = evaluateScore(row as any, chart, {
    songLinked: !!row.song_id,
    chartLinked: !!chart,
    playerUnresolved: opts?.playerUnresolved,
  });
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

  // bulk=1 (mass import of past photos): reduced in-model retries so a
  // transient error burst does not burn the daily free quota.
  const bulk = form.get("bulk") === "1";
  let extraction: Extraction;
  try {
    extraction = await extractFromImage(c.env, file, { bulk });
  } catch (e) {
    if (e instanceof GeminiQuotaExhaustedError) {
      // Every model ran out of free quota: tell the client to stop for
      // today (429) instead of looking like a generic failure (502).
      return c.json({ error: "quota_exhausted", detail: e.message }, 429);
    }
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
    // Newest first on the Home screen.
    .sort((a, b) => (b.played_at as number) - (a.played_at as number));
  return c.json({
    date,
    total_plays: dayRows.length,
    unique_charts: chartIds.length,
    updates,
  });
});

// ---- GET /api/stats: achievements (per level / category) + monthly activity ----
app.get("/api/stats", async (c) => {
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

// ---- GET /api/versus: versus history from raw_extraction ----
app.get("/api/versus", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.id AS id, COALESCE(songs.title, s.raw_title) AS song_title, s.raw_extraction AS raw_extraction, s.played_at AS played_at
       FROM scores s LEFT JOIN songs ON songs.song_id = s.song_id
       WHERE s.raw_extraction IS NOT NULL ORDER BY s.played_at DESC`,
    )
    .all<{ id: string; song_title: string | null; raw_extraction: string | null; played_at: number }>();
  return c.json(computeVersus(results, c.env.MY_DANCER_NAME));
});

// ---- GET /api/close-calls: charts whose best play is almost AAA / almost the next lamp ----
app.get("/api/close-calls", async (c) => {
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
  // Ties on the best score: keep the latest play per chart.
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

// ---- POST /api/import: restore an export JSON (GET /api/export format) ----
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

/** Validate one exported score row; returns the INSERT values in IMPORT_COLUMNS order. */
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

app.post("/api/import", async (c) => {
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

  // Duplicates already in the DB (by id or image_hash).
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
      // image_hash column missing (migration 0002 not applied): skip hash dedupe.
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
        // Batch is atomic: the whole chunk failed (e.g. schema mismatch).
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
      `SELECT s.*, songs.title AS song_title, songs.artist AS artist,
              charts.level AS chart_level, charts.notes AS chart_notes,
              charts.freeze AS chart_freeze, charts.shock AS chart_shock,
              charts.max_ex AS chart_max_ex
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
app.get("/api/scores/:id", async (c) => {
  const score = await getScore(c.env.DB, c.req.param("id"));
  if (!score) return c.json({ error: "not found" }, 404);
  await attachReviewDetails(c.env.DB, [score as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score });
});

// ---- GET /api/scores/:id/image (temporary review image from KV) ----
app.get("/api/scores/:id/image", async (c) => {
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

// ---- DELETE /api/scores/:id (remove a bogus/unlinkable record) ----
app.delete("/api/scores/:id", async (c) => {
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

app.patch("/api/scores/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getScore(c.env.DB, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if ("review_status" in body && body.review_status !== null && body.review_status !== "waiting_master") {
    return c.json({ error: "review_status must be null or 'waiting_master'" }, 400);
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
      // Force clear review_status if review is resolved.
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
app.post("/api/scores/:id/select-player", async (c) => {
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
  const playerUnresolved = row.needs_review === 1 ? isPlayerUnresolved(merged, c.env.MY_DANCER_NAME) : false;
  const checks = recomputeChecks(merged, chart, { playerUnresolved });
  await c.env.DB
    .prepare(
      `UPDATE scores SET chart_id = ?, song_id = ?, play_style = ?, difficulty = ?, level = ?,
       ex_check = ?, judge_sum_check = ?, needs_review = ?,
       review_status = NULL${checks.needs_review === 0 ? ", has_review_image = 0" : ""} WHERE id = ?`,
    )
    .bind(chart.chart_id, chart.song_id, chart.play_style, chart.difficulty, chart.level,
      checks.ex_check, checks.judge_sum_check, checks.needs_review, id)
    .run();
  if (checks.needs_review === 0) {
    await deleteReviewImage(c.env, id);
  }
  const updated = await getScore(c.env.DB, id);
  if (updated) await attachReviewDetails(c.env.DB, [updated as Record<string, any>], c.env.MY_DANCER_NAME);
  return c.json({ score: updated });
});

// ---- GET /api/targets / POST /api/targets / DELETE /api/targets/:chart_id ----
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

app.get("/api/targets", async (c) => {
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

app.post("/api/targets", async (c) => {
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
  return c.json({ target: await getTargetWithChart(c.env.DB, body.chart_id) });
});

app.delete("/api/targets/:chart_id", async (c) => {
  const chartId = c.req.param("chart_id");
  const existing = await getTargetWithChart(c.env.DB, chartId);
  if (!existing) return c.json({ error: "target not found" }, 404);
  await c.env.DB.prepare("DELETE FROM targets WHERE chart_id = ?").bind(chartId).run();
  return c.json({ deleted: true });
});

// ---- GET /api/songs/by-phash?phash=...&max_distance=20&limit=5 ----
// Nearest songs by jacket pHash (hamming distance). Candidates are
// suggestions only: Phase 2.4 verification showed true matches at
// distance 18-36 while unrelated songs match at 16-20, so a small
// distance does not prove a match. Never auto-link from this alone.
app.get("/api/songs/by-phash", async (c) => {
  const phash = (c.req.query("phash") ?? "").toLowerCase();
  if (!isValidPhash64(phash)) {
    return c.json({ error: "phash must be 16 hex characters" }, 400);
  }
  const maxDistance = Math.min(Math.max(parseInt(c.req.query("max_distance") ?? "20", 10) || 20, 0), 64);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "5", 10) || 5, 1), 20);
  const { results: songs } = await c.env.DB
    .prepare("SELECT song_id, title, artist, phash_8 FROM songs WHERE phash_8 IS NOT NULL")
    .all<{ song_id: string; title: string; artist: string | null; phash_8: string }>();
  const candidates = findPhashCandidates(phash, songs, limit, maxDistance);
  const items = [];
  for (const cand of candidates) {
    const { results: charts } = await c.env.DB
      .prepare("SELECT chart_id, play_style, difficulty, level FROM charts WHERE song_id = ? ORDER BY play_style, difficulty")
      .bind(cand.song.song_id)
      .all();
    items.push({
      song_id: cand.song.song_id,
      title: cand.song.title,
      artist: cand.song.artist,
      distance: cand.distance,
      charts,
    });
  }
  return c.json({ items });
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

// ---- POST /api/songs/custom (register provisional song + chart and optionally link score) ----
const VALID_DIFFS = ["BEGINNER", "BASIC", "DIFFICULT", "EXPERT", "CHALLENGE"] as const;

app.post("/api/songs/custom", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: unknown;
    artist?: unknown;
    play_style?: unknown;
    difficulty?: unknown;
    level?: unknown;
    notes?: unknown;
    freeze?: unknown;
    shock?: unknown;
    score_id?: unknown;
  };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "title is required" }, 400);
  const titleNorm = normalizeTitle(title);
  if (!titleNorm) return c.json({ error: "title contains no valid characters" }, 400);
  if (body.play_style !== "SP" && body.play_style !== "DP") {
    return c.json({ error: "play_style must be SP or DP" }, 400);
  }
  if (typeof body.difficulty !== "string" || !(VALID_DIFFS as readonly string[]).includes(body.difficulty)) {
    return c.json({ error: `difficulty must be one of ${VALID_DIFFS.join(", ")}` }, 400);
  }
  const optInt = (v: unknown) => (v == null || v === "" ? null : isInt(v) ? v : NaN);
  const level = optInt(body.level);
  const notes = optInt(body.notes);
  const freeze = optInt(body.freeze);
  const shock = optInt(body.shock);
  if ([level, notes, freeze, shock].some((x) => Number.isNaN(x))) {
    return c.json({ error: "level, notes, freeze, shock must be integers or null" }, 400);
  }

  const songId = `custom_${genId()}`;
  const chartId = makeChartId(songId, body.play_style, body.difficulty);
  const artist = typeof body.artist === "string" && body.artist.trim() ? body.artist.trim() : null;
  const maxEx = notes != null && freeze != null ? (notes + freeze) * 3 : null;
  const now = Date.now();

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO songs (song_id, title, title_normalized, artist, availability, updated_at)
         VALUES (?, ?, ?, ?, 'custom', ?)`,
      )
      .bind(songId, title, titleNorm, artist, now),
    c.env.DB
      .prepare(
        `INSERT INTO charts (chart_id, song_id, play_style, difficulty, level, notes, freeze, shock, max_ex)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(chartId, songId, body.play_style, body.difficulty, level, notes, freeze, shock, maxEx),
  ]);

  let updatedScore: Record<string, unknown> | null = null;
  if (typeof body.score_id === "string" && body.score_id) {
    const scoreId = body.score_id;
    const row = await getScore(c.env.DB, scoreId);
    if (row) {
      const chart: ChartDbRow = {
        chart_id: chartId,
        song_id: songId,
        play_style: body.play_style,
        difficulty: body.difficulty,
        level,
        notes,
        freeze,
        shock,
        max_ex: maxEx,
      };
      const merged: Record<string, any> = {
        ...row,
        chart_id: chartId,
        song_id: songId,
        play_style: body.play_style,
        difficulty: body.difficulty,
        level: level ?? row.level,
      };
      const playerUnresolved = row.needs_review === 1 ? isPlayerUnresolved(merged, c.env.MY_DANCER_NAME) : false;
      const checks = recomputeChecks(merged, chart, { playerUnresolved });
      await c.env.DB
        .prepare(
          `UPDATE scores SET chart_id = ?, song_id = ?, play_style = ?, difficulty = ?, level = ?,
           ex_check = ?, judge_sum_check = ?, needs_review = ?,
           review_status = NULL${checks.needs_review === 0 ? ", has_review_image = 0" : ""} WHERE id = ?`,
        )
        .bind(
          chartId,
          songId,
          body.play_style,
          body.difficulty,
          merged.level,
          checks.ex_check,
          checks.judge_sum_check,
          checks.needs_review,
          scoreId,
        )
        .run();
      if (checks.needs_review === 0) {
        await deleteReviewImage(c.env, scoreId);
      }
      updatedScore = await getScore(c.env.DB, scoreId);
      if (updatedScore) await attachReviewDetails(c.env.DB, [updatedScore as Record<string, any>], c.env.MY_DANCER_NAME);
    }
  }

  return c.json(
    {
      song: { song_id: songId, title, artist },
      chart: { chart_id: chartId, play_style: body.play_style, difficulty: body.difficulty, level },
      score: updatedScore,
    },
    201,
  );
});

// ---- GET /api/jackets/:song_id (authenticated image delivery from KV) ----
// Jacket images are KONAMI artwork, so they are NOT public: the pipeline
// stores them in Workers KV and this endpoint serves them only to
// requests that passed the API-token auth middleware. 404 when the KV
// binding is not configured yet or the song has no jacket in KV.
app.get("/api/jackets/:song_id", async (c) => {
  const kv = c.env.JACKETS;
  if (!kv) return c.json({ error: "jacket storage is not configured" }, 404);
  const songId = c.req.param("song_id");
  const got = await kv.getWithMetadata<{ content_type?: string }>(songId, "arrayBuffer");
  if (!got.value) return c.json({ error: "jacket not found" }, 404);
  return new Response(got.value, {
    headers: {
      "Content-Type": got.metadata?.content_type ?? "image/jpeg",
      // Authenticated response: browsers may cache it privately only.
      "Cache-Control": "private, max-age=86400",
    },
  });
});

// ---- browse charts (master + personal bests) ----
app.get("/api/browse/facets", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT DISTINCT version FROM songs WHERE version IS NOT NULL AND version <> '' ORDER BY version")
    .all<{ version: string }>();
  const { results: verCounts } = await c.env.DB
    .prepare("SELECT version, COUNT(*) AS n FROM songs GROUP BY version")
    .all<{ version: string | null; n: number }>();
  const categories: Record<SongCategory, number> = { CLASSIC: 0, WHITE: 0, GOLD: 0 };
  for (const r of verCounts) {
    const cat = songCategory(r.version);
    if (cat) categories[cat] += r.n;
  }
  return c.json({ versions: results.map((r) => r.version), categories });
});

app.get("/api/browse", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const style = c.req.query("style") ?? "";
  const difficulty = c.req.query("difficulty") ?? "";
  const levelRaw = parseInt(c.req.query("level") ?? "", 10);
  const level = Number.isNaN(levelRaw) ? null : levelRaw;
  const version = c.req.query("version") ?? "";
  const categoryRaw = (c.req.query("category") ?? "").toUpperCase();
  const category = (["CLASSIC", "WHITE", "GOLD"] as const).find((x) => x === categoryRaw) ?? null;
  const played = c.req.query("played") ?? "";
  const sort = c.req.query("sort") ?? "level";
  const dirRaw = (c.req.query("dir") ?? "").toLowerCase();
  const dir: "asc" | "desc" | null = dirRaw === "asc" || dirRaw === "desc" ? dirRaw : null;
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    const esc = (s: string) => s.replace(/[%_\\]/g, "\\$&");
    where.push("(s.title_normalized LIKE ? ESCAPE '\\' OR s.artist LIKE ? ESCAPE '\\')");
    binds.push(`%${esc(normalizeTitle(q))}%`, `%${esc(q)}%`);
  }
  if (style === "SP" || style === "DP") { where.push("c.play_style = ?"); binds.push(style); }
  if (difficulty) { where.push("c.difficulty = ?"); binds.push(difficulty); }
  if (level != null) { where.push("c.level = ?"); binds.push(level); }
  if (version) { where.push("s.version = ?"); binds.push(version); }
  if (category) {
    const spellings = CATEGORY_VERSION_SPELLINGS[category];
    where.push(`s.version IN (${spellings.map(() => "?").join(", ")})`);
    binds.push(...spellings);
  }
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

  // Sort keys with their default direction; ?dir=asc|desc overrides it.
  // Nullable keys always sort NULLs last, in both directions.
  const bpmValue =
    "(CASE WHEN s.bpm LIKE '%-%' THEN CAST(substr(s.bpm, instr(s.bpm, '-') + 1) AS INTEGER) " +
    "ELSE CAST(s.bpm AS INTEGER) END)";
  const sortDefs: Record<string, { def: "asc" | "desc"; by: (d: string) => string }> = {
    level: { def: "asc", by: (d) => `c.level IS NULL, c.level ${d}, s.title, c.play_style` },
    title: { def: "asc", by: (d) => `s.title ${d}, c.play_style, c.level` },
    notes: { def: "desc", by: (d) => `c.notes IS NULL, c.notes ${d}, s.title` },
    bpm: { def: "desc", by: (d) => `${bpmValue} IS NULL, ${bpmValue} ${d}, s.title` },
    plays: { def: "desc", by: (d) => `pb.plays IS NULL, pb.plays ${d}, s.title` },
    best: { def: "desc", by: (d) => `pb.best_score IS NULL, pb.best_score ${d}, s.title` },
    recent: { def: "desc", by: (d) => `pb.last_played IS NULL, pb.last_played ${d}, s.title` },
  };
  const sortDef = sortDefs[sort] ?? sortDefs.level;
  const orderSql = `ORDER BY ${sortDef.by((dir ?? sortDef.def).toUpperCase())}`;
  const { results: rows } = await c.env.DB
    .prepare(
      `SELECT c.chart_id, c.song_id, c.play_style, c.difficulty, c.level, c.max_ex, c.notes,
              s.title, s.artist, s.version, s.bpm, s.has_jacket,
              pb.best_score, pb.plays, pb.last_played
       ${fromSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<Record<string, unknown> & { chart_id: string; best_score: number | null }>();

  // Rank/lamp/EX of the personal-best play (latest row achieving the best score).
  const ids = rows.filter((r) => r.best_score != null).map((r) => r.chart_id);
  if (ids.length > 0) {
    const picked = new Set<string>();
    const detail = new Map<string, { ex_score: number | null; rank: string | null; clear_lamp: string | null }>();
    const bestFlare = new Map<string, string>();
    for (const chunk of chunkArray(ids)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const { results: bestRows } = await c.env.DB
        .prepare(
          `SELECT chart_id, ex_score, rank, clear_lamp FROM scores
           WHERE chart_id IN (${placeholders}) ORDER BY score DESC, played_at DESC`,
        )
        .bind(...chunk)
        .all<{ chart_id: string; ex_score: number | null; rank: string | null; clear_lamp: string | null }>();
      for (const br of bestRows) {
        if (picked.has(br.chart_id)) continue;
        picked.add(br.chart_id);
        detail.set(br.chart_id, { ex_score: br.ex_score, rank: br.rank, clear_lamp: br.clear_lamp });
      }
      // Highest flare rank achieved on any cleared play of each chart on this page.
      const { results: flareRows } = await c.env.DB
        .prepare(
          `SELECT chart_id, flare_rank FROM scores
           WHERE chart_id IN (${placeholders}) AND flare_rank IS NOT NULL
             AND clear_lamp IS NOT NULL AND clear_lamp <> 'FAILED'`,
        )
        .bind(...chunk)
        .all<{ chart_id: string; flare_rank: string }>();
      for (const fr of flareRows) {
        const cur = bestFlare.get(fr.chart_id);
        if (!cur || (FLARE_ORDER[fr.flare_rank] ?? 0) > (FLARE_ORDER[cur] ?? 0)) {
          bestFlare.set(fr.chart_id, fr.flare_rank);
        }
      }
    }
    for (const r of rows) {
      const d = detail.get(r.chart_id);
      if (d) Object.assign(r, { best_ex_score: d.ex_score, best_rank: d.rank, best_lamp: d.clear_lamp });
      const f = bestFlare.get(r.chart_id);
      if (f) Object.assign(r, { best_flare_rank: f });
    }
  }
  for (const r of rows) r.category = songCategory((r as { version?: string | null }).version);
  return c.json({ items: rows, total: totalRow?.n ?? 0 });
});

// ---- GET /api/charts/:chart_id/history ----
app.get("/api/charts/:chart_id/history", async (c) => {
  const chartId = c.req.param("chart_id");
  const chartRow = await c.env.DB
    .prepare(
      `SELECT charts.*, songs.title AS song_title, songs.artist AS artist, songs.version AS version, songs.has_jacket AS has_jacket
       FROM charts JOIN songs ON songs.song_id = charts.song_id WHERE charts.chart_id = ?`,
    )
    .bind(chartId)
    .first();
  if (!chartRow) return c.json({ error: "chart not found" }, 404);
  (chartRow as Record<string, unknown>).category = songCategory((chartRow as { version?: string | null }).version);
  const { results } = await c.env.DB
    .prepare("SELECT * FROM scores WHERE chart_id = ? ORDER BY played_at ASC")
    .bind(chartId)
    .all();
  return c.json({ chart: chartRow, items: results });
});

// ---- master sync (shared by POST /api/admin/sync and the daily cron) ----
async function syncMaster(
  db: D1Database,
  url: string,
): Promise<{ songs: number; charts: number; songWrites: number; chartWrites: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`master fetch failed: ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, any>>;
  if (!Array.isArray(raw)) throw new Error("master is not an array");
  const { songs, charts } = expandMaster(raw);
  const now = Date.now();

  // Only write rows that actually changed (see planSync in lib.ts).
  const { results: existingSongs } = await db
    .prepare(
      "SELECT song_id, title, title_normalized, artist, version, bpm, phash_8, phash_16, availability, deleted_at, has_jacket FROM songs",
    )
    .all<SongRow>();
  const { results: existingCharts } = await db
    .prepare("SELECT chart_id, song_id, play_style, difficulty, level, notes, freeze, shock, max_ex FROM charts")
    .all<ChartRow>();
  const { songUpserts, chartUpserts } = planSync(existingSongs, existingCharts, songs, charts);

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
  // v1 masters carry no notecounts: keep existing notes/freeze/shock/max_ex via COALESCE.
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
  return { songs: songs.length, charts: charts.length, songWrites: songUpserts.length, chartWrites: chartUpserts.length };
}

async function relinkUnlinkedScores(
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
    const merged: Record<string, any> = {
      ...row,
      chart_id: chart.chart_id,
      song_id: chart.song_id,
      play_style: chart.play_style,
      difficulty: chart.difficulty,
      level: chart.level,
    };
    const playerUnresolved = row.needs_review === 1 ? isPlayerUnresolved(merged, env.MY_DANCER_NAME) : false;
    const checks = recomputeChecks(merged, chart, { playerUnresolved });
    await env.DB
      .prepare(
        `UPDATE scores SET chart_id = ?, song_id = ?, play_style = ?, difficulty = ?, level = ?,
         ex_check = ?, judge_sum_check = ?, needs_review = ?,
         review_status = NULL${checks.needs_review === 0 ? ", has_review_image = 0" : ""} WHERE id = ?`,
      )
      .bind(chart.chart_id, chart.song_id, chart.play_style, chart.difficulty, chart.level,
        checks.ex_check, checks.judge_sum_check, checks.needs_review, row.id)
      .run();
    if (checks.needs_review === 0) {
      await deleteReviewImage(env, row.id);
    }
    linked += 1;
  }
  return { checked: rows.length, linked, remaining: rows.length - linked };
}

// ---- POST /api/admin/relink: re-run title matching for unlinked scores ----
app.post("/api/admin/relink", async (c) => {
  return c.json(await relinkUnlinkedScores(c.env));
});

// ---- POST /api/admin/sync ----
app.post("/api/admin/sync", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  const url = body.url || c.env.MASTER_URL || DEFAULT_MASTER_URL;
  try {
    const res = await syncMaster(c.env.DB, url);
    const relink = res.songWrites > 0 || res.chartWrites > 0
      ? await relinkUnlinkedScores(c.env)
      : { checked: 0, linked: 0, remaining: 0 };
    return c.json({ ...res, relink });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  // Daily master auto-sync (cron in wrangler.toml: 04:00 JST, after the
  // song-data pipeline's 03:00 JST update). Failures are logged, never
  // thrown, and can be checked in the Worker's logs; the manual
  // POST /api/admin/sync endpoint remains available as a fallback.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      syncMaster(env.DB, env.MASTER_URL || DEFAULT_MASTER_URL)
        .then(async (r) => {
          const relink = r.songWrites > 0 || r.chartWrites > 0
            ? await relinkUnlinkedScores(env)
            : { linked: 0 };
          console.log(
            `[cron sync] master songs=${r.songs} charts=${r.charts} writes: songs=${r.songWrites} charts=${r.chartWrites} relinked=${relink.linked}`,
          );
        })
        .catch((e) => console.error(`[cron sync] failed: ${e instanceof Error ? e.message : String(e)}`)),
    );
  },
};

export default handler;
