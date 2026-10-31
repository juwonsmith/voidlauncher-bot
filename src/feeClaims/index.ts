// Creator-fee claiming for the bot's launch wallets. Every launch makes its launch wallet the coin's fee receiver;
// claiming pulls the fees into that wallet, and the group (or member) moves them on by exporting the wallet's key.
import { getWallet, listLaunchedMints, type StoredWallet } from "../db.js";
import { ROBINHOOD_EXPLORER_URL } from "../launchpads/robinhoodChain.js";
import { escapeHtml } from "../messages.js";
import { exportWalletSecretBase58, getRobinhoodWalletSecret } from "../wallets.js";
import { claimPonsFees, planPonsFeeClaims } from "./robinhood.js";
import { claimSolanaFees, planSolanaFeeClaims, solanaPlanTotals } from "./solana.js";
import type { ClaimRun, FeeClaimed, FeeLaunchpad } from "./types.js";

export type FeeChain = "solana" | "robinhood";

export interface FeeClaimScope {
  kind: "group" | "user";
  id: string;
}

const CHAINS: FeeChain[] = ["solana", "robinhood"];
const WALLET_SCOPES: Record<FeeClaimScope["kind"], Record<FeeChain, StoredWallet["scope"]>> = {
  group: { solana: "group_portal", robinhood: "group_evm" },
  user: { solana: "user", robinhood: "user_evm" }
};
const LAUNCHPAD_LABELS: Record<FeeLaunchpad, string> = { pumpfun: "Pump.fun", bags: "Bags", pons: "Pons" };

export interface ChainFeeStatus {
  chain: FeeChain;
  wallet: string;
  sources: Array<{ label: string; amount: bigint }>;
  notes: string[];
  error?: string;
}

export interface ChainClaimOutcome {
  chain: FeeChain;
  wallet: string;
  claims: FeeClaimed[];
  errors: string[];
}

/** What each of the scope's launch wallets can claim right now. Read-only. */
export async function checkCreatorFees(scope: FeeClaimScope): Promise<ChainFeeStatus[]> {
  const statuses: ChainFeeStatus[] = [];

  for (const chain of CHAINS) {
    const wallet = await getWallet(WALLET_SCOPES[scope.kind][chain], scope.id);
    if (!wallet) continue;
    const status: ChainFeeStatus = { chain, wallet: wallet.address, sources: [], notes: [] };
    statuses.push(status);

    try {
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

/** Claims every launch wallet in the scope. The fees stay in those wallets. */
export async function claimCreatorFees(scope: FeeClaimScope): Promise<ChainClaimOutcome[]> {
  const outcomes: ChainClaimOutcome[] = [];

  for (const chain of CHAINS) {
    const wallet = await getWallet(WALLET_SCOPES[scope.kind][chain], scope.id);
    if (!wallet) continue;
    const outcome: ChainClaimOutcome = { chain, wallet: wallet.address, claims: [], errors: [] };
    outcomes.push(outcome);

    try {
      let run: ClaimRun;
      if (chain === "solana") {
        const { secretKey } = await exportWalletSecretBase58(WALLET_SCOPES[scope.kind].solana, scope.id);
        const plan = await planSolanaFeeClaims(wallet.address, await listLaunchedMints(wallet.address, "pumpfun"));
        if (plan.bagsError) outcome.errors.push(`Bags couldn't be checked: ${plan.bagsError}`);
        run = await claimSolanaFees(secretKey, plan);
      } else {
        const { privateKey } = await getRobinhoodWalletSecret(scope.kind, scope.id);
        run = await claimPonsFees(
          privateKey,
          await planPonsFeeClaims(wallet.address, await listLaunchedMints(wallet.address, "robinhood"))
        );
      }
      outcome.claims = run.claims;
      outcome.errors.push(...run.errors);
    } catch (error) {
      outcome.errors.push(errorText(error));
    }
  }
  return outcomes;
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
    if (status.error) lines.push(`Couldn't check for fees: ${escapeHtml(status.error)}`);
    else if (found.length === 0) lines.push("Nothing to claim right now.");
    for (const note of status.notes) lines.push(`<i>${escapeHtml(note)}</i>`);
    if (found.length > 0) canClaim = true;
  }

  if (canClaim) {
    lines.push(
      "",
      "<b>Claim fees</b> moves them into the launch wallets. Network fees are paid from those wallets, so leave a " +
        "little SOL or ETH in them."
    );
  }
  return { text: lines.join("\n"), canClaim };
}

export function feeClaimResultMessage(scope: FeeClaimScope, outcomes: ChainClaimOutcome[]): string {
  const problems = outcomes.some((outcome) => outcome.errors.length > 0);
  const claimed = outcomes.some((outcome) => outcome.claims.length > 0);
  const lines = [
    problems ? "&#9888;&#65039; <b>Creator fee claim finished with problems</b>" : "&#9989; <b>Creator fees claimed</b>"
  ];

  for (const outcome of outcomes) {
    lines.push("", `<b>${chainLabel(outcome.chain)}</b> · <code>${escapeHtml(outcome.wallet)}</code>`);
    for (const claim of outcome.claims) {
      lines.push(
        `${LAUNCHPAD_LABELS[claim.launchpad]}: <b>${formatAmount(claim.amount, outcome.chain)}</b> · ` +
          `<a href="${explorerTxUrl(outcome.chain, claim.tx)}">transaction</a>`
      );
    }
    if (outcome.claims.length === 0 && outcome.errors.length === 0) lines.push("Nothing to claim.");
    for (const error of outcome.errors) lines.push(`• ${escapeHtml(error)}`);
  }

  if (claimed) {
    lines.push(
      "",
      scope.kind === "group"
        ? "The fees are in the group's launch wallet. Its owner and admins can export the wallet key in a DM with the " +
            "bot: <code>/exportgroupwallet</code>."
        : "The fees are in your launch wallet. Export its key in a DM with the bot: <code>/exportmywallet</code>."
    );
  }
  return lines.join("\n");
}

export function chainLabel(chain: FeeChain): string {
  return chain === "solana" ? "Solana" : "Robinhood Chain";
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

/** One line for Telegram: viem's short message when there is one, and never the multi-line details or logs. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return ((error as { shortMessage?: string }).shortMessage ?? error.message).split("\n")[0];
}
