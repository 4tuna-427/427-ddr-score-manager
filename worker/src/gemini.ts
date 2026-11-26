import type { Extraction } from "./lib";

export interface GeminiEnv {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  /** Optional comma-separated override for the whole model priority list. */
  GEMINI_MODELS?: string;
}

/**
 * Default model priority: current primary, then the fallback.
 * gemini-2.5-flash-lite is NOT used: it returns 404 (no longer available
 * to new users) for this project, so it cannot serve as a fallback.
 * gemini-3.1-flash-lite was verified on the Phase 0 photos at 151/152
 * fields (99.3%, same as the primary) and has its own 500/day free quota.
 */
export const DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

/**
 * Thrown when every model in the list ultimately failed with HTTP 429,
 * i.e. the free-tier daily quota is exhausted across all models.
 * Callers (POST /api/analyze) map this to HTTP 429 quota_exhausted so
 * the client can stop instead of retrying forever.
 */
export class GeminiQuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiQuotaExhaustedError";
  }
}

/** A 429 whose body names quota exhaustion is definitely a quota stop. */
export function isQuotaExhaustedBody(bodyText: string): boolean {
  return /RESOURCE_EXHAUSTED/i.test(bodyText) || /quota/i.test(bodyText);
}

/**
 * In-model retry delays. Normal mode backs off generously; bulk mode
 * (bulk=1, mass import of past photos) retries at most once per model
 * so a transient error burst does not burn the daily quota.
 */
export function retryDelaysMs(bulk: boolean): number[] {
  return bulk ? [4000] : [1500, 4000, 9000];
}

