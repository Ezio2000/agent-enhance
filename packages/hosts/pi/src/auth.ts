import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import stripJsonComments from "strip-json-comments";
import {
  isConfiguredValue,
  sourceEnvironment,
} from "../../../integrations/services/src/sources/config-value.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CredentialResolution, CredentialResolver } from "../../../core/src/auth.ts";
import type { AuthRequirement } from "../../../core/src/contracts.ts";
import { channels } from "../../../integrations/services/src/sources/channels.ts";
import type { ServiceSource } from "../../../integrations/services/src/contracts.ts";
export class PiCredentialResolver implements CredentialResolver {
  constructor(
    private readonly registry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">,
    private readonly providerId: string,
    private readonly reloadModels?: (signal?: AbortSignal) => Promise<void>,
  ) {}
  async resolve(
    request: AuthRequirement,
    context: { signal?: AbortSignal; interactive: boolean },
  ): Promise<CredentialResolution> {
    context.signal?.throwIfAborted();
    const provider = this.providerId;
    const channel = channels[provider];
    if (!channel || channel.provider !== request.provider || channel.channel !== request.channel)
      return {
        status: "unsupported",
        guidance: `Pi authentication does not support ${request.provider}/${request.channel}.`,
      };
    const guidance = `Authenticate using Pi /login and select ${provider}.`;
    try {
      // Pi owns the credential store, refresh locking and provider-specific resolution.
      // The compatibility facade has no AbortSignal argument. Bound the caller's wait
      // without bypassing Pi's refresh lock or automatically restarting authentication.
      const signal = AbortSignal.any([
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(15_000),
      ]);
      if (this.reloadModels) await this.reloadModels(signal);
      signal.throwIfAborted();
      const resolved = await new Promise<Awaited<ReturnType<typeof this.registry.getProviderAuth>>>(
        (resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          this.registry
            .getProviderAuth(provider)
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        },
      );
      context.signal?.throwIfAborted();
      const auth = resolved?.auth;
      const headers = new Headers();
      for (const [key, value] of Object.entries(auth?.headers ?? {}))
        if (typeof value === "string") headers.set(key, value);
      const secret = auth?.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!secret) return { status: "missing", guidance };
      const kind = channel.kind;
      if (kind === "oauth" && secret.split(".").length !== 3)
        return {
          status: "login_required",
          guidance: `${guidance} This capability requires subscription OAuth, not a platform API key.`,
        };
      if (!request.acceptedKinds.includes(kind))
        return {
          status: "unsupported",
          guidance: "This channel does not accept the credential type resolved by Pi.",
        };
      return {
        status: "ready",
        credential: {
          kind,
          secret,
          accountId: headers.get("chatgpt-account-id") ?? undefined,
          baseUrl: auth?.baseUrl ?? channel.baseUrl,
        },
      };
    } catch {
      context.signal?.throwIfAborted();
      return { status: "login_required", guidance }; // Never return raw authentication errors.
    }
  }
}

export interface PiSourceOptions {
  env?: NodeJS.ProcessEnv;
  storedCredential?(provider: string):
    | {
        type: string;
        key?: string;
        env?: Record<string, string>;
        access?: string;
        refresh?: string;
        expires?: number;
      }
    | undefined;
  modelConfig?: Record<string, { apiKey?: string; env?: Record<string, string> }>;
}
export function piServiceSource(ctx: ExtensionContext, options: PiSourceOptions = {}): ServiceSource {
  return {
    id: "pi",
    async discover() {
      const env = options.env ?? process.env;
      const path = join(getAgentDir(), "models.json");
      const models =
        options.modelConfig ??
        (existsSync(path)
          ? (JSON.parse(stripJsonComments(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))).providers ?? {})
          : {});
      const readStored: NonNullable<PiSourceOptions["storedCredential"]> =
        options.storedCredential ??
        (() => {
          // Pi's one-off reader also swallows malformed JSON and I/O errors. Only a
          // missing file means no credentials; other failures must reach discovery.
          let stored: Record<string, ReturnType<NonNullable<PiSourceOptions["storedCredential"]>>>;
          try {
            stored = JSON.parse(
              readFileSync(join(getAgentDir(), "auth.json"), "utf8").replace(/^\uFEFF/, ""),
            );
            if (!stored || typeof stored !== "object" || Array.isArray(stored))
              throw new Error("Pi auth.json must contain a credential object.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            stored = {};
          }
          return (id: string) => stored[id];
        })();
      return Object.entries(channels).flatMap(([providerId, channel]) => {
        const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
        const stored = readStored(providerId);
        const extension = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
        const runtime =
          status.configured &&
          (status.source === "runtime" ||
            (channel.kind === "api_key" &&
              (status.source === "fallback" || isConfiguredValue(extension?.apiKey, env))));
        const configured =
          runtime ||
          (stored?.type === channel.kind &&
            (channel.kind === "oauth"
              ? !!(
                  stored.refresh ||
                  (stored.access && (stored.expires === undefined || stored.expires > Date.now()))
                )
              : isConfiguredValue(stored.key, sourceEnvironment(env, stored.env)))) ||
          (channel.kind === "api_key" &&
            !!(
              (channel.env && env[channel.env]) ||
              isConfiguredValue(models[providerId]?.apiKey, sourceEnvironment(env, models[providerId]?.env))
            ));
        if (!configured) return [];
        return [
          {
            id: `pi:${providerId}`,
            source: "pi",
            provider: channel.provider,
            channel: channel.channel,
            kind: channel.kind,
            label: `${providerId} · Pi`,
            credentials: new PiCredentialResolver(
              ctx.modelRegistry,
              providerId,
              // Refresh API-key configuration even after its models.json key was
              // removed, so Pi can fall back to the current environment credential.
              channel.kind === "api_key"
                ? async (signal) => {
                    await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [providerId], signal });
                  }
                : undefined,
            ),
          },
        ];
      });
    },
  };
}

export const piSourcePaths = () => [join(getAgentDir(), "auth.json"), join(getAgentDir(), "models.json")];
