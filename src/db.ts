import dns from "node:dns";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config.js";
import type { CoinIdeaInput, Proposal } from "./types.js";

if (!config.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Configure a persistent Postgres database before starting the bot."
  );
}

// Some Windows/ISP combinations resolve Neon's IPv6 address without providing
// a working IPv6 route. Prefer IPv4 while retaining normal DNS fallback.
dns.setDefaultResultOrder("ipv4first");

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS
});

pool.on("error", (error) => {
  console.error("Unexpected Postgres pool error", error);
});

const databaseReady = initializeDatabase();

export interface VanityMint {
  id: number;
  suffix: string;
  address: string;
  secretKeyBase58: string;
}

export interface StoredWallet {
  id: number;
  scope: "group" | "user" | "group_portal" | "group_evm" | "user_evm";
  scopeId: string;
  address: string;
  encryptedSecretKey: string;
  encryptedApiKey?: string;
  provider: "local" | "pumpportal" | "evm";
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

export interface CustomCaOrder {
  proposalId: number;
  chatId: string;
  status: "pending" | "ready" | "reserved" | "used" | "cancelled";
  address?: string;
  encryptedSecretKey?: string;
  createdAt: string;
  readyAt?: string;
}

export interface PendingCustomCaOrder {
  proposalId: number;
  position: "start" | "end";
  pattern: string;
}

export interface LaunchJobInput {
  proposalId: number;
  launchpad: string;
  mode: LaunchJob["mode"];
  chatId: string;
  actorId?: number;
  actorUsername?: string;
}

async function initializeDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposals (
      id BIGSERIAL PRIMARY KEY,
      launchpad TEXT NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      description TEXT NOT NULL,
      website TEXT,
      telegram TEXT,
      twitter TEXT,
      image TEXT,
      dev_buy_sol DOUBLE PRECISION,
      dev_buy_eth DOUBLE PRECISION,
      pumpfun_cashback BOOLEAN,
      pumpfun_fee_shares TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by BIGINT NOT NULL,
      created_by_username TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      approved_by BIGINT,
      approved_at TIMESTAMPTZ,
      rejection_reason TEXT,
      launch_signature TEXT
    );

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

    CREATE INDEX IF NOT EXISTS idx_vanity_mints_status_suffix
      ON vanity_mints(status, suffix, id);