export interface ExtractOptions {
  /** Bulk import mode: reduced in-model retries (see retryDelaysMs). */
  bulk?: boolean;
  /** Test hook: replace the retry sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Ordered model list for extraction. GEMINI_MODELS (comma-separated) wins
 * when set; otherwise GEMINI_MODEL comes first, followed by the defaults
 * (deduplicated). Never empty.
 */
export function resolveModelList(env: GeminiEnv): string[] {
  const list: string[] = [];
  const push = (m?: string | null) => {
    const v = (m ?? "").trim();
    if (v && !list.includes(v)) list.push(v);
  };
  if (env.GEMINI_MODELS) {
    for (const m of env.GEMINI_MODELS.split(",")) push(m);
  } else {
    push(env.GEMINI_MODEL);
    for (const m of DEFAULT_GEMINI_MODELS) push(m);
  }
  return list.length ? list : [...DEFAULT_GEMINI_MODELS];
}

/** Transient statuses worth retrying within one model. */
export function isRetryableStatus(status: number): boolean {
  return status === 503 || status === 429;
}

/** Statuses that mean "this model cannot serve the request, try the next". */
export function isModelFallbackStatus(status: number): boolean {
  return status === 404 || status === 503 || status === 429;
}

export const GEMINI_PROMPT = "# Gemini 抽出プロンプト v0.1（Phase 0 検証用）\n\nあなたは DanceDanceRevolution（DDR）のリザルト画面の写真から数値を転記する専門の読み取り器です。推測や補完はせず、画面に実際に表示されているものだけを転記してください。\n\n## 対象範囲\n- 対象は写真中央のメインモニター内に表示されたリザルトUIだけです。\n- モニターの外枠、周囲に映り込む他の筐体の画面、天井照明やその反射は無視してください。\n- 斜め撮影や反射で判読できない項目は、推測せず null にしてください。\n\n## 楽曲情報\n- `song_title`: 画面表示の曲名を一字一句そのまま転記してください（記号・大文字小文字も保持）。\n- `play_style`: SINGLE PLAY なら \"SP\"、DOUBLE PLAY なら \"DP\"。判別できなければ null。\n- `jacket_bbox`: ジャケット画像の位置を、画像全体を 0〜1000 とした [x_min, y_min, x_max, y_max] で返してください。無ければ null。\n\n- `result_tab`: リザルト画面で開いているタブを返すこと。判定内訳・EX SCORE・MAX COMBO が表示される「詳細リザルト」タブなら \"DETAIL\"、「プレーグラフ」タブなら \"GRAPH\"、「フレア」タブなら \"FLARE\"、それ以外は \"OTHER\"、判別できなければ null。詳細リザルト以外のタブでは判定内訳・EX SCORE・MAX COMBO は画面に表示されていないので、グラフ等の数値を推測で入れず、必ず null にすること。\n\n## プレイヤー情報（最重要）\n- 画面左側のプレイヤーを `player_1`、右側を `player_2` に入れてください。あなたが「どちらが撮影者か」を判断する必要はありません。\n- 片側しか表示されていない場合、もう片方は null にしてください。`is_versus` は両側ある場合のみ true。\n- 各プレイヤーについて次を転記してください:\n  - `dancer_name`: ダンサーネーム表示そのまま\n  - `difficulty`: BEGINNER / BASIC / DIFFICULT / EXPERT / CHALLENGE のいずれか（画面の難易度表記に対応）\n  - `level`: 難易度レベル（数値）\n  - `score`: 通常スコア（カンマなし整数、0〜1,000,000）\n  - `ex_score`: EX SCORE\n  - `rank`: AAA / AA+ / AA / AA- / A+ / A / A- / B+ / B / B- / C+ / C / C- / D+ / D / E\n  - `clear_lamp`: MFC / PFC / GFC / FC / LIFE4 / CLEAR / FAILED（フルコンボ等のランプ表記から）\n  - `flare_rank`: スコアランク表示（AAAなど）の右上に表示される六角形のバッジに書かれたローマ数字を読むこと。EX / IX / VIII / VII / VI / V / IV / III / II / I のいずれか。バッジが表示されていない場合は NONE\n  - `flare_skill`: フレアスキル数値（この画面には数値表示が無いため、通常は null）\n  - `max_combo`: MAX COMBO\n  - 判定内訳: `marvelous` / `perfect` / `great` / `good` / `ok` / `miss`\n    - `ok` はフリーズアロー等の OK 判定の合計です。NG は miss 側の表示と混同しないでください。\n  - `fast_count` / `slow_count`: FAST / SLOW の合計表示があればその数値\n\n## 数値の注意\n- 数字の読み取りでは 8/6/9/0、1/7 を特に慎重に確認してください。\n- 桁区切りカンマや先行ゼロは除いて整数で返してください。\n- 表示されていない項目は 0 ではなく null です。\n\n- ダンサーネームは画面上部のプレイヤー情報バナー内の文字列だけを読むこと。画面の端や背景に映り込んだ反射文字は読まないこと。\n";

export const GEMINI_SCHEMA = {
  "type": "OBJECT",
  "properties": {
    "song_title": {
      "type": "STRING",
      "nullable": true
    },
    "play_style": {
      "type": "STRING",
      "nullable": true,
      "enum": [
        "SP",
        "DP"
      ]
    },
    "result_tab": {
      "type": "STRING",
      "nullable": true,
      "enum": [
        "DETAIL",
        "GRAPH",
        "FLARE",
        "OTHER"
      ]
    },
    "is_versus": {
      "type": "BOOLEAN"
    },
    "player_1": {
      "type": "OBJECT",
      "nullable": true,
      "properties": {
        "dancer_name": {
          "type": "STRING",
          "nullable": true
        },
        "difficulty": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "BEGINNER",
            "BASIC",
            "DIFFICULT",
            "EXPERT",
            "CHALLENGE"
          ]
        },
        "level": {
          "type": "INTEGER",
          "nullable": true
        },
        "score": {
          "type": "INTEGER",
          "nullable": true
        },
        "ex_score": {
          "type": "INTEGER",
          "nullable": true
        },
        "rank": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "AAA",
            "AA+",
            "AA",
            "AA-",
            "A+",
            "A",
            "A-",
            "B+",
            "B",
            "B-",
            "C+",
            "C",
            "C-",
            "D+",
            "D",
            "E"
          ]
        },
        "clear_lamp": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "MFC",
            "PFC",
            "GFC",
            "FC",
            "LIFE4",
            "CLEAR",
            "FAILED"
          ]
        },
        "flare_rank": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "EX",
            "IX",
            "VIII",
            "VII",
            "VI",
            "V",
            "IV",
            "III",
            "II",
            "I",
            "NONE"
          ]
        },
        "flare_skill": {
          "type": "INTEGER",
          "nullable": true
        },
        "max_combo": {
          "type": "INTEGER",
          "nullable": true
        },
        "marvelous": {
          "type": "INTEGER",
          "nullable": true
        },
        "perfect": {
          "type": "INTEGER",
          "nullable": true
        },
        "great": {
          "type": "INTEGER",
          "nullable": true
        },
        "good": {
          "type": "INTEGER",
          "nullable": true
        },
        "ok": {
          "type": "INTEGER",
          "nullable": true
        },
        "miss": {
          "type": "INTEGER",
          "nullable": true
        },
        "fast_count": {
          "type": "INTEGER",
          "nullable": true
        },
        "slow_count": {
          "type": "INTEGER",
          "nullable": true
        }
      },
      "required": [
        "dancer_name",
        "difficulty",
        "level",
        "score",
        "ex_score",
        "rank",
        "clear_lamp",
        "flare_rank",
        "flare_skill",
        "max_combo",
        "marvelous",
        "perfect",
        "great",
        "good",
        "ok",
        "miss",
        "fast_count",
        "slow_count"
      ]
    },
    "player_2": {
      "type": "OBJECT",
      "nullable": true,
      "properties": {
        "dancer_name": {
          "type": "STRING",
          "nullable": true
        },
        "difficulty": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "BEGINNER",
            "BASIC",
            "DIFFICULT",
            "EXPERT",
            "CHALLENGE"
          ]
        },
        "level": {
          "type": "INTEGER",
          "nullable": true
        },
        "score": {
          "type": "INTEGER",
          "nullable": true
        },
        "ex_score": {
          "type": "INTEGER",
          "nullable": true
        },
        "rank": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "AAA",
            "AA+",
            "AA",
            "AA-",
            "A+",
            "A",
            "A-",
            "B+",
            "B",
            "B-",
            "C+",
            "C",
            "C-",
            "D+",
            "D",
            "E"
          ]
        },
        "clear_lamp": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "MFC",
            "PFC",
            "GFC",
            "FC",
            "LIFE4",
            "CLEAR",
            "FAILED"
          ]
        },
        "flare_rank": {
          "type": "STRING",
          "nullable": true,
          "enum": [
            "EX",
            "IX",
            "VIII",
            "VII",
            "VI",
            "V",
            "IV",
            "III",
            "II",
            "I",
            "NONE"
          ]
        },
        "flare_skill": {
          "type": "INTEGER",
          "nullable": true
        },
        "max_combo": {
          "type": "INTEGER",
          "nullable": true
        },
        "marvelous": {
          "type": "INTEGER",
          "nullable": true
        },
        "perfect": {
          "type": "INTEGER",
          "nullable": true
        },
        "great": {
          "type": "INTEGER",
          "nullable": true
        },
        "good": {
          "type": "INTEGER",
          "nullable": true
        },
        "ok": {
          "type": "INTEGER",
          "nullable": true
        },
        "miss": {
          "type": "INTEGER",
          "nullable": true
        },
        "fast_count": {
          "type": "INTEGER",
          "nullable": true
        },
        "slow_count": {
          "type": "INTEGER",
          "nullable": true
        }
      },
      "required": [
        "dancer_name",
        "difficulty",
        "level",
        "score",
        "ex_score",
        "rank",
        "clear_lamp",
        "flare_rank",
        "flare_skill",
        "max_combo",
        "marvelous",
        "perfect",
        "great",
        "good",
        "ok",
        "miss",
        "fast_count",
        "slow_count"
      ]
    },
    "jacket_bbox": {
      "type": "ARRAY",
      "nullable": true,
      "items": {
        "type": "INTEGER"
      }
    }
  },
  "required": [
    "song_title",
    "play_style",
    "result_tab",
    "is_versus",
    "player_1",
    "player_2",
    "jacket_bbox"
  ]
};

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Send one result-screen image to Gemini with Structured Outputs
 * and return the parsed extraction.
 *
 * Models are tried in priority order (see resolveModelList). Within one
 * model, transient 503/429 errors are retried with backoff; when a model
 * is exhausted (404 = model unavailable, or retries used up on 503/429),
 * the next model is tried. Other errors (400/401/403/...) fail fast.
 */
