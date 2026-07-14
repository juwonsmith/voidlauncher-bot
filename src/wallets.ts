import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { createWalletRecord, getWallet, type StoredWallet } from "./db.js";

export type WalletScope = "group" | "user" | "group_portal" | "group_evm" | "user_evm";

export interface WalletView {
  scope: WalletScope;
  scopeId: string;
  address: string;
  provider: "local" | "pumpportal" | "evm";
  hasApiKey: boolean;
  balanceSol?: number;
  balanceEth?: number;
  balanceError?: string;
  created: boolean;
}

export async function getOrCreateRobinhoodWallet(scope: "group" | "user", scopeId: string): Promise<WalletView> {
  const storageScope = robinhoodStorageScope(scope);
  const existing = getWallet(storageScope, scopeId);
  const wallet = existing ?? createEncryptedEvmWallet(storageScope, scopeId);
  return {
    scope: storageScope,
    scopeId,
    address: wallet.address,
    provider: wallet.provider,
    hasApiKey: false,
    created: !existing
  };
}

export async function getOrCreateWallet(scope: WalletScope, scopeId: string): Promise<WalletView> {
  const existing = getWallet(scope, scopeId);
  const wallet = existing ?? createEncryptedWallet(scope, scopeId);
  return {
    scope,
    scopeId,
    address: wallet.address,
    provider: wallet.provider,
    hasApiKey: Boolean(wallet.encryptedApiKey),
    created: !existing
  };
}

export async function getOrCreatePumpPortalWallet(scope: WalletScope, scopeId: string): Promise<WalletView> {
  const storageScope = pumpPortalStorageScope(scope);
  const existing = getWallet(storageScope, scopeId);
  if (existing) {
    if (existing.provider !== "pumpportal" || !existing.encryptedApiKey) {
      throw new Error(
        "This chat already has an old local wallet. Export it if needed, then use a new chat/database or migrate it before creating a PumpPortal launch wallet."
      );
    }

    return {
      scope,
      scopeId,
      address: existing.address,
      provider: existing.provider,
      hasApiKey: true,
      created: false
    };
  }

  const wallet = await createPumpPortalWallet(storageScope, scopeId);
  return {
    scope,
    scopeId,
    address: wallet.address,
    provider: wallet.provider,
    hasApiKey: Boolean(wallet.encryptedApiKey),
    created: true
  };
}

export async function getWalletView(scope: WalletScope, scopeId: string): Promise<WalletView | undefined> {
  const wallet = getWallet(scope, scopeId);
  if (!wallet) return undefined;

  return {
    scope,
    scopeId,
    address: wallet.address,
    provider: wallet.provider,
    hasApiKey: Boolean(wallet.encryptedApiKey),
    ...(await safeSolBalance(wallet.address)),
    created: false
  };
}

export function getWalletSummary(scope: WalletScope, scopeId: string): WalletView | undefined {
  const wallet = getWallet(scope, scopeId);
  if (!wallet) return undefined;

  return {
    scope,
    scopeId,
    address: wallet.address,
    provider: wallet.provider,
    hasApiKey: Boolean(wallet.encryptedApiKey),
    created: false
  };
}

export function decryptWalletSecret(wallet: StoredWallet): Uint8Array {
  const key = walletEncryptionKey();
  const [ivBase64, tagBase64, encryptedBase64] = wallet.encryptedSecretKey.split(".");
  if (!ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error("Wallet secret is not in the expected encrypted format.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final()
  ]);

  return new Uint8Array(decrypted);
}

export function exportWalletSecretBase58(scope: WalletScope, scopeId: string): { address: string; secretKey: string } {
  const wallet = getWallet(scope, scopeId);
  if (!wallet) throw new Error("Wallet not found.");

  const decrypted = Buffer.from(decryptWalletSecret(wallet)).toString("utf8");
  return {
    address: wallet.address,
    secretKey: decrypted
  };
}

export function exportPumpPortalWallet(scope: WalletScope, scopeId: string): {
  address: string;
  secretKey: string;
  apiKey: string;
} {
  const wallet = getWallet(pumpPortalStorageScope(scope), scopeId);
  if (!wallet) throw new Error("Wallet not found.");
  if (!wallet.encryptedApiKey) throw new Error("This wallet does not have a PumpPortal API key.");

  return {
    address: wallet.address,
    secretKey: Buffer.from(decryptWalletSecret(wallet)).toString("utf8"),
    apiKey: decryptSecretString(wallet.encryptedApiKey)
  };
}

export function getPumpPortalApiKey(scope: WalletScope, scopeId: string): { address: string; apiKey: string } {
  const wallet = getWallet(pumpPortalStorageScope(scope), scopeId);
  if (!wallet) throw new Error("Wallet not found.");
  if (!wallet.encryptedApiKey) {
    throw new Error("This wallet is not linked to PumpPortal. Run /groupwallet to create a PumpPortal launch wallet.");
  }

  return {
    address: wallet.address,
    apiKey: decryptSecretString(wallet.encryptedApiKey)
  };
}

export function getWalletSecretBase58(scope: WalletScope, scopeId: string): { address: string; secretKey: string } {
  return exportWalletSecretBase58(scope, scopeId);
}

