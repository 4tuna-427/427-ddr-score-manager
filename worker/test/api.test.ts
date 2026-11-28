import { test } from "node:test";
import assert from "node:assert/strict";
import { app, type Env } from "../src/index";

function createMockDb(options?: { firstRow?: Record<string, unknown> | null }): D1Database {
  const stmt = {
    bind(..._args: unknown[]) {
      return stmt;
    },
    async first<T = Record<string, unknown>>() {
      return (options?.firstRow ?? null) as T | null;
    },
    async all<T = Record<string, unknown>>() {
      return { results: [] as T[], success: true, meta: {} };
    },
    async run() {
      return { results: [], success: true, meta: {} };
    },
  };
  return {
    prepare(_sql: string) {
      return stmt as unknown as D1PreparedStatement;
    },
    async batch() {
      return [];
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

function createEnv(options?: { firstRow?: Record<string, unknown> | null }): Env {
  return {
    DB: createMockDb(options),
    API_TOKEN: "test-token",
    GEMINI_API_KEY: "test-gemini-key",
  };
}

test("GET /api/health returns 200 without auth", async () => {
  const res = await app.request("/api/health", {}, createEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("Auth middleware rejects missing or invalid X-API-Token with 401", async () => {
  const env = createEnv();
  const resNoToken = await app.request("/api/scores", {}, env);
  assert.equal(resNoToken.status, 401);

  const resBadToken = await app.request(
    "/api/scores",
    { headers: { "X-API-Token": "wrong" } },
    env,
  );
  assert.equal(resBadToken.status, 401);
});

test("PATCH /api/scores/:id returns 400 on invalid fields", async () => {
  const env = createEnv({
    firstRow: { id: "s1", score: 900000, difficulty: "EXPERT", needs_review: 0 },
  });
  const headers = { "X-API-Token": "test-token", "Content-Type": "application/json" };

  const resBadScore = await app.request(
    "/api/scores/s1",
    { method: "PATCH", headers, body: JSON.stringify({ score: -1 }) },
    env,
  );
  assert.equal(resBadScore.status, 400);

  const resBadDiff = await app.request(
    "/api/scores/s1",
    { method: "PATCH", headers, body: JSON.stringify({ difficulty: "NORMAL" }) },
    env,
  );
  assert.equal(resBadDiff.status, 400);
});

test("POST /api/targets returns 400 when both target_score and target_lamp are omitted", async () => {
  const env = createEnv();
  const res = await app.request(
    "/api/targets",
    {
      method: "POST",
      headers: { "X-API-Token": "test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ chart_id: "song1|SP|EXPERT" }),
    },
    env,
  );
  assert.equal(res.status, 400);
});

test("GET /api/songs/by-phash returns 400 on invalid phash", async () => {
  const env = createEnv();
  const res = await app.request(
    "/api/songs/by-phash?phash=invalid",
    { headers: { "X-API-Token": "test-token" } },
    env,
  );
  assert.equal(res.status, 400);
});

test("GET /api/scores filters by JST date and validates format", async () => {
  const capturedBinds: unknown[][] = [];
  const rows = [
    { id: "s1", played_at: Date.parse("2026-11-28T00:00:00+09:00"), score: 990000 },
    { id: "s2", played_at: Date.parse("2026-11-28T23:59:59+09:00"), score: 980000 },
    { id: "s3", played_at: Date.parse("2026-11-29T00:00:00+09:00"), score: 970000 },
  ];
  const mockDb = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          capturedBinds.push(args);
          return stmt;
        },
        async first<T>() {
          if (sql.includes("COUNT(*)")) {
            const [start, end] = bound as [number, number];
            const filtered = rows.filter((r) => r.played_at >= start && r.played_at < end);
            return { n: filtered.length } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          const [start, end] = bound as [number, number];
          const filtered = rows.filter((r) => r.played_at >= start && r.played_at < end);
          return { results: filtered as T[], success: true, meta: {} };
        },
        async run() {
          return { results: [], success: true, meta: {} };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
    async batch() { return []; },
    async exec() { return { count: 0, duration: 0 }; },
    async dump() { return new ArrayBuffer(0); },
  } as unknown as D1Database;

  const env: Env = {
    DB: mockDb,
    API_TOKEN: "test-token",
    GEMINI_API_KEY: "test-gemini-key",
  };
  const headers = { "X-API-Token": "test-token" };

  const resBad = await app.request("/api/scores?date=2026-11", { headers }, env);
  assert.equal(resBad.status, 400);

  const resOk = await app.request("/api/scores?date=2026-11-28", { headers }, env);
  assert.equal(resOk.status, 200);
  const body = (await resOk.json()) as { items: { id: string }[]; total: number };
  assert.equal(body.total, 2);
  assert.deepEqual(body.items.map((x) => x.id), ["s1", "s2"]);
  assert.equal(capturedBinds[0][0], Date.parse("2026-11-28T00:00:00+09:00"));
  assert.equal(capturedBinds[0][1], Date.parse("2026-11-29T00:00:00+09:00"));
});
