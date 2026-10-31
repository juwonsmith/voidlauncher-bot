// Bags launches on Robinhood Chain: the backup Robinhood launchpad, used when ROBINHOOD_LAUNCHPAD=bags.
import { formatEther, getAddress, parseEther, parseEventLogs, zeroAddress, type Address, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import type { LaunchResult, Proposal } from "../types.js";
import { uploadMetadataToPinata } from "./metadata.js";
import {
  ROBINHOOD_EXPLORER_URL,
  robinhoodPublicClient,
  robinhoodWalletClient,
  sendRobinhoodPlatformFee
} from "./robinhoodChain.js";

const ROBINHOOD_FACTORY = "0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37" as const;
const TOTAL_BPS = 10_000;

const bagsFactoryAbi = [
  {
    type: "function",
    name: "creationFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "create",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "partner", type: "address" },
      { name: "claimers", type: "address[]" },
      { name: "bps", type: "uint16[]" }
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" }
    ]
  },
  {
    type: "function",
    name: "createAndBuy",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "partner", type: "address" },
      { name: "claimers", type: "address[]" },
      { name: "bps", type: "uint16[]" }
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curve", type: "address" }
    ]
  },
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "curve", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "feeShare", type: "address", indexed: false },
      { name: "partner", type: "address", indexed: false },
      { name: "poolId", type: "bytes32", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "metadataURI", type: "string", indexed: false }
    ],
    anonymous: false
  }
] as const;

/** Bags' current creation fee in ETH. The factory owner can change it, so read it per launch. */
export async function readBagsCreationFeeEth(): Promise<number> {
  const fee = await robinhoodPublicClient().readContract({
    address: ROBINHOOD_FACTORY,
    abi: bagsFactoryAbi,
    functionName: "creationFee"
  });
  return Number(formatEther(fee));
}

/** The TokenCreated event in a launch receipt, or undefined if none decodes with this ABI. */
export function findTokenCreated(logs: Log[]) {
  const [created] = parseEventLogs({ abi: bagsFactoryAbi, logs, eventName: "TokenCreated" });
  return created?.args;
}

export async function launchWithRobinhoodBags(
  proposal: Proposal,
  privateKey: `0x${string}`,
  expectedAddress?: string
): Promise<LaunchResult> {
  if (!proposal.image) throw new Error("An image is required for Robinhood Chain launches.");
  if (proposal.launchpad !== "robinhood") throw new Error("Robinhood launcher only supports Robinhood proposals.");

  const account = privateKeyToAccount(privateKey);
  if (expectedAddress && account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error("Robinhood signer private key does not match wallet address.");
  }

  const publicClient = robinhoodPublicClient();
  const walletClient = robinhoodWalletClient(account);

  console.log(`[launch:${proposal.id}] preparing Robinhood Chain metadata`);
  const metadataUri = await uploadMetadataToPinata(proposal, "robinhood");
  console.log(`[launch:${proposal.id}] Robinhood metadata ready: ${metadataUri}`);

  const creationFee = await publicClient.readContract({
    address: ROBINHOOD_FACTORY,
    abi: bagsFactoryAbi,
    functionName: "creationFee"
  });
  const initialBuyWei = parseEther(String(proposal.devBuyEth ?? config.DEFAULT_DEV_BUY_ETH));
  const args = [
    proposal.name,
    proposal.symbol,
    metadataUri,
    zeroAddress,
    [getAddress(account.address)],
    [TOTAL_BPS]
  ] as const;
  const functionName = initialBuyWei > 0n ? "createAndBuy" : "create";
  const value = creationFee + initialBuyWei;

  console.log(
    `[launch:${proposal.id}] Robinhood ${functionName} value=${formatEther(value)} ETH fee=${formatEther(creationFee)} ETH`
  );
  const { request } = await publicClient.simulateContract({
    account,
    address: ROBINHOOD_FACTORY,
    abi: bagsFactoryAbi,
    functionName,
    args,
    value
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error("Robinhood launch transaction reverted on-chain.");

  // The ETH is already spent at this point, so a missing event (say, after a Bags contract upgrade) must not
  // turn a successful launch into a reported failure; the transaction link still shows the new token.
  const created = findTokenCreated(receipt.logs);
  if (!created) console.warn(`[launch:${proposal.id}] Robinhood launch ${hash} succeeded but TokenCreated did not decode`);

  const platformFee = await sendRobinhoodPlatformFee(walletClient);

  return {
    launchpad: "robinhood",
    dryRun: false,
    mint: created?.token as Address | undefined,
    curve: created?.curve as Address | undefined,
    feeShare: created?.feeShare as Address | undefined,
    signature: hash,
    explorerUrl: `${ROBINHOOD_EXPLORER_URL}/tx/${hash}`,
    metadataUri,
    platformFeeUrl: platformFee.url,
    platformFeeError: platformFee.error,
    message: created
      ? `Launched ${proposal.name} ($${proposal.symbol}) on Robinhood Chain.`
      : `Launched ${proposal.name} ($${proposal.symbol}) on Robinhood Chain. The bot couldn't read the new token's address, ` +
        "so open the transaction on Blockscout to find it."
  };
}
