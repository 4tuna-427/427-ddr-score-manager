import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calcEx,
  chartId,
  choosePlayer,
  detectMasterFormat,
  diffKey,
  exCheck,
  expandMaster,
  expandMasterSong,
  judgeSumCheck,
  normalizeTitle,
  computeStats,
  type Extraction,
} from "../src/lib";

const here = dirname(fileURLToPath(import.meta.url));
// Fixtures are bundled in-repo (test/fixtures/) so the suite runs anywhere,
// including a fresh clone: ground truth = the 6 real Phase 0 photos,
// master fixtures = the matching 6 songs (v2) and 3 songs (v1), verbatim
// excerpts of the real master data.
const gtDir = join(here, "fixtures", "ground_truth");
const masterPath = join(here, "fixtures", "master_v2_fixture.json");
const masterV1Path = join(here, "fixtures", "master_v1_fixture.json");

const groundTruths: Extraction[] = readdirSync(gtDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(gtDir, f), "utf-8")) as Extraction);

const masterV2 = JSON.parse(readFileSync(masterPath, "utf-8")) as Array<Record<string, any>>;
const { songs, charts } = expandMaster(masterV2);
const chartById = new Map(charts.map((c) => [c.chart_id, c]));

test("ground truth has 6 files and 8 player results", () => {
  assert.equal(groundTruths.length, 6);
  const players = groundTruths.flatMap((g) => [g.player_1, g.player_2].filter(Boolean));
  assert.equal(players.length, 8);
});

test("EX cross-check matches for all 8 real player results", () => {
  for (const gt of groundTruths) {
    for (const p of [gt.player_1, gt.player_2]) {
      if (!p) continue;
      assert.equal(exCheck(p), "match", `${gt.song_title} ex=${p.ex_score} calc=${calcEx(p)}`);
      assert.equal(calcEx(p), p.ex_score);
    }
  }
});

test("judge sum matches master notecounts for all 8 real player results", () => {
  for (const gt of groundTruths) {
    // find the unique song via normalized title
    const matches = songs.filter((s) => s.title_normalized === normalizeTitle(gt.song_title));
    assert.equal(matches.length, 1, `${gt.song_title} should match exactly one master song`);
    const song = matches[0];
    for (const p of [gt.player_1, gt.player_2]) {
      if (!p) continue;
      const key = diffKey(gt.play_style ?? "SP", p.difficulty ?? "");
      assert.ok(key, `diffKey for ${gt.play_style}/${p.difficulty}`);
      const raw = masterV2.find((s) => s.id === song.song_id);
      const nc = raw?.notecounts?.[key as string];
      assert.ok(nc, `notecounts for ${gt.song_title} ${key}`);
      assert.equal(judgeSumCheck(p, { notes: nc.notes, shock: nc.shock ?? null }), "match",
        `${gt.song_title} judge sum`);
      // and via the expanded chart row
      const chart = chartById.get(chartId(song.song_id, gt.play_style ?? "SP", p.difficulty ?? ""));
      assert.ok(chart);
      assert.equal(judgeSumCheck(p, chart), "match");
      assert.equal(chart.level, p.level);
    }
  }
});

test("normalizeTitle finds all 6 ground-truth titles uniquely in the master", () => {
  for (const gt of groundTruths) {
    const norm = normalizeTitle(gt.song_title);
    assert.ok(norm.length > 0);
    const matches = songs.filter((s) => s.title_normalized === norm);
    assert.equal(matches.length, 1, gt.song_title ?? "");
  }
  // normalization specifics: zero-width, symbols, case
  assert.equal(normalizeTitle("Roll the Dice"), "rollthedice");
  assert.equal(normalizeTitle("THE SAFARI (STARDOM Remix)"), normalizeTitle("THE SAFARI（STARDOM Remix）"));
});

test("choosePlayer selects 4TUNA in both versus photos", () => {
  const versus = groundTruths.filter((g) => g.is_versus);
  assert.equal(versus.length, 2);
  for (const gt of versus) {
    const chosen = choosePlayer(gt, "4TUNA");
    assert.ok(chosen);
    assert.equal(chosen.player.dancer_name, "4TUNA");
    assert.equal(chosen.index, 1);
    assert.equal(chosen.unresolved, false);
  }
});

