import { config } from "../config.js";
import type { LaunchResult, Proposal } from "../types.js";
import { launchWithBags } from "./bags.js";
import { launchWithPons, readPonsLaunchFeeEth } from "./pons.js";
import { launchWithPumpPortal } from "./pumpportal.js";
import { launchWithRobinhoodBags, readBagsCreationFeeEth } from "./robinhood.js";

export async function launchProposal(proposal: Proposal): Promise<LaunchResult> {
  if (config.DRY_RUN) {
    return {
      launchpad: proposal.launchpad,
      dryRun: true,
      message: `Dry run only. Would launch ${proposal.name} ($${proposal.symbol}) on ${proposal.launchpad}.`
    };
  }

  if (proposal.launchpad === "pumpfun" || proposal.launchpad === "bonk") {
    return launchWithPumpPortal(proposal);
  }

  if (proposal.launchpad === "bags") {
    if (!config.PUMPFUN_SIGNER_PRIVATE_KEY) {
      throw new Error("PUMPFUN_SIGNER_PRIVATE_KEY is required for API Bags launches. Prefer Launch Group for Bags.");
    }
    return launchWithBags(proposal, config.PUMPFUN_SIGNER_PRIVATE_KEY);
  }

  if (proposal.launchpad === "robinhood") {
    throw new Error("Robinhood Chain launches use group or personal Robinhood wallets. Use Launch Group or Launch Me.");
  }

  throw new Error(`Unsupported launchpad: ${proposal.launchpad}`);
}

/** Robinhood Chain proposals launch on Pons unless ROBINHOOD_LAUNCHPAD=bags. */
export function robinhoodLaunchpadName(): "Pons" | "Bags" {
  return config.ROBINHOOD_LAUNCHPAD === "bags" ? "Bags" : "Pons";
}

export function launchOnRobinhood(
  proposal: Proposal,
  privateKey: `0x${string}`,
  expectedAddress?: string
): Promise<LaunchResult> {
  return config.ROBINHOOD_LAUNCHPAD === "bags"
    ? launchWithRobinhoodBags(proposal, privateKey, expectedAddress)
    : launchWithPons(proposal, privateKey, expectedAddress);
}

/** The selected Robinhood launchpad's current launch fee in ETH, read live. */
export function readRobinhoodLaunchFeeEth(): Promise<number> {
  return config.ROBINHOOD_LAUNCHPAD === "bags" ? readBagsCreationFeeEth() : readPonsLaunchFeeEth();
}
