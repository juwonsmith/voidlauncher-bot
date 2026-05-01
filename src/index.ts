import { Context, Telegraf } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import { ZodError } from "zod";
import { config, requireAdmin } from "./config.js";
import {
  approveProposal,
  countAvailableVanityMints,
  createProposal,
  getProposal,
  listPendingProposals,
  markLaunched,
  quarantineInexactVanityMints,
  rejectProposal,
  listWallets,
  updateProposalCashback,
  updateProposalFeeShares
} from "./db.js";
import { launchProposal } from "./launchpads/index.js";
import {
  launchWithPumpFunSdk,
  launchWithPumpPortalApiKey,
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
  getPumpPortalApiKey,
  getSolBalance,
  getWalletSecretBase58,
  getWalletSummary,
  getWalletView,
  type WalletView
} from "./wallets.js";

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
const drafts = new Map<string, Draft>();
const activeLaunches = new Set<string>();

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
  | "preview";

interface Draft {
  step: DraftStep;
  data: Partial<CoinIdeaInput>;
  promptMessageId?: number;
  customFeeWallet?: string;
  forcedStep?: DraftStep;
}

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? "unknown-chat";
  const fromId = ctx.from?.id ?? "unknown-user";
  const text = "message" in ctx.update && "text" in ctx.update.message ? ctx.update.message.text : ctx.updateType;
  console.log(`[update] chat=${chatId} from=${fromId} type=${ctx.updateType} text=${text}`);
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

  const wallet = getWalletSummary("group_portal", String(ctx.chat.id));
  if (!wallet) return ctx.reply("No group wallet yet. An admin can create one with /groupwallet.");

  try {
    await replyWallet(ctx, "Group Launch Wallet", await withBalance(wallet));
  } catch (error) {
    await replyWallet(ctx, "Group Launch Wallet", withBalanceError(wallet, error));
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

  const wallet = getWalletSummary("user", String(ctx.from.id));
  if (!wallet) return ctx.reply("No personal wallet yet. Create one with /mywallet.");

  try {
    await replyWallet(ctx, "Personal Launch Wallet", await withBalance(wallet));
  } catch (error) {
    await replyWallet(ctx, "Personal Launch Wallet", withBalanceError(wallet, error));
  }
});

bot.command("exportmywallet", async (ctx) => {
  if (ctx.chat?.type !== "private") return ctx.reply("Wallet export is only available in DM with the bot.");
  if (!requireAdmin(ctx.from?.id)) return ctx.reply("Configured admin only.");
  if (!ctx.from) return ctx.reply("I could not identify you.");

  try {
    const exported = exportWalletSecretBase58("user", String(ctx.from.id));
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
    const wallets = listWallets("group_portal");
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
    const exported = exportPumpPortalWallet("group", groupId);
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
  const wallet = listWallets("group_portal").find((item) => item.id === walletId);
  if (!wallet) {
    await safeAnswerCallback(ctx, "Wallet not found.");
    return;
  }

  const exported = exportPumpPortalWallet("group", wallet.scopeId);
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
    const proposal = createProposal(idea, from.id, from.username);

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

  const proposals = listPendingProposals();
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

  const proposal = getProposal(id);
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

  const proposal = getProposal(id);
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

  const proposal = getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);

  try {
    const signer =
      walletMode.toLowerCase() === "me"
        ? getWalletSecretBase58("user", String(ctx.from?.id))
        : getWalletSecretBase58("group", String(ctx.chat?.id));
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

  const pendingProposal = getProposal(id);
  if (!pendingProposal) return ctx.reply(`Proposal #${id} not found.`);
  if (!pendingProposal.image) {
    return ctx.reply(`Proposal #${id} has no image. Reject it or ask for a new proposal with an image.`);
  }

  const proposal = approveProposal(id, ctx.from.id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  if (proposal.status !== "approved") return ctx.reply(`Proposal #${id} is ${proposal.status}.`);

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

  const proposal = rejectProposal(id, reason);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);

  return ctx.reply(`❌ <b>Rejected proposal #${id}</b>\n${escapeHtml(reason)}`, telegramReplyOptions);
});

bot.command("launch", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /launch <proposal_id>");

  runLaunchInBackground(ctx, () => runApiLaunch(ctx, id));
});

