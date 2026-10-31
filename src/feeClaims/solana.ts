// Creator-fee claims for Solana launch wallets: Pump.fun (the wallet's own creator vaults, plus its share of coins
// launched with fee sharing) and Bags. Claims land in the launch wallet; index.ts forwards them to the payout wallet.
import { BagsSDK } from "@bagsfm/bags-sdk";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type TransactionInstruction
} from "@solana/web3.js";
import type BN from "bn.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { callBagsApi } from "../launchpads/bags.js";
import { loadPumpSdk } from "../launchpads/pumpportal.js";
import { TransferNotSentError, type ClaimRun, type FeeClaimed } from "./types.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
// What a plain system account must keep to stay rent-exempt.
const RENT_EXEMPT_LAMPORTS = 890_880n;
const BASE_FEE_LAMPORTS = 5_000n;
// Checked before sending anything: the network fee for each claim transaction, plus the rent of the temporary WSOL
// account a PumpSwap claim opens (refunded when it closes in the same transaction).
const CLAIM_TX_FEE_LAMPORTS = 60_000n;
const WSOL_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

type PumpFeeSdk = {
  OnlinePumpSdk: new (connection: Connection) => {
    collectCoinCreatorFeeInstructions(creator: PublicKey, feePayer?: PublicKey): Promise<TransactionInstruction[]>;
    getMinimumDistributableFee(mint: PublicKey): Promise<{ distributableFees: BN; canDistribute: boolean }>;
    buildDistributeCreatorFeesInstructions(mint: PublicKey): Promise<{ instructions: TransactionInstruction[] }>;
  };
  PUMP_SDK: {
    decodeSharingConfig(info: AccountInfo<Buffer>): { shareholders: Array<{ address: PublicKey; shareBps: number }> };
  };
  creatorVaultPda(creator: PublicKey): PublicKey;
  ammCreatorVaultPda(creator: PublicKey): PublicKey;
  feeSharingConfigPda(mint: PublicKey): PublicKey;
};

export interface SolanaFeePlan {
  wallet: string;
  /** The wallet's own Pump.fun creator vaults: bonding curve (SOL) and PumpSwap (WSOL, after graduation). */
  pumpCurve: bigint;
  pumpAmm: bigint;
  /** Coins launched with fee sharing, "Creator 100%" included: this wallet's share of each coin's payout. */
  pumpShares: Array<{ mint: string; amount: bigint }>;
  bags: Array<{ mint: string; amount: bigint }>;
  bagsError?: string;
}

export function solanaPlanTotals(plan: SolanaFeePlan): { pumpfun: bigint; bags: bigint } {
  return {
    pumpfun: plan.pumpCurve + plan.pumpAmm + sum(plan.pumpShares.map((share) => share.amount)),
    bags: sum(plan.bags.map((position) => position.amount))
  };
}

/** Reads what the wallet can claim. `pumpMints` are the Pump.fun coins it launched, for fee-sharing payouts. */
export async function planSolanaFeeClaims(walletAddress: string, pumpMints: string[]): Promise<SolanaFeePlan> {
  const connection = solanaConnection();
  const wallet = new PublicKey(walletAddress);
  const sdk = (await loadPumpSdk()) as unknown as PumpFeeSdk;

  const curveVault = sdk.creatorVaultPda(wallet);
  const ammVault = associatedTokenAddress(sdk.ammCreatorVaultPda(wallet), NATIVE_MINT);
  const [curveInfo, ammInfo] = await connection.getMultipleAccountsInfo([curveVault, ammVault]);
  const curveRent = curveInfo ? BigInt(await connection.getMinimumBalanceForRentExemption(curveInfo.data.length)) : 0n;
  const pumpCurve = curveInfo ? positive(BigInt(curveInfo.lamports) - curveRent) : 0n;
  const pumpAmm = ammInfo && ammInfo.data.length >= 72 ? ammInfo.data.readBigUInt64LE(64) : 0n;

  const pumpShares = await planPumpSharePayouts(connection, sdk, wallet, pumpMints);
  return { wallet: walletAddress, pumpCurve, pumpAmm, pumpShares, ...(await planBagsClaims(connection, wallet)) };
}

