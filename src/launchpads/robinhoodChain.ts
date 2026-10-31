// Robinhood Chain plumbing shared by the Pons and Bags launchers: chain definition, clients and the platform fee.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseEther,
  type PrivateKeyAccount
} from "viem";
import { config } from "../config.js";

export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [config.ROBINHOOD_RPC_URL] }
  },
  blockExplorers: {
    default: { name: "Blockscout", url: ROBINHOOD_EXPLORER_URL }
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" }
  }
});

export function robinhoodPublicClient() {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(config.ROBINHOOD_RPC_URL, { batch: true }),
    batch: { multicall: true },
    pollingInterval: 500
  });
}

export function robinhoodWalletClient(account: PrivateKeyAccount) {
  return createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(config.ROBINHOOD_RPC_URL, { batch: true })
  });
}

/**
 * Sends ROBINHOOD_PLATFORM_FEE_ETH to the Robinhood treasury after a successful launch. Failures come back as an
 * error string instead of throwing, so a launch that already went through is never reported as failed.
 */
export async function sendRobinhoodPlatformFee(
  walletClient: ReturnType<typeof robinhoodWalletClient>
): Promise<{ url?: string; error?: string }> {
  const feeEth = config.ROBINHOOD_PLATFORM_FEE_ETH;
  const treasury = config.ROBINHOOD_PLATFORM_TREASURY_WALLET;
  if (feeEth <= 0 || !treasury) return {};
  if (!isAddress(treasury)) return { error: "ROBINHOOD_PLATFORM_TREASURY_WALLET is not a valid EVM address." };

  try {
    const hash = await walletClient.sendTransaction({ to: getAddress(treasury), value: parseEther(String(feeEth)) });
    return { url: `${ROBINHOOD_EXPLORER_URL}/tx/${hash}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}
