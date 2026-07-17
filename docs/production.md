# VoidLauncher Production Runbook

## What Is Production-Ready Now

- Launches are queued in `launch_jobs`, so a confirmed launch request survives a bot restart.
- A worker polls the database and resumes queued or stale running jobs.
- Each launch has a persistent `launch_attempts` record.
- Admin/security actions are written to `audit_logs`.
- Logs are written as JSONL in `logs/app.jsonl` and `logs/error.jsonl`.
- `/status` shows uptime, queue state, recent jobs, and recent attempts.
- `/launchcheck` shows operational limits and launch readiness.
- Postgres is the source of truth for wallets, proposals, audit records, jobs, and launch attempts.
- Queue workers atomically claim jobs with `FOR UPDATE SKIP LOCKED`.

## AWS Process

Use one bot process for now. Telegram long polling allows only one active instance per bot token.

```bash
npm install
npm run build
npm install -g pm2
pm2 start dist/index.js --name voidlauncher
pm2 save
pm2 startup
pm2 install pm2-logrotate
pm2 logs voidlauncher
```

Restart after deploy:

```bash
git pull
npm install
npm run build
pm2 restart voidlauncher
```

## Required Backups

Back up these together:

- `.env`
- your Postgres database
- `WALLET_ENCRYPTION_KEY`

If `WALLET_ENCRYPTION_KEY` is lost, encrypted launch wallets may be unrecoverable. Store it outside Render as well as in Render's secret environment variables.

## Secret Rotation Checklist

Rotate anything ever pasted into chat or screenshots:

- Telegram bot token in BotFather
- PumpPortal API key
- Pinata JWT
- Any wallet private key
- `WALLET_ENCRYPTION_KEY` only if you also rotate/recreate encrypted wallets

After rotation:

```bash
npm run build
pm2 restart voidlauncher
```

## Database

Set `DATABASE_URL` to a persistent Postgres connection string. The bot creates and upgrades its schema during startup. To copy a previous local SQLite database into Postgres, stop the bot and run `npm run db:migrate:sqlite` once with both `DATABASE_PATH` and `DATABASE_URL` configured.

Do not run multiple Telegram polling processes with the same token. If scaling horizontally, move Telegram to webhooks behind HTTPS and let only the queue workers scale separately.
