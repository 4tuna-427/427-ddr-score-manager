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
