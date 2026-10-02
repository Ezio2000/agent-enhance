import type { CredentialResolver } from "../../../core/src/auth.ts";
import type { ProviderId } from "../../../core/src/contracts.ts";

/** A discovered connection is runtime data. Its ID survives credential refresh. */
export interface ServiceConnection {
  id: string;
  provider: ProviderId;
  channel: string;
  kind: "oauth" | "api_key" | "runtime";
  source: string;
  label: string;
  credentials: CredentialResolver;
}
export interface ServiceSource {
  id: string;
  discover(): Promise<ServiceConnection[]>;
}
export interface ServiceSnapshot {
  connections: ServiceConnection[];
  errors: Record<string, string>;
}
export async function discoverServices(sources: readonly ServiceSource[]): Promise<ServiceSnapshot> {
  const results = await Promise.allSettled(sources.map((source) => source.discover()));
  const connections = new Map<string, ServiceConnection>();
  const errors: Record<string, string> = {};
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      errors[sources[index]!.id] =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      return;
    }
    for (const connection of result.value) {
      if (connections.has(connection.id)) throw new Error(`Duplicate service connection: ${connection.id}`);
      connections.set(connection.id, connection);
    }
  });
  return { connections: [...connections.values()], errors };
}