export function getRobinhoodWalletSecret(scope: "group" | "user", scopeId: string): {
  address: `0x${string}`;
  privateKey: `0x${string}`;
} {
  const wallet = getWallet(robinhoodStorageScope(scope), scopeId);
  if (!wallet) throw new Error("Robinhood wallet not found. Create it with /rhgroupwallet or /rhmywallet.");
  if (wallet.provider !== "evm") throw new Error("Stored wallet is not a Robinhood/EVM wallet.");

  return {
    address: wallet.address as `0x${string}`,
    privateKey: Buffer.from(decryptWalletSecret(wallet)).toString("utf8") as `0x${string}`
  };
}

export async function getSolBalance(address: string): Promise<number> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.BALANCE_CHECK_ATTEMPTS; attempt += 1) {
    try {
      return await fetchSolBalance(address);
    } catch (error) {
      lastError = error;
      if (attempt < config.BALANCE_CHECK_ATTEMPTS) await delay(500 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getEthBalance(address: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.BALANCE_CHECK_TIMEOUT_MS);
  const response = await fetch(config.ROBINHOOD_RPC_URL, {
    method: "POST",
    signal: controller.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"]
    })
  }).finally(() => clearTimeout(timeout));

  const body = (await response.json().catch(() => ({}))) as {
    result?: string;
    error?: { message?: string };
  };

  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `Robinhood RPC balance request failed: ${response.status} ${response.statusText}`);
  }
  if (!body.result) throw new Error("Robinhood RPC balance response did not include a value.");

  return Number(BigInt(body.result)) / 1e18;
}

async function fetchSolBalance(address: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.BALANCE_CHECK_TIMEOUT_MS);
  const response = await fetch(config.SOLANA_RPC_URL, {
    method: "POST",
    signal: controller.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [address]
    })
  }).finally(() => clearTimeout(timeout));

  const body = (await response.json().catch(() => ({}))) as {
    result?: { value?: number };
    error?: { message?: string };
  };

  if (!response.ok || body.error) {
    throw new Error(body.error?.message ?? `RPC balance request failed: ${response.status} ${response.statusText}`);
  }

  if (typeof body.result?.value !== "number") {
    throw new Error("RPC balance response did not include a lamport value.");
  }

  return body.result.value / 1_000_000_000;
}

async function safeSolBalance(address: string): Promise<Pick<WalletView, "balanceSol" | "balanceError">> {
  try {
    return { balanceSol: await getSolBalance(address) };
  } catch (error) {
    return { balanceError: error instanceof Error ? error.message : String(error) };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEncryptedWallet(scope: WalletScope, scopeId: string): StoredWallet {
  const keypair = nacl.sign.keyPair();
  const address = bs58.encode(keypair.publicKey);
  const secretKeyBase58 = bs58.encode(keypair.secretKey);
  return createWalletRecord(scope, scopeId, address, encryptSecret(secretKeyBase58));
}

function createEncryptedEvmWallet(scope: WalletScope, scopeId: string): StoredWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return createWalletRecord(scope, scopeId, account.address, encryptSecret(privateKey), "evm");
}

async function createPumpPortalWallet(scope: WalletScope, scopeId: string): Promise<StoredWallet> {
  const response = await fetch("https://pumpportal.fun/api/create-wallet", { method: "GET" });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`PumpPortal wallet creation failed: ${response.status} ${response.statusText}`);
  }

  const address = stringField(body, ["publicKey", "public_key", "walletPublicKey", "wallet"]);
  const secretKey = stringField(body, ["privateKey", "private_key", "secretKey", "walletPrivateKey"]);
  const apiKey = stringField(body, ["apiKey", "api_key", "apikey"]);
  if (!address || !secretKey || !apiKey) {
    throw new Error(`PumpPortal wallet creation returned unexpected fields: ${Object.keys(body).join(", ")}`);
  }

  return createWalletRecord(scope, scopeId, address, encryptSecret(secretKey), "pumpportal", encryptSecret(apiKey));
}

function encryptSecret(secret: string): string {
  const key = walletEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptSecretString(encryptedSecret: string): string {
  const key = walletEncryptionKey();
  const [ivBase64, tagBase64, encryptedBase64] = encryptedSecret.split(".");
  if (!ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error("Encrypted secret is not in the expected format.");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function stringField(body: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = body[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pumpPortalStorageScope(scope: WalletScope): WalletScope {
  return scope === "group" ? "group_portal" : scope;
}

function robinhoodStorageScope(scope: "group" | "user"): WalletScope {
  return scope === "group" ? "group_evm" : "user_evm";
}

function walletEncryptionKey(): Buffer {
  if (!config.WALLET_ENCRYPTION_KEY) {
    return localWalletKey();
  }

  const raw = config.WALLET_ENCRYPTION_KEY.trim();
  const bytes = raw.length === 64 && /^[a-f0-9]+$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error("WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }

  return bytes;
}

function localWalletKey(): Buffer {
  const keyPath = path.join(path.dirname(config.DATABASE_PATH), "wallet.key");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString("base64"), { encoding: "utf8", flag: "wx" });
  }

  const bytes = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
  if (bytes.length !== 32) {
    throw new Error(`Local wallet encryption key at ${keyPath} is invalid.`);
  }

  return bytes;
}
