import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { config } from "../config.js";
import { consumeVanityMint, markVanityMintUsed, releaseVanityMint } from "../db.js";
import { imageValidationSummary, validateImageFile } from "../imageValidation.js";
import type { LaunchResult, Proposal } from "../types.js";
import { getSolBalance } from "../wallets.js";

type PumpSdkPackage = {
  getBuyTokenAmountFromSolAmount: (args: {
    global: unknown;
    feeConfig: unknown;
    mintSupply: unknown;
    bondingCurve: unknown;
    amount: BN;
  }) => BN;
  OnlinePumpSdk: new (connection: Connection) => { fetchGlobal: () => Promise<unknown> };
  PumpSdk: new () => {
    createV2AndBuyInstructions: (args: Record<string, unknown>) => Promise<unknown[]>;
    createAndBuyInstructions: (args: Record<string, unknown>) => Promise<unknown[]>;
    createSharingConfigWithSocialRecipients: (args: Record<string, unknown>) => Promise<unknown[]>;
  };
};

interface PinataResponse {
  data?: {
    cid?: string;
  };
}

interface PumpPortalResponse {
  signature?: string;
  error?: string;
}

interface MintKeypair {
  publicKey?: Uint8Array;
  secretKeyBase58: string;
  address: string;
  source: "random" | "pool";
  poolId?: number;
}

interface FeeSharingResult {
  signature?: string;
  url?: string;
  error?: string;
}

export interface PlatformFeeResult {
  signature?: string;
  url?: string;
  error?: string;
}

class UnknownConfirmationError extends Error {}
class NonRetryableLaunchError extends Error {}
class UnlandedLaunchError extends Error {}

async function loadPumpSdk(): Promise<PumpSdkPackage> {
  const modulePath = "../../node_modules/@pump-fun/pump-sdk/dist/esm/index.js";
  return (await import(modulePath)) as PumpSdkPackage;
}

export async function launchWithPumpPortal(proposal: Proposal): Promise<LaunchResult> {
  if (proposal.launchpad === "pumpfun") {
    if (!config.PUMPFUN_SIGNER_PRIVATE_KEY) {
      throw new Error("PUMPFUN_SIGNER_PRIVATE_KEY is required for Pump.fun SDK launches outside group wallets.");
    }
    return launchWithPumpFunSdk(proposal, config.PUMPFUN_SIGNER_PRIVATE_KEY);
  }

  if (!config.PUMPPORTAL_API_KEY) {
    throw new Error("PUMPPORTAL_API_KEY is required for Bonk launches when DRY_RUN=false.");
  }
  return launchWithPumpPortalApiKey(proposal, config.PUMPPORTAL_API_KEY);
}

export async function launchWithPumpPortalApiKey(proposal: Proposal, pumpPortalApiKey: string): Promise<LaunchResult> {
  if (!proposal.image) {
    throw new Error("An image URL is required for launch metadata.");
  }

  if (proposal.launchpad === "bonk") {
    return launchBonkWithFreshMints(proposal, pumpPortalApiKey);
  }

  if (proposal.launchpad === "pumpfun") {
    throw new Error("Pump.fun launches now use the official Pump.fun SDK. Use group wallet launch or set PUMPFUN_SIGNER_PRIVATE_KEY.");
  }

  const mintKeypair = await getMintKeypair(proposal);

  try {
    console.log(`[launch:${proposal.id}] preparing metadata for ${proposal.launchpad}`);
    const metadataUri = await uploadPumpMetadataToPinata(proposal);

    console.log(`[launch:${proposal.id}] metadata ready: ${metadataUri}`);
    const signature = await sendCreateWithRetries(proposal, mintKeypair, metadataUri, pumpPortalApiKey);
    if (mintKeypair.poolId) await markVanityMintUsed(mintKeypair.poolId);

    return {
      launchpad: proposal.launchpad,
      dryRun: false,
      mint: mintKeypair.address,
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      metadataUri,
      message: `Launched ${proposal.name} ($${proposal.symbol}).`
    };
  } catch (error) {
    if (mintKeypair.poolId) {
      if (error instanceof UnknownConfirmationError) await markVanityMintUsed(mintKeypair.poolId);
      else await releaseVanityMint(mintKeypair.poolId);
    }
    throw error;
  }
}

