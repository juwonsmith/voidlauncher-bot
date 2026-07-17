import { spawn } from "node:child_process";

const suffixes = ["pump", "bonk", "bags"];

const build = spawn("cargo", ["build", "--release", "--manifest-path", "rust/vanity-worker/Cargo.toml"], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

build.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code !== 0) process.exit(code ?? 1);
  startWorkers();
});

const children = [];

function startWorkers() {
  for (const suffix of suffixes) {
    const child = spawn(process.execPath, ["scripts/run-vanity-worker.mjs", suffix], {
      env: {
        ...process.env,
        SKIP_VANITY_BUILD: "true"
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${suffix}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${suffix}] ${chunk}`));
  child.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[${suffix}] worker exited with ${reason}`);
  });

    children.push(child);
  }
}

function stopAll(signal) {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.once("SIGINT", () => {
  stopAll("SIGINT");
  process.exit(130);
});

process.once("SIGTERM", () => {
  stopAll("SIGTERM");
  process.exit(143);
});