async function planPumpSharePayouts(
  connection: Connection,
  sdk: PumpFeeSdk,
  wallet: PublicKey,
  mints: string[]
): Promise<SolanaFeePlan["pumpShares"]> {
  const online = new sdk.OnlinePumpSdk(connection);
  // A malformed record must not stop the wallet's other coins from being checked.
  const coins = mints.flatMap((mint) => {
    try {
      return [{ mint, key: new PublicKey(mint) }];
    } catch {
      return [];
    }
  });
  const configs = await getAccountsInfo(
    connection,
    coins.map((coin) => sdk.feeSharingConfigPda(coin.key))
  );
  const shares: SolanaFeePlan["pumpShares"] = [];
  for (const [index, info] of configs.entries()) {
    if (!info) continue;
    const shareBps = sdk.PUMP_SDK.decodeSharingConfig(info)
      .shareholders.filter((holder) => holder.address.equals(wallet))
      .reduce((total, holder) => total + holder.shareBps, 0);
    if (shareBps <= 0) continue;

    // Pump.fun only pays out once a coin's fees reach its minimum; smaller balances wait for more trading.
    const { distributableFees, canDistribute } = await online.getMinimumDistributableFee(coins[index].key);
    const amount = (BigInt(distributableFees.toString()) * BigInt(shareBps)) / 10_000n;
    if (canDistribute && amount > 0n) shares.push({ mint: coins[index].mint, amount });
  }
  return shares;
}

async function planBagsClaims(connection: Connection, wallet: PublicKey): Promise<Pick<SolanaFeePlan, "bags" | "bagsError">> {
  if (!config.BAGS_API_KEY) return { bags: [] };

  try {
    const sdk = new BagsSDK(config.BAGS_API_KEY, connection, "confirmed");
    const positions = await callBagsApi("Bags claimable positions", () => sdk.fee.getAllClaimablePositions(wallet));
    const byMint = new Map<string, bigint>();
    for (const position of positions) {
      const amount = BigInt(Math.floor(position.totalClaimableLamportsUserShare ?? 0));
      if (amount > 0n) byMint.set(position.baseMint, (byMint.get(position.baseMint) ?? 0n) + amount);
    }
    return { bags: [...byMint].map(([mint, amount]) => ({ mint, amount })) };
  } catch (error) {
    return { bags: [], bagsError: errorText(error) };
  }
}

/** Claims everything in the plan into the launch wallet, reporting each claim as soon as it confirms. */
export async function claimSolanaFees(
  secretKeyBase58: string,
  plan: SolanaFeePlan,
  onClaim: (claim: FeeClaimed) => Promise<void>
): Promise<ClaimRun> {
  const run: ClaimRun = { claims: [], errors: [] };
  const hasPumpVaults = plan.pumpCurve > 0n || plan.pumpAmm > 0n;
  const transactions = (hasPumpVaults ? 1 : 0) + plan.pumpShares.length + plan.bags.length;
  if (transactions === 0) return run;

  const connection = solanaConnection();
  const signer = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
  if (signer.publicKey.toBase58() !== plan.wallet) throw new Error("Launch wallet key does not match its address.");

  const balance = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
  const needed =
    BigInt(transactions) * CLAIM_TX_FEE_LAMPORTS + (plan.pumpAmm > 0n ? WSOL_ACCOUNT_RENT_LAMPORTS : 0n) + RENT_EXEMPT_LAMPORTS;
  if (balance < needed) {
    throw new Error(
      `The launch wallet needs about ${formatSol(needed)} SOL for network fees to claim. ` +
        `Send a little SOL to ${plan.wallet} and try again.`
    );
  }

  const record = async (launchpad: FeeClaimed["launchpad"], tx: string, amount: bigint) => {
    const claim = { launchpad, amount, tx };
    run.claims.push(claim);
    await onClaim(claim);
  };
  const sdk = (await loadPumpSdk()) as unknown as PumpFeeSdk;
  const online = new sdk.OnlinePumpSdk(connection);

  if (hasPumpVaults) {
    try {
      const instructions = await pumpVaultClaimInstructions(connection, plan);
      const sent = await sendInstructions(connection, signer, instructions, "Pump.fun creator fee claim");
      await record("pumpfun", sent.signature, sent.received ?? plan.pumpCurve + plan.pumpAmm);
    } catch (error) {
      run.errors.push(`Pump.fun: ${errorText(error)}`);
    }
  }

  for (const share of plan.pumpShares) {
    try {
      // Pays every shareholder of the coin, this wallet included.
      const { instructions } = await online.buildDistributeCreatorFeesInstructions(new PublicKey(share.mint));
      const sent = await sendInstructions(connection, signer, instructions, "Pump.fun fee-sharing payout");
      await record("pumpfun", sent.signature, sent.received ?? share.amount);
    } catch (error) {
      run.errors.push(`Pump.fun fee sharing ${shortAddress(share.mint)}: ${errorText(error)}`);
    }
  }

  if (plan.bags.length > 0 && config.BAGS_API_KEY) {
    const bags = new BagsSDK(config.BAGS_API_KEY, connection, "confirmed");
    for (const position of plan.bags) {
      try {
        const claimTransactions = await callBagsApi("Bags claim transactions", () =>
          fetchBagsClaimTransactions(bags, signer.publicKey, position.mint)
        );
        for (const transaction of claimTransactions) {
          const sent = await sendPrebuiltTransaction(connection, transaction, signer, "Bags fee claim");
          // Bags may split a claim over several transactions; without a measurement, the last one carries the estimate.
          const isLast = transaction === claimTransactions[claimTransactions.length - 1];
          await record("bags", sent.signature, sent.received ?? (isLast ? position.amount : 0n));
        }
      } catch (error) {
        run.errors.push(`Bags ${shortAddress(position.mint)}: ${errorText(error)}`);
      }
    }
  }

  return run;
}

