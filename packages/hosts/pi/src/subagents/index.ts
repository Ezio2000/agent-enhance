import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CapabilityRegistry } from "../../../../core/src/registry.ts";
import { runSubagent, type SubagentOutcome, type SubagentProgress, type SubagentTask } from "./runner.ts";

const TaskSchema = Type.Object(
  {
    context: Type.String({
      minLength: 1,
      maxLength: 100_000,
      description:
        "Complete task and context for this independent Pi agent. The parent transcript is not copied.",
    }),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 32,
        description:
          "Exact Pi tool names. Omit or use [] for no tools. Only currently active parent tools may be requested.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Exact provider/model-id from view_subagent_models. Overrides the saved subagent default; otherwise inherits the current Pi model.",
      }),
    ),
    thinking_level: Type.Optional(
      Type.Union(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((x) => Type.Literal(x)) as [
          ReturnType<typeof Type.Literal>,
          ...ReturnType<typeof Type.Literal>[],
        ],
      ),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Child working directory; defaults to the parent cwd. Not a filesystem sandbox.",
      }),
    ),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 2_147_483,
        description: "Optional wall-clock limit. Omitted means no agent-enhance time limit.",
      }),
    ),
    max_turns: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1_000_000,
        description: "Optional Pi agent-turn limit. Omitted means no agent-enhance turn limit.",
      }),
    ),
  },
  { additionalProperties: false },
);
const CallSchema = Type.Object(
  { tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 8 }) },
  { additionalProperties: false },
);
const ModelsSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ description: "Filter by provider, ID or name" })),
    input: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")])),
    reasoning: Type.Optional(Type.Boolean()),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
const ViewSchema = Type.Object(
  {
    batchId: Type.Optional(Type.String({ description: "Batch ID returned by call_subagents" })),
    id: Type.Optional(Type.String({ description: "Task ID returned by call_subagents or view_subagents" })),
  },
  { additionalProperties: false },
);
const CancelSchema = Type.Object(
  { batchId: Type.String({ minLength: 1, description: "Batch ID to cancel" }) },
  { additionalProperties: false },
);
const HOST_TOOLS = new Set(["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"]);
const EFFECTFUL = new Set([
  "edit",
  "write",
  "bash",
  "powershell",
  "gen_image",
  "gen_video",
  "gen_voice",
  "use_computer",
]);
const BUILTIN = new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Pi's Model metadata semantics: xhigh/max require an explicit mapping.
export function thinkingLevels(model: ModelChoice): Thinking[] {
  if (!model.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
  }) as Thinking[];
}
const PAGE_SIZE = 30;
const MAX_RUNNING = 4;
const MAX_QUEUED = 32;
const OUTPUT_CHARS = 12_000;
const PREVIEW_CHARS = 400;
const HISTORY_LIMIT = 24;

