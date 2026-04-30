import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { CoinIdeaInput, Proposal } from "./types.js";

const databaseDir = path.dirname(config.DATABASE_PATH);
fs.mkdirSync(databaseDir, { recursive: true });

const db = new Database(config.DATABASE_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    launchpad TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    description TEXT NOT NULL,
    website TEXT,
    telegram TEXT,
    twitter TEXT,
    image TEXT,
    dev_buy_sol REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by INTEGER NOT NULL,
    created_by_username TEXT,
    created_at TEXT NOT NULL,
    approved_by INTEGER,
    approved_at TEXT,
    rejection_reason TEXT,
    launch_signature TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS vanity_mints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suffix TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    secret_key_base58 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    created_at TEXT NOT NULL,
    reserved_at TEXT,
    used_at TEXT,
    proposal_id INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_vanity_mints_status_suffix
    ON vanity_mints(status, suffix, id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    encrypted_secret_key TEXT NOT NULL,
    encrypted_api_key TEXT,
    provider TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL,
    UNIQUE(scope, scope_id)
  );
`);

try {
  db.prepare("ALTER TABLE wallets ADD COLUMN encrypted_api_key TEXT").run();
} catch {
  // Column already exists.
}

try {
  db.prepare("ALTER TABLE wallets ADD COLUMN provider TEXT NOT NULL DEFAULT 'local'").run();
} catch {
  // Column already exists.
}

export interface VanityMint {
  id: number;
  suffix: string;
  address: string;
  secretKeyBase58: string;
}

export interface StoredWallet {
  id: number;
  scope: "group" | "user" | "group_portal";
  scopeId: string;
  address: string;
  encryptedSecretKey: string;
  encryptedApiKey?: string;
  provider: "local" | "pumpportal";
  createdAt: string;
}

function mapWallet(row: Record<string, unknown>): StoredWallet {
  return {
    id: Number(row.id),
    scope: row.scope as StoredWallet["scope"],
    scopeId: String(row.scope_id),
    address: String(row.address),
    encryptedSecretKey: String(row.encrypted_secret_key),
    encryptedApiKey: row.encrypted_api_key ? String(row.encrypted_api_key) : undefined,
    provider: (row.provider ? String(row.provider) : "local") as StoredWallet["provider"],
    createdAt: String(row.created_at)
  };
}

export function getWallet(scope: StoredWallet["scope"], scopeId: string): StoredWallet | undefined {
  const row = db.prepare("SELECT * FROM wallets WHERE scope = ? AND scope_id = ?").get(scope, scopeId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapWallet(row) : undefined;
}

export function listWallets(scope: StoredWallet["scope"]): StoredWallet[] {
  const rows = db.prepare("SELECT * FROM wallets WHERE scope = ? ORDER BY created_at DESC").all(scope) as Record<
    string,
    unknown
  >[];
  return rows.map(mapWallet);
}

export function createWalletRecord(
  scope: StoredWallet["scope"],
  scopeId: string,
  address: string,
  encryptedSecretKey: string,
  provider: StoredWallet["provider"] = "local",
  encryptedApiKey?: string
): StoredWallet {
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO wallets (scope, scope_id, address, encrypted_secret_key, encrypted_api_key, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(scope, scopeId, address, encryptedSecretKey, encryptedApiKey ?? null, provider, createdAt);

  const wallet = getWallet(scope, scopeId);
  if (!wallet) throw new Error("Failed to read wallet after insert.");
  return wallet;
}

function mapProposal(row: Record<string, unknown>): Proposal {
  return {
    id: Number(row.id),
    launchpad: row.launchpad as Proposal["launchpad"],
    name: String(row.name),
    symbol: String(row.symbol),
    description: String(row.description),
    website: row.website ? String(row.website) : undefined,
    telegram: row.telegram ? String(row.telegram) : undefined,
    twitter: row.twitter ? String(row.twitter) : undefined,
    image: row.image ? String(row.image) : undefined,
    devBuySol: row.dev_buy_sol ? Number(row.dev_buy_sol) : undefined,
    status: row.status as Proposal["status"],
    createdBy: Number(row.created_by),
    createdByUsername: row.created_by_username ? String(row.created_by_username) : undefined,
    createdAt: String(row.created_at),
    approvedBy: row.approved_by ? Number(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : undefined,
    launchSignature: row.launch_signature ? String(row.launch_signature) : undefined
  };
}

export function createProposal(
  idea: CoinIdeaInput,
  createdBy: number,
  createdByUsername?: string
): Proposal {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO proposals (
        launchpad, name, symbol, description, website, telegram, twitter, image,
        dev_buy_sol, created_by, created_by_username, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      idea.launchpad,
      idea.name,
      idea.symbol.toUpperCase(),
      idea.description,
      idea.website ?? null,
      idea.telegram ?? null,
      idea.twitter ?? null,
      idea.image ?? null,
      idea.devBuySol ?? null,
      createdBy,
      createdByUsername ?? null,
      createdAt
    );

  const proposal = getProposal(Number(result.lastInsertRowid));
  if (!proposal) throw new Error("Failed to read proposal after insert.");
  return proposal;
}

export function getProposal(id: number): Proposal | undefined {
  const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapProposal(row) : undefined;
}

export function listPendingProposals(limit = 10): Proposal[] {
  const rows = db
    .prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id ASC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(mapProposal);
}

export function approveProposal(id: number, adminId: number): Proposal | undefined {
  db.prepare(
    "UPDATE proposals SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'pending'"
  ).run(adminId, new Date().toISOString(), id);
  return getProposal(id);
}

export function rejectProposal(id: number, reason: string): Proposal | undefined {
  db.prepare(
    "UPDATE proposals SET status = 'rejected', rejection_reason = ? WHERE id = ? AND status = 'pending'"
  ).run(reason, id);
  return getProposal(id);
}

export function markLaunched(id: number, signature?: string): Proposal | undefined {
  db.prepare("UPDATE proposals SET status = 'launched', launch_signature = ? WHERE id = ?").run(
    signature ?? null,
    id
  );
  return getProposal(id);
}

export function consumeVanityMint(suffix: string, proposalId: number): VanityMint | undefined {
  const normalizedSuffix = suffix;
  const now = new Date().toISOString();

  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM vanity_mints
         WHERE status = 'available' AND suffix = ?
         ORDER BY id ASC
         LIMIT 1`
      )
      .get(normalizedSuffix) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    db.prepare(
      `UPDATE vanity_mints
       SET status = 'reserved', reserved_at = ?, proposal_id = ?
       WHERE id = ?`
    ).run(now, proposalId, row.id);

    return {
      id: Number(row.id),
      suffix: String(row.suffix),
      address: String(row.address),
      secretKeyBase58: String(row.secret_key_base58)
    };
  })();
}

export function markVanityMintUsed(id: number): void {
  db.prepare("UPDATE vanity_mints SET status = 'used', used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export function releaseVanityMint(id: number): void {
  db.prepare(
    `UPDATE vanity_mints
     SET status = 'available', reserved_at = NULL, proposal_id = NULL
     WHERE id = ? AND status = 'reserved'`
  ).run(id);
}

export function countAvailableVanityMints(suffix: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM vanity_mints WHERE status = 'available' AND suffix = ?")
    .get(suffix) as { count: number };
  return Number(row.count);
}

export function quarantineInexactVanityMints(suffix: string): number {
  const rows = db
    .prepare("SELECT id, address FROM vanity_mints WHERE status = 'available' AND suffix = ?")
    .all(suffix) as Array<{ id: number; address: string }>;
  const badIds = rows.filter((row) => !row.address.endsWith(suffix)).map((row) => row.id);

  if (badIds.length === 0) return 0;

  const update = db.prepare("UPDATE vanity_mints SET status = 'invalid' WHERE id = ?");
  db.transaction(() => {
    for (const id of badIds) update.run(id);
  })();

  return badIds.length;
}
