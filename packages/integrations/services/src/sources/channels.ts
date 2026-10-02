import type { ProviderId } from "../../../../core/src/contracts.ts";
export interface ChannelDefinition {
  provider: ProviderId;
  channel: string;
  kind: "oauth" | "api_key";
  baseUrl?: string;
  env?: string;
}
export const channels: Readonly<Record<string, ChannelDefinition>> = {
  "openai-codex": { provider: "openai", channel: "codex", kind: "oauth" },
  xai: { provider: "xai", channel: "imagine", kind: "oauth" },
  "opencode-go": {
    provider: "opencode",
    channel: "go",
    kind: "api_key",
    env: "OPENCODE_API_KEY",
    baseUrl: "https://opencode.ai/zen/go/v1/",
  },
  "minimax-cn": {
    provider: "minimax",
    channel: "token-plan",
    kind: "api_key",
    env: "MINIMAX_CN_API_KEY",
    baseUrl: "https://api.minimaxi.com",
  },
  minimax: {
    provider: "minimax",
    channel: "token-plan",
    kind: "api_key",
    env: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io",
  },
  zai: {
    provider: "zai",
    channel: "coding-plan",
    kind: "api_key",
    env: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai",
  },
  "zai-coding-cn": {
    provider: "zai",
    channel: "coding-plan",
    kind: "api_key",
    env: "ZAI_CODING_CN_API_KEY",
    baseUrl: "https://open.bigmodel.cn",
  },
};