test("choosePlayer picks player_2 when the name matches player_2, and flags unknown versus", () => {
  const gt = groundTruths.find((g) => g.is_versus) as Extraction;
  const swapped: Extraction = { ...gt, player_1: gt.player_2, player_2: gt.player_1 };
  const chosen = choosePlayer(swapped, "4tuna"); // case-insensitive
  assert.ok(chosen);
  assert.equal(chosen.index, 2);
  assert.equal(chosen.player.dancer_name, "4TUNA");

  const unknown = choosePlayer(gt, "NOBODY");
  assert.ok(unknown);
  assert.equal(unknown.index, 1);
  assert.equal(unknown.unresolved, true);

  const solo = groundTruths.find((g) => !g.is_versus) as Extraction;
  const soloChosen = choosePlayer(solo, "4TUNA");
  assert.ok(soloChosen);
  assert.equal(soloChosen.index, 1);
  assert.equal(soloChosen.unresolved, false);
});

test("master format detection and v1 expansion", () => {
  const masterV1 = JSON.parse(readFileSync(masterV1Path, "utf-8")) as Array<Record<string, any>>;
  assert.equal(detectMasterFormat(masterV1[0]), "v1");
  assert.equal(detectMasterFormat(masterV2[0]), "v2");
  const { song, charts: v1Charts } = expandMasterSong(masterV1[0]);
  assert.equal(song.title, masterV1[0].title);
  assert.ok(v1Charts.length > 0);
  for (const ch of v1Charts) {
    assert.equal(typeof ch.level, "number");
    assert.equal(ch.notes, null); // v1 has no notecounts
    assert.equal(ch.max_ex, null);
  }
  const spExpert = v1Charts.find((c) => c.play_style === "SP" && c.difficulty === "EXPERT");
  assert.ok(spExpert);
  assert.equal(spExpert.level, parseInt(masterV1[0].single_expert_level, 10));
});

test("v2 expansion computes max_ex from notecounts", () => {
  const { charts: v2Charts } = expandMasterSong(masterV2[0]);
  const spBeginner = v2Charts.find((c) => c.play_style === "SP" && c.difficulty === "BEGINNER");
  assert.ok(spBeginner);
  const nc = masterV2[0].notecounts.sp_beginner;
  assert.equal(spBeginner.notes, nc.notes);
  assert.equal(spBeginner.max_ex, (nc.notes + nc.freeze + (nc.shock ?? 0)) * 3);
});

test("parsePlayedAt accepts plausible ISO times and rejects bad ones", async () => {
  const { parsePlayedAt } = await import("../src/lib");
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.equal(parsePlayedAt("2026-11-23T07:38:10.000Z", now), Date.parse("2026-11-23T07:38:10.000Z"));
  assert.equal(parsePlayedAt("2026-11-24T12:30:00Z", now), Date.parse("2026-11-24T12:30:00Z")); // +30min skew ok
  assert.equal(parsePlayedAt("2026-11-25T12:00:00Z", now), null); // a day in the future
  assert.equal(parsePlayedAt("2005-01-01T00:00:00Z", now), null); // too old
  assert.equal(parsePlayedAt("not a date", now), null);
  assert.equal(parsePlayedAt(null, now), null);
  assert.equal(parsePlayedAt(123, now), null);
});

test("jstDateString / jstDayStartMs use JST boundaries", async () => {
  const { jstDateString, jstDayStartMs } = await import("../src/lib");
  // 2026-11-24 00:30 JST = 2026-11-23 15:30 UTC
  assert.equal(jstDateString(Date.parse("2026-11-23T15:30:00Z")), "2026-11-24");
  // 2026-11-24 23:59 JST = 14:59 UTC; 2026-11-25 00:00 JST = 15:00 UTC
  assert.equal(jstDateString(Date.parse("2026-11-24T14:59:00Z")), "2026-11-24");
  assert.equal(jstDateString(Date.parse("2026-11-24T15:00:00Z")), "2026-11-25");
  assert.equal(jstDayStartMs("2026-11-24"), Date.parse("2026-11-23T15:00:00Z"));
});

