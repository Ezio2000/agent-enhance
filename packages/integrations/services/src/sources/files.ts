import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Credential, CredentialResolution, CredentialResolver } from "../../../../core/src/auth.ts";
import { StaticCredentialResolver } from "../../../../core/src/auth.ts";
import type { ServiceConnection, ServiceSource } from "../contracts.ts";
import { resolveConfiguredValue, isConfiguredValue, sourceEnvironment } from "./config-value.ts";
import { channels, type ChannelDefinition } from "./channels.ts";
import {
  codexAuthPath,
  codexCredential,
  readCodex,
  codexConfigured,
  refreshCodex,
  jwtAccount,
} from "./codex.ts";
import { refreshXai } from "./xai.ts";
import { withFileLock, writeFileAtomic } from "./lock.ts";

type AuthEntry = Record<string, any>;
export interface FileSourceOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
  platform?: string;
  /** The Pi host uses its native resolver instead of scanning Pi's file or environment again. */
  nativePi?: boolean;
}
export function sourcePaths(options: FileSourceOptions): string[] {
  const env = options.env ?? process.env,
    root = options.userHome ?? homedir();
  return [
    join(env.CODEX_HOME ?? join(root, ".codex"), "auth.json"),
    join(env.PI_CODING_AGENT_DIR ?? join(root, ".pi", "agent"), "auth.json"),
    join(env.XDG_DATA_HOME ?? join(root, ".local", "share"), "opencode", "auth.json"),
    join(options.home, "credentials.json"),
    env.OPENAI_CODEX_COMPUTER_APP ?? "/Applications/ChatGPT.app",
  ];
}
async function readObject(path: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected a JSON object");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `Cannot discover services from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function resolver(
  def: ChannelDefinition,
  resolve: (signal?: AbortSignal) => Promise<Credential | undefined>,
  guidance: string,
): CredentialResolver {
  return {
    async resolve(request, context): Promise<CredentialResolution> {
      context.signal?.throwIfAborted();
      if (
        request.provider !== def.provider ||
        request.channel !== def.channel ||
        !request.acceptedKinds.includes(def.kind)
      )
        return {
          status: "unsupported",
          guidance: "Selected service does not support this authentication channel.",
        };
      try {
        const credential = await resolve(context.signal);
        context.signal?.throwIfAborted();
        if (!credential?.secret) return { status: "missing", guidance };
        return { status: "ready", credential };
      } catch (error) {
        context.signal?.throwIfAborted();
        return {
          status: "login_required",
          guidance: `${error instanceof Error ? error.message : String(error)} ${guidance}`,
        };
      }
    },
  };
}
function connection(
  id: string,
  source: string,
  def: ChannelDefinition,
  credentials: CredentialResolver,
): ServiceConnection {
  return {
    id,
    source: source === "Agent Enhance" ? "agent-enhance" : source.toLowerCase(),
    label: `${def.provider} · ${def.channel} · ${source}${def.baseUrl ? ` · ${new URL(def.baseUrl).hostname}` : ""}`,
    ...def,
    credentials,
  };
}
const oauthConfigured = (entry: AuthEntry) =>
  !!(entry.refresh || (entry.access && (entry.expires === undefined || entry.expires > Date.now())));
