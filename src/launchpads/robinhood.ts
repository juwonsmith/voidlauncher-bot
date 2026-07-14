import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEther,
  parseEventLogs,
  zeroAddress,
  type Address
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import type { LaunchResult, Proposal } from "../types.js";
import { uploadMetadataToPinata } from "./metadata.js";

const ROBINHOOD_FACTORY = "0xe8Cc4431adF8b5A847C113EF0c6af9043219Cb37" as const;
const TOTAL_BPS = 10_000;

const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [config.ROBINHOOD_RPC_URL] }
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" }
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" }
  }
});

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

  const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport: http(config.ROBINHOOD_RPC_URL, { batch: true }),
    batch: { multicall: true },
    pollingInterval: 500
  });
  const walletClient = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(config.ROBINHOOD_RPC_URL, { batch: true })
  });

  console.log(`[launch:${proposal.id}] preparing Robinhood Chain metadata`);
  const metadataUri = await uploadMetadataToPinata(proposal, "robinhood");
  console.log(`[launch:${proposal.id}] Robinhood metadata ready: ${metadataUri}`);

  const creationFee = await publicClient.readContract({
    address: ROBINHOOD_FACTORY,
    abi: bagsFactoryAbi,
    functionName: "creationFee"
  });
  const initialBuyWei = parseEther(String(proposal.devBuyEth ?? config.DEFAULT_DEV_BUY_ETH));
  const platformFeeWei = config.ROBINHOOD_PLATFORM_FEE_ETH > 0 ? parseEther(String(config.ROBINHOOD_PLATFORM_FEE_ETH)) : 0n;
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

  const [created] = parseEventLogs({
    abi: bagsFactoryAbi,
    logs: receipt.logs,
    eventName: "TokenCreated"
  });
  if (!created) throw new Error("Robinhood launch confirmed but no TokenCreated event was found.");

  let platformFeeUrl: string | undefined;
  let platformFeeError: string | undefined;
  if (platformFeeWei > 0n && config.ROBINHOOD_PLATFORM_TREASURY_WALLET) {
    if (!isAddress(config.ROBINHOOD_PLATFORM_TREASURY_WALLET)) {
      platformFeeError = "ROBINHOOD_PLATFORM_TREASURY_WALLET is not a valid EVM address.";
    } else {
      const feeHash = await walletClient.sendTransaction({
        account,
        to: getAddress(config.ROBINHOOD_PLATFORM_TREASURY_WALLET),
        value: platformFeeWei
      });
      platformFeeUrl = `https://robinhoodchain.blockscout.com/tx/${feeHash}`;
    }
  }

  const token = created.args.token as Address;
  return {
    launchpad: "robinhood",
    dryRun: false,
    mint: token,
    curve: created.args.curve as Address,
    feeShare: created.args.feeShare as Address,
    signature: hash,
    explorerUrl: `https://robinhoodchain.blockscout.com/tx/${hash}`,
    metadataUri,
    platformFeeUrl,
    platformFeeError,
    message: `Launched ${proposal.name} ($${proposal.symbol}) on Robinhood Chain.`
  };
}
