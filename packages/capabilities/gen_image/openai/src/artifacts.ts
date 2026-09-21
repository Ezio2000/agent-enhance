import { open, realpath, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ArtifactDirectories } from "../../../../transports/openai/src/artifacts.ts";
import type { ImageReference } from "./types.ts";
import type { ImageSource } from "./schema.ts";
import { validateReference } from "./validation.ts";

export const MAX_IMAGE_BYTES = 50 * 1000 * 1000 - 1;
export const MAX_TOTAL_INPUT_BYTES = 100 * 1024 * 1024;
export interface ImageInfo {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpeg" | "webp";
  width?: number;
  height?: number;
  alpha?: boolean;
}
export function imageInfo(bytes: Uint8Array): ImageInfo {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length >= 33 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.toString("ascii", 12, 16) === "IHDR"
  ) {
    let alpha = b[25] === 4 || b[25] === 6;
    for (let p = 8; p + 12 <= b.length;) {
      const size = b.readUInt32BE(p);
      if (p + size + 12 > b.length) break;
      if (b.toString("ascii", p + 4, p + 8) === "tRNS") alpha = true;
      p += size + 12;
    }
    return {
      mimeType: "image/png",
      extension: "png",
      width: b.readUInt32BE(16),
      height: b.readUInt32BE(20),
      alpha,
    };
  }
  if (b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p++] !== 255) break;
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > b.length) break;
      const length = b.readUInt16BE(p);
      if (length < 2 || p + length > b.length) break;
      if (
        marker !== undefined &&
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
        length >= 7
      ) {
        return {
          mimeType: "image/jpeg",
          extension: "jpeg",
          height: b.readUInt16BE(p + 3),
          width: b.readUInt16BE(p + 5),
          alpha: false,
        };
      }
      p += length;
    }
    return { mimeType: "image/jpeg", extension: "jpeg" };
  }
  if (b.length >= 16 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const format = b.toString("ascii", 12, 16);
    if (format === "VP8X" && b.length >= 30)
      return {
        mimeType: "image/webp",
        extension: "webp",
        width: b.readUIntLE(24, 3) + 1,
        height: b.readUIntLE(27, 3) + 1,
        alpha: Boolean(b[20]! & 0x10),
      };
    if (format === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return {
        mimeType: "image/webp",
        extension: "webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        alpha: Boolean(bits & (1 << 28)),
      };
    }
    if (format === "VP8 " && b.length >= 30 && b.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])))
      return {
        mimeType: "image/webp",
        extension: "webp",
        width: b.readUInt16LE(26) & 0x3fff,
        height: b.readUInt16LE(28) & 0x3fff,
        alpha: false,
      };
    return { mimeType: "image/webp", extension: "webp" };
  }
  throw new Error("Not a supported PNG, JPEG or WebP image (file content, not filename, is checked).");
}

export function decodeImage(base64: string, maxBytes = MAX_IMAGE_BYTES): { bytes: Buffer; info: ImageInfo } {
  if (
    base64.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    base64.length % 4 !== 0
  )
    throw new Error("Invalid or oversized base64 image.");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > maxBytes) throw new Error("Image exceeds the byte limit.");
  return { bytes, info: imageInfo(bytes) };
}

export interface ResolvedImage {
  reference: ImageReference;
  bytes?: Buffer;
  info?: ImageInfo;
}
export async function resolveImage(
  source: ImageSource,
  cwd: string,
  signal?: AbortSignal,
): Promise<ResolvedImage> {
  signal?.throwIfAborted();
  if (Object.keys(source).some((key) => !["path", "image_url"].includes(key)))
    throw new Error("Image sources only support path or image_url.");
  if ([source.path, source.image_url].filter((x) => x !== undefined).length !== 1)
    throw new Error("Each image requires exactly one of path or image_url.");
  if (source.path !== undefined) {
    let name = source.path.replace(/^@/, "");
    if (name.startsWith("~/")) name = join(homedir(), name.slice(2));
    const path = await realpath(resolve(cwd, name));
    if (!(await lstat(path)).isFile()) throw new Error("Input must be a regular image file.");
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
        throw new Error("Input must be a regular PNG/JPEG/WebP file smaller than 50 MB.");
      const bytes = await file.readFile({ signal });
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Input image grew beyond the 50 MB limit.");
      const info = imageInfo(bytes);
      return {
        reference: { image_url: `data:${info.mimeType};base64,${bytes.toString("base64")}` },
        bytes,
        info,
      };
    } finally {
      await file.close();
    }
  }
  const reference: ImageReference = { image_url: source.image_url! };
  validateReference(reference);
  if (source.image_url?.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(source.image_url);
    if (!match) throw new Error("Invalid image data URL.");
    const decoded = decodeImage(match[2]!);
    if (decoded.info.mimeType !== match[1]) throw new Error("Data URL MIME type does not match image bytes.");
    return { reference, ...decoded };
  }
  return { reference };
}

export interface SavedImage {
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}
export class ImageArtifactStore extends ArtifactDirectories {
  async saveImages(
    sessionId: string,
    images: { b64_json: string }[],
    signal?: AbortSignal,
  ): Promise<SavedImage[]> {
    // Validate the complete batch before making any output files.
    const decoded = images.map((image) => decodeImage(image.b64_json, 32 * 1024 * 1024));
    const directory = await this.directory(sessionId);
    const saved: SavedImage[] = [];
    for (const [i, image] of decoded.entries()) {
      signal?.throwIfAborted();
      const path = join(directory, `image-${i + 1}.${image.info.extension}`);
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(image.bytes, { signal });
      } finally {
        await file.close();
      }
      saved.push({
        path,
        mimeType: image.info.mimeType,
        bytes: image.bytes.length,
        width: image.info.width,
        height: image.info.height,
      });
    }
    return saved;
  }
}
