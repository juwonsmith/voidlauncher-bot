// Pons V2 launches on Robinhood Chain (docs.ponsfamily.com/docs/v2), the default Robinhood launchpad.
// Pons has no API: the name, logo, description and socials all go into the launch transaction itself,
// and the logo must be an ipfs:// URI.
import crypto from "node:crypto";
import {
  encodeFunctionData,
  formatEther,
  getAddress,
  parseAbi,
  parseEther,
  parseEventLogs,
  zeroAddress,
  type Log,
  type PrivateKeyAccount
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import type { LaunchResult, Proposal } from "../types.js";
import { uploadImageToPinata } from "./metadata.js";
import {
  ROBINHOOD_EXPLORER_URL,
  robinhoodPublicClient,
  robinhoodWalletClient,
  sendRobinhoodPlatformFee
} from "./robinhoodChain.js";

export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;
export const PONS_ROUTER = "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948" as const;
// Pons currently has a single launch config (#0), and new tokens pair against native ETH (the zero address).
const LAUNCH_CONFIG_ID = 0n;
const NATIVE_ETH = zeroAddress;

const ponsAbi = parseAbi([
  "struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }",
  "struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }",
  "function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)",
  "function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)",
  "function launchFee() view returns (uint256)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)"
]);

export function ponsTokenUrl(token: string): string {
  return `https://www.ponsfamily.com/launchpad/${token}`;
}

/** Pons' current launch fee in ETH (0.0005 ETH when checked); read live because Pons can change it. */
export async function readPonsLaunchFeeEth(): Promise<number> {
  const fee = await robinhoodPublicClient().readContract({ address: PONS_FACTORY, abi: ponsAbi, functionName: "launchFee" });
  return Number(formatEther(fee));
}

/** Turns Pinata's https://ipfs.io/ipfs/CID gateway URL into the ipfs://CID form Pons expects. */
export function toIpfsUri(url: string): string {
  const cid = url.match(/\/ipfs\/([^/?#]+)/)?.[1];
  if (!cid) throw new Error(`Expected an IPFS gateway URL, got ${url}`);
  return `ipfs://${cid}`;
}

/** The TokenLaunched event in a launch receipt, or undefined if none decodes. */
export function findPonsLaunch(logs: Log[]) {
  const [launched] = parseEventLogs({ abi: ponsAbi, logs, eventName: "TokenLaunched" });
  return launched?.args;
}

/**
 * Builds and simulates the Pons launch, returning the transaction to send. With a dev buy it uses the LaunchAndBuy
 * router, quoting the buy first and protecting it with DEFAULT_SLIPPAGE_PERCENT; without one it calls the factory's
 * launchToken.
 */
export async function preparePonsLaunch(
  client: ReturnType<typeof robinhoodPublicClient>,
  account: PrivateKeyAccount,
  proposal: Proposal,
  logo: string
) {
  const [launchFee, expectedEconomics] = await Promise.all([
    client.readContract({ address: PONS_FACTORY, abi: ponsAbi, functionName: "launchFee" }),
    // Must match the launch config at send time, or Pons reverts with LaunchEconomicsMismatch.
    client.readContract({
      address: PONS_FACTORY,
      abi: ponsAbi,
      functionName: "previewLaunchEconomics",
      args: [LAUNCH_CONFIG_ID, NATIVE_ETH]
    })
  ]);
  const owner = getAddress(account.address);
  const params = {
    name: proposal.name,
    symbol: proposal.symbol,
    logo,
    description: proposal.description,
    socials: {
      twitter: proposal.twitter ?? "",
      telegram: proposal.telegram ?? "",
      discord: "",
      website: proposal.website ?? "",
      farcaster: ""
    },
    creatorFeeRecipient: owner,
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics,
    // Pons derives the token address from this salt (CREATE2); reusing one with the same terms reverts.
    salt: `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`
  };
  const quoteIn = parseEther(String(proposal.devBuyEth ?? config.DEFAULT_DEV_BUY_ETH));

  if (quoteIn === 0n) {
    const args = [params, LAUNCH_CONFIG_ID, NATIVE_ETH] as const;
    await client.simulateContract({ account, address: PONS_FACTORY, abi: ponsAbi, functionName: "launchToken", args, value: launchFee });
    const data = encodeFunctionData({ abi: ponsAbi, functionName: "launchToken", args });
    return { transaction: { to: PONS_FACTORY, data, value: launchFee }, launchFee, quoteIn, minTokensOut: 0n };
  }

  const buyArgs = (minTokensOut: bigint) => [params, LAUNCH_CONFIG_ID, NATIVE_ETH, quoteIn, minTokensOut, owner, []] as const;
  const simulateBuy = (minTokensOut: bigint) =>
    client.simulateContract({
      account,
      address: PONS_ROUTER,
      abi: ponsAbi,
      functionName: "launchAndBuy",
      args: buyArgs(minTokensOut),
      value: launchFee + quoteIn
    });
  const quote = await simulateBuy(0n);
  const keepBps = BigInt(Math.round((100 - config.DEFAULT_SLIPPAGE_PERCENT) * 100));
  const minTokensOut = (quote.result[2] * keepBps) / 10_000n;
  await simulateBuy(minTokensOut);
  const data = encodeFunctionData({ abi: ponsAbi, functionName: "launchAndBuy", args: buyArgs(minTokensOut) });
  return { transaction: { to: PONS_ROUTER, data, value: launchFee + quoteIn }, launchFee, quoteIn, minTokensOut };
}

export async function launchWithPons(
  proposal: Proposal,
  privateKey: `0x${string}`,
  expectedAddress?: string
): Promise<LaunchResult> {
  if (!proposal.image) throw new Error("An image is required for Pons launches.");
  if (proposal.launchpad !== "robinhood") throw new Error("Pons launches only support Robinhood proposals.");

  const account = privateKeyToAccount(privateKey);
  if (expectedAddress && account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error("Robinhood signer private key does not match wallet address.");
  }

  const publicClient = robinhoodPublicClient();
  const walletClient = robinhoodWalletClient(account);

  const logo = toIpfsUri(await uploadImageToPinata(proposal, "pons"));
  console.log(`[launch:${proposal.id}] Pons logo ready: ${logo}`);

  const { transaction, launchFee, quoteIn, minTokensOut } = await preparePonsLaunch(publicClient, account, proposal, logo);
  console.log(
    `[launch:${proposal.id}] Pons launch fee=${formatEther(launchFee)} ETH buy=${formatEther(quoteIn)} ETH minTokensOut=${minTokensOut}`
  );
  const hash = await walletClient.sendTransaction(transaction);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("Pons launch transaction reverted on-chain.");

  // The ETH is already spent, so a missing event must not turn a successful launch into a reported failure.
  const launched = findPonsLaunch(receipt.logs);
  if (!launched) console.warn(`[launch:${proposal.id}] Pons launch ${hash} succeeded but TokenLaunched did not decode`);

  const platformFee = await sendRobinhoodPlatformFee(walletClient);

  return {
    launchpad: "robinhood",
    dryRun: false,
    mint: launched?.token,
    curve: launched?.curve,
    signature: hash,
    explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${hash}`,
    metadataUri: logo,
    platformFeeUrl: platformFee.url,
    platformFeeError: platformFee.error,
    message: launched
      ? `Launched ${proposal.name} ($${proposal.symbol}) on Pons (Robinhood Chain).`
      : `Launched ${proposal.name} ($${proposal.symbol}) on Pons (Robinhood Chain). The bot couldn't read the new token's ` +
        "address, so open the transaction on Blockscout to find it."
  };
}
