import type { Static, TSchema, TObject } from "typebox";
import type { MODULE_API_VERSION } from "./module.ts";
import type { CredentialResolver } from "./auth.ts";

export type ProviderId = string;
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
  apiVersion: typeof MODULE_API_VERSION;
  id: string;
  capability: string;
  provider: ProviderId;
  auth?: AuthRequirement;
  platforms?: string[];
  /** Local runtime requirement, interpreted by the integration that supplies the module. */
  runtime?: string;
  /** Tool is only exposed while the active host model lacks every listed input modality (e.g. ["image"]). */
  modelInputExcludes?: readonly string[];
  requires?: ("approval" | "task-settled" | "request-interception")[];
}
export interface ModuleServices {
  artifactRoot: string;
  preview?: (bytes: Uint8Array, mime: string) => Promise<{ data: string; mimeType: string } | null>;
}
export type LifecycleEvent = "task_settled" | "session_shutdown" | "session_tree" | "provider_change";
export interface ModuleInstance {
  tool: ToolDefinition<any, any>;
  lifecycle?(event: LifecycleEvent, isIdle?: () => boolean): Promise<void>;
  notice?(): string | undefined;
  status?(): unknown;
  manage?(action: string): Promise<string>;
  dispose?(): Promise<void>;
}
export interface CapabilityDefinition {
  id: string;
  label: string;
  group: string;
  commonFields?: readonly string[];
  composeParameters?(schemas: readonly TObject[]): Record<string, TSchema>;
}
/** An explicit execution binding supplied by a caller; Core does not discover its source. */
export interface ModuleBinding {
  id: string;
  label: string;
  credentials: CredentialResolver;
}
export interface CapabilityModule {
  definition: CapabilityDefinition;
  manifest: ModuleManifest;
  create(services: ModuleServices): ModuleInstance;
}
