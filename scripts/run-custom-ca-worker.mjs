// Grinds custom CA orders for the bot: fetches pending orders from the bot's /grinder API,
// runs the Rust vanity worker until it finds a matching address, and posts the keypair back.
// It only talks to the bot over HTTPS, never to the database, so the database can sleep while it waits.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ override: true });

const botUrl = (process.env.CUSTOM_CA_BOT_URL ?? "").replace(/\/+$/, "");
const token = process.env.GRINDER_API_TOKEN ?? "";
const pollMs = positiveNumber(process.env.CUSTOM_CA_POLL_SECONDS, 15) * 1000;
const workers = positiveNumber(process.env.CUSTOM_CA_WORKERS, os.availableParallelism());
const orderCheckMs = 30_000;
const binaryPath = path.join(
  "rust",
  "vanity-worker",
  "target",
  "release",
  process.platform === "win32" ? "vanity-worker.exe" : "vanity-worker"
);

let child;
let stopping = false;

if (!botUrl || !token) {
  console.error("Set CUSTOM_CA_BOT_URL (the bot's public Render URL) and GRINDER_API_TOKEN in .env.");
  process.exit(1);
}

process.once("SIGINT", () => stop(130));
process.once("SIGTERM", () => stop(143));

if (process.env.SKIP_VANITY_BUILD === "true") {
  void main().catch(fail);
} else {
  const build = spawn("cargo", ["build", "--release", "--manifest-path", "rust/vanity-worker/Cargo.toml"], {
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  build.on("exit", (code) => {
    if (code !== 0) process.exit(code ?? 1);
    void main().catch(fail);
  });
}

async function main() {
  console.log(`Custom CA grinder: checking ${botUrl} every ${pollMs / 1000}s, ${workers} worker threads.`);
  while (!stopping) {
    let orders;
    try {
      orders = await fetchOrders();
    } catch (error) {
      console.error(`Could not fetch orders: ${messageOf(error)}`);
      await sleep(pollMs);
      continue;
    }

    const order = orders[0];
    if (!order) {
      await sleep(pollMs);
      continue;
    }

    try {
      await grind(order);
    } catch (error) {
      if (!stopping) console.error(`Order #${order.proposalId} failed: ${messageOf(error)}`);
      await sleep(pollMs);
    }
  }
}

async function fetchOrders() {
  const response = await fetch(`${botUrl}/grinder/orders`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET /grinder/orders returned ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return Array.isArray(body.orders) ? body.orders : [];
}

function grind(order) {
  return new Promise((resolve, reject) => {
    const target = `${order.position === "start" ? "starts" : "ends"} with ${order.pattern}`;
    console.log(`Order #${order.proposalId}: searching for a CA that ${target}...`);

    const env = { ...process.env, VANITY_CUSTOM_ORDER: "true", VANITY_STDOUT_MODE: "true", PUMP_MINT_WORKERS: String(workers) };
    delete env.VANITY_MINT_PREFIX;
    delete env.VANITY_MINT_SUFFIX;
    env[order.position === "start" ? "VANITY_MINT_PREFIX" : "VANITY_MINT_SUFFIX"] = order.pattern;

    const startedAt = Date.now();
    let settled = false;
    let buffer = "";
    child = spawn(binaryPath, [], { env, stdio: ["ignore", "pipe", "inherit"], shell: false });

    // Stop early if the order was cancelled or filled elsewhere while this one searched.
    const orderCheck = setInterval(() => {
      void fetchOrders()
        .then((orders) => {
          if (!orders.some((pending) => pending.proposalId === order.proposalId)) {
            console.log(`Order #${order.proposalId} is no longer pending; stopping.`);
            finish(resolve);
          }
        })
        .catch(() => undefined);
    }, orderCheckMs);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearInterval(orderCheck);
      child?.kill();
      child = undefined;
      callback(value);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("VANITY_MINT\t")) {
          const [, address, secretKey] = line.split("\t");
          if (!address || !secretKey || settled) continue;
          const seconds = Math.round((Date.now() - startedAt) / 1000);
          console.log(`Order #${order.proposalId}: found ${address} after ${seconds}s. Sending to the bot...`);
          finish(() => void submit(order, address, secretKey).then(resolve, reject));
        } else if (line.startsWith("Searching...")) {
          console.log(`Order #${order.proposalId}: ${line}`);
        }
      }
    });

    child.on("exit", (code) => {
      if (!settled && !stopping) finish(reject, new Error(`vanity worker exited with code ${code}`));
    });
    child.on("error", (error) => finish(reject, error));
  });
}

async function submit(order, address, secretKey) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${botUrl}/grinder/orders/${order.proposalId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ address, secretKey })
      });
      if (response.ok) {
        console.log(`Order #${order.proposalId}: delivered.`);
        return;
      }
      const text = await response.text();
      // 4xx means the bot rejected it (cancelled, already filled, invalid); retrying won't help.
      if (response.status < 500) throw new Error(`bot rejected the result (${response.status}): ${text}`);
      console.error(`Order #${order.proposalId}: bot returned ${response.status}, retrying...`);
    } catch (error) {
      if (String(messageOf(error)).startsWith("bot rejected")) throw error;
      console.error(`Order #${order.proposalId}: delivery failed (${messageOf(error)}), retrying...`);
    }
    await sleep(5_000);
  }
  throw new Error("could not deliver the result after 5 attempts; it will be searched again");
}

function stop(exitCode) {
  stopping = true;
  child?.kill();
  process.exit(exitCode);
}

function fail(error) {
  console.error(error);
  child?.kill();
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
