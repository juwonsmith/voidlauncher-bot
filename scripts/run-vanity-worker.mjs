import { spawn } from "node:child_process";
import path from "node:path";

const suffix = process.argv[2] ?? "pump";
const binaryPath = path.join(
  "rust",
  "vanity-worker",
  "target",
  "release",
  process.platform === "win32" ? "vanity-worker.exe" : "vanity-worker"
);

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
  startWorker();
});

let child;

function startWorker() {
  child = spawn(binaryPath, [], {
    env: {
      ...process.env,
      VANITY_MINT_SUFFIX: suffix
    },
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