export async function launchWithPumpFunSdk(
  proposal: Proposal,
  signerSecretKeyBase58: string,
  signerAddress?: string
): Promise<LaunchResult> {
  if (!proposal.image) {
    throw new Error("An image URL is required for Pump.fun metadata.");
  }
  if (proposal.launchpad !== "pumpfun") {
    throw new Error("Official Pump.fun SDK launch only supports Pump.fun proposals.");
  }

  const signerKeypair = Keypair.fromSecretKey(bs58.decode(signerSecretKeyBase58));
  if (signerAddress && signerKeypair.publicKey.toBase58() !== signerAddress) {
    throw new Error("Signer wallet secret does not match wallet address.");
  }

  await assertLocalWalletFunded(
    signerKeypair.publicKey.toBase58(),
    proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL,
    priorityFeeForLaunchpad(proposal.launchpad)
  );
  validatePumpFunFeeShares(proposal, signerKeypair.publicKey);

  const mintKeypair = await getMintKeypair(proposal);
  const mintSigner = Keypair.fromSecretKey(bs58.decode(mintKeypair.secretKeyBase58));

  try {
    console.log(`[launch:${proposal.id}] preparing Pump.fun SDK metadata`);
    const metadataUri = await uploadPumpMetadataToPinata(proposal);
    console.log(`[launch:${proposal.id}] metadata ready: ${metadataUri}`);

    const signature = await sendPumpFunSdkCreateWithRetries(proposal, signerKeypair, mintSigner, mintKeypair, metadataUri);
    const feeSharing: FeeSharingResult = await configurePumpFunFeeSharingIfEnabled(proposal, signerKeypair, mintSigner.publicKey).catch(
      (error) => ({ error: errorMessage(error) })
    );
    const platformFee: PlatformFeeResult = await sendPlatformFeeIfEnabled(
      signerSecretKeyBase58,
      signerKeypair.publicKey.toBase58()
    ).catch((error): PlatformFeeResult => ({ error: errorMessage(error) }));
    if (mintKeypair.poolId) await markVanityMintUsed(mintKeypair.poolId);

    return {
      launchpad: proposal.launchpad,
      dryRun: false,
      mint: mintKeypair.address,
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      metadataUri,
      feeSharingSignature: feeSharing.signature,
      feeSharingUrl: feeSharing.url,
      feeSharingError: feeSharing.error,
      platformFeeSignature: platformFee.signature,
      platformFeeUrl: platformFee.url,
      platformFeeError: platformFee.error,
      message: `Launched ${proposal.name} ($${proposal.symbol}).`
    };
  } catch (error) {
    if (mintKeypair.poolId) {
      if (error instanceof UnknownConfirmationError) await markVanityMintUsed(mintKeypair.poolId);
      else await releaseVanityMint(mintKeypair.poolId);
    }
    throw error;
  }
}

async function launchBonkWithFreshMints(proposal: Proposal, pumpPortalApiKey: string): Promise<LaunchResult> {
  console.log(`[launch:${proposal.id}] preparing metadata for bonk`);
  const metadataUri = await uploadBonkMetadata(proposal);
  console.log(`[launch:${proposal.id}] metadata ready: ${metadataUri}`);

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.LAUNCH_MAX_ATTEMPTS; attempt += 1) {
    const mintKeypair = await getMintKeypair(proposal);
    let submitted = false;

    try {
      console.log(`[launch:${proposal.id}] sending Bonk create request (${attempt}/${config.LAUNCH_MAX_ATTEMPTS})`);
      const signature = await sendCreateRequest(proposal, mintKeypair, metadataUri, pumpPortalApiKey);
      submitted = true;
      console.log(`[launch:${proposal.id}] launch signature: ${signature}`);
      await waitForBonkLanding(signature, proposal.id, mintKeypair.address);
      if (mintKeypair.poolId) await markVanityMintUsed(mintKeypair.poolId);

      return {
        launchpad: proposal.launchpad,
        dryRun: false,
        mint: mintKeypair.address,
        signature,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        metadataUri,
        message: `Launched ${proposal.name} ($${proposal.symbol}).`
      };
    } catch (error) {
      if (mintKeypair.poolId) {
        if (submitted || error instanceof UnlandedLaunchError || error instanceof UnknownConfirmationError) {
          await markVanityMintUsed(mintKeypair.poolId);
        } else {
          await releaseVanityMint(mintKeypair.poolId);
        }
      }

      if (error instanceof NonRetryableLaunchError) throw error;
      lastError = error;
      console.warn(
        `[launch:${proposal.id}] Bonk launch attempt ${attempt}/${config.LAUNCH_MAX_ATTEMPTS} failed with mint ${
          mintKeypair.address
        }: ${errorMessage(error)}`
      );
      if (attempt < config.LAUNCH_MAX_ATTEMPTS) await delay(config.LAUNCH_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Bonk launch failed after ${config.LAUNCH_MAX_ATTEMPTS} fresh mint attempts: ${errorMessage(lastError)}`);
}

export async function launchWithPumpPortalLocal(
  proposal: Proposal,
  signerSecretKeyBase58: string,
  signerAddress: string
): Promise<LaunchResult> {
  if (!proposal.image) {
    throw new Error("An image URL is required for launch metadata.");
  }

  const signerKeypair = Keypair.fromSecretKey(bs58.decode(signerSecretKeyBase58));
  if (signerKeypair.publicKey.toBase58() !== signerAddress) {
    throw new Error("Signer wallet secret does not match wallet address.");
  }
  await assertLocalWalletFunded(
    signerAddress,
    proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL,
    priorityFeeForLaunchpad(proposal.launchpad)
  );

  const mintKeypair = await getMintKeypair(proposal);
  const mintSigner = Keypair.fromSecretKey(bs58.decode(mintKeypair.secretKeyBase58));

  try {
    console.log(`[launch:${proposal.id}] preparing metadata for local ${proposal.launchpad}`);
    const metadataUri =
      proposal.launchpad === "bonk" ? await uploadBonkMetadata(proposal) : await uploadPumpMetadataToPinata(proposal);

    const signature = await sendLocalCreateWithRetries(proposal, signerKeypair, mintSigner, mintKeypair, metadataUri);
    const platformFee: PlatformFeeResult = await sendPlatformFeeIfEnabled(
      signerSecretKeyBase58,
      signerKeypair.publicKey.toBase58()
    ).catch((error): PlatformFeeResult => ({ error: errorMessage(error) }));
    if (mintKeypair.poolId) await markVanityMintUsed(mintKeypair.poolId);

    return {
      launchpad: proposal.launchpad,
      dryRun: false,
      mint: mintKeypair.address,
      signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      metadataUri,
      platformFeeSignature: platformFee.signature,
      platformFeeUrl: platformFee.url,
      platformFeeError: platformFee.error,
      message: `Launched ${proposal.name} ($${proposal.symbol}).`
    };
  } catch (error) {
    if (mintKeypair.poolId) {
      if (error instanceof UnknownConfirmationError) await markVanityMintUsed(mintKeypair.poolId);
      else await releaseVanityMint(mintKeypair.poolId);
    }
    throw error;
  }
}

async function assertLocalWalletFunded(address: string, devBuySol: number, priorityFeeSol: number): Promise<void> {
  validatePlatformFeeConfig();
  const balance = await getSolBalance(address);
  const platformFeeSol = configuredPlatformFeeSol();
  const required = devBuySol + priorityFeeSol + platformFeeSol + config.LOCAL_LAUNCH_MIN_SOL_BUFFER;
  if (balance < required) {
    throw new NonRetryableLaunchError(
      `Local launch wallet needs more SOL. Balance: ${balance.toFixed(6)} SOL. ` +
        `Required minimum: ${required.toFixed(6)} SOL (${devBuySol} dev buy + ${platformFeeSol} platform fee + fees/rent buffer). ` +
        `Fund this wallet, or lower DevBuySol. Address: ${address}`
    );
  }
}

export async function sendPlatformFeeIfEnabled(
  signerSecretKeyBase58: string,
  signerAddress?: string
): Promise<PlatformFeeResult> {
  const platformFeeSol = configuredPlatformFeeSol();
  if (platformFeeSol <= 0) return {};

  const treasury = platformTreasuryPublicKey();
  const signerKeypair = Keypair.fromSecretKey(bs58.decode(signerSecretKeyBase58));
  if (signerAddress && signerKeypair.publicKey.toBase58() !== signerAddress) {
    throw new Error("Platform fee signer secret does not match wallet address.");
  }

  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const lamports = Math.round(platformFeeSol * LAMPORTS_PER_SOL);
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: signerKeypair.publicKey,
      toPubkey: treasury,
      lamports
    })
  );
  transaction.feePayer = signerKeypair.publicKey;
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.sign(signerKeypair);

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    skipPreflight: false
  });
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `Platform fee transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}. ` +
        `Solscan: https://solscan.io/tx/${signature}`
    );
  }

  return { signature, url: `https://solscan.io/tx/${signature}` };
}

