export type Launchpad = "pumpfun" | "bonk" | "bags";
export type ProposalStatus = "pending" | "approved" | "rejected" | "launched";

export interface CoinIdeaInput {
  launchpad: Launchpad;
  name: string;
  symbol: string;
  description: string;
  website?: string;
  telegram?: string;
  twitter?: string;
  image?: string;
  devBuySol?: number;
  pumpfunCashback?: boolean;
  pumpfunFeeShares?: string;
}

export interface Proposal extends CoinIdeaInput {
  id: number;
  status: ProposalStatus;
  createdBy: number;
  createdByUsername?: string;
  createdAt: string;
  approvedBy?: number;
  approvedAt?: string;
  rejectionReason?: string;
  launchSignature?: string;
}

export interface LaunchResult {
  launchpad: Launchpad;
  dryRun: boolean;
  mint?: string;
  signature?: string;
  explorerUrl?: string;
  metadataUri?: string;
  message: string;
}