test("computeDayUpdates picks per-chart day best and diffs vs previous best", async () => {
  const { computeDayUpdates } = await import("../src/lib");
  const rows = [
    { id: "a", chart_id: "c1", score: 900000, played_at: 1000 },
    { id: "b", chart_id: "c1", score: 920000, played_at: 2000 },
    { id: "c", chart_id: "c2", score: 800000, played_at: 1500 },
    { id: "d", chart_id: "c3", score: 700000, played_at: 1200 },
    { id: "e", chart_id: null, score: 999999, played_at: 1100 },
  ];
  const prev = new Map([["c1", 910000], ["c3", 750000]]);
  const ups = computeDayUpdates(rows, prev);
  // c1: day best 920000 > 910000 -> update diff 10000; c2: new; c3: 700000 < 750000 -> none; null chart ignored
  assert.equal(ups.length, 2);
  const c1 = ups.find((u) => u.row.chart_id === "c1")!;
  assert.equal(c1.row.id, "b");
  assert.equal(c1.diff, 10000);
  assert.equal(c1.is_new, false);
  const c2 = ups.find((u) => u.row.chart_id === "c2")!;
  assert.equal(c2.is_new, true);
  assert.equal(c2.prev_best, null);
});

test("songCategory classifies by version folder with spelling variants", async () => {
  const { songCategory } = await import("../src/lib");
  assert.equal(songCategory("1st"), "CLASSIC");
  assert.equal(songCategory("X3 vs 2nd"), "CLASSIC");
  assert.equal(songCategory("X3"), "CLASSIC");
  assert.equal(songCategory("Extreme"), "CLASSIC");
  assert.equal(songCategory("EXTREME"), "CLASSIC");
  assert.equal(songCategory("DDRMAX2"), "CLASSIC");
  assert.equal(songCategory("SuperNOVA2"), "CLASSIC");
  assert.equal(songCategory("2013"), "WHITE");
  assert.equal(songCategory("2014"), "WHITE");
  assert.equal(songCategory("A"), "WHITE");
  assert.equal(songCategory("A20"), "GOLD");
  assert.equal(songCategory("A20 PLUS"), "GOLD");
  assert.equal(songCategory("A3"), "GOLD");
  assert.equal(songCategory("WORLD"), "GOLD");
  assert.equal(songCategory(null), null);
  assert.equal(songCategory(""), null);
  assert.equal(songCategory("SOMETHING ELSE"), null);
});

test("planSync writes only new or actually-changed rows", async () => {
  const { planSync } = await import("../src/lib");
  type S = import("../src/lib").SongRow;
  type C = import("../src/lib").ChartRow;
  const song = (over: Partial<S> = {}): S => ({
    song_id: "s1", title: "Song", title_normalized: "song", artist: "Artist",
    version: "WORLD", bpm: "150", phash_8: "aa", phash_16: "bb",
    availability: null, deleted_at: null, ...over,
  });
  const chart = (over: Partial<C> = {}): C => ({
    chart_id: "s1-SP-EXPERT", song_id: "s1", play_style: "SP", difficulty: "EXPERT",
    level: 15, notes: 500, freeze: 10, shock: 0, max_ex: 1530, ...over,
  });

  // Identical master -> no writes at all.
  let plan = planSync([song()], [chart()], [song()], [chart()]);
  assert.equal(plan.songUpserts.length, 0);
  assert.equal(plan.chartUpserts.length, 0);

  // New song + its chart -> both written.
  plan = planSync([], [], [song()], [chart()]);
  assert.equal(plan.songUpserts.length, 1);
  assert.equal(plan.chartUpserts.length, 1);

  // Changed title / level -> written.
  plan = planSync([song()], [chart()], [song({ title: "Song (Remix)" })], [chart({ level: 16 })]);
  assert.equal(plan.songUpserts.length, 1);
  assert.equal(plan.chartUpserts.length, 1);

  // v1-style master (phash carried, notecounts null) with same level -> no
  // chart write, and a null master phash never counts as a song change.
  plan = planSync(
    [song()], [chart()],
    [song({ phash_8: null, phash_16: null })],
    [chart({ notes: null, freeze: null, shock: null, max_ex: null })],
  );
  assert.equal(plan.songUpserts.length, 0);
  assert.equal(plan.chartUpserts.length, 0);

  // v2 notecount change at the same level -> chart written.
  plan = planSync([song()], [chart()], [song()], [chart({ notes: 501 })]);
  assert.equal(plan.chartUpserts.length, 1);

  // Tombstone appearing in the master -> song written.
  plan = planSync([song()], [chart()], [song({ deleted_at: "2026-01-01" })], [chart()]);
  assert.equal(plan.songUpserts.length, 1);
});