bot.command("launchgroup", async (ctx) => {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("Use /launchgroup inside the Telegram group.");
  }
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /launchgroup <proposal_id>");

  runLaunchInBackground(ctx, () => runGroupLaunch(ctx, id));
});

bot.command("launchme", async (ctx) => {
  if (!ctx.from) return ctx.reply("I could not identify you.");

  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /launchme <proposal_id>");

  runLaunchInBackground(ctx, () => runPersonalLaunch(ctx, id));
});

bot.command("feesettings", async (ctx) => {
  const id = parseIdArg(ctx.message.text);
  if (!id) return ctx.reply("Usage: /feesettings <proposal_id>");
  const proposal = getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  return ctx.reply(feeSettingsMessage(proposal), telegramReplyOptions);
});

bot.command("cashback", async (ctx) => {
  const [, idText, value] = ctx.message.text.split(/\s+/, 3);
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0 || !value) return ctx.reply("Usage: /cashback <proposal_id> on|off");
  const proposal = getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  if (!(await canEditProposalSettings(ctx, proposal))) return ctx.reply("Only the proposal creator or an admin can edit this.");
  if (proposal.launchpad !== "pumpfun") return ctx.reply("Cashback only applies to Pump.fun proposals.");
  const enabled = parseOnOff(value);
  const updated = updateProposalCashback(id, enabled);
  return ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
});

bot.command("setfees", async (ctx) => {
  const [, idText, ...valueParts] = ctx.message.text.split(/\s+/);
  const id = Number(idText);
  const value = valueParts.join("").trim();
  if (!Number.isInteger(id) || id <= 0 || !value) {
    return ctx.reply("Usage: /setfees <proposal_id> none|creator|wallet:bps,wallet:bps");
  }
  const proposal = getProposal(id);
  if (!proposal) return ctx.reply(`Proposal #${id} not found.`);
  if (!(await canEditProposalSettings(ctx, proposal))) return ctx.reply("Only the proposal creator or an admin can edit this.");
  if (proposal.launchpad !== "pumpfun") return ctx.reply("Fee sharing only applies to Pump.fun proposals.");
  const feeShares = normalizeFeeShareSetting(value);
  const updated = updateProposalFeeShares(id, feeShares);
  return ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
});

bot.command("launchcheck", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");
  const groupWallet =
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? await getWalletView("group_portal", String(ctx.chat.id))
      : undefined;

  const lines = [
    "<b>Launch Readiness</b>",
    "",
    `Mode: <b>${config.DRY_RUN ? "DRY RUN" : "LIVE"}</b>`,
    `Pump.fun SDK signer: <b>${config.PUMPFUN_SIGNER_PRIVATE_KEY ? "SET" : "MISSING"}</b>`,
    `PumpPortal API key (Bonk): <b>${config.PUMPPORTAL_API_KEY ? "SET" : "MISSING"}</b>`,
    `Pinata JWT: <b>${config.PINATA_JWT ? "SET" : "MISSING"}</b>`,
    `Default dev buy: <b>${config.DEFAULT_DEV_BUY_SOL} SOL</b>`,
    `Slippage: <b>${config.DEFAULT_SLIPPAGE_PERCENT}%</b>`,
    `Priority fee: <b>${config.DEFAULT_PRIORITY_FEE_SOL} SOL</b>`,
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
      ? `Pump.fun vanity mints ready: <b>${countAvailableVanityMints(config.PUMP_MINT_SUFFIX).toLocaleString()}</b>`
      : undefined,
    config.BONK_MINT_SUFFIX
      ? `Bonk vanity mints ready: <b>${countAvailableVanityMints(config.BONK_MINT_SUFFIX).toLocaleString()}</b>`
      : undefined,
    `Bags launches: <b>disabled</b>`,
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup" ? "" : undefined,
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup"
      ? `<b>Group Wallet</b>: ${groupWallet ? `<code>${escapeHtml(groupWallet.address)}</code>` : "MISSING"}`
      : undefined,
    groupWallet?.balanceSol === undefined
      ? groupWallet
        ? `Group wallet balance: <b>unavailable</b>`
        : undefined
      : `Group wallet balance: <b>${groupWallet.balanceSol.toFixed(6)} SOL</b>`,
    "",
    config.DRY_RUN
      ? "Set <code>DRY_RUN=false</code> only after your API key/wallet is funded and tested."
      : "Live launches are enabled. Approved proposals can spend funds."
  ].filter(Boolean);

  return ctx.reply(lines.join("\n"), telegramReplyOptions);
});

