import type { InlineKeyboardButton } from "telegraf/types";
import { config } from "./config.js";
import type { CoinIdeaInput, LaunchResult, Proposal } from "./types.js";

export const telegramReplyOptions = {
  parse_mode: "HTML" as const,
  link_preview_options: { is_disabled: true }
};

export function helpMessage(): string {
  return [
    "<b>VoidLauncher</b>",
    "",
    "&#128640; <b>Drop a coin idea</b>",
    "Use <code>/idea</code> for the guided wizard, then launch with buttons.",
    "",
    "<b>Fast start</b>",
    "<code>/idea pumpfun Example Cat ECAT</code>",
    "<code>/idea bonk Example Dog EDOG</code>",
    "<code>/idea bags Example Bag EBAG</code>",
    "",
    "<b>Power template</b>",
    "<pre>/idea pumpfun",
    "Name: Example Cat",
    "Symbol: ECAT",
    "Description: Community meme coin for testing.",
    "Website: https://example.com",
    "Telegram: https://t.me/example",
    "Twitter: https://x.com/example",
    "Image: https://example.com/logo.png",
    "DevBuySol: 0.01</pre>",
    "",
    "&#9989; Ideas go to admin review before launch.",
    "&#128188; Group wallet launches use the group launch wallet.",
    "&#127890; Bags launches use the group launch wallet."
  ].join("\n");
}

export function helpKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: "Pump.fun", url: "https://pump.fun" },
      { text: "Bonk", url: "https://letsbonk.fun" }
    ]
  ];
}

export function proposalMessage(proposal: Proposal, heading = "New Coin Idea"): string {
  const links = proposalLinks(proposal);
  const submittedBy = proposal.createdByUsername
    ? `@${escapeHtml(proposal.createdByUsername)}`
    : `<code>${proposal.createdBy}</code>`;

  return [
    `&#128138; <b>${escapeHtml(heading)} #${proposal.id}</b>`,
    "",
    `&#128313; <b>${escapeHtml(proposal.name)}</b> | <code>$${escapeHtml(proposal.symbol)}</code>`,
    `&#128640; Launchpad: <b>${launchpadName(proposal.launchpad)}</b>`,
    `&#128205; Status: <b>${statusLabel(proposal.status)}</b>`,
    `&#128176; Dev Buy: <b>${proposal.devBuySol ?? "default"} SOL</b>`,
    proposal.launchpad === "pumpfun"
      ? `&#127873; Cashback: <b>${proposal.pumpfunCashback ? "Enabled" : "Off"}</b>`
      : undefined,
    proposal.launchpad === "pumpfun"
      ? `&#129309; Fee Share: <b>${feeShareLabel(proposal.pumpfunFeeShares)}</b>`
      : undefined,
    "",
    
    `&#128221; ${escapeHtml(proposal.description)}`,
    links.length > 0 ? `Links: ${links.join(" | ")}` : undefined,
    "",
    `&#128100; Submitted by ${submittedBy}`
  ]
    .filter(Boolean)
    .join("\n");
}

export function proposalKeyboard(proposal: Proposal): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  const linkButtons: InlineKeyboardButton[] = [];

  if (proposal.website) linkButtons.push({ text: "Website", url: proposal.website });
  if (proposal.telegram) linkButtons.push({ text: "Telegram", url: proposal.telegram });
  if (proposal.twitter) linkButtons.push({ text: "Twitter/X", url: proposal.twitter });
  if (proposal.image && isPublicDisplayUrl(proposal.image)) {
    linkButtons.push({ text: "Image", url: proposal.image });
  }

  for (let index = 0; index < linkButtons.length; index += 2) {
    rows.push(linkButtons.slice(index, index + 2));
  }

  if (proposal.status === "pending") {
    rows.push([{ text: "Approve", callback_data: `approve:${proposal.id}` }]);
  }

  if (proposal.status === "approved") {
    if (proposal.launchpad === "bags") {
      rows.push([{ text: "Launch Group", callback_data: `launch_group:${proposal.id}` }]);
    } else {
      rows.push([
        { text: "Launch Group", callback_data: `launch_group:${proposal.id}` },
        { text: "Launch Me", callback_data: `launch_me:${proposal.id}` },
        { text: "Launch API", callback_data: `launch:${proposal.id}` }
      ]);
    }
  }

  if (proposal.launchpad === "pumpfun" && proposal.status !== "launched" && proposal.status !== "rejected") {
    rows.push([
      { text: proposal.pumpfunCashback ? "Cashback: On" : "Cashback: Off", callback_data: `cashback_toggle:${proposal.id}` },
      { text: "Fees", callback_data: `fees_menu:${proposal.id}` }
    ]);
  }

  if (proposal.status === "pending" || proposal.status === "approved") {
    rows.push([{ text: "Reject", callback_data: `reject_prompt:${proposal.id}` }]);
  }

  return rows;
}

