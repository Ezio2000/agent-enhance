import type { CapabilityDefinition } from "../../core/src/contracts.ts";
import { Type } from "typebox";
export const definition: CapabilityDefinition = {
  id: "gen_image",
  label: "图片生成",
  group: "Images",
  commonFields: ["prompt", "images", "model", "timeout_seconds"],
  composeParameters(schemas) {
    return {
      images: Type.Optional(
        Type.Array(
          Type.Object(
            {
              path: Type.Optional(Type.String({ minLength: 1 })),
              image_url: Type.Optional(Type.String({ minLength: 1 })),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            maxItems: Math.max(
              ...schemas.map(
                (s) => (s.properties.images as { maxItems?: number } | undefined)?.maxItems ?? 1,
              ),
            ),
          },
        ),
      ),
      model: Type.Optional(
        Type.Unsafe<string>({
          type: "string",
          enum: [
            ...new Set(
              schemas.flatMap((s) => (s.properties.model as { enum?: string[] } | undefined)?.enum ?? []),
            ),
          ],
        }),
      ),
    };
  },
};
