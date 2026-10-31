# Telegram Launchpad Bot

This is a starter Telegram bot for turning group coin ideas into moderated launch proposals for Solana launchpads such as Pump.fun / PumpPortal and Bonk-style pools.

It is built for legitimate community launches: proposal capture, admin review, dry-run previews, and explicit approval before any launch action. Do not use it for market manipulation, fake volume, coordinated dumping, or deceptive promotions.

## What It Does

- `/idea` collects a proposed coin name, ticker, description, links, and target launchpad.
- `/review` lets admins see pending proposals.
- `/approve <id>` marks a proposal as approved.
- `/reject <id> <reason>` rejects a proposal.
- `/launch <id>` launches only approved proposals.
- Admins can be either IDs listed in `.env` or Telegram admins of the group where the command is used.
- Dry-run mode is enabled by default so you can test safely in a group.

## Setup

1. Create a Telegram bot with BotFather and copy the token.
2. Copy `.env.example` to `.env`.
3. Fill `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_IDS`.
4. Install dependencies:

```bash
npm install
```

5. Run locally:

```bash
npm run dev
```

## If Commands Do Not Work In A Group

- Restart the bot after code changes with `npm run dev`.
- Make sure `.env` contains the current BotFather token. If you pasted a token anywhere public, revoke it in BotFather and use the new one.
- Add the bot to the group.
- For the wizard, reply to the bot's questions. Telegram privacy mode can block normal non-command group messages from reaching bots.
- Recommended: in BotFather, open `/mybots` -> your bot -> Bot Settings -> Group Privacy -> Turn off, especially if you want users to upload images or type wizard answers freely in the group.
- Use `/skip` for optional wizard fields and `/cancel` to cancel a draft.

## Example Commands

Wallets:

```text
/groupwallet
/groupbalance
/mywallet
/mybalance
```

`/groupwallet` creates one encrypted launch wallet for the Telegram group. `/mywallet` creates one encrypted personal wallet for the user. The bot shows deposit addresses and balances, never private keys.

Configured admins can export wallet private keys only in DM with the bot:

```text
/exportmywallet
/exportgroupwallet
```

Never run exports in a shared screen/session. Anyone with the private key can drain the wallet.

Wallet-funded launches:

```text
/launchgroup <proposal_id>
/launchme <proposal_id>
```

`/launchgroup` is admin-only and spends from the encrypted group wallet. `/launchme` spends from the caller's personal wallet and can be used by the proposal creator or configured admin.

Per-launch platform fee:

```env
PLATFORM_TREASURY_WALLET=your_treasury_wallet
PLATFORM_FEE_SOL=0.02
```

When enabled, the bot adds the platform fee to preflight balance checks and sends it to the treasury wallet only after a successful live launch. The fee is a separate transfer, so it does not make the Pump.fun create transaction larger. For Bonk, use group-wallet launch so the bot has a wallet available to pay the platform fee.

Production controls:

```env
MAX_DEV_BUY_SOL=0
GROUP_DAILY_LAUNCH_LIMIT=0
USER_DAILY_LAUNCH_LIMIT=0
RATE_LIMIT_WINDOW_MS=10000
RATE_LIMIT_MAX_UPDATES=12
LOG_DIR=./logs
HEALTHCHECK_PORT=3001
```

Every live launch now requires a final spend confirmation button. The bot writes admin actions, wallets, queued jobs, and launch attempts to Postgres, and writes searchable JSONL logs to `logs/app.jsonl` and `logs/error.jsonl`. Use `/status` for recent launch attempts and uptime.
Set `MAX_DEV_BUY_SOL`, `GROUP_DAILY_LAUNCH_LIMIT`, or `USER_DAILY_LAUNCH_LIMIT` to `0` to make that control unlimited. `DEFAULT_DEV_BUY_SOL` is only the default wizard value.

Launches confirmed through the bot are stored in a persistent Postgres `launch_jobs` queue. If the bot restarts before a queued job runs, it resumes from the database on startup. See `docs/production.md` for the deployment runbook.

AWS process example with PM2:

```bash
npm install
npm run build
npm install -g pm2
pm2 start dist/index.js --name voidlauncher
pm2 save
pm2 startup
pm2 logs voidlauncher
```

Server hygiene:

- Rotate any Telegram token, API key, or private key that was ever pasted into chat.
- Keep `.env`, `data/`, `logs/`, and wallet backups out of GitHub.
- Back up `WALLET_ENCRYPTION_KEY` and your Postgres database; losing the encryption key can make encrypted wallets unrecoverable.
- Use AWS security groups to allow SSH only from your IP. The bot uses Telegram polling, so it does not need public HTTP/HTTPS unless you expose `HEALTHCHECK_PORT`.
- Add log rotation on AWS, for example `pm2 install pm2-logrotate`.

