import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(config.LOG_DIR, { recursive: true });

const appLogPath = path.join(config.LOG_DIR, "app.jsonl");
const errorLogPath = path.join(config.LOG_DIR, "error.jsonl");

function writeJsonl(filePath: string, event: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data
  });
  fs.appendFile(filePath, `${line}\n`, (error) => {
    if (error) console.error("Failed to write log file", error);
  });
}

export function logInfo(event: string, data: Record<string, unknown> = {}): void {
  console.log(`[${event}]`, data);
  writeJsonl(appLogPath, event, data);
}

export function logError(event: string, error: unknown, data: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${event}]`, message, data);
  writeJsonl(errorLogPath, event, {
    ...data,
    error: message,
    stack: error instanceof Error ? error.stack : undefined
  });
}
