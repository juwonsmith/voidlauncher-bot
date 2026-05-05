# VoidLauncher Production Runbook

## What Is Production-Ready Now

- Launches are queued in `launch_jobs`, so a confirmed launch request survives a bot restart.
- A worker polls the database and resumes queued or stale running jobs.
- Each launch has a persistent `launch_attempts` record.
- Admin/security actions are written to `audit_logs`.
- Logs are written as JSONL in `logs/app.jsonl` and `logs/error.jsonl`.
- `/status` shows uptime, queue state, recent jobs, and recent attempts.
- `/launchcheck` shows operational limits and launch readiness.

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
- `data/bot.sqlite`
- `data/wallet.key` if the bot generated one

If `WALLET_ENCRYPTION_KEY` or `data/wallet.key` is lost, encrypted launch wallets may be unrecoverable.

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

## Database Scale Path

Current production beta uses SQLite with WAL mode. That is fine for one AWS instance and one bot process.

Move to Postgres when you need:

- multiple bot/worker instances,
- hosted backups and point-in-time recovery,
- analytics across many groups,
- higher write concurrency,
- read replicas or external dashboards.

Migration approach:

1. Keep SQLite as the source of truth until traffic is stable.
2. Create Postgres tables matching `proposals`, `wallets`, `vanity_mints`, `audit_logs`, `launch_attempts`, and `launch_jobs`.
3. Move DB functions in `src/db.ts` behind a repository interface.
4. Add a Postgres implementation using transactions with `FOR UPDATE SKIP LOCKED` for `claimNextLaunchJob`.
5. Run one queue worker first, then scale workers only after idempotency and monitoring are proven.

Do not run multiple Telegram polling processes with the same token. If scaling horizontally, move Telegram to webhooks behind HTTPS and let only the queue workers scale separately.