bot.command("vanityclean", async (ctx) => {
  if (!(await isBotAdmin(ctx))) return ctx.reply("Admin command only.");
  if (!config.PUMP_MINT_SUFFIX) return ctx.reply("No PUMP_MINT_SUFFIX configured.");

  const count = quarantineInexactVanityMints(config.PUMP_MINT_SUFFIX);
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
  const pendingProposal = getProposal(id);
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
  await safeAnswerCallback(ctx, config.DRY_RUN ? "Starting dry run..." : "Starting API launch...");
  runLaunchInBackground(ctx, () => runApiLaunch(ctx, id));
});

bot.action(/^launch_group:(\d+)$/, async (ctx) => {
  if (!(await isBotAdmin(ctx))) {
    await safeAnswerCallback(ctx, "Admin command only.");
    return;
  }

  await safeAnswerCallback(ctx, "Starting group launch...");
  runLaunchInBackground(ctx, () => runGroupLaunch(ctx, Number(ctx.match[1])));
});

bot.action(/^launch_me:(\d+)$/, async (ctx) => {
  await safeAnswerCallback(ctx, "Starting personal launch...");
  runLaunchInBackground(ctx, () => runPersonalLaunch(ctx, Number(ctx.match[1])));
});

bot.action(/^cashback_toggle:(\d+)$/, async (ctx) => {
  const proposal = getProposal(Number(ctx.match[1]));
  if (!proposal) return safeAnswerCallback(ctx, "Proposal not found.");
  if (!(await canEditProposalSettings(ctx, proposal))) return safeAnswerCallback(ctx, "Creator or admin only.");
  const updated = updateProposalCashback(proposal.id, !proposal.pumpfunCashback);
  await safeAnswerCallback(ctx, updated?.pumpfunCashback ? "Cashback enabled." : "Cashback disabled.");
  await ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
});

bot.action(/^fees_menu:(\d+)$/, async (ctx) => {
  const proposal = getProposal(Number(ctx.match[1]));
  if (!proposal) return safeAnswerCallback(ctx, "Proposal not found.");
  if (!(await canEditProposalSettings(ctx, proposal))) return safeAnswerCallback(ctx, "Creator or admin only.");
  await safeAnswerCallback(ctx, "Fee settings.");
  await ctx.reply(feeSettingsMessage(proposal), {
    ...telegramReplyOptions,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "No Fee Sharing", callback_data: `fees_set:${proposal.id}:none` },
          { text: "Creator 100%", callback_data: `fees_set:${proposal.id}:creator` }
        ],
        [{ text: "Custom Split", switch_inline_query_current_chat: `/setfees ${proposal.id} ` }]
      ]
    }
  });
});