test("computeStats: achievements, best lamp across plays, monthly PB updates", () => {
  const jst = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h) - 9 * 3600 * 1000;
  const master = [
    { chart_id: "c1", play_style: "SP", level: 15, category: "GOLD" as const },
    { chart_id: "c2", play_style: "SP", level: 15, category: "GOLD" as const },
    { chart_id: "c5", play_style: "SP", level: 15, category: "GOLD" as const },
    { chart_id: "c3", play_style: "SP", level: 18, category: "CLASSIC" as const },
    { chart_id: "c4", play_style: "DP", level: 12, category: "WHITE" as const },
  ];
  const plays = [
    { chart_id: "c1", score: 900000, rank: "AA", clear_lamp: "FC", played_at: jst(2026, 10, 5) },
    { chart_id: "c1", score: 950000, rank: "AAA", clear_lamp: "PFC", played_at: jst(2026, 11, 2) },
    { chart_id: "c2", score: 800000, rank: "A", clear_lamp: "LIFE4", played_at: jst(2026, 11, 3) },
    // lower score but a full combo: best lamp must come from THIS play
    { chart_id: "c2", score: 750000, rank: "A-", clear_lamp: "FC", played_at: jst(2026, 11, 4) },
    { chart_id: "c3", score: 700000, rank: "B", clear_lamp: "FAILED", played_at: jst(2026, 11, 3) },
    { chart_id: "c3", score: 990000, rank: "AAA", clear_lamp: "MFC", played_at: jst(2026, 11, 10) },
    { chart_id: null, score: 500000, rank: null, clear_lamp: null, played_at: jst(2026, 11, 5) },
    // outside the 12-month window: counts in buckets/play_days, not monthly
    { chart_id: "c4", score: 600000, rank: "C", clear_lamp: "CLEAR", played_at: jst(2025, 6, 15) },
  ];
  const s = computeStats(master, plays, jst(2026, 11, 25));

  assert.equal(s.totals.total_charts, 5);
  assert.equal(s.totals.played, 4);
  assert.equal(s.totals.clear, 4);
  assert.equal(s.totals.fc, 3); // c1, c2 (via the lower-score play), c3
  assert.equal(s.totals.gfc, 2);
  assert.equal(s.totals.pfc, 2);
  assert.equal(s.totals.mfc, 1);
  assert.equal(s.totals.plays, 8);
  assert.equal(s.totals.play_days, 7);
  assert.equal(s.totals.aaa, 2);
  assert.equal(s.totals.max_clear_level, 18);

  const sp15 = s.by_level.find((r) => r.play_style === "SP" && r.level === 15)!;
  assert.deepEqual(
    [sp15.total_charts, sp15.played, sp15.clear, sp15.fc, sp15.gfc, sp15.pfc, sp15.mfc],
    [3, 2, 2, 2, 1, 1, 0],
  );
  const sp18 = s.by_level.find((r) => r.play_style === "SP" && r.level === 18)!;
  assert.equal(sp18.mfc, 1);
  const dp12 = s.by_level.find((r) => r.play_style === "DP" && r.level === 12)!;
  assert.deepEqual([dp12.played, dp12.clear, dp12.fc], [1, 1, 0]);
  // level rows: SP first, level descending
  assert.deepEqual(s.by_level.map((r) => `${r.play_style}${r.level}`), ["SP18", "SP15", "DP12"]);

  const gold = s.by_category.find((r) => r.category === "GOLD")!;
  assert.deepEqual([gold.total_charts, gold.played, gold.pfc], [3, 2, 1]);
  const classic = s.by_category.find((r) => r.category === "CLASSIC")!;
  assert.equal(classic.mfc, 1);
  const white = s.by_category.find((r) => r.category === "WHITE")!;
  assert.deepEqual([white.played, white.clear, white.fc], [1, 1, 0]);

  assert.equal(s.monthly.length, 12);
  assert.equal(s.monthly[0].month, "2025-12");
  assert.equal(s.monthly[11].month, "2026-11");
  const oct = s.monthly.find((m) => m.month === "2026-10")!;
  assert.deepEqual([oct.plays, oct.pb_updates], [1, 0]);
  const nov = s.monthly.find((m) => m.month === "2026-11")!;
  assert.deepEqual([nov.plays, nov.pb_updates], [6, 2]); // PB: c1 and c3 improvements only
});