    CREATE TABLE IF NOT EXISTS wallets (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      address TEXT NOT NULL UNIQUE,
      encrypted_secret_key TEXT NOT NULL,
      encrypted_api_key TEXT,
      provider TEXT NOT NULL DEFAULT 'local',
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE(scope, scope_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id BIGINT,
      actor_username TEXT,
      chat_id TEXT,
      proposal_id BIGINT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

    CREATE TABLE IF NOT EXISTS launch_attempts (
      id BIGSERIAL PRIMARY KEY,
      proposal_id BIGINT NOT NULL,
      launchpad TEXT NOT NULL,
      mode TEXT NOT NULL,
      payer_address TEXT,
      chat_id TEXT,
      actor_id BIGINT,
      status TEXT NOT NULL,
      signature TEXT,
      mint TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_launch_attempts_proposal ON launch_attempts(proposal_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_launch_attempts_chat ON launch_attempts(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_launch_attempts_actor ON launch_attempts(actor_id, created_at);

    CREATE TABLE IF NOT EXISTS launch_jobs (
      id BIGSERIAL PRIMARY KEY,
      proposal_id BIGINT NOT NULL,
      launchpad TEXT NOT NULL,
      mode TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      actor_id BIGINT,
      actor_username TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      signature TEXT,
      mint TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      run_after TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_launch_jobs_status_run_after ON launch_jobs(status, run_after, id);
    CREATE INDEX IF NOT EXISTS idx_launch_jobs_proposal ON launch_jobs(proposal_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_jobs_active_proposal_mode
      ON launch_jobs(proposal_id, mode) WHERE status IN ('queued', 'running');

    ALTER TABLE proposals
      ADD COLUMN IF NOT EXISTS custom_ca_position TEXT,
      ADD COLUMN IF NOT EXISTS custom_ca_pattern TEXT,
      ADD COLUMN IF NOT EXISTS custom_ca_fee_sol DOUBLE PRECISION;

    CREATE TABLE IF NOT EXISTS custom_ca_orders (
      proposal_id BIGINT PRIMARY KEY REFERENCES proposals(id),
      chat_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      address TEXT UNIQUE,
      encrypted_secret_key TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      ready_at TIMESTAMPTZ,
      reserved_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_custom_ca_orders_status ON custom_ca_orders(status, proposal_id);

    CREATE TABLE IF NOT EXISTS payout_wallets (
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      address TEXT NOT NULL,
      set_by BIGINT,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (scope, scope_id, chain)
    );

    CREATE TABLE IF NOT EXISTS fee_claims (
      id BIGSERIAL PRIMARY KEY,
      chain TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      launchpad TEXT NOT NULL,
      amount TEXT NOT NULL,
      claim_tx TEXT NOT NULL,
      chat_id TEXT,
      actor_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL,
      payout_address TEXT,
      forward_tx TEXT,
      forward_started_at TIMESTAMPTZ,
      forwarded_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_fee_claims_unforwarded ON fee_claims(wallet_address, id) WHERE forwarded_at IS NULL;
  `);
}

export async function assertDatabaseReady(): Promise<void> {
  await databaseReady;
  await pool.query("SELECT 1");
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

function mapWallet(row: QueryResultRow): StoredWallet {
  return {
    id: Number(row.id),
    scope: row.scope as StoredWallet["scope"],
    scopeId: String(row.scope_id),
    address: String(row.address),
    encryptedSecretKey: String(row.encrypted_secret_key),
    encryptedApiKey: row.encrypted_api_key ? String(row.encrypted_api_key) : undefined,
    provider: (row.provider ? String(row.provider) : "local") as StoredWallet["provider"],
    createdAt: asIso(row.created_at)
  };
}

export async function getWallet(scope: StoredWallet["scope"], scopeId: string): Promise<StoredWallet | undefined> {
  await databaseReady;
  const result = await pool.query("SELECT * FROM wallets WHERE scope = $1 AND scope_id = $2", [scope, scopeId]);
  return result.rows[0] ? mapWallet(result.rows[0]) : undefined;
}

export async function listWallets(scope: StoredWallet["scope"]): Promise<StoredWallet[]> {
  await databaseReady;
  const result = await pool.query("SELECT * FROM wallets WHERE scope = $1 ORDER BY created_at DESC", [scope]);
  return result.rows.map(mapWallet);
}

export async function createWalletRecord(
  scope: StoredWallet["scope"],
  scopeId: string,
  address: string,
  encryptedSecretKey: string,
  provider: StoredWallet["provider"] = "local",
  encryptedApiKey?: string
): Promise<StoredWallet> {
  await databaseReady;
  const result = await pool.query(
    `INSERT INTO wallets (scope, scope_id, address, encrypted_secret_key, encrypted_api_key, provider, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (scope, scope_id) DO NOTHING
     RETURNING *`,
    [scope, scopeId, address, encryptedSecretKey, encryptedApiKey ?? null, provider]
  );
  if (result.rows[0]) return mapWallet(result.rows[0]);
  const existing = await getWallet(scope, scopeId);
  if (!existing) throw new Error("Failed to read wallet after insert.");
  return existing;
}

function mapProposal(row: QueryResultRow): Proposal {
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
    devBuySol: row.dev_buy_sol === null || row.dev_buy_sol === undefined ? undefined : Number(row.dev_buy_sol),
    devBuyEth: row.dev_buy_eth === null || row.dev_buy_eth === undefined ? undefined : Number(row.dev_buy_eth),
    pumpfunCashback:
      row.pumpfun_cashback === null || row.pumpfun_cashback === undefined ? undefined : Boolean(row.pumpfun_cashback),
    pumpfunFeeShares: row.pumpfun_fee_shares ? String(row.pumpfun_fee_shares) : undefined,
    status: row.status as Proposal["status"],
    createdBy: Number(row.created_by),
    createdByUsername: row.created_by_username ? String(row.created_by_username) : undefined,
    createdAt: asIso(row.created_at),
    approvedBy: row.approved_by === null || row.approved_by === undefined ? undefined : Number(row.approved_by),
    approvedAt: row.approved_at ? asIso(row.approved_at) : undefined,
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : undefined,
    launchSignature: row.launch_signature ? String(row.launch_signature) : undefined,
    customCaPosition: row.custom_ca_position ? (String(row.custom_ca_position) as Proposal["customCaPosition"]) : undefined,
    customCaPattern: row.custom_ca_pattern ? String(row.custom_ca_pattern) : undefined,
    customCaFeeSol:
      row.custom_ca_fee_sol === null || row.custom_ca_fee_sol === undefined ? undefined : Number(row.custom_ca_fee_sol)
  };
}

export async function createProposal(
  idea: CoinIdeaInput,
  createdBy: number,
  createdByUsername?: string
): Promise<Proposal> {
  await databaseReady;
  const result = await pool.query(
    `INSERT INTO proposals (
      launchpad, name, symbol, description, website, telegram, twitter, image,
      dev_buy_sol, dev_buy_eth, pumpfun_cashback, pumpfun_fee_shares, created_by, created_by_username, created_at,
      custom_ca_position, custom_ca_pattern, custom_ca_fee_sol
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), $15, $16, $17)
    RETURNING *`,
    [
      idea.launchpad,
      idea.name,
      idea.symbol.toUpperCase(),
      idea.description,
      idea.website ?? null,
      idea.telegram ?? null,
      idea.twitter ?? null,
      idea.image ?? null,
      idea.devBuySol ?? null,
      idea.devBuyEth ?? null,
      idea.pumpfunCashback ?? null,
      idea.pumpfunFeeShares ?? null,
      createdBy,
      createdByUsername ?? null,
      idea.customCaPattern ? idea.customCaPosition ?? null : null,
      idea.customCaPattern ?? null,
      idea.customCaPattern ? idea.customCaFeeSol ?? null : null
    ]
  );
  return mapProposal(result.rows[0]);
}

export async function updateProposalCashback(id: number, enabled: boolean): Promise<Proposal | undefined> {
  await databaseReady;
  const result = await pool.query(
    "UPDATE proposals SET pumpfun_cashback = $1 WHERE id = $2 AND status IN ('pending', 'approved') RETURNING *",
    [enabled, id]
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : getProposal(id);
}

export async function updateProposalFeeShares(id: number, feeShares?: string): Promise<Proposal | undefined> {
  await databaseReady;
  const result = await pool.query(
    "UPDATE proposals SET pumpfun_fee_shares = $1 WHERE id = $2 AND status IN ('pending', 'approved') RETURNING *",
    [feeShares?.trim() || null, id]
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : getProposal(id);
}

export async function getProposal(id: number): Promise<Proposal | undefined> {
  await databaseReady;
  const result = await pool.query("SELECT * FROM proposals WHERE id = $1", [id]);
  return result.rows[0] ? mapProposal(result.rows[0]) : undefined;
}

export async function listPendingProposals(limit = 10): Promise<Proposal[]> {
  await databaseReady;
  const result = await pool.query("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id ASC LIMIT $1", [limit]);
  return result.rows.map(mapProposal);
}

export async function approveProposal(id: number, adminId: number): Promise<Proposal | undefined> {
  await databaseReady;
  const result = await pool.query(
    "UPDATE proposals SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2 AND status = 'pending' RETURNING *",
    [adminId, id]
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : getProposal(id);
}

export async function rejectProposal(id: number, reason: string): Promise<Proposal | undefined> {
  await databaseReady;
  const result = await pool.query(
    "UPDATE proposals SET status = 'rejected', rejection_reason = $1 WHERE id = $2 AND status = 'pending' RETURNING *",
    [reason, id]
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : getProposal(id);
}

export async function createCustomCaOrder(proposalId: number, chatId: string): Promise<void> {
  await databaseReady;
  await pool.query(
    `INSERT INTO custom_ca_orders (proposal_id, chat_id, status, created_at)
     VALUES ($1, $2, 'pending', NOW()) ON CONFLICT (proposal_id) DO NOTHING`,
    [proposalId, chatId]
  );
}

export async function listPendingCustomCaOrders(): Promise<PendingCustomCaOrder[]> {
  await databaseReady;
  const result = await pool.query(
    `SELECT o.proposal_id, p.custom_ca_position, p.custom_ca_pattern
     FROM custom_ca_orders o JOIN proposals p ON p.id = o.proposal_id
     WHERE o.status = 'pending' AND p.custom_ca_pattern IS NOT NULL
     ORDER BY o.proposal_id ASC`
  );
  return result.rows.map((row) => ({
    proposalId: Number(row.proposal_id),
    position: String(row.custom_ca_position) === "start" ? "start" : "end",
    pattern: String(row.custom_ca_pattern)
  }));
}

export async function getCustomCaOrder(proposalId: number): Promise<CustomCaOrder | undefined> {
  await databaseReady;
  const result = await pool.query("SELECT * FROM custom_ca_orders WHERE proposal_id = $1", [proposalId]);
  return result.rows[0] ? mapCustomCaOrder(result.rows[0]) : undefined;
}

/** Stores a found keypair. Returns the order, or undefined when it was no longer pending. */
export async function fulfillCustomCaOrder(
  proposalId: number,
  address: string,
  encryptedSecretKey: string
): Promise<CustomCaOrder | undefined> {
  await databaseReady;
  const result = await pool.query(
    `UPDATE custom_ca_orders
     SET status = 'ready', address = $2, encrypted_secret_key = $3, ready_at = NOW()
     WHERE proposal_id = $1 AND status = 'pending' RETURNING *`,
    [proposalId, address, encryptedSecretKey]
  );
  return result.rows[0] ? mapCustomCaOrder(result.rows[0]) : undefined;
}

/** Claims a ready custom mint for a launch. A reservation from a crashed launch is reclaimed after 15 minutes. */
export async function reserveCustomCaOrder(proposalId: number): Promise<CustomCaOrder | undefined> {
  await databaseReady;
  const result = await pool.query(
    `UPDATE custom_ca_orders SET status = 'reserved', reserved_at = NOW()
     WHERE proposal_id = $1
       AND (status = 'ready' OR (status = 'reserved' AND reserved_at < NOW() - INTERVAL '15 minutes'))
     RETURNING *`,
    [proposalId]
  );
  return result.rows[0] ? mapCustomCaOrder(result.rows[0]) : undefined;
}

export async function markCustomCaOrderUsed(proposalId: number): Promise<void> {
  await databaseReady;
  await pool.query("UPDATE custom_ca_orders SET status = 'used', used_at = NOW() WHERE proposal_id = $1", [proposalId]);
}

export async function releaseCustomCaOrder(proposalId: number): Promise<void> {
  await databaseReady;
  await pool.query(
    "UPDATE custom_ca_orders SET status = 'ready', reserved_at = NULL WHERE proposal_id = $1 AND status = 'reserved'",
    [proposalId]
  );
}

export async function cancelCustomCaOrder(proposalId: number): Promise<void> {
  await databaseReady;
  await pool.query(
    "UPDATE custom_ca_orders SET status = 'cancelled' WHERE proposal_id = $1 AND status IN ('pending', 'ready')",
    [proposalId]
  );
}

function mapCustomCaOrder(row: QueryResultRow): CustomCaOrder {
  return {
    proposalId: Number(row.proposal_id),
    chatId: String(row.chat_id),
    status: String(row.status) as CustomCaOrder["status"],
    address: row.address ? String(row.address) : undefined,
    encryptedSecretKey: row.encrypted_secret_key ? String(row.encrypted_secret_key) : undefined,
    createdAt: asIso(row.created_at),
    readyAt: row.ready_at ? asIso(row.ready_at) : undefined
  };
}

export type PayoutScope = "group" | "user";
export type FeeChain = "solana" | "robinhood";

/** A claim that landed in a launch wallet; forwarded once its transfer to the payout wallet confirms. */
export interface FeeClaimRecord {
  id: number;
  chain: FeeChain;
  walletAddress: string;
  launchpad: string;
  /** Lamports or wei. */
  amount: bigint;
  claimTx: string;
  payoutAddress?: string;
  forwardTx?: string;
  forwardStartedAt?: string;
}

export interface FeeClaimInput {
  chain: FeeChain;
  walletAddress: string;
  launchpad: string;
  amount: bigint;
  claimTx: string;
  chatId?: string;
  actorId?: number;
}

export async function getPayoutWallets(scope: PayoutScope, scopeId: string): Promise<Partial<Record<FeeChain, string>>> {
  await databaseReady;
  const result = await pool.query("SELECT chain, address FROM payout_wallets WHERE scope = $1 AND scope_id = $2", [
    scope,
    scopeId
  ]);
  return Object.fromEntries(result.rows.map((row) => [String(row.chain), String(row.address)]));
}

export async function setPayoutWallet(
  scope: PayoutScope,
  scopeId: string,
  chain: FeeChain,
  address: string,
  setBy?: number
): Promise<void> {
  await databaseReady;
  await pool.query(
    `INSERT INTO payout_wallets (scope, scope_id, chain, address, set_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (scope, scope_id, chain) DO UPDATE SET address = EXCLUDED.address, set_by = EXCLUDED.set_by, updated_at = NOW()`,
    [scope, scopeId, chain, address, setBy ?? null]
  );
}

/** True for any wallet the bot itself holds, which must never be a payout wallet. */
export async function isLaunchWalletAddress(address: string): Promise<boolean> {
  await databaseReady;
  const result = await pool.query("SELECT 1 FROM wallets WHERE lower(address) = lower($1) LIMIT 1", [address]);
  return result.rows.length > 0;
}

/** Coins a wallet launched successfully on one launchpad, newest first. */
export async function listLaunchedMints(payerAddress: string, launchpad: string): Promise<string[]> {
  await databaseReady;
  const result = await pool.query(
    `SELECT mint FROM launch_attempts
     WHERE payer_address = $1 AND launchpad = $2 AND status = 'success' AND mint IS NOT NULL
     GROUP BY mint
     ORDER BY MAX(created_at) DESC`,
    [payerAddress, launchpad]
  );
  return result.rows.map((row) => String(row.mint));
}

export async function recordFeeClaim(input: FeeClaimInput): Promise<void> {
  await databaseReady;
  await pool.query(
    `INSERT INTO fee_claims (chain, wallet_address, launchpad, amount, claim_tx, chat_id, actor_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      input.chain,
      input.walletAddress,
      input.launchpad,
      input.amount.toString(),
      input.claimTx,
      input.chatId ?? null,
      input.actorId ?? null
    ]
  );
}

export async function listUnforwardedFeeClaims(walletAddress: string): Promise<FeeClaimRecord[]> {
  await databaseReady;
  const result = await pool.query(
    "SELECT * FROM fee_claims WHERE wallet_address = $1 AND forwarded_at IS NULL ORDER BY id",
    [walletAddress]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    chain: String(row.chain) as FeeChain,
    walletAddress: String(row.wallet_address),
    launchpad: String(row.launchpad),
    amount: BigInt(String(row.amount)),
    claimTx: String(row.claim_tx),
    payoutAddress: row.payout_address ? String(row.payout_address) : undefined,
    forwardTx: row.forward_tx ? String(row.forward_tx) : undefined,
    forwardStartedAt: row.forward_started_at ? asIso(row.forward_started_at) : undefined
  }));
}

/** Notes the transfer before it is broadcast, so a crash mid-send can't lead to sending the same fees twice. */
export async function markFeeClaimsForwarding(ids: number[], payoutAddress: string, forwardTx: string): Promise<void> {
  await databaseReady;
  await pool.query(
    `UPDATE fee_claims SET payout_address = $2, forward_tx = $3, forward_started_at = NOW()
     WHERE id = ANY($1::bigint[]) AND forwarded_at IS NULL`,
    [ids, payoutAddress, forwardTx]
  );
}

export async function markFeeClaimsForwarded(ids: number[]): Promise<void> {
  await databaseReady;
  await pool.query("UPDATE fee_claims SET forwarded_at = NOW() WHERE id = ANY($1::bigint[]) AND forwarded_at IS NULL", [ids]);
}

/** Frees claims whose transfer never landed so the next run sends them again. */
export async function clearFeeClaimsForwarding(ids: number[]): Promise<void> {
  await databaseReady;
  await pool.query(
    `UPDATE fee_claims SET payout_address = NULL, forward_tx = NULL, forward_started_at = NULL
     WHERE id = ANY($1::bigint[]) AND forwarded_at IS NULL`,
    [ids]
  );
}

export async function markLaunched(id: number, signature?: string): Promise<Proposal | undefined> {
  await databaseReady;
  const result = await pool.query(
    "UPDATE proposals SET status = 'launched', launch_signature = $1 WHERE id = $2 RETURNING *",
    [signature ?? null, id]
  );
  return result.rows[0] ? mapProposal(result.rows[0]) : undefined;
}

export async function createAuditLog(input: AuditLogInput): Promise<void> {
  await databaseReady;
  await pool.query(
    `INSERT INTO audit_logs (action, actor_id, actor_username, chat_id, proposal_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
    [
      input.action,
      input.actorId ?? null,
      input.actorUsername ?? null,
      input.chatId ?? null,
      input.proposalId ?? null,
      input.details === undefined ? null : JSON.stringify(input.details)
    ]
  );
}

export async function createLaunchAttempt(input: LaunchAttemptInput): Promise<number> {
  await databaseReady;
  const result = await pool.query(
    `INSERT INTO launch_attempts (
      proposal_id, launchpad, mode, payer_address, chat_id, actor_id, status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'running', NOW()) RETURNING id`,
    [input.proposalId, input.launchpad, input.mode, input.payerAddress ?? null, input.chatId ?? null, input.actorId ?? null]
  );
  return Number(result.rows[0].id);
}

export async function finishLaunchAttempt(id: number, update: LaunchAttemptUpdate): Promise<void> {
  await databaseReady;
  await pool.query(
    `UPDATE launch_attempts
     SET status = $1, signature = $2, mint = $3, error = $4, completed_at = NOW()
     WHERE id = $5`,
    [update.status, update.signature ?? null, update.mint ?? null, update.error ?? null, id]
  );
}

export async function countSuccessfulLaunchesSince(
  scope: "chat" | "actor",
  id: string | number,
  sinceIso: string
): Promise<number> {
  await databaseReady;
  const column = scope === "chat" ? "chat_id" : "actor_id";
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM launch_attempts WHERE ${column} = $1 AND status = 'success' AND created_at >= $2`,
    [String(id), sinceIso]
  );
  return Number(result.rows[0].count);
}

export async function recentLaunchAttempts(limit = 8): Promise<Array<{
  proposalId: number;
  launchpad: string;
  mode: string;
  status: string;
  signature?: string;
  mint?: string;
  error?: string;
  createdAt: string;
}>> {
  await databaseReady;
  const result = await pool.query(
    `SELECT proposal_id, launchpad, mode, status, signature, mint, error, created_at
     FROM launch_attempts ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    proposalId: Number(row.proposal_id),
    launchpad: String(row.launchpad),
    mode: String(row.mode),
    status: String(row.status),
    signature: row.signature ? String(row.signature) : undefined,
    mint: row.mint ? String(row.mint) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: asIso(row.created_at)
  }));
}

function mapLaunchJob(row: QueryResultRow): LaunchJob {
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
    createdAt: asIso(row.created_at),
    runAfter: asIso(row.run_after),
    startedAt: row.started_at ? asIso(row.started_at) : undefined,
    completedAt: row.completed_at ? asIso(row.completed_at) : undefined
  };
}

export async function enqueueLaunchJob(input: LaunchJobInput): Promise<LaunchJob> {
  await databaseReady;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM launch_jobs
       WHERE proposal_id = $1 AND mode = $2 AND status IN ('queued', 'running')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [input.proposalId, input.mode]
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return mapLaunchJob(existing.rows[0]);
    }
    const inserted = await client.query(
      `INSERT INTO launch_jobs (
        proposal_id, launchpad, mode, chat_id, actor_id, actor_username, created_at, run_after
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
      [input.proposalId, input.launchpad, input.mode, input.chatId, input.actorId ?? null, input.actorUsername ?? null]
    );
    await client.query("COMMIT");
    return mapLaunchJob(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(error)) {
      const existing = await getActiveLaunchJob(input.proposalId, input.mode);
      if (existing) return existing;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getLaunchJob(id: number): Promise<LaunchJob | undefined> {
  await databaseReady;
  const result = await pool.query("SELECT * FROM launch_jobs WHERE id = $1", [id]);
  return result.rows[0] ? mapLaunchJob(result.rows[0]) : undefined;
}

async function getActiveLaunchJob(proposalId: number, mode: LaunchJob["mode"]): Promise<LaunchJob | undefined> {
  const result = await pool.query(
    `SELECT * FROM launch_jobs
     WHERE proposal_id = $1 AND mode = $2 AND status IN ('queued', 'running')
     ORDER BY id DESC LIMIT 1`,
    [proposalId, mode]
  );
  return result.rows[0] ? mapLaunchJob(result.rows[0]) : undefined;
}

// A running job older than this is assumed to belong to a crashed process and is requeued.
const STALE_LAUNCH_JOB_INTERVAL = "15 minutes";

export async function claimNextLaunchJob(maxAttempts: number): Promise<LaunchJob | undefined> {
  await databaseReady;
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE launch_jobs SET status = 'queued', started_at = NULL
       WHERE status = 'running' AND started_at < NOW() - INTERVAL '${STALE_LAUNCH_JOB_INTERVAL}'`
    );
    const result = await client.query(
      `SELECT * FROM launch_jobs
       WHERE status = 'queued' AND run_after <= NOW() AND attempts < $1
       ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [maxAttempts]
    );
    if (!result.rows[0]) return undefined;
    const claimed = await client.query(
      `UPDATE launch_jobs
       SET status = 'running', attempts = attempts + 1, started_at = NOW()
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [result.rows[0].id]
    );
    return claimed.rows[0] ? mapLaunchJob(claimed.rows[0]) : undefined;
  });
}

/** When the next queued job becomes claimable or a running job turns stale, whichever is first. */
export async function nextLaunchJobRunAt(maxAttempts: number): Promise<Date | undefined> {
  await databaseReady;
  const result = await pool.query(
    `SELECT MIN(
       CASE WHEN status = 'queued' THEN run_after ELSE started_at + INTERVAL '${STALE_LAUNCH_JOB_INTERVAL}' END
     ) AS next_run_at
     FROM launch_jobs
     WHERE (status = 'queued' AND attempts < $1) OR status = 'running'`,
    [maxAttempts]
  );
  const nextRunAt = result.rows[0]?.next_run_at;
  return nextRunAt ? new Date(nextRunAt) : undefined;
}

export async function completeLaunchJob(id: number, signature?: string, mint?: string): Promise<void> {
  await databaseReady;
  await pool.query(
    `UPDATE launch_jobs SET status = 'success', signature = $1, mint = $2, completed_at = NOW() WHERE id = $3`,
    [signature ?? null, mint ?? null, id]
  );
}

export async function failLaunchJob(id: number, error: string, retryDelayMs: number, maxAttempts: number): Promise<void> {
  await databaseReady;
  const job = await getLaunchJob(id);
  if (!job) return;
  const willRetry = job.attempts < maxAttempts;
  await pool.query(
    `UPDATE launch_jobs
     SET status = $1, last_error = $2, run_after = $3, completed_at = $4
     WHERE id = $5`,
    [
      willRetry ? "queued" : "failed",
      error,
      new Date(Date.now() + retryDelayMs),
      willRetry ? null : new Date(),
      id
    ]
  );
}

export async function recentLaunchJobs(limit = 8): Promise<LaunchJob[]> {
  await databaseReady;
  const result = await pool.query("SELECT * FROM launch_jobs ORDER BY id DESC LIMIT $1", [limit]);
  return result.rows.map(mapLaunchJob);
}

export async function consumeVanityMint(suffix: string, proposalId: number): Promise<VanityMint | undefined> {
  await databaseReady;
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM vanity_mints
       WHERE status = 'available' AND suffix = $1
       ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [suffix]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const reserved = await client.query(
      `UPDATE vanity_mints
       SET status = 'reserved', reserved_at = NOW(), proposal_id = $1
       WHERE id = $2 AND status = 'available' RETURNING *`,
      [proposalId, row.id]
    );
    if (!reserved.rows[0]) return undefined;
    return mapVanityMint(reserved.rows[0]);
  });
}

export async function markVanityMintUsed(id: number): Promise<void> {
  await databaseReady;
  await pool.query("UPDATE vanity_mints SET status = 'used', used_at = NOW() WHERE id = $1", [id]);
}

export async function releaseVanityMint(id: number): Promise<void> {
  await databaseReady;
  await pool.query(
    `UPDATE vanity_mints
     SET status = 'available', reserved_at = NULL, proposal_id = NULL
     WHERE id = $1 AND status = 'reserved'`,
    [id]
  );
}

export async function countAvailableVanityMints(suffix: string): Promise<number> {
  await databaseReady;
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM vanity_mints WHERE status = 'available' AND suffix = $1",
    [suffix]
  );
  return Number(result.rows[0].count);
}

export async function quarantineInexactVanityMints(suffix: string): Promise<number> {
  await databaseReady;
  const result = await pool.query(
    "SELECT id, address FROM vanity_mints WHERE status = 'available' AND suffix = $1",
    [suffix]
  );
  const badIds = result.rows.filter((row) => !String(row.address).endsWith(suffix)).map((row) => Number(row.id));
  if (badIds.length === 0) return 0;
  await pool.query("UPDATE vanity_mints SET status = 'invalid' WHERE id = ANY($1::bigint[])", [badIds]);
  return badIds.length;
}

function mapVanityMint(row: QueryResultRow): VanityMint {
  return {
    id: Number(row.id),
    suffix: String(row.suffix),
    address: String(row.address),
    secretKeyBase58: String(row.secret_key_base58)
  };
}

async function withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
