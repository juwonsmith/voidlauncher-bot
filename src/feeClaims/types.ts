// Shapes shared by the Solana and Robinhood fee-claim modules.
export type FeeLaunchpad = "pumpfun" | "bags" | "pons";

/** A claim that confirmed: `amount` (lamports or wei) is now in the launch wallet. */
export interface FeeClaimed {
  launchpad: FeeLaunchpad;
  amount: bigint;
  tx: string;
}

export interface ClaimRun {
  claims: FeeClaimed[];
  errors: string[];
}

/** Thrown when a transfer was never broadcast, so its claims can be sent again right away. */
export class TransferNotSentError extends Error {}