type ModelChoice = NonNullable<ExtensionContext["model"]>;
type Thinking = NonNullable<ExtensionContext["thinkingLevel"]>;
interface PreparedTask {
  task: SubagentTask;
  model: ModelChoice;
  thinking: Thinking;
}
interface TaskState {
  id: string;
  status: "queued" | "running" | "cancelling" | SubagentOutcome["status"];
  startedAt?: number;
  finishedAt?: number;
  progress?: SubagentProgress;
}
interface Batch {
  id: string;
  createdAt: number;
  finishedAt?: number;
  states: TaskState[];
  owner: string;
  anchor: string | null;
  sessionManager: ExtensionContext["sessionManager"];
  controller: AbortController;
  tasks: PreparedTask[];
  modelRegistry: ExtensionContext["modelRegistry"];
  results: SubagentOutcome[];
}
export class Subagents {
  private readonly batches = new Map<string, Batch>();
  private readonly history = new Map<string, Batch>();
  private readonly renderWatchers = new Map<string, Set<() => void>>();
  private readonly pendingRenders = new Map<string, ReturnType<typeof setTimeout>>();
  private renderTimer: ReturnType<typeof setInterval> | undefined;
  private activeRunners = 0;
  private readonly waiters: Array<() => void> = [];
  private owner: string | undefined;
  private enabled = false;
  private defaultModel: string | undefined;
  private closed = false;
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registry: CapabilityRegistry,
    private readonly runner: typeof runSubagent = runSubagent,
  ) {
    pi.registerMessageRenderer("pi-enhance:subagents", (message, { expanded, outputPad }, theme) => {
      const details = message.details as
        | {
            batchId?: string;
            results?: SubagentOutcome[];
            taskIds?: string[];
            elapsedMs?: number;
            taskElapsedMs?: number[];
          }
        | undefined;
      const results = details?.results ?? [];
      const good = results.filter((r) => r.status === "completed").length;
      const lines = [
        theme.fg("accent", theme.bold("SUBAGENTS")) + theme.fg("muted", `  ${details?.batchId ?? "batch"}`),
      ];
      lines.push(
        theme.fg(
          results.length && good === results.length ? "success" : "warning",
          results.length ? `${good}/${results.length} completed` : "Batch error",
        ) +
          theme.fg(
            "muted",
            ` · ${results.length ? "final results" : "details"}${details?.elapsedMs !== undefined ? ` · ${(details.elapsedMs / 1000).toFixed(1)}s` : ""}`,
          ),
      );
      for (const result of results) {
        const color = result.status === "completed" ? "success" : "warning";
        lines.push(
          theme.fg(
            color,
            `${result.status === "completed" ? "✓" : "!"} Task ${result.index + 1} · ${result.status}`,
          ) + theme.fg("muted", ` · ${result.model} · ${result.turns} turns`),
        );
        if (expanded) {
          lines.push(
            theme.fg(
              "muted",
              `  id ${details?.taskIds?.[result.index] ?? "—"} · ${details?.taskElapsedMs?.[result.index] === undefined ? "—" : `${(details.taskElapsedMs[result.index]! / 1000).toFixed(1)}s`} · ${result.usage.input} in / ${result.usage.output} out · $${result.usage.cost.toFixed(4)}`,
            ),
          );
          lines.push(result.text.slice(0, OUTPUT_CHARS));
        } else lines.push(theme.fg("dim", result.text.replace(/\s+/g, " ").slice(0, 160)));
      }
      if (!results.length)
        lines.push(
          typeof message.content === "string"
            ? message.content.slice(0, expanded ? 2500 : 300)
            : "(no results)",
        );
      const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(lines.join("\n"), 0, 0));
      return box;
    });
  }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  isEnabled(): boolean {
    return this.enabled;
  }
  setDefaultModel(model: string | undefined): void {
    this.defaultModel = model;
  }
  getDefaultModel(): string | undefined {
    return this.defaultModel;
  }
  startSession(sessionId: string): void {
    if (this.owner && this.owner !== sessionId) this.cancelAll();
    this.owner = sessionId;
    this.closed = false;
  }
  cancelAll(): void {
    for (const batch of this.batches.values()) batch.controller.abort();
    this.batches.clear();
    this.history.clear();
    this.renderWatchers.clear();
    for (const timer of this.pendingRenders.values()) clearTimeout(timer);
    this.pendingRenders.clear();
    this.stopRenderTimer();
  }
  shutdown(): void {
    this.closed = true;
    this.cancelAll();
    this.owner = undefined;
  }
  cancel(id: string): boolean {
    const batch = this.batches.get(id);
    if (!batch) return false;
    batch.controller.abort();
    for (const state of batch.states) {
      if (state.status === "queued") {
        state.status = "cancelled";
        state.finishedAt = Date.now();
      } else if (state.status === "running") state.status = "cancelling";
    }
    this.notifyRender(batch.id);
    return true;
  }
  private stopRenderTimer(): void {
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = undefined;
  }
  private notifyRender(id: string): void {
    const pending = this.pendingRenders.get(id);
    if (pending) clearTimeout(pending);
    this.pendingRenders.delete(id);
    for (const invalidate of this.renderWatchers.get(id) ?? []) invalidate();
  }
  private scheduleRender(id: string): void {
    if (!this.renderWatchers.has(id) || this.pendingRenders.has(id)) return;
    const timer = setTimeout(() => this.notifyRender(id), 200);
    timer.unref();
    this.pendingRenders.set(id, timer);
  }
  private watchRender(id: string, invalidate: () => void): void {
    let watchers = this.renderWatchers.get(id);
    if (!watchers) {
      watchers = new Set();
      this.renderWatchers.set(id, watchers);
    }
    watchers.add(invalidate);
    if (!this.renderTimer) {
      this.renderTimer = setInterval(() => {
        for (const batchId of this.renderWatchers.keys()) this.notifyRender(batchId);
      }, 1000);
      this.renderTimer.unref();
    }
  }
  private finishRender(id: string): void {
    this.notifyRender(id);
    this.renderWatchers.delete(id);
    if (!this.renderWatchers.size) this.stopRenderTimer();
  }
  status(ctx?: ExtensionContext): string {
    const selected = this.defaultModel;
    const availability =
      selected && ctx
        ? this.availableModels(ctx).some((model) => `${model.provider}/${model.id}` === selected)
          ? "available"
          : "unavailable in this Pi session"
        : undefined;
    return `Subagents: ${this.enabled ? "enabled" : "disabled"}; default model: ${selected ?? "inherit current Pi model"}${availability ? ` (${availability})` : ""}; running: ${this.activeRunners}; active batches: ${[...this.batches.keys()].join(", ") || "none"}. Background results return to the originating session.`;
  }
  assertModuleIdle(capability: string): void {
    if (
      [...this.batches.values()].some((batch) =>
        batch.tasks.some(({ task }) => task.tools?.includes(capability)),
      )
    )
      throw new Error(`Subagents are using ${capability}; cancel or wait for the batch before unloading.`);
  }
  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next)
      next(); // Transfer the reserved slot; no new caller may steal it.
    else this.activeRunners--;
  }
  private async slot(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("Batch cancelled.");
    if (this.activeRunners < MAX_RUNNING) this.activeRunners++;
    else {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Batch cancelled."));
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", cancel, { once: true });
      });
      if (signal.aborted) {
        this.releaseSlot();
        throw new Error("Batch cancelled.");
      }
    }
    return () => this.releaseSlot();
  }
  tools(): ToolDefinition<any, any>[] {
    return this.enabled ? [this.modelsTool(), this.callTool(), this.viewTool(), this.cancelTool()] : [];
  }
  availableModels(ctx: ExtensionContext): ModelChoice[] {
    const available = ctx.modelRegistry.getAvailable();
    const scoped = ctx.scopedModels?.length
      ? new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`))
      : undefined;
    return available.filter((model) => !scoped || scoped.has(`${model.provider}/${model.id}`));
  }
  private modelsTool(): ToolDefinition<typeof ModelsSchema, any> {
    return {
      name: "view_subagent_models",
      label: "Subagent Models",
      description:
        "View models enabled and available in the current Pi session, including text/image input and reasoning metadata. Read-only, no model call. Use exact provider/model-id in call_subagents; omit model to use the saved subagent default or current Pi model.",
      parameters: ModelsSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const query = args.query?.toLowerCase() ?? "";
        const models = this.availableModels(ctx).filter(
          (model) =>
            (!query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query)) &&
            (!args.input || model.input.includes(args.input)) &&
            (args.reasoning === undefined || model.reasoning === args.reasoning),
        );
        const offset = args.offset ?? 0;
        const page = models.slice(offset, offset + PAGE_SIZE).map((model) => ({
          model: `${model.provider}/${model.id}`,
          name: model.name,
          input: model.input,
          reasoning: model.reasoning,
          thinking_levels: thinkingLevels(model),
          current: ctx.model?.provider === model.provider && ctx.model?.id === model.id,
          default: this.defaultModel === `${model.provider}/${model.id}`,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total: models.length,
                  default_model: this.defaultModel ?? null,
                  offset,
                  next_offset: offset + PAGE_SIZE < models.length ? offset + PAGE_SIZE : null,
                  models: page,
                },
                null,
                2,
              ),
            },
          ],
          details: { total: models.length },
        };
      },
    };
  }
  private callTool(): ToolDefinition<typeof CallSchema, any> {
    return {
      name: "call_subagents",
      label: "Call Subagents",
      promptSnippet:
        "Delegate substantial independent investigations, parallel subtasks, or useful second opinions to isolated Pi agents; handle trivial questions directly.",
      promptGuidelines: [
        "Consider call_subagents when independent or parallel work justifies extra model usage. Give each child self-contained context and only the tools it needs; wait for the background completion before relying on its findings.",
      ],
      description:
        "Create 1–8 independent Pi agents in the background. Each task needs context; tools are optional (omitted = no tools). Model priority: explicit task.model, saved subagent default, current Pi model. Thinking inherits the current Pi session unless specified. Only models enabled in the current Pi session and tools active in the parent are allowed. Pi and pi-enhance write/effectful tools require explicit user approval; unknown extension tools are unsupported. No implicit timeout or turn limit. Results return as a separate session message after completion; no progress stream. Never retry side effects automatically.",
      parameters: CallSchema,
      renderCall: (args, theme) =>
        new Text(
          [
            theme.fg("toolTitle", theme.bold("SUBAGENTS")) +
              theme.fg("muted", ` · launching ${args.tasks.length} task(s)`),
            ...args.tasks.map(
              (task, index) =>
                theme.fg("accent", `  ${index + 1}. `) +
                theme.fg("dim", task.context.replace(/\s+/g, " ").slice(0, 100)) +
                (task.model ? theme.fg("muted", ` · ${task.model}`) : ""),
            ),
          ].join("\n"),
          0,
          0,
        ),
      renderResult: (result, { expanded }, theme, context) => {
        const details = result.details as { batchId?: string; taskIds?: string[] } | undefined;
        if (!details?.batchId)
          return new Text(
            theme.fg("warning", result.content.find((c) => c.type === "text")?.text ?? "Failed to start"),
            0,
            0,
          );
        const batch = this.batches.get(details.batchId) ?? this.history.get(details.batchId);
        if (!batch)
          return new Text(
            theme.fg("muted", `Subagents · batch ${details.batchId} · no longer in this session`),
            0,
            0,
          );
        if (this.batches.has(batch.id) && !context.state.subagentWatcher) {
          context.state.subagentWatcher = () => context.invalidate();
          this.watchRender(batch.id, context.state.subagentWatcher);
        }
        const now = Date.now();
        const elapsed = ((batch.finishedAt ?? now) - batch.createdAt) / 1000;
        const completed = batch.states.filter((state) => state.status === "completed").length;
        const usage = batch.states.reduce(
          (total, state, index) => {
            const value = batch.results[index]?.usage ?? state.progress?.usage;
            total.input += value?.input ?? 0;
            total.output += value?.output ?? 0;
            total.cost += value?.cost ?? 0;
            return total;
          },
          { input: 0, output: 0, cost: 0 },
        );
        const lines = [
          theme.fg("accent", theme.bold("SUBAGENTS")) + theme.fg("muted", ` · ${batch.id}`),
          theme.fg(
            batch.finishedAt ? "success" : "warning",
            `${completed}/${batch.states.length} completed`,
          ) +
            theme.fg(
              "muted",
              ` · ${elapsed.toFixed(1)}s · ${usage.input} in / ${usage.output} out · $${usage.cost.toFixed(4)} settled`,
            ),
        ];
        for (let index = 0; index < batch.states.length; index++) {
          const state = batch.states[index]!;
          const latest = state.progress?.recent.at(-1);
          const seconds = state.startedAt ? ((state.finishedAt ?? now) - state.startedAt) / 1000 : 0;
          lines.push(
            theme.fg(
              state.status === "completed"
                ? "success"
                : state.status === "failed" || state.status === "cancelled"
                  ? "error"
                  : "accent",
              `  ${index + 1}. ${state.status}`,
            ) +
              theme.fg(
                "muted",
                ` · ${seconds.toFixed(1)}s${state.progress?.tool ? ` · ${state.progress.tool}` : ""}`,
              ),
          );
          if (expanded) {
            lines.push(
              theme.fg(
                "dim",
                `     ${state.id} · ${batch.results[index]?.usage.input ?? state.progress?.usage.input ?? 0} in / ${batch.results[index]?.usage.output ?? state.progress?.usage.output ?? 0} out`,
              ),
            );
            if (latest?.text)
              lines.push(
                theme.fg(
                  "dim",
                  `     ${latest.source}${latest.tool ? `/${latest.tool}` : ""}: ${latest.text.replace(/\s+/g, " ").slice(-180)}`,
                ),
              );
          } else if (latest?.text)
            lines.push(theme.fg("dim", `     ${latest.text.replace(/\s+/g, " ").slice(-100)}`));
        }
        return new Text(lines.join("\n"), 0, 0);
      },
      execute: async (_id, args, signal, _update, ctx) => {
        if (!this.enabled || this.closed) throw new Error("Subagents are disabled or the session has ended.");
        signal?.throwIfAborted();
        const models = this.availableModels(ctx);
        const active = new Set(this.pi.getActiveTools());
        const enhanced = new Set(this.registry.tools().map((tool) => tool.name));
        const approved = new Set<string>();
        const prepared: PreparedTask[] = [];
        for (const task of args.tasks as SubagentTask[]) {
          const requestedModel = task.model ?? this.defaultModel;
          const model = requestedModel
            ? models.find((m) => `${m.provider}/${m.id}` === requestedModel)
            : ctx.model && models.find((m) => m.provider === ctx.model?.provider && m.id === ctx.model?.id);
          if (!model)
            throw new Error(
              `Model ${requestedModel ?? "(current)"} is not enabled and available in this Pi session. Use view_subagent_models or change /pi-enhance subagents model.`,
            );
          if (task.thinking_level && !thinkingLevels(model).includes(task.thinking_level))
            throw new Error(
              `Thinking level ${task.thinking_level} is unsupported by ${model.provider}/${model.id}.`,
            );
          const names = task.tools ?? [];
          if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in one task.");
          for (const name of names) {
            if (HOST_TOOLS.has(name) || !active.has(name))
              throw new Error(`Tool ${name} is not active in the parent Pi session.`);
            if (!BUILTIN.has(name) && !enhanced.has(name))
              throw new Error(`Tool ${name} cannot be safely reconstructed in a child session.`);
            if (EFFECTFUL.has(name)) approved.add(name);
          }
          prepared.push({ task, model, thinking: task.thinking_level ?? ctx.thinkingLevel ?? "off" });
        }
        if (approved.size) {
          if (!ctx.hasUI)
            throw new Error(
              `Subagent write/effectful tools are blocked without interactive user approval: ${[...approved].join(", ")}.`,
            );
          const ok = await ctx.ui.confirm(
            "Allow subagent side effects?",
            `These child agents may use ${[...approved].join(", ")}. Bash/PowerShell can bypass file restrictions; generation saves artifacts and can consume quota. Approve this batch only?`,
          );
          if (!ok) throw new Error("Subagent write/effectful tools were not approved.");
        }
        signal?.throwIfAborted();
        if (
          [...this.batches.values()].reduce(
            (count, batch) => count + batch.tasks.length - batch.results.filter(Boolean).length,
            0,
          ) +
            prepared.length >
          MAX_QUEUED
        )
          throw new Error("Subagent queue is full; wait for existing batches to finish.");
        const owner = ctx.sessionManager.getSessionId();
        if (this.owner !== owner) throw new Error("Session changed while preparing subagents.");
        const batch: Batch = {
          id: randomUUID(),
          createdAt: Date.now(),
          states: prepared.map(() => ({ id: randomUUID(), status: "queued" })),
          owner,
          anchor: ctx.sessionManager.getLeafId(),
          sessionManager: ctx.sessionManager,
          controller: new AbortController(),
          tasks: prepared,
          modelRegistry: ctx.modelRegistry,
          results: [],
        };
        this.batches.set(batch.id, batch);
        // The tool result is immediate; the child Pi sessions continue independently of this turn's signal.
        void this.run(batch).catch((error: unknown) => {
          this.finishRender(batch.id);
          this.batches.delete(batch.id);
          if (!this.closed && this.owner === owner && !batch.controller.signal.aborted)
            this.publish(
              batch,
              `Batch ${batch.id} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
        return {
          content: [
            {
              type: "text",
              text: `Started ${prepared.length} subagent task(s); batch ${batch.id}; task IDs: ${batch.states.map((state) => state.id).join(", ")}. Continue other work. Use view_subagents to check progress or cancel_subagents to cancel. A completion message will be delivered to this session.`,
            },
          ],
          details: {
            batchId: batch.id,
            taskIds: batch.states.map((state) => state.id),
            tasks: prepared.length,
          },
        };
      },
    };
  }
  private taskView(batch: Batch, index: number, full = false) {
    const state = batch.states[index]!;
    const result = batch.results[index];
    const now = Date.now();
    return {
      id: state.id,
      index: index + 1,
      status: state.status,
      phase:
        state.status === "running" || state.status === "cancelling"
          ? (state.progress?.phase ?? "starting")
          : undefined,
      current_tool:
        state.status === "running" || state.status === "cancelling" ? state.progress?.tool : undefined,
      recent_output: state.progress?.recent?.filter((entry) => entry.text) ?? [],
      model: `${batch.tasks[index]!.model.provider}/${batch.tasks[index]!.model.id}`,
      context_preview: batch.tasks[index]!.task.context.replace(/\s+/g, " ").slice(0, 160),
      started_at: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      elapsed_ms: state.startedAt ? (state.finishedAt ?? now) - state.startedAt : 0,
      turns: result?.turns ?? state.progress?.turns ?? 0,
      usage: result?.usage ?? state.progress?.usage ?? { input: 0, output: 0, cost: 0 },
      result: result ? result.text.slice(0, full ? OUTPUT_CHARS : PREVIEW_CHARS) : undefined,
      truncated: result ? result.text.length > (full ? OUTPUT_CHARS : PREVIEW_CHARS) : undefined,
    };
  }
  private batchView(batch: Batch, full = false) {
    return {
      batchId: batch.id,
      created_at: new Date(batch.createdAt).toISOString(),
      finished_at: batch.finishedAt ? new Date(batch.finishedAt).toISOString() : null,
      total: batch.states.length,
      counts: Object.fromEntries(
        ["queued", "running", "cancelling", "completed", "failed", "cancelled", "timeout", "max_turns"].map(
          (status) => [status, batch.states.filter((state) => state.status === status).length],
        ),
      ),
      tasks: full ? batch.states.map((_, index) => this.taskView(batch, index)) : undefined,
    };
  }
  private viewTool(): ToolDefinition<typeof ViewSchema, any> {
    return {
      name: "view_subagents",
      label: "View Subagents",
      description:
        "Read-only current-session progress. With no arguments, list batches; with batchId, show task progress; with id, show one task and its final result. Recent visible assistant text and tool output are bounded to three snippets of 500 characters; reasoning is never included. Completed batches are retained for this session (latest 24).",
      parameters: ViewSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const batches = [...this.batches.values(), ...this.history.values()].filter(
          (batch) => batch.owner === ctx.sessionManager.getSessionId() && this.onBranch(batch),
        );
        let data: unknown;
        if (args.id) {
          const batch = batches.find((item) => item.states.some((state) => state.id === args.id));
          if (!batch || (args.batchId && batch.id !== args.batchId))
            throw new Error("Subagent task not found in this session/branch.");
          data = {
            batchId: batch.id,
            task: this.taskView(
              batch,
              batch.states.findIndex((state) => state.id === args.id),
              true,
            ),
          };
        } else if (args.batchId) {
          const batch = batches.find((item) => item.id === args.batchId);
          if (!batch) throw new Error("Subagent batch not found in this session/branch.");
          data = this.batchView(batch, true);
        } else data = { batches: batches.map((batch) => this.batchView(batch)) };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      },
    };
  }
  private cancelTool(): ToolDefinition<typeof CancelSchema, any> {
    return {
      name: "cancel_subagents",
      label: "Cancel Subagents",
      description:
        "Request cancellation of an active batch by batchId. Running tasks show cancelling until their model/tool acknowledges abort and settles; queued tasks are cancelled immediately. No automatic retry.",
      parameters: CancelSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const batch = this.batches.get(args.batchId);
        if (!batch || batch.owner !== ctx.sessionManager.getSessionId() || !this.onBranch(batch))
          throw new Error("Active subagent batch not found in this session/branch.");
        this.cancel(args.batchId);
        return {
          content: [
            {
              type: "text",
              text: `Cancellation requested for batch ${args.batchId}. Use view_subagents to inspect final state.`,
            },
          ],
          details: { batchId: args.batchId, cancelled: true },
        };
      },
    };
  }
  private async run(batch: Batch): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_RUNNING, batch.tasks.length) }, async () => {
      while (next < batch.tasks.length && !batch.controller.signal.aborted) {
        const index = next++;
        const { task, model, thinking } = batch.tasks[index]!;
        let release: (() => void) | undefined;
        try {
          release = await this.slot(batch.controller.signal);
          const state = batch.states[index]!;
          if (batch.controller.signal.aborted) throw new Error("Batch cancelled.");
          state.status = "running";
          state.startedAt = Date.now();
          batch.results[index] = await this.runner(
            task,
            index,
            model,
            thinking,
            this.registry,
            batch.modelRegistry,
            batch.controller.signal,
            (progress) => {
              state.progress = progress;
              this.scheduleRender(batch.id);
            },
          );
          state.status = batch.controller.signal.aborted ? "cancelled" : batch.results[index]!.status;
          if (batch.controller.signal.aborted) batch.results[index]!.status = "cancelled";
          state.finishedAt = Date.now();
        } catch (error) {
          const state = batch.states[index]!;
          state.status = batch.controller.signal.aborted ? "cancelled" : "failed";
          state.finishedAt = Date.now();
          batch.results[index] = {
            index,
            model: `${model.provider}/${model.id}`,
            status: state.status,
            text: error instanceof Error ? error.message : String(error),
            turns: state.progress?.turns ?? 0,
            usage: state.progress?.usage ?? { input: 0, output: 0, cost: 0 },
          };
        } finally {
          release?.();
        }
      }
    });
    await Promise.all(workers);
    for (let index = 0; index < batch.states.length; index++) {
      const state = batch.states[index]!;
      if (state.status === "queued") {
        state.status = "cancelled";
        state.finishedAt = Date.now();
      }
      if (!batch.results[index])
        batch.results[index] = {
          index,
          model: `${batch.tasks[index]!.model.provider}/${batch.tasks[index]!.model.id}`,
          status: "cancelled",
          text: "Cancelled before starting.",
          turns: 0,
          usage: { input: 0, output: 0, cost: 0 },
        };
    }
    batch.finishedAt = Date.now();
    this.finishRender(batch.id);
    const stillTracked = this.batches.delete(batch.id);
    if (!stillTracked || this.closed || this.owner !== batch.owner || !this.onBranch(batch)) return;
    this.history.set(batch.id, batch);
    if (this.history.size > HISTORY_LIMIT) this.history.delete(this.history.keys().next().value!);
    if (batch.controller.signal.aborted) return;
    const lines = batch.results.map(
      (result) =>
        `### Task ${result.index + 1} · ${result.model} · ${result.status}\n${result.text.slice(0, OUTPUT_CHARS)}${result.text.length > OUTPUT_CHARS ? "\n[Output truncated]" : ""}\nTurns: ${result.turns}; tokens: ${result.usage.input} in / ${result.usage.output} out; cost: $${result.usage.cost.toFixed(4)}`,
    );
    this.publish(batch, `Batch ${batch.id} completed.\n\n${lines.join("\n\n---\n\n")}`);
  }
  private onBranch(batch: Batch): boolean {
    return (
      batch.sessionManager.getSessionId() === batch.owner &&
      (!batch.anchor || batch.sessionManager.getBranch().some((entry) => entry.id === batch.anchor))
    );
  }
  private publish(batch: Batch, content: string): void {
    if (this.closed || !this.onBranch(batch)) return;
    this.pi.sendMessage(
      {
        customType: "pi-enhance:subagents",
        content,
        display: true,
        details: {
          batchId: batch.id,
          results: batch.results,
          taskIds: batch.states.map((state) => state.id),
          elapsedMs: (batch.finishedAt ?? Date.now()) - batch.createdAt,
          taskElapsedMs: batch.states.map((state) =>
            state.startedAt ? (state.finishedAt ?? Date.now()) - state.startedAt : 0,
          ),
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
}
