import type { ExecutionContext } from "../../../core/src/contracts.ts";
import { requireCredential } from "../../../core/src/auth.ts";
import type { ProtocolAuth } from "./types.ts";

/**
 * GLM Coding Plan tool endpoints. The international (api.z.ai) and China (open.bigmodel.cn)
 * platforms expose the same /api/coding/paas/v4 tool routes; the platform is derived from the
 * credential's own baseUrl so the key never leaves the host it belongs to. Both origins verified
 * by live probe; anything else is refused.
 */
const ALLOWED_ORIGINS = ["https://api.z.ai", "https://open.bigmodel.cn"] as const;
const DEFAULT_ORIGIN = "https://api.z.ai";
const CODING_PATH = "/api/coding/paas/v4";

export function zaiCodingBase(raw?: string): string {
  const origin = (() => {
    if (!raw) return DEFAULT_ORIGIN;
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Refusing to use a Zai base URL with credentials or fragments.");
    if (!(ALLOWED_ORIGINS as readonly string[]).includes(url.origin))
      throw new Error(`Refusing to send Zai credentials to ${url.origin}.`);
    return url.origin;
  })();
  return `${origin}${CODING_PATH}/`;
}

export async function resolveZaiAuth(
  ctx: Pick<ExecutionContext, "credentials" | "signal">,
): Promise<ProtocolAuth> {
  const credential = await requireCredential(
    ctx.credentials,
    { provider: "zai", channel: "coding-plan", acceptedKinds: ["api_key"] },
    ctx.signal,
  );
  return {
    baseUrl: zaiCodingBase(credential.baseUrl),
    headers: { Authorization: `Bearer ${credential.secret}`, "User-Agent": "agent-enhance/0.2.0" },
  };
}