Guided flow:

```text
/idea
```

The bot will ask for launchpad, name, ticker, description, optional links, image/logo, dev buy, then show a preview with submit/cancel buttons.
The image/logo step is required because launch metadata needs an image. Bags launches are available through Launch Group and require `BAGS_API_KEY`.

Fast image flow:

```text
/idea pumpfun Example Cat ECAT
```

The bot pre-fills launchpad, name, and ticker, then asks for the missing details. When it asks for an image, upload the image directly in Telegram or paste an image URL.

Bags fast start:

```text
/idea bags Example Bag EBAG
```

Current Bags SDK/API launches generate the mint internally, so `BAGS_MINT_SUFFIX` must stay empty until Bags supports caller-provided mints.

Power-user paste format:

```text
/idea pumpfun
Name: Example Cat
Symbol: ECAT
Description: Community meme coin for testing.
Website: https://example.com
Telegram: https://t.me/example
Twitter: https://x.com/example
Image: https://example.com/logo.png
DevBuySol: 0.01
```

```text
/review
/approve 1
/launch 1
```

## Launchpad Notes

PumpPortal documentation currently shows Pump.fun creation through IPFS metadata plus a create trade request to `https://pumpportal.fun/api/trade`, and it also documents Bonk token creation with `pool: "bonk"`. Pump.fun’s own UI notes that coin data is locked after creation, so treat metadata review as a hard approval step.

This starter keeps `DRY_RUN=true` by default. Before real launches, you should add:

- a dedicated hot wallet with limited funds,
- credential storage outside chat logs and source control,
- test launches with tiny amounts,
- explicit risk disclosures in the Telegram group,
- checks for trademark, impersonation, illegal content, and misleading claims.

## Security Rules

- Never paste wallet private keys or API keys into Telegram.
- Never commit `.env`.
- If `ALLOW_GROUP_ADMINS=true`, every Telegram admin in the group can approve and launch.
- Use a dedicated launch wallet/API key, not a treasury wallet.
- Keep launch amounts small until the whole flow is audited.
- Keep admins limited to trusted Telegram user IDs.

## Paid Custom CAs

People can pay to launch a Pump.fun or Bonk token whose CA starts or ends with text they choose. After the dev buy step, `/idea` offers **Starts with…**, **Ends with…** or **Normal CA (free)**, quotes the fee, and refuses text that would take longer than `CUSTOM_CA_MAX_WAIT_MINUTES` to find.

The search runs on your own machine, not on Render:

1. Set `CUSTOM_CA_FEES_SOL` (for example `3:0.05,4:0.1`), `GRINDER_API_TOKEN` (24+ random characters) and `PLATFORM_TREASURY_WALLET` on Render.
2. On the grinder PC, put the same `GRINDER_API_TOKEN` and `CUSTOM_CA_BOT_URL=https://<your-service>.onrender.com` in `.env`.
3. Run `npm run vanity:custom` and leave it running.

The grinder asks the bot for orders every 15 seconds over HTTPS. The bot answers from memory, so the database can still sleep. When an address is found, the bot checks it, encrypts its key with `WALLET_ENCRYPTION_KEY`, and posts "Custom CA ready" in the group. The address itself stays hidden until launch. The fee is sent to the treasury with the platform fee only after a successful launch. Rejecting a proposal cancels its order.

Each extra character makes the search about 58 times longer. On a 4-core PC (about 40,000 keys a second), 3 characters take seconds, 4 take about 4 minutes, and 5 take about 4 hours. Set `CUSTOM_CA_KEYS_PER_SECOND` to your machine's speed; the grinder prints its attempts every 5 seconds. Bags and Robinhood Chain choose their own addresses, so they can't offer custom CAs.

If Node can't reach the bot from a PC with antivirus TLS scanning, set `NODE_EXTRA_CA_CERTS` to the antivirus root certificate.

## Pump.fun CA Suffix

Pump.fun token addresses that end in `pump` are vanity mint addresses. They are not automatic when a normal random mint keypair is generated.

You can opt into Pump.fun mints ending in `pump`:

```env
PUMP_MINT_SUFFIX=pump
PUMP_MINT_POOL_SIZE=3
PUMP_MINT_WORKERS=4
```

Finding a 4-character suffix can take millions of attempts. Do not grind during launch. Instead, run the Rust worker ahead of time:

```bash
npm run vanity:worker
```

Keep that worker running until `/launchcheck` shows mints ready:

```text
Pump.fun mint suffix: pump
Pump.fun vanity mints ready: 3
```

When `PUMP_MINT_SUFFIX=pump`, `/launch` consumes one ready mint from the pool. If the pool is empty, launch fails fast instead of hanging. Keep `PUMP_MINT_SUFFIX=` empty for normal fast random mints.
