import type { Static, TSchema } from "typebox";
import type { CredentialResolver } from "./auth.ts";

export type ProviderId = "openai" | "xai" | "opencode";
export interface ModelInfo {
  id: string;
  provider: string;
  channel?: string;
  api?: string;
  input?: readonly string[];
}
export type Content =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string; text?: never };
export interface ToolResult<D = Record<string, unknown>> {
  content: Content[];
  details: D;
}
export interface HistoryMessage {
  role: string;
  content?: unknown;
}
export interface ExecutionContext {
  cwd: string;
  sessionId: string;
  host: string;
  credentials: CredentialResolver;
  signal?: AbortSignal;
  model?: ModelInfo;
  /** Explicit host-filtered conversation entries. Never credentials or system prompts. */
  history?: readonly HistoryMessage[];
  choose?: (title: string, choices: string[], signal: AbortSignal) => Promise<string | undefined>;
}
export interface ToolDefinition<S extends TSchema = TSchema, D = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: S;
  execute(
    callId: string,
    args: Static<S>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: ToolResult<D>) => void) | undefined,
    context: ExecutionContext,
  ): Promise<ToolResult<D>>;
}
export interface AuthRequirement {
  provider: ProviderId;
  channel: string;
  acceptedKinds: readonly ("oauth" | "api_key")[];
  scopes?: readonly string[];
}
export interface ModuleManifest {
  apiVersion: 1;
  id: string;
  capability: string;
  provider: ProviderId;
  kind: "tool" | "request-control";
  version: string;
  auth?: AuthRequirement;
  platforms?: string[];
  requires?: ("approval" | "task-settled" | "request-interception")[];
}
export interface ModuleServices {
  artifactRoot: string;
  preview?: (bytes: Uint8Array, mime: string) => Promise<{ data: string; mimeType: string } | null>;
}
export type LifecycleEvent = "task_settled" | "session_shutdown" | "session_tree" | "provider_change";
export interface ModuleInstance {
  tool?: ToolDefinition<any, any>;
  control?: import("./controls.ts").RequestControl;
  lifecycle?(event: LifecycleEvent, isIdle?: () => boolean): Promise<void>;
  notice?(): string | undefined;
  status?(): unknown;
  check?(): Promise<void>;
  manage?(action: string): Promise<string>;
  dispose?(): Promise<void>;
}
export interface CapabilityModule {
  manifest: ModuleManifest;
  create(services: ModuleServices): ModuleInstance;
}