function configuredPlatformFeeSol(): number {
  return config.PLATFORM_FEE_SOL > 0 ? config.PLATFORM_FEE_SOL : 0;
}

function validatePlatformFeeConfig(): void {
  if (configuredPlatformFeeSol() <= 0) return;
  platformTreasuryPublicKey();
}

function platformTreasuryPublicKey(): PublicKey {
  if (!config.PLATFORM_TREASURY_WALLET) {
    throw new NonRetryableLaunchError("PLATFORM_TREASURY_WALLET is required when PLATFORM_FEE_SOL is greater than 0.");
  }

  try {
    return new PublicKey(config.PLATFORM_TREASURY_WALLET);
  } catch {
    throw new NonRetryableLaunchError("PLATFORM_TREASURY_WALLET must be a valid Solana wallet address.");
  }
}

function priorityFeeForLaunchpad(launchpad: Proposal["launchpad"]): number {
  if (launchpad === "bonk") return Math.max(config.DEFAULT_PRIORITY_FEE_SOL, 0.0005);
  return config.DEFAULT_PRIORITY_FEE_SOL;
}

async function sendLocalCreateWithRetries(
  proposal: Proposal,
  signerKeypair: Keypair,
  mintSigner: Keypair,
  mintKeypair: MintKeypair,
  metadataUri: string
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.LAUNCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      console.log(`[launch:${proposal.id}] requesting local transaction (${attempt}/${config.LAUNCH_MAX_ATTEMPTS})`);
      const signature = await sendLocalCreateRequest(proposal, signerKeypair, mintSigner, mintKeypair, metadataUri);
      console.log(`[launch:${proposal.id}] local launch signature: ${signature}`);
      await waitForSubmittedOrConfirmedSignature(signature, proposal, mintKeypair.address);
      return signature;
    } catch (error) {
      if (error instanceof UnknownConfirmationError || error instanceof NonRetryableLaunchError) throw error;
      lastError = error;
      console.warn(
        `[launch:${proposal.id}] local launch attempt ${attempt}/${config.LAUNCH_MAX_ATTEMPTS} failed: ${errorMessage(
          error
        )}`
      );
      if (attempt < config.LAUNCH_MAX_ATTEMPTS) await delay(config.LAUNCH_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Local launch failed after ${config.LAUNCH_MAX_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}

async function sendPumpFunSdkCreateWithRetries(
  proposal: Proposal,
  signerKeypair: Keypair,
  mintSigner: Keypair,
  mintKeypair: MintKeypair,
  metadataUri: string
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.LAUNCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      console.log(`[launch:${proposal.id}] sending Pump.fun SDK create (${attempt}/${config.LAUNCH_MAX_ATTEMPTS})`);
      const signature = await sendPumpFunSdkCreateRequest(proposal, signerKeypair, mintSigner, mintKeypair, metadataUri);
      console.log(`[launch:${proposal.id}] Pump.fun SDK launch signature: ${signature}`);
      await waitForSubmittedOrConfirmedSignature(signature, proposal, mintKeypair.address);
      return signature;
    } catch (error) {
      if (error instanceof UnknownConfirmationError || error instanceof NonRetryableLaunchError) throw error;
      lastError = error;
      console.warn(
        `[launch:${proposal.id}] Pump.fun SDK attempt ${attempt}/${config.LAUNCH_MAX_ATTEMPTS} failed: ${errorMessage(
          error
        )}`
      );
      if (attempt < config.LAUNCH_MAX_ATTEMPTS) await delay(config.LAUNCH_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Pump.fun SDK launch failed after ${config.LAUNCH_MAX_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}

async function sendPumpFunSdkCreateRequest(
  proposal: Proposal,
  signerKeypair: Keypair,
  mintSigner: Keypair,
  mintKeypair: MintKeypair,
  metadataUri: string
): Promise<string> {
  const mintAddress = mintSigner.publicKey.toBase58();
  if (mintAddress !== mintKeypair.address) {
    throw new Error(`Prepared mint address mismatch: ${mintKeypair.address} != ${mintAddress}.`);
  }

  const { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PumpSdk } = await loadPumpSdk();
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const onlineSdk = new OnlinePumpSdk(connection);
  const sdk = new PumpSdk();
  const global = await onlineSdk.fetchGlobal();
  const devBuyLamports = Math.round((proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL) * LAMPORTS_PER_SOL);
  const solAmount = new BN(devBuyLamports);
  const tokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig: null,
    mintSupply: null,
    bondingCurve: null,
    amount: solAmount
  });

  const createInstructions = (proposal.pumpfunCashback ?? config.PUMPFUN_CASHBACK)
    ? await sdk.createV2AndBuyInstructions({
        global,
        mint: mintSigner.publicKey,
        name: proposal.name,
        symbol: proposal.symbol,
        uri: metadataUri,
        creator: signerKeypair.publicKey,
        user: signerKeypair.publicKey,
        solAmount,
        amount: tokenAmount,
        mayhemMode: false,
        cashback: true
      })
    : await sdk.createAndBuyInstructions({
        global,
        mint: mintSigner.publicKey,
        name: proposal.name,
        symbol: proposal.symbol,
        uri: metadataUri,
        creator: signerKeypair.publicKey,
        user: signerKeypair.publicKey,
        solAmount,
        amount: tokenAmount
      });

  const transaction = new Transaction().add(...(createInstructions as Parameters<Transaction["add"]>));
  transaction.feePayer = signerKeypair.publicKey;
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.sign(signerKeypair, mintSigner);

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new NonRetryableLaunchError(
      `Pump.fun SDK simulation failed: ${JSON.stringify(simulation.value.err)}${
        simulation.value.logs?.length ? ` | logs: ${simulation.value.logs.slice(-8).join(" | ")}` : ""
      }`
    );
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    skipPreflight: false
  });

  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `Pump.fun SDK transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}. ` +
        `Solscan: https://solscan.io/tx/${signature}`
    );
  }

  return signature;
}

