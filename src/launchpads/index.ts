import { config } from "../config.js";
import type { LaunchResult, Proposal } from "../types.js";
import { launchWithPumpPortal } from "./pumpportal.js";

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
    throw new Error("Bags launches are disabled for this production release.");
  }

  throw new Error(`Unsupported launchpad: ${proposal.launchpad}`);
}
