import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const workerDir = path.join(repoRoot, "worker");
const wranglerBin = path.join(workerDir, "node_modules", "wrangler", "bin", "wrangler.js");
const seedFile = path.join(repoRoot, "scripts", "seed_master.sql");
const CHUNK_SIZE = 800;

/** Run a wrangler subcommand in workerDir and exit on failure. */
function runWrangler(args) {
  if (!fs.existsSync(wranglerBin)) {
    throw new Error(`wrangler binary not found at ${wranglerBin}. Run "npm install" in worker/ first.`);
  }
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: workerDir,
    stdio: ["pipe", "inherit", "inherit"],
    input: "y\n",
    env: { ...process.env, CI: "true" },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

console.log("[1/3] Applying D1 migrations to local database...");
runWrangler(["d1", "migrations", "apply", "ddr-score-db", "--local"]);

console.log("[2/3] Importing seed_master.sql into local D1...");
const rawSql = fs.readFileSync(seedFile, "utf8");
const stmts = rawSql.split(/\r?\n/).filter((line) => line.startsWith("INSERT"));
console.log(`Found ${stmts.length} INSERT statements.`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddr-seed-"));
try {
  const totalChunks = Math.ceil(stmts.length / CHUNK_SIZE);
  for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunkPath = path.join(tmpDir, `chunk_${String(chunkIndex).padStart(2, "0")}.sql`);
    fs.writeFileSync(chunkPath, `${stmts.slice(i, i + CHUNK_SIZE).join("\n")}\n`, "utf8");
    console.log(`Executing chunk ${chunkIndex + 1}/${totalChunks}...`);
    runWrangler(["d1", "execute", "ddr-score-db", "--local", "--file", chunkPath]);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("[3/3] Verifying song count in local D1...");
runWrangler([
  "d1",
  "execute",
  "ddr-score-db",
  "--local",
  "--command",
  "SELECT count(*) AS song_count FROM songs",
]);

console.log("Local D1 setup completed.");
