import { normalizeTitle } from "./title";
import { chartId, type ChartCorrection, type ChartRow, type SongCategory, type SongRow } from "./types";

function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}

/** v2 = levels/notecounts objects; v1 = flat single_*_level / double_*_level fields. */
export function detectMasterFormat(song: Record<string, unknown>): "v1" | "v2" {
  if (song && typeof song === "object") {
    if (song.levels && typeof song.levels === "object") return "v2";
    if (song.notecounts && typeof song.notecounts === "object") return "v2";
    for (const k of Object.keys(song)) {
      if (/^(single|double)_.+_level$/.test(k)) return "v1";
    }
  }
  return "v2";
}

const V2_KEYMAP: Array<[string, string, string]> = [
  ["sp_beginner", "SP", "BEGINNER"],
  ["sp_basic", "SP", "BASIC"],
  ["sp_difficult", "SP", "DIFFICULT"],
  ["sp_expert", "SP", "EXPERT"],
  ["sp_challenge", "SP", "CHALLENGE"],
  ["dp_basic", "DP", "BASIC"],
  ["dp_difficult", "DP", "DIFFICULT"],
  ["dp_expert", "DP", "EXPERT"],
  ["dp_challenge", "DP", "CHALLENGE"],
];

const V1_KEYMAP: Array<[string, string, string]> = [
  ["single_beginner_level", "SP", "BEGINNER"],
  ["single_basic_level", "SP", "BASIC"],
  ["single_difficult_level", "SP", "DIFFICULT"],
  ["single_expert_level", "SP", "EXPERT"],
  ["single_challenge_level", "SP", "CHALLENGE"],
  ["double_beginner_level", "DP", "BEGINNER"],
  ["double_basic_level", "DP", "BASIC"],
  ["double_difficult_level", "DP", "DIFFICULT"],
  ["double_expert_level", "DP", "EXPERT"],
  ["double_challenge_level", "DP", "CHALLENGE"],
];

export function expandMasterSong(raw: Record<string, any>): { song: SongRow; charts: ChartRow[] } {
  const format = detectMasterFormat(raw);
  const songId = String(raw.id);
  const song: SongRow = {
    song_id: songId,
    title: String(raw.title),
    title_normalized: normalizeTitle(String(raw.title)),
    artist: toStr(raw.artist),
    version:
      format === "v2"
        ? toStr(raw.version_current) ?? toStr(raw.version_remy_first_ddr) ?? toStr(raw.version)
        : toStr(raw.version),
    bpm: toStr(raw.bpm),
    phash_8: toStr(raw.phash_8),
    phash_16: toStr(raw.phash_16),
    availability: toStr(raw.availability),
    deleted_at: toStr(raw.deleted_at),
    has_jacket: typeof raw.jacket === "boolean" ? (raw.jacket ? 1 : 0) : null,
  };
  const charts: ChartRow[] = [];
  if (format === "v2") {
    const levels = (raw.levels ?? {}) as Record<string, unknown>;
    const notecounts = (raw.notecounts ?? {}) as Record<string, any>;
    for (const [key, style, diff] of V2_KEYMAP) {
      const level = toInt(levels[key]);
      if (level == null) continue;
      const nc = notecounts[key] ?? {};
      const notes = toInt(nc.notes);
      const freeze = toInt(nc.freeze);
      const shock = toInt(nc.shock);
      const max_ex = notes != null && freeze != null ? (notes + freeze + (shock ?? 0)) * 3 : null;
      charts.push({
        chart_id: chartId(songId, style, diff),
        song_id: songId,
        play_style: style,
        difficulty: diff,
        level,
        notes,
        freeze,
        shock,
        max_ex,
        judge_sum_deficit: null,
      });
    }
  } else {
    for (const [key, style, diff] of V1_KEYMAP) {
      const level = toInt(raw[key]);
      if (level == null) continue;
      charts.push({
        chart_id: chartId(songId, style, diff),
        song_id: songId,
        play_style: style,
        difficulty: diff,
        level,
        notes: null,
        freeze: null,
        shock: null,
        max_ex: null,
        judge_sum_deficit: null,
      });
    }
  }
  return { song, charts };
}

export function expandMaster(rawSongs: Array<Record<string, any>>): { songs: SongRow[]; charts: ChartRow[] } {
  const songs: SongRow[] = [];
  const charts: ChartRow[] = [];
  for (const raw of rawSongs) {
    const { song, charts: cs } = expandMasterSong(raw);
    songs.push(song);
    charts.push(...cs);
  }
  return { songs, charts };
}

