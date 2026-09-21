// Adapted from openai-codex-enhance (MIT); see LICENSE.
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
