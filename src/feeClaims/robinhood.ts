// Creator-fee claims for Robinhood Chain launch wallets on Pons. A coin's trading fees wait on its bonding curve until
// someone sweeps them; a sweep credits the creator's share (70% of the 1% fee) to Pons' fee escrow, and claim() pays
// it out in ETH to the launch wallet.
import { encodeFunctionData, getAddress, isAddress, parseAbi, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PONS_FACTORY } from "../launchpads/pons.js";
import { ROBINHOOD_EXPLORER_URL, robinhoodPublicClient, robinhoodWalletClient } from "../launchpads/robinhoodChain.js";
import type { ClaimRun } from "./types.js";

// docs.ponsfamily.com/docs/v2#contracts
export const PONS_FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" as const;

const ponsFeeAbi = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function graduated() view returns (bool)",
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function sweepFees(uint256 minBuybackTokensOut)",
  "function balanceOf(address recipient) view returns (uint256)",
  "function claim()"
]);

type Client = ReturnType<typeof robinhoodPublicClient>;

export interface PonsFeePlan {
  wallet: Hex;
  /** Bonding curves still holding fees that haven't been swept to the escrow. */
  curves: Hex[];
  /** ETH claim() pays once those sweeps run. */
  amount: bigint;
}

/** Reads what the wallet can claim from the Pons coins it launched (`tokens`). */
export async function planPonsFeeClaims(walletAddress: string, tokens: string[]): Promise<PonsFeePlan> {
  const client = robinhoodPublicClient();
  const wallet = getAddress(walletAddress);
  const curves: Hex[] = [];

  for (const token of tokens) {
    if (!isAddress(token)) continue;
    // Coins launched on Bags' Robinhood contracts aren't in Pons' factory and read as missing here.
    const launch = await client
      .readContract({ address: PONS_FACTORY, abi: ponsFeeAbi, functionName: "getLaunchedToken", args: [getAddress(token)] })
      .catch(() => undefined);
    if (!launch?.exists || launch.creatorFeeRecipient !== wallet || launch.pairToken !== zeroAddress) continue;

    const [graduated, quoteFees, creatorTax] = await Promise.all([
      client.readContract({ address: launch.curve, abi: ponsFeeAbi, functionName: "graduated" }),
      client.readContract({ address: launch.curve, abi: ponsFeeAbi, functionName: "quoteFeeBalance" }),
      client.readContract({ address: launch.curve, abi: ponsFeeAbi, functionName: "creatorTaxBalance" })
    ]);
    // After graduation the fees sit in Pons' Uniswap hook, which Pons' operator sweeps into the escrow itself.
    if (!graduated && quoteFees + creatorTax > 0n) curves.push(launch.curve);
  }

  return { wallet, curves, amount: await claimableAfterSweeps(client, wallet, curves) };
}

/** The escrow balance the sweeps would leave, by simulating them; the current balance if that isn't possible. */
async function claimableAfterSweeps(client: Client, wallet: Hex, curves: Hex[]): Promise<bigint> {
  const readBalance = () =>
    client.readContract({ address: PONS_FEE_ESCROW, abi: ponsFeeAbi, functionName: "balanceOf", args: [wallet] });
  if (curves.length === 0) return readBalance();

  try {
    const { results } = await client.simulateCalls({
      account: wallet,
      calls: [
        ...curves.map((curve) => ({ to: curve, data: sweepData() })),
        { to: PONS_FEE_ESCROW, data: encodeFunctionData({ abi: ponsFeeAbi, functionName: "balanceOf", args: [wallet] }) }
      ]
    });
    const balance = results[results.length - 1];
    if (balance?.status === "success" && balance.data !== "0x") return BigInt(balance.data);
  } catch (error) {
    console.warn(`[fees] Pons sweep simulation failed for ${wallet}: ${evmErrorText(error)}`);
  }
  return readBalance();
}

/** Sweeps the plan's curves, then claims the escrow into the launch wallet. */
export async function claimPonsFees(privateKey: Hex, plan: PonsFeePlan): Promise<ClaimRun> {
  const run: ClaimRun = { claims: [], errors: [] };
  if (plan.amount === 0n) return run;

  const account = privateKeyToAccount(privateKey);
  if (account.address !== plan.wallet) throw new Error("Robinhood wallet key does not match its address.");
  const client = robinhoodPublicClient();

  for (const curve of plan.curves) {
    try {
      await sendCall(client, account, curve, sweepData(), "Pons fee sweep");
    } catch (error) {
      run.errors.push(`Pons sweep ${curve.slice(0, 6)}...${curve.slice(-4)}: ${evmErrorText(error, account.address)}`);
    }
  }

  const owed = await client.readContract({
    address: PONS_FEE_ESCROW,
    abi: ponsFeeAbi,
    functionName: "balanceOf",
    args: [account.address]
  });
  if (owed === 0n) return run;

  try {
    const tx = await sendCall(
      client,
      account,
      PONS_FEE_ESCROW,
      encodeFunctionData({ abi: ponsFeeAbi, functionName: "claim" }),
      "Pons fee claim"
    );
    // claim() pays out the whole escrow balance, which can only have grown since it was read.
    run.claims.push({ launchpad: "pons", amount: owed, tx });
  } catch (error) {
    run.errors.push(`Pons claim: ${evmErrorText(error, account.address)}`);
  }
  return run;
}

/** Simulates first so a revert costs no gas, then sends and waits for the receipt. */
async function sendCall(client: Client, account: PrivateKeyAccount, to: Hex, data: Hex, label: string): Promise<Hex> {
  await client.call({ account, to, data });
  const hash = await robinhoodWalletClient(account).sendTransaction({ to, data });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted on-chain: ${ROBINHOOD_EXPLORER_URL}/tx/${hash}`);
  return hash;
}

function sweepData(): Hex {
  // Buybacks are off for the bot's coins, so there are no buyback tokens to protect with a minimum.
  return encodeFunctionData({ abi: ponsFeeAbi, functionName: "sweepFees", args: [0n] });
}

function evmErrorText(error: unknown, wallet?: string): string {
  const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  if (wallet && /insufficient funds|exceeds the balance/i.test(message)) {
    return `the Robinhood launch wallet needs a little ETH for gas. Send about 0.0005 ETH to ${wallet} and try again.`;
  }
  return message.split("\n")[0];
}
