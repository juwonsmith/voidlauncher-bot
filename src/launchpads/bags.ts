import { BagsSDK } from "@bagsfm/bags-sdk";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { validateImageFile } from "../imageValidation.js";
import type { LaunchResult, Proposal } from "../types.js";

export async function launchWithBags(proposal: Proposal, signerSecretKeyBase58: string): Promise<LaunchResult> {
  if (!config.BAGS_API_KEY) {
    throw new Error("BAGS_API_KEY is required for BagsApp launches.");
  }
  if (!proposal.image) {
    throw new Error("An image is required for BagsApp launches.");
  }
  if (config.BAGS_MINT_SUFFIX.trim()) {
    throw new Error(
      "Bags vanity mints are not supported by the current Bags SDK launch flow. " +
        "The Bags create-token-info endpoint generates the token mint itself, so launching now would not guarantee a CA ending in bags."
    );
  }

  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const sdk = new BagsSDK(config.BAGS_API_KEY, connection, "confirmed");
  const launchWallet = Keypair.fromSecretKey(bs58.decode(signerSecretKeyBase58));
  const image = proposal.image;

  console.log(`[launch:${proposal.id}] creating Bags metadata`);
  const tokenInfo = await callBagsApi("Bags metadata creation", async () =>
    sdk.tokenLaunch.createTokenInfoAndMetadata({
      name: proposal.name,
      symbol: proposal.symbol,
      description: proposal.description,
      telegram: proposal.telegram,
      twitter: proposal.twitter,
      website: proposal.website,
      ...(image.startsWith("telegram:") ? { image: await bagsImageInput(image, proposal.symbol) } : { imageUrl: image })
    })
  );
  const tokenMint = new PublicKey(tokenInfo.tokenMint);

  console.log(`[launch:${proposal.id}] creating Bags fee-share config`);
  const configResult = await callBagsApi("Bags fee-share config creation", () =>
    sdk.config.createBagsFeeShareConfig({
      feeClaimers: [{ user: launchWallet.publicKey, userBps: 10_000 }],
      payer: launchWallet.publicKey,
      admin: launchWallet.publicKey,
      baseMint: tokenMint
    })
  );

  for (const transaction of configResult.transactions ?? []) {
    await sendBagsTransaction("Bags fee-share config transaction", connection, transaction, launchWallet);
  }

  console.log(`[launch:${proposal.id}] creating Bags launch transaction`);
  const launchTransaction = await callBagsApi("Bags launch transaction creation", () =>
    sdk.tokenLaunch.createLaunchTransaction({
      metadataUrl: tokenInfo.tokenMetadata,
      tokenMint,
      launchWallet: launchWallet.publicKey,
      initialBuyLamports: Math.round((proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL) * 1_000_000_000),
      configKey: new PublicKey(configResult.meteoraConfigKey)
    })
  );
  const signature = await sendBagsTransaction("Bags launch transaction", connection, launchTransaction, launchWallet);

  return {
    launchpad: proposal.launchpad,
    dryRun: false,
    mint: tokenMint.toBase58(),
    signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    metadataUri: tokenInfo.tokenMetadata,
    message: `Launched ${proposal.name} ($${proposal.symbol}) on BagsApp.`
  };
}

async function sendBagsTransaction(
  label: string,
  connection: Connection,
  transaction: VersionedTransaction,
  signer: Keypair
): Promise<string> {
  try {
    transaction.sign([signer]);
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed"
    });

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
      const value = status.value;
      if (value?.err) {
        throw new Error(`${label} failed on-chain: ${safeJson(value.err)}. Solscan: https://solscan.io/tx/${signature}`);
      }
      if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") {
        return signature;
      }
      await delay(2000);
    }

    throw new Error(`${label} was submitted but not confirmed after 60s. Solscan: https://solscan.io/tx/${signature}`);
  } catch (error) {
    throw new Error(`${label} failed: ${bagsErrorMessage(error)}`);
  }
}

export async function callBagsApi<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRetryableBagsError(error) || attempt === 5) break;
      console.warn(`[bags] ${label} failed. Attempt ${attempt}/5: ${bagsErrorMessage(error)}`);
      await delay(2000 * attempt);
    }
  }

  throw new Error(`${label} failed: ${bagsErrorMessage(lastError)}`);
}

function bagsErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const parts: string[] = [];
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") parts.push(record.message);
    if (typeof record.status === "number") parts.push(`status ${record.status}`);
    if (typeof record.url === "string") parts.push(`endpoint ${record.url}`);
    if (record.data !== undefined) parts.push(`response ${safeJson(record.data)}`);
    if (parts.length > 0) return parts.join(" | ");
  }

  return error instanceof Error ? error.message : String(error);
}

function isRetryableBagsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as Record<string, unknown>).status;
  return status === 408 || status === 425 || status === 429 || (typeof status === "number" && status >= 500);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 800);
  } catch {
    return String(value);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bagsImageInput(image: string, symbol: string): Promise<{
  value: Buffer;
  options: { filename: string; contentType: string };
}> {
  const file = await fetchFile(image, `${symbol}-bags-image`);
  const validated = await validateImageFile(file);
  const buffer = Buffer.from(await validated.file.arrayBuffer());
  return {
    value: buffer,
    options: {
      filename: validated.file.name || `${symbol}.png`,
      contentType: validated.file.type || "image/png"
    }
  };
}

async function fetchFile(url: string, fallbackName: string): Promise<File> {
  const resolvedUrl = url.startsWith("telegram:") ? await resolveTelegramFileUrl(url) : url;
  const response = await fetch(resolvedUrl);
  if (!response.ok) {
    throw new Error(`Could not download image: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const extension = extensionFromContentType(contentType);
  const blob = await response.blob();
  return new File([blob], `${fallbackName}${extension}`, { type: contentType });
}

async function resolveTelegramFileUrl(value: string): Promise<string> {
  const fileId = value.slice("telegram:".length);
  const response = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(config.TELEGRAM_BOT_TOKEN)}/getFile?file_id=${encodeURIComponent(
      fileId
    )}`
  );
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { file_path?: string };
    description?: string;
  };

  if (!response.ok || !body.ok || !body.result?.file_path) {
    throw new Error(body.description ?? `Could not resolve Telegram image: ${response.status} ${response.statusText}`);
  }

  return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${body.result.file_path}`;
}

function extensionFromContentType(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return "";
}
