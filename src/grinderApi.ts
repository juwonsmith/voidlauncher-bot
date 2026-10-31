// HTTP API the custom CA grinder (scripts/run-custom-ca-worker.mjs) uses to fetch orders and hand back keypairs.
// Orders are served from memory, so a grinder polling every few seconds never touches the database.
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CustomCaPosition } from "./customCa.js";

export interface GrinderOrder {
  proposalId: number;
  position: CustomCaPosition;
  pattern: string;
}

export type GrinderSubmitResult = { ok: true } | { ok: false; status: number; error: string };

export interface GrinderApi {
  token?: string;
  pendingOrders(): GrinderOrder[];
  submitResult(proposalId: number, address: string, secretKeyBase58: string): Promise<GrinderSubmitResult>;
}

export const MIN_GRINDER_TOKEN_LENGTH = 24;
const MAX_BODY_BYTES = 4096;

export function grinderApiEnabled(token: string | undefined): token is string {
  return Boolean(token && token.length >= MIN_GRINDER_TOKEN_LENGTH);
}

/** Answers /grinder/* requests. Returns false for any other path so the caller can serve it. */
export async function handleGrinderRequest(
  request: IncomingMessage,
  response: ServerResponse,
  api: GrinderApi
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/grinder/")) return false;

  if (!grinderApiEnabled(api.token)) {
    sendJson(response, 404, { error: "not found" });
    return true;
  }
  if (!isAuthorized(request, api.token)) {
    sendJson(response, 401, { error: "invalid grinder token" });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/grinder/orders") {
    sendJson(response, 200, { orders: api.pendingOrders() });
    return true;
  }

  const submitMatch = url.pathname.match(/^\/grinder\/orders\/(\d+)$/);
  if (request.method === "POST" && submitMatch) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid JSON body" });
      return true;
    }
    if (typeof body.address !== "string" || typeof body.secretKey !== "string") {
      sendJson(response, 400, { error: "address and secretKey are required" });
      return true;
    }

    const result = await api.submitResult(Number(submitMatch[1]), body.address, body.secretKey);
    if (result.ok) sendJson(response, 200, { ok: true });
    else sendJson(response, result.status, { error: result.error });
    return true;
  }

  sendJson(response, 404, { error: "not found" });
  return true;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const expected = crypto.createHash("sha256").update(`Bearer ${token}`).digest();
  const actual = crypto.createHash("sha256").update(header).digest();
  return crypto.timingSafeEqual(expected, actual);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
