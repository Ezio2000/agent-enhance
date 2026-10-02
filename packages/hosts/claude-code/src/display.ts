/** Capability labels come from the same release catalog used by discovery. */
export function toolTitle(name: string, providers: readonly string[] = [], label = name): string {
  return [label === name ? name : label + " " + name, providers.length ? "· " + providers.join("/") : ""]
    .filter(Boolean)
    .join(" ");
}
// Claude Code shows arguments in the order the model writes them, which follows schema order. Lead
// with what describes the call; routing details go last.
const FRONT = ["title", "prompt", "search_query", "text", "task", "path", "image", "images", "code"];
const BACK = ["options", "provider", "service"];
export function orderSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return schema;
  const rank = (key: string) =>
    FRONT.includes(key) ? FRONT.indexOf(key) - FRONT.length : BACK.includes(key) ? 1 + BACK.indexOf(key) : 0;
  const keys = Object.keys(properties).sort((a, b) => rank(a) - rank(b));
  return { ...schema, properties: Object.fromEntries(keys.map((key) => [key, properties[key]])) };
}
