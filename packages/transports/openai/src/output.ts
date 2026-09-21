export function truncateText(text: string): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let output = lines.slice(0, 2000).join("\n");
  if (Buffer.byteLength(output) > 48 * 1024) {
    output = Buffer.from(output)
      .subarray(0, 48 * 1024)
      .toString("utf8")
      .replace(/\uFFFD$/, "");
  }
  return { text: output, truncated: output.length < text.length };
}
