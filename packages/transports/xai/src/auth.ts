import type { ExecutionContext } from "../../../core/src/contracts.ts";
import { requireCredential } from "../../../core/src/auth.ts";
import type { ProtocolAuth } from "./types.ts";
export async function resolveGrokAuth(
  ctx: Pick<ExecutionContext, "credentials" | "signal">,
): Promise<ProtocolAuth> {
  const credential = await requireCredential(
    ctx.credentials,
    { provider: "xai", channel: "imagine", acceptedKinds: ["oauth"] },
    ctx.signal,
  );
  return {
    baseUrl: "https://api.x.ai/v1/",
    headers: { Authorization: `Bearer ${credential.secret}`, "User-Agent": "agent-enhance/0.2.0" },
  };
}
