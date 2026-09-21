import type { ExecutionContext } from "../../../core/src/contracts.ts";
import { requireCredential } from "../../../core/src/auth.ts";
import type { ProtocolAuth } from "./types.ts";

const ALLOWED_ORIGINS = ["https://api.minimaxi.com", "https://api.minimax.io"] as const;
const DEFAULT_ORIGIN = "https://api.minimaxi.com";

/**
 * The credential baseUrl points at the chat API (e.g. .../anthropic); media endpoints
 * live under /v1 on the same host. Only the origin is adopted so the key never leaves
 * the MiniMax host the credential belongs to; anything else is refused.
 */
export function minimaxMediaBase(raw?: string): string {
  const origin = (() => {
    if (!raw) return DEFAULT_ORIGIN;
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Refusing to use a MiniMax base URL with credentials or fragments.");
    if (!(ALLOWED_ORIGINS as readonly string[]).includes(url.origin))
      throw new Error(`Refusing to send MiniMax credentials to ${url.origin}.`);
    return url.origin;
  })();
  return `${origin}/v1/`;
}

export async function resolveMinimaxAuth(
  ctx: Pick<ExecutionContext, "credentials" | "signal">,
): Promise<ProtocolAuth> {
  const credential = await requireCredential(
    ctx.credentials,
    { provider: "minimax", channel: "token-plan", acceptedKinds: ["api_key"] },
    ctx.signal,
  );
  if (!credential.secret.startsWith("sk-cp-") && !credential.secret.startsWith("eyJ"))
    throw new Error("MiniMax credential does not look like a Token Plan key; reauthenticate in the host.");
  return {
    baseUrl: minimaxMediaBase(credential.baseUrl),
    headers: { Authorization: `Bearer ${credential.secret}`, "User-Agent": "agent-enhance/0.2.0" },
  };
}
