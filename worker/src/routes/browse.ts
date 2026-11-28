import { Hono } from "hono";
import {
  CATEGORY_VERSION_SPELLINGS,
  chartId as makeChartId,
  findPhashCandidates,
  FLARE_ORDER,
  isValidPhash64,
  normalizeTitle,
  songCategory,
  type SongCategory,
  type SongRow,
} from "../lib";
import {
  applyChartLinkToScore,
  attachReviewDetails,
  chunkArray,
  fetchChartsBySongIds,
  genId,
  getScore,
  type ChartDbRow,
  type Env,
} from "../db";

export const browseRoutes = new Hono<{ Bindings: Env }>();

const VALID_DIFFS = ["BEGINNER", "BASIC", "DIFFICULT", "EXPERT", "CHALLENGE"] as const;

// ---- GET /api/songs/by-phash ----
browseRoutes.get("/api/songs/by-phash", async (c) => {
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
  const chartsBySong = await fetchChartsBySongIds(
    c.env.DB,
    candidates.map((cand) => cand.song.song_id),
  );
  const items = candidates.map((cand) => ({
    song_id: cand.song.song_id,
    title: cand.song.title,
    artist: cand.song.artist,
    distance: cand.distance,
    charts: chartsBySong.get(cand.song.song_id) ?? [],
  }));
  return c.json({ items });
});

// ---- GET /api/songs?q= ----
browseRoutes.get("/api/songs", async (c) => {
  const q = normalizeTitle(c.req.query("q") ?? "");
  const { results: songs } = await c.env.DB
    .prepare("SELECT * FROM songs WHERE title_normalized LIKE ? ESCAPE '\\' ORDER BY title LIMIT 20")
    .bind(`%${q.replace(/[%_\\]/g, "\\$&")}%`)
    .all<SongRow>();
  const chartsBySong = await fetchChartsBySongIds(
    c.env.DB,
    songs.map((s) => s.song_id),
  );
  const items = songs.map((song) => ({
    song_id: song.song_id,
    title: song.title,
    artist: song.artist,
    charts: chartsBySong.get(song.song_id) ?? [],
  }));
  return c.json({ items });
});

// ---- POST /api/songs/custom ----
browseRoutes.post("/api/songs/custom", async (c) => {
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
  const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
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
      await applyChartLinkToScore(c.env, row, chart, level ?? (row.level as number | null));
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

// ---- GET /api/jackets/:song_id ----
browseRoutes.get("/api/jackets/:song_id", async (c) => {
  const kv = c.env.JACKETS;
  if (!kv) return c.json({ error: "jacket storage is not configured" }, 404);
  const songId = c.req.param("song_id");
  const got = await kv.getWithMetadata<{ content_type?: string }>(songId, "arrayBuffer");
  if (!got.value) return c.json({ error: "jacket not found" }, 404);
  return new Response(got.value, {
    headers: {
      "Content-Type": got.metadata?.content_type ?? "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
});

// ---- GET /api/browse/facets ----
browseRoutes.get("/api/browse/facets", async (c) => {
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

// ---- GET /api/browse ----
browseRoutes.get("/api/browse", async (c) => {
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
browseRoutes.get("/api/charts/:chart_id/history", async (c) => {
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