async function configurePumpFunFeeSharingIfEnabled(
  proposal: Proposal,
  signerKeypair: Keypair,
  mint: PublicKey
): Promise<FeeSharingResult> {
  const shareholders = parsePumpFunFeeShares(proposal, signerKeypair.publicKey);
  if (shareholders.length === 0) return {};

  const { PumpSdk } = await loadPumpSdk();
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const sdk = new PumpSdk();
  const instructions = await sdk.createSharingConfigWithSocialRecipients({
    creator: signerKeypair.publicKey,
    mint,
    pool: null,
    newShareholders: shareholders.map((shareholder) => ({
      address: shareholder.address,
      shareBps: shareholder.shareBps
    }))
  });

  const transaction = new Transaction().add(...(instructions as Parameters<Transaction["add"]>));
  transaction.feePayer = signerKeypair.publicKey;
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.sign(signerKeypair);

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    skipPreflight: false
  });
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    },
    "confirmed"
  );
  if (confirmation.value.err) {
    throw new Error(
      `Pump.fun fee sharing transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}. ` +
        `Solscan: https://solscan.io/tx/${signature}`
    );
  }

  return { signature, url: `https://solscan.io/tx/${signature}` };
}

function validatePumpFunFeeShares(proposal: Proposal, creatorAddress: PublicKey): void {
  parsePumpFunFeeShares(proposal, creatorAddress);
}