/**
 * Bags' claim transactions for one coin. The SDK's getClaimTransactions decodes them as legacy transactions, which
 * throws now that the API returns versioned ones, so they're fetched and decoded here.
 */
export async function fetchBagsClaimTransactions(bags: BagsSDK, wallet: PublicKey, mint: string): Promise<VersionedTransaction[]> {
  const response = await bags.state.getBagsApiClient().post<Array<{ tx: string }>>("/token-launch/claim-txs/v3", {
    feeClaimer: wallet.toBase58(),
    tokenMint: mint
  });
  return response.map((item) => VersionedTransaction.deserialize(bs58.decode(item.tx)));
}

/**
 * Collects the wallet's own Pump.fun creator vaults. The SDK's first instruction empties the bonding-curve vault and
 * the rest empty PumpSwap's WSOL vault and unwrap it; each part is only kept when its vault holds fees, so no
 * account gets opened just to collect nothing.
 */
export async function pumpVaultClaimInstructions(connection: Connection, plan: SolanaFeePlan): Promise<TransactionInstruction[]> {
  const sdk = (await loadPumpSdk()) as unknown as PumpFeeSdk;
  const wallet = new PublicKey(plan.wallet);
  const [curveCollect, ...ammCollect] = await new sdk.OnlinePumpSdk(connection).collectCoinCreatorFeeInstructions(wallet, wallet);
  return [...(plan.pumpCurve > 0n ? [curveCollect] : []), ...(plan.pumpAmm > 0n ? ammCollect : [])];
}

/**
 * Sends `lamports` (or as much as the wallet can spare while staying rent-exempt) to the payout wallet.
 * `onSigned` runs before the broadcast so the caller can note the signature first.
 */
export async function forwardSolanaFees(
  secretKeyBase58: string,
  payoutAddress: string,
  lamports: bigint,
  onSigned: (signature: string) => Promise<void>
): Promise<{ tx: string; amount: bigint }> {
  const connection = solanaConnection();
  const signer = Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
  // A transfer plus the two compute-budget instructions uses about 450 compute units.
  const unitLimit = 1_000;
  const microLamports = Math.ceil((config.DEFAULT_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL * 1_000_000) / unitLimit);
  const networkFee = BASE_FEE_LAMPORTS + BigInt(Math.ceil((unitLimit * microLamports) / 1_000_000));

  const balance = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
  const spendable = balance - networkFee - RENT_EXEMPT_LAMPORTS;
  const amount = lamports < spendable ? lamports : spendable;
  if (amount <= 0n) {
    throw new TransferNotSentError(
      `The launch wallet can't cover the network fee for the transfer. Send about 0.001 SOL to ${signer.publicKey.toBase58()} and try again.`
    );
  }

  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(payoutAddress), lamports: amount })
  );
  transaction.feePayer = signer.publicKey;
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.sign(signer);
  const signature = bs58.encode(transaction.signature!);

  await onSigned(signature);
  try {
    await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
  } catch (error) {
    // An RPC rejection means the transfer never went out; anything else may have reached the network.
    if (error instanceof SendTransactionError) throw new TransferNotSentError(`Transfer rejected: ${errorText(error)}`);
    throw error;
  }
  await confirmSignature(connection, signature, latestBlockhash, "Payout transfer");
  return { tx: signature, amount };
}