bot.action(/^fees_set:(\d+):(.+)$/, async (ctx) => {
  const proposal = getProposal(Number(ctx.match[1]));
  if (!proposal) return safeAnswerCallback(ctx, "Proposal not found.");
  if (!(await canEditProposalSettings(ctx, proposal))) return safeAnswerCallback(ctx, "Creator or admin only.");
  const updated = updateProposalFeeShares(proposal.id, normalizeFeeShareSetting(ctx.match[2]));
  await safeAnswerCallback(ctx, "Fee settings updated.");
  await ctx.reply(feeSettingsMessage(updated ?? proposal), telegramReplyOptions);
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
      if (launchpad !== "pumpfun" && launchpad !== "bonk") {
        throw new Error("Invalid launchpad. Bags launches are disabled for now.");
      }
      draft.data.launchpad = launchpad;
      await ctx.answerCbQuery(`Selected ${launchpad}.`);
      await advanceWizard(ctx, draft, true);
      return;
    }

    if (action.startsWith("devbuy:")) {
      draft.data.devBuySol = Number(action.split(":")[1]);
      await ctx.answerCbQuery("Dev buy set.");
      await advanceWizard(ctx, draft, true);
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
      const proposal = createProposal(idea, ctx.from.id, ctx.from.username);
      drafts.delete(key);
      await ctx.answerCbQuery("Submitted.");
      await ctx.editMessageText(proposalMessage(proposal, "Proposal Submitted"), {
        ...telegramReplyOptions,
        reply_markup: { inline_keyboard: proposalKeyboard(proposal) }
      });
      return;
    }

    await ctx.answerCbQuery("Unknown action.");
  } catch (error) {
    await ctx.answerCbQuery("Check the message.");
    await ctx.reply(formatError(error), telegramReplyOptions);
  }
});

bot.catch((error, ctx) => {
  console.error("Bot error", error);
  void ctx.reply("Something went wrong. Check the bot logs.");
});

async function runApiLaunch(ctx: Context, id: number): Promise<void> {
  const proposal = getProposal(id);
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

    const result = await launchProposal(proposal);
    if (!result.dryRun) markLaunched(id, result.signature);
    await safeDeleteMessage(ctx, progressMessage.message_id, "API launch progress");
    await replyLaunchResult(ctx, result);
  });
}

async function runGroupLaunch(ctx: Context, id: number): Promise<void> {
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    await ctx.reply("Use group-wallet launch inside the Telegram group.");
    return;
  }
  const chatId = ctx.chat.id;

  const proposal = getProposal(id);
  if (!proposal) return void (await ctx.reply(`Proposal #${id} not found.`));
  if (proposal.status !== "approved") {
    return void (await ctx.reply(`Proposal #${id} must be approved before group wallet launch. Current status: ${proposal.status}.`));
  }

  await withLaunchLock(ctx, `proposal:${id}`, async () => {
    const wallet = getPumpPortalApiKey("group", String(chatId));
    const exportedWallet = proposal.launchpad === "pumpfun" ? exportPumpPortalWallet("group", String(chatId)) : undefined;
    if (!config.DRY_RUN) {
      await assertGroupLaunchReady(proposal, String(chatId), wallet.address);
    }

    const progressMessage = await ctx.reply(
      config.DRY_RUN
        ? `&#129514; <b>Running dry group launch for #${id}...</b>`
        : `&#128640; <b>Starting group-wallet launch for #${id}...</b>\nThis can take a moment while metadata uploads.`,
      telegramReplyOptions
    );

    const result = config.DRY_RUN
      ? {
          launchpad: proposal.launchpad,
          dryRun: true,
          message: `Dry run only. Would launch ${proposal.name} ($${proposal.symbol}) from group wallet ${wallet.address}.`
        }
      : proposal.launchpad === "bags"
        ? (() => {
            throw new Error("Bags launches are disabled for this production release.");
          })()
        : proposal.launchpad === "bonk"
          ? await launchWithPumpPortalApiKey(proposal, wallet.apiKey)
          : await launchWithPumpFunSdk(proposal, exportedWallet?.secretKey ?? "", wallet.address);
    if (!result.dryRun) markLaunched(id, result.signature);
    await safeDeleteMessage(ctx, progressMessage.message_id, "group launch progress");
    await replyLaunchResult(ctx, result);
  });
}