function parsePumpFunFeeShares(
  proposal: Proposal,
  creatorAddress: PublicKey
): Array<{ address: PublicKey; shareBps: number }> {
  const raw = (proposal.pumpfunFeeShares ?? config.PUMPFUN_FEE_SHARES).trim();
  if (!raw) return [];

  const shares = raw.split(",").map((part) => {
    let [addressText, bpsText] = part.split(":").map((value) => value?.trim());
    if (!addressText || !bpsText) {
      throw new NonRetryableLaunchError(
        "PUMPFUN_FEE_SHARES must use address:bps pairs, for example ADDRESS1:8000,ADDRESS2:2000."
      );
    }
    if (addressText.toLowerCase() === "creator") {
      addressText = creatorAddress.toBase58();
    }

    const shareBps = Number(bpsText);
    if (!Number.isInteger(shareBps) || shareBps <= 0) {
      throw new NonRetryableLaunchError(`Invalid Pump.fun fee share bps for ${addressText}: ${bpsText}.`);
    }

    try {
      return { address: new PublicKey(addressText), shareBps };
    } catch {
      throw new NonRetryableLaunchError(`Invalid Pump.fun fee share address: ${addressText}.`);
    }
  });

  const total = shares.reduce((sum, share) => sum + share.shareBps, 0);
  if (total !== 10000) {
    throw new NonRetryableLaunchError(`PUMPFUN_FEE_SHARES must total 10000 bps. Current total: ${total}.`);
  }

  return shares;
}

async function sendLocalCreateRequest(
  proposal: Proposal,
  signerKeypair: Keypair,
  mintSigner: Keypair,
  mintKeypair: MintKeypair,
  metadataUri: string
): Promise<string> {
  const mintAddress = mintSigner.publicKey.toBase58();
  if (mintAddress !== mintKeypair.address) {
    throw new Error(`Prepared mint address mismatch: ${mintKeypair.address} != ${mintAddress}.`);
  }
  const payload = {
    publicKey: signerKeypair.publicKey.toBase58(),
    action: "create",
    tokenMetadata: {
      name: proposal.name,
      symbol: proposal.symbol,
      uri: metadataUri
    },
    mint: mintAddress,
    denominatedInSol: "true",
    amount: proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL,
    slippage: config.DEFAULT_SLIPPAGE_PERCENT,
    priorityFee: priorityFeeForLaunchpad(proposal.launchpad),
    pool: proposal.launchpad === "bonk" ? "bonk" : "pump",
  };

  console.log(
    `[launch:${proposal.id}] local create payload: ${JSON.stringify({
      publicKey: payload.publicKey,
      action: payload.action,
      tokenMetadata: payload.tokenMetadata,
      mint: payload.mint,
      denominatedInSol: payload.denominatedInSol,
      amount: payload.amount,
      slippage: payload.slippage,
      priorityFee: payload.priorityFee,
      pool: payload.pool,
      quoteMint: "quoteMint" in payload ? payload.quoteMint : undefined
    })}`
  );

  const response = await retryFetch("PumpPortal local create request", () =>
    fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    const detail = response.statusText && response.statusText !== "Bad Request" ? response.statusText : body;
    if (response.status === 400) {
      throw new NonRetryableLaunchError(
        `PumpPortal local create rejected the request: ${detail || "Bad Request"}. ` +
          "PumpPortal only supports Bonk token creation through the Lightning API."
      );
    }
    throw new Error(`PumpPortal local launch failed: ${response.status} ${detail || response.statusText}`);
  }

  const txBytes = new Uint8Array(await response.arrayBuffer());
  const transaction = VersionedTransaction.deserialize(txBytes);
  transaction.sign([mintSigner, signerKeypair]);

  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  return connection.sendTransaction(transaction, { maxRetries: 3 });
}

