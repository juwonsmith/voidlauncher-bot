# Render Deploy

This blueprint deploys the bot as a Render Web Service and binds the health server to Render's `$PORT`.

## Important

Render Free Web Services have an ephemeral filesystem. The local SQLite database and generated wallets can be lost on restart, redeploy, or spin-down. Use this for testing only unless you move storage to Postgres or upgrade to a paid service with a persistent disk.

## Deploy Steps

1. Push this repo to GitHub.
2. Open Render Dashboard.
3. Click **New +**.
4. Choose **Blueprint**.
5. Connect `juwonsmith/voidlauncher-bot`.
6. Select `render.yaml`.
7. Add the secret environment variables Render asks for:
   - `TELEGRAM_BOT_TOKEN`
   - `ADMIN_TELEGRAM_IDS`
   - `WALLET_ENCRYPTION_KEY`
   - `PINATA_JWT`
   - `SOLANA_RPC_URL`
   - `PUMPFUN_SIGNER_PRIVATE_KEY`
   - `PUMPPORTAL_API_KEY`
   - `BAGS_API_KEY`
   - `PLATFORM_TREASURY_WALLET`
8. Keep `DRY_RUN=true` for the first deploy.
9. Deploy.
10. After logs show `Telegram launchpad bot polling started.`, set `DRY_RUN=false` only when the wallets and keys are ready.

## Avoid Telegram 409 Conflict

Only one copy of the bot can poll Telegram at once. Stop your local bot before Render starts:

```powershell
Get-Process node | Stop-Process
```

Or stop only the specific process running `dist/index.js`.
