import "dotenv/config";
import Database from "better-sqlite3";
import dns from "node:dns";
import pg from "pg";

const { Pool } = pg;

dns.setDefaultResultOrder("ipv4first");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the Postgres migration.");
}

const sqlitePath = process.env.DATABASE_PATH || "./data/bot.sqlite";
const sqlite = new Database(sqlitePath, { readonly: true });
const postgres = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 30_000)
});

const databaseModule = await import("../dist/db.js");
await databaseModule.assertDatabaseReady();

const tables = [
  {
    name: "proposals",
    columns: [
      "id", "launchpad", "name", "symbol", "description", "website", "telegram", "twitter", "image",
      "dev_buy_sol", "dev_buy_eth", "pumpfun_cashback", "pumpfun_fee_shares", "status", "created_by",
      "created_by_username", "created_at", "approved_by", "approved_at", "rejection_reason", "launch_signature"
    ],
    transform(row) {
      if (row.pumpfun_cashback !== null && row.pumpfun_cashback !== undefined) {
        row.pumpfun_cashback = Boolean(row.pumpfun_cashback);
      }
      return row;
    }
  },
  {
    name: "vanity_mints",
    columns: [
      "id", "suffix", "address", "secret_key_base58", "status", "created_at", "reserved_at", "used_at", "proposal_id"
    ]
  },
  {
    name: "wallets",
    columns: [
      "id", "scope", "scope_id", "address", "encrypted_secret_key", "encrypted_api_key", "provider", "created_at"
    ]
  },
  {
    name: "audit_logs",
    columns: ["id", "action", "actor_id", "actor_username", "chat_id", "proposal_id", "details", "created_at"]
  },
  {
    name: "launch_attempts",
    columns: [
      "id", "proposal_id", "launchpad", "mode", "payer_address", "chat_id", "actor_id", "status", "signature",
      "mint", "error", "created_at", "completed_at"
    ]
  },
  {
    name: "launch_jobs",
    columns: [
      "id", "proposal_id", "launchpad", "mode", "chat_id", "actor_id", "actor_username", "status", "attempts",
      "last_error", "signature", "mint", "created_at", "run_after", "started_at", "completed_at"
    ]
  }
];

const client = await postgres.connect();
try {
  await client.query("BEGIN");
  for (const table of tables) {
    if (!sqliteTableExists(table.name)) {
      console.log(`${table.name}: source table does not exist; skipped`);
      continue;
    }

    const availableColumns = new Set(
      sqlite.prepare(`PRAGMA table_info(${table.name})`).all().map((column) => column.name)
    );
    const columns = table.columns.filter((column) => availableColumns.has(column));
    const rows = sqlite.prepare(`SELECT * FROM ${table.name}`).all();
    let copied = 0;

    for (const sourceRow of rows) {
      const row = table.transform ? table.transform({ ...sourceRow }) : sourceRow;
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      const values = columns.map((column) => normalizeValue(column, row[column]));
      const result = await client.query(
        `INSERT INTO ${table.name} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
      copied += result.rowCount ?? 0;
    }

    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table.name}), 1), ` +
        `(SELECT COUNT(*) > 0 FROM ${table.name}))`,
      [table.name]
    );
    console.log(`${table.name}: copied ${copied}/${rows.length}`);
  }
  await client.query("COMMIT");
  console.log("SQLite to Postgres migration completed.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  sqlite.close();
  await postgres.end();
  await databaseModule.closeDatabase();
}

// Native SQLite bindings can keep a Windows process alive briefly after close.
// The migration has no background work, so terminate once all pools are closed.
process.exit(0);

function sqliteTableExists(name) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function normalizeValue(column, value) {
  if (value === undefined || value === null) return null;
  if (!column.endsWith("_at")) return value;

  const text = String(value).trim();
  if (/^\d{9,13}$/.test(text)) {
    const numeric = Number(text);
    const milliseconds = text.length <= 10 ? numeric * 1000 : numeric;
    return new Date(milliseconds);
  }
  return value;
}
