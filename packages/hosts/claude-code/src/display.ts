/** Chinese labels for capabilities, used in tool titles and status output. */
export const LABELS: Record<string, string> = {
  gen_image: "图片生成",
  gen_video: "视频生成",
  gen_voice: "语音合成",
  search_web: "联网搜索",
  view_pdf: "PDF 理解",
  view_video: "视频理解",
  view_image: "图片理解",
  use_computer: "桌面操作",
  manage_computer: "桌面管理",
  fast: "请求增强",
  verbosity: "请求增强",
  image_detail: "请求增强",
};
/** Claude Code renders `<server> - <annotations.title> (MCP)(args…)`; keep it short and bilingual. */
export function toolTitle(name: string, providers: readonly string[] = []): string {
  return (
    [LABELS[name], name].filter(Boolean).join(" ") + (providers.length ? ` · ${providers.join("/")}` : "")
  );
}
// Claude Code shows arguments in the order the model writes them, which follows schema order. Lead
// with what describes the call; routing details go last.
const FRONT = ["title", "prompt", "search_query", "text", "task", "path", "image", "images", "code"];
const BACK = ["options", "provider"];
export function orderSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return schema;
  const rank = (key: string) =>
    FRONT.includes(key) ? FRONT.indexOf(key) - FRONT.length : BACK.includes(key) ? 1 + BACK.indexOf(key) : 0;
  const keys = Object.keys(properties).sort((a, b) => rank(a) - rank(b));
  return { ...schema, properties: Object.fromEntries(keys.map((key) => [key, properties[key]])) };
}
