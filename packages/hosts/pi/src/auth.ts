import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CredentialResolution, CredentialResolver } from "../../../core/src/auth.ts";
import type { AuthRequirement } from "../../../core/src/contracts.ts";
const channels: Record<string, string> = {
  "openai/codex": "openai-codex",
  "xai/imagine": "xai",
  "opencode/go": "opencode-go",
  "minimax/token-plan": "minimax-cn",
};
export class PiCredentialResolver implements CredentialResolver {
  constructor(private readonly registry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">) {}
  async resolve(
    request: AuthRequirement,
    context: { signal?: AbortSignal; interactive: boolean },
  ): Promise<CredentialResolution> {
    context.signal?.throwIfAborted();
    const provider = channels[`${request.provider}/${request.channel}`];
    if (!provider)
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
      const kind = ["opencode-go", "minimax-cn", "minimax"].includes(provider) ? "api_key" : "oauth";
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
          baseUrl: auth?.baseUrl,
        },
      };
    } catch {
      context.signal?.throwIfAborted();
      return { status: "login_required", guidance }; // Never return raw authentication errors.
    }
  }
}
