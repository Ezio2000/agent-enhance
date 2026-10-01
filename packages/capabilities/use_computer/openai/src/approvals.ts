import type { Json } from "./mcp.ts";

export type ComputerApprovalMode = "auto-app" | "ask";

export interface ApprovalEvent {
  event: "prompt" | "decision" | "cache_hit" | "cancelled";
  app?: string;
  tool?: string;
  action?: string;
  scope?: "once" | "session" | "policy";
  reason?: string;
}
export type ApprovalTrace = (event: ApprovalEvent) => void;
export type Choose = (title: string, choices: string[], signal: AbortSignal) => Promise<string | undefined>;
const ONCE = "Allow once";
const SESSION = "Allow this app for this agent session";
const DENY = "Deny";
const APP_TOOLS = new Set([
  "get_app_state",
  "click",
  "press_key",
  "type_text",
  "scroll",
  "set_value",
  "drag",
  "perform_secondary_action",
  "paste",
  "select_text",
  "start_app",
]);

/** Default automatically approves ordinary app access only.
 * This is an extension policy, not a YOLO/project-trust detector. Native policy still runs first.
 * Sensitive-action/unknown requests never inherit automatic or cached app access.
 */
export class ComputerApprovals {
  private apps = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private policyLifetime = new AbortController();
  constructor(private approvalMode: ComputerApprovalMode = "auto-app") {}
  get mode(): ComputerApprovalMode {
    return this.approvalMode;
  }
  setMode(mode: ComputerApprovalMode): void {
    if (mode !== "auto-app" && mode !== "ask") throw new Error("Invalid Computer approval mode.");
    this.clear();
    this.approvalMode = mode;
  }
  clear(): void {
    this.apps.clear();
    this.policyLifetime.abort(); // Old queued/dialog approvals must not recreate revoked grants.
    this.policyLifetime = new AbortController();
  }
  list(): string[] {
    return [...this.apps].sort();
  }
  review(
    params: Json,
    choose: Choose | undefined,
    signal: AbortSignal,
    trace?: ApprovalTrace,
  ): Promise<Json> {
    const approvalSignal = AbortSignal.any([signal, this.policyLifetime.signal]);
    const task = this.queue.then(() => this.reviewOne(params, choose, approvalSignal, trace));
    this.queue = task.catch(() => {});
    return task;
  }
  private async reviewOne(
    params: Json,
    choose: Choose | undefined,
    signal: AbortSignal,
    trace?: ApprovalTrace,
  ): Promise<Json> {
    signal.throwIfAborted();
    // Record only decision metadata, never page text, prompt text, credentials or action arguments.
    const report = (event: ApprovalEvent) =>
      trace?.({
        ...event,
        app:
          typeof params._meta?.tool_params?.app === "string"
            ? params._meta.tool_params.app.slice(0, 1024)
            : undefined,
        tool: typeof params._meta?.tool_name === "string" ? params._meta.tool_name.slice(0, 100) : undefined,
      });
    const schema = params.requestedSchema;
    // No URL auth, credential forms, or fake Guardian responses. Keep unsupported flows fail-closed.
    if (
      (params.mode && params.mode !== "form") ||
      !schema ||
      schema.type !== "object" ||
      Object.keys(schema.properties ?? {}).length ||
      (schema.required?.length ?? 0)
    ) {
      report({ event: "decision", action: "decline", reason: "unsupported_form" });
      return { action: "decline" };
    }
    const meta = params._meta ?? {};
    if (Object.entries(meta).some(([key, value]) => /strict.*review/i.test(key) && value === true)) {
      report({ event: "decision", action: "decline", reason: "strict_review" });
      return { action: "decline" };
    }
    const sensitive = Object.entries(meta).some(
      ([key, value]) => /sensitive|requires_user_input/i.test(key) && value === true,
    );
    const app = meta.tool_params?.app;
    const ordinaryApp =
      !sensitive &&
      meta.codex_request_type !== "approval_request" &&
      meta.codex_approval_kind === "mcp_tool_call" &&
      meta.connector_id === "computer-use" &&
      typeof app === "string" &&
      app.length > 0 &&
      app.length <= 1024 &&
      APP_TOOLS.has(meta.tool_name) &&
      Object.keys(meta.tool_params ?? {}).every((key) => key === "app") &&
      Array.isArray(meta.persist) &&
      meta.persist.includes("session");
    if (ordinaryApp && this.mode === "auto-app") {
      report({ event: "decision", action: "accept", scope: "policy", reason: "auto_app_access" });
      return { action: "accept" }; // Do not turn automatic access into a reusable manual grant.
    }
    if (ordinaryApp && this.apps.has(app)) {
      report({ event: "cache_hit", action: "accept", scope: "session" });
      return { action: "accept" };
    }
    if (!choose) {
      report({ event: "decision", action: "decline", reason: "no_ui" });
      return { action: "decline" };
    }
    const title = [
      "Computer Use permission",
      String(params.message ?? "Runtime requests confirmation."),
      meta.subtitle ? String(meta.subtitle) : "",
      `App: ${ordinaryApp ? app : "not a reusable app grant"}`,
      `Tool: ${String(meta.tool_name ?? "unknown")}; risk: ${String(meta.riskLevel ?? "unknown")}`,
      sensitive ? "Sensitive action: a session app grant does not authorize this request." : "",
      "Session app access is not blanket permission for sending, deleting, payments, or other consequential actions.",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000);
    report({ event: "prompt", reason: ordinaryApp ? "no_session_grant" : "not_reusable" });
    try {
      const selection = await choose(title, ordinaryApp ? [DENY, ONCE, SESSION] : [DENY, ONCE], signal);
      signal.throwIfAborted();
      if (selection === SESSION && ordinaryApp) this.apps.add(app);
      const action = selection === ONCE || (selection === SESSION && ordinaryApp) ? "accept" : "decline";
      report({
        event: "decision",
        action,
        scope: action === "accept" ? (selection === SESSION ? "session" : "once") : undefined,
      });
      return { action };
    } catch (error) {
      report({ event: "cancelled" });
      throw error;
    }
  }
}
