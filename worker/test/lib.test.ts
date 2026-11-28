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
  evaluateScore,
  exCheck,
  expandMaster,
  expandMasterSong,
  judgeSumCheck,
  judgeSumDeficitToLearn,
  correctOkValue,
  impliedMasterNotes,
  applyCorrections,
  findRedundantCorrections,
  isDetailResult,
  normalizeTitle,
  computeReviewReasons,
  computeStats,
  rankTitleCandidates,
  bestTitleMatch,
  validateScorePatch,
  extractDdrBpm,
  bpmSortValue,
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

test("expandMasterSong maps the jacket flag (boolean -> 1/0, absent -> null)", () => {
  const base = { ...masterV2[0] };
  assert.equal(expandMasterSong({ ...base, jacket: true }).song.has_jacket, 1);
  assert.equal(expandMasterSong({ ...base, jacket: false }).song.has_jacket, 0);
  assert.equal(expandMasterSong(base).song.has_jacket, null);
});

test("v2 expansion computes max_ex from notecounts", () => {
  const { charts: v2Charts } = expandMasterSong(masterV2[0]);
  const spBeginner = v2Charts.find((c) => c.play_style === "SP" && c.difficulty === "BEGINNER");
  assert.ok(spBeginner);
  const nc = masterV2[0].notecounts.sp_beginner;
  assert.equal(spBeginner.notes, nc.notes);
  assert.equal(spBeginner.max_ex, (nc.notes + nc.freeze) * 3);
});

