import type { SearchRequest } from "./types.ts";
import { requireText, integer } from "../../../../transports/openai/src/validation.ts";

function validateDate(value: string | undefined, name: string): void {
  if (value === undefined) return;
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error(`${name} must be a valid YYYY-MM-DD date.`);
}
export function validateDomain(domain: string): void {
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(domain) ||
    domain.length > 253
  )
    throw new Error(
      `Invalid domain ${JSON.stringify(domain)}: use a bare hostname, without URL scheme, path or wildcard.`,
    );
}
export function validateSearchRequest(request: SearchRequest): void {
  const c = request.commands;
  const operations = [
    c.search_query,
    c.image_query,
    c.open,
    c.click,
    c.find,
    c.screenshot,
    c.finance,
    c.weather,
    c.sports,
    c.time,
  ];
  if (!operations.some((x) => x?.length))
    throw new Error(
      "Provide at least one search_query, image_query, open, click, find, screenshot, finance, weather, sports or time operation.",
    );
  for (const operation of operations)
    if (operation !== undefined)
      integer(
        operation.length,
        "operation count",
        1,
        operation === c.search_query || operation === c.image_query ? 4 : 10,
      );
  if ((c.search_query?.length ?? 0) > 4) throw new Error("search_query allows at most 4 queries per call.");
  if (c.search_query?.length === 4 && (c.response_length ?? "short") === "short")
    throw new Error("4 search queries require response_length: medium or long.");
  for (const q of [...(c.search_query ?? []), ...(c.image_query ?? [])]) {
    requireText(q.q, "query", 4000);
    integer(q.recency, "recency", 0, 36500);
    for (const domain of q.domains ?? []) validateDomain(domain);
  }
  for (const operation of [
    ...(c.open ?? []),
    ...(c.click ?? []),
    ...(c.find ?? []),
    ...(c.screenshot ?? []),
  ]) {
    requireText(operation.ref_id, "ref_id", 8192);
    if (/^[a-z][a-z\d+.-]*:/i.test(operation.ref_id) && !/^https?:\/\//i.test(operation.ref_id))
      throw new Error("ref_id must be an HTTP(S) URL or a search reference ID.");
  }
  for (const o of c.open ?? []) integer(o.lineno, "lineno", 0, 10000000);
  for (const o of c.click ?? []) integer(o.id, "link id", 0, 10000000);
  for (const o of c.find ?? []) requireText(o.pattern, "pattern", 4000);
  for (const o of c.screenshot ?? []) integer(o.pageno, "pageno", 0, 100000);
  for (const o of c.finance ?? []) {
    requireText(o.ticker, "ticker", 100);
    if (!["equity", "fund", "crypto", "index"].includes(o.type))
      throw new Error("Invalid finance asset type.");
    if (o.market !== undefined && !/^(?:[A-Z]{3})?$/.test(o.market))
      throw new Error("market must be ISO alpha-3, OTC, or empty for crypto.");
  }
  for (const o of c.weather ?? []) {
    requireText(o.location, "location", 300);
    validateDate(o.start, "start");
    integer(o.duration, "duration", 1, 365);
  }
  for (const o of c.sports ?? []) {
    if (o.tool !== undefined && o.tool !== "sports") throw new Error("Invalid sports tool.");
    if (!["schedule", "standings"].includes(o.fn)) throw new Error("Invalid sports function.");
    if (!["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"].includes(o.league))
      throw new Error("Invalid sports league.");
    for (const key of ["team", "opponent", "locale"] as const)
      if (o[key] !== undefined) requireText(o[key], key, 100);
    validateDate(o.date_from, "date_from");
    validateDate(o.date_to, "date_to");
    if (o.date_from && o.date_to && o.date_from > o.date_to)
      throw new Error("date_from must not be after date_to.");
    integer(o.num_games, "num_games", 1, 100);
  }
  for (const o of c.time ?? [])
    if (!/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(o.utc_offset))
      throw new Error("utc_offset must be ±HH:MM (hours 00–23, minutes 00–59).");
  for (const domains of [
    request.settings?.filters?.allowed_domains,
    request.settings?.filters?.blocked_domains,
  ]) {
    if (domains && domains.length > 100)
      throw new Error("Domain filters allow at most 100 domains per list.");
    for (const domain of domains ?? []) validateDomain(domain);
  }
  const location = request.settings?.user_location;
  if (location?.country && !/^[A-Z]{2}$/.test(location.country))
    throw new Error("country must be a two-letter uppercase ISO code.");
  if (location?.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: location.timezone });
    } catch {
      throw new Error("timezone must be a valid IANA timezone.");
    }
  }
  integer(request.max_output_tokens, "max_output_tokens", 256, 20000);
}
