import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromImage } from "../src/gemini";

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
    assert.ok(calls[1].includes("gemini-2.5-flash-lite"));
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
      /gemini-2.5-flash-lite/,
    );
  } finally {
    restore();
  }
});