export function commandHelpMessage(): string {
  return [
    "<b>Commands</b>",
    "",
    "<b>Everyone</b>",
    "<code>/idea</code> - open the guided coin idea wizard",
    "<code>/proposal &lt;id&gt;</code> - view a proposal",
    "<code>/help</code> - show instructions",
    "",
    "<b>Admins</b>",
    "<code>/review</code> - show pending ideas",
    "<code>/approve &lt;id&gt;</code> - approve an idea",
    "<code>/reject &lt;id&gt; reason</code> - reject an idea",
    "<code>/launchgroup &lt;id&gt;</code> - launch with the group wallet",
    "<code>/launchme &lt;id&gt;</code> - launch your own Pump.fun proposal with your personal wallet",
    "<code>/cashback &lt;id&gt; on|off</code> - set Pump.fun cashback before launch",
    "<code>/setfees &lt;id&gt; none|creator|wallet:bps,...</code> - set Pump.fun fee sharing before launch",
    "<code>/feesettings &lt;id&gt;</code> - show Pump.fun fee settings",
    "<code>/launchcheck</code> - check production readiness",
    "<code>/status</code> - uptime, active launches, recent launch attempts",
    "<code>/groupwallet</code> - create/show group wallet",
    "<code>/groupbalance</code> - check group wallet balance",
    "<code>/mywallet</code> - create/show your personal launch wallet",
    "<code>/mybalance</code> - check your personal wallet balance",
    "<code>/txcheck &lt;signature&gt; [ca]</code> - inspect a launch transaction",
    "",
    "<b>Admin DM Only</b>",
    "<code>/exportgroupwallet</code> - choose and export a group wallet",
    "<code>/exportgroupwallet &lt;group_id&gt;</code> - export a specific group wallet",
    "<code>/exportmywallet</code> - export your personal wallet",
    "",
    "Supported launchpads: <b>Pump.fun</b>, <b>Bonk</b>, and <b>Bags</b>."
  ].join("\n");
}

