import { Type, type Static } from "typebox";
import { object, text, choices } from "../../../../transports/openai/src/schema.ts";

const domainList = Type.Array(text("Bare domain, e.g. openai.com, without scheme or path", 253), {
  minItems: 1,
  maxItems: 100,
});
const query = object({
  q: text("Search query"),
  recency: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 36500, description: "Limit to the last N days" }),
  ),
  domains: Type.Optional(domainList),
});
const ref = text("An HTTP(S) URL or an unchanged reference ID from a previous search_web result", 8192);
export const WebSchema = object({
  search_query: Type.Optional(Type.Array(query, { minItems: 1, maxItems: 4 })),
  image_query: Type.Optional(Type.Array(query, { minItems: 1, maxItems: 4 })),
  open: Type.Optional(
    Type.Array(object({ ref_id: ref, lineno: Type.Optional(Type.Integer({ minimum: 0 })) }), {
      minItems: 1,
      maxItems: 10,
    }),
  ),
  click: Type.Optional(
    Type.Array(
      object({ ref_id: ref, id: Type.Integer({ minimum: 0, description: "Link number in an opened page" }) }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  find: Type.Optional(
    Type.Array(object({ ref_id: ref, pattern: text("Text to find") }), { minItems: 1, maxItems: 10 }),
  ),
  screenshot: Type.Optional(
    Type.Array(
      object({
        ref_id: ref,
        pageno: Type.Integer({ minimum: 0, description: "Zero-based PDF page number" }),
      }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  finance: Type.Optional(
    Type.Array(
      object({
        ticker: text("Ticker symbol", 100),
        type: choices(["equity", "fund", "crypto", "index"]),
        market: Type.Optional(
          Type.String({
            maxLength: 3,
            pattern: "^(?:[A-Z]{3})?$",
            description: "ISO alpha-3 country code, OTC, or empty string for crypto",
          }),
        ),
      }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  weather: Type.Optional(
    Type.Array(
      object({
        location: text("Country, Area, City", 300),
        start: Type.Optional(
          Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD; default today" }),
        ),
        duration: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 365,
            description: "Number of days; default 7. Forecast coverage depends on backend.",
          }),
        ),
      }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  sports: Type.Optional(
    Type.Array(
      object({
        fn: choices(["schedule", "standings"]),
        league: choices(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"]),
        team: Type.Optional(text("Common team alias", 100)),
        opponent: Type.Optional(text("Opponent alias", 100)),
        date_from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        date_to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
        num_games: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        locale: Type.Optional(text("Locale, e.g. en-US", 100)),
      }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  time: Type.Optional(
    Type.Array(
      object({
        utc_offset: Type.String({
          pattern: "^[+-](?:[01]\\d|2[0-3]):[0-5]\\d$",
          description: "UTC offset, e.g. +08:00",
        }),
      }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  response_length: Type.Optional(
    choices(["short", "medium", "long"], "Default short; 4 search queries require medium or long"),
  ),
  search_context_size: Type.Optional(
    choices(["low", "medium", "high"], "Amount of search context, not an exact token budget"),
  ),
  external_web_access: Type.Optional(
    Type.Union([Type.Boolean(), choices(["cached", "indexed", "live"])], {
      description:
        "Default true (live); false for cache only; indexed restricts live fetches to indexed URLs",
    }),
  ),
  filters: Type.Optional(
    object({ allowed_domains: Type.Optional(domainList), blocked_domains: Type.Optional(domainList) }),
  ),
  user_location: Type.Optional(
    object({
      country: Type.Optional(
        Type.String({ pattern: "^[A-Z]{2}$", description: "Two-letter ISO country code" }),
      ),
      city: Type.Optional(text("Approximate city", 200)),
      region: Type.Optional(text("Approximate region", 200)),
      timezone: Type.Optional(text("IANA timezone, e.g. Asia/Shanghai", 100)),
    }),
  ),
  image_settings: Type.Optional(
    object({
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      caption: Type.Optional(Type.Boolean()),
    }),
  ),
  max_output_tokens: Type.Optional(
    Type.Integer({ minimum: 256, maximum: 20000, description: "Search service output budget; default 6000" }),
  ),
  include_context: Type.Optional(
    Type.Boolean({
      description:
        "Default true: send only the last two user text messages and intervening assistant text; no files, tool results or reasoning",
    }),
  ),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 300, description: "Default 90" })),
});

export type WebArgs = Static<typeof WebSchema>;
