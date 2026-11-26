import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractFromImage,
  resolveModelList,
  retryDelaysMs,
  GeminiQuotaExhaustedError,
  DEFAULT_GEMINI_MODELS,
} from "../src/gemini";

// Model fallback is exercised with a stubbed fetch: no network, no API key.

function geminiOk(): Response {
  const extraction = JSON.stringify({
    song_title: "Test",
    play_style: "SP",
    is_versus: false,
    player_1: null,
    player_2: null,
    jacket_bbox: null,
  });
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: extraction }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function withStubbedFetch(stub: (url: string) => Response | Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any) => stub(String(input))) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

const blob = () => new Blob(["x"], { type: "image/jpeg" });

test("extractFromImage falls back to the next model on 404", async () => {
  const calls: string[] = [];
  const restore = withStubbedFetch((url) => {
    calls.push(url);
    if (url.includes("gemini-3.5-flash-lite")) return new Response("model not found", { status: 404 });
    return geminiOk();
  });
  try {
    const ext = await extractFromImage({ GEMINI_API_KEY: "k" }, blob());
    assert.equal(ext.song_title, "Test");
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("gemini-3.5-flash-lite"));
    assert.ok(calls[1].includes("gemini-3.1-flash-lite"));
  } finally {
    restore();
  }
});

test("extractFromImage fails fast on 401 without trying the fallback model", async () => {
  const calls: string[] = [];
  const restore = withStubbedFetch((url) => {
    calls.push(url);
    return new Response("bad key", { status: 401 });
  });
  try {
    await assert.rejects(() => extractFromImage({ GEMINI_API_KEY: "k" }, blob()), /401/);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("extractFromImage throws the last model's error when all models fail", async () => {
  const restore = withStubbedFetch(() => new Response("gone", { status: 404 }));
  try {
    await assert.rejects(
      () => extractFromImage({ GEMINI_API_KEY: "k" }, blob()),
      /gemini-3.1-flash-lite/,
    );
  } finally {
    restore();
  }
});

test("default model list is 3.5-flash-lite then 3.1-flash-lite (no 2.5, no 3.8)", () => {
  assert.deepEqual(DEFAULT_GEMINI_MODELS, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.deepEqual(resolveModelList({ GEMINI_API_KEY: "k" }), [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
  ]);
});

const quotaBody = JSON.stringify({
  error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric" },
});
const noSleep = async () => {};

test("extractFromImage throws GeminiQuotaExhaustedError when all models end in 429", async () => {
  const restore = withStubbedFetch(() => new Response(quotaBody, { status: 429 }));
  try {
    await assert.rejects(
      () => extractFromImage({ GEMINI_API_KEY: "k" }, blob(), { sleep: noSleep }),
      (e: unknown) => e instanceof GeminiQuotaExhaustedError,
    );
  } finally {
    restore();
  }
});

test("extractFromImage does not call it quota when a model fails differently (429 then 404)", async () => {
  const restore = withStubbedFetch((url) =>
    url.includes("gemini-3.5-flash-lite")
      ? new Response("rate limited", { status: 429 })
      : new Response("gone", { status: 404 }),
  );
  try {
    await assert.rejects(
      () => extractFromImage({ GEMINI_API_KEY: "k" }, blob(), { sleep: noSleep }),
      (e: unknown) => !(e instanceof GeminiQuotaExhaustedError) && /404/.test(String(e)),
    );
  } finally {
    restore();
  }
});

test("bulk mode retries each model only once (delays [4000]); normal mode keeps [1500,4000,9000]", async () => {
  assert.deepEqual(retryDelaysMs(true), [4000]);
  assert.deepEqual(retryDelaysMs(false), [1500, 4000, 9000]);

  const countCalls = async (bulk: boolean) => {
    let calls = 0;
    const delays: number[] = [];
    const restore = withStubbedFetch(() => {
      calls++;
      return new Response("busy", { status: 503 });
    });
    try {
      await assert.rejects(() =>
        extractFromImage({ GEMINI_API_KEY: "k" }, blob(), {
          bulk,
          sleep: async (ms: number) => {
            delays.push(ms);
          },
        }),
      );
    } finally {
      restore();
    }
    return { calls, delays };
  };

  // 2 models: bulk = 2 attempts/model, normal = 4 attempts/model.
  const bulkRun = await countCalls(true);
  assert.equal(bulkRun.calls, 4);
  assert.deepEqual(bulkRun.delays, [4000, 4000]);
  const normalRun = await countCalls(false);
  assert.equal(normalRun.calls, 8);
  assert.deepEqual(normalRun.delays, [1500, 4000, 9000, 1500, 4000, 9000]);
});
