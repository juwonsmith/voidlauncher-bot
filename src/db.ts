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
    pumpfun_cashback INTEGER,
    pumpfun_fee_shares TEXT,
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

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    actor_id INTEGER,
    actor_username TEXT,
    chat_id TEXT,
    proposal_id INTEGER,
    details TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

  CREATE TABLE IF NOT EXISTS launch_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    launchpad TEXT NOT NULL,
    mode TEXT NOT NULL,
    payer_address TEXT,
    chat_id TEXT,
    actor_id INTEGER,
    status TEXT NOT NULL,
    signature TEXT,
    mint TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_launch_attempts_proposal ON launch_attempts(proposal_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_launch_attempts_chat ON launch_attempts(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_launch_attempts_actor ON launch_attempts(actor_id, created_at);

  CREATE TABLE IF NOT EXISTS launch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    launchpad TEXT NOT NULL,
    mode TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    actor_id INTEGER,
    actor_username TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    signature TEXT,
    mint TEXT,
    created_at TEXT NOT NULL,
    run_after TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_launch_jobs_status_run_after ON launch_jobs(status, run_after, id);
  CREATE INDEX IF NOT EXISTS idx_launch_jobs_proposal ON launch_jobs(proposal_id, created_at);
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

try {
  db.prepare("ALTER TABLE proposals ADD COLUMN pumpfun_cashback INTEGER").run();
} catch {
  // Column already exists.
}

try {
  db.prepare("ALTER TABLE proposals ADD COLUMN pumpfun_fee_shares TEXT").run();
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

export interface AuditLogInput {
  action: string;
  actorId?: number;
  actorUsername?: string;
  chatId?: string;
  proposalId?: number;
  details?: unknown;
}

export interface LaunchAttemptInput {
  proposalId: number;
  launchpad: string;
  mode: "api" | "group" | "personal";
  payerAddress?: string;
  chatId?: string;
  actorId?: number;
}

export interface LaunchAttemptUpdate {
  status: "success" | "failed";
  signature?: string;
  mint?: string;
  error?: string;
}

export interface LaunchJob {
  id: number;
  proposalId: number;
  launchpad: string;
  mode: "api" | "group" | "personal";
  chatId: string;
  actorId?: number;
  actorUsername?: string;
  status: "queued" | "running" | "success" | "failed";
  attempts: number;
  lastError?: string;
  signature?: string;
  mint?: string;
  createdAt: string;
  runAfter: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LaunchJobInput {
  proposalId: number;
  launchpad: string;
  mode: LaunchJob["mode"];
  chatId: string;
  actorId?: number;
  actorUsername?: string;
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
    pumpfunCashback: row.pumpfun_cashback === null || row.pumpfun_cashback === undefined ? undefined : Boolean(row.pumpfun_cashback),
    pumpfunFeeShares: row.pumpfun_fee_shares ? String(row.pumpfun_fee_shares) : undefined,
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
        dev_buy_sol, pumpfun_cashback, pumpfun_fee_shares, created_by, created_by_username, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      idea.pumpfunCashback === undefined ? null : Number(idea.pumpfunCashback),
      idea.pumpfunFeeShares ?? null,
      createdBy,
      createdByUsername ?? null,
      createdAt
    );

  const proposal = getProposal(Number(result.lastInsertRowid));
  if (!proposal) throw new Error("Failed to read proposal after insert.");
  return proposal;
}

export function updateProposalCashback(id: number, enabled: boolean): Proposal | undefined {
  db.prepare("UPDATE proposals SET pumpfun_cashback = ? WHERE id = ? AND status IN ('pending', 'approved')").run(
    Number(enabled),
    id
  );
  return getProposal(id);
}

export function updateProposalFeeShares(id: number, feeShares?: string): Proposal | undefined {
  db.prepare("UPDATE proposals SET pumpfun_fee_shares = ? WHERE id = ? AND status IN ('pending', 'approved')").run(
    feeShares?.trim() || null,
    id
  );
  return getProposal(id);
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

export function createAuditLog(input: AuditLogInput): void {
  db.prepare(
    `INSERT INTO audit_logs (action, actor_id, actor_username, chat_id, proposal_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.action,
    input.actorId ?? null,
    input.actorUsername ?? null,
    input.chatId ?? null,
    input.proposalId ?? null,
    input.details === undefined ? null : JSON.stringify(input.details),
    new Date().toISOString()
  );
}

export function createLaunchAttempt(input: LaunchAttemptInput): number {
  const result = db
    .prepare(
      `INSERT INTO launch_attempts (
        proposal_id, launchpad, mode, payer_address, chat_id, actor_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(
      input.proposalId,
      input.launchpad,
      input.mode,
      input.payerAddress ?? null,
      input.chatId ?? null,
      input.actorId ?? null,
      new Date().toISOString()
    );
  return Number(result.lastInsertRowid);
}

export function finishLaunchAttempt(id: number, update: LaunchAttemptUpdate): void {
  db.prepare(
    `UPDATE launch_attempts
     SET status = ?, signature = ?, mint = ?, error = ?, completed_at = ?
     WHERE id = ?`
  ).run(update.status, update.signature ?? null, update.mint ?? null, update.error ?? null, new Date().toISOString(), id);
}

export function countSuccessfulLaunchesSince(scope: "chat" | "actor", id: string | number, sinceIso: string): number {
  const column = scope === "chat" ? "chat_id" : "actor_id";
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM launch_attempts WHERE ${column} = ? AND status = 'success' AND created_at >= ?`)
    .get(String(id), sinceIso) as { count: number };
  return Number(row.count);
}

export function recentLaunchAttempts(limit = 8): Array<{
  proposalId: number;
  launchpad: string;
  mode: string;
  status: string;
  signature?: string;
  mint?: string;
  error?: string;
  createdAt: string;
}> {
  const rows = db
    .prepare(
      `SELECT proposal_id, launchpad, mode, status, signature, mint, error, created_at
       FROM launch_attempts
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    proposalId: Number(row.proposal_id),
    launchpad: String(row.launchpad),
    mode: String(row.mode),
    status: String(row.status),
    signature: row.signature ? String(row.signature) : undefined,
    mint: row.mint ? String(row.mint) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: String(row.created_at)
  }));
}

function mapLaunchJob(row: Record<string, unknown>): LaunchJob {
  return {
    id: Number(row.id),
    proposalId: Number(row.proposal_id),
    launchpad: String(row.launchpad),
    mode: String(row.mode) as LaunchJob["mode"],
    chatId: String(row.chat_id),
    actorId: row.actor_id === null || row.actor_id === undefined ? undefined : Number(row.actor_id),
    actorUsername: row.actor_username ? String(row.actor_username) : undefined,
    status: String(row.status) as LaunchJob["status"],
    attempts: Number(row.attempts),
    lastError: row.last_error ? String(row.last_error) : undefined,
    signature: row.signature ? String(row.signature) : undefined,
    mint: row.mint ? String(row.mint) : undefined,
    createdAt: String(row.created_at),
    runAfter: String(row.run_after),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined
  };
}

export function enqueueLaunchJob(input: LaunchJobInput): LaunchJob {
  const existing = db
    .prepare(
      `SELECT * FROM launch_jobs
       WHERE proposal_id = ? AND mode = ? AND status IN ('queued', 'running')
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(input.proposalId, input.mode) as Record<string, unknown> | undefined;
  if (existing) return mapLaunchJob(existing);

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO launch_jobs (
        proposal_id, launchpad, mode, chat_id, actor_id, actor_username, created_at, run_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.proposalId,
      input.launchpad,
      input.mode,
      input.chatId,
      input.actorId ?? null,
      input.actorUsername ?? null,
      now,
      now
    );
  const job = getLaunchJob(Number(result.lastInsertRowid));
  if (!job) throw new Error("Failed to read launch job after insert.");
  return job;
}

export function getLaunchJob(id: number): LaunchJob | undefined {
  const row = db.prepare("SELECT * FROM launch_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapLaunchJob(row) : undefined;
}

export function claimNextLaunchJob(maxAttempts: number): LaunchJob | undefined {
  return db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE launch_jobs
       SET status = 'queued', started_at = NULL
       WHERE status = 'running' AND started_at < ?`
    ).run(new Date(Date.now() - 15 * 60 * 1000).toISOString());

    const row = db
      .prepare(
        `SELECT * FROM launch_jobs
         WHERE status = 'queued' AND run_after <= ? AND attempts < ?
         ORDER BY id ASC
         LIMIT 1`
      )
      .get(now, maxAttempts) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    db.prepare(
      `UPDATE launch_jobs
       SET status = 'running', attempts = attempts + 1, started_at = ?
       WHERE id = ? AND status = 'queued'`
    ).run(now, row.id);

    return getLaunchJob(Number(row.id));
  })();
}

export function completeLaunchJob(id: number, signature?: string, mint?: string): void {
  db.prepare(
    `UPDATE launch_jobs
     SET status = 'success', signature = ?, mint = ?, completed_at = ?
     WHERE id = ?`
  ).run(signature ?? null, mint ?? null, new Date().toISOString(), id);
}

export function failLaunchJob(id: number, error: string, retryDelayMs: number, maxAttempts: number): void {
  const job = getLaunchJob(id);
  if (!job) return;
  const willRetry = job.attempts < maxAttempts;
  db.prepare(
    `UPDATE launch_jobs
     SET status = ?, last_error = ?, run_after = ?, completed_at = CASE WHEN ? THEN NULL ELSE ? END
     WHERE id = ?`
  ).run(
    willRetry ? "queued" : "failed",
    error,
    new Date(Date.now() + retryDelayMs).toISOString(),
    willRetry ? 1 : 0,
    new Date().toISOString(),
    id
  );
}

export function recentLaunchJobs(limit = 8): LaunchJob[] {
  const rows = db
    .prepare("SELECT * FROM launch_jobs ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(mapLaunchJob);
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
