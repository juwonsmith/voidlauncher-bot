import { config } from "../config.js";
import { validateImageFile } from "../imageValidation.js";
import type { Proposal } from "../types.js";

interface PinataResponse {
  data?: {
    cid?: string;
  };
}

export async function uploadMetadataToPinata(proposal: Proposal, label: string): Promise<string> {
  if (!config.PINATA_JWT) {
    throw new Error("PINATA_JWT is required for IPFS metadata uploads.");
  }
  if (!proposal.image) {
    throw new Error("An image URL is required for launch metadata.");
  }

  console.log(`[launch:${proposal.id}] downloading/uploading ${label} image to Pinata`);
  const imageUri = await uploadFileToPinata(proposal.image, `${proposal.symbol}-${label}-image`);
  console.log(`[launch:${proposal.id}] ${label} image uploaded: ${imageUri}`);

  const metadata = {
    name: proposal.name,
    symbol: proposal.symbol,
    description: proposal.description,
    image: imageUri,
    website: proposal.website,
    telegram: proposal.telegram,
    twitter: proposal.twitter
  };

  const file = new File([JSON.stringify(metadata)], `${proposal.symbol}-${label}-metadata.json`, {
    type: "application/json"
  });
  return uploadBlobToPinata(file);
}

async function uploadFileToPinata(url: string, fallbackName: string): Promise<string> {
  const file = await fetchFile(url, fallbackName);
  const validatedImage = await validateImageFile(file);
  return uploadBlobToPinata(validatedImage.file);
}

async function uploadBlobToPinata(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("network", "public");
  formData.append("file", file);

  const response = await retryFetch("Pinata upload request", () =>
    fetch("https://uploads.pinata.cloud/v3/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.PINATA_JWT}` },
      body: formData
    })
  );

  const body = (await response.json().catch(() => ({}))) as PinataResponse;
  if (!response.ok || !body.data?.cid) {
    throw new Error(`Pinata upload failed: ${response.status} ${response.statusText}`);
  }

  return `https://ipfs.io/ipfs/${body.data.cid}`;
}

async function fetchFile(url: string, fallbackName: string, attempts = 5): Promise<File> {
  console.log(`[image] fetching ${safeUrlLabel(url)}`);
  const resolvedUrl = url.startsWith("telegram:") ? await resolveTelegramFileUrl(url, attempts) : url;
  const response = await retryFetch(`image download from ${safeUrlLabel(url)}`, () => fetch(resolvedUrl), attempts);

  if (!response.ok) {
    throw new Error(`Could not download image from ${safeUrlLabel(url)}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const extension = extensionFromContentType(contentType);
  const blob = await response.blob();
  return new File([blob], `${fallbackName}${extension}`, { type: contentType });
}

async function resolveTelegramFileUrl(value: string, attempts = 5): Promise<string> {
  const fileId = value.slice("telegram:".length);
  const response = await retryFetch("Telegram getFile request", () =>
    fetch(
      `https://api.telegram.org/bot${encodeURIComponent(config.TELEGRAM_BOT_TOKEN)}/getFile?file_id=${encodeURIComponent(
        fileId
      )}`
    )
  , attempts);

  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { file_path?: string };
    description?: string;
  };

  if (!response.ok || !body.ok || !body.result?.file_path) {
    throw new Error(body.description ?? `Could not resolve Telegram image: ${response.status} ${response.statusText}`);
  }

  return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${body.result.file_path}`;
}

async function retryFetch(label: string, run: () => Promise<Response>, attempts = 5): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await run();
      if (response.ok || attempt === attempts || !isRetryableStatus(response.status)) return response;

      console.warn(`[retry] ${label} returned ${response.status}. Attempt ${attempt}/${attempts}`);
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      console.warn(`[retry] ${label} failed. Attempt ${attempt}/${attempts}: ${errorMessage(error)}`);
    }

    await delay(750 * attempt);
  }

  throw new Error(`${label} failed after ${attempts} attempts: ${errorMessage(lastError)}`);
}

function safeUrlLabel(url: string): string {
  if (url.startsWith("telegram:")) return "Telegram upload";
  if (url.includes("api.telegram.org/file/bot")) return "Telegram file URL";
  return url;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function extensionFromContentType(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  return "";
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