async function runPersonalLaunch(ctx: Context, id: number): Promise<void> {
  if (!ctx.from) {
    await ctx.reply("I could not identify you.");
    return;
  }

  const proposal = getProposal(id);
  if (!proposal) return void (await ctx.reply(`Proposal #${id} not found.`));
  if (proposal.status === "launched" || proposal.status === "rejected") {
    return void (await ctx.reply(`Proposal #${id} is ${proposal.status}.`));
  }
  if (proposal.createdBy !== ctx.from.id && !(await isBotAdmin(ctx))) {
    return void (await ctx.reply("You can only personal-launch your own proposal."));
  }
  if (proposal.launchpad !== "pumpfun") {
    return void (await ctx.reply("Personal launch currently supports Pump.fun only. Use group/API launch for Bonk."));
  }

  await withLaunchLock(ctx, `personal:${ctx.from.id}:${id}`, async () => {
    const wallet = await getOrCreateWallet("user", String(ctx.from!.id));
    if (!config.DRY_RUN) {
      await assertPersonalLaunchReady(proposal, wallet.address);
    }

    const progressMessage = await ctx.reply(
      config.DRY_RUN
        ? `&#129514; <b>Running dry personal launch for #${id}...</b>`
        : `&#128640; <b>Starting personal-wallet launch for #${id}...</b>\nThis can take a moment while metadata uploads.`,
      telegramReplyOptions
    );

    const result = config.DRY_RUN
      ? {
          launchpad: proposal.launchpad,
          dryRun: true,
          message: `Dry run only. Would launch ${proposal.name} ($${proposal.symbol}) from personal wallet ${wallet.address}.`
        }
      : await launchWithPumpFunSdk(proposal, exportWalletSecretBase58("user", String(ctx.from!.id)).secretKey, wallet.address);

    if (!result.dryRun) markLaunched(id, result.signature);
    await safeDeleteMessage(ctx, progressMessage.message_id, "personal launch progress");
    await replyLaunchResult(ctx, result);
  });
}