async function sendCreateWithRetries(
  proposal: Proposal,
  mintKeypair: MintKeypair,
  metadataUri: string,
  pumpPortalApiKey: string
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.LAUNCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      console.log(`[launch:${proposal.id}] sending create request (${attempt}/${config.LAUNCH_MAX_ATTEMPTS})`);
      const signature = await sendCreateRequest(proposal, mintKeypair, metadataUri, pumpPortalApiKey);
      console.log(`[launch:${proposal.id}] launch signature: ${signature}`);
      await waitForSubmittedOrConfirmedSignature(signature, proposal, mintKeypair.address);
      return signature;
    } catch (error) {
      if (error instanceof UnknownConfirmationError || error instanceof NonRetryableLaunchError) throw error;

      lastError = error;
      console.warn(
        `[launch:${proposal.id}] launch attempt ${attempt}/${config.LAUNCH_MAX_ATTEMPTS} failed: ${errorMessage(error)}`
      );

      if (attempt < config.LAUNCH_MAX_ATTEMPTS) {
        await delay(config.LAUNCH_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Launch failed after ${config.LAUNCH_MAX_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}

async function sendCreateRequest(
  proposal: Proposal,
  mintKeypair: MintKeypair,
  metadataUri: string,
  pumpPortalApiKey: string
): Promise<string> {
  const payload = {
    action: "create",
    tokenMetadata: {
      name: proposal.name,
      symbol: proposal.symbol,
      uri: metadataUri
    },
    mint: mintKeypair.secretKeyBase58,
    denominatedInSol: "true",
    amount: proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL,
    slippage: config.DEFAULT_SLIPPAGE_PERCENT,
    priorityFee: priorityFeeForLaunchpad(proposal.launchpad),
    pool: proposal.launchpad === "bonk" ? "bonk" : "pump",
  };

  console.log(
    `[launch:${proposal.id}] PumpPortal create payload: ${JSON.stringify({
      action: payload.action,
      tokenMetadata: payload.tokenMetadata,
      mint: mintKeypair.address,
      denominatedInSol: payload.denominatedInSol,
      amount: payload.amount,
      slippage: payload.slippage,
      priorityFee: payload.priorityFee,
      pool: payload.pool,
      quoteMint: "quoteMint" in payload ? payload.quoteMint : undefined
    })}`
  );

  const response = await retryFetch("PumpPortal create request", () =>
    fetch(`https://pumpportal.fun/api/trade?api-key=${encodeURIComponent(pumpPortalApiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );

  const responseText = await response.text();
  const body = parsePumpPortalResponse(responseText);
  if (!response.ok || !body.signature) {
    const detail = body.error ?? responseText;
    if (detail.includes("sufficient quoteMint tokens")) {
      throw new NonRetryableLaunchError(
        "PumpPortal says the launch wallet does not have enough quoteMint tokens. " +
          "For SOL-funded Bonk launches, quoteMint must be omitted from the create request."
      );
    }
    throw new Error(
      detail ||
        `PumpPortal launch failed: ${response.status} ${response.statusText}${
          responseText ? ` - ${responseText.slice(0, 500)}` : ""
        }`
    );
  }

  return body.signature;
}

async function waitForSubmittedOrConfirmedSignature(
  signature: string,
  proposal: Proposal,
  mintAddress?: string
): Promise<void> {
  if (proposal.launchpad === "bonk") {
    await waitForBonkLanding(signature, proposal.id, mintAddress);
    return;
  }

  if (!config.REQUIRE_LAUNCH_CONFIRMATION) {
    const status = await getSignatureStatus(signature).catch(() => null);
    if (status?.err) {
      throw new Error(
        `Launch transaction failed on-chain: ${JSON.stringify(status.err)}. ` +
          `Solscan: https://solscan.io/tx/${signature}`
      );
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      console.log(`[launch:${proposal.id}] transaction ${status.confirmationStatus}`);
    } else if (mintAddress && (await accountExists(mintAddress).catch(() => false))) {
      console.log(`[launch:${proposal.id}] mint account exists while signature is not indexed yet`);
    } else {
      await waitForSuccessfulSignature(signature, proposal.id, mintAddress);
    }
    return;
  }

  await waitForSuccessfulSignature(signature, proposal.id, mintAddress);
}

async function waitForBonkLanding(signature: string, proposalId: number, mintAddress?: string): Promise<void> {
  const attempts = Math.min(config.LAUNCH_CONFIRM_ATTEMPTS, 20);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = await getSignatureStatus(signature).catch(() => null);
    if (status?.err) {
      throw new Error(
        `Bonk launch transaction failed on-chain: ${JSON.stringify(status.err)}. ` +
          `Solscan: https://solscan.io/tx/${signature}`
      );
    }

    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      console.log(`[launch:${proposalId}] Bonk transaction ${status.confirmationStatus}`);
      return;
    }

    if (mintAddress && (await accountExists(mintAddress).catch(() => false))) {
      console.log(`[launch:${proposalId}] Bonk CA exists while signature is not indexed yet`);
      return;
    }

    console.log(`[launch:${proposalId}] waiting for Bonk landing (${attempt}/${attempts})`);
    await delay(config.LAUNCH_CONFIRM_DELAY_MS);
  }

  throw new UnlandedLaunchError(
    `Bonk launch signature was not found and the CA does not exist after ${Math.round(
      (attempts * config.LAUNCH_CONFIRM_DELAY_MS) / 1000
    )}s. Retrying instead of marking it launched. ` +
      `CA: ${mintAddress ?? "unknown"}. Solscan: https://solscan.io/tx/${signature}`
  );
}

async function waitForSuccessfulSignature(signature: string, proposalId: number, mintAddress?: string): Promise<void> {
  for (let attempt = 1; attempt <= config.LAUNCH_CONFIRM_ATTEMPTS; attempt += 1) {
    const status = await getSignatureStatus(signature);
    if (status?.err) {
      const logs = await getTransactionLogs(signature);
      const insufficientLamportsLog = logs.find((log) => log.includes("insufficient lamports"));
      if (insufficientLamportsLog) {
        throw new NonRetryableLaunchError(
          `${insufficientLamportsLog}. Fund your PumpPortal/API wallet or lower the dev buy. ` +
            `Solscan: https://solscan.io/tx/${signature}`
        );
      }

      throw new Error(
        `Launch transaction failed on-chain: ${JSON.stringify(status.err)}. ` +
          `Solscan: https://solscan.io/tx/${signature}`
      );
    }

    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      console.log(`[launch:${proposalId}] transaction ${status.confirmationStatus}`);
      return;
    }

    if (mintAddress && attempt % 5 === 0 && (await accountExists(mintAddress))) {
      console.log(`[launch:${proposalId}] mint account exists while signature is not indexed yet`);
      return;
    }

    console.log(`[launch:${proposalId}] waiting for confirmation (${attempt}/${config.LAUNCH_CONFIRM_ATTEMPTS})`);
    await delay(config.LAUNCH_CONFIRM_DELAY_MS);
  }

  throw new UnknownConfirmationError(
    `Launch transaction was submitted, but your RPC did not find/confirm it after ${Math.round(
      (config.LAUNCH_CONFIRM_ATTEMPTS * config.LAUNCH_CONFIRM_DELAY_MS) / 1000
    )}s. It may still land later, or it may have been dropped by the network/PumpPortal broadcast. ` +
      `CA: ${mintAddress ?? "unknown"}. Do not press launch again until you check Solscan: https://solscan.io/tx/${signature}`
  );
}

