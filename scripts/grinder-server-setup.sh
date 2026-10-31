#!/usr/bin/env bash
# Server side of `npm run grinder:deploy`: installs or updates the custom CA grinder on Ubuntu/Debian
# and runs it as a systemd service. deploy-grinder.mjs streams this over SSH after a prelude that
# defines write_grinder_files and write_grinder_env, which unpack the uploaded files and settings.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! declare -F write_grinder_files >/dev/null; then
  echo "Run this through npm run grinder:deploy on your PC, not directly." >&2
  exit 1
fi

APP=${GRINDER_APP_DIR:-/opt/voidlauncher-grinder}
SERVICE=voidlauncher-grinder
RUN_USER=voidgrinder
export RUSTUP_HOME=/opt/rust/rustup
export CARGO_HOME=/opt/rust/cargo
export PATH="$CARGO_HOME/bin:$PATH"

step() { printf '\n==> %s\n' "$*"; }

if ! command -v apt-get >/dev/null; then
  echo "This setup supports Ubuntu and Debian servers (apt-get was not found)." >&2
  exit 1
fi

step "Installing build tools"
apt-get update -qq
apt-get install -y -qq curl ca-certificates build-essential >/dev/null

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 20 ]; then
  step "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  step "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path >/dev/null
fi

step "Copying the grinder to $APP"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
# Stop a running copy so it doesn't skew the speed test; it picks its order back up when restarted.
systemctl stop "$SERVICE" 2>/dev/null || true
mkdir -p "$APP/scripts" "$APP/rust/vanity-worker/src"
write_grinder_files "$APP"
cat > "$APP/package.json" <<'JSON'
{ "name": "voidlauncher-grinder", "private": true, "dependencies": { "dotenv": "^16.4.7" } }
JSON
(umask 077 && write_grinder_env "$APP/.env")
chown "$RUN_USER" "$APP/.env"

step "Installing Node packages"
(cd "$APP" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)

step "Building the Rust vanity worker (a minute or two)"
cargo build --release --locked --quiet --manifest-path "$APP/rust/vanity-worker/Cargo.toml"

step "Measuring speed for 15 seconds"
# A prefix that will never be found, so the worker just reports how many keys it tried every 5 seconds.
bench=$(cd "$APP" && VANITY_CUSTOM_ORDER=true VANITY_STDOUT_MODE=true VANITY_MINT_PREFIX=zzzzzzzzzz \
  PUMP_MINT_WORKERS="$(nproc)" timeout 16 ./rust/vanity-worker/target/release/vanity-worker || true)
keys_per_second=$(printf '%s\n' "$bench" | grep -o '(+[0-9]*)' | tr -d '(+)' | tail -n 2 |
  awk '{ sum += $1 } END { if (NR) print int(sum / (NR * 5)) }' || true)
echo "GRINDER_KEYS_PER_SECOND=${keys_per_second:-0} on $(nproc) cores"

step "Starting the grinder service"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=VoidLauncher custom CA grinder
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP
Environment=SKIP_VANITY_BUILD=true
ExecStart=$(command -v node) scripts/run-custom-ca-worker.mjs
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
sleep 8
journalctl -u "$SERVICE" -n 12 --no-pager --output=cat || true