test("lampGap measures judgments to the next lamp", async () => {
  const { lampGap } = await import("../src/lib");
  // CLEAR -> FC: only Misses break the combo (Goods do not).
  assert.deepEqual(lampGap({ clear_lamp: "CLEAR", great: 10, good: 5, miss: 2, perfect: 0 }), { next_lamp: "FC", gap: 2 });
  assert.deepEqual(lampGap({ clear_lamp: "LIFE4", great: 0, good: 0, miss: 0, perfect: 0 }), { next_lamp: "FC", gap: 0 });
  // FC -> GFC: at most one Great and no Good.
  assert.deepEqual(lampGap({ clear_lamp: "FC", great: 3, good: 1, miss: 0, perfect: 0 }), { next_lamp: "GFC", gap: 3 });
  assert.deepEqual(lampGap({ clear_lamp: "FC", great: 1, good: 0, miss: 0, perfect: 0 }), { next_lamp: "GFC", gap: 0 });
  // GFC -> PFC: no Great/Good left.
  assert.deepEqual(lampGap({ clear_lamp: "GFC", great: 2, good: 0, miss: 0, perfect: 0 }), { next_lamp: "PFC", gap: 2 });
  // PFC -> MFC: every Perfect must become Marvelous.
  assert.deepEqual(lampGap({ clear_lamp: "PFC", great: 0, good: 0, miss: 0, perfect: 4 }), { next_lamp: "MFC", gap: 4 });
  // No next lamp, or no lamp at all.
  assert.equal(lampGap({ clear_lamp: "MFC", great: 0, good: 0, miss: 0, perfect: 0 }), null);
  assert.equal(lampGap({ clear_lamp: "FAILED", great: 0, good: 0, miss: 30, perfect: 0 }), null);
  assert.equal(lampGap({ clear_lamp: null, great: 0, good: 0, miss: 0, perfect: 0 }), null);
  // Missing judgments are unknown, never zero: no close call is claimed.
  assert.equal(lampGap({ clear_lamp: "PFC", great: 0, good: 0, miss: 0, perfect: null }), null);
  assert.equal(lampGap({ clear_lamp: "FC", great: null, good: 0, miss: 0, perfect: 0 }), null);
  assert.equal(lampGap({ clear_lamp: "CLEAR", great: 0, good: 0, miss: null, perfect: 0 }), null);
});