/** Diff expanded master against current DB rows so a sync only writes what changed. */
export function planSync(
  existingSongs: SongRow[],
  existingCharts: ChartRow[],
  masterSongs: SongRow[],
  masterCharts: ChartRow[],
): { songUpserts: SongRow[]; chartUpserts: ChartRow[] } {
  const songById = new Map(existingSongs.map((s) => [s.song_id, s]));
  const songUpserts = masterSongs.filter((m) => {
    const e = songById.get(m.song_id);
    if (!e) return true;
    return (
      e.title !== m.title ||
      e.title_normalized !== m.title_normalized ||
      e.artist !== m.artist ||
      e.version !== m.version ||
      e.bpm !== m.bpm ||
      e.availability !== m.availability ||
      e.deleted_at !== m.deleted_at ||
      (m.phash_8 != null && e.phash_8 !== m.phash_8) ||
      (m.phash_16 != null && e.phash_16 !== m.phash_16) ||
      (m.has_jacket != null && e.has_jacket !== m.has_jacket)
    );
  });
  const chartById = new Map(existingCharts.map((ch) => [ch.chart_id, ch]));
  const chartUpserts = masterCharts.filter((m) => {
    const e = chartById.get(m.chart_id);
    if (!e) return true;
    if (e.level !== m.level) return true;
    if (m.notes != null && (e.notes !== m.notes || e.freeze !== m.freeze || e.shock !== m.shock)) return true;
    if (m.max_ex != null && e.max_ex !== m.max_ex) return true;
    return false;
  });
  return { songUpserts, chartUpserts };
}

/** Overlay user-registered master corrections onto expanded master charts. */
export function applyCorrections(charts: ChartRow[], corrections: ChartCorrection[]): ChartRow[] {
  if (corrections.length === 0) return charts;
  const byId = new Map(corrections.map((k) => [k.chart_id, k]));
  return charts.map((ch) => {
    const k = byId.get(ch.chart_id);
    if (!k || (k.notes == null && k.freeze == null && k.shock == null)) return ch;
    const notes = k.notes ?? ch.notes;
    const freeze = k.freeze ?? ch.freeze;
    const shock = k.shock ?? ch.shock;
    const max_ex = notes != null && freeze != null ? (notes + freeze + (shock ?? 0)) * 3 : ch.max_ex;
    return { ...ch, notes, freeze, shock, max_ex };
  });
}

/** Chart ids whose correction the delivered master has caught up with. */
export function findRedundantCorrections(masterCharts: ChartRow[], corrections: ChartCorrection[]): string[] {
  if (corrections.length === 0) return [];
  const byId = new Map(masterCharts.map((ch) => [ch.chart_id, ch]));
  const out: string[] = [];
  for (const k of corrections) {
    const m = byId.get(k.chart_id);
    if (!m) continue;
    const fields = ["notes", "freeze", "shock"] as const;
    if (fields.every((f) => k[f] == null || m[f] === k[f])) out.push(k.chart_id);
  }
  return out;
}

const CATEGORY_BY_VERSION = new Map<string, SongCategory>([
  ...["1ST", "2ND", "3RD", "4TH", "5TH", "MAX", "DDRMAX", "MAX2", "DDRMAX2",
    "EXTREME", "SUPERNOVA", "SUPERNOVA2", "X", "X2", "X3", "X3 VS 2ND", "X3 VS 2NDMIX"]
    .map((v) => [v, "CLASSIC"] as [string, SongCategory]),
  ...["2013", "2014", "A"].map((v) => [v, "WHITE"] as [string, SongCategory]),
  ...["A20", "A20 PLUS", "A3", "WORLD"].map((v) => [v, "GOLD"] as [string, SongCategory]),
]);

export function songCategory(version: string | null | undefined): SongCategory | null {
  if (!version) return null;
  return CATEGORY_BY_VERSION.get(version.trim().toUpperCase()) ?? null;
}

export const CATEGORY_VERSION_SPELLINGS: Record<SongCategory, string[]> = {
  CLASSIC: ["1st", "2nd", "3rd", "4th", "5th", "MAX", "DDRMAX", "MAX2", "DDRMAX2",
    "Extreme", "EXTREME", "SuperNOVA", "SuperNOVA2", "X", "X2", "X3", "X3 vs 2nd"],
  WHITE: ["2013", "2014", "A"],
  GOLD: ["A20", "A20 PLUS", "A3", "WORLD"],
};