async function piCredential(
  path: string,
  provider: string,
  def: ChannelDefinition,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Credential | undefined> {
  const entry = (await readObject(path))[provider] as AuthEntry | undefined;
  if (!entry) return;
  if (def.kind === "api_key") {
    if (entry.type !== "api_key" || typeof entry.key !== "string") return;
    return {
      kind: "api_key",
      secret: await resolveConfiguredValue(entry.key, sourceEnvironment(env, entry.env), signal),
      baseUrl: def.baseUrl,
    };
  }
  if (entry.type !== "oauth") return;
  const current = (value: AuthEntry): Credential => ({
    kind: "oauth",
    secret: value.access,
    accountId: value.accountId ?? jwtAccount(value.access),
    expiresAt: value.expires,
  });
  if (entry.access && (entry.expires === undefined || entry.expires > Date.now())) return current(entry);
  if (!entry.refresh) return;
  // Pi's own credential store uses proper-lockfile directories and a heartbeat. Reuse that protocol.
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 15, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
  });
  try {
    signal?.throwIfAborted();
    const file = await readObject(path),
      latest = file[provider] as AuthEntry | undefined;
    if (!latest || latest.type !== "oauth") return;
    if (latest.access && (latest.expires === undefined || latest.expires > Date.now()))
      return current(latest);
    const refreshed =
      provider === "xai"
        ? await refreshXai(latest.refresh, signal)
        : await refreshCodex(latest.refresh, signal);
    file[provider] = {
      ...latest,
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
    };
    await writeFileAtomic(path, JSON.stringify(file, null, 2) + "\n");
    return current(file[provider]);
  } finally {
    await release();
  }
}
export function fileSources(options: FileSourceOptions): ServiceSource[] {
  const env = options.env ?? process.env;
  const [codexPath, piPath, opencodePath, ownPath, desktopPath] = sourcePaths(options) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const sources: ServiceSource[] = [
    {
      id: "codex",
      async discover() {
        const auth = await readCodex(codexPath),
          tokens = auth?.tokens;
        if (!codexConfigured(auth)) return [];
        const def = channels["openai-codex"]!;
        return [
          connection(
            "codex:openai-codex",
            "Codex",
            def,
            resolver(
              def,
              (signal) => codexCredential(signal, codexPath),
              "Run codex login, then refresh services.",
            ),
          ),
        ];
      },
    },
    {
      id: "opencode",
      async discover() {
        const content = () =>
          env.OPENCODE_AUTH_CONTENT
            ? Promise.resolve(JSON.parse(env.OPENCODE_AUTH_CONTENT) as Record<string, AuthEntry>)
            : readObject(opencodePath);
        const file = await content(),
          def = channels["opencode-go"]!;
        const entry = file["opencode-go"];
        if (entry?.type !== "api" || !entry.key) return [];
        return [
          connection(
            "opencode:opencode-go",
            "OpenCode",
            def,
            resolver(
              def,
              async () => {
                const latest = (await content())["opencode-go"];
                return latest?.type === "api"
                  ? { kind: "api_key", secret: latest.key, baseUrl: def.baseUrl }
                  : undefined;
              },
              "Configure the OpenCode Go connection in OpenCode.",
            ),
          ),
        ];
      },
    },
    {
      id: "agent-enhance",
      async discover() {
        const file = await readObject(ownPath);
        if (!Object.keys(file).length) return [];
        if (file.version !== 1 || !file.credentials || typeof file.credentials !== "object")
          throw new Error(`Invalid credential source: ${ownPath}`);
        const result: ServiceConnection[] = [];
        for (const [channel, entry] of Object.entries(file.credentials) as [string, AuthEntry][]) {
          const def = Object.values(channels).find(
            (c) => `${c.provider}/${c.channel}` === channel && c.kind === entry.kind,
          );
          if (
            !def ||
            (entry.kind === "oauth"
              ? !oauthConfigured(entry)
              : !isConfiguredValue(entry.key, sourceEnvironment(env, entry.env)))
          )
            continue;
          const selected = { ...def, baseUrl: entry.baseUrl ?? def.baseUrl };
          result.push(
            connection(
              `agent-enhance:${channel}`,
              "Agent Enhance",
              selected,
              resolver(
                def,
                async (signal) => {
                  const latest = (await readObject(ownPath)).credentials?.[channel] as AuthEntry | undefined;
                  if (!latest || latest.kind !== def.kind) return;
                  if (latest.kind === "api_key")
                    return {
                      kind: "api_key",
                      secret: await resolveConfiguredValue(
                        latest.key,
                        sourceEnvironment(env, latest.env),
                        signal,
                      ),
                      baseUrl: latest.baseUrl ?? def.baseUrl,
                    };
                  if (latest.expires === undefined || latest.expires > Date.now())
                    return { kind: "oauth", secret: latest.access, expiresAt: latest.expires };
                  if (def.provider !== "xai")
                    throw new Error(`No OAuth refresh implementation for ${channel}`);
                  return withFileLock(ownPath, async () => {
                    const file = await readObject(ownPath),
                      now = file.credentials?.[channel] as AuthEntry | undefined;
                    if (!now || now.kind !== "oauth") return;
                    if (now.expires <= Date.now()) {
                      file.credentials[channel] = { ...now, ...(await refreshXai(now.refresh, signal)) };
                      await writeFileAtomic(ownPath, JSON.stringify(file, null, 2) + "\n");
                    }
                    const token = file.credentials[channel];
                    return { kind: "oauth", secret: token.access, expiresAt: token.expires };
                  });
                },
                `Authenticate ${def.provider} in its original account source.`,
              ),
            ),
          );
        }
        return result;
      },
    },
    {
      id: "desktop",
      async discover() {
        return (options.platform ?? process.platform) === "darwin" && existsSync(desktopPath)
          ? [
              {
                id: "local:chatgpt-desktop",
                source: "desktop",
                label: "ChatGPT desktop runtime",
                provider: "openai",
                channel: "chatgpt-desktop",
                kind: "runtime",
                credentials: new StaticCredentialResolver({}),
              },
            ]
          : [];
      },
    },
  ];
  if (!options.nativePi)
    sources.push(
      {
        id: "pi",
        async discover() {
          const file = await readObject(piPath),
            result: ServiceConnection[] = [];
          for (const [provider, def] of Object.entries(channels)) {
            const entry = file[provider] as AuthEntry | undefined;
            if (
              !entry ||
              (def.kind === "oauth"
                ? entry.type !== "oauth" || !oauthConfigured(entry)
                : entry.type !== "api_key" ||
                  !isConfiguredValue(entry.key, sourceEnvironment(env, entry.env)))
            )
              continue;
            result.push(
              connection(
                `pi:${provider}`,
                "Pi",
                def,
                resolver(
                  def,
                  (signal) => piCredential(piPath, provider, def, env, signal),
                  `Authenticate ${provider} using Pi /login.`,
                ),
              ),
            );
          }
          return result;
        },
      },
      {
        id: "environment",
        async discover() {
          return Object.values(channels)
            .filter((def) => def.env && env[def.env])
            .map((def) =>
              connection(
                `env:${def.env}`,
                "Environment",
                def,
                resolver(
                  def,
                  async () => ({ kind: "api_key", secret: env[def.env!] ?? "", baseUrl: def.baseUrl }),
                  `Set ${def.env}.`,
                ),
              ),
            );
        },
      },
    );
  return sources;
}
