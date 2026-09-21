export interface ProtocolAuth {
  baseUrl: string;
  headers: Record<string, string>;
}
export type ResolveAuth = () => Promise<ProtocolAuth>;
export interface ProtocolResult<T> {
  data: T;
  requestId?: string;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
