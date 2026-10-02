import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential } from "../../../../core/src/auth.ts";
import { withFileLock, writeFileAtomic } from "./lock.ts";
// ---- Codex (ChatGPT) OAuth, owned by the Codex CLI login state -----------------------------------
// Codex refresh tokens rotate, so the refresh is serialized with the same lock-file convention as
// other readers of ~/.codex/auth.json, and the file is re-read inside the lock.
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_MARGIN_MS = 120_000;
export const codexAuthPath = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
function jwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}
const jwtExpiry = (token: string) => {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
};
export const jwtAccount = (token: string) => {
  const auth = jwtPayload(token)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
};
const fresh = (expires: number | undefined, margin: number) =>
  expires === undefined || expires - margin > Date.now();
interface CodexFile {
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string };
  [key: string]: unknown;
}
export function codexConfigured(auth: CodexFile | undefined): boolean {
  return !!(
    auth?.tokens?.refresh_token ||
    (auth?.tokens?.access_token && fresh(jwtExpiry(auth.tokens.access_token), CODEX_MARGIN_MS))
  );
}
export async function readCodex(path = codexAuthPath()): Promise<CodexFile | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CodexFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${path} is unreadable; run \`codex login\` again.`);
  }
}
export async function codexCredential(
  signal?: AbortSignal,
  path = codexAuthPath(),
): Promise<Credential | undefined> {
  const quick = await readCodex(path);
  const token = quick?.tokens?.access_token;
  if (token && fresh(jwtExpiry(token), CODEX_MARGIN_MS))
    return {
      kind: "oauth",
      secret: token,
      accountId: quick.tokens?.account_id ?? jwtAccount(token),
      expiresAt: jwtExpiry(token),
    };
  if (!quick?.tokens?.refresh_token) return undefined;
  return withFileLock(path, async () => {
    const auth = await readCodex(path);
    const current = auth?.tokens?.access_token;
    if (current && fresh(jwtExpiry(current), CODEX_MARGIN_MS))
      return {
        kind: "oauth",
        secret: current,
        accountId: auth.tokens?.account_id ?? jwtAccount(current),
        expiresAt: jwtExpiry(current),
      };
    const refresh = auth?.tokens?.refresh_token;
    if (!refresh) return undefined;
    const data = await requestRefresh(refresh, signal);
    const accountId = auth.tokens?.account_id ?? jwtAccount(data.access_token);
    await writeFileAtomic(
      path,
      JSON.stringify(
        {
          ...auth,
          tokens: {
            ...auth.tokens,
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            ...(typeof data.id_token === "string" ? { id_token: data.id_token } : {}),
            ...(accountId ? { account_id: accountId } : {}),
          },
          last_refresh: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return { kind: "oauth", secret: data.access_token, accountId, expiresAt: jwtExpiry(data.access_token) };
  });
}

async function requestRefresh(refresh: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CODEX_CLIENT_ID,
    }),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string" || typeof data.refresh_token !== "string")
    throw new Error(`Codex token refresh failed (HTTP ${response.status}); run \`codex login\` again.`);
  return data;
}
export async function refreshCodex(
  refresh: string,
  signal?: AbortSignal,
): Promise<{ access: string; refresh: string; expires: number }> {
  const data = await requestRefresh(refresh, signal);
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires:
      Date.now() + (typeof data.expires_in === "number" ? data.expires_in * 1000 : 3600000) - CODEX_MARGIN_MS,
  };
}