async function assertGroupLaunchReady(proposal: Proposal, groupId: string, walletAddress: string): Promise<void> {
  const problems: string[] = [];
  const suffix = mintSuffixForLaunchpad(proposal.launchpad);
  const devBuySol = proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL;
  const priorityFeeSol = priorityFeeForLaunchpad(proposal.launchpad);
  const requiredSol = devBuySol + priorityFeeSol + config.LOCAL_LAUNCH_MIN_SOL_BUFFER;

  if (!proposal.image) problems.push("proposal has no image");
  if (proposal.launchpad === "bags") problems.push("Bags launches are disabled for this production release");
  if (proposal.launchpad === "pumpfun" && !config.PINATA_JWT) problems.push("PINATA_JWT is missing");
  if (suffix && countAvailableVanityMints(suffix) < 1) {
    problems.push(`no ${proposal.launchpad} vanity mints available for suffix "${suffix}"`);
  }

  if (proposal.launchpad === "bonk") {
    try {
      exportPumpPortalWallet("group", groupId);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "group wallet export failed");
    }
  }

  try {
    const balance = await getSolBalance(walletAddress);
    if (balance < requiredSol) {
      problems.push(
        `group wallet has ${balance.toFixed(6)} SOL; needs at least ${requiredSol.toFixed(6)} SOL for dev buy, fees, and rent`
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
  const suffix = mintSuffixForLaunchpad(proposal.launchpad);
  const devBuySol = proposal.devBuySol ?? config.DEFAULT_DEV_BUY_SOL;
  const priorityFeeSol = priorityFeeForLaunchpad(proposal.launchpad);
  const requiredSol = devBuySol + priorityFeeSol + config.LOCAL_LAUNCH_MIN_SOL_BUFFER;

  if (proposal.launchpad !== "pumpfun") problems.push("personal launch currently supports Pump.fun only");
  if (!proposal.image) problems.push("proposal has no image");
  if (!config.PINATA_JWT) problems.push("PINATA_JWT is missing");
  if (suffix && countAvailableVanityMints(suffix) < 1) {
    problems.push(`no ${proposal.launchpad} vanity mints available for suffix "${suffix}"`);
  }

  try {
    const balance = await getSolBalance(walletAddress);
    if (balance < requiredSol) {
      problems.push(
        `personal wallet has ${balance.toFixed(6)} SOL; needs at least ${requiredSol.toFixed(6)} SOL for dev buy, fees, and rent`
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

async function assertApiLaunchReady(proposal: Proposal): Promise<void> {
  const problems: string[] = [];
  const suffix = mintSuffixForLaunchpad(proposal.launchpad);

  if (proposal.launchpad === "bags") {
    problems.push("Bags launches must use Launch Group");
  }
  if (proposal.launchpad === "pumpfun" && !config.PUMPFUN_SIGNER_PRIVATE_KEY) {
    problems.push("PUMPFUN_SIGNER_PRIVATE_KEY is missing");
  }
  if (proposal.launchpad === "bonk" && !config.PUMPPORTAL_API_KEY) problems.push("PUMPPORTAL_API_KEY is missing");
  if (proposal.launchpad === "pumpfun" && !config.PINATA_JWT) problems.push("PINATA_JWT is missing");
  if (!proposal.image) problems.push("proposal has no image");
  if (suffix && countAvailableVanityMints(suffix) < 1) {
    problems.push(`no ${proposal.launchpad} vanity mints available for suffix "${suffix}"`);
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

function mintSuffixForLaunchpad(launchpad: Launchpad): string {
  if (launchpad === "pumpfun") return config.PUMP_MINT_SUFFIX;
  if (launchpad === "bonk") return config.BONK_MINT_SUFFIX;
  return "";
}

function priorityFeeForLaunchpad(launchpad: Launchpad): number {
  if (launchpad === "bonk") return Math.max(config.DEFAULT_PRIORITY_FEE_SOL, 0.0005);
  return config.DEFAULT_PRIORITY_FEE_SOL;
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
    const [, bpsText] = part.split(":");
    const bps = Number(bpsText);
    if (!Number.isInteger(bps) || bps <= 0) throw new Error("Custom fees must be wallet:bps pairs.");
    return sum + bps;
  }, 0);
  if (total !== 10000) throw new Error(`Fee share bps must total 10000. Current total: ${total}.`);
  return normalized;
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
    `Cashback: <b>${proposal.pumpfunCashback ? "Enabled" : "Off"}</b>`,
    `Fee sharing: <b>${escapeHtml(fees)}</b>`,
    "",
    "<b>Commands</b>",
    `<code>/cashback ${proposal.id} on</code> or <code>/cashback ${proposal.id} off</code>`,
    `<code>/setfees ${proposal.id} none</code>`,
    `<code>/setfees ${proposal.id} creator</code>`,
    `<code>/setfees ${proposal.id} WALLET1:8000,WALLET2:2000</code>`,
    "",
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
    console.error("Background launch failed", error);
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
  const pendingProposal = getProposal(id);
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

  const proposal = approveProposal(id, adminId);
  if (!proposal) {
    await ctx.reply(`Proposal #${id} not found.`);
    return;
  }

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

  if (rawLaunchpad === "pumpfun" || rawLaunchpad === "bonk") {
    data.launchpad = rawLaunchpad;
  } else if (rawLaunchpad === "bags") {
    throw new Error("Bags launches are disabled for now. Use /idea pumpfun or /idea bonk.");
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
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Send a valid SOL amount, like 0.01.");
    draft.data.devBuySol = amount;
  } else if (draft.step === "feeShares") {
    draft.data.pumpfunFeeShares = normalizeFeeShareSetting(value);
  } else if (draft.step === "feeShareWallet") {
    assertSolanaAddress(value, "fee recipient wallet");
    draft.customFeeWallet = value.trim();
  } else if (draft.step === "feeSharePercent") {
    const percent = Number(value.replace("%", ""));
    draft.data.pumpfunFeeShares = feeSplitFromPercent(draft.customFeeWallet, percent);
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

  const question = wizardQuestion(draft.step);
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
  if (draft.step === "devBuy") return draft.data.launchpad === "pumpfun" ? "cashback" : "preview";
  if (draft.step === "cashback") return "feeShares";
  if (draft.step === "feeShares") return "preview";
  if (draft.step === "feeShareWallet") return "feeSharePercent";
  if (draft.step === "feeSharePercent") return "preview";
  return draft.step;
}

function wizardQuestion(step: DraftStep): {
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
    devBuy: "Choose the dev buy amount, send a custom SOL amount, or use default.",
    cashback: "Pump.fun cashback uses the V2 create flow. Enable it only if you want cashback on this launch.",
    feeShares:
      "Choose Pump.fun creator-fee sharing. This can lock reward distribution once configured.",
    feeShareWallet: "Send the wallet that should receive part of the creator fees.",
    feeSharePercent: "Choose what percent this wallet should receive. The remaining percent goes to the creator/dev wallet."
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
        { text: "0.01 SOL", callback_data: "wizard:devbuy:0.01" },
        { text: "0.05 SOL", callback_data: "wizard:devbuy:0.05" },
        { text: "Default", callback_data: "wizard:skip:devBuy" }
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
    ]
  };

  return {
    text: wizardQuestionMessage(`Step: ${step}`, questions[step]),
    keyboard: keyboards[step],
    forceReply:
      step === "name" ||
      step === "symbol" ||
      step === "description" ||
      step === "feeShares" ||
      step === "feeShareWallet" ||
      step === "feeSharePercent"
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
  if (!("message" in ctx.update)) return false;
  const message = ctx.update.message as { reply_to_message?: { message_id?: number } };
  const replyTo = message.reply_to_message;
  return Boolean(draft.promptMessageId && replyTo?.message_id === draft.promptMessageId);
}

function walletMessage(title: string, wallet: WalletView): string {
  return [
    `<b>${escapeHtml(title)}</b>`,
    "",
    wallet.created ? "Created a new wallet." : undefined,
    `Provider: <b>${wallet.provider === "pumpportal" ? "PumpPortal" : "Local"}</b>`,
    wallet.hasApiKey ? "API key: <b>encrypted</b>" : undefined,
    `Address: <code>${escapeHtml(wallet.address)}</code>`,
    wallet.balanceSol === undefined
      ? wallet.balanceError
        ? `Balance: unavailable right now (${escapeHtml(wallet.balanceError)})`
        : `Balance: use <code>/groupbalance</code> to refresh`
      : `Balance: <b>${wallet.balanceSol.toFixed(6)} SOL</b>`,
    "",
    "Deposit SOL to this address. The private key is encrypted and never shown in Telegram."
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

function withBalanceError(wallet: WalletView, error: unknown): WalletView {
  return {
    ...wallet,
    balanceSol: undefined,
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
  return step === "website" || step === "telegram" || step === "twitter" || step === "devBuy";
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
    console.error("Failed to check group admin status", error);
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

console.log("Starting Telegram launchpad bot...");
void launchBotWithRetry();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

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
      console.error(`Telegram polling failed on startup attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`Retrying in ${Math.round(delayMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}

async function setupBotCommands(): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: "idea", description: "Open the coin idea wizard" },
    { command: "commands", description: "Show bot commands" },
    { command: "review", description: "Review pending launch ideas" },
    { command: "groupwallet", description: "Create/show the group launch wallet" },
    { command: "groupbalance", description: "Check the group launch wallet balance" },
    { command: "mywallet", description: "Create/show your personal launch wallet" },
    { command: "mybalance", description: "Check your personal wallet balance" },
    { command: "launchme", description: "Launch your own Pump.fun proposal" },
    { command: "feesettings", description: "Show proposal fee settings" },
    { command: "cashback", description: "Set Pump.fun cashback on/off" },
    { command: "setfees", description: "Set Pump.fun fee sharing" },
    { command: "exportgroupwallet", description: "DM admin: export a group wallet" },
    { command: "exportmywallet", description: "DM admin: export your personal wallet" },
    { command: "launchcheck", description: "Check launch readiness" },
    { command: "proposal", description: "Show a proposal by ID" },
    { command: "imagetest", description: "Validate a proposal image" },
    { command: "txcheck", description: "Check a launch transaction/CA" },
    { command: "help", description: "Show bot help and launchpad links" }
  ]);
}
