import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  DEFAULT_MASTER_URL,
  recheckLinkedNeedsReviewScores,
  relinkUnlinkedScores,
  syncMaster,
  type Env,
} from "./db";
import { scoresRoutes } from "./routes/scores";
import { browseRoutes } from "./routes/browse";
import { statsRoutes } from "./routes/stats";
import { targetsRoutes } from "./routes/targets";
import { adminRoutes } from "./routes/admin";

export type { Env };

const app = new Hono<{ Bindings: Env }>();

// ---- CORS: the PWA is served from a different origin (pages.dev) ----
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-API-Token"],
    maxAge: 86400,
  }),
);

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ---- auth: every /api/* needs X-API-Token except GET /api/health ----
app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  if (c.req.path === "/api/health") return next();
  const token = c.req.header("X-API-Token");
  if (!c.env.API_TOKEN || !token || !timingSafeEqual(token, c.env.API_TOKEN)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/", scoresRoutes);
app.route("/", browseRoutes);
app.route("/", statsRoutes);
app.route("/", targetsRoutes);
app.route("/", adminRoutes);

const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      syncMaster(env.DB, env.MASTER_URL || DEFAULT_MASTER_URL)
        .then(async (r) => {
          const hasWrites = r.songWrites > 0 || r.chartWrites > 0;
          const relink = hasWrites
            ? await relinkUnlinkedScores(env)
            : { linked: 0 };
          const recheck = hasWrites
            ? await recheckLinkedNeedsReviewScores(env)
            : { resolved: 0 };
          console.log(
            `[cron sync] master songs=${r.songs} charts=${r.charts} writes: songs=${r.songWrites} charts=${r.chartWrites} relinked=${relink.linked} resolved=${recheck.resolved}` +
              (r.redundantCorrections.length > 0
                ? ` redundant_corrections=${r.redundantCorrections.join(",")}`
                : ""),
          );
        })
        .catch((e) => console.error(`[cron sync] failed: ${e instanceof Error ? e.message : String(e)}`)),
    );
  },
};

export { app };
export default handler;
