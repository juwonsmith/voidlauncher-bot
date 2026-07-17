import { spawn } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ override: true });

const { Pool } = pg;

const suffix = process.argv[2] ?? "pump";
const binaryPath = path.join(
  "rust",
  "vanity-worker",
  "target",
  "release",
  process.platform === "win32" ? "vanity-worker.exe" : "vanity-worker"
);
let child;
let postgres;
let stopping = false;

if (process.env.SKIP_VANITY_BUILD === "true") {
  void startWorker().catch(fail);
} else {
  const build = spawn("cargo", ["build", "--release", "--manifest-path", "rust/vanity-worker/Cargo.toml"], {
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  build.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code !== 0) process.exit(code ?? 1);
    void startWorker().catch(fail);
  });
}

async function startWorker() {
  const usePostgres = Boolean(process.env.DATABASE_URL);
  if (usePostgres) {
    postgres = new Pool({
      connectionString: process.env.DATABASE_URL
    });
    await ensurePostgresVanitySchema();
    if ((await countAvailable()) >= poolSize()) {
      console.log(`Pool full: ${await countAvailable()}/${poolSize()} ready for ${suffix}.`);
      await postgres.end();
      process.exit(0);
    }
  }

  child = spawn(binaryPath, [], {
    env: {
      ...process.env,
      VANITY_MINT_SUFFIX: suffix,
      VANITY_STDOUT_MODE: usePostgres ? "true" : "false"
    },
    stdio: usePostgres ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: false
  });

  if (usePostgres && child.stdout) {
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) void processWorkerLine(line);
    });
  }

  child.on("exit", async (code, signal) => {
    if (postgres) await postgres.end().catch(() => undefined);
    if (stopping) process.exit(0);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function processWorkerLine(line) {
  if (!line.startsWith("VANITY_MINT\t")) {
    console.log(line);
    return;
  }

  const [, address, secretKey] = line.split("\t");
  if (!address || !secretKey) return;
  await postgres.query(
    `INSERT INTO vanity_mints (suffix, address, secret_key_base58, status, created_at)
     VALUES ($1, $2, $3, 'available', NOW()) ON CONFLICT (address) DO NOTHING`,
    [suffix, address, secretKey]
  );
  const available = await countAvailable();
  console.log(`Stored vanity mint ${address} (${available}/${poolSize()} ready)`);
  if (available >= poolSize() && !stopping) {
    stopping = true;
    child.kill();
  }
}

async function ensurePostgresVanitySchema() {
  await postgres.query(`
    CREATE TABLE IF NOT EXISTS vanity_mints (
      id BIGSERIAL PRIMARY KEY,
      suffix TEXT NOT NULL,
      address TEXT NOT NULL UNIQUE,
      secret_key_base58 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      created_at TIMESTAMPTZ NOT NULL,
      reserved_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      proposal_id BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_vanity_mints_status_suffix ON vanity_mints(status, suffix, id);
  `);
}

async function countAvailable() {
  const result = await postgres.query(
    "SELECT COUNT(*) AS count FROM vanity_mints WHERE status = 'available' AND suffix = $1",
    [suffix]
  );
  return Number(result.rows[0].count);
}

function poolSize() {
  const value = Number(process.env.PUMP_MINT_POOL_SIZE ?? 3);
  return Number.isInteger(value) && value > 0 ? value : 3;
}

function fail(error) {
  console.error(error);
  void postgres?.end().finally(() => process.exit(1));
}
