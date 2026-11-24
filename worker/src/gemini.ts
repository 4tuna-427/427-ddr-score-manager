import type { Extraction } from "./lib";

export interface GeminiEnv {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
}

export const GEMINI_PROMPT = "# Gemini 抽出プロンプト v0.1（Phase 0 検証用）\n\nあなたは DanceDanceRevolution（DDR）のリザルト画面の写真から数値を転記する専門の読み取り器です。推測や補完はせず、画面に実際に表示されているものだけを転記してください。\n\n## 対象範囲\n- 対象は写真中央のメインモニター内に表示されたリザルトUIだけです。\n- モニターの外枠、周囲に映り込む他の筐体の画面、天井照明やその反射は無視してください。\n- 斜め撮影や反射で判読できない項目は、推測せず null にしてください。\n\n## 楽曲情報\n- `song_title`: 画面表示の曲名を一字一句そのまま転記してください（記号・大文字小文字も保持）。\n- `play_style`: SINGLE PLAY なら \"SP\"、DOUBLE PLAY なら \"DP\"。判別できなければ null。\n- `jacket_bbox`: ジャケット画像の位置を、画像全体を 0〜1000 とした [x_min, y_min, x_max, y_max] で返してください。無ければ null。\n\n## プレイヤー情報（最重要）\n- 画面左側のプレイヤーを `player_1`、右側を `player_2` に入れてください。あなたが「どちらが撮影者か」を判断する必要はありません。\n- 片側しか表示されていない場合、もう片方は null にしてください。`is_versus` は両側ある場合のみ true。\n- 各プレイヤーについて次を転記してください:\n  - `dancer_name`: ダンサーネーム表示そのまま\n  - `difficulty`: BEGINNER / BASIC / DIFFICULT / EXPERT / CHALLENGE のいずれか（画面の難易度表記に対応）\n  - `level`: 難易度レベル（数値）\n  - `score`: 通常スコア（カンマなし整数、0〜1,000,000）\n  - `ex_score`: EX SCORE\n  - `rank`: AAA / AA+ / AA / AA- / A+ / A / A- / B+ / B / B- / C+ / C / C- / D+ / D / E\n  - `clear_lamp`: MFC / PFC / GFC / FC / LIFE4 / CLEAR / FAILED（フルコンボ等のランプ表記から）\n  - `flare_rank`: EX / IX / VIII / VII / VI / V / IV / III / II / I / NONE（FLAREゲージのランク）\n  - `flare_skill`: フレアスキル数値\n  - `max_combo`: MAX COMBO\n  - 判定内訳: `marvelous` / `perfect` / `great` / `good` / `ok` / `miss`\n    - `ok` はフリーズアロー等の OK 判定の合計です。NG は miss 側の表示と混同しないでください。\n  - `fast_count` / `slow_count`: FAST / SLOW の合計表示があればその数値\n\n## 数値の注意\n- 数字の読み取りでは 8/6/9/0、1/7 を特に慎重に確認してください。\n- 桁区切りカンマや先行ゼロは除いて整数で返してください。\n- 表示されていない項目は 0 ではなく null です。\n\n- ダンサーネームは画面上部のプレイヤー情報バナー内の文字列だけを読むこと。画面の端や背景に映り込んだ反射文字は読まないこと。\n";

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
 */
export async function extractFromImage(
  env: GeminiEnv,
  image: Blob,
): Promise<Extraction> {
  const model = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 500)}`);
  }
  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini API returned no content");
  return JSON.parse(text) as Extraction;
}
