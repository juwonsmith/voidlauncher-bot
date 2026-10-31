// Creator-fee claiming for the bot's launch wallets. Every launch makes its launch wallet the coin's fee receiver;
// claiming pulls the fees into that wallet, then sends them on to the payout wallet the group owner (or member) set.
// Each claim is recorded before anything is sent, so a failed payout transfer is retried by the next claim and a
// transfer that may have landed is never sent twice.
import { PublicKey } from "@solana/web3.js";
import { getAddress, isAddress } from "viem";
import {
  clearFeeClaimsForwarding,
  getPayoutWallets,
  getWallet,
  listLaunchedMints,
  listUnforwardedFeeClaims,
  markFeeClaimsForwarded,
  markFeeClaimsForwarding,
  recordFeeClaim,
  type FeeChain,
  type PayoutScope,
  type StoredWallet
} from "../db.js";
import { ROBINHOOD_EXPLORER_URL } from "../launchpads/robinhoodChain.js";
import { escapeHtml } from "../messages.js";
import { exportWalletSecretBase58, getRobinhoodWalletSecret } from "../wallets.js";
import { claimPonsFees, forwardRobinhoodFees, planPonsFeeClaims, robinhoodTransferStatus } from "./robinhood.js";
import { claimSolanaFees, forwardSolanaFees, planSolanaFeeClaims, solanaPlanTotals, solanaTransferStatus } from "./solana.js";
import { TransferNotSentError, type ClaimRun, type FeeClaimed } from "./types.js";

export interface FeeClaimScope {
  kind: PayoutScope;
  id: string;
}

const CHAINS: FeeChain[] = ["solana", "robinhood"];
const WALLET_SCOPES: Record<PayoutScope, Record<FeeChain, StoredWallet["scope"]>> = {
  group: { solana: "group_portal", robinhood: "group_evm" },
  user: { solana: "user", robinhood: "user_evm" }
};
// A payout transfer still unconfirmed after this long never landed: Solana blockhashes expire within about two
// minutes, and Robinhood Chain's sequencer includes or drops a transaction within seconds.
const TRANSFER_EXPIRY_MS: Record<FeeChain, number> = { solana: 3 * 60_000, robinhood: 10 * 60_000 };

export interface ChainFeeStatus {
  chain: FeeChain;
  wallet: string;
  payout?: string;
  sources: Array<{ label: string; amount: bigint }>;
  /** Claimed earlier but not yet sent to the payout wallet. */
  unsent: bigint;
  notes: string[];
  error?: string;
}

export interface ChainClaimOutcome {
  chain: FeeChain;
  wallet: string;
  payout?: string;
  claimed: bigint;
  sent: bigint;
  /** Claimed fees left in the launch wallet because sending all of it would not leave enough for network fees. */
  kept: bigint;
  sendTx?: string;
  skipped?: boolean;
  errors: string[];
}

/** What each of the scope's launch wallets can claim right now. Read-only. */
export async function checkCreatorFees(scope: FeeClaimScope): Promise<ChainFeeStatus[]> {
  const payouts = await getPayoutWallets(scope.kind, scope.id);
  const statuses: ChainFeeStatus[] = [];

  for (const chain of CHAINS) {
    const wallet = await getWallet(WALLET_SCOPES[scope.kind][chain], scope.id);
    if (!wallet) continue;
    const status: ChainFeeStatus = { chain, wallet: wallet.address, payout: payouts[chain], sources: [], unsent: 0n, notes: [] };
    statuses.push(status);

    try {
      status.unsent = sum((await listUnforwardedFeeClaims(wallet.address)).map((claim) => claim.amount));
      if (chain === "solana") {
        if ((await listLaunchedMints(wallet.address, "bonk")).length > 0) {
          status.notes.push("Bonk fees can't be claimed through the bot yet.");
        }
        const plan = await planSolanaFeeClaims(wallet.address, await listLaunchedMints(wallet.address, "pumpfun"));
        const totals = solanaPlanTotals(plan);
        status.sources.push({ label: "Pump.fun", amount: totals.pumpfun }, { label: "Bags", amount: totals.bags });
        if (plan.bagsError) status.notes.push(`Bags couldn't be checked: ${plan.bagsError}`);
      } else {
        const plan = await planPonsFeeClaims(wallet.address, await listLaunchedMints(wallet.address, "robinhood"));
        status.sources.push({ label: "Pons", amount: plan.amount });
      }
    } catch (error) {
      status.error = errorText(error);
    }
  }
  return statuses;
}

/** Claims every launch wallet in the scope that has a payout wallet, and sends the fees there. */
export async function claimCreatorFees(
  scope: FeeClaimScope,
  actor: { chatId?: string; actorId?: number }
): Promise<ChainClaimOutcome[]> {
  const payouts = await getPayoutWallets(scope.kind, scope.id);
  const outcomes: ChainClaimOutcome[] = [];

  for (const chain of CHAINS) {
    const wallet = await getWallet(WALLET_SCOPES[scope.kind][chain], scope.id);
    if (!wallet) continue;
    const payout = payouts[chain];
    const outcome: ChainClaimOutcome = { chain, wallet: wallet.address, payout, claimed: 0n, sent: 0n, kept: 0n, errors: [] };
    outcomes.push(outcome);
    if (!payout) {
      outcome.skipped = true;
      continue;
    }

    try {
      await claimAndSend(scope, chain, wallet.address, payout, actor, outcome);
    } catch (error) {
      outcome.errors.push(errorText(error));
    }
  }
  return outcomes;
}

