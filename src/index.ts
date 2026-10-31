import { Context, Telegraf } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import { PublicKey } from "@solana/web3.js";
import http from "node:http";
import { ZodError } from "zod";
import { config, requireAdmin } from "./config.js";
import {
  approveProposal,
  createAuditLog,
  createLaunchAttempt,
  countAvailableVanityMints,
  countSuccessfulLaunchesSince,
  claimNextLaunchJob,
  nextLaunchJobRunAt,
  completeLaunchJob,
  cancelCustomCaOrder,
  createCustomCaOrder,
  fulfillCustomCaOrder,
  getCustomCaOrder,
  listPendingCustomCaOrders,
  type CustomCaOrder,
  createProposal,
  enqueueLaunchJob,
  failLaunchJob,
  finishLaunchAttempt,
  getProposal,
  listPendingProposals,
  recentLaunchAttempts,
  recentLaunchJobs,
  markLaunched,
  quarantineInexactVanityMints,
  rejectProposal,
  listWallets,
  updateProposalCashback,
  updateProposalFeeShares,
  assertDatabaseReady,
  closeDatabase
} from "./db.js";
import { launchOnRobinhood, launchProposal, readRobinhoodLaunchFeeEth, robinhoodLaunchpadName } from "./launchpads/index.js";
import { launchWithBags } from "./launchpads/bags.js";
import {
  launchWithPumpFunSdk,
  launchWithPumpPortalApiKey,
  sendPlatformFeeIfEnabled,
  type PlatformFeeResult,
  inspectLaunchOnchain,
  probePumpPortalLocalCreate,
  testLaunchImageFetch
} from "./launchpads/pumpportal.js";
import {
  errorMessage,
  escapeAttr,
  escapeHtml,
  helpKeyboard,
  helpMessage,
  commandHelpMessage,
  copyButton,
  launchKeyboard,
  launchMessage,
  proposalKeyboard,
  proposalMessage,
  telegramReplyOptions,
  wizardPreviewKeyboard,
  wizardPreviewMessage,
  wizardQuestionMessage
} from "./messages.js";
import { parseIdea, validateIdea } from "./parser.js";
import type { CoinIdeaInput, Launchpad, LaunchResult, Proposal } from "./types.js";
import {
  exportWalletSecretBase58,
  exportPumpPortalWallet,
  getOrCreateWallet,
  getOrCreatePumpPortalWallet,
  getOrCreateRobinhoodWallet,
  getEthBalance,
  getPumpPortalApiKey,
  getRobinhoodWalletSecret,
  getSolBalance,
  getWalletSecretBase58,
  getWalletSummary,
  getWalletView,
  assertWalletEncryptionKeyReady,
  encryptMintSecret,
  type WalletView
} from "./wallets.js";
import { logError, logInfo } from "./logger.js";
import { createLaunchJobWorker } from "./launchJobWorker.js";
import {
  customCaFeeSol,
  customCaKeypairProblem,
  describeCustomCa,
  describeLengths,
  expectedAttempts,
  FAST_FIRST_CHARACTERS_LABEL,
  formatSearchTime,
  normalizeCustomCaPattern,
  parseCustomCaFees,
  quoteCustomCa,
  typicalSearchTime,
  type CustomCaPosition,
  type CustomCaPricing,
  type CustomCaRequest
} from "./customCa.js";
import {
  grinderApiEnabled,
  handleGrinderRequest,
  type GrinderApi,
  type GrinderOrder,
  type GrinderSubmitResult
} from "./grinderApi.js";

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const drafts = new Map<string, Draft>();
const rejectionDrafts = new Map<string, RejectionDraft>();
const activeLaunches = new Set<string>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const startedAt = new Date();
let databaseHealthy = false;
const launchJobWorker = createLaunchJobWorker({
  claimNext: () => claimNextLaunchJob(config.LAUNCH_JOB_MAX_ATTEMPTS),
  execute: executeLaunchJob,
  nextRunAt: () => nextLaunchJobRunAt(config.LAUNCH_JOB_MAX_ATTEMPTS),
  onError: (error) => logError("launch_job_worker_failed", error)
});
const customCaPricing: CustomCaPricing = {
  feesByLength: parseCustomCaFees(config.CUSTOM_CA_FEES_SOL),
  keysPerSecond: config.CUSTOM_CA_KEYS_PER_SECOND,
  maxWaitMinutes: config.CUSTOM_CA_MAX_WAIT_MINUTES
};
const customCaEnabled = customCaPricing.feesByLength.size > 0 && grinderApiEnabled(config.GRINDER_API_TOKEN);
// Orders waiting for the grinder. Kept in memory so grinder polls never wake the database.
const pendingCustomCaOrders = new Map<number, GrinderOrder>();
const grinderApi: GrinderApi = {
  token: config.GRINDER_API_TOKEN,
  pendingOrders: () => [...pendingCustomCaOrders.values()],
  submitResult: storeCustomCaResult
};

type DraftStep =
  | "launchpad"
  | "name"
  | "symbol"
  | "description"
  | "website"
  | "telegram"
  | "twitter"
  | "image"
  | "devBuy"
  | "cashback"
  | "feeShares"
  | "feeShareWallet"
  | "feeSharePercent"
  | "customCa"
  | "customCaText"
  | "preview";

interface Draft {
  step: DraftStep;
  data: Partial<CoinIdeaInput>;
  promptMessageId?: number;
  customFeeWallet?: string;
  customCaPosition?: CustomCaPosition;
  forcedStep?: DraftStep;
}

interface RejectionDraft {
  proposalId: number;
  promptMessageId?: number;
}

type LaunchMode = "api" | "group" | "personal";

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? "unknown-chat";
  const fromId = ctx.from?.id ?? "unknown-user";
  const text = "message" in ctx.update && "text" in ctx.update.message ? ctx.update.message.text : ctx.updateType;
  if (isRateLimited(String(chatId), String(fromId))) return;
  logInfo("telegram_update", { chatId, fromId, updateType: ctx.updateType, text });
  return next();
});

bot.start((ctx) => {
  return ctx.reply(helpMessage(), {
    ...telegramReplyOptions,
    reply_markup: { inline_keyboard: helpKeyboard() }
  });
});

bot.help((ctx) =>
  ctx.reply(helpMessage(), {
    ...telegramReplyOptions,
    reply_markup: { inline_keyboard: helpKeyboard() }
  })
);

bot.command("ping", (ctx) => {
  return ctx.reply("pong");
});

bot.command("commands", (ctx) => {
  return ctx.reply(commandHelpMessage(), telegramReplyOptions);
});

bot.command("customca", (ctx) => {
  if (!customCaEnabled) return ctx.reply("Custom CAs are not available right now.");
  return ctx.reply(
    [
      "<b>Custom CA</b>",
      "",
      customCaInfoMessage(),
      "",
      "Order one in <code>/idea</code> for a Pump.fun or Bonk launch. It's offered after the dev buy step."
    ].join("\n"),
    telegramReplyOptions
  );
});

bot.command("deletecheck", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Use /deletecheck inside the Telegram group.");
  }
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const me = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(ctx.chat.id, me.id);
  const canDelete =
    member.status === "creator" ||
    (member.status === "administrator" && Boolean((member as { can_delete_messages?: boolean }).can_delete_messages));

  const testMessage = await ctx.reply("Delete check: testing bot delete permission...");
  const botMessageDeleted = await safeDeleteMessage(ctx, testMessage.message_id, "deletecheck bot message");
  const commandMessageDeleted = await safeDeleteMessage(ctx, ctx.message.message_id, "deletecheck command message");

  return ctx.reply(
    [
      "<b>Delete Check</b>",
      "",
      `Bot admin status: <b>${escapeHtml(member.status)}</b>`,
      `Delete permission: <b>${canDelete ? "yes" : "no"}</b>`,
      `Deleted bot test message: <b>${botMessageDeleted ? "yes" : "no"}</b>`,
      `Deleted command message: <b>${commandMessageDeleted ? "yes" : "no"}</b>`,
      "",
      canDelete
        ? "If command deletion says no, check the bot logs for Telegram's exact error."
        : "Enable admin permission: Delete messages."
    ].join("\n"),
    telegramReplyOptions
  );
});

bot.command("groupwallet", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Use this command inside a Telegram group.");
  }
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  try {
    const wallet = await withBalance(await getOrCreatePumpPortalWallet("group", String(ctx.chat.id)));
    await replyWallet(ctx, "Group Launch Wallet", wallet);
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("groupbalance", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Use this command inside a Telegram group.");
  }

  const wallet = await getWalletSummary("group_portal", String(ctx.chat.id));
  if (!wallet) return ctx.reply("No group wallet yet. An admin can create one with /groupwallet.");

  try {
    await replyWallet(ctx, "Group Launch Wallet", await withBalance(wallet));
  } catch (error) {
    await replyWallet(ctx, "Group Launch Wallet", withBalanceError(wallet, error));
  }
});

bot.command("rhgroupwallet", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Use this command inside a Telegram group.");
  }
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  try {
    const wallet = await withEthBalance(await getOrCreateRobinhoodWallet("group", String(ctx.chat.id)));
    await replyWallet(ctx, "Robinhood Group Wallet", wallet);
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("rhgroupbalance", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Use this command inside a Telegram group.");
  }

  const wallet = await getWalletSummary("group_evm", String(ctx.chat.id));
  if (!wallet) return ctx.reply("No Robinhood group wallet yet. An admin can create one with /rhgroupwallet.");

  try {
    await replyWallet(ctx, "Robinhood Group Wallet", await withEthBalance(wallet));
  } catch (error) {
    await replyWallet(ctx, "Robinhood Group Wallet", withBalanceError(wallet, error));
  }
});

