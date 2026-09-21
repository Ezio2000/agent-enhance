import type { ExecutionContext } from "../../../core/src/contracts.ts";
import { requireCredential } from "../../../core/src/auth.ts";
import type { ProtocolAuth } from "./types.ts";
export async function resolveOpencodeGoAuth(
  ctx: Pick<ExecutionContext, "credentials" | "signal">,
): Promise<ProtocolAuth> {
  const credential = await requireCredential(
    ctx.credentials,
    { provider: "opencode", channel: "go", acceptedKinds: ["api_key"] },
    ctx.signal,
  );
  const url = new URL(credential.baseUrl ?? "https://opencode.ai/zen/go/v1/");
  if (
    url.origin !== "https://opencode.ai" ||
    !url.pathname.startsWith("/zen/go/") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Unrecognized opencode-go endpoint; refusing to send credentials.");
  return {
    baseUrl: url.toString().replace(/\/?$/, "/"),
    headers: { Authorization: `Bearer ${credential.secret}`, "User-Agent": "agent-enhance/0.2.0" },
  };
}
