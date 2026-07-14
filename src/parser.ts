import { z } from "zod";
import type { CoinIdeaInput, Launchpad, Proposal } from "./types.js";

const launchpads = new Set<Launchpad>(["pumpfun", "bonk", "bags", "robinhood"]);

export const ideaSchema = z.object({
  launchpad: z.enum(["pumpfun", "bonk", "bags", "robinhood"]),
  name: z.string().min(2).max(32),
  symbol: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Za-z0-9]+$/, "Symbol must be 2-10 letters or numbers."),
  description: z.string().min(10).max(500),
  website: z.string().url().optional(),
  telegram: z.string().url().optional(),
  twitter: z.string().url().optional(),
  image: z
    .string()
    .refine((value) => value.startsWith("telegram:") || z.string().url().safeParse(value).success, {
      message: "Image must be a valid URL or Telegram upload."
    })
    .optional(),
  devBuySol: z.number().positive().max(5).optional(),
  devBuyEth: z.number().positive().max(5).optional(),
  pumpfunCashback: z.boolean().optional(),
  pumpfunFeeShares: z.string().max(500).optional()
});

export function parseIdea(text: string): CoinIdeaInput {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const firstLine = lines.shift() ?? "";
  const [, rawLaunchpad] = firstLine.split(/\s+/, 2);
  const launchpad = normalizeLaunchpad(rawLaunchpad);
  const fields = new Map<string, string>();

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    fields.set(key, value);
  }

  const rawIdea = {
    launchpad,
    name: fields.get("name"),
    symbol: fields.get("symbol"),
    description: fields.get("description"),
    website: optional(fields.get("website")),
    telegram: optional(fields.get("telegram")),
    twitter: optional(fields.get("twitter") ?? fields.get("x")),
    image: optional(fields.get("image")),
    devBuySol: fields.get("devbuysol") ? Number(fields.get("devbuysol")) : undefined,
    devBuyEth: fields.get("devbuyeth") ? Number(fields.get("devbuyeth")) : undefined,
    pumpfunCashback: parseOptionalBoolean(fields.get("cashback") ?? fields.get("pumpfuncashback")),
    pumpfunFeeShares: optional(fields.get("feeshares") ?? fields.get("pumpfunfeeshares"))
  };

  return ideaSchema.parse(rawIdea);
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1", "enabled"].includes(normalized)) return true;
  if (["false", "no", "off", "0", "disabled"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function validateIdea(idea: Partial<CoinIdeaInput>): CoinIdeaInput {
  return ideaSchema.parse(idea);
}

function optional(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function normalizeLaunchpad(value: string | undefined): Launchpad {
  const normalized = value?.toLowerCase();
  if (normalized && launchpads.has(normalized as Launchpad)) {
    return normalized as Launchpad;
  }
  throw new Error("Use `/idea pumpfun`, `/idea bonk`, `/idea bags`, or `/idea robinhood` as the first line.");
}

export function formatProposal(proposal: Proposal): string {
  const lines = [
    `#${proposal.id} ${proposal.name} ($${proposal.symbol})`,
    `Launchpad: ${proposal.launchpad}`,
    `Status: ${proposal.status}`,
    `Description: ${proposal.description}`,
    proposal.website ? `Website: ${proposal.website}` : undefined,
    proposal.telegram ? `Telegram: ${proposal.telegram}` : undefined,
    proposal.twitter ? `Twitter/X: ${proposal.twitter}` : undefined,
    proposal.image ? `Image: ${proposal.image}` : undefined,
    proposal.launchpad === "robinhood"
      ? `Initial buy: ${proposal.devBuyEth ?? "default"} ETH`
      : `Dev buy: ${proposal.devBuySol ?? "default"} SOL`,
    `Submitted by: ${proposal.createdByUsername ?? proposal.createdBy}`
  ].filter(Boolean);

  return lines.join("\n");
}

export function ideaHelp(): string {
  return [
    "Send a proposal like this:",
    "",
    "/idea pumpfun",
    "Name: Example Cat",
    "Symbol: ECAT",
    "Description: Community meme coin for testing.",
    "Website: https://example.com",
    "Telegram: https://t.me/example",
    "Twitter: https://x.com/example",
    "Image: https://example.com/logo.png",
    "DevBuySol: 0.01",
    "",
    "For Robinhood Chain, use <code>/idea robinhood</code> and optionally <code>DevBuyEth: 0.01</code>."
  ].join("\n");
}