async function accountExists(address: string): Promise<boolean> {
  const response = await retryFetch("Solana account info request", () =>
    fetch(config.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64" }]
      })
    })
  );

  const body = (await response.json().catch(() => ({}))) as { result?: { value?: unknown } };
  return Boolean(body.result?.value);
}

async function getTransactionLogs(signature: string): Promise<string[]> {
  const response = await retryFetch("Solana transaction log request", () =>
    fetch(config.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]
      })
    })
  );

  const body = (await response.json().catch(() => ({}))) as {
    result?: { meta?: { logMessages?: string[] } };
  };

  return body.result?.meta?.logMessages ?? [];
}

async function getSignatureStatus(signature: string): Promise<{
  confirmationStatus?: "processed" | "confirmed" | "finalized";
  err?: unknown;
} | null> {
  const response = await retryFetch("Solana signature status request", () =>
    fetch(config.SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignatureStatuses",
        params: [[signature], { searchTransactionHistory: true }]
      })
    })
  );

  const body = (await response.json().catch(() => ({}))) as {
    result?: { value?: Array<{ confirmationStatus?: "processed" | "confirmed" | "finalized"; err?: unknown } | null> };
  };

  return body.result?.value?.[0] ?? null;
}

function parsePumpPortalResponse(text: string): PumpPortalResponse {
  try {
    return JSON.parse(text) as PumpPortalResponse;
  } catch {
    return text ? { error: text } : {};
  }
}

export async function testLaunchImageFetch(proposal: Proposal): Promise<string> {
  if (!proposal.image) {
    throw new Error("Proposal has no image.");
  }

  const file = await fetchFile(proposal.image, `${proposal.symbol}-image-test`, 2);
  return imageValidationSummary(await validateImageFile(file));
}

export async function inspectLaunchOnchain(signature: string, mintAddress?: string): Promise<{
  signatureStatus: string;
  signatureError?: string;
  mintExists?: boolean;
}> {
  const status = await getSignatureStatus(signature);
  return {
    signatureStatus: status?.confirmationStatus ?? "not found",
    signatureError: status?.err ? JSON.stringify(status.err) : undefined,
    mintExists: mintAddress ? await accountExists(mintAddress) : undefined
  };
}

export async function probePumpPortalLocalCreate(
  proposal: Proposal,
  signerAddress: string,
  amountOverride?: number
): Promise<{ ok: boolean; status: number; detail: string; mint: string }> {
  if (!proposal.image) {
    throw new Error("An image URL is required for launch metadata.");
  }

  console.log(`[launch:${proposal.id}] probing PumpPortal local create`);
  const metadataUri =
    proposal.launchpad === "bonk" ? await uploadBonkMetadata(proposal) : await uploadPumpMetadataToPinata(proposal);
  const mint = Keypair.generate().publicKey.toBase58();
  const payload = {
    publicKey: signerAddress,
    action: "create",
    tokenMetadata: {
      name: proposal.name,
      symbol: proposal.symbol,
      uri: metadataUri
    },
    mint,
    denominatedInSol: "true",
    amount: amountOverride ?? proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL,
    slippage: config.DEFAULT_SLIPPAGE_PERCENT,
    priorityFee: priorityFeeForLaunchpad(proposal.launchpad),
    pool: proposal.launchpad === "bonk" ? "bonk" : "pump",
  };

  console.log(`[launch:${proposal.id}] local probe payload: ${JSON.stringify(payload)}`);
  const response = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const detail = contentType.includes("application/json")
    ? JSON.stringify(await response.json().catch(() => ({})))
    : await response.text().catch(() => response.statusText);

  return {
    ok: response.ok,
    status: response.status,
    detail: detail || response.statusText,
    mint
  };
}

async function getMintKeypair(proposal: Proposal): Promise<MintKeypair> {
  const suffix = mintSuffixForLaunchpad(proposal).trim();
  if (suffix) {
    const mint = await consumeVanityMint(suffix, proposal.id);
    if (!mint) {
      throw new Error(
        `No pre-generated ${proposal.launchpad} mint ending in "${suffix}" is ready. ` +
          "Start the vanity worker for this suffix, wait for /launchcheck to show mints ready, then launch again."
      );
    }
    if (!mint.address.endsWith(suffix)) {
      await releaseVanityMint(mint.id);
      throw new Error(`Prepared vanity mint ${mint.address} does not end with exact suffix "${suffix}".`);
    }

    return {
      secretKeyBase58: mint.secretKeyBase58,
      address: mint.address,
      source: "pool",
      poolId: mint.id
    };
  }

  const keypair = nacl.sign.keyPair();
  return {
    publicKey: keypair.publicKey,
    secretKeyBase58: bs58.encode(keypair.secretKey),
    address: bs58.encode(keypair.publicKey),
    source: "random"
  };
}

function mintSuffixForLaunchpad(proposal: Proposal): string {
  if (proposal.launchpad === "pumpfun") return config.PUMP_MINT_SUFFIX;
  if (proposal.launchpad === "bonk") return config.BONK_MINT_SUFFIX;
  return "";
}

