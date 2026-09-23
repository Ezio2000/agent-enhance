// Capability hints from the local Codex models catalog and OpenAI's GPT-6 Sol/Luna
// release, model, Fast-mode and Responses documentation (checked 2026-09-23):
// https://openai.com/index/introducing-gpt-6-sol-and-luna/
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://learn.chatgpt.com/docs/agent-configuration/speed
// They describe model support, not account entitlement or guaranteed backend behavior.
// Unknown models remain opt-out until their protocol support is checked.
const SUPPORT: Readonly<Record<string, { verbosity: boolean; originalImages: boolean; priority: boolean }>> =
  Object.freeze({
    "gpt-6-astra": { verbosity: true, originalImages: true, priority: true },
    "gpt-6-sol": { verbosity: true, originalImages: true, priority: true },
    "gpt-6-luna": { verbosity: true, originalImages: true, priority: true },
    "gpt-5.6-sol": { verbosity: true, originalImages: true, priority: true },
    "gpt-5.6-terra": { verbosity: true, originalImages: true, priority: true },
    "gpt-5.6-luna": { verbosity: true, originalImages: true, priority: true },
    "gpt-daybreak-blue-latest": { verbosity: true, originalImages: true, priority: false },
    "gpt-daybreak-red-latest": { verbosity: true, originalImages: true, priority: false },
    "gpt-5.5": { verbosity: true, originalImages: true, priority: true },
    "gpt-5.4": { verbosity: true, originalImages: true, priority: true },
    "gpt-5.4-mini": { verbosity: true, originalImages: true, priority: false },
    "gpt-5.2": { verbosity: true, originalImages: false, priority: false },
    "codex-auto-review": { verbosity: true, originalImages: true, priority: true },
  });

export function supportsModelOption(
  modelId: string,
  option: "verbosity" | "originalImages" | "priority",
): boolean {
  return Object.hasOwn(SUPPORT, modelId) && SUPPORT[modelId]![option];
}
