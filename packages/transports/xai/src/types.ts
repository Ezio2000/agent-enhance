export interface ProtocolAuth {
  baseUrl: string;
  headers: Record<string, string>;
}
export type ResolveAuth = () => Promise<ProtocolAuth>;
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