async function uploadPumpMetadataToPinata(proposal: Proposal): Promise<string> {
  if (!config.PINATA_JWT) {
    throw new Error("PINATA_JWT is required for Pump.fun metadata when DRY_RUN=false.");
  }
  if (!proposal.image) {
    throw new Error("An image URL is required for Pump.fun metadata.");
  }

  console.log(`[launch:${proposal.id}] downloading/uploading image to Pinata`);
  const imageUri = await uploadFileToPinata(proposal.image, `${proposal.symbol}-image`);
  console.log(`[launch:${proposal.id}] image uploaded: ${imageUri}`);
  const metadata = {
    name: proposal.name,
    symbol: proposal.symbol,
    description: proposal.description,
    image: imageUri,
    website: proposal.website,
    telegram: proposal.telegram,
    twitter: proposal.twitter
  };

  const file = new File([JSON.stringify(metadata)], `${proposal.symbol}-metadata.json`, {
    type: "application/json"
  });
  return uploadBlobToPinata(file);
}

async function uploadBonkMetadata(proposal: Proposal): Promise<string> {
  if (!proposal.image) {
    throw new Error("An image URL is required for Bonk metadata.");
  }

  console.log(`[launch:${proposal.id}] downloading image for Bonk metadata`);
  const imageFile = await fetchFile(proposal.image, `${proposal.symbol}-image`);
  const validatedImage = await validateImageFile(imageFile);
  const imageFormData = new FormData();
  imageFormData.append("image", validatedImage.file);

  const imageResponse = await fetch("https://nft-storage.letsbonk22.workers.dev/upload/img", {
    method: "POST",
    body: imageFormData
  });
  const imageUri = await imageResponse.text();
  if (!imageResponse.ok || !imageUri) {
    throw new Error(`Bonk image upload failed: ${imageResponse.status} ${imageResponse.statusText}`);
  }

  const metadataResponse = await fetch("https://nft-storage.letsbonk22.workers.dev/upload/meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      createdOn: "https://bonk.fun",
      description: proposal.description,
      image: imageUri,
      name: proposal.name,
      symbol: proposal.symbol,
      website: proposal.website,
      telegram: proposal.telegram,
      twitter: proposal.twitter
    })
  });

  const metadataUri = await metadataResponse.text();
  if (!metadataResponse.ok || !metadataUri) {
    throw new Error(`Bonk metadata upload failed: ${metadataResponse.status} ${metadataResponse.statusText}`);
  }

  return metadataUri;
}

async function uploadFileToPinata(url: string, fallbackName: string): Promise<string> {
  const file = await fetchFile(url, fallbackName);
  const validatedImage = await validateImageFile(file);
  return uploadBlobToPinata(validatedImage.file);
}

async function uploadBlobToPinata(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("network", "public");
  formData.append("file", file);

  const response = await retryFetch("Pinata upload request", () =>
    fetch("https://uploads.pinata.cloud/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.PINATA_JWT}` },
      body: formData
    })
  );

  const body = (await response.json().catch(() => ({}))) as PinataResponse;
  if (!response.ok || !body.data?.cid) {
    throw new Error(`Pinata metadata upload failed: ${response.status} ${response.statusText}`);
  }

  return `https://ipfs.io/ipfs/${body.data.cid}`;
}

async function fetchFile(url: string, fallbackName: string, attempts = 5): Promise<File> {
  console.log(`[image] fetching ${safeUrlLabel(url)}`);
  const resolvedUrl = url.startsWith("telegram:") ? await resolveTelegramFileUrl(url, attempts) : url;
  const response = await retryFetch(`image download from ${safeUrlLabel(url)}`, () => fetch(resolvedUrl), attempts);

  if (!response.ok) {
    throw new Error(`Could not download image from ${safeUrlLabel(url)}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const extension = extensionFromContentType(contentType);
  const blob = await response.blob();
  return new File([blob], `${fallbackName}${extension}`, { type: contentType });
}

async function resolveTelegramFileUrl(value: string, attempts = 5): Promise<string> {
  const fileId = value.slice("telegram:".length);
  const response = await retryFetch("Telegram getFile request", () =>
    fetch(
      `https://api.telegram.org/bot${encodeURIComponent(config.TELEGRAM_BOT_TOKEN)}/getFile?file_id=${encodeURIComponent(
        fileId
      )}`
    )
  , attempts);

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

function safeUrlLabel(url: string): string {
  if (url.startsWith("telegram:")) return "Telegram upload";
  if (url.includes("api.telegram.org/file/bot")) return "Telegram file URL";
  return url;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

async function retryFetch(label: string, run: () => Promise<Response>, attempts = 5): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await run();
      if (response.ok || attempt === attempts || !isRetryableStatus(response.status)) return response;

      console.warn(`[retry] ${label} returned ${response.status}. Attempt ${attempt}/${attempts}`);
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      console.warn(`[retry] ${label} failed. Attempt ${attempt}/${attempts}: ${errorMessage(error)}`);
    }

    await delay(750 * attempt);
  }

  throw new Error(`${label} failed after ${attempts} attempts: ${errorMessage(lastError)}`);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionFromContentType(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  return "";
}