async function claimAndSend(
  scope: FeeClaimScope,
  chain: FeeChain,
  walletAddress: string,
  payout: string,
  actor: { chatId?: string; actorId?: number },
  outcome: ChainClaimOutcome
): Promise<void> {
  const pending = await settleEarlierTransfers(chain, walletAddress);
  if (pending) {
    outcome.errors.push(
      `An earlier transfer to the payout wallet hasn't confirmed yet (${explorerTxUrl(chain, pending)}). Try again in a few minutes.`
    );
    return;
  }

  const onClaim = (claim: FeeClaimed) =>
    recordFeeClaim({
      chain,
      walletAddress,
      launchpad: claim.launchpad,
      amount: claim.amount,
      claimTx: claim.tx,
      chatId: actor.chatId,
      actorId: actor.actorId
    });

  let claim: () => Promise<ClaimRun>;
  let send: (amount: bigint, onSigned: (tx: string) => Promise<void>) => Promise<{ tx: string; amount: bigint }>;
  if (chain === "solana") {
    const { secretKey } = await exportWalletSecretBase58(WALLET_SCOPES[scope.kind].solana, scope.id);
    claim = async () => {
      const plan = await planSolanaFeeClaims(walletAddress, await listLaunchedMints(walletAddress, "pumpfun"));
      if (plan.bagsError) outcome.errors.push(`Bags couldn't be checked: ${plan.bagsError}`);
      return claimSolanaFees(secretKey, plan, onClaim);
    };
    send = (amount, onSigned) => forwardSolanaFees(secretKey, payout, amount, onSigned);
  } else {
    const { privateKey } = await getRobinhoodWalletSecret(scope.kind, scope.id);
    claim = async () =>
      claimPonsFees(privateKey, await planPonsFeeClaims(walletAddress, await listLaunchedMints(walletAddress, "robinhood")), onClaim);
    send = (amount, onSigned) => forwardRobinhoodFees(privateKey, payout, amount, onSigned);
  }

  // A failed claim doesn't stop fees claimed earlier from being sent.
  try {
    const run = await claim();
    outcome.claimed = sum(run.claims.map((claimed) => claimed.amount));
    outcome.errors.push(...run.errors);
  } catch (error) {
    outcome.errors.push(errorText(error));
  }

  // Everything claimed and not yet sent, this run's claims plus any whose transfer failed before.
  const unsent = await listUnforwardedFeeClaims(walletAddress);
  const total = sum(unsent.map((claim) => claim.amount));
  if (total === 0n) return;

  const ids = unsent.map((claim) => claim.id);
  try {
    const sent = await send(total, (tx) => markFeeClaimsForwarding(ids, payout, tx));
    await markFeeClaimsForwarded(ids);
    outcome.sent = sent.amount;
    outcome.kept = total - sent.amount;
    outcome.sendTx = sent.tx;
  } catch (error) {
    // A transfer that never went out is freed for the next claim; one that may have gone out waits to settle.
    if (error instanceof TransferNotSentError) await clearFeeClaimsForwarding(ids);
    outcome.errors.push(`Sending to the payout wallet failed: ${errorText(error)}`);
  }
}

/** Resolves payout transfers from earlier runs; returns one that is still waiting to confirm. */
async function settleEarlierTransfers(chain: FeeChain, walletAddress: string): Promise<string | undefined> {
  const inFlight = (await listUnforwardedFeeClaims(walletAddress)).filter((claim) => claim.forwardTx);

  for (const tx of new Set(inFlight.map((claim) => claim.forwardTx!))) {
    const claims = inFlight.filter((claim) => claim.forwardTx === tx);
    const ids = claims.map((claim) => claim.id);
    const status = chain === "solana" ? await solanaTransferStatus(tx) : await robinhoodTransferStatus(tx);
    const age = Date.now() - Date.parse(claims[0].forwardStartedAt ?? "1970-01-01T00:00:00Z");

    if (status === "landed") await markFeeClaimsForwarded(ids);
    else if (status === "failed" || age > TRANSFER_EXPIRY_MS[chain]) await clearFeeClaimsForwarding(ids);
    else return tx;
  }
  return undefined;
}

/** Works out the chain from the address: 0x addresses are Robinhood Chain, anything else must be a Solana wallet. */
export function parsePayoutAddress(raw: string): { chain: FeeChain; address: string } {
  const value = raw.trim();
  if (/^0x/i.test(value)) {
    if (!isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) {
      throw new Error("That isn't a valid Robinhood Chain (0x) address.");
    }
    return { chain: "robinhood", address: getAddress(value) };
  }

  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    throw new Error("Send a Solana wallet address, or a 0x address for Robinhood Chain.");
  }
  // Program-owned addresses (token accounts, vaults) have no private key, so SOL sent there is usually stuck.
  if (key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes())) {
    throw new Error("That Solana address isn't a regular wallet. Use the address your wallet app shows, like Phantom's.");
  }
  return { chain: "solana", address: key.toBase58() };
}

