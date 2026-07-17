# Render Deploy

This blueprint deploys the bot as a Render Web Service and binds the health server to Render's `$PORT`.

## Important

The bot uses Postgres for proposals, encrypted wallet records, audits, vanity mints, and launch jobs. Render's ephemeral filesystem is used only for temporary logs. Never deploy without `DATABASE_URL` and never change `WALLET_ENCRYPTION_KEY` after wallets have been created.

## Deploy Steps

1. Push this repo to GitHub.
2. Open Render Dashboard.
3. Click **New +**.
4. Choose **Blueprint**.
5. Connect `juwonsmith/voidlauncher-bot`.
6. Select `render.yaml`.
7. Create a persistent Postgres database, then copy its pooled connection string.
8. Add the secret environment variables Render asks for:
   - `DATABASE_URL`
   - `TELEGRAM_BOT_TOKEN`
   - `ADMIN_TELEGRAM_IDS`
   - `WALLET_ENCRYPTION_KEY`
   - `PINATA_JWT`
   - `SOLANA_RPC_URL`
   - `PUMPFUN_SIGNER_PRIVATE_KEY`
   - `PUMPPORTAL_API_KEY`
   - `BAGS_API_KEY`
   - `PLATFORM_TREASURY_WALLET`
9. Keep `DRY_RUN=true` for the first deploy.
10. Deploy.
11. Confirm the logs show `database_connected` followed by `Telegram launchpad bot polling started.`
12. Set `DRY_RUN=false` only when the wallets and keys are ready.

## Migrate Existing SQLite Data

Keep the existing `data/bot.sqlite` and the same `WALLET_ENCRYPTION_KEY`. Put the new Postgres connection string in local `.env` as `DATABASE_URL`, stop every running bot instance, then run:

Before redeploying, use the existing bot's DM wallet-export commands for any funded wallet that exists only on Render. A Render redeploy discards its current ephemeral SQLite file, so do not assume that file will survive the switch.

```powershell
npm run db:migrate:sqlite
```

The migration is transactional and can be rerun. It preserves proposal IDs, encrypted wallet records, audits, launch attempts, queued jobs, and vanity mints. After it completes, add the same `DATABASE_URL` and `WALLET_ENCRYPTION_KEY` to Render and deploy.

## Avoid Telegram 409 Conflict

Only one copy of the bot can poll Telegram at once. Stop your local bot before Render starts:

```powershell
Get-Process node | Stop-Process
```

Or stop only the specific process running `dist/index.js`.
