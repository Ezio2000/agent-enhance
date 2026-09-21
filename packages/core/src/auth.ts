import type { AuthRequirement } from "./contracts.ts";

export interface Credential {
  kind: "oauth" | "api_key";
  secret: string;
  accountId?: string;
  baseUrl?: string;
  expiresAt?: number;
}
export type CredentialResolution =
  | { status: "ready"; credential: Credential }
  | { status: "missing" | "login_required" | "unsupported"; guidance: string };
export interface CredentialResolver {
  resolve(
    request: AuthRequirement,
    context: { signal?: AbortSignal; interactive: boolean },
  ): Promise<CredentialResolution>;
}
export class EnhanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "EnhanceError";
  }
}
export async function requireCredential(
  resolver: CredentialResolver,
  requirement: AuthRequirement,
  signal?: AbortSignal,
): Promise<Credential> {
  signal?.throwIfAborted();
  const result = await resolver.resolve(requirement, { signal, interactive: false });
  signal?.throwIfAborted();
  if (result.status !== "ready")
    throw new EnhanceError(`AUTH_${result.status.toUpperCase()}`, result.guidance);
  if (!requirement.acceptedKinds.includes(result.credential.kind))
    throw new EnhanceError("AUTH_KIND", "Credential type is not supported by this channel.");
  if (!result.credential.secret)
    throw new EnhanceError("AUTH_EMPTY", "The host returned an empty credential.");
  return result.credential;
}
/** Standalone/test host. Sources must be explicitly configured; never searches another agent's files. */
export class StaticCredentialResolver implements CredentialResolver {
  constructor(private readonly credentials: Readonly<Record<string, Credential>>) {}
  async resolve(request: AuthRequirement): Promise<CredentialResolution> {
    const credential = this.credentials[`${request.provider}/${request.channel}`];
    return credential
      ? { status: "ready", credential }
      : {
          status: "missing",
          guidance: `Configure ${request.provider}/${request.channel} credentials in this host.`,
        };
  }
}
