import type { ImageRequest, ImageResponse } from "./types.ts";

export function imageWarnings(
  request: ImageRequest,
  response: ImageResponse,
  actual: { mimeType: string; width?: number; height?: number }[] = [],
): string[] {
  const warnings: string[] = [...(response.warnings ?? [])];
  if (response.data.length !== (request.n ?? 1))
    warnings.push(
      `Requested n=${request.n ?? 1}, but the backend returned ${response.data.length} image(s).`,
    );
  const expectedFormat = request.output_format ?? "png";
  const formats = new Set(
    actual.length
      ? actual.map((image) => image.mimeType.replace("image/", ""))
      : response.output_format
        ? [response.output_format]
        : [],
  );
  for (const format of formats)
    if (format !== expectedFormat)
      warnings.push(
        `Requested output_format=${expectedFormat}, but the actual output is ${format}. The backend did not honor the format; originals were saved without conversion.`,
      );
  if (request.size && request.size !== "auto") {
    const sizes = new Set(
      actual.filter((image) => image.width && image.height).map((image) => `${image.width}x${image.height}`),
    );
    if (!sizes.size && response.size) sizes.add(response.size);
    for (const size of sizes)
      if (size !== request.size)
        warnings.push(
          `Requested size=${request.size}, but the actual output is ${size}. The backend did not honor the dimensions.`,
        );
  }
  for (const name of ["quality", "background"] as const) {
    if (request[name] && request[name] !== "auto" && response[name] && response[name] !== request[name])
      warnings.push(`Requested ${name}=${request[name]}, but the backend reports ${response[name]}.`);
  }
  return warnings;
}
