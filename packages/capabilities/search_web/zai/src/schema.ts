import { Type, type Static } from "typebox";
import { object, text, choices } from "../../../../transports/zai/src/schema.ts";

const domainList = Type.Array(text("Bare domain, e.g. openai.com, without scheme or path", 253), {
  minItems: 1,
  maxItems: 100,
});
const query = object({
  q: text("Search query"),
  recency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 36500,
      description: "Limit to the last N days; rounded to the backend buckets oneDay/oneWeek/oneMonth/oneYear",
    }),
  ),
  domains: Type.Optional(domainList),
});
/**
 * Field names deliberately match the openai implementation so the registry floats them to the
 * top level of the merged search_web schema. lineno is accepted for schema symmetry and ignored.
 */
export const ZaiWebSchema = object({
  search_query: Type.Optional(Type.Array(query, { minItems: 1, maxItems: 4 })),
  open: Type.Optional(
    Type.Array(
      object({
        ref_id: text("An HTTP(S) URL or an unchanged z-reference from a previous zai search result", 8192),
        lineno: Type.Optional(
          Type.Integer({ minimum: 0, description: "Accepted for symmetry; ignored by zai" }),
        ),
      }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  search_engine: Type.Optional(
    choices(
      ["search_std", "search_pro", "search_pro_sogou", "search_pro_quark"],
      "Default search_std (Zhipu basic); applies to every query in the batch",
    ),
  ),
  location: Type.Optional(text("Location preference for results, e.g. China / United States", 100)),
  content_size: Type.Optional(choices(["medium", "high"], "Result content richness")),
  return_format: Type.Optional(choices(["markdown", "text"], "Page format for open; default markdown")),
  no_cache: Type.Optional(Type.Boolean({ description: "Bypass the reader cache; default false" })),
  retain_images: Type.Optional(Type.Boolean({ description: "Keep image references in pages; default true" })),
  no_gfm: Type.Optional(Type.Boolean({ description: "Disable GitHub Flavored Markdown; default false" })),
  keep_img_data_url: Type.Optional(
    Type.Boolean({ description: "Keep inline image data URLs; default false" }),
  ),
  with_images_summary: Type.Optional(
    Type.Boolean({ description: "Append an image summary for opened pages; default false" }),
  ),
  with_links_summary: Type.Optional(
    Type.Boolean({ description: "Append a link summary for opened pages; default false" }),
  ),
  reader_timeout: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 120, description: "Per-page fetch timeout in seconds; default 20" }),
  ),
  timeout_seconds: Type.Optional(
    Type.Integer({ minimum: 5, maximum: 300, description: "Whole-call budget; default 90" }),
  ),
});
export type ZaiWebArgs = Static<typeof ZaiWebSchema>;
