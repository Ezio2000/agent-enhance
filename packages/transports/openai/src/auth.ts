import type { ExecutionContext } from "../../../core/src/contracts.ts";
import { requireCredential } from "../../../core/src/auth.ts";
import type { ProtocolAuth } from "./types.ts";

export function codexBaseURL(raw = "https://chatgpt.com/backend-api"): string {
  const url = new URL(raw);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.search || url.hash)
    throw new Error("Refusing to send Codex credentials to an untrusted endpoint.");
  if (
    !["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(
      url.pathname.replace(/\/+$/, ""),
    )
  )
    throw new Error("Unrecognized Codex provider base URL.");
  return "https://chatgpt.com/backend-api/codex/";
}
export async function resolveCodexAuth(
  ctx: Pick<ExecutionContext, "credentials" | "signal">,
): Promise<ProtocolAuth> {
  const credential = await requireCredential(
    ctx.credentials,
    { provider: "openai", channel: "codex", acceptedKinds: ["oauth"] },
    ctx.signal,
  );
  let accountId = credential.accountId;
  if (!accountId) {
    try {
      const payload = JSON.parse(
        Buffer.from(credential.secret.split(".")[1] ?? "", "base64url").toString("utf8"),
      );
      const value = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof value === "string" && value) accountId = value;
    } catch {
      /* Never expose a token or raw parser error. */
    }
  }
  if (!accountId) throw new Error("Codex credential is missing its account ID; reauthenticate in the host.");
  return {
    baseUrl: codexBaseURL(credential.baseUrl),
    headers: {
      Authorization: `Bearer ${credential.secret}`,
      "chatgpt-account-id": accountId,
      originator: "pi",
      "User-Agent": "agent-enhance/0.2.0",
    },
  };
}
