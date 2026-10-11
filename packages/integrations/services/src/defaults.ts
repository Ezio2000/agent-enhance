import type { ServiceConnection } from "./contracts.ts";

const providers: Readonly<Record<string, readonly string[]>> = {
  gen_image: ["xai", "openai", "minimax"],
  gen_video: ["xai"],
  gen_voice: ["minimax"],
  search_web: ["openai", "zai"],
  space: ["openai"],
  sites: ["openai"],
  use_computer: ["openai"],
  view_image: ["zai"],
  view_pdf: ["opencode"],
  view_video: ["opencode"],
};
const connections: Readonly<Record<string, readonly string[]>> = {
  openai: ["codex:openai-codex", "pi:openai-codex", "local:chatgpt-desktop"],
  xai: ["pi:xai"],
  minimax: ["pi:minimax-cn", "pi:minimax", "env:MINIMAX_CN_API_KEY", "env:MINIMAX_API_KEY"],
  zai: ["pi:zai", "pi:zai-coding-cn", "env:ZAI_API_KEY", "env:ZAI_CODING_CN_API_KEY"],
  opencode: ["pi:opencode-go", "opencode:opencode-go", "env:OPENCODE_API_KEY"],
};
/** Providers of a capability, most preferred first. */
export const providerOrder = (capability: string): readonly string[] => providers[capability] ?? [];
const rank = (order: readonly string[], value: string) => {
  const index = order.indexOf(value);
  return index < 0 ? order.length : index;
};

/** Select before execution, independently of discovery order; never retry failed calls. */
export function defaultServiceOrder(capability: string, candidates: readonly ServiceConnection[]): string[] {
  return [...candidates]
    .sort(
      (a, b) =>
        rank(providers[capability] ?? [], a.provider) - rank(providers[capability] ?? [], b.provider) ||
        a.provider.localeCompare(b.provider) ||
        rank(connections[a.provider] ?? [], a.id) - rank(connections[b.provider] ?? [], b.id) ||
        a.id.localeCompare(b.id),
    )
    .map((connection) => connection.id);
}
