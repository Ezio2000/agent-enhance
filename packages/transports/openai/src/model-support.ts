// Capability hints from the local Codex models catalog (2026-09-07).
// They describe model support, not account entitlement or guaranteed backend behavior.
// Unknown models remain opt-out until their protocol support is checked.
const SUPPORT: Readonly<Record<string, { verbosity: boolean; originalImages: boolean; priority: boolean }>> =
  Object.freeze({
    "gpt-6-astra": { verbosity: true, originalImages: true, priority: true },
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
