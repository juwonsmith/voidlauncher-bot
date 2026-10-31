// Custom contract addresses: a Pump.fun/Bonk mint whose address starts or ends with text the customer picks.
// Kept free of config and database imports so pricing and difficulty can be tested on their own.
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { CoinIdeaInput } from "./types.js";

export type CustomCaPosition = "start" | "end";

export interface CustomCaRequest {
  position: CustomCaPosition;
  pattern: string;
}

export interface CustomCaPricing {
  feesByLength: Map<number, number>;
  keysPerSecond: number;
  maxWaitMinutes: number;
}

export interface CustomCaQuote extends CustomCaRequest {
  feeSol: number;
  expectedAttempts: number;
  expectedSeconds: number;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// About 1 in 17 addresses starts with each of these; every other first character is ~1 in 1,000 (J is ~1 in 70).
// Derived from prefixMatchCount; the tests check it still matches.
export const FAST_FIRST_CHARACTERS = "23456789ABCDEFGH";
export const FAST_FIRST_CHARACTERS_LABEL = "2–9 or A–H";
const TWO_256 = 1n << 256n;
// A 32-byte key below 2^248 has a leading zero byte, which base58 writes as a leading "1".
const TWO_248 = 1n << 248n;
const MAX_ADDRESS_LENGTH = 44;
const MAX_PATTERN_LENGTH = 8;

/** Parses CUSTOM_CA_FEES_SOL, e.g. "3:0.05,4:0.1" (pattern length : fee in SOL). Lengths not listed are not offered. */
export function parseCustomCaFees(spec: string): Map<number, number> {
  const fees = new Map<number, number>();
  for (const entry of spec.split(",").map((part) => part.trim()).filter(Boolean)) {
    const [lengthText, feeText] = entry.split(":").map((part) => part.trim());
    const length = Number(lengthText);
    const fee = Number(feeText);
    if (!Number.isInteger(length) || length < 1 || length > MAX_PATTERN_LENGTH || !Number.isFinite(fee) || fee < 0) {
      throw new Error(`Invalid CUSTOM_CA_FEES_SOL entry "${entry}". Use length:fee pairs like 3:0.05,4:0.1.`);
    }
    fees.set(length, fee);
  }
  return fees;
}

export function normalizeCustomCaPattern(position: CustomCaPosition, value: string): string {
  const pattern = value.trim();
  if (!pattern) throw new Error(`Send the text the CA should ${position === "start" ? "start" : "end"} with.`);

  const invalid = [...new Set([...pattern].filter((char) => !BASE58_ALPHABET.includes(char)))];
  if (invalid.length > 0) {
    const suggestion = validSpelling(pattern);
    throw new Error(
      `A CA can't contain ${invalid.map((char) => (char === " " ? "spaces" : `"${char}"`)).join(", ")}. ` +
        "CAs never use 0, O, I or l." +
        (suggestion && suggestion !== pattern ? ` Try "${suggestion}" instead.` : "")
    );
  }
  if (position === "start" && pattern.startsWith("1")) {
    throw new Error(`A CA can't start with 1. Begin with ${FAST_FIRST_CHARACTERS_LABEL} for a fast result.`);
  }
  return pattern;
}

/** A spelling CAs can contain: lowercase (so MOON becomes moon), with l as L and 0 as o, other symbols dropped. */
function validSpelling(pattern: string): string | undefined {
  const spelled = [...pattern.toLowerCase()]
    .map((char) => (char === "l" ? "L" : char === "0" ? "o" : char))
    .filter((char) => BASE58_ALPHABET.includes(char))
    .join("");
  return spelled.length > 0 ? spelled : undefined;
}

/** Average number of random keys needed before one matches. */
export function expectedAttempts(request: CustomCaRequest): number {
  if (request.position === "end") return 58 ** request.pattern.length;

  // Base58 addresses are 43-44 characters, and only a few first characters are common, so a
  // prefix's odds depend on its characters, not just its length. Count matching 32-byte values exactly.
  const matches = prefixMatchCount(request.pattern);
  const probability = Number((matches << 64n) / TWO_256) / 2 ** 64;
  return probability > 0 ? 1 / probability : Infinity;
}

export function quoteCustomCa(request: CustomCaRequest, pricing: CustomCaPricing): CustomCaQuote {
  const feeSol = pricing.feesByLength.get(request.pattern.length);
  if (feeSol === undefined) {
    throw new Error(
      `Custom CAs are ${describeLengths(pricing.feesByLength)} characters long. "${request.pattern}" has ${request.pattern.length}.`
    );
  }

  const attempts = expectedAttempts(request);
  const expectedSeconds = attempts / pricing.keysPerSecond;
  if (expectedSeconds > pricing.maxWaitMinutes * 60) {
    const slow = `"${request.pattern}" would take about ${formatSearchTime(expectedSeconds)} to find, over the ${formatSearchTime(
      pricing.maxWaitMinutes * 60
    )} limit.`;
    const firstCharacter = request.pattern[0];
    throw new Error(
      request.position === "start" && !FAST_FIRST_CHARACTERS.includes(firstCharacter)
        ? `${slow} Very few CAs start with "${firstCharacter}". Use Ends with… for this text, or begin with ${FAST_FIRST_CHARACTERS_LABEL}.`
        : `${slow} Try fewer characters.`
    );
  }

  return { ...request, feeSol, expectedAttempts: attempts, expectedSeconds };
}

export function matchesCustomCa(address: string, request: CustomCaRequest): boolean {
  return request.position === "start" ? address.startsWith(request.pattern) : address.endsWith(request.pattern);
}

/** Returns why a grinder result can't be used, or undefined when the keypair is valid and matches the order. */
export function customCaKeypairProblem(request: CustomCaRequest, address: string, secretKeyBase58: string): string | undefined {
  let secretKey: Uint8Array;
  try {
    secretKey = bs58.decode(secretKeyBase58);
  } catch {
    return "secret key is not base58";
  }
  if (secretKey.length !== 64) return "secret key must be 64 bytes";

  const derived = nacl.sign.keyPair.fromSeed(secretKey.slice(0, 32));
  const derivedAddress = bs58.encode(derived.publicKey);
  if (bs58.encode(secretKey.slice(32)) !== derivedAddress) return "secret key halves do not match";
  if (derivedAddress !== address) return "address does not match the secret key";
  if (!matchesCustomCa(address, request)) return `address does not ${describeCustomCa(request)}`;
  return undefined;
}

export function describeCustomCa(request: CustomCaRequest): string {
  return `${request.position === "start" ? "start" : "end"} with ${request.pattern}`;
}

/** The custom CA fee owed for a proposal, or 0 when it uses a normal address. */
export function customCaFeeSol(idea: Pick<CoinIdeaInput, "customCaPattern" | "customCaFeeSol">): number {
  return idea.customCaPattern ? Math.max(0, idea.customCaFeeSol ?? 0) : 0;
}

/** "3 or 4", "3, 4 or 5" */
export function describeLengths(feesByLength: Map<number, number>): string {
  const lengths = [...feesByLength.keys()].sort((a, b) => a - b).map(String);
  return lengths.length > 1 ? `${lengths.slice(0, -1).join(", ")} or ${lengths.at(-1)}` : lengths.join("");
}

/** Average wait for an "ends with" order of this length; "starts with" is similar when it begins with a fast character. */
export function typicalSearchTime(length: number, keysPerSecond: number): string {
  return formatSearchTime(58 ** length / keysPerSecond);
}

export function formatSearchTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  if (seconds < 2 * 3600) return `${Math.ceil(seconds / 60)} min`;
  const hours = seconds / 3600;
  return hours < 48 ? `${hours.toFixed(1)} hours` : `${Math.round(hours / 24)} days`;
}

function prefixMatchCount(pattern: string): bigint {
  let patternValue = 0n;
  for (const char of pattern) patternValue = patternValue * 58n + BigInt(BASE58_ALPHABET.indexOf(char));

  let count = 0n;
  for (let length = pattern.length; length <= MAX_ADDRESS_LENGTH; length += 1) {
    const scale = 58n ** BigInt(length - pattern.length);
    const low = maxBigInt(patternValue * scale, 58n ** BigInt(length - 1), TWO_248);
    const high = minBigInt((patternValue + 1n) * scale, 58n ** BigInt(length), TWO_256);
    if (high > low) count += high - low;
  }
  return count;
}

function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((best, value) => (value > best ? value : best));
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((best, value) => (value < best ? value : best));
}