export function chainLabel(chain: FeeChain): string {
  return chain === "solana" ? "Solana" : "Robinhood Chain";
}

export function feeStatusMessage(scope: FeeClaimScope, statuses: ChainFeeStatus[]): { text: string; canClaim: boolean } {
  const lines = [scope.kind === "group" ? "&#128176; <b>Creator fees for this group</b>" : "&#128176; <b>Your creator fees</b>"];
  if (statuses.length === 0) {
    lines.push("", scope.kind === "group" ? "This group has no launch wallets yet." : "You don't have any launch wallets yet.");
    return { text: lines.join("\n"), canClaim: false };
  }

  let canClaim = false;
  for (const status of statuses) {
    lines.push("", `<b>${chainLabel(status.chain)}</b> · launch wallet <code>${shortAddress(status.wallet)}</code>`);

    const found = status.sources.filter((source) => source.amount > 0n);
    for (const source of found) lines.push(`${source.label}: <b>${formatAmount(source.amount, status.chain)}</b>`);
    if (status.unsent > 0n) lines.push(`Claimed earlier, not sent yet: <b>${formatAmount(status.unsent, status.chain)}</b>`);
    if (status.error) lines.push(`Couldn't check for new fees: ${escapeHtml(status.error)}`);
    else if (found.length === 0 && status.unsent === 0n) lines.push("Nothing to claim right now.");
    for (const note of status.notes) lines.push(`<i>${escapeHtml(note)}</i>`);
    lines.push(
      status.payout ? `Payout wallet: <code>${escapeHtml(status.payout)}</code>` : missingPayoutLine(scope, status.chain)
    );
    if (status.payout && (found.length > 0 || status.unsent > 0n)) canClaim = true;
  }

  if (canClaim) {
    lines.push(
      "",
      "<b>Claim &amp; send</b> claims the fees into the launch wallets, then sends them to the payout wallets. " +
        "Network fees are paid from the launch wallets."
    );
  }
  return { text: lines.join("\n"), canClaim };
}

export function feeClaimResultMessage(scope: FeeClaimScope, outcomes: ChainClaimOutcome[]): string {
  const problems = outcomes.some((outcome) => outcome.errors.length > 0);
  const lines = [problems ? "&#9888;&#65039; <b>Creator fee claim finished with problems</b>" : "&#9989; <b>Creator fees claimed</b>"];

  for (const outcome of outcomes) {
    lines.push("", `<b>${chainLabel(outcome.chain)}</b>`);
    if (outcome.skipped) {
      lines.push(missingPayoutLine(scope, outcome.chain));
      continue;
    }
    if (outcome.claimed === 0n && outcome.sent === 0n && outcome.errors.length === 0) {
      lines.push("Nothing to claim.");
      continue;
    }
    if (outcome.claimed > 0n) lines.push(`Claimed: <b>${formatAmount(outcome.claimed, outcome.chain)}</b>`);
    if (outcome.sendTx && outcome.payout) {
      lines.push(
        `Sent <b>${formatAmount(outcome.sent, outcome.chain)}</b> to <code>${escapeHtml(outcome.payout)}</code> · ` +
          `<a href="${explorerTxUrl(outcome.chain, outcome.sendTx)}">transaction</a>`
      );
    }
    if (outcome.kept > 0n) {
      lines.push(`${formatAmount(outcome.kept, outcome.chain)} stayed in the launch wallet to cover network fees.`);
    }
    for (const error of outcome.errors) lines.push(`• ${escapeHtml(error)}`);
  }
  return lines.join("\n");
}

function missingPayoutLine(scope: FeeClaimScope, chain: FeeChain): string {
  const example = chain === "solana" ? "Solana address" : "0x address";
  return scope.kind === "group"
    ? `Payout wallet: <b>not set</b>. The group owner sets it with <code>/setpayout &lt;${example}&gt;</code>.`
    : `Payout wallet: <b>not set</b>. Set it with <code>/setmypayout &lt;${example}&gt;</code>.`;
}

export function formatAmount(value: bigint, chain: FeeChain): string {
  const symbol = chain === "solana" ? "SOL" : "ETH";
  const amount = Number(value) / 10 ** (chain === "solana" ? 9 : 18);
  if (value > 0n && amount < 0.000001) return `&lt;0.000001 ${symbol}`;
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${symbol}`;
}

function explorerTxUrl(chain: FeeChain, tx: string): string {
  return chain === "solana" ? `https://solscan.io/tx/${tx}` : `${ROBINHOOD_EXPLORER_URL}/tx/${tx}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/** One line for Telegram: viem's short message when there is one, and never the multi-line details or logs. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return ((error as { shortMessage?: string }).shortMessage ?? error.message).split("\n")[0];
}
