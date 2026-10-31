// Installs or updates the custom CA grinder on an Ubuntu/Debian server, in one command from this folder:
//   npm run grinder:deploy -- root@SERVER_IP
// Over a single SSH session it sends only the grinder (the Rust worker and run-custom-ca-worker.mjs) and two
// settings from .env, GRINDER_API_TOKEN and CUSTOM_CA_BOT_URL, then builds it and runs it as a systemd service
// that restarts after crashes and reboots. The server never sees the bot token, database URL or wallet key.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRINDER_FILES = [
  "scripts/run-custom-ca-worker.mjs",
  "rust/vanity-worker/Cargo.toml",
  "rust/vanity-worker/Cargo.lock",
  "rust/vanity-worker/src/main.rs"
];
const SERVICE = "voidlauncher-grinder";
// Runs the streamed script as root, or through passwordless sudo for users like "ubuntu".
const REMOTE_COMMAND = "[ $(id -u) -eq 0 ] && exec bash -s || exec sudo -n bash -s";

/** The bash program streamed to the server: file and settings unpackers, then grinder-server-setup.sh. */
export function buildServerScript({ token, botUrl }) {
  const lines = ["write_grinder_files() {"];
  for (const file of GRINDER_FILES) {
    lines.push(`  base64 -d > "$1/${file}" <<'GRINDER_PAYLOAD'`, ...base64Lines(fs.readFileSync(path.join(projectDir, file))));
    lines.push("GRINDER_PAYLOAD");
  }
  lines.push("}", "write_grinder_env() {", `  base64 -d > "$1" <<'GRINDER_PAYLOAD'`);
  lines.push(...base64Lines(Buffer.from(`GRINDER_API_TOKEN=${token}\nCUSTOM_CA_BOT_URL=${botUrl}\n`)), "GRINDER_PAYLOAD", "}");

  const setup = fs.readFileSync(path.join(projectDir, "scripts", "grinder-server-setup.sh"), "utf8").replace(/\r\n/g, "\n");
  return `${lines.join("\n")}\n${setup}`;
}

async function main() {
  const args = process.argv.slice(2);
  const skipCheck = args.includes("--skip-check");
  const [target, ...sshArgs] = args.filter((arg) => arg !== "--skip-check");
  if (!target || target.startsWith("-")) {
    fail("Usage: npm run grinder:deploy -- root@SERVER_IP [ssh options such as -i key.pem or -p 2222] [--skip-check]");
  }

  const env = dotenv.parse(fs.readFileSync(path.join(projectDir, ".env")));
  const token = (env.GRINDER_API_TOKEN ?? "").trim();
  const botUrl = (env.CUSTOM_CA_BOT_URL ?? "").trim().replace(/\/+$/, "");
  if (token.length < 24) fail("GRINDER_API_TOKEN in .env must be at least 24 characters.");
  if (!/^https:\/\/[^/\s]+$/.test(botUrl)) {
    fail("Set CUSTOM_CA_BOT_URL in .env to your bot's Render URL, like https://your-service.onrender.com");
  }
  if (!skipCheck) await checkBot(botUrl, token);

  console.log(`\nConnecting to ${target}. Setup takes about 5 minutes on a new server.`);
  const ssh = spawn("ssh", ["-o", "StrictHostKeyChecking=accept-new", ...sshArgs, target, REMOTE_COMMAND], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  let output = "";
  ssh.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  ssh.on("error", (error) => fail(`Could not run ssh (${error.message}). Install the OpenSSH client and try again.`));
  // If ssh exits before reading the script (bad host, refused login), its exit code below explains why.
  ssh.stdin.on("error", () => undefined);
  ssh.stdin.end(buildServerScript({ token, botUrl }));

  const code = await new Promise((resolve) => ssh.on("close", resolve));
  if (code !== 0) {
    fail(`\nSetup stopped with exit code ${code}. Fix the error above and run the same command again; it is safe to repeat.`);
  }

  const speed = Number(output.match(/GRINDER_KEYS_PER_SECOND=(\d+)/)?.[1] ?? 0);
  console.log(`\nDone. The grinder is running on ${target} and restarts on its own after crashes and reboots.`);
  if (speed > 0) {
    console.log(`Measured speed: ${speed.toLocaleString()} keys/s. On Render, set CUSTOM_CA_KEYS_PER_SECOND=${speed}`);
    console.log("so the wait times the bot shows match this server.");
  }
  console.log(`Watch it:  ssh ${target} journalctl -u ${SERVICE} -f`);
  console.log("Update it: run this same command again after pulling new code.");
}

async function checkBot(botUrl, token) {
  let response;
  try {
    response = await fetch(`${botUrl}/grinder/orders`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (error) {
    const reason = error?.cause?.code ?? error?.message ?? String(error);
    console.warn(`Could not reach ${botUrl} from this PC (${reason}). Continuing; the server will connect on its own.`);
    console.warn("Antivirus HTTPS scanning on this PC can cause this.");
    return;
  }

  if (response.ok) {
    const body = await response.json().catch(() => ({}));
    console.log(`The bot accepted GRINDER_API_TOKEN (${body.orders?.length ?? 0} custom CA orders waiting).`);
    return;
  }
  if (response.status === 401) {
    fail("The bot rejected GRINDER_API_TOKEN: the value on Render doesn't match your .env. Copy it again, wait for the redeploy, then rerun.");
  }
  fail(
    `${botUrl}/grinder/orders returned ${response.status}. Check that CUSTOM_CA_BOT_URL is your bot's Render URL, ` +
      "that GRINDER_API_TOKEN is set on Render, and that its redeploy has finished. Add --skip-check to deploy anyway."
  );
}

function base64Lines(buffer) {
  return buffer.toString("base64").match(/.{1,76}/g) ?? [];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) await main();
