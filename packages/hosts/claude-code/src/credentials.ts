import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialResolution, CredentialResolver } from "../../../core/src/auth.ts";
import type { AuthRequirement } from "../../../core/src/contracts.ts";
import { credentialsPath } from "./paths.ts";
import { withFileLock, writeFileAtomic } from "./lock.ts";
import { refreshXai, type OAuthTokens } from "./xai.ts";

export interface ApiKeyEntry {
  kind: "api_key";
  key: string;
  baseUrl?: string;
}
export type StoredCredential = ApiKeyEntry | OAuthTokens;
export interface CredentialFile {
  version: 1;
  /** Keyed by `provider/channel` (e.g. `zai/coding-plan`). Plaintext by design. */
  credentials: Record<string, StoredCredential>;
}
/** provider/channel pairs managed by this host, and the login hint shown when missing. */
export const CHANNELS: Record<string, { provider: string; login: string }> = {
  "openai/codex": {
    provider: "openai",
    login: "Run `codex login` (Codex CLI, ChatGPT account); cc-enhance reads ~/.codex/auth.json.",
  },
  "xai/imagine": { provider: "xai", login: "/cc-enhance login xai" },
  "opencode/go": { provider: "opencode", login: "/cc-enhance login opencode <api-key>" },
  "minimax/token-plan": { provider: "minimax", login: "/cc-enhance login minimax <sk-cp-key> [--global]" },
  "zai/coding-plan": { provider: "zai", login: "/cc-enhance login zai <api-key> [--cn]" },
};

export class CredentialStore {
  readonly path: string;
  constructor(home: string) {
    this.path = credentialsPath(home);
  }
  async read(): Promise<CredentialFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, credentials: {} };
      throw error;
    }
    const parsed = JSON.parse(text) as CredentialFile;
    if (parsed?.version !== 1 || !parsed.credentials || typeof parsed.credentials !== "object")
      throw new Error(`Unsupported credential file ${this.path}; not overwritten.`);
    return parsed;
  }
  async update(
    fn: (file: CredentialFile) => CredentialFile | Promise<CredentialFile>,
  ): Promise<CredentialFile> {
    return withFileLock(this.path, async () => {
      const next = await fn(await this.read());
      await writeFileAtomic(this.path, JSON.stringify(next, null, 2) + "\n");
      return next;
    });
  }
  set(channel: string, entry: StoredCredential | undefined): Promise<CredentialFile> {
    return this.update((file) => {
      const credentials = { ...file.credentials };
      if (entry) credentials[channel] = entry;
      else delete credentials[channel];
      return { version: 1, credentials };
    });
  }
}

// ---- Codex (ChatGPT) OAuth, owned by the Codex CLI login state -----------------------------------
// Codex refresh tokens rotate, so the refresh is serialized with the same lock-file convention as
// other readers of ~/.codex/auth.json, and the file is re-read inside the lock.
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_MARGIN_MS = 120_000;
export const codexAuthPath = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
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
const jwtAccount = (token: string) => {
  const auth = jwtPayload(token)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
};
const fresh = (expires: number | undefined, margin: number) =>
  expires === undefined || expires - margin > Date.now();
interface CodexFile {
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string };
  [key: string]: unknown;
}
async function readCodex(): Promise<CodexFile | undefined> {
  try {
    return JSON.parse(await readFile(codexAuthPath(), "utf8")) as CodexFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${codexAuthPath()} is unreadable; run \`codex login\` again.`);
  }
}
export async function codexCredential(signal?: AbortSignal): Promise<Credential | undefined> {
  const quick = await readCodex();
  const token = quick?.tokens?.access_token;
  if (token && fresh(jwtExpiry(token), CODEX_MARGIN_MS))
    return {
      kind: "oauth",
      secret: token,
      accountId: quick.tokens?.account_id ?? jwtAccount(token),
      expiresAt: jwtExpiry(token),
    };
  if (!quick?.tokens?.refresh_token) return undefined;
  return withFileLock(codexAuthPath(), async () => {
    const auth = await readCodex();
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
    const accountId = auth.tokens?.account_id ?? jwtAccount(data.access_token);
    await writeFileAtomic(
      codexAuthPath(),
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

// ---- Resolver ----------------------------------------------------------------------------------
const OAUTH_REFRESHERS: Record<string, (refresh: string, signal?: AbortSignal) => Promise<OAuthTokens>> = {
  "xai/imagine": refreshXai,
};
export class ClaudeCodeCredentialResolver implements CredentialResolver {
  readonly store: CredentialStore;
  constructor(home: string) {
    this.store = new CredentialStore(home);
  }
  async resolve(
    request: AuthRequirement,
    context: { signal?: AbortSignal; interactive: boolean },
  ): Promise<CredentialResolution> {
    context.signal?.throwIfAborted();
    const channel = `${request.provider}/${request.channel}`;
    const hint = CHANNELS[channel]?.login;
    if (!hint)
      return { status: "unsupported", guidance: `cc-enhance has no credential source for ${channel}.` };
    try {
      const credential =
        channel === "openai/codex"
          ? await codexCredential(context.signal)
          : await this.stored(channel, context.signal);
      if (!credential) return { status: "missing", guidance: `Not logged in for ${channel}. ${hint}` };
      if (!request.acceptedKinds.includes(credential.kind))
        return {
          status: "unsupported",
          guidance: `${channel} does not accept ${credential.kind} credentials. ${hint}`,
        };
      return { status: "ready", credential };
    } catch (error) {
      context.signal?.throwIfAborted();
      return { status: "login_required", guidance: `${(error as Error).message} ${hint}` };
    }
  }
  private async stored(channel: string, signal?: AbortSignal): Promise<Credential | undefined> {
    const entry = (await this.store.read()).credentials[channel];
    if (!entry) return undefined;
    if (entry.kind === "api_key") return { kind: "api_key", secret: entry.key, baseUrl: entry.baseUrl };
    if (fresh(entry.expires, 0)) return { kind: "oauth", secret: entry.access, expiresAt: entry.expires };
    const refresher = OAUTH_REFRESHERS[channel];
    if (!refresher) throw new Error(`${channel} token expired.`);
    // Re-read inside the lock: another cc-enhance process may already have rotated the token.
    const next = await this.store.update(async (file) => {
      const current = file.credentials[channel];
      if (current?.kind !== "oauth") throw new Error(`${channel} login was removed.`);
      if (fresh(current.expires, 0)) return file;
      return {
        version: 1,
        credentials: { ...file.credentials, [channel]: await refresher(current.refresh, signal) },
      };
    });
    const refreshed = next.credentials[channel] as OAuthTokens;
    return { kind: "oauth", secret: refreshed.access, expiresAt: refreshed.expires };
  }
}
