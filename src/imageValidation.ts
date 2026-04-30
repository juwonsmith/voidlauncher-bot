import { config } from "./config.js";

const allowedContentTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface ImageValidationResult {
  file: File;
  width?: number;
  height?: number;
}

export async function validateImageFile(file: File): Promise<ImageValidationResult> {
  if (file.size > config.MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is too large (${formatBytes(file.size)}). Max allowed is ${formatBytes(config.MAX_IMAGE_BYTES)}.`
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedType = detectImageType(bytes) ?? file.type;

  if (!allowedContentTypes.has(detectedType)) {
    throw new Error("Image must be PNG, JPG, WebP, or GIF.");
  }

  const dimensions = readImageDimensions(bytes, detectedType);

  if (!dimensions) {
    throw new Error("Could not read image dimensions. Please upload a standard PNG, JPG, WebP, or GIF.");
  }

  const { width, height } = dimensions;
  if (
    width < config.MIN_IMAGE_DIMENSION ||
    height < config.MIN_IMAGE_DIMENSION ||
    width > config.MAX_IMAGE_DIMENSION ||
    height > config.MAX_IMAGE_DIMENSION
  ) {
    throw new Error(
      `Image dimensions must be between ${config.MIN_IMAGE_DIMENSION}x${config.MIN_IMAGE_DIMENSION} and ` +
        `${config.MAX_IMAGE_DIMENSION}x${config.MAX_IMAGE_DIMENSION}. Got ${width}x${height}.`
    );
  }

  if (config.REQUIRE_SQUARE_IMAGE && width !== height) {
    throw new Error(`Image must be square. Got ${width}x${height}.`);
  }

  return {
    file: file.type === detectedType ? file : new File([bytes], file.name, { type: detectedType }),
    width,
    height
  };
}

export function imageValidationSummary(result: ImageValidationResult): string {
  const dimensions = result.width && result.height ? `${result.width}x${result.height}` : "unknown dimensions";
  return `${result.file.name} (${result.file.type}, ${dimensions}, ${formatBytes(result.file.size)})`;
}

function readImageDimensions(bytes: Uint8Array, contentType: string): { width: number; height: number } | undefined {
  if (contentType === "image/png") return readPngDimensions(bytes);
  if (contentType === "image/jpeg") return readJpegDimensions(bytes);
  if (contentType === "image/gif") return readGifDimensions(bytes);
  if (contentType === "image/webp") return readWebpDimensions(bytes);
  return undefined;
}

function detectImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const signature = ascii(bytes, 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
  return { width: readU32be(bytes, 16), height: readU32be(bytes, 20) };
}

function readGifDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined;
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") return undefined;
  return { width: readU16le(bytes, 6), height: readU16le(bytes, 8) };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    const length = readU16be(bytes, offset + 2);
    if (length < 2) return undefined;

    if (isJpegSofMarker(marker)) {
      return {
        height: readU16be(bytes, offset + 5),
        width: readU16be(bytes, offset + 7)
      };
    }

    offset += 2 + length;
  }

  return undefined;
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return undefined;

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + readU24le(bytes, 24),
      height: 1 + readU24le(bytes, 27)
    };
  }

  if (chunk === "VP8 " && bytes.length >= 30) {
    return { width: readU16le(bytes, 26) & 0x3fff, height: readU16le(bytes, 28) & 0x3fff };
  }

  if (chunk === "VP8L" && bytes.length >= 25) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    };
  }

  return undefined;
}

function isJpegSofMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readU16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
