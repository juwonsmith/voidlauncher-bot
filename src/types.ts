export type Launchpad = "pumpfun" | "bonk" | "bags" | "robinhood";
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
  devBuyEth?: number;
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
  feeSharingSignature?: string;
  feeSharingUrl?: string;
  feeSharingError?: string;
  platformFeeSignature?: string;
  platformFeeUrl?: string;
  platformFeeError?: string;
  curve?: string;
  feeShare?: string;
  message: string;
}
