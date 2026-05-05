import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ override: true });

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ADMIN_TELEGRAM_IDS: z.string().min(1),
  ALLOW_GROUP_ADMINS: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  DATABASE_PATH: z.string().default("./data/bot.sqlite"),
  DRY_RUN: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  PUMPFUN_SIGNER_PRIVATE_KEY: z.string().optional(),
  PUMPFUN_CASHBACK: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  PUMPFUN_FEE_SHARES: z.string().default(""),
  PLATFORM_TREASURY_WALLET: z.string().default(""),
  PLATFORM_FEE_SOL: z.coerce.number().min(0).default(0),
  PUMPPORTAL_API_KEY: z.string().optional(),
  BAGS_API_KEY: z.string().optional(),
  PINATA_JWT: z.string().optional(),
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  BALANCE_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
  BALANCE_CHECK_ATTEMPTS: z.coerce.number().int().positive().default(3),
  DEFAULT_DEV_BUY_SOL: z.coerce.number().positive().default(0.01),
  MAX_DEV_BUY_SOL: z.coerce.number().positive().default(0.05),
  GROUP_DAILY_LAUNCH_LIMIT: z.coerce.number().int().positive().default(10),
  USER_DAILY_LAUNCH_LIMIT: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  RATE_LIMIT_MAX_UPDATES: z.coerce.number().int().positive().default(12),
  DEFAULT_SLIPPAGE_PERCENT: z.coerce.number().positive().max(50).default(10),
  DEFAULT_PRIORITY_FEE_SOL: z.coerce.number().positive().default(0.00005),
  BONK_QUOTE_MINT: z.string().default(""),
  LOCAL_LAUNCH_MIN_SOL_BUFFER: z.coerce.number().positive().default(0.015),
  PUMP_MINT_SUFFIX: z.string().default(""),
  BONK_MINT_SUFFIX: z.string().default(""),
  BAGS_MINT_SUFFIX: z.string().default(""),
  PUMP_MINT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(25000000),
  PUMP_MINT_POOL_SIZE: z.coerce.number().int().positive().default(3),
  PUMP_MINT_WORKERS: z.coerce.number().int().positive().default(4),
  TROJAN_REF_CODE: z.string().optional(),
  TROJAN_LINK_TEMPLATE: z.string().default("https://t.me/solana_trojanbot?start=r-{ref}-{mint}"),
  BASED_LINK_TEMPLATE: z.string().default("https://t.me/based_eth_bot?start=r_<referral>_b_{mint}"),
  AXIOM_LINK_TEMPLATE: z.string().default("https://axiom.trade/t/{mint}/@thadev?chain=sol"),
  LAUNCH_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  LAUNCH_RETRY_DELAY_MS: z.coerce.number().int().positive().default(3000),
  LAUNCH_CONFIRM_ATTEMPTS: z.coerce.number().int().positive().default(20),
  LAUNCH_CONFIRM_DELAY_MS: z.coerce.number().int().positive().default(3000),
  LAUNCH_JOB_POLL_MS: z.coerce.number().int().positive().default(2000),
  LAUNCH_JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  REQUIRE_LAUNCH_CONFIRMATION: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(2_000_000),
  MIN_IMAGE_DIMENSION: z.coerce.number().int().positive().default(256),
  MAX_IMAGE_DIMENSION: z.coerce.number().int().positive().default(2048),
  REQUIRE_SQUARE_IMAGE: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  HEALTHCHECK_PORT: z.coerce.number().int().min(0).default(0),
  LOG_DIR: z.string().default("./logs"),
  WALLET_ENCRYPTION_KEY: z.string().optional()
});

export const config = envSchema.parse(process.env);

export const adminTelegramIds = new Set(
  config.ADMIN_TELEGRAM_IDS.split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id))
);

export function requireAdmin(userId: number | undefined): boolean {
  return userId !== undefined && adminTelegramIds.has(userId);
}