test("computeCloseCalls finds AAA-near and lamp-near charts", async () => {
  const { computeCloseCalls } = await import("../src/lib");
  const play = (over: Record<string, unknown>) => ({
    chart_id: "c", score: 900000, rank: "AA", clear_lamp: "FC",
    marvelous: 100, perfect: 50, great: 0, good: 0, miss: 0, ...over,
  });
  const calls = computeCloseCalls([
    // 985,000: within 10,000 of AAA; FC with 0 Great/Good -> already GFC by counts (gap 0)
    play({ chart_id: "aaa-lamp", score: 985000 }),
    // 979,999: 10,001 away from AAA -> not an AAA close call; GFC 2 Greats from PFC
    play({ chart_id: "lamp-only", score: 979999, clear_lamp: "GFC", great: 2 }),
    // Exactly 990,000 is AAA already, not a close call; PFC with 6 Perfects is also not lamp-close
    play({ chart_id: "aaa-done", score: 990000, clear_lamp: "PFC", perfect: 6 }),
    // FAILED is never a lamp close call
    play({ chart_id: "failed", score: 700000, clear_lamp: "FAILED", miss: 20 }),
    // PFC 6 Perfects from MFC: gap 6 > 5, not close
    play({ chart_id: "pfc-far", score: 995000, clear_lamp: "PFC", perfect: 6 }),
    // CLEAR with 3 Misses from FC
    play({ chart_id: "clear-near", score: 800000, clear_lamp: "CLEAR", miss: 3 }),
  ]);
  const byId = new Map(calls.map((c) => [`${c.chart_id}:${c.kind}`, c]));
  assert.equal(byId.get("aaa-lamp:aaa")?.gap, 5000);
  assert.equal(byId.get("aaa-lamp:lamp")?.gap, 0);
  assert.equal(byId.get("aaa-lamp:lamp")?.next_lamp, "GFC");
  assert.equal(byId.get("lamp-only:lamp")?.gap, 2);
  assert.equal(byId.get("lamp-only:lamp")?.next_lamp, "PFC");
  assert.equal(byId.has("lamp-only:aaa"), false);
  assert.equal(byId.has("aaa-done:aaa"), false);
  assert.equal(byId.has("aaa-done:lamp"), false);
  assert.equal(byId.get("clear-near:lamp")?.gap, 3);
  assert.equal(byId.has("failed:lamp"), false);
  assert.equal(byId.has("pfc-far:lamp"), false);
  // Lamp close calls sort before AAA close calls, each by gap ascending.
  assert.deepEqual(calls.map((c) => `${c.chart_id}:${c.kind}`), [
    "aaa-lamp:lamp", "lamp-only:lamp", "clear-near:lamp", "aaa-lamp:aaa",
  ]);
});