test("v2 expansion and judgeSumCheck handle shock-arrow charts (notes excludes shock)", () => {
  const { charts } = expandMasterSong({
    id: "override_esp",
    title: "オーバーライド",
    levels: { sp_expert: 15 },
    notecounts: { sp_expert: { notes: 812, freeze: 29, shock: 2 } },
  });
  assert.equal(charts.length, 1);
  assert.equal(charts[0].notes, 812);
  assert.equal(charts[0].freeze, 29);
  assert.equal(charts[0].shock, 2);
  // max_ex = (notes + freeze + shock) * 3 = (812 + 29 + 2) * 3 = 2529
  assert.equal(charts[0].max_ex, 2529);

  // Tap judgments total 812 (= notes), O.K. = 31 (= freeze + shock), MAX COMBO = 814 (= notes + shock)
  const ev = evaluateScore(
    {
      marvelous: 700,
      perfect: 100,
      great: 10,
      good: 2,
      miss: 0,
      ok: 31,
      max_combo: 814,
      ex_score: (700 + 31) * 3 + 100 * 2 + 10,
      score: 990000,
      level: 15,
    },
    charts[0],
    { songLinked: true, chartLinked: true },
  );
  assert.equal(ev.judge_sum_check, "match");
  assert.equal(ev.ex_check, "match");
  assert.equal(ev.needs_review, false);
  assert.deepEqual(ev.reasons, []);
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
    availability: null, deleted_at: null, has_jacket: null, ...over,
  });
  const chart = (over: Partial<C> = {}): C => ({
    chart_id: "s1-SP-EXPERT", song_id: "s1", play_style: "SP", difficulty: "EXPERT",
    level: 15, notes: 500, freeze: 10, shock: 0, max_ex: 1530, judge_sum_deficit: null, ...over,
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

  // Stale max_ex alone (notecounts unchanged) -> chart written so the
  // stored value heals; a null master max_ex never counts as a change.
  plan = planSync([song()], [chart({ max_ex: 1500 })], [song()], [chart()]);
  assert.equal(plan.chartUpserts.length, 1);
  plan = planSync([song()], [chart({ max_ex: 1500 })], [song()], [chart({ max_ex: null })]);
  assert.equal(plan.chartUpserts.length, 0);

  // Tombstone appearing in the master -> song written.
  plan = planSync([song()], [chart()], [song({ deleted_at: "2026-01-01" })], [chart()]);
  assert.equal(plan.songUpserts.length, 1);

  // Jacket flag arriving/changing in the master -> song written.
  plan = planSync([song({ has_jacket: 0 })], [chart()], [song({ has_jacket: 1 })], [chart()]);
  assert.equal(plan.songUpserts.length, 1);

  // Master without the jacket field (null) never counts as a change.
  plan = planSync([song({ has_jacket: 1 })], [chart()], [song()], [chart()]);
  assert.equal(plan.songUpserts.length, 0);
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
  assert.deepEqual(resolveModelList({ GEMINI_API_KEY: "x" }), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.deepEqual(
    resolveModelList({ GEMINI_API_KEY: "x", GEMINI_MODEL: "gemini-2.5-flash" }),
    ["gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  );
  // Explicit override replaces the whole list (deduped, order kept).
  assert.deepEqual(
    resolveModelList({ GEMINI_API_KEY: "x", GEMINI_MODELS: "gemini-2.5-flash, gemini-3.5-flash-lite, gemini-2.5-flash" }),
    ["gemini-2.5-flash", "gemini-3.5-flash-lite"],
  );
  assert.deepEqual(resolveModelList({ GEMINI_API_KEY: "x", GEMINI_MODELS: "  " }), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
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

const titleSongs = [
  { song_id: "s1", title: "チルノのパーフェクトさんすう学園", title_normalized: normalizeTitle("チルノのパーフェクトさんすう学園") },
  { song_id: "s2", title: "PARANOiA", title_normalized: normalizeTitle("PARANOiA") },
  { song_id: "s3", title: "PARANOiA MAX～DIRTY MIX～", title_normalized: normalizeTitle("PARANOiA MAX～DIRTY MIX～") },
  { song_id: "s4", title: "革命", title_normalized: normalizeTitle("革命") },
  { song_id: "s5", title: "Electronic or Treat!", title_normalized: normalizeTitle("Electronic or Treat!") },
];

test("title matching: trailing artist credit in brackets still auto-matches", () => {
  const m = bestTitleMatch("チルノのパーフェクトさんすう学園【ビートまりお】", titleSongs);
  assert.equal(m?.song_id, "s1");
  assert.ok((m?.score ?? 0) >= 0.99);
});

test("title matching: one dropped character auto-matches a long title", () => {
  const m = bestTitleMatch("チルノのパーフェクトさんすう園", titleSongs);
  assert.equal(m?.song_id, "s1");
});

test("title matching: confusable substitution (U1 read as Li1) surfaces as candidate", () => {
  const cands = rankTitleCandidates("E1ectronic or Treat!", titleSongs);
  assert.equal(cands[0]?.song_id, "s5");
  const exact = bestTitleMatch("Electronic or Treat!", titleSongs);
  assert.equal(exact?.song_id, "s5");
});

test("title matching: series titles are not confused with each other", () => {
  assert.equal(bestTitleMatch("PARANOiA", titleSongs)?.song_id, "s2");
  // A truncated read of the longer title is genuinely ambiguous: it must
  // never auto-link, and both series entries surface as candidates.
  assert.equal(bestTitleMatch("PARANOiA MAX", titleSongs), null);
  const candIds = rankTitleCandidates("PARANOiA MAX", titleSongs).map((cand) => cand.song_id);
  assert.ok(candIds.includes("s2") && candIds.includes("s3"));
});

test("title matching: unknown titles return no confident match", () => {
  assert.equal(bestTitleMatch("Footnotes on BPM", titleSongs), null);
  assert.equal(bestTitleMatch(null, titleSongs), null);
});

test("computeStats: flare distribution uses each chart's best flare rank", () => {
  const master = [
    { chart_id: "a|SP|EXPERT", play_style: "SP", level: 15, max_ex: 3000, category: "GOLD" as const },
    { chart_id: "b|SP|EXPERT", play_style: "SP", level: 16, max_ex: 3000, category: "GOLD" as const },
  ];
  const plays = [
    { chart_id: "a|SP|EXPERT", score: 900000, rank: "AA", clear_lamp: "CLEAR", flare_rank: "III", played_at: 1764000000000 },
    { chart_id: "a|SP|EXPERT", score: 950000, rank: "AA+", clear_lamp: "CLEAR", flare_rank: "EX", played_at: 1764003600000 },
    { chart_id: "b|SP|EXPERT", score: 800000, rank: "A", clear_lamp: "CLEAR", flare_rank: "IX", played_at: 1764007200000 },
    { chart_id: "b|SP|EXPERT", score: 700000, rank: "B", clear_lamp: "FAILED", flare_rank: null, played_at: 1764010800000 },
  ];
  const s = computeStats(master as never, plays as never, 1764014400000);
  assert.equal(s.flare.charts_with_flare, 2);
  assert.deepEqual(s.flare.by_rank, [
    { flare_rank: "EX", charts: 1 },
    { flare_rank: "IX", charts: 1 },
  ]);
});

test("computeStats: flare targets count cleared charts at/above the target rank", () => {
  const master: any[] = [];
  const plays: any[] = [];
  const add = (id: string, level: number, lamp: string, flare: string | null) => {
    master.push({ chart_id: `${id}|SP|EXPERT`, play_style: "SP", level, max_ex: null, category: "GOLD", title: id });
    plays.push({ chart_id: `${id}|SP|EXPERT`, score: 900000, rank: "AA", clear_lamp: lamp, flare_rank: flare, played_at: 1764000000000 });
  };
  add("lv16ex", 16, "CLEAR", "EX");    // 16EX achieved
  add("lv17ex", 17, "CLEAR", "EX");    // 17EX achieved, and 17IX too (EX >= IX)
  add("lv17v8", 17, "CLEAR", "VIII");  // candidate for both 17 targets
  add("lv17norm", 17, "CLEAR", null);  // candidate (cleared without flare)
  add("lv18fail", 18, "FAILED", null); // never cleared: nowhere
  add("lv18ix", 18, "CLEAR", "IX");    // 18IX achieved
  const s = computeStats(master, plays, 1764014400000);
  const t16 = s.flare.targets.find((t) => t.level === 16 && t.min_rank === "EX")!;
  const t17ex = s.flare.targets.find((t) => t.level === 17 && t.min_rank === "EX")!;
  const t17ix = s.flare.targets.find((t) => t.level === 17 && t.min_rank === "IX")!;
  const t18 = s.flare.targets.find((t) => t.level === 18 && t.min_rank === "IX")!;
  assert.equal(t16.achieved_count, 1);
  assert.equal(t17ex.achieved_count, 1);
  assert.equal(t17ix.achieved_count, 1); // the EX clear satisfies IX too
  assert.equal(t17ix.candidate_count, 2); // VIII clear + normal clear, VIII first
  assert.equal(t17ix.candidates[0].best_flare_rank, "VIII");
  assert.equal(t17ix.candidates[1].best_flare_rank, null);
  assert.equal(t18.achieved_count, 1);
  assert.equal(t18.candidate_count, 0); // the FAILED-only chart is not a candidate
  // by_rank is cleared-only now: EX x2, IX x1, VIII x1
  assert.deepEqual(s.flare.by_rank, [
    { flare_rank: "EX", charts: 2 },
    { flare_rank: "IX", charts: 1 },
    { flare_rank: "VIII", charts: 1 },
  ]);
});

test("computeStats: graphs aggregate level x month, judge days and coverage", () => {
  const master: any[] = [
    { chart_id: "a|SP|EXPERT", play_style: "SP", level: 17, max_ex: 3000, category: "GOLD", title: "A" },
    { chart_id: "b|SP|EXPERT", play_style: "SP", level: 17, max_ex: 3000, category: "GOLD", title: "B" },
    { chart_id: "c|SP|CHALLENGE", play_style: "SP", level: 18, max_ex: 3000, category: "GOLD", title: "C" },
    { chart_id: "d|DP|EXPERT", play_style: "DP", level: 16, max_ex: 3000, category: "GOLD", title: "D" },
  ];
  const t0 = 1764000000000; // within the 12-month window of nowMs below
  const plays: any[] = [
    { chart_id: "a|SP|EXPERT", score: 900000, rank: "AA", clear_lamp: "CLEAR", flare_rank: null, played_at: t0, marvelous: 100, perfect: 50, great: 10, good: 0, ok: 5, miss: 2 },
    { chart_id: "a|SP|EXPERT", score: 910000, rank: "AA", clear_lamp: "CLEAR", flare_rank: null, played_at: t0 + 3600000, marvelous: 120, perfect: 40, great: 5, good: 1, ok: 5, miss: 0 },
    { chart_id: "b|SP|EXPERT", score: 500000, rank: "C", clear_lamp: "FAILED", flare_rank: null, played_at: t0 },
    { chart_id: "c|SP|CHALLENGE", score: 950000, rank: "AAA", clear_lamp: "FC", flare_rank: null, played_at: t0 + 86400000, marvelous: 200, perfect: 30, great: 0, good: 0, ok: 8, miss: 0 },
  ];
  const s = computeStats(master, plays, t0 + 2 * 86400000);
  const lm = s.graphs.level_monthly.filter((r) => r.plays > 0);
  assert.equal(lm.find((r) => r.level === 17)?.plays, 3); // a x2 + b x1 in the same month
  assert.equal(lm.find((r) => r.level === 18)?.plays, 1);
  assert.equal(s.graphs.judge_daily.length, 2); // two distinct JST days
  const d0 = s.graphs.judge_daily[0];
  assert.equal(d0.marvelous, 220);
  assert.equal(d0.perfect, 90);
  assert.equal(d0.miss, 2);
  const cov = (style: string, level: number, diff: string) =>
    s.graphs.coverage.find((c) => c.play_style === style && c.level === level && c.difficulty === diff);
  assert.deepEqual(cov("SP", 17, "EXPERT"), { play_style: "SP", level: 17, difficulty: "EXPERT", total: 2, played: 2, cleared: 1 });
  assert.deepEqual(cov("SP", 18, "CHALLENGE"), { play_style: "SP", level: 18, difficulty: "CHALLENGE", total: 1, played: 1, cleared: 1 });
  assert.deepEqual(cov("DP", 16, "EXPERT"), { play_style: "DP", level: 16, difficulty: "EXPERT", total: 1, played: 0, cleared: 0 });
});

test("computeReviewReasons & evaluateScore flag all inconsistency types", async () => {
  const { computeReviewReasons, evaluateScore } = await import("../src/lib");
  const basePlayer = {
    score: 950000,
    level: 16,
    ex_score: 1400,
    marvelous: 400,
    perfect: 100,
    great: 0,
    good: 0,
    ok: 0,
    miss: 0,
  };
  const baseChart = { notes: 500, shock: 0, level: 16, max_ex: 1500 };

  // Clean match -> no reasons
  const clean = evaluateScore(basePlayer, baseChart, { songLinked: true, chartLinked: true });
  assert.equal(clean.needs_review, false);
  assert.deepEqual(clean.reasons, []);

  // Unlinked song
  assert.deepEqual(
    computeReviewReasons(basePlayer, null, { songLinked: false, chartLinked: false }).map((r) => r.code),
    ["unlinked_song"],
  );

  // Difficulty mismatch (song matched, chart missing)
  assert.deepEqual(
    computeReviewReasons(basePlayer, null, { songLinked: true, chartLinked: false }).map((r) => r.code),
    ["difficulty_mismatch"],
  );

  // Level mismatch + EX mismatch + judge sum mismatch + player unresolved
  const multi = evaluateScore(
    { ...basePlayer, level: 15, ex_score: 1390, marvelous: 390 },
    baseChart,
    { songLinked: true, chartLinked: true, playerUnresolved: true },
  );
  assert.equal(multi.needs_review, true);
  assert.deepEqual(
    multi.reasons.map((r) => r.code),
    ["level_mismatch", "ex_mismatch", "judge_sum_mismatch", "player_unresolved"],
  );
  assert.deepEqual(multi.reasons.find((r) => r.code === "level_mismatch")?.detail, {
    extracted_level: 15,
    master_level: 16,
  });
  assert.deepEqual(multi.reasons.find((r) => r.code === "ex_mismatch")?.detail, {
    ex_score: 1390,
    calc_ex: 1370,
    diff: 20,
  });
  assert.deepEqual(multi.reasons.find((r) => r.code === "judge_sum_mismatch")?.detail, {
    judge_sum: 490,
    expected: 500,
  });

  // EX invalid: exceeds max_ex
  const overMax = computeReviewReasons(
    { ...basePlayer, ex_score: 1501, marvelous: 500, perfect: 0 },
    baseChart,
    { songLinked: true, chartLinked: true },
  );
  assert.equal(overMax.some((r) => r.code === "ex_invalid" && r.detail?.reason === "exceeds_max_ex"), true);

  // EX invalid: missing or zero with positive score
  const zeroEx = computeReviewReasons(
    { ...basePlayer, ex_score: 0 },
    baseChart,
    { songLinked: true, chartLinked: true },
  );
  assert.equal(zeroEx.some((r) => r.code === "ex_invalid" && r.detail?.reason === "missing_or_zero"), true);

  // O.K. exceeds freeze + shock
  const shockChart = { notes: 709, freeze: 163, shock: 146, level: 17, max_ex: 3054 };
  const overOk = computeReviewReasons(
    {
      ...basePlayer,
      level: 17,
      marvelous: 709,
      perfect: 0,
      ok: 310,
      ex_score: (709 + 310) * 3,
      max_combo: 855,
    },
    shockChart,
    { songLinked: true, chartLinked: true },
  );
  assert.deepEqual(overOk.find((r) => r.code === "ok_exceeds_max"), {
    code: "ok_exceeds_max",
    detail: { ok: 310, max_ok: 309 },
  });

  // MAX COMBO exceeds chart.notes + shock
  const overCombo = computeReviewReasons(
    {
      ...basePlayer,
      level: 17,
      marvelous: 709,
      perfect: 0,
      ok: 309,
      ex_score: 3054,
      max_combo: 856,
    },
    shockChart,
    { songLinked: true, chartLinked: true },
  );
  assert.deepEqual(overCombo.find((r) => r.code === "max_combo_exceeds_notes"), {
    code: "max_combo_exceeds_notes",
    detail: { max_combo: 856, max_notes: 855 },
  });
});

test("judgeSumCheck: dropped freezes count as Miss (judgeSum = notes + freeze + shock - ok)", () => {
  // 8ISMUTH OVERDRIV3 ESP: notes 649, freeze 96, no shock; one dropped freeze.
  const chart: any = { notes: 649, freeze: 96, shock: null, level: 15, max_ex: 2235 };
  const play: any = { marvelous: 563, perfect: 81, great: 4, good: 0, miss: 2, ok: 95, ex_score: 2140, score: 994310, level: 15 };
  assert.equal(judgeSumCheck(play, chart), "match");
  const ev = evaluateScore(play, chart, { songLinked: true, chartLinked: true });
  assert.equal(ev.needs_review, false);
  assert.deepEqual(ev.reasons, []);

  // Same chart, all freezes held: judge sum must equal notes exactly.
  assert.equal(judgeSumCheck({ ...play, miss: 1, ok: 96 }, chart), "match");
  // One tap judgment missing despite the dropped freeze: still a mismatch,
  // and the reported expectation includes the NG adjustment.
  const short = { ...play, marvelous: 562 };
  assert.equal(judgeSumCheck(short, chart), "check");
  const reasons = computeReviewReasons(short, chart, { songLinked: true, chartLinked: true });
  assert.deepEqual(reasons.find((r) => r.code === "judge_sum_mismatch")?.detail, { judge_sum: 649, expected: 650 });

  // Shock chart: a hit shock adds a Miss, an avoided shock adds an O.K.
  const shockChart: any = { notes: 812, freeze: 29, shock: 2, level: 15, max_ex: 2529 };
  const base: any = { marvelous: 700, perfect: 100, great: 10, good: 2, score: 990000, level: 15 };
  // 1 avoided + 1 hit: ok = 29 + 1, judge sum = 812 + 1 (hit) + 0 dropped freezes
  assert.equal(judgeSumCheck({ ...base, miss: 1, ok: 30 }, shockChart), "match");
  // both avoided, one freeze dropped: ok = 28 + 2, judge sum = 812 + 1
  assert.equal(judgeSumCheck({ ...base, miss: 1, ok: 30 }, shockChart), "match");
  // both hit: ok = 29, judge sum = 812 + 2
  assert.equal(judgeSumCheck({ ...base, miss: 2, ok: 29 }, shockChart), "match");
  // inconsistent combination still flags
  assert.equal(judgeSumCheck({ ...base, miss: 0, ok: 29 }, shockChart), "check");

  // Fallbacks: freeze or ok unknown -> plain notes comparison.
  assert.equal(judgeSumCheck({ ...play, ok: null }, chart), "check"); // 650 != 649 without the identity
  assert.equal(judgeSumCheck(play, { notes: 649, shock: null }), "check");
  assert.equal(judgeSumCheck({ ...play, miss: 1, ok: null }, { notes: 649, shock: null }), "match");
});

test("judgeSumDeficitToLearn: simultaneous freezes are learned once, from a proven play only", () => {
  // Blew My Mind CSP: notes 665, freeze 46, shock 2; one simultaneous
  // freeze pair held (O.K. 46 = 45 events + 1 avoided shock), so the
  // read judge sum is 666 against an expected 667.
  const blewChart: any = { notes: 665, freeze: 46, shock: 2, level: 18, max_ex: 2139 };
  const blewPlay: any = { marvelous: 600, perfect: 60, great: 4, good: 1, miss: 1, ok: 46, ex_score: 2062, score: 990000, level: 18 };
  const blewEv = evaluateScore(blewPlay, blewChart, { songLinked: true, chartLinked: true });
  assert.equal(blewEv.ex_check, "match");
  assert.deepEqual(blewEv.reasons.map((r) => r.code), ["judge_sum_mismatch"]);
  assert.equal(judgeSumDeficitToLearn(blewPlay, blewChart, blewEv), 1);
  // With the learned deficit the same play passes cleanly.
  const learned = { ...blewChart, judge_sum_deficit: 1 };
  assert.equal(judgeSumCheck(blewPlay, learned), "match");
  assert.deepEqual(evaluateScore(blewPlay, learned, { songLinked: true, chartLinked: true }).reasons, []);
  // And a different shortfall on the learned chart still flags (P is fixed).
  assert.equal(judgeSumCheck({ ...blewPlay, marvelous: 599 }, learned), "check");
  // Nothing is learned twice: a known deficit never re-learns.
  assert.equal(judgeSumDeficitToLearn(blewPlay, learned, blewEv), null);

  // 1116 CSP with the live-master freeze count (14, not 13): the same
  // read (sum 631, ok 83) teaches P = 2, not 1 — learning follows the
  // stored chart row instead of a guessed seed.
  const c1116: any = { notes: 631, freeze: 14, shock: 71, level: 18, max_ex: 2148 };
  const p1116: any = { marvelous: 550, perfect: 70, great: 8, good: 2, miss: 1, ok: 83, ex_score: 2047, score: 990000, level: 18 };
  const ev1116 = evaluateScore(p1116, c1116, { songLinked: true, chartLinked: true });
  assert.equal(ev1116.ex_check, "match");
  assert.equal(judgeSumDeficitToLearn(p1116, c1116, ev1116), 2);

  // Guards: a surplus can never come from simultaneous freezes.
  const snowChart: any = { notes: 593, freeze: 6, shock: 0, level: 15, max_ex: 1797 };
  const snowPlay: any = { marvelous: 500, perfect: 80, great: 10, good: 3, miss: 2, ok: 6, ex_score: 1688, score: 990000, level: 15 };
  const snowEv = evaluateScore(snowPlay, snowChart, { songLinked: true, chartLinked: true });
  assert.equal(snowEv.ex_check, "match");
  assert.equal(judgeSumDeficitToLearn(snowPlay, snowChart, snowEv), null);
  // EX mismatch: the judgments are not proven consistent, so no learning.
  const badEx = evaluateScore({ ...blewPlay, ex_score: 2000 }, blewChart, { songLinked: true, chartLinked: true });
  assert.equal(judgeSumDeficitToLearn({ ...blewPlay, ex_score: 2000 }, blewChart, badEx), null);
  // Another reason present (level mismatch): no learning.
  const badLevel = evaluateScore({ ...blewPlay, level: 17 }, blewChart, { songLinked: true, chartLinked: true });
  assert.equal(badLevel.reasons.length, 2);
  assert.equal(judgeSumDeficitToLearn({ ...blewPlay, level: 17 }, blewChart, badLevel), null);
  // Identity not applicable (ok unknown): no learning.
  const noOk = evaluateScore({ ...blewPlay, ok: null }, blewChart, { songLinked: true, chartLinked: true });
  assert.equal(judgeSumDeficitToLearn({ ...blewPlay, ok: null }, blewChart, noOk), null);
});

test("correctOkValue: O.K. correction still proves on a chart with a learned deficit", () => {
  // Blew My Mind CSP with a learned P = 1; the true ok (46) read as 460.
  const chart: any = { notes: 665, freeze: 46, shock: 2, level: 18, max_ex: 2139, judge_sum_deficit: 1 };
  const play: any = { marvelous: 600, perfect: 60, great: 4, good: 1, miss: 1, ok: 460, ex_score: 2062, score: 990000, level: 18 };
  assert.deepEqual(correctOkValue(play, chart), { ok: 46, corrected: true });
  // The correct read already proves against the deficit-aware identity.
  assert.deepEqual(correctOkValue({ ...play, ok: 46 }, chart), { ok: 46, corrected: false });
});

test("correctOkValue: repairs the O.K. trailing-digit misread only when proven", () => {
  // 8ISMUTH OVERDRIV3 ESP (notes 649, freeze 96): true ok 95 read as 950.
  const chart: any = { notes: 649, freeze: 96, shock: null, level: 15, max_ex: 2235 };
  const play: any = { marvelous: 563, perfect: 81, great: 4, good: 0, miss: 2, ok: 950, ex_score: 2140, score: 994310, level: 15 };
  assert.deepEqual(correctOkValue(play, chart), { ok: 95, corrected: true });
  const ev = evaluateScore({ ...play, ok: 95 }, chart, { songLinked: true, chartLinked: true });
  assert.equal(ev.needs_review, false);

  // Already-consistent value is never touched.
  assert.deepEqual(correctOkValue({ ...play, ok: 95 }, chart), { ok: 95, corrected: false });
  // Candidate that fails the EX cross-check is not accepted.
  assert.deepEqual(correctOkValue({ ...play, ex_score: 2000 }, chart), { ok: 950, corrected: false });
  // Candidate that fails the judge-sum identity is not accepted.
  assert.deepEqual(correctOkValue({ ...play, marvelous: 560 }, chart), { ok: 950, corrected: false });
  // No EX read -> cannot prove -> untouched. No chart / single digit -> untouched.
  assert.deepEqual(correctOkValue({ ...play, ex_score: null }, chart), { ok: 950, corrected: false });
  assert.deepEqual(correctOkValue(play, null), { ok: 950, corrected: false });
  assert.deepEqual(correctOkValue({ ...play, ok: 9 }, chart), { ok: 9, corrected: false });

  // Shock chart (Another Phase CSP 542/6/41): true ok 47 read as 470.
  const apChart: any = { notes: 542, freeze: 6, shock: 41, level: 16, max_ex: 1767 };
  const apPlay: any = { marvelous: 451, perfect: 86, great: 5, good: 0, miss: 0, ok: 470, ex_score: 1671, score: 995690, level: 16 };
  assert.deepEqual(correctOkValue(apPlay, apChart), { ok: 47, corrected: true });

  // Two bled digits (true ok 8, read 812): the /100 candidate proves out.
  const small: any = { notes: 100, freeze: 8, shock: 0, level: 10, max_ex: 324 };
  const smallPlay: any = { marvelous: 90, perfect: 10, great: 0, good: 0, miss: 0, ok: 812, ex_score: (90 + 8) * 3 + 10 * 2, score: 990000, level: 10 };
  assert.deepEqual(correctOkValue(smallPlay, small), { ok: 8, corrected: true });
});

test("isDetailResult: consistent data overrides the tab; absence signature is the fallback", () => {
  const full: any = { marvelous: 100, perfect: 20, great: 1, good: 0, miss: 0, ok: 5, ex_score: 500, max_combo: 121 };
  const empty: any = { marvelous: null, perfect: null, great: null, good: null, miss: null, ok: null, ex_score: null, max_combo: null };
  assert.equal(isDetailResult({ result_tab: "DETAIL" }, empty), true);
  // `full` is complete but NOT self-consistent (EX should be 356, not 500),
  // so the reported tab still decides.
  assert.equal(isDetailResult({ result_tab: "GRAPH" }, full), false);
  assert.equal(isDetailResult({ result_tab: "FLARE" }, full), false);
  assert.equal(isDetailResult({ result_tab: "OTHER" }, full), false);
  // A complete AND self-consistent read can only come from the detail tab:
  // it overrides a misreported tab label.
  const consistent: any = { marvelous: 100, perfect: 20, great: 1, good: 0, miss: 0, ok: 5, ex_score: 356, max_combo: 121 };
  assert.equal(isDetailResult({ result_tab: "GRAPH" }, consistent, null), true);
  assert.equal(isDetailResult({ result_tab: "GRAPH" }, consistent, { notes: 121, freeze: 5, shock: 0 }), true);
  // ...unless the linked chart's judge-sum identity rejects the read.
  assert.equal(isDetailResult({ result_tab: "GRAPH" }, consistent, { notes: 122, freeze: 5, shock: 0 }), false);
  // No tab reported: full read -> detail; hollow read -> not detail.
  assert.equal(isDetailResult({ result_tab: null }, full), true);
  assert.equal(isDetailResult({}, empty), false);
  // Partial read (EX + combo present, some judgments missing) still counts
  // as a detail screen and goes through the normal review flow.
  assert.equal(isDetailResult({}, { ...empty, ex_score: 500, max_combo: 121, marvelous: 100 }), true);
});

test("impliedMasterNotes: a surplus play proves the master notes value", () => {
  // Snow Garland Fairy ESP: master says 593/6/0, but the game's MAX
  // COMBO is 595 and a verified play's judge sum is 595 with ok = 6
  // (all freezes held, no shocks): 595 - 6 - 0 + 6 + 0 = 595.
  const chart: any = { notes: 593, freeze: 6, shock: 0, level: 17, max_ex: 1797, judge_sum_deficit: null };
  const play: any = { marvelous: 545, perfect: 40, great: 8, good: 1, miss: 1, ok: 6, ex_score: 1741, score: 978350, level: 17, max_combo: null };
  assert.equal(impliedMasterNotes(play, chart), 595);

  // The reason detail carries implied_notes for the surplus case only.
  const ev = evaluateScore(play, chart, { songLinked: true, chartLinked: true });
  assert.equal(ev.ex_check, "match");
  assert.deepEqual(ev.reasons.map((r) => r.code), ["judge_sum_mismatch"]);
  assert.deepEqual(ev.reasons[0].detail, { judge_sum: 595, expected: 593, implied_notes: 595 });

  // A shortfall (Blew My Mind: freeze pairs) yields a value BELOW the
  // master notes, and the detail offers nothing — pairs explain it.
  const blewChart: any = { notes: 665, freeze: 46, shock: 2, level: 18, max_ex: 2139, judge_sum_deficit: null };
  const blewPlay: any = { marvelous: 600, perfect: 50, great: 10, good: 3, miss: 3, ok: 46, ex_score: 2014, score: 923710, level: 18, max_combo: null };
  assert.equal(impliedMasterNotes(blewPlay, blewChart), 664);
  const blewEv = evaluateScore(blewPlay, blewChart, { songLinked: true, chartLinked: true });
  assert.deepEqual(blewEv.reasons.find((r) => r.code === "judge_sum_mismatch")?.detail, {
    judge_sum: 666,
    expected: 667,
  });

  // A learned deficit P is part of the identity: implied accounts for it.
  const learnedChart: any = { ...chart, judge_sum_deficit: 2 };
  assert.equal(impliedMasterNotes(play, learnedChart), 597);

  // Identity not applicable: no freeze count / no ok read.
  assert.equal(impliedMasterNotes(play, { ...chart, freeze: null }), null);
  assert.equal(impliedMasterNotes({ ...play, ok: null }, chart), null);
  assert.equal(impliedMasterNotes(play, null), null);
});

test("applyCorrections: sync writes master + corrections, never the plain master", () => {
  const master: any[] = [
    { chart_id: "snow|SP|EXPERT", song_id: "snow", play_style: "SP", difficulty: "EXPERT", level: 17, notes: 593, freeze: 6, shock: 0, max_ex: 1797, judge_sum_deficit: null },
    { chart_id: "other|SP|EXPERT", song_id: "other", play_style: "SP", difficulty: "EXPERT", level: 16, notes: 500, freeze: 10, shock: 0, max_ex: 1530, judge_sum_deficit: null },
  ];
  // No corrections: the master passes through untouched.
  assert.deepEqual(applyCorrections(master, []), master);

  const corrected = applyCorrections(master, [{ chart_id: "snow|SP|EXPERT", notes: 595, freeze: null, shock: null }]);
  // notes overridden, max_ex recomputed with the expandMaster rule.
  assert.equal(corrected[0].notes, 595);
  assert.equal(corrected[0].freeze, 6);
  assert.equal(corrected[0].max_ex, 1803);
  // Unmatched charts are untouched.
  assert.deepEqual(corrected[1], master[1]);

  // A freeze-only override recomputes max_ex from the effective counts.
  const fz = applyCorrections(master, [{ chart_id: "other|SP|EXPERT", notes: null, freeze: 12, shock: null }]);
  assert.equal(fz[1].notes, 500);
  assert.equal(fz[1].freeze, 12);
  assert.equal(fz[1].max_ex, 1536);

  // An all-null correction row changes nothing.
  const noop = applyCorrections(master, [{ chart_id: "snow|SP|EXPERT", notes: null, freeze: null, shock: null }]);
  assert.deepEqual(noop, master);
});

test("findRedundantCorrections: only corrections the master has fully caught up with", () => {
  const master: any[] = [
    { chart_id: "a|SP|EXPERT", notes: 595, freeze: 6, shock: 0 },
    { chart_id: "b|SP|EXPERT", notes: 500, freeze: 10, shock: 0 },
    { chart_id: "c|SP|EXPERT", notes: null, freeze: null, shock: null },
  ];
  // Master caught up on every named field -> redundant.
  assert.deepEqual(
    findRedundantCorrections(master, [{ chart_id: "a|SP|EXPERT", notes: 595, freeze: null, shock: null }]),
    ["a|SP|EXPERT"],
  );
  // One field still differs -> load-bearing, not redundant.
  assert.deepEqual(
    findRedundantCorrections(master, [{ chart_id: "a|SP|EXPERT", notes: 595, freeze: 7, shock: null }]),
    [],
  );
  // Master still behind -> not redundant.
  assert.deepEqual(
    findRedundantCorrections(master, [{ chart_id: "b|SP|EXPERT", notes: 505, freeze: null, shock: null }]),
    [],
  );
  // Master has no counts yet -> not redundant.
  assert.deepEqual(
    findRedundantCorrections(master, [{ chart_id: "c|SP|EXPERT", notes: 100, freeze: null, shock: null }]),
    [],
  );
  // Chart missing from the master -> never flagged.
  assert.deepEqual(
    findRedundantCorrections(master, [{ chart_id: "gone|SP|EXPERT", notes: 1, freeze: null, shock: null }]),
    [],
  );
  assert.deepEqual(findRedundantCorrections(master, []), []);
});

test("validateScorePatch accepts valid partial updates and rejects invalid values", () => {
  assert.equal(validateScorePatch({}), null);
  assert.equal(validateScorePatch({ score: 995000, ex_score: 1800, level: 17, difficulty: "EXPERT" }), null);
  assert.equal(validateScorePatch({ ex_score: null, marvelous: 0, rank: "AAA", clear_lamp: null, review_status: "waiting_master" }), null);
  assert.equal(validateScorePatch({ review_status: null }), null);

  assert.match(validateScorePatch({ score: -1 }) ?? "", /score/);
  assert.match(validateScorePatch({ score: 1000001 }) ?? "", /score/);
  assert.match(validateScorePatch({ score: null }) ?? "", /score/);
  assert.match(validateScorePatch({ score: 99.5 }) ?? "", /score/);
  assert.match(validateScorePatch({ marvelous: -3 }) ?? "", /marvelous/);
  assert.match(validateScorePatch({ ok: "8" }) ?? "", /ok/);
  assert.match(validateScorePatch({ level: 21 }) ?? "", /level/);
  assert.match(validateScorePatch({ level: 0 }) ?? "", /level/);
  assert.match(validateScorePatch({ difficulty: "NORMAL" }) ?? "", /difficulty/);
  assert.match(validateScorePatch({ rank: 123 }) ?? "", /rank/);
  assert.match(validateScorePatch({ review_status: "done" }) ?? "", /review_status/);
});

test("extractDdrBpm handles simple, multi-game, per-difficulty, except, and versioned BPM strings", () => {
  assert.equal(extractDdrBpm(null, "EXPERT"), null);
  assert.equal(extractDdrBpm("", "EXPERT"), null);
  assert.equal(extractDdrBpm("140", "EXPERT"), "140");
  assert.equal(extractDdrBpm("100-200", "EXPERT"), "100-200");
  assert.equal(extractDdrBpm("100~200", "EXPERT"), "100-200");

  // Multi-game explicit DDR
  assert.equal(extractDdrBpm("123-135 (beatmania IIDX), 110-135 (DanceDanceRevolution)", "EXPERT"), "110-135");
  assert.equal(extractDdrBpm("82-163 (DanceDanceRevolution), 163 (SOUND VOLTEX)", "CHALLENGE"), "82-163");

  // Catch-all "other BEMANI games" / "all BEMANI games except"
  assert.equal(extractDdrBpm("100 (DANCERUSH), 200 (other BEMANI games)", "EXPERT"), "200");
  assert.equal(extractDdrBpm("110 (all BEMANI games except SOUND VOLTEX), 220 (SOUND VOLTEX)", "EXPERT"), "110");
  assert.equal(extractDdrBpm("116-146 (all games except DanceDanceRevolution), 146 (DanceDanceRevolution)", "EXPERT"), "146");

  // Per-difficulty DDR-only
  const ace = "200 (BEGINNER, BASIC), 100-200 (DIFFICULT), 50-800 (EXPERT), 50-400 (CHALLENGE)";
  assert.equal(extractDdrBpm(ace, "BEGINNER"), "200");
  assert.equal(extractDdrBpm(ace, "BASIC"), "200");
  assert.equal(extractDdrBpm(ace, "DIFFICULT"), "100-200");
  assert.equal(extractDdrBpm(ace, "EXPERT"), "50-800");
  assert.equal(extractDdrBpm(ace, "CHALLENGE"), "50-400");

  // "all ... difficulties except ..." and ranges ("BEGINNER to EXPERT")
  const exceptBeg = "154 (beatmania IIDX, DanceDanceRevolution BEGINNER, DANCERUSH, pop'n music), 150-155 (all DanceDanceRevolution difficulties except BEGINNER)";
  assert.equal(extractDdrBpm(exceptBeg, "BEGINNER"), "154");
  assert.equal(extractDdrBpm(exceptBeg, "EXPERT"), "150-155");

  const rangeDiff = "90-190 (beatmania IIDX, DanceDanceRevolution BEGINNER to EXPERT), 90-360 (DanceDanceRevolution CHALLENGE)";
  assert.equal(extractDdrBpm(rangeDiff, "DIFFICULT"), "90-190");
  assert.equal(extractDdrBpm(rangeDiff, "CHALLENGE"), "90-360");

  // Version hints: Present beats ULTRAMIX4 / HOTTEST PARTY
  assert.equal(
    extractDdrBpm("110 (DanceDanceRevolution A&rarr;Present, GF/DM, REFLEC BEAT, ノスタルジア), 220 (DanceDanceRevolution ULTRAMIX4, pop'n music)", "EXPERT"),
    "110",
  );
  assert.equal(
    extractDdrBpm("90-180 (DanceDanceRevolution / Dancing Stage HOTTEST PARTY), 180 (DanceDanceRevolution A3&rarr;Present)", "EXPERT"),
    "180",
  );

  // Style-specific Double DIFFICULT vs other DanceDanceRevolution charts
  const doubleDiff = "83-148 (beatmania IIDX, other DanceDanceRevolution charts), 148 (DanceDanceRevolution Double DIFFICULT)";
  assert.equal(extractDdrBpm(doubleDiff, "DIFFICULT", "SP"), "83-148");
  assert.equal(extractDdrBpm(doubleDiff, "DIFFICULT", "DP"), "148");
});

test("bpmSortValue extracts numeric upper bound for sorting", () => {
  assert.equal(bpmSortValue("140"), 140);
  assert.equal(bpmSortValue("50-800"), 800);
  assert.equal(bpmSortValue("110-135"), 135);
  assert.equal(bpmSortValue(null), null);
});