export async function extractFromImage(
  env: GeminiEnv,
  image: Blob,
  opts: ExtractOptions = {},
): Promise<Extraction> {
  const models = resolveModelList(env);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const buf = new Uint8Array(await image.arrayBuffer());
  const body = {
    contents: [
      {
        parts: [
          { text: GEMINI_PROMPT },
          { inline_data: { mime_type: image.type || "image/jpeg", data: bytesToBase64(buf) } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_SCHEMA,
      temperature: 0,
    },
  };
  // The free tier (especially flash-lite) returns transient 503
  // "high demand" errors in bursts. Retry those (and 429) with backoff
  // inside the request so the client rarely sees them. Bulk mode uses
  // a single retry per model so transient bursts do not waste quota.
  const RETRY_DELAYS_MS = retryDelaysMs(!!opts.bulk);
  let lastError: Error | null = null;
  // Quota tracking: record each model's final outcome. The daily free
  // quota counts as exhausted when every tried model ended in 429, or
  // when the only non-429 outcomes are 404 (model unavailable) and at
  // least one model returned a 429 whose body names RESOURCE_EXHAUSTED
  // / quota (which makes the quota stop certain for that model).
  const outcomes: string[] = [];
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    let res: Response | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (attempt === RETRY_DELAYS_MS.length) {
          lastError = e instanceof Error ? e : new Error(String(e));
          res = null;
          break;
        }
        res = null;
      }
      if (res && res.ok) break;
      if (res && !isRetryableStatus(res.status)) break;
      if (attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
    if (res && res.ok) {
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini API returned no content");
      return JSON.parse(text) as Extraction;
    }
    if (res) {
      const text = await res.text();
      lastError = new Error(`Gemini API error ${res.status} (model ${model}): ${text.slice(0, 500)}`);
      outcomes.push(res.status === 429 && isQuotaExhaustedBody(text) ? "429-quota" : String(res.status));
      // Only fall through to the next model for 404/503/429; anything
      // else (bad key, bad request, ...) would fail the same way there.
      if (!isModelFallbackStatus(res.status)) throw lastError;
    } else {
      outcomes.push("network");
    }
    // Network failure with no response: also try the next model, since a
    // per-model endpoint problem is possible (and cheap to rule out).
  }
  const all429 = outcomes.length > 0 && outcomes.every((o) => o === "429" || o === "429-quota");
  const quotaMarkedWithOnly404Else = outcomes.includes("429-quota") &&
    outcomes.every((o) => o === "429-quota" || o === "404");
  if (lastError && (all429 || quotaMarkedWithOnly404Else)) {
    throw new GeminiQuotaExhaustedError(lastError.message);
  }
  throw lastError ?? new Error("Gemini API error: no model responded");
}