test("resolveModelList orders models and honors GEMINI_MODELS override", async () => {
  const { resolveModelList } = await import("../src/gemini");
  assert.deepEqual(resolveModelList({ GEMINI_API_KEY: "x" }), ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"]);
  assert.deepEqual(
    resolveModelList({ GEMINI_API_KEY: "x", GEMINI_MODEL: "gemini-2.5-flash" }),
    ["gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"],
  );
  // Explicit override replaces the whole list (deduped, order kept).
  assert.deepEqual(
    resolveModelList({ GEMINI_API_KEY: "x", GEMINI_MODELS: "gemini-2.5-flash, gemini-3.5-flash-lite, gemini-2.5-flash" }),
    ["gemini-2.5-flash", "gemini-3.5-flash-lite"],
  );
  assert.deepEqual(resolveModelList({ GEMINI_API_KEY: "x", GEMINI_MODELS: "  " }), ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"]);
});

test("computeStats: monthly and per-level EX rates use only charts with max_ex", async () => {
  const { computeStats } = await import("../src/lib");
  const jst = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h) - 9 * 3600 * 1000;
  const master = [
    { chart_id: "c1", play_style: "SP", level: 15, category: "GOLD" as const, max_ex: 3000 },
    { chart_id: "c2", play_style: "SP", level: 15, category: "GOLD" as const, max_ex: 2000 },
    { chart_id: "c3", play_style: "SP", level: 18, category: "CLASSIC" as const, max_ex: null }, // no notecounts: excluded
  ];
  const plays = [
    { chart_id: "c1", score: 900000, ex_score: 2700, rank: "AA", clear_lamp: "FC", played_at: jst(2026, 11, 2) }, // 90%
    { chart_id: "c1", score: 950000, ex_score: 2850, rank: "AAA", clear_lamp: "PFC", played_at: jst(2026, 11, 3) }, // 95%
    { chart_id: "c2", score: 800000, ex_score: 1600, rank: "A", clear_lamp: "CLEAR", played_at: jst(2026, 11, 3) }, // 80%
    { chart_id: "c3", score: 700000, ex_score: 1500, rank: "B", clear_lamp: "CLEAR", played_at: jst(2026, 11, 3) }, // no max_ex: excluded
    { chart_id: "c1", score: 990000, ex_score: 2970, rank: "AAA", clear_lamp: "PFC", played_at: jst(2026, 10, 5) }, // 99%, October
    { chart_id: null, score: 500000, ex_score: 1000, rank: null, clear_lamp: null, played_at: jst(2026, 11, 4) }, // unlinked: excluded
  ];
  const s = computeStats(master, plays, jst(2026, 11, 25));
  const nov = s.monthly.find((m) => m.month === "2026-11")!;
  // Monthly: every qualifying play counts -> (90+95+80)/3 = 88.3
  assert.equal(nov.avg_ex_rate, 88.3);
  const oct = s.monthly.find((m) => m.month === "2026-10")!;
  assert.equal(oct.avg_ex_rate, 99);
  const sep = s.monthly.find((m) => m.month === "2026-09")!;
  assert.equal(sep.avg_ex_rate, null);
  // Per level: each chart contributes its BEST ex rate once: c1 99%, c2 80% -> (99+80)/2 = 89.5
  const sp15 = s.ex_rate_by_level.find((r) => r.play_style === "SP" && r.level === 15)!;
  assert.equal(sp15.avg_ex_rate, 89.5);
  assert.equal(sp15.charts, 2);
  assert.equal(s.ex_rate_by_level.find((r) => r.level === 18), undefined);
  // Calendar: 2026-11-02: 1, 11-03: 3 (c1, c2, c3), 11-04: 1, 10-05: 1
  assert.deepEqual(s.calendar, [
    { date: "2026-10-05", plays: 1 },
    { date: "2026-11-02", plays: 1 },
    { date: "2026-11-03", plays: 3 },
    { date: "2026-11-04", plays: 1 },
  ]);
  // Calendar window is the last 365 days: an older play is dropped.
  const old = computeStats(master, [
    { chart_id: "c1", score: 1, ex_score: null, rank: null, clear_lamp: null, played_at: jst(2025, 11, 24) },
  ], jst(2026, 11, 25));
  assert.deepEqual(old.calendar, []);
});

test("computeVersus aggregates opponents from raw_extraction (Phase 0 versus ground truth)", async () => {
  const { computeVersus } = await import("../src/lib");
  const gtDir = join(here, "fixtures", "ground_truth");
  const versus = readdirSync(gtDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(gtDir, f), "utf-8")) as Extraction)
    .filter((g) => g.is_versus);
  assert.equal(versus.length, 2);
  const T0 = Date.parse("2026-08-25T07:17:00+09:00");
  const rows = versus.map((g, i) => ({
    id: `v${i}`,
    song_title: g.song_title,
    raw_extraction: JSON.stringify(g),
    played_at: T0 + i * 600000,
  }));
  // Plus edge cases: solo (not versus), corrupt JSON, unknown names, null scores.
  rows.push(
    { id: "solo", song_title: "Solo", raw_extraction: JSON.stringify({ is_versus: false, player_1: { dancer_name: "4TUNA", score: 1 }, player_2: null }), played_at: T0 + 1000000 },
    { id: "corrupt", song_title: "Bad", raw_extraction: "{not json", played_at: T0 + 2000000 },
    { id: "unknown", song_title: "Strangers", raw_extraction: JSON.stringify({ is_versus: true, player_1: { dancer_name: "AAA", score: 5 }, player_2: { dancer_name: "BBB", score: 4 } }), played_at: T0 + 3000000 },
    { id: "noscore", song_title: "NoScore", raw_extraction: JSON.stringify({ is_versus: true, player_1: { dancer_name: "4TUNA", score: null }, player_2: { dancer_name: "CORGI", score: 900000 } }), played_at: T0 + 4000000 },
  );
  const v = computeVersus(rows, "4TUNA");
  // Pierce The Sky: 4TUNA 994610 vs CORGI 994680 -> loss; HORIZON BEATZ: 995260 vs 995250 -> win
  assert.equal(v.opponents.length, 1);
  assert.deepEqual(v.opponents[0], {
    name: "CORGI", plays: 3, wins: 1, losses: 1, draws: 0, last_played_at: T0 + 4000000,
  });
  assert.equal(v.recent.length, 3);
  assert.equal(v.recent[0].result, "unknown"); // null score
  assert.equal(v.recent[1].song_title, "HORIZON BEATZ");
  assert.equal(v.recent[1].result, "win");
  assert.equal(v.recent[1].my_score, 995260);
  assert.equal(v.recent[1].opp_score, 995250);
  assert.equal(v.recent[2].song_title, "Pierce The Sky");
  assert.equal(v.recent[2].result, "loss");
  // Player_2 as self: swapped names still resolve.
  const swapped = computeVersus(rows.slice(0, 2).map((r) => {
    const g = JSON.parse(r.raw_extraction!) as Extraction;
    return { ...r, raw_extraction: JSON.stringify({ ...g, player_1: g.player_2, player_2: g.player_1 }) };
  }), "4TUNA");
  assert.equal(swapped.opponents[0].wins, 1);
  assert.equal(swapped.opponents[0].losses, 1);
  // No MY_DANCER_NAME configured: nothing can be attributed.
  assert.deepEqual(computeVersus(rows, null), { opponents: [], recent: [] });
});