export async function solanaTransferStatus(signature: string): Promise<"landed" | "failed" | "unknown"> {
  const { value } = await solanaConnection().getSignatureStatus(signature, { searchTransactionHistory: true });
  if (!value) return "unknown";
  if (value.err) return "failed";
  return value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized" ? "landed" : "unknown";
}

/** Signs and sends our own instructions with a priority fee sized from a simulation. */
async function sendInstructions(
  connection: Connection,
  signer: Keypair,
  instructions: TransactionInstruction[],
  label: string
): Promise<{ signature: string; received?: bigint }> {
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const build = (...computeBudget: TransactionInstruction[]) => {
    const transaction = new Transaction().add(...computeBudget, ...instructions);
    transaction.feePayer = signer.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.sign(signer);
    return transaction;
  };

  const simulation = await connection.simulateTransaction(build());
  if (simulation.value.err) {
    throw new Error(
      `${label} simulation failed: ${JSON.stringify(simulation.value.err)}${
        simulation.value.logs?.length ? ` | logs: ${simulation.value.logs.slice(-6).join(" | ")}` : ""
      }`
    );
  }
  const unitLimit = Math.min(1_400_000, Math.ceil((simulation.value.unitsConsumed ?? 200_000) * 1.1) + 1_000);
  const microLamports = Math.ceil((config.DEFAULT_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL * 1_000_000) / unitLimit);
  const transaction = build(
    ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
  );

  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
  await confirmSignature(connection, signature, latestBlockhash, label);
  return { signature, received: await receivedBy(connection, signature, signer.publicKey) };
}

/** Sends a transaction Bags built (with its own blockhash), polling the signature until it confirms. */
async function sendPrebuiltTransaction(
  connection: Connection,
  transaction: VersionedTransaction,
  signer: Keypair,
  label: string
): Promise<{ signature: string; received?: bigint }> {
  transaction.sign([signer]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 3,
    preflightCommitment: "confirmed"
  });

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const { value } = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (value?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(value.err)}. Solscan: ${solscanTx(signature)}`);
    if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") {
      return { signature, received: await receivedBy(connection, signature, signer.publicKey) };
    }
    await delay(2_000);
  }
  throw new Error(`${label} was sent but not confirmed after 60s. Solscan: ${solscanTx(signature)}`);
}

async function confirmSignature(
  connection: Connection,
  signature: string,
  latestBlockhash: BlockhashWithExpiryBlockHeight,
  label: string
): Promise<void> {
  const confirmation = await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
  if (confirmation.value.err) {
    throw new Error(`${label} failed on-chain: ${JSON.stringify(confirmation.value.err)}. Solscan: ${solscanTx(signature)}`);
  }
}

/** SOL the wallet gained in a confirmed transaction, network fee added back when it paid it. */
async function receivedBy(connection: Connection, signature: string, wallet: PublicKey): Promise<bigint | undefined> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const transaction = await connection
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
      .catch(() => null);
    if (transaction?.meta) {
      const index = transaction.transaction.message.staticAccountKeys.findIndex((key) => key.equals(wallet));
      if (index < 0) return 0n;
      const change = BigInt(transaction.meta.postBalances[index]) - BigInt(transaction.meta.preBalances[index]);
      return positive(index === 0 ? change + BigInt(transaction.meta.fee) : change);
    }
    await delay(1_500);
  }
  return undefined;
}

async function getAccountsInfo(connection: Connection, keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> {
  const infos: Array<AccountInfo<Buffer> | null> = [];
  for (let start = 0; start < keys.length; start += 100) {
    infos.push(...(await connection.getMultipleAccountsInfo(keys.slice(start, start + 100))));
  }
  return infos;
}

function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

function solanaConnection(): Connection {
  return new Connection(config.SOLANA_RPC_URL, "confirmed");
}

function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

function formatSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function positive(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/** First line only: RPC errors can carry pages of transaction logs. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