export function launchMessage(result: LaunchResult): string {
  const links = result.mint ? launchLinks(result.mint, result.launchpad) : [];

  return [
    result.dryRun ? `&#129514; <b>${escapeHtml(result.message)}</b>` : `&#128640; ${escapeHtml(result.message)}`,
    result.feeSharingUrl ? `&#129309; Fee Share: <a href="${escapeAttr(result.feeSharingUrl)}">Locked</a>` : undefined,
    result.feeSharingError ? `&#9888; Fee Share: ${escapeHtml(result.feeSharingError)}` : undefined,
    result.platformFeeUrl ? `&#128188; Platform Fee: <a href="${escapeAttr(result.platformFeeUrl)}">Paid</a>` : undefined,
    result.platformFeeError ? `&#9888; Platform Fee: ${escapeHtml(result.platformFeeError)}` : undefined,
    result.mint ? `&#129689; CA: <code>${escapeHtml(result.mint)}</code>` : undefined,
    result.explorerUrl ? `&#128269; Solscan: <a href="${escapeAttr(result.explorerUrl)}">Solscan</a>` : undefined,
    links.length > 0 ? `&#128279; Links: ${links.join(" | ")}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function launchKeyboard(result: LaunchResult): InlineKeyboardButton[][] | undefined {
  if (!result.mint) return undefined;
  const rows: InlineKeyboardButton[][] = [[copyButton("Copy CA", result.mint)]];
  if (result.explorerUrl) rows[0].push({ text: "Solscan", url: result.explorerUrl });
  return rows;
}

export function errorMessage(message: string, includeHelp = false): string {
  return ["&#9888; <b>Could not process that</b>", "", escapeHtml(message), includeHelp ? `\n${helpMessage()}` : undefined]
    .filter(Boolean)
    .join("\n");
}

export function wizardQuestionMessage(title: string, body: string): string {
  return [`<b>${escapeHtml(title)}</b>`, "", body].join("\n");
}

export function wizardPreviewMessage(idea: CoinIdeaInput): string {
  const preview: Proposal = {
    ...idea,
    id: 0,
    status: "pending",
    createdBy: 0,
    createdAt: new Date().toISOString()
  };

  return proposalMessage(preview, "Preview");
}

export function wizardPreviewKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: "Submit for Review", callback_data: "wizard:submit" },
      { text: "Cancel", callback_data: "wizard:cancel" }
    ]
  ];
}

function proposalLinks(proposal: Proposal): string[] {
  const links: string[] = [];
  if (proposal.website) links.push(`<a href="${escapeAttr(proposal.website)}">WEB</a>`);
  if (proposal.telegram) links.push(`<a href="${escapeAttr(proposal.telegram)}">TG</a>`);
  if (proposal.twitter) links.push(`<a href="${escapeAttr(proposal.twitter)}">X</a>`);
  if (proposal.image && isPublicDisplayUrl(proposal.image)) {
    links.push(`<a href="${escapeAttr(proposal.image)}">IMG</a>`);
  }
  return links;
}

function isPublicDisplayUrl(value: string): boolean {
  return !value.startsWith("telegram:") && !value.includes("api.telegram.org/file/bot");
}

function launchLinks(mint: string, launchpad: Proposal["launchpad"]): string[] {
  const encodedMint = encodeURIComponent(mint);
  const links = [];

  if (launchpad === "pumpfun") {
    links.push(`<a href="https://pump.fun/${encodedMint}">Pump.fun</a>`);
  } else if (launchpad === "bonk") {
    links.push(`<a href="https://letsbonk.fun/token/${encodedMint}">Bonk</a>`);
  } else if (launchpad === "bags") {
    links.push(`<a href="https://bags.fm/token/${encodedMint}">Bags</a>`);
  }

  links.push(`<a href="${escapeAttr(applyMintTemplate(config.AXIOM_LINK_TEMPLATE, mint))}">Axiom</a>`);
  links.push(`<a href="${escapeAttr(trojanLink(mint))}">Trojan</a>`);
  links.push(`<a href="https://gmgn.ai/sol/token/${encodedMint}">GMGN</a>`);
  links.push(`<a href="${escapeAttr(applyMintTemplate(config.BASED_LINK_TEMPLATE, mint))}">BSD</a>`);

  return links;
}

function applyMintTemplate(template: string, mint: string): string {
  return template
    .replaceAll("{mint}", encodeURIComponent(mint))
    .replaceAll("{ref}", encodeURIComponent(config.TROJAN_REF_CODE ?? ""));
}

function trojanLink(mint: string): string {
  if (config.TROJAN_REF_CODE) {
    return applyMintTemplate(config.TROJAN_LINK_TEMPLATE, mint);
  }

  return `https://t.me/solana_trojanbot?start=${encodeURIComponent(mint)}`;
}

export function copyButton(text: string, value: string): InlineKeyboardButton {
  return { text, copy_text: { text: value } } as unknown as InlineKeyboardButton;
}

function launchpadName(launchpad: Proposal["launchpad"]): string {
  if (launchpad === "bonk") return "Bonk";
  if (launchpad === "bags") return "BagsApp";
  return "Pump.fun";
}

function feeShareLabel(value: string | undefined): string {
  if (!value) return "None";
  const parts = value.split(",").map((part) => {
    const [wallet, bpsText] = part.split(":");
    const bps = Number(bpsText);
    if (!wallet || !Number.isFinite(bps)) return escapeHtml(part);

    const percent = bps / 100;
    const percentText = Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`;
    if (wallet.toLowerCase() === "creator") return `Creator ${percentText}`;
    return `${shortAddress(wallet)} ${percentText}`;
  });

  return parts.join(" / ");
}

function shortAddress(value: string): string {
  if (value.length <= 12) return escapeHtml(value);
  return `<code>${escapeHtml(value.slice(0, 4))}...${escapeHtml(value.slice(-4))}</code>`;
}

function statusLabel(status: Proposal["status"]): string {
  const labels: Record<Proposal["status"], string> = {
    pending: "Pending Review",
    approved: "Approved",
    rejected: "Rejected",
    launched: "Launched"
  };
  return labels[status];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