bot.command("mywallet", async (ctx) => {
  if (!ctx.from) return ctx.reply("I could not identify you.");

  try {
    const wallet = await withBalance(await getOrCreateWallet("user", String(ctx.from.id)));
    await replyWallet(ctx, "Personal Launch Wallet", wallet);
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("mybalance", async (ctx) => {
  if (!ctx.from) return ctx.reply("I could not identify you.");

  const wallet = await getWalletSummary("user", String(ctx.from.id));
  if (!wallet) return ctx.reply("No personal wallet yet. Create one with /mywallet.");

  try {
    await replyWallet(ctx, "Personal Launch Wallet", await withBalance(wallet));
  } catch (error) {
    await replyWallet(ctx, "Personal Launch Wallet", withBalanceError(wallet, error));
  }
});

bot.command("rhmywallet", async (ctx) => {
  if (!ctx.from) return ctx.reply("I could not identify you.");

  try {
    const wallet = await withEthBalance(await getOrCreateRobinhoodWallet("user", String(ctx.from.id)));
    await replyWallet(ctx, "Robinhood Personal Wallet", wallet);
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("rhmybalance", async (ctx) => {
  if (!ctx.from) return ctx.reply("I could not identify you.");

  const wallet = await getWalletSummary("user_evm", String(ctx.from.id));
  if (!wallet) return ctx.reply("No Robinhood personal wallet yet. Create one with /rhmywallet.");

  try {
    await replyWallet(ctx, "Robinhood Personal Wallet", await withEthBalance(wallet));
  } catch (error) {
    await replyWallet(ctx, "Robinhood Personal Wallet", withBalanceError(wallet, error));
  }
});

bot.command("exportmywallet", async (ctx) => {
  if (ctx.chat?.type !== "private") return ctx.reply("Wallet export is only available in DM with the bot.");
  if (!requireAdmin(ctx.from?.id)) return ctx.reply("Configured admin only.");
  if (!ctx.from) return ctx.reply("I could not identify you.");

  try {
    const exported = await exportWalletSecretBase58("user", String(ctx.from.id));
    audit(ctx, "wallet_export_user", undefined, { address: exported.address });
    return ctx.reply(exportMessage("Personal Wallet Export", exported.address, exported.secretKey), telegramReplyOptions);
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("exportgroupwallet", async (ctx) => {
  if (ctx.chat?.type !== "private") return ctx.reply("Wallet export is only available in DM with the bot.");
  if (!requireAdmin(ctx.from?.id)) return ctx.reply("Configured admin only.");

  const [, groupId] = ctx.message.text.split(/\s+/, 2);
  if (!groupId) {
    const wallets = await listWallets("group_portal");
    if (wallets.length === 0) return ctx.reply("No group wallets found yet. Create one in a group with /groupwallet.");

    return ctx.reply(
      "Select a group wallet to export:",
      {
        ...telegramReplyOptions,
        reply_markup: {
          inline_keyboard: wallets.map((wallet) => [
            {
              text: `${wallet.scopeId} (${wallet.address.slice(0, 4)}...${wallet.address.slice(-4)})`,
              callback_data: `export_group_wallet:${wallet.id}`
            }
          ])
        }
      }
    );
  }

  try {
    const exported = await exportPumpPortalWallet("group", groupId);
    audit(ctx, "wallet_export_group", undefined, { groupId, address: exported.address });
    return ctx.reply(
      exportMessage(`Group PumpPortal Wallet Export ${groupId}`, exported.address, exported.secretKey, exported.apiKey),
      telegramReplyOptions
    );
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.action(/^export_group_wallet:(\d+)$/, async (ctx) => {
  if (ctx.chat?.type !== "private") {
    await safeAnswerCallback(ctx, "DM only.");
    return;
  }
  if (!requireAdmin(ctx.from?.id)) {
    await safeAnswerCallback(ctx, "Configured admin only.");
    return;
  }

  const walletId = Number(ctx.match[1]);
  const wallet = (await listWallets("group_portal")).find((item) => item.id === walletId);
  if (!wallet) {
    await safeAnswerCallback(ctx, "Wallet not found.");
    return;
  }

  const exported = await exportPumpPortalWallet("group", wallet.scopeId);
  audit(ctx, "wallet_export_group", undefined, { groupId: wallet.scopeId, address: exported.address });
  await safeAnswerCallback(ctx, "Exported.");
  await ctx.reply(
    exportMessage(`Group PumpPortal Wallet Export ${wallet.scopeId}`, exported.address, exported.secretKey, exported.apiKey),
    telegramReplyOptions
  );
});

bot.command("idea", async (ctx) => {
  try {
    const from = ctx.from;
    if (!from) return ctx.reply("I could not identify the sender.");

    if (shouldStartWizard(ctx.message.text)) {
      await startWizard(ctx, parseIdeaCommandShortcut(ctx.message.text));
      return;
    }

    const idea = parseIdea(ctx.message.text);
    const proposal = await createProposal(idea, from.id, from.username);

    await ctx.reply(proposalMessage(proposal, "Proposal Submitted"), {
      ...telegramReplyOptions,
      reply_markup: { inline_keyboard: proposalKeyboard(proposal) }
    });
  } catch (error) {
    await ctx.reply(formatError(error, true), telegramReplyOptions);
  }
});

bot.command("skip", async (ctx) => {
  const key = draftKey(ctx);
  const draft = key ? drafts.get(key) : undefined;
  if (!draft) return ctx.reply("No active draft. Start with /idea.");
  if (!canSkipStep(draft.step)) return ctx.reply("This step is required.");

  return advanceWizard(ctx, draft);
});

bot.command("cancel", async (ctx) => {
  const key = draftKey(ctx);
  if (key) drafts.delete(key);
  return ctx.reply("Draft cancelled.");
});

bot.on("text", async (ctx, next) => {
  const key = draftKey(ctx);
  const rejectionDraft = key ? rejectionDrafts.get(key) : undefined;
  if (key && rejectionDraft && !ctx.message.text.startsWith("/") && isRejectionReply(ctx, rejectionDraft)) {
    try {
      await applyRejectionText(ctx, key, rejectionDraft, ctx.message.text.trim());
      await safeDeleteWizardInput(ctx, ctx.message.message_id);
    } catch (error) {
      await ctx.reply(formatError(error), telegramReplyOptions);
    }
    return;
  }

  const draft = key ? drafts.get(key) : undefined;
  if (!key || !draft || ctx.message.text.startsWith("/") || !isWizardReply(ctx, draft)) {
    return next();
  }

  try {
    await applyWizardText(ctx, draft, ctx.message.text.trim());
    await safeDeleteWizardInput(ctx, ctx.message.message_id);
  } catch (error) {
    await ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.on("photo", async (ctx, next) => {
  const key = draftKey(ctx);
  const draft = key ? drafts.get(key) : undefined;
  if (!key || !draft || draft.step !== "image" || !isWizardReply(ctx, draft)) {
    return next();
  }

  const photo = ctx.message.photo.at(-1);
  if (!photo) return;

  const imageProblem = validateTelegramPhotoMeta(photo);
  if (imageProblem) {
    await ctx.reply(
      [
        "&#9888; <b>Image rejected</b>",
        "",
        escapeHtml(imageProblem),
        "",
        "Upload a new image that matches the launch requirements."
      ].join("\n"),
      telegramReplyOptions
    );
    return;
  }

  draft.data.image = `telegram:${photo.file_id}`;
  await advanceWizard(ctx, draft);
  await safeDeleteWizardInput(ctx, ctx.message.message_id);
});

bot.command("review", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const proposals = await listPendingProposals();
  if (proposals.length === 0) return ctx.reply("No pending proposals.");

  for (const proposal of proposals) {
    await ctx.reply(proposalMessage(proposal, "Pending Review"), {
      ...telegramReplyOptions,
      reply_markup: { inline_keyboard: proposalKeyboard(proposal) }
    });
  }
});

bot.command("proposal", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /proposal <proposal_id>");

  const proposal = await getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);

  const imageStatus = proposal.image
    ? proposal.image.startsWith("telegram:")
      ? "Telegram upload"
      : proposal.image.includes("api.telegram.org/file/bot")
        ? "Old Telegram file URL"
        : "Public URL"
    : "Missing";

  return ctx.reply(
    [
      proposalMessage(proposal, "Proposal Details"),
      "",
      `<b>Image storage:</b> ${imageStatus}`
    ].join("\n"),
    telegramReplyOptions
  );
});

bot.command("imagetest", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /imagetest <proposal_id>");

  const proposal = await getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);

  try {
    const result = await testLaunchImageFetch(proposal);
    return ctx.reply(`Image fetch OK: ${escapeHtml(result)}`, telegramReplyOptions);
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("txcheck", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const [, signature, mint] = ctx.message.text.trim().split(/\s+/, 3);
  if (!signature) return ctx.reply("Usage: /txcheck <signature> [mint_or_ca]");

  try {
    const result = await inspectLaunchOnchain(signature, mint);
    return ctx.reply(
      [
        "<b>Transaction Check</b>",
        "",
        `Signature: <code>${escapeHtml(signature)}</code>`,
        `Status: <b>${escapeHtml(result.signatureStatus)}</b>`,
        result.signatureError ? `Error: <code>${escapeHtml(result.signatureError)}</code>` : undefined,
        mint ? `CA: <code>${escapeHtml(mint)}</code>` : undefined,
        result.mintExists !== undefined ? `CA exists: <b>${result.mintExists ? "yes" : "no"}</b>` : undefined,
        `Solscan: <a href="https://solscan.io/tx/${escapeAttr(signature)}">open</a>`
      ]
        .filter(Boolean)
        .join("\n"),
      telegramReplyOptions
    );
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("localprobe", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const [, idText, walletMode = "group", amountText] = ctx.message.text.split(/\s+/);
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) return ctx.reply("Usage: /localprobe <proposal_id> [group|me] [amount_sol]");
  const amountOverride = amountText ? Number(amountText) : undefined;
  if (amountOverride !== undefined && (!Number.isFinite(amountOverride) || amountOverride <= 0)) {
    return ctx.reply("Amount must be a positive SOL number, like 0.0001.");
  }

  const proposal = await getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);

  try {
    const signer = await (
      walletMode.toLowerCase() === "me"
        ? getWalletSecretBase58("user", String(ctx.from?.id))
        : getWalletSecretBase58("group", String(ctx.chat?.id))
    );
    const result = await probePumpPortalLocalCreate(proposal, signer.address, amountOverride);
    return ctx.reply(
      [
        result.ok ? "Local probe passed." : "Local probe failed.",
        `Status: ${result.status}`,
        `Wallet: <code>${escapeHtml(signer.address)}</code>`,
        `Amount: <b>${amountOverride ?? proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL} SOL</b>`,
        `Test mint: <code>${escapeHtml(result.mint)}</code>`,
        `Detail: <code>${escapeHtml(result.detail.slice(0, 600))}</code>`,
        "",
        "No transaction was signed or sent."
      ].join("\n"),
      telegramReplyOptions
    );
  } catch (error) {
    return ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.command("approve", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /approve <proposal_id>");

  const pendingProposal = await getProposal(id);
  if (!pendingProposal) return ctx.reply(`Proposal #${id} not found.`);
  if (!pendingProposal.image) {
    return ctx.reply(`Proposal #${id} has no image. Reject it or ask for a new proposal with an image.`);
  }

  await assertApprovalImageValid(pendingProposal);
  const proposal = await approveProposal(id, ctx.from.id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  if (proposal.status !== "approved") return ctx.reply(`Proposal #${id} is ${proposal.status}.`);
  audit(ctx, "proposal_approved", id, { launchpad: proposal.launchpad, devBuySol: proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL });

  return ctx.reply(`✅ <b>Approved proposal #${id}</b>\nUse <code>/launch ${id}</code> when ready.`, telegramReplyOptions);
});

bot.command("reject", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const [, idText, ...reasonParts] = ctx.message.text.split(/\s+/);
  const id = Number(idText);
  const reason = reasonParts.join(" ").trim();
  if (!Number.isInteger(id) || id <= 0 || !reason) {
    return ctx.reply("Usage: /reject <proposal_id> <reason>");
  }

  const proposal = await rejectProposal(id, reason);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  await cancelCustomCaIfRejected(proposal);
  audit(ctx, "proposal_rejected", id, { reason });

  return ctx.reply(`❌ <b>Rejected proposal #${id}</b>\n${escapeHtml(reason)}`, telegramReplyOptions);
});

bot.command("launch", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /launch <proposal_id>");

  await sendLaunchConfirmation(ctx, "api", id);
});

bot.command("launchgroup", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Use /launchgroup inside the Telegram group.");
  }
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /launchgroup <proposal_id>");

  await sendLaunchConfirmation(ctx, "group", id);
});

bot.command("launchme", async (ctx) => {
  if (!ctx.from) return ctx.reply("I could not identify you.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /launchme <proposal_id>");

  await sendLaunchConfirmation(ctx, "personal", id);
});

bot.command("feesettings", async (ctx) => {
  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /feesettings <proposal_id>");
  const proposal = await getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  return ctx.reply(feeSettingsMessage(proposal), telegramReplyOptions);
});

bot.command("cashback", async (ctx) => {
  const [, idText, value] = ctx.message.text.split(/\s+/, 3);
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0 || !value) return ctx.reply("Usage: /cashback <proposal_id> on|off");
  const proposal = await getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  if (!(await canEditProposalSettings(ctx, proposal))) return ctx.reply("Only the proposal creator or an admin can edit this.");
  if (proposal.launchpad !== "pumpfun") return ctx.reply("Cashback only applies to Pump.fun proposals.");
  const enabled = parseOnOff(value);
  const updated = await updateProposalCashback(id, enabled);
  audit(ctx, "cashback_updated", id, { enabled });
  return ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
});

bot.command("setfees", async (ctx) => {
  const [, idText, ...valueParts] = ctx.message.text.split(/\s+/);
  const id = Number(idText);
  const value = valueParts.join("").trim();
  if (!Number.isInteger(id) || id <= 0 || !value) {
    return ctx.reply("Usage: /setfees <proposal_id> none|creator|wallet:bps,wallet:bps");
  }
  const proposal = await getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  if (!(await canEditProposalSettings(ctx, proposal))) return ctx.reply("Only the proposal creator or an admin can edit this.");
  if (proposal.launchpad !== "pumpfun") return ctx.reply("Fee sharing only applies to Pump.fun proposals.");
  const feeShares = normalizeFeeShareSetting(value);
  const updated = await updateProposalFeeShares(id, feeShares);
  audit(ctx, "fee_shares_updated", id, { feeShares });
  return ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
});

bot.command("launchcheck", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");
  const groupWallet =
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? await getWalletView("group_portal", String(ctx.chat.id))
      : undefined;
  const robinhoodGroupWallet =
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? await getWalletSummary("group_evm", String(ctx.chat.id))
      : undefined;

  const lines = [
    "<b>Launch Readiness</b>",
    "",
    `Mode: <b>${config.DRY_RUN ? "DRY RUN" : "LIVE"}</b>`,
    `Pump.fun SDK signer: <b>${config.PUMPFUN_SIGNER_PRIVATE_KEY ? "SET" : "MISSING"}</b>`,
    `PumpPortal API key (Bonk): <b>${config.PUMPPORTAL_API_KEY ? "SET" : "MISSING"}</b>`,
    `Bags API key: <b>${config.BAGS_API_KEY ? "SET" : "MISSING"}</b>`,
    `Pinata JWT: <b>${config.PINATA_JWT ? "SET" : "MISSING"}</b>`,
    `Robinhood RPC: <b>${config.ROBINHOOD_RPC_URL ? "SET" : "MISSING"}</b>`,
    `Default dev buy: <b>${config.DEFAULT_DEV_BUY_SOL} SOL</b>`,
    `Default Robinhood initial buy: <b>${config.DEFAULT_DEV_BUY_ETH} ETH</b>`,
    `Slippage: <b>${config.DEFAULT_SLIPPAGE_PERCENT}%</b>`,
    `Priority fee: <b>${config.DEFAULT_PRIORITY_FEE_SOL} SOL</b>`,
    `Platform fee: <b>${config.PLATFORM_FEE_SOL} SOL</b>`,
    `Treasury wallet: <b>${
      config.PLATFORM_FEE_SOL > 0 || customCaEnabled ? (config.PLATFORM_TREASURY_WALLET ? "SET" : "MISSING") : "off"
    }</b>`,
    `Custom CA: <b>${
      customCaEnabled
        ? [...customCaPricing.feesByLength.entries()]
            .sort(([a], [b]) => a - b)
            .map(([length, fee]) => `${length} chars ${fee} SOL`)
            .join(", ")
        : customCaPricing.feesByLength.size > 0
          ? "off (GRINDER_API_TOKEN missing or under 24 characters)"
          : "off"
    }</b>`,
    `Custom CA orders waiting for grinder: <b>${pendingCustomCaOrders.size}</b>`,
    `Robinhood platform fee: <b>${config.ROBINHOOD_PLATFORM_FEE_ETH} ETH</b>`,
    `Robinhood treasury wallet: <b>${
      config.ROBINHOOD_PLATFORM_FEE_ETH > 0 ? (config.ROBINHOOD_PLATFORM_TREASURY_WALLET ? "SET" : "MISSING") : "off"
    }</b>`,
    `Max dev buy: <b>${config.MAX_DEV_BUY_SOL > 0 ? `${config.MAX_DEV_BUY_SOL} SOL` : "unlimited"}</b>`,
    `Group daily launch limit: <b>${config.GROUP_DAILY_LAUNCH_LIMIT > 0 ? config.GROUP_DAILY_LAUNCH_LIMIT : "unlimited"}</b>`,
    `User daily launch limit: <b>${config.USER_DAILY_LAUNCH_LIMIT > 0 ? config.USER_DAILY_LAUNCH_LIMIT : "unlimited"}</b>`,
    `Rate limit: <b>${config.RATE_LIMIT_MAX_UPDATES} updates / ${Math.round(config.RATE_LIMIT_WINDOW_MS / 1000)}s</b>`,
    `Max image size: <b>${config.MAX_IMAGE_BYTES.toLocaleString()} bytes</b>`,
    `Image dimensions: <b>${config.MIN_IMAGE_DIMENSION}-${config.MAX_IMAGE_DIMENSION}px</b>`,
    `Square image required: <b>${config.REQUIRE_SQUARE_IMAGE ? "yes" : "no"}</b>`,
    `Launch attempts: <b>${config.LAUNCH_MAX_ATTEMPTS}</b>`,
    `Require confirmation: <b>${config.REQUIRE_LAUNCH_CONFIRMATION ? "yes" : "no"}</b>`,
    `Confirmation wait: <b>${config.LAUNCH_CONFIRM_ATTEMPTS} x ${config.LAUNCH_CONFIRM_DELAY_MS}ms</b>`,
    `Pump.fun mint suffix: <b>${config.PUMP_MINT_SUFFIX || "none"}</b>`,
    `Bonk mint suffix: <b>${config.BONK_MINT_SUFFIX || "none"}</b>`,
    `Pump.fun mint pool target: <b>${config.PUMP_MINT_POOL_SIZE.toLocaleString()}</b>`,
    `Pump.fun mint workers: <b>${config.PUMP_MINT_WORKERS.toLocaleString()}</b>`,
    config.PUMP_MINT_SUFFIX
      ? `Pump.fun vanity mints ready: <b>${(await countAvailableVanityMints(config.PUMP_MINT_SUFFIX)).toLocaleString()}</b>`
      : undefined,
    config.BONK_MINT_SUFFIX
      ? `Bonk vanity mints ready: <b>${(await countAvailableVanityMints(config.BONK_MINT_SUFFIX)).toLocaleString()}</b>`
      : undefined,
    `Bags mint suffix: <b>${config.BAGS_MINT_SUFFIX || "none"}</b>`,
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup" ? "" : undefined,
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? `<b>Group Wallet</b>: ${groupWallet ? `<code>${escapeHtml(groupWallet.address)}</code>` : "MISSING"}`
      : undefined,
    groupWallet?.balanceSol === undefined
      ? groupWallet
        ? `Group wallet balance: <b>unavailable</b>`
        : undefined
      : `Group wallet balance: <b>${groupWallet.balanceSol.toFixed(6)} SOL</b>`,
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? `<b>Robinhood Group Wallet</b>: ${
          robinhoodGroupWallet ? `<code>${escapeHtml(robinhoodGroupWallet.address)}</code>` : "MISSING"
        }`
      : undefined,
    "",
    config.DRY_RUN
      ? "Set <code>DRY_RUN=false</code> only after your API key/wallet is funded and tested."
      : "Live launches are enabled. Approved proposals can spend funds."
  ].filter(Boolean);

  return ctx.reply(lines.join("\n"), telegramReplyOptions);
});

bot.command("status", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");
  const attempts = await recentLaunchAttempts(6);
  const jobs = await recentLaunchJobs(6);
  const uptimeSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  const nextQueueWake = launchJobWorker.nextWakeAt();
  const lines = [
    "<b>Bot Status</b>",
    "",
    `Mode: <b>${config.DRY_RUN ? "DRY RUN" : "LIVE"}</b>`,
    `Uptime: <b>${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s</b>`,
    `Active launches: <b>${activeLaunches.size}</b>`,
    `Queue worker: <b>${launchJobWorker.isBusy() ? "busy" : "idle"}</b>`,
    `Next queue check: <b>${
      nextQueueWake ? `in ${Math.max(0, Math.ceil((nextQueueWake.getTime() - Date.now()) / 1000))}s` : "when a launch is queued"
    }</b>`,
    `Rate buckets: <b>${rateBuckets.size}</b>`,
    `Health port: <b>${config.HEALTHCHECK_PORT || "off"}</b>`,
    "",
    "<b>Recent Launch Jobs</b>",
    jobs.length === 0
      ? "None yet."
      : jobs
          .map((job) => {
            const link = job.signature ? ` | <a href="https://solscan.io/tx/${escapeAttr(job.signature)}">tx</a>` : "";
            const error = job.lastError ? ` | ${escapeHtml(job.lastError.slice(0, 90))}` : "";
            return `Job ${job.id} #${job.proposalId} ${escapeHtml(job.mode)}: <b>${escapeHtml(job.status)}</b> (${job.attempts})${link}${error}`;
          })
          .join("\n"),
    "",
    "<b>Recent Launch Attempts</b>",
    attempts.length === 0
      ? "None yet."
      : attempts
          .map((attempt) => {
            const suffix = attempt.signature ? ` | <a href="https://solscan.io/tx/${escapeAttr(attempt.signature)}">tx</a>` : "";
            const error = attempt.error ? ` | ${escapeHtml(attempt.error.slice(0, 100))}` : "";
            return `#${attempt.proposalId} ${escapeHtml(attempt.mode)} ${escapeHtml(attempt.launchpad)}: <b>${escapeHtml(
              attempt.status
            )}</b>${suffix}${error}`;
          })
          .join("\n")
  ];

  return ctx.reply(lines.join("\n"), telegramReplyOptions);
});

bot.command("vanityclean", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");
  if (!config.PUMP_MINT_SUFFIX) return ctx.reply("No PUMP_MINT_SUFFIX configured.");

  const count = await quarantineInexactVanityMints(config.PUMP_MINT_SUFFIX);
  return ctx.reply(
    `Quarantined ${count.toLocaleString()} pooled mints that do not exactly end with <code>${escapeHtml(
      config.PUMP_MINT_SUFFIX
    )}</code>.`,
    telegramReplyOptions
  );
});

bot.action(/^approve:(\d+)$/, async (ctx) => {
  if (!(await isBotAdmin(ctx))) {
    await ctx.answerCbQuery("Admin command only.");
    return;
  }

  const id = Number(ctx.match[1]);
  const pendingProposal = await getProposal(id);
  if (!pendingProposal) {
    await ctx.answerCbQuery("Proposal not found.");
    return;
  }

  await safeAnswerCallback(ctx, "Approving...");
  void validateAndApproveFromButton(ctx, id, ctx.from.id);
});

bot.action(/^launch:(\d+)$/, async (ctx) => {
  if (!(await isBotAdmin(ctx))) {
    await safeAnswerCallback(ctx, "Admin command only.");
    return;
  }

  const id = Number(ctx.match[1]);
  await safeAnswerCallback(ctx, "Confirm spend first.");
  await sendLaunchConfirmation(ctx, "api", id);
});

bot.action(/^launch_group:(\d+)$/, async (ctx) => {
  if (!(await isBotAdmin(ctx))) {
    await safeAnswerCallback(ctx, "Admin command only.");
    return;
  }

  await safeAnswerCallback(ctx, "Confirm spend first.");
  await sendLaunchConfirmation(ctx, "group", Number(ctx.match[1]));
});

bot.action(/^launch_me:(\d+)$/, async (ctx) => {
  await safeAnswerCallback(ctx, "Confirm spend first.");
  await sendLaunchConfirmation(ctx, "personal", Number(ctx.match[1]));
});

bot.action(/^confirm_launch:(api|group|personal):(\d+)$/, async (ctx) => {
  const mode = ctx.match[1] as LaunchMode;
  const id = Number(ctx.match[2]);
  if (mode !== "personal" && !(await isBotAdmin(ctx))) {
    await safeAnswerCallback(ctx, "Admin command only.");
    return;
  }

  const proposal = await getProposal(id);
  if (!proposal) {
    await safeAnswerCallback(ctx, "Proposal not found.");
    return;
  }
  if (!ctx.chat?.id) {
    await safeAnswerCallback(ctx, "Chat missing.");
    return;
  }

  const job = await enqueueLaunchJob({
    proposalId: proposal.id,
    launchpad: proposal.launchpad,
    mode,
    chatId: String(ctx.chat.id),
    actorId: ctx.from?.id,
    actorUsername: ctx.from?.username
  });
  audit(ctx, "launch_job_queued", id, { jobId: job.id, mode });
  await safeAnswerCallback(ctx, `Queued job #${job.id}.`);
  await ctx.reply(
    `🧾 <b>Launch queued</b>\nJob: <code>${job.id}</code>\nProposal: <code>${id}</code>\nMode: <b>${escapeHtml(mode)}</b>`,
    telegramReplyOptions
  );
  void launchJobWorker.run();
});

bot.action(/^cancel_launch:(\d+)$/, async (ctx) => {
  await safeAnswerCallback(ctx, "Cancelled.");
  await ctx.reply(`Launch #${Number(ctx.match[1])} cancelled.`);
});

bot.action(/^cashback_toggle:(\d+)$/, async (ctx) => {
  const proposal = await getProposal(Number(ctx.match[1]));
  if (!proposal) return safeAnswerCallback(ctx, "Proposal not found.");
  if (!(await canEditProposalSettings(ctx, proposal))) return safeAnswerCallback(ctx, "Creator or admin only.");
  const updated = await updateProposalCashback(proposal.id, !proposal.pumpfunCashback);
  audit(ctx, "cashback_updated", proposal.id, { enabled: updated?.pumpfunCashback ?? !proposal.pumpfunCashback });
  await safeAnswerCallback(ctx, updated?.pumpfunCashback ? "Cashback enabled." : "Cashback disabled.");
  await ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
});

bot.action(/^fees_menu:(\d+)$/, async (ctx) => {
  const proposal = await getProposal(Number(ctx.match[1]));
  if (!proposal) return safeAnswerCallback(ctx, "Proposal not found.");
  if (!(await canEditProposalSettings(ctx, proposal))) return safeAnswerCallback(ctx, "Creator or admin only.");
  await safeAnswerCallback(ctx, "Fee settings.");
  await ctx.reply(feeSettingsMessage(proposal), {
    ...telegramReplyOptions,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: proposal.pumpfunCashback ? "Cashback: On" : "Cashback: Off",
            callback_data: `cashback_toggle:${proposal.id}`
          }
        ],
        [
          { text: "No Fee Sharing", callback_data: `fees_set:${proposal.id}:none` },
          { text: "Creator 100%", callback_data: `fees_set:${proposal.id}:creator` }
        ],
        [{ text: "Custom Split", callback_data: `fees_custom_prompt:${proposal.id}` }]
      ]
    }
  });
});

bot.action(/^fees_custom_prompt:(\d+)$/, async (ctx) => {
  const proposal = await getProposal(Number(ctx.match[1]));
  if (!proposal) return safeAnswerCallback(ctx, "Proposal not found.");
  if (!(await canEditProposalSettings(ctx, proposal))) return safeAnswerCallback(ctx, "Creator or admin only.");

  await safeAnswerCallback(ctx, "Send custom split.");
  await ctx.reply(
    [
      `<b>Custom Fee Split #${proposal.id}</b>`,
      "",
      "Send the split as wallets and percentages totaling 100%.",
      "",
      "Example:",
      `<code>/setfees ${proposal.id} WALLET1:50,WALLET2:50</code>`,
      "",
      "You can also use bps:",
      `<code>/setfees ${proposal.id} WALLET1:5000,creator:5000</code>`
    ].join("\n"),
    telegramReplyOptions
  );
});

bot.action(/^fees_set:(\d+):(.+)$/, async (ctx) => {
  const proposal = await getProposal(Number(ctx.match[1]));
  if (!proposal) return safeAnswerCallback(ctx, "Proposal not found.");
  if (!(await canEditProposalSettings(ctx, proposal))) return safeAnswerCallback(ctx, "Creator or admin only.");
  const updated = await updateProposalFeeShares(proposal.id, normalizeFeeShareSetting(ctx.match[2]));
  audit(ctx, "fee_shares_updated", proposal.id, { feeShares: updated?.pumpfunFeeShares });
  await safeAnswerCallback(ctx, "Fee settings updated.");
  await ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
});

bot.action(/^reject_prompt:(\d+)$/, async (ctx) => {
  if (!(await isBotAdmin(ctx))) {
    await safeAnswerCallback(ctx, "Admin command only.");
    return;
  }

  const proposalId = Number(ctx.match[1]);
  const proposal = await getProposal(proposalId);
  if (!proposal) {
    await safeAnswerCallback(ctx, "Proposal not found.");
    return;
  }
  if (proposal.status !== "pending" && proposal.status !== "approved") {
    await safeAnswerCallback(ctx, `Proposal is ${proposal.status}.`);
    return;
  }

  const key = draftKey(ctx);
  if (!key) {
    await safeAnswerCallback(ctx, "Could not identify admin.");
    return;
  }

  await safeAnswerCallback(ctx, "Send rejection reason.");
  const prompt = await ctx.reply(
    [`<b>Reject #${proposalId}</b>`, "", "Reply with the reason for rejection."].join("\n"),
    {
      ...telegramReplyOptions,
      reply_markup: { force_reply: true, selective: true }
    }
  );
  rejectionDrafts.set(key, { proposalId, promptMessageId: prompt.message_id });
});

bot.action(/^wizard:(.+)$/, async (ctx) => {
  const action = ctx.match[1];
  const key = draftKey(ctx);
  const draft = key ? drafts.get(key) : undefined;

  if (action === "cancel") {
    if (key) drafts.delete(key);
    await ctx.answerCbQuery("Cancelled.");
    await ctx.editMessageText("❌ <b>Draft cancelled.</b>", telegramReplyOptions);
    return;
  }

  if (!key || !draft) {
    await ctx.answerCbQuery("Start with /idea.");
    return;
  }

  try {
    if (action.startsWith("launchpad:")) {
      const launchpad = action.split(":")[1];
      if (launchpad !== "pumpfun" && launchpad !== "bonk" && launchpad !== "bags" && launchpad !== "robinhood") {
        throw new Error("Invalid launchpad.");
      }
      draft.data.launchpad = launchpad;
      await ctx.answerCbQuery(`Selected ${launchpad}.`);
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action.startsWith("devbuy:")) {
      const amount = Number(action.split(":")[1]);
      if (draft.data.launchpad === "robinhood") draft.data.devBuyEth = amount;
      else draft.data.devBuySol = amount;
      await ctx.answerCbQuery("Dev buy set.");
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action === "devbuy_custom") {
      await ctx.answerCbQuery("Send custom amount.");
      const unit = draft.data.launchpad === "robinhood" ? "ETH" : "SOL";
      const prompt = await ctx.reply(`Send any positive ${unit} amount for initial buy. Example: <code>0.2</code>`, telegramReplyOptions);
      draft.promptMessageId = prompt.message_id;
      return;
    }

    if (action.startsWith("cashback:")) {
      draft.data.pumpfunCashback = action.endsWith(":on");
      await ctx.answerCbQuery(draft.data.pumpfunCashback ? "Cashback enabled." : "Cashback disabled.");
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action.startsWith("fees:")) {
      draft.data.pumpfunFeeShares = normalizeFeeShareSetting(action.split(":")[1]);
      await ctx.answerCbQuery("Fee setting saved.");
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action === "fees_custom") {
      draft.forcedStep = "feeShareWallet";
      await ctx.answerCbQuery("Custom split.");
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action.startsWith("fees_percent:")) {
      const percent = Number(action.split(":")[1]);
      draft.data.pumpfunFeeShares = feeSplitFromPercent(draft.customFeeWallet, percent);
      await ctx.answerCbQuery(`Recipient gets ${percent}%.`);
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action === "fees_percent_custom") {
      await ctx.answerCbQuery("Reply with percent.");
      await ctx.reply("Reply with a custom percent from 1 to 99. Example: <code>35</code>", telegramReplyOptions);
      return;
    }

    if (action === "customca:start" || action === "customca:end") {
      draft.customCaPosition = action === "customca:start" ? "start" : "end";
      draft.forcedStep = "customCaText";
      await ctx.answerCbQuery(`CA will ${draft.customCaPosition} with your text.`);
      await advanceWizard(ctx, draft);
      return;
    }

    if (action === "customca:none") {
      await ctx.answerCbQuery("Normal CA.");
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action === "group_tg") {
      const username = ctx.chat && "username" in ctx.chat ? ctx.chat.username : undefined;
      if (!username) {
        await ctx.answerCbQuery("This group has no public @username.");
        return;
      }
      draft.data.telegram = `https://t.me/${username}`;
      await ctx.answerCbQuery("Group link added.");
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action.startsWith("skip:")) {
      await ctx.answerCbQuery("Skipped.");
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action === "submit") {
      const idea = validateIdea(draft.data);
      if (!ctx.from) throw new Error("I could not identify the sender.");
      const proposal = await createProposal(idea, ctx.from.id, ctx.from.username);
      drafts.delete(key);
      const customCa = customCaRequest(proposal);
      if (customCa) {
        await createCustomCaOrder(proposal.id, String(ctx.chat?.id ?? ctx.from.id));
        pendingCustomCaOrders.set(proposal.id, { proposalId: proposal.id, ...customCa });
        audit(ctx, "custom_ca_ordered", proposal.id, { ...customCa, feeSol: proposal.customCaFeeSol });
      }
      await ctx.answerCbQuery("Submitted.");
      await ctx.editMessageText(proposalMessage(proposal, "Proposal Submitted"), {
        ...telegramReplyOptions,
        reply_markup: { inline_keyboard: proposalKeyboard(proposal) }
      });
      if (customCa) {
        await ctx.reply(
          `&#9203; <b>Generating custom CA for #${proposal.id}</b>\nIt will ${escapeHtml(describeCustomCa(customCa))}. ` +
            `Usually takes about ${formatSearchTime(expectedAttempts(customCa) / customCaPricing.keysPerSecond)}. ` +
            "I'll post here when it's ready.",
          telegramReplyOptions
        );
      }
      return;
    }

    await ctx.answerCbQuery("Unknown action.");
  } catch (error) {
    await ctx.answerCbQuery("Check the message.");
    await ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.catch((error, ctx) => {
  logError("bot_error", error, { chatId: ctx.chat?.id, fromId: ctx.from?.id, updateType: ctx.updateType });
  void ctx.reply("Something went wrong. Check the bot logs.");
});

async function runApiLaunch(ctx: Context, id: number): Promise<void> {
  const proposal = await getProposal(id);
  if (!proposal) return void (await ctx.reply(`Proposal #${id} not found.`));
  if (proposal.status !== "approved") {
    return void (await ctx.reply(`Proposal #${id} must be approved before API launch. Current status: ${proposal.status}.`));
  }

  await withLaunchLock(ctx, `proposal:${id}`, async () => {
    if (!config.DRY_RUN) {
      await assertApiLaunchReady(proposal);
    }

    const progressMessage = await ctx.reply(
      config.DRY_RUN
        ? `&#129514; <b>Running dry launch for #${id}...</b>`
        : `&#128640; <b>Starting API launch for #${id}...</b>\nThis can take a moment while metadata uploads.`,
      telegramReplyOptions
    );

    const attemptId = await createLaunchAttempt({
      proposalId: proposal.id,
      launchpad: proposal.launchpad,
      mode: "api",
      chatId: ctx.chat?.id === undefined ? undefined : String(ctx.chat.id),
      actorId: ctx.from?.id
    });
    let result: LaunchResult;
    try {
      result = await launchProposal(proposal);
      await finishLaunchAttempt(attemptId, {
        status: result.dryRun ? "success" : "success",
        signature: result.signature,
        mint: result.mint
      });
    } catch (error) {
      await finishLaunchAttempt(attemptId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (!result.dryRun) await markLaunched(id, result.signature);
    audit(ctx, "launch_api", id, { signature: result.signature, mint: result.mint });
    await safeDeleteMessage(ctx, progressMessage.message_id, "API launch progress");
    await replyLaunchResult(ctx, result);
  });
}

async function sendLaunchConfirmation(ctx: Context, mode: LaunchMode, id: number): Promise<void> {
  const proposal = await getProposal(id);
  if (!proposal) return void (await ctx.reply(`Proposal #${id} not found.`));
  if (proposal.launchpad === "robinhood") {
    const cost = await robinhoodLaunchCost(proposal);

    await ctx.reply(
      [
        `<b>Confirm Launch Spend #${proposal.id}</b>`,
        "",
        `<b>${escapeHtml(proposal.name)}</b> | <code>$${escapeHtml(proposal.symbol)}</code>`,
        `Mode: <b>${mode === "api" ? "API" : mode === "group" ? "Group Wallet" : "Personal Wallet"}</b>`,
        `Launchpad: <b>Robinhood Chain / ${robinhoodLaunchpadName()}</b>`,
        "",
        `Initial buy: <b>${cost.devBuyEth} ETH</b>`,
        `${robinhoodLaunchpadName()} launch fee: <b>${cost.launchFeeEth === undefined ? "couldn't be read right now" : `${cost.launchFeeEth} ETH`}</b>`,
        cost.platformFeeEth > 0 ? `Platform fee: <b>${cost.platformFeeEth} ETH</b>` : `Platform fee: <b>off</b>`,
        `Suggested wallet minimum: <b>${cost.minimumEth.toFixed(6)} ETH</b> (includes gas)`,
        "",
        "Only continue if the metadata, image, wallet, and spend are correct."
      ].join("\n"),
      {
        ...telegramReplyOptions,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Confirm Launch", callback_data: `confirm_launch:${mode}:${id}` },
              { text: "Cancel", callback_data: `cancel_launch:${id}` }
            ]
          ]
        }
      }
    );
    return;
  }

  const devBuySol = proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL;
  const priorityFeeSol = priorityFeeForLaunchpad(proposal.launchpad);
  const platformFeeSol = config.PLATFORM_FEE_SOL > 0 ? config.PLATFORM_FEE_SOL : 0;
  const customFeeSol = customCaFeeSol(proposal);
  const minimumTotal = devBuySol + priorityFeeSol + platformFeeSol + customFeeSol + config.LOCAL_LAUNCH_MIN_SOL_BUFFER;
  const customCa = customCaRequest(proposal);
  const customCaOrder = customCa ? await getCustomCaOrder(proposal.id) : undefined;

  await ctx.reply(
    [
      `<b>Confirm Launch Spend #${proposal.id}</b>`,
      "",
      `<b>${escapeHtml(proposal.name)}</b> | <code>$${escapeHtml(proposal.symbol)}</code>`,
      `Mode: <b>${mode === "api" ? "API" : mode === "group" ? "Group Wallet" : "Personal Wallet"}</b>`,
      `Launchpad: <b>${escapeHtml(proposal.launchpad)}</b>`,
      customCa
        ? `Custom CA: <b>${escapeHtml(describeCustomCa(customCa))}</b> (${customCaStatusLabel(customCaOrder)})`
        : undefined,
      "",
      `Dev buy: <b>${devBuySol} SOL</b>`,
      `Priority fee: <b>${priorityFeeSol} SOL</b>`,
      platformFeeSol > 0 ? `Platform fee: <b>${platformFeeSol} SOL</b>` : `Platform fee: <b>off</b>`,
      customCa ? `Custom CA fee: <b>${customFeeSol} SOL</b>` : undefined,
      `Required wallet minimum: <b>${minimumTotal.toFixed(6)} SOL</b>`,
      "",
      "Only continue if the metadata, image, wallet, and spend are correct."
    ]
      .filter((line) => line !== undefined)
      .join("\n"),
    {
      ...telegramReplyOptions,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirm Launch", callback_data: `confirm_launch:${mode}:${id}` },
            { text: "Cancel", callback_data: `cancel_launch:${id}` }
          ]
        ]
      }
    }
  );
}

async function runGroupLaunch(ctx: Context, id: number): Promise<void> {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await ctx.reply("Use group-wallet launch inside the Telegram group.");
    return;
  }
  const chatId = ctx.chat.id;

  const proposal = await getProposal(id);
  if (!proposal) return void (await ctx.reply(`Proposal #${id} not found.`));
  if (proposal.status !== "approved") {
    return void (await ctx.reply(`Proposal #${id} must be approved before group wallet launch. Current status: ${proposal.status}.`));
  }

  await withLaunchLock(ctx, `proposal:${id}`, async () => {
    const robinhoodWallet =
      proposal.launchpad === "robinhood" ? await getOrCreateRobinhoodWallet("group", String(chatId)) : undefined;
    const wallet = proposal.launchpad === "robinhood" ? undefined : await getPumpPortalApiKey("group", String(chatId));
    const exportedWallet =
      proposal.launchpad === "pumpfun" || proposal.launchpad === "bonk" || proposal.launchpad === "bags"
        ? await exportPumpPortalWallet("group", String(chatId))
        : undefined;
    if (!config.DRY_RUN) {
      await assertGroupLaunchReady(proposal, String(chatId), robinhoodWallet?.address ?? wallet!.address);
    }

    const progressMessage = await ctx.reply(
      config.DRY_RUN
        ? `&#129514; <b>Running dry group launch for #${id}...</b>`
        : `&#128640; <b>Starting group-wallet launch for #${id}...</b>\nThis can take a moment while metadata uploads.`,
      telegramReplyOptions
    );

    const attemptId = await createLaunchAttempt({
      proposalId: proposal.id,
      launchpad: proposal.launchpad,
      mode: "group",
      payerAddress: robinhoodWallet?.address ?? wallet?.address,
      chatId: String(chatId),
      actorId: ctx.from?.id
    });
    let result: LaunchResult;
    try {
      result = config.DRY_RUN
        ? {
            launchpad: proposal.launchpad,
            dryRun: true,
            message: `Dry run only. Would launch ${proposal.name} ($${proposal.symbol}) from group wallet ${
              robinhoodWallet?.address ?? wallet?.address
            }.`
          }
        : proposal.launchpad === "robinhood"
          ? await launchOnRobinhood(
              proposal,
              (await getRobinhoodWalletSecret("group", String(chatId))).privateKey,
              robinhoodWallet?.address
            )
        : proposal.launchpad === "bags"
          ? await launchWithBags(proposal, exportedWallet?.secretKey ?? "")
          : proposal.launchpad === "bonk"
            ? await launchWithPumpPortalApiKey(proposal, wallet!.apiKey)
            : await launchWithPumpFunSdk(proposal, exportedWallet?.secretKey ?? "", wallet!.address);
    } catch (error) {
      await finishLaunchAttempt(attemptId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (!result.dryRun && proposal.launchpad === "bonk" && exportedWallet) {
      const platformFee: PlatformFeeResult = await sendPlatformFeeIfEnabled(exportedWallet.secretKey, wallet!.address, customCaFeeSol(proposal)).catch(
        (error): PlatformFeeResult => ({
          error: error instanceof Error ? error.message : String(error)
        })
      );
      result = {
        ...result,
        platformFeeSignature: platformFee.signature,
        platformFeeUrl: platformFee.url,
        platformFeeError: platformFee.error
      };
    }
    if (!result.dryRun) await markLaunched(id, result.signature);
    await finishLaunchAttempt(attemptId, { status: "success", signature: result.signature, mint: result.mint });
    audit(ctx, "launch_group", id, { signature: result.signature, mint: result.mint, payerAddress: robinhoodWallet?.address ?? wallet?.address });
    await safeDeleteMessage(ctx, progressMessage.message_id, "group launch progress");
    await replyLaunchResult(ctx, result);
  });
}

async function runPersonalLaunch(ctx: Context, id: number): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify you.");
    return;
  }

  const proposal = await getProposal(id);
  if (!proposal) return void (await ctx.reply(`Proposal #${id} not found.`));
  if (proposal.status === "launched" || proposal.status === "rejected") {
    return void (await ctx.reply(`Proposal #${id} is ${proposal.status}.`));
  }
  if (proposal.createdBy !== ctx.from.id && !(await isBotAdmin(ctx))) {
    return void (await ctx.reply("You can only personal-launch your own proposal."));
  }
  if (proposal.launchpad !== "pumpfun" && proposal.launchpad !== "robinhood") {
    return void (await ctx.reply("Personal launch currently supports Pump.fun and Robinhood Chain only. Use group/API launch for Bonk."));
  }

  await withLaunchLock(ctx, `personal:${ctx.from.id}:${id}`, async () => {
    const wallet =
      proposal.launchpad === "robinhood"
        ? await getOrCreateRobinhoodWallet("user", String(ctx.from!.id))
        : await getOrCreateWallet("user", String(ctx.from!.id));
    if (!config.DRY_RUN) {
      await assertPersonalLaunchReady(proposal, wallet.address);
    }

    const progressMessage = await ctx.reply(
      config.DRY_RUN
        ? `&#129514; <b>Running dry personal launch for #${id}...</b>`
        : `&#128640; <b>Starting personal-wallet launch for #${id}...</b>\nThis can take a moment while metadata uploads.`,
      telegramReplyOptions
    );

    const attemptId = await createLaunchAttempt({
      proposalId: proposal.id,
      launchpad: proposal.launchpad,
      mode: "personal",
      payerAddress: wallet.address,
      chatId: ctx.chat?.id === undefined ? undefined : String(ctx.chat.id),
      actorId: ctx.from!.id
    });
    let result: LaunchResult;
    try {
      result = config.DRY_RUN
        ? {
            launchpad: proposal.launchpad,
            dryRun: true,
            message: `Dry run only. Would launch ${proposal.name} ($${proposal.symbol}) from personal wallet ${wallet.address}.`
          }
        : proposal.launchpad === "robinhood"
          ? await launchOnRobinhood(
              proposal,
              (await getRobinhoodWalletSecret("user", String(ctx.from!.id))).privateKey,
              wallet.address
            )
          : await launchWithPumpFunSdk(
              proposal,
              (await exportWalletSecretBase58("user", String(ctx.from!.id))).secretKey,
              wallet.address
            );
      await finishLaunchAttempt(attemptId, { status: "success", signature: result.signature, mint: result.mint });
    } catch (error) {
      await finishLaunchAttempt(attemptId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    if (!result.dryRun) await markLaunched(id, result.signature);
    audit(ctx, "launch_personal", id, { signature: result.signature, mint: result.mint, payerAddress: wallet.address });
    await safeDeleteMessage(ctx, progressMessage.message_id, "personal launch progress");
    await replyLaunchResult(ctx, result);
  });
}

async function executeLaunchJob(job: {
  id: number;
  proposalId: number;
  launchpad: string;
  mode: LaunchMode;
  chatId: string;
  actorId?: number;
}): Promise<void> {
  const lockKey = job.mode === "personal" ? `personal:${job.actorId}:${job.proposalId}` : `proposal:${job.proposalId}`;
  if (activeLaunches.has(lockKey)) {
    await failLaunchJob(job.id, "Launch is already active; retrying shortly.", config.LAUNCH_RETRY_DELAY_MS, config.LAUNCH_JOB_MAX_ATTEMPTS);
    return;
  }

  activeLaunches.add(lockKey);
  try {
    const proposal = await getProposal(job.proposalId);
    if (!proposal) throw new Error(`Proposal #${job.proposalId} not found.`);
    if (proposal.status !== "approved") throw new Error(`Proposal #${job.proposalId} is ${proposal.status}; expected approved.`);

    let payerAddress: string | undefined;
    if (job.mode === "group") {
      const wallet =
        proposal.launchpad === "robinhood"
          ? await getOrCreateRobinhoodWallet("group", job.chatId)
          : await getPumpPortalApiKey("group", job.chatId);
      payerAddress = wallet.address;
      if (!config.DRY_RUN) await assertGroupLaunchReady(proposal, job.chatId, wallet.address);
    } else if (job.mode === "personal") {
      if (!job.actorId) throw new Error("Personal launch job is missing actor id.");
      const wallet =
        proposal.launchpad === "robinhood"
          ? await getOrCreateRobinhoodWallet("user", String(job.actorId))
          : await getOrCreateWallet("user", String(job.actorId));
      payerAddress = wallet.address;
      if (!config.DRY_RUN) await assertPersonalLaunchReady(proposal, wallet.address);
    } else if (!config.DRY_RUN) {
      await assertApiLaunchReady(proposal);
    }

    const progressMessage = await bot.telegram.sendMessage(
      job.chatId,
      config.DRY_RUN
        ? `🧪 <b>Running queued dry launch job #${job.id} for #${job.proposalId}...</b>`
        : `🚀 <b>Running queued launch job #${job.id} for #${job.proposalId}...</b>\nThis can take a moment while metadata uploads.`,
      telegramReplyOptions
    );

    const attemptId = await createLaunchAttempt({
      proposalId: proposal.id,
      launchpad: proposal.launchpad,
      mode: job.mode,
      payerAddress,
      chatId: job.chatId,
      actorId: job.actorId
    });

    let result: LaunchResult;
    try {
      result = await runQueuedLaunch(proposal, job.mode, job.chatId, job.actorId);
      await finishLaunchAttempt(attemptId, { status: "success", signature: result.signature, mint: result.mint });
    } catch (error) {
      await finishLaunchAttempt(attemptId, { status: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    if (!result.dryRun) await markLaunched(job.proposalId, result.signature);
    await completeLaunchJob(job.id, result.signature, result.mint);
    await createAuditLog({
      action: `launch_job_${job.mode}_success`,
      actorId: job.actorId,
      chatId: job.chatId,
      proposalId: job.proposalId,
      details: { jobId: job.id, signature: result.signature, mint: result.mint, payerAddress }
    });

    await bot.telegram.deleteMessage(job.chatId, progressMessage.message_id).catch(() => undefined);
    await bot.telegram.sendMessage(job.chatId, launchMessage(result), {
      ...telegramReplyOptions,
      ...(launchKeyboard(result) ? { reply_markup: { inline_keyboard: launchKeyboard(result)! } } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryableLaunchJobError(error);
    await failLaunchJob(job.id, message, config.LAUNCH_RETRY_DELAY_MS, retryable ? config.LAUNCH_JOB_MAX_ATTEMPTS : 0);
    logError("launch_job_failed", error, { jobId: job.id, proposalId: job.proposalId, mode: job.mode, retryable });
    await bot.telegram.sendMessage(
      job.chatId,
      formatError(
        retryable
          ? `Launch job #${job.id} failed and will retry if attempts remain:\n${message}`
          : `Launch job #${job.id} failed and will not retry automatically:\n${message}`
      ),
      telegramReplyOptions
    );
  } finally {
    activeLaunches.delete(lockKey);
  }
}

async function runQueuedLaunch(
  proposal: Proposal,
  mode: LaunchMode,
  chatId: string,
  actorId?: number
): Promise<LaunchResult> {
  if (config.DRY_RUN) {
    return {
      launchpad: proposal.launchpad,
      dryRun: true,
      message: `Dry run only. Would launch ${proposal.name} ($${proposal.symbol}) with ${mode} mode.${await customCaDryRunNote(
        proposal
      )}`
    };
  }

  if (mode === "api") return launchProposal(proposal);

  if (mode === "group") {
    const robinhoodWallet = proposal.launchpad === "robinhood" ? await getOrCreateRobinhoodWallet("group", chatId) : undefined;
    const wallet = proposal.launchpad === "robinhood" ? undefined : await getPumpPortalApiKey("group", chatId);
    const exportedWallet =
      proposal.launchpad === "pumpfun" || proposal.launchpad === "bonk" || proposal.launchpad === "bags"
        ? await exportPumpPortalWallet("group", chatId)
        : undefined;
    let result =
      proposal.launchpad === "robinhood"
        ? await launchOnRobinhood(
            proposal,
            (await getRobinhoodWalletSecret("group", chatId)).privateKey,
            robinhoodWallet?.address
          )
        : proposal.launchpad === "bags"
        ? await launchWithBags(proposal, exportedWallet?.secretKey ?? "")
        : proposal.launchpad === "bonk"
        ? await launchWithPumpPortalApiKey(proposal, wallet!.apiKey)
        : await launchWithPumpFunSdk(proposal, exportedWallet?.secretKey ?? "", wallet!.address);
    if (!result.dryRun && proposal.launchpad === "bonk" && exportedWallet) {
      const platformFee: PlatformFeeResult = await sendPlatformFeeIfEnabled(exportedWallet.secretKey, wallet!.address, customCaFeeSol(proposal)).catch(
        (error): PlatformFeeResult => ({
          error: error instanceof Error ? error.message : String(error)
        })
      );
      result = {
        ...result,
        platformFeeSignature: platformFee.signature,
        platformFeeUrl: platformFee.url,
        platformFeeError: platformFee.error
      };
    }
    return result;
  }

  if (!actorId) throw new Error("Personal launch job is missing actor id.");
  if (proposal.launchpad === "robinhood") {
    const wallet = await getOrCreateRobinhoodWallet("user", String(actorId));
    return launchOnRobinhood(
      proposal,
      (await getRobinhoodWalletSecret("user", String(actorId))).privateKey,
      wallet.address
    );
  }
  const wallet = await getOrCreateWallet("user", String(actorId));
  return launchWithPumpFunSdk(
    proposal,
    (await exportWalletSecretBase58("user", String(actorId))).secretKey,
    wallet.address
  );
}

function isRetryableLaunchJobError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/submitted|signature|solscan|not confirmed|confirmed later|on-chain|already landed/i.test(message)) return false;
  if (/insufficient|needs more SOL|daily launch limit|MAX_DEV_BUY|missing|invalid|rejected|not found|expected approved/i.test(message)) {
    return false;
  }
  return isTransientNetworkError(error) || /fetch failed|timeout|ECONNRESET|429|500|502|503|504/i.test(message);
}

async function assertGroupLaunchReady(proposal: Proposal, groupId: string, walletAddress: string): Promise<void> {
  const problems: string[] = [];
  if (proposal.launchpad === "robinhood") {
    await assertRobinhoodLaunchReady(proposal, walletAddress, "group");
    return;
  }

  const devBuySol = proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL;
  const priorityFeeSol = priorityFeeForLaunchpad(proposal.launchpad);
  const platformFeeSol = platformFeeForProposal(proposal);
  const requiredSol = devBuySol + priorityFeeSol + platformFeeSol + config.LOCAL_LAUNCH_MIN_SOL_BUFFER;

  if (config.MAX_DEV_BUY_SOL > 0 && devBuySol > config.MAX_DEV_BUY_SOL) {
    problems.push(`dev buy ${devBuySol} SOL exceeds MAX_DEV_BUY_SOL ${config.MAX_DEV_BUY_SOL} SOL`);
  }
  const groupLaunchesToday = config.GROUP_DAILY_LAUNCH_LIMIT > 0 ? await countSuccessfulLaunchesSince("chat", groupId, dayAgoIso()) : 0;
  if (config.GROUP_DAILY_LAUNCH_LIMIT > 0 && groupLaunchesToday >= config.GROUP_DAILY_LAUNCH_LIMIT) {
    problems.push(`group daily launch limit reached (${groupLaunchesToday}/${config.GROUP_DAILY_LAUNCH_LIMIT})`);
  }
  if (!proposal.image) problems.push("proposal has no image");
  if (platformFeeSol > 0 && !config.PLATFORM_TREASURY_WALLET) problems.push("PLATFORM_TREASURY_WALLET is missing");
  if (platformFeeSol > 0 && config.PLATFORM_TREASURY_WALLET && !isValidSolanaAddress(config.PLATFORM_TREASURY_WALLET)) {
    problems.push("PLATFORM_TREASURY_WALLET is not a valid Solana wallet address");
  }
  if (proposal.launchpad === "bags" && !config.BAGS_API_KEY) problems.push("BAGS_API_KEY is missing");
  if (proposal.launchpad === "bags" && config.BAGS_MINT_SUFFIX.trim()) {
    problems.push("Bags vanity suffix is not supported by the current Bags SDK launch flow; set BAGS_MINT_SUFFIX=");
  }
  if (proposal.launchpad === "pumpfun" && !config.PINATA_JWT) problems.push("PINATA_JWT is missing");
  const mintProblem = await mintReadinessProblem(proposal);
  if (mintProblem) problems.push(mintProblem);

  if (proposal.launchpad === "bonk") {
    try {
      await exportPumpPortalWallet("group", groupId);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "group wallet export failed");
    }
  }

  try {
    const balance = await getSolBalance(walletAddress);
    if (balance < requiredSol) {
      problems.push(
        `group wallet has ${balance.toFixed(6)} SOL; needs at least ${requiredSol.toFixed(6)} SOL for dev buy, platform fee, fees, and rent`
      );
    }
  } catch (error) {
    console.warn(
      `[preflight:${proposal.id}] could not read group wallet balance from RPC: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (proposal.image) {
    try {
      await testLaunchImageFetch(proposal);
    } catch (error) {
      if (isTransientNetworkError(error)) {
        console.warn(
          `[preflight:${proposal.id}] image fetch check skipped due network timeout: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } else {
        problems.push(`image is not launch-ready: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Launch preflight failed:\n- ${problems.join("\n- ")}`);
  }
}

async function assertPersonalLaunchReady(proposal: Proposal, walletAddress: string): Promise<void> {
  const problems: string[] = [];
  if (proposal.launchpad === "robinhood") {
    await assertRobinhoodLaunchReady(proposal, walletAddress, "personal");
    return;
  }

  const devBuySol = proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL;
  const priorityFeeSol = priorityFeeForLaunchpad(proposal.launchpad);
  const platformFeeSol = platformFeeForProposal(proposal);
  const requiredSol = devBuySol + priorityFeeSol + platformFeeSol + config.LOCAL_LAUNCH_MIN_SOL_BUFFER;

  if (config.MAX_DEV_BUY_SOL > 0 && devBuySol > config.MAX_DEV_BUY_SOL) {
    problems.push(`dev buy ${devBuySol} SOL exceeds MAX_DEV_BUY_SOL ${config.MAX_DEV_BUY_SOL} SOL`);
  }
  const personalLaunchesToday =
    config.USER_DAILY_LAUNCH_LIMIT > 0 ? await countSuccessfulLaunchesSince("actor", proposal.createdBy, dayAgoIso()) : 0;
  if (config.USER_DAILY_LAUNCH_LIMIT > 0 && personalLaunchesToday >= config.USER_DAILY_LAUNCH_LIMIT) {
    problems.push(`personal daily launch limit reached (${personalLaunchesToday}/${config.USER_DAILY_LAUNCH_LIMIT})`);
  }
  if (proposal.launchpad !== "pumpfun") problems.push("personal launch currently supports Pump.fun only");
  if (!proposal.image) problems.push("proposal has no image");
  if (platformFeeSol > 0 && !config.PLATFORM_TREASURY_WALLET) problems.push("PLATFORM_TREASURY_WALLET is missing");
  if (platformFeeSol > 0 && config.PLATFORM_TREASURY_WALLET && !isValidSolanaAddress(config.PLATFORM_TREASURY_WALLET)) {
    problems.push("PLATFORM_TREASURY_WALLET is not a valid Solana wallet address");
  }
  if (!config.PINATA_JWT) problems.push("PINATA_JWT is missing");
  const mintProblem = await mintReadinessProblem(proposal);
  if (mintProblem) problems.push(mintProblem);

  try {
    const balance = await getSolBalance(walletAddress);
    if (balance < requiredSol) {
      problems.push(
        `personal wallet has ${balance.toFixed(6)} SOL; needs at least ${requiredSol.toFixed(6)} SOL for dev buy, platform fee, fees, and rent`
      );
    }
  } catch (error) {
    console.warn(
      `[preflight:${proposal.id}] could not read personal wallet balance from RPC: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (proposal.image) {
    try {
      await testLaunchImageFetch(proposal);
    } catch (error) {
      if (isTransientNetworkError(error)) {
        console.warn(
          `[preflight:${proposal.id}] image fetch check skipped due network timeout: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } else {
        problems.push(`image is not launch-ready: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Personal launch preflight failed:\n- ${problems.join("\n- ")}`);
  }
}

// A Robinhood launch uses ~1.7M gas, about 0.00004 ETH at recent prices; this covers spikes and the fee transfer.
const ROBINHOOD_GAS_BUFFER_ETH = 0.001;
// Only used when the live launch fee can't be read: covers Bags' documented 0.02 ETH default plus gas, and far
// more than Pons' 0.0005 ETH.
const ROBINHOOD_FALLBACK_FEE_AND_GAS_ETH = 0.025;

/** What a Robinhood launch needs in the wallet: the launchpad's live fee, the initial buy, the platform fee and gas. */
async function robinhoodLaunchCost(
  proposal: Proposal
): Promise<{ launchFeeEth?: number; devBuyEth: number; platformFeeEth: number; minimumEth: number }> {
  const devBuyEth = proposal.devBuyEth ?? config.DEFAULT_DEV_BUY_ETH;
  const platformFeeEth = config.ROBINHOOD_PLATFORM_FEE_ETH > 0 ? config.ROBINHOOD_PLATFORM_FEE_ETH : 0;
  const launchFeeEth = await readRobinhoodLaunchFeeEth().catch((error: unknown) => {
    console.warn(
      `[preflight:${proposal.id}] could not read the ${robinhoodLaunchpadName()} launch fee: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  });
  const feeAndGasEth = launchFeeEth === undefined ? ROBINHOOD_FALLBACK_FEE_AND_GAS_ETH : launchFeeEth + ROBINHOOD_GAS_BUFFER_ETH;
  return { launchFeeEth, devBuyEth, platformFeeEth, minimumEth: devBuyEth + platformFeeEth + feeAndGasEth };
}

async function assertRobinhoodLaunchReady(proposal: Proposal, walletAddress: string, mode: "group" | "personal"): Promise<void> {
  const problems: string[] = [];
  const { platformFeeEth, minimumEth: estimatedMinimum } = await robinhoodLaunchCost(proposal);

  if (!proposal.image) problems.push("proposal has no image");
  if (!config.PINATA_JWT) problems.push("PINATA_JWT is missing");
  if (!isValidEvmAddress(walletAddress)) problems.push(`${mode} Robinhood wallet is not a valid EVM address`);
  if (platformFeeEth > 0 && !config.ROBINHOOD_PLATFORM_TREASURY_WALLET) {
    problems.push("ROBINHOOD_PLATFORM_TREASURY_WALLET is missing");
  }
  if (
    platformFeeEth > 0 &&
    config.ROBINHOOD_PLATFORM_TREASURY_WALLET &&
    !isValidEvmAddress(config.ROBINHOOD_PLATFORM_TREASURY_WALLET)
  ) {
    problems.push("ROBINHOOD_PLATFORM_TREASURY_WALLET is not a valid EVM address");
  }

  try {
    const balance = await getEthBalance(walletAddress);
    if (balance < estimatedMinimum) {
      problems.push(
        `${mode} Robinhood wallet has ${balance.toFixed(6)} ETH; needs roughly ${estimatedMinimum.toFixed(
          6
        )} ETH for creation fee, dev buy, platform fee, and gas`
      );
    }
  } catch (error) {
    console.warn(
      `[preflight:${proposal.id}] could not read Robinhood wallet balance from RPC: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (proposal.image) {
    try {
      await testLaunchImageFetch(proposal);
    } catch (error) {
      if (isTransientNetworkError(error)) {
        console.warn(
          `[preflight:${proposal.id}] image fetch check skipped due network timeout: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } else {
        problems.push(`image is not launch-ready: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Robinhood launch preflight failed:\n- ${problems.join("\n- ")}`);
  }
}

async function assertApiLaunchReady(proposal: Proposal): Promise<void> {
  const problems: string[] = [];
  const devBuySol = proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL;
  const platformFeeSol = platformFeeForProposal(proposal);

  if (config.MAX_DEV_BUY_SOL > 0 && devBuySol > config.MAX_DEV_BUY_SOL) {
    problems.push(`dev buy ${devBuySol} SOL exceeds MAX_DEV_BUY_SOL ${config.MAX_DEV_BUY_SOL} SOL`);
  }
  if (proposal.launchpad === "bags") {
    problems.push("Bags launches should use Launch Group so the encrypted group wallet signs the launch");
  }
  if (proposal.launchpad === "pumpfun" && !config.PUMPFUN_SIGNER_PRIVATE_KEY) {
    problems.push("PUMPFUN_SIGNER_PRIVATE_KEY is missing");
  }
  if (proposal.launchpad === "bonk" && !config.PUMPPORTAL_API_KEY) problems.push("PUMPPORTAL_API_KEY is missing");
  if (proposal.launchpad === "bonk" && platformFeeSol > 0) {
    problems.push("per-launch platform and custom CA fees require group-wallet launch for Bonk");
  }
  if (platformFeeSol > 0 && !config.PLATFORM_TREASURY_WALLET) problems.push("PLATFORM_TREASURY_WALLET is missing");
  if (platformFeeSol > 0 && config.PLATFORM_TREASURY_WALLET && !isValidSolanaAddress(config.PLATFORM_TREASURY_WALLET)) {
    problems.push("PLATFORM_TREASURY_WALLET is not a valid Solana wallet address");
  }
  if (proposal.launchpad === "pumpfun" && !config.PINATA_JWT) problems.push("PINATA_JWT is missing");
  if (!proposal.image) problems.push("proposal has no image");
  const mintProblem = await mintReadinessProblem(proposal);
  if (mintProblem) problems.push(mintProblem);

  if (proposal.image) {
    try {
      await testLaunchImageFetch(proposal);
    } catch (error) {
      if (isTransientNetworkError(error)) {
        console.warn(
          `[preflight:${proposal.id}] image fetch check skipped due network timeout: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } else {
        problems.push(`image is not launch-ready: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Launch preflight failed:\n- ${problems.join("\n- ")}`);
  }
}

function mintSuffixForLaunchpad(launchpad: Launchpad): string {
  if (launchpad === "pumpfun") return config.PUMP_MINT_SUFFIX;
  if (launchpad === "bonk") return config.BONK_MINT_SUFFIX;
  return "";
}

function priorityFeeForLaunchpad(launchpad: Launchpad): number {
  if (launchpad === "bonk") return Math.max(config.DEFAULT_PRIORITY_FEE_SOL, 0.0005);
  return config.DEFAULT_PRIORITY_FEE_SOL;
}

/** Everything sent to the treasury after a successful launch: the platform fee plus any custom CA fee. */
function platformFeeForProposal(proposal: Proposal): number {
  return (config.PLATFORM_FEE_SOL > 0 ? config.PLATFORM_FEE_SOL : 0) + customCaFeeSol(proposal);
}

async function mintReadinessProblem(proposal: Proposal): Promise<string | undefined> {
  const customCa = customCaRequest(proposal);
  if (customCa) {
    const order = await getCustomCaOrder(proposal.id);
    // A reservation left by a crashed launch is reclaimed at launch time, so let the launch decide.
    if (order?.status === "ready" || order?.status === "reserved") return undefined;
    return `custom CA (${describeCustomCa(customCa)}) is ${customCaStatusLabel(order)}`;
  }

  const suffix = mintSuffixForLaunchpad(proposal.launchpad);
  if (suffix && (await countAvailableVanityMints(suffix)) < 1) {
    return `no ${proposal.launchpad} vanity mints available for suffix "${suffix}"`;
  }
  return undefined;
}

function customCaRequest(proposal: Proposal): CustomCaRequest | undefined {
  if (!proposal.customCaPattern) return undefined;
  return { position: proposal.customCaPosition ?? "end", pattern: proposal.customCaPattern };
}

function customCaStatusLabel(order: CustomCaOrder | undefined): string {
  if (!order) return "not ordered";
  if (order.status === "pending") return "still being generated";
  if (order.status === "reserved") return "in use by a launch";
  if (order.status === "used") return "already used";
  return order.status;
}

async function customCaDryRunNote(proposal: Proposal): Promise<string> {
  const customCa = customCaRequest(proposal);
  if (!customCa) return "";
  const order = await getCustomCaOrder(proposal.id);
  return ` Custom CA (${describeCustomCa(customCa)}): ${customCaStatusLabel(order)}.`;
}

async function cancelCustomCaIfRejected(proposal: Proposal): Promise<void> {
  if (proposal.status !== "rejected" || !proposal.customCaPattern) return;
  pendingCustomCaOrders.delete(proposal.id);
  await cancelCustomCaOrder(proposal.id);
}

/** Called by the grinder API with a keypair it found. Verifies it before storing it encrypted. */
async function storeCustomCaResult(proposalId: number, address: string, secretKeyBase58: string): Promise<GrinderSubmitResult> {
  const order = pendingCustomCaOrders.get(proposalId);
  if (!order) return { ok: false, status: 404, error: `no pending custom CA order for #${proposalId}` };

  const problem = customCaKeypairProblem(order, address, secretKeyBase58);
  if (problem) return { ok: false, status: 400, error: problem };

  const stored = await fulfillCustomCaOrder(proposalId, address, encryptMintSecret(secretKeyBase58));
  pendingCustomCaOrders.delete(proposalId);
  if (!stored) return { ok: false, status: 409, error: `custom CA order for #${proposalId} is no longer pending` };

  logInfo("custom_ca_ready", { proposalId, position: order.position, pattern: order.pattern });
  await bot.telegram
    .sendMessage(
      stored.chatId,
      `&#9989; <b>Custom CA ready for #${proposalId}</b>\nIt will ${escapeHtml(describeCustomCa(order))}. ` +
        "The full address stays hidden until launch.",
      telegramReplyOptions
    )
    .catch((error) => logError("custom_ca_ready_notify_failed", error, { proposalId }));
  return { ok: true };
}

/** Adds orders from the database that this process does not know about yet. */
async function loadPendingCustomCaOrders(): Promise<void> {
  for (const order of await listPendingCustomCaOrders()) {
    if (!pendingCustomCaOrders.has(order.proposalId)) pendingCustomCaOrders.set(order.proposalId, order);
  }
}

function dayAgoIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

function parseOnOff(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["on", "yes", "true", "1", "enable", "enabled"].includes(normalized)) return true;
  if (["off", "no", "false", "0", "disable", "disabled"].includes(normalized)) return false;
  throw new Error("Use on or off.");
}

function assertSolanaAddress(value: string, label: string): void {
  const normalized = value.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalized)) {
    throw new Error(`Send a valid ${label}.`);
  }
}

function feeSplitFromPercent(wallet: string | undefined, percent: number): string {
  if (!wallet) throw new Error("Send the fee recipient wallet first.");
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    throw new Error("Fee percent must be greater than 0 and less than 100.");
  }
  const recipientBps = Math.round(percent * 100);
  const creatorBps = 10000 - recipientBps;
  const split = normalizeFeeShareSetting(`${wallet}:${recipientBps},creator:${creatorBps}`);
  if (!split) throw new Error("Custom fee split could not be created.");
  return split;
}

function normalizeFeeShareSetting(value: string): string | undefined {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (lower === "none" || lower === "off" || lower === "no") return undefined;
  if (lower === "creator" || lower === "creator:10000") return "creator:10000";

  const total = normalized.split(",").reduce((sum, part) => {
    const [, rawShareText] = part.split(":");
    const rawShare = Number(rawShareText?.replace("%", ""));
    if (!Number.isFinite(rawShare) || rawShare <= 0) throw new Error("Custom fees must be wallet:percent pairs.");
    const bps = rawShare <= 100 ? Math.round(rawShare * 100) : rawShare;
    if (!Number.isInteger(bps) || bps <= 0) throw new Error("Custom fees must be wallet:percent pairs.");
    return sum + bps;
  }, 0);
  if (total !== 10000) throw new Error(`Fee share bps must total 10000. Current total: ${total}.`);
  return normalized
    .split(",")
    .map((part) => {
      const [wallet, rawShareText] = part.split(":");
      const rawShare = Number(rawShareText?.replace("%", ""));
      const bps = rawShare <= 100 ? Math.round(rawShare * 100) : rawShare;
      return `${wallet.trim()}:${bps}`;
    })
    .join(",");
}

async function canEditProposalSettings(ctx: Context, proposal: Proposal): Promise<boolean> {
  return proposal.createdBy === ctx.from?.id || (await isBotAdmin(ctx));
}

function feeSettingsMessage(proposal: Proposal): string {
  const fees = proposal.pumpfunFeeShares
    ? proposal.pumpfunFeeShares === "creator:10000"
      ? "Creator 100%"
      : proposal.pumpfunFeeShares
    : "None";

  return [
    `<b>Fee Settings #${proposal.id}</b>`,
    "",
    `<b>${escapeHtml(proposal.name)}</b> | <code>$${escapeHtml(proposal.symbol)}</code>`,
    `Launchpad: <b>${proposal.launchpad === "pumpfun" ? "Pump.fun" : proposal.launchpad}</b>`,
    `&#127873; Cashback: <b>${proposal.pumpfunCashback ? "On" : "Off"}</b>`,
    `&#129309; Fee Share: <b>${escapeHtml(fees)}</b>`,
    "",
    "Use the buttons below to change launch fee settings.",
    "Fee sharing can lock Pump.fun reward distribution once configured."
  ].join("\n");
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted|ECONNRESET|ENOTFOUND|fetch failed|Connect Timeout/i.test(message);
}

async function withLaunchLock(ctx: Context, key: string, run: () => Promise<void>): Promise<void> {
  if (activeLaunches.has(key)) {
    await ctx.reply("A launch for this proposal is already running. Please wait.");
    return;
  }

  activeLaunches.add(key);
  try {
    await run();
  } catch (error) {
    await ctx.reply(formatError(error), telegramReplyOptions);
  } finally {
    activeLaunches.delete(key);
  }
}

function runLaunchInBackground(ctx: Context, run: () => Promise<void>): void {
  void run().catch((error) => {
    logError("background_launch_failed", error, { chatId: ctx.chat?.id, fromId: ctx.from?.id });
    void ctx.reply(formatError(error), telegramReplyOptions);
  });
}

async function assertApprovalImageValid(proposal: Proposal): Promise<void> {
  if (!proposal.image) {
    throw new Error("Proposal image is required before approval.");
  }

  const result = await testLaunchImageFetch(proposal);
  console.log(`[approval:${proposal.id}] image validation OK: ${result}`);
}

function validateTelegramPhotoMeta(photo: { width: number; height: number; file_size?: number }): string | undefined {
  if (photo.file_size && photo.file_size > config.MAX_IMAGE_BYTES) {
    return `Image is too large. Max ${config.MAX_IMAGE_BYTES.toLocaleString()} bytes.`;
  }

  const minDimension = Math.min(photo.width, photo.height);
  const maxDimension = Math.max(photo.width, photo.height);
  if (minDimension < config.MIN_IMAGE_DIMENSION) {
    return `Image is too small. Minimum dimension is ${config.MIN_IMAGE_DIMENSION}px.`;
  }
  if (maxDimension > config.MAX_IMAGE_DIMENSION) {
    return `Image is too large. Maximum dimension is ${config.MAX_IMAGE_DIMENSION}px.`;
  }
  if (config.REQUIRE_SQUARE_IMAGE && photo.width !== photo.height) {
    return `Image must be square. Got ${photo.width}x${photo.height}.`;
  }

  return undefined;
}

async function validateAndApproveFromButton(ctx: Context, id: number, adminId: number): Promise<void> {
  const pendingProposal = await getProposal(id);
  if (!pendingProposal) {
    await ctx.reply(`Proposal #${id} not found.`);
    return;
  }

  if (!pendingProposal.image) {
    await ctx.reply(
      `&#9888; <b>Cannot approve proposal #${id}</b>\n\nProposal image is required before approval.`,
      telegramReplyOptions
    );
    return;
  }

  await assertApprovalImageValid(pendingProposal);
  const proposal = await approveProposal(id, adminId);
  if (!proposal) {
    await ctx.reply(`Proposal #${id} not found.`);
    return;
  }
  audit(ctx, "proposal_approved", id, { launchpad: proposal.launchpad, devBuySol: proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL });

  await ctx.reply(proposalMessage(proposal, "Approved"), {
    ...telegramReplyOptions,
    reply_markup: { inline_keyboard: proposalKeyboard(proposal) }
  });
}

function parseIdArg(text: string): number | undefined {
  const [, idText] = text.split(/\s+/, 2);
  const id = Number(idText);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function shouldStartWizard(text: string): boolean {
  if (text.includes("\n")) return false;
  const parts = text.trim().split(/\s+/);
  return parts[0].startsWith("/idea");
}

function parseIdeaCommandShortcut(text: string): Partial<CoinIdeaInput> {
  const [, rawLaunchpad, ...rest] = text.trim().split(/\s+/);
  const data: Partial<CoinIdeaInput> = {};

  if (rawLaunchpad === "pumpfun" || rawLaunchpad === "bonk" || rawLaunchpad === "robinhood") {
    data.launchpad = rawLaunchpad;
  } else if (rawLaunchpad === "bags") {
    data.launchpad = rawLaunchpad;
  }

  if (rest.length >= 2) {
    data.symbol = rest.at(-1)?.toUpperCase();
    data.name = rest.slice(0, -1).join(" ");
  }

  return data;
}

async function startWizard(ctx: Context, data: Partial<CoinIdeaInput> = {}): Promise<void> {
  const key = draftKey(ctx);
  if (!key) {
    await ctx.reply("I could not identify this chat/user.");
    return;
  }

  const draft: Draft = { data, step: "launchpad" };
  drafts.set(key, draft);
  await advanceWizard(ctx, draft);
}

async function applyWizardText(ctx: Context, draft: Draft, value: string): Promise<void> {
  if (draft.step === "name") {
    if (value.length < 2 || value.length > 32) throw new Error("Name must be 2-32 characters.");
    draft.data.name = value;
  } else if (draft.step === "symbol") {
    const symbol = value.replace(/^\$/, "").toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) {
      throw new Error("Ticker must be 2-10 letters or numbers.");
    }
    draft.data.symbol = symbol;
  } else if (draft.step === "description") {
    if (value.length < 10 || value.length > 500) {
      throw new Error("Description must be 10-500 characters.");
    }
    draft.data.description = value;
  } else if (draft.step === "website") {
    assertUrl(value, "website");
    draft.data.website = value;
  } else if (draft.step === "telegram") {
    assertUrl(value, "Telegram link");
    draft.data.telegram = value;
  } else if (draft.step === "twitter") {
    assertUrl(value, "Twitter/X link");
    draft.data.twitter = value;
  } else if (draft.step === "image") {
    assertUrl(value, "image link");
    draft.data.image = value;
  } else if (draft.step === "devBuy") {
    const amount = Number(value);
    const unit = draft.data.launchpad === "robinhood" ? "ETH" : "SOL";
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Send a valid ${unit} amount, like 0.01.`);
    if (draft.data.launchpad === "robinhood") draft.data.devBuyEth = amount;
    else draft.data.devBuySol = amount;
  } else if (draft.step === "feeShares") {
    draft.data.pumpfunFeeShares = normalizeFeeShareSetting(value);
  } else if (draft.step === "feeShareWallet") {
    assertSolanaAddress(value, "fee recipient wallet");
    draft.customFeeWallet = value.trim();
  } else if (draft.step === "feeSharePercent") {
    const percent = Number(value.replace("%", ""));
    draft.data.pumpfunFeeShares = feeSplitFromPercent(draft.customFeeWallet, percent);
  } else if (draft.step === "customCaText") {
    const position = draft.customCaPosition ?? "end";
    let quote: ReturnType<typeof quoteCustomCa>;
    try {
      quote = quoteCustomCa({ position, pattern: normalizeCustomCaPattern(position, value) }, customCaPricing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nReply to my question above with different text, or send /skip for a normal CA.`);
    }
    draft.data.customCaPosition = quote.position;
    draft.data.customCaPattern = quote.pattern;
    draft.data.customCaFeeSol = quote.feeSol;
  }

  await advanceWizard(ctx, draft);
}

function assertUrl(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`Send a valid ${label}, including https://, or tap Skip.`);
  }
}

async function advanceWizard(ctx: Context, draft: Draft, edit = false): Promise<void> {
  const previousPromptMessageId = draft.promptMessageId;
  draft.step = nextDraftStep(draft);

  if (draft.step === "preview") {
    const idea = validateIdea(draft.data);
    if (!edit) await safeDeleteMessage(ctx, previousPromptMessageId, "previous wizard prompt");
    draft.promptMessageId = await sendWizardMessage(ctx, wizardPreviewMessage(idea), wizardPreviewKeyboard(), false, edit);
    return;
  }

  const question = wizardQuestion(draft.step, draft);
  if (!edit) await safeDeleteMessage(ctx, previousPromptMessageId, "previous wizard prompt");
  draft.promptMessageId = await sendWizardMessage(ctx, question.text, question.keyboard, question.forceReply, edit);
}

function nextDraftStep(draft: Draft): DraftStep {
  if (draft.forcedStep) {
    const step = draft.forcedStep;
    draft.forcedStep = undefined;
    return step;
  }

  if (!draft.data.launchpad) return "launchpad";
  if (!draft.data.name) return "name";
  if (!draft.data.symbol) return "symbol";
  if (!draft.data.description) return "description";
  if (draft.step === "description") return "website";
  if (draft.step === "website") return "telegram";
  if (draft.step === "telegram") return "twitter";
  if (draft.step === "twitter") return "image";
  if (draft.step === "image") return "devBuy";
  if (draft.step === "devBuy") return draft.data.launchpad === "pumpfun" ? "cashback" : customCaStepOrPreview(draft);
  if (draft.step === "cashback") return "feeShares";
  if (draft.step === "feeShares") return customCaStepOrPreview(draft);
  if (draft.step === "feeShareWallet") return "feeSharePercent";
  if (draft.step === "feeSharePercent") return customCaStepOrPreview(draft);
  if (draft.step === "customCa" || draft.step === "customCaText") return "preview";
  return draft.step;
}

/** Prices, waits and rules, shown by /customca and at the top of the wizard's Custom CA step. */
function customCaInfoMessage(): string {
  const prices = [...customCaPricing.feesByLength.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([length, fee]) =>
        `• ${length} characters: <b>${fee} SOL</b>, usually ready in ${typicalSearchTime(length, customCaPricing.keysPerSecond)}`
    );

  return [
    "Make your token's CA start or end with your own text, like <code>…pepe</code> or <code>…doge</code>.",
    "",
    ...prices,
    "",
    "<b>Good to know</b>",
    "• <b>Ends with…</b> works for any text.",
    `• <b>Starts with…</b> is only fast when your text begins with <b>${FAST_FIRST_CHARACTERS_LABEL}</b>.`,
    ...customCaTextRules(),
    "• The fee is paid from the launch wallet only after a successful launch. A normal CA is free.",
    "• The full CA stays hidden until launch."
  ].join("\n");
}

function customCaTextRules(): string[] {
  return [
    `• ${describeLengths(customCaPricing.feesByLength)} letters or numbers.`,
    "• CAs never contain 0, O, I or l, so <code>MOON</code> won't work but <code>moon</code> will.",
    "• Upper and lower case must match exactly: <code>pepe</code> and <code>PEPE</code> are different."
  ];
}

function customCaStepOrPreview(draft: Draft): DraftStep {
  const supported = draft.data.launchpad === "pumpfun" || draft.data.launchpad === "bonk";
  return customCaEnabled && supported ? "customCa" : "preview";
}

function wizardQuestion(step: DraftStep, draft?: Draft): {
  text: string;
  keyboard?: InlineKeyboardButton[][];
  forceReply?: boolean;
} {
  if (step === "launchpad") {
    return {
      text: wizardQuestionMessage("Step 1/8: Choose Launchpad", "Where should this idea launch?"),
      keyboard: [
        [
          { text: "🚀 Pump.fun", callback_data: "wizard:launchpad:pumpfun" },
          { text: "🟠 Bonk", callback_data: "wizard:launchpad:bonk" }
        ],
        [
          { text: "🎒 Bags", callback_data: "wizard:launchpad:bags" },
          { text: "🟢 Robinhood", callback_data: "wizard:launchpad:robinhood" }
        ],
        [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]
      ]
    };
  }

  if (step === "preview") {
    throw new Error("Preview does not have a question.");
  }

  const questions: Record<Exclude<DraftStep, "launchpad" | "preview">, string> = {
    name: "Reply with the coin name.\nExample: <code>Example Cat</code>",
    symbol: "Reply with the ticker without $.\nExample: <code>ECAT</code>",
    description: "Reply with a short description for the proposal.",
    website: "Reply to this message with the website link, tap Skip, or send <code>/skip</code>.",
    telegram:
      "Reply to this message with the Telegram/community link, use this group, tap Skip, or send <code>/skip</code>.",
    twitter: "Reply to this message with the Twitter/X link, tap Skip, or send <code>/skip</code>.",
    image: "Reply with an image URL or upload the image as a reply. Image is required for launch metadata.",
    devBuy: "Choose the initial buy amount, or tap Custom and send any positive amount.",
    cashback: "Pump.fun cashback uses the V2 create flow. Enable it only if you want cashback on this launch.",
    feeShares:
      "Choose Pump.fun creator-fee sharing. This can lock reward distribution once configured.",
    feeShareWallet: "Send the wallet that should receive part of the creator fees.",
    feeSharePercent: "Choose what percent this wallet should receive. The remaining percent goes to the creator/dev wallet.",
    customCa: [customCaInfoMessage(), "", "Pick an option below."].join("\n"),
    customCaText:
      draft?.customCaPosition === "start"
        ? [
            "Reply with the text your CA should <b>start</b> with.",
            "Example: <code>Bonk</code> gives <code>Bonk…</code>",
            "",
            `• Begin with <b>${FAST_FIRST_CHARACTERS_LABEL}</b> for a fast result. Text like <code>moon</code> or <code>PEPE</code> may be refused as too slow; use Ends with… for those.`,
            ...customCaTextRules(),
            "",
            "Send <code>/skip</code> to keep a normal CA instead."
          ].join("\n")
        : [
            "Reply with the text your CA should <b>end</b> with.",
            "Example: <code>pepe</code> gives <code>…pepe</code>",
            "",
            ...customCaTextRules(),
            "",
            "Send <code>/skip</code> to keep a normal CA instead."
          ].join("\n")
  };

  const skipButton = (field: string): InlineKeyboardButton => ({
    text: "Skip",
    callback_data: `wizard:skip:${field}`
  });

  const keyboards: Partial<Record<DraftStep, InlineKeyboardButton[][]>> = {
    website: [[skipButton("website")], [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]],
    telegram: [
      [{ text: "Use this group", callback_data: "wizard:group_tg" }, skipButton("telegram")],
      [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]
    ],
    twitter: [[skipButton("twitter")], [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]],
    image: [[{ text: "❌ Cancel", callback_data: "wizard:cancel" }]],
    devBuy: [
      [
        { text: "0.01", callback_data: "wizard:devbuy:0.01" },
        { text: "0.05", callback_data: "wizard:devbuy:0.05" },
        { text: "Custom", callback_data: "wizard:devbuy_custom" }
      ],
      [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]
    ],
    cashback: [
      [
        { text: "Cashback On", callback_data: "wizard:cashback:on" },
        { text: "Cashback Off", callback_data: "wizard:cashback:off" }
      ],
      [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]
    ],
    feeShares: [
      [
        { text: "No Fee Sharing", callback_data: "wizard:fees:none" },
        { text: "Creator 100%", callback_data: "wizard:fees:creator" }
      ],
      [{ text: "Custom Split", callback_data: "wizard:fees_custom" }],
      [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]
    ],
    feeSharePercent: [
      [
        { text: "10%", callback_data: "wizard:fees_percent:10" },
        { text: "20%", callback_data: "wizard:fees_percent:20" },
        { text: "30%", callback_data: "wizard:fees_percent:30" }
      ],
      [
        { text: "40%", callback_data: "wizard:fees_percent:40" },
        { text: "50%", callback_data: "wizard:fees_percent:50" },
        { text: "Custom", callback_data: "wizard:fees_percent_custom" }
      ],
      [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]
    ],
    customCa: [
      [
        { text: "Starts with…", callback_data: "wizard:customca:start" },
        { text: "Ends with…", callback_data: "wizard:customca:end" }
      ],
      [{ text: "Normal CA (free)", callback_data: "wizard:customca:none" }],
      [{ text: "❌ Cancel", callback_data: "wizard:cancel" }]
    ]
  };

  const titles: Partial<Record<DraftStep, string>> = {
    customCa: "Custom CA (optional)",
    customCaText: "Custom CA text"
  };

  return {
    text: wizardQuestionMessage(titles[step] ?? `Step: ${step}`, questions[step]),
    keyboard: keyboards[step],
    forceReply:
      step === "name" ||
      step === "symbol" ||
      step === "description" ||
      step === "feeShares" ||
      step === "feeShareWallet" ||
      step === "feeSharePercent" ||
      step === "customCaText"
  };
}

async function sendWizardMessage(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboardButton[][] | undefined,
  forceReply: boolean | undefined,
  edit: boolean
): Promise<number | undefined> {
  if (edit && keyboard && "editMessageText" in ctx) {
    try {
      await ctx.editMessageText(text, {
        ...telegramReplyOptions,
        reply_markup: { inline_keyboard: keyboard }
      });
      const callbackQuery = ctx.callbackQuery as { message?: { message_id?: number } } | undefined;
      return callbackQuery?.message?.message_id;
    } catch {
      // Fall through to a new reply when Telegram cannot edit the old message.
    }
  }

  if (keyboard) {
    const message = await ctx.reply(text, {
      ...telegramReplyOptions,
      reply_markup: { inline_keyboard: keyboard }
    });
    return message.message_id;
  }

  if (forceReply) {
    const message = await ctx.reply(text, {
      ...telegramReplyOptions,
      reply_markup: { force_reply: true, selective: true }
    });
    return message.message_id;
  }

  const message = await ctx.reply(text, telegramReplyOptions);
  return message.message_id;
}

function draftKey(ctx: Context): string | undefined {
  if (!ctx.chat?.id || !ctx.from?.id) return undefined;
  return `${ctx.chat.id}:${ctx.from.id}`;
}

function isWizardReply(ctx: Context, draft: Draft): boolean {
  if (ctx.chat?.type === "private") return true;
  if (draft.step === "devBuy") return true;
  if (!("message" in ctx.update)) return false;
  const message = ctx.update.message as { reply_to_message?: { message_id?: number } };
  const replyTo = message.reply_to_message;
  return Boolean(draft.promptMessageId && replyTo?.message_id === draft.promptMessageId);
}

function isRejectionReply(ctx: Context, draft: RejectionDraft): boolean {
  if (ctx.chat?.type === "private") return true;
  if (!("message" in ctx.update)) return false;
  const message = ctx.update.message as { reply_to_message?: { message_id?: number } };
  const replyTo = message.reply_to_message;
  return Boolean(draft.promptMessageId && replyTo?.message_id === draft.promptMessageId);
}

async function applyRejectionText(
  ctx: Context,
  key: string,
  draft: RejectionDraft,
  reason: string
): Promise<void> {
  if (reason.length < 2 || reason.length > 300) {
    throw new Error("Rejection reason must be 2-300 characters.");
  }

  const proposal = await rejectProposal(draft.proposalId, reason);
  rejectionDrafts.delete(key);
  await safeDeleteMessage(ctx, draft.promptMessageId, "rejection prompt");

  if (!proposal) {
    await ctx.reply(`Proposal #${draft.proposalId} not found or cannot be rejected.`);
    return;
  }
  await cancelCustomCaIfRejected(proposal);
  audit(ctx, "proposal_rejected", proposal.id, { reason });

  await ctx.reply(
    [`<b>Rejected #${proposal.id}</b>`, "", escapeHtml(reason)].join("\n"),
    telegramReplyOptions
  );
}

function walletMessage(title: string, wallet: WalletView): string {
  const providerLabel =
    wallet.provider === "pumpportal"
      ? "Launch Wallet (Pump.fun SDK + Bonk API)"
      : wallet.provider === "evm"
        ? "Robinhood Chain Wallet"
      : "Launch Wallet";
  const balanceLine =
    wallet.provider === "evm"
      ? wallet.balanceEth === undefined
        ? wallet.balanceError
          ? `Balance: unavailable right now (${escapeHtml(wallet.balanceError)})`
          : `Balance: use <code>/rhgroupbalance</code> or <code>/rhmybalance</code> to refresh`
        : `Balance: <b>${wallet.balanceEth.toFixed(6)} ETH</b>`
      : wallet.balanceSol === undefined
        ? wallet.balanceError
          ? `Balance: unavailable right now (${escapeHtml(wallet.balanceError)})`
          : `Balance: use <code>/groupbalance</code> to refresh`
        : `Balance: <b>${wallet.balanceSol.toFixed(6)} SOL</b>`;
  const fundingText =
    wallet.provider === "evm"
      ? "Deposit Robinhood Chain ETH to this address. The private key is encrypted and never shown in Telegram."
      : "Deposit SOL to this address. Pump.fun signs with this encrypted wallet; Bonk uses its encrypted API key. The private key is never shown in Telegram.";

  return [
    `<b>${escapeHtml(title)}</b>`,
    "",
    wallet.created ? "Created a new wallet." : undefined,
    `Provider: <b>${providerLabel}</b>`,
    wallet.hasApiKey ? "Bonk API key: <b>encrypted</b>" : undefined,
    `Address: <code>${escapeHtml(wallet.address)}</code>`,
    balanceLine,
    "",
    fundingText
  ]
    .filter(Boolean)
    .join("\n");
}

function walletKeyboard(wallet: WalletView): InlineKeyboardButton[][] {
  return [[copyButton("Copy Address", wallet.address)]];
}

async function replyWallet(ctx: Context, title: string, wallet: WalletView): Promise<void> {
  try {
    await ctx.reply(walletMessage(title, wallet), {
      ...telegramReplyOptions,
      reply_markup: { inline_keyboard: walletKeyboard(wallet) }
    });
  } catch (error) {
    console.warn("Wallet reply with copy button failed, retrying without markup", error);
    await ctx.reply(walletMessage(title, wallet), telegramReplyOptions);
  }
}

async function withBalance(wallet: WalletView): Promise<WalletView> {
  return {
    ...wallet,
    balanceSol: await getSolBalance(wallet.address),
    balanceError: undefined
  };
}

async function withEthBalance(wallet: WalletView): Promise<WalletView> {
  return {
    ...wallet,
    balanceEth: await getEthBalance(wallet.address),
    balanceError: undefined
  };
}

function withBalanceError(wallet: WalletView, error: unknown): WalletView {
  return {
    ...wallet,
    balanceSol: undefined,
    balanceEth: undefined,
    balanceError: error instanceof Error ? error.message : String(error)
  };
}

async function replyLaunchResult(ctx: Context, result: LaunchResult): Promise<void> {
  const keyboard = launchKeyboard(result);
  await ctx.reply(launchMessage(result), {
    ...telegramReplyOptions,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

function exportMessage(title: string, address: string, secretKey: string, apiKey?: string): string {
  return [
    `<b>${escapeHtml(title)}</b>`,
    "",
    "<b>Keep this private.</b> Anyone with this key can drain the wallet or trade with the API key.",
    "",
    `Address: <code>${escapeHtml(address)}</code>`,
    `Private key: <code>${escapeHtml(secretKey)}</code>`,
    apiKey ? `PumpPortal API key: <code>${escapeHtml(apiKey)}</code>` : undefined
  ].filter(Boolean).join("\n");
}

async function safeAnswerCallback(ctx: Context, text: string): Promise<void> {
  if (!("answerCbQuery" in ctx) || typeof ctx.answerCbQuery !== "function") return;

  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    console.warn("Could not answer callback query", error);
  }
}

async function safeDeleteMessage(ctx: Context, messageId: number | undefined, label = "message"): Promise<boolean> {
  if (!messageId || !ctx.chat?.id) return false;

  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
    return true;
  } catch (error) {
    console.warn(`Could not delete ${label} ${messageId}`, error);
    return false;
  }
}

async function safeDeleteWizardInput(ctx: Context, messageId: number | undefined): Promise<void> {
  if (ctx.chat?.type === "private") return;
  await safeDeleteMessage(ctx, messageId, "wizard input");
}

async function safeEditMessageText(ctx: Context, text: string, keyboard: InlineKeyboardButton[][]): Promise<void> {
  if (!("editMessageText" in ctx) || typeof ctx.editMessageText !== "function") return;

  try {
    await ctx.editMessageText(text, {
      ...telegramReplyOptions,
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("message is not modified")) return;
    throw error;
  }
}

function canSkipStep(step: DraftStep): boolean {
  return (
    step === "website" ||
    step === "telegram" ||
    step === "twitter" ||
    step === "devBuy" ||
    step === "customCa" ||
    step === "customCaText"
  );
}

async function isBotAdmin(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (requireAdmin(userId)) return true;
  if (!config.ALLOW_GROUP_ADMINS || !userId) return false;
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return false;

  try {
    const member = await ctx.getChatMember(userId);
    return member.status === "creator" || member.status === "administrator";
  } catch (error) {
    logError("group_admin_check_failed", error, { chatId: ctx.chat?.id, fromId: userId });
    return false;
  }
}

function formatError(error: unknown, includeHelp = false): string {
  const message =
    error instanceof ZodError
      ? error.errors.map((issue) => issue.message).join("\n")
      : error instanceof Error
        ? error.message
        : describeUnknownError(error);

  return errorMessage(message, includeHelp);
}

function describeUnknownError(error: unknown): string {
  if (error === undefined) return "Unknown error.";
  if (error === null) return "Unknown error: null.";
  if (typeof error === "object") {
    try {
      return JSON.stringify(error).slice(0, 1200);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

function audit(ctx: Context, action: string, proposalId?: number, details?: unknown): void {
  void createAuditLog({
    action,
    actorId: ctx.from?.id,
    actorUsername: ctx.from?.username,
    chatId: ctx.chat?.id === undefined ? undefined : String(ctx.chat.id),
    proposalId,
    details
  }).catch((error) => logError("audit_persist_failed", error, { action, proposalId }));
  logInfo("audit", { action, proposalId, actorId: ctx.from?.id, chatId: ctx.chat?.id, details });
}

function isRateLimited(chatId: string, fromId: string): boolean {
  const now = Date.now();
  const key = `${chatId}:${fromId}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + config.RATE_LIMIT_WINDOW_MS });
    return false;
  }

  bucket.count += 1;
  if (bucket.count > config.RATE_LIMIT_MAX_UPDATES) {
    logInfo("rate_limited", { chatId, fromId, count: bucket.count });
    return true;
  }
  return false;
}

function startHealthServer(): void {
  if (!config.HEALTHCHECK_PORT) return;

  const server = http.createServer((request, response) => {
    void handleGrinderRequest(request, response, grinderApi)
      .then((handled) => {
        if (handled) return;
        response.writeHead(databaseHealthy ? 200 : 503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: databaseHealthy,
            database: databaseHealthy ? "connected" : "starting",
            mode: config.DRY_RUN ? "dry-run" : "live",
            uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
            activeLaunches: activeLaunches.size
          })
        );
      })
      .catch((error) => {
        logError("grinder_api_failed", error);
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "internal error" }));
      });
  });

  server.listen(config.HEALTHCHECK_PORT, () => {
    logInfo("health_server_started", { port: config.HEALTHCHECK_PORT });
  });
}

console.log("Starting Telegram launchpad bot...");
startHealthServer();
void startBot().catch((error) => {
  logError("bot_startup_failed", error);
  void closeDatabase().finally(() => process.exit(1));
});

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function startBot(): Promise<void> {
  assertWalletEncryptionKeyReady();
  await assertDatabaseReady();
  databaseHealthy = true;
  logInfo("database_connected", { provider: "postgres" });
  // Resume jobs queued before a restart; the worker schedules its own wakeups from here.
  void launchJobWorker.run();
  await loadPendingCustomCaOrders();
  // Pick up orders the outgoing instance took while a deploy overlapped this one.
  setTimeout(
    () => void loadPendingCustomCaOrders().catch((error) => logError("custom_ca_orders_load_failed", error)),
    3 * 60_000
  ).unref();
  await launchBotWithRetry();
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  bot.stop(signal);
  await closeDatabase();
}

async function launchBotWithRetry(): Promise<void> {
  let attempt = 1;

  while (true) {
    try {
      await setupBotCommands();
      await bot.launch();
      console.log("Telegram launchpad bot polling started.");
      return;
    } catch (error) {
      const delayMs = Math.min(60_000, 2_000 * attempt);
      logError("telegram_polling_start_failed", error, { attempt, retryInSeconds: Math.round(delayMs / 1000) });
      try {
        bot.stop("polling retry");
      } catch {
        // Telegraf throws if polling never fully started. That is fine; the next loop starts cleanly.
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}

async function setupBotCommands(): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: "idea", description: "Open the coin idea wizard" },
    ...(customCaEnabled ? [{ command: "customca", description: "Custom CA prices and tips" }] : []),
    { command: "commands", description: "Show bot commands" },
    { command: "review", description: "Review pending launch ideas" },
    { command: "groupwallet", description: "Create/show the group launch wallet" },
    { command: "groupbalance", description: "Check the group launch wallet balance" },
    { command: "mywallet", description: "Create/show your personal launch wallet" },
    { command: "mybalance", description: "Check your personal wallet balance" },
    { command: "rhgroupwallet", description: "Create/show Robinhood group wallet" },
    { command: "rhgroupbalance", description: "Check Robinhood group wallet balance" },
    { command: "rhmywallet", description: "Create/show Robinhood personal wallet" },
    { command: "rhmybalance", description: "Check Robinhood personal wallet balance" },
    { command: "launchme", description: "Launch your own proposal" },
    { command: "feesettings", description: "Show proposal fee settings" },
    { command: "cashback", description: "Set Pump.fun cashback on/off" },
    { command: "setfees", description: "Set Pump.fun fee sharing" },
    { command: "exportgroupwallet", description: "DM admin: export a group wallet" },
    { command: "exportmywallet", description: "DM admin: export your personal wallet" },
    { command: "launchcheck", description: "Check launch readiness" },
    { command: "status", description: "Admin status and recent launch attempts" },
    { command: "proposal", description: "Show a proposal by ID" },
    { command: "imagetest", description: "Validate a proposal image" },
    { command: "txcheck", description: "Check a launch transaction/CA" },
    { command: "help", description: "Show bot help and launchpad links" }
  ]);
}