test("hammingDistanceHex and findPhashCandidates rank by distance", async () => {
  const { hammingDistanceHex, findPhashCandidates, isValidPhash64 } = await import("../src/lib");
  assert.equal(hammingDistanceHex("0000000000000000", "0000000000000000"), 0);
  assert.equal(hammingDistanceHex("ffffffffffffffff", "0000000000000000"), 64);
  assert.equal(hammingDistanceHex("9af667693a15209e", "9af667693a15209e"), 0);
  assert.equal(hammingDistanceHex("9af667693a15209e", "9af667693a15209f"), 1);
  assert.equal(isValidPhash64("9af667693a15209e"), true);
  assert.equal(isValidPhash64("9AF667693A15209E"), true);
  assert.equal(isValidPhash64("xyz"), false);
  assert.equal(isValidPhash64("9af667693a15209"), false); // 15 chars
  assert.equal(isValidPhash64(null), false);

  const songs = [
    { song_id: "a", phash_8: "0000000000000000" },
    { song_id: "b", phash_8: "0000000000000001" },
    { song_id: "c", phash_8: "ffffffffffffffff" },
    { song_id: "d", phash_8: null },
  ];
  // Query 1 bit from "a", 2 bits from "b": closest first, null-phash skipped.
  assert.deepEqual(
    findPhashCandidates("0000000000000003", songs, 5, 20).map((c) => [c.song.song_id, c.distance]),
    [["b", 1], ["a", 2]],
  );
  // maxDistance filters; limit caps.
  assert.deepEqual(findPhashCandidates("0000000000000003", songs, 5, 1).map((c) => c.song.song_id), ["b"]);
  assert.deepEqual(findPhashCandidates("0000000000000003", songs, 1, 20).map((c) => c.song.song_id), ["b"]);
  assert.deepEqual(findPhashCandidates("not-a-phash", songs), []);
  // The real Phase 0 Pierce The Sky photo hash (variant A) vs the fixture
  // songs: the correct song is at distance 24, i.e. outside the default
  // maxDistance of 20 — this is the documented accuracy limitation.
  const masterV2Local = JSON.parse(readFileSync(masterPath, "utf-8")) as Array<Record<string, any>>;
  const fixtureSongs = masterV2Local.map((s) => ({ song_id: String(s.id), phash_8: (s.phash_8 as string | null) ?? null }));
  const pierce = fixtureSongs.find((s) => s.song_id === "DD6olq00PD91odbO9QbldDb0bQ18oqo1")!;
  assert.equal(hammingDistanceHex("9af667693a15209e", pierce.phash_8!), 24);
  assert.equal(findPhashCandidates("9af667693a15209e", fixtureSongs, 5, 20).length, 0);
  assert.equal(findPhashCandidates("9af667693a15209e", fixtureSongs, 5, 24)[0]?.song.song_id, pierce.song_id);
});
