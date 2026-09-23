import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CapabilityRegistry } from "../../../../core/src/registry.ts";
import { runSubagent, type SubagentOutcome, type SubagentTask } from "./runner.ts";

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
          "Exact provider/model-id from list_subagent_models. Overrides the saved subagent default; otherwise inherits the current Pi model.",
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

type ModelChoice = NonNullable<ExtensionContext["model"]>;
type Thinking = NonNullable<ExtensionContext["thinkingLevel"]>;
interface PreparedTask {
  task: SubagentTask;
  model: ModelChoice;
  thinking: Thinking;
}
interface Batch {
  id: string;
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
  private activeRunners = 0;
  private readonly waiters: Array<() => void> = [];
  private owner: string | undefined;
  private enabled = false;
  private defaultModel: string | undefined;
  private closed = false;
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registry: CapabilityRegistry,
  ) {
    pi.registerMessageRenderer(
      "pi-enhance:subagents",
      (message, { expanded }, theme) =>
        new Text(
          theme.fg("accent", "Subagents") +
            "\n" +
            (expanded ? message.content : message.content.slice(0, 2500)),
          0,
          0,
        ),
    );
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
    this.batches.delete(id);
    return true;
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
    return this.enabled ? [this.modelsTool(), this.callTool()] : [];
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
      name: "list_subagent_models",
      label: "Subagent Models",
      description:
        "List models enabled and available in the current Pi session, including text/image input and reasoning metadata. Read-only, no model call. Use exact provider/model-id in call_subagents; omit model to use the saved subagent default or current Pi model.",
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
      description:
        "Create 1–8 independent Pi agents in the background. Each task needs context; tools are optional (omitted = no tools). Model priority: explicit task.model, saved subagent default, current Pi model. Thinking inherits the current Pi session unless specified. Only models enabled in the current Pi session and tools active in the parent are allowed. Pi and pi-enhance write/effectful tools require explicit user approval; unknown extension tools are unsupported. No implicit timeout or turn limit. Results return as a separate session message after completion; no progress stream. Never retry side effects automatically.",
      parameters: CallSchema,
      renderCall: (args, theme) =>
        new Text(theme.fg("toolTitle", "call_subagents") + ` · ${args.tasks.length} task(s)`, 0, 0),
      renderResult: (result, _options, theme) =>
        new Text(theme.fg("muted", result.content.find((c) => c.type === "text")?.text ?? ""), 0, 0),
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
              `Model ${requestedModel ?? "(current)"} is not enabled and available in this Pi session. Use list_subagent_models or change /pi-enhance subagents model.`,
            );
          if (task.thinking_level && !thinkingLevels(model).includes(task.thinking_level))
            throw new Error(
              `Thinking level ${task.thinking_level} is unsupported by ${model.provider}/${model.id}.`,
            );
          const names = task.tools ?? [];
          if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in one task.");
          for (const name of names) {
            if (name === "call_subagents" || name === "list_subagent_models" || !active.has(name))
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
              text: `Started ${prepared.length} subagent task(s); batch ${batch.id}. Continue other work. A completion message will be delivered to this session.`,
            },
          ],
          details: { batchId: batch.id, tasks: prepared.length },
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
          batch.results[index] = await runSubagent(
            task,
            index,
            model,
            thinking,
            this.registry,
            batch.modelRegistry,
            batch.controller.signal,
          );
        } catch (error) {
          batch.results[index] = {
            index,
            model: `${model.provider}/${model.id}`,
            status: batch.controller.signal.aborted ? "cancelled" : "failed",
            text: error instanceof Error ? error.message : String(error),
            turns: 0,
            usage: { input: 0, output: 0, cost: 0 },
          };
        } finally {
          release?.();
        }
      }
    });
    await Promise.all(workers);
    this.batches.delete(batch.id);
    if (this.closed || batch.controller.signal.aborted || this.owner !== batch.owner || !this.onBranch(batch))
      return;
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
        details: { batchId: batch.id, results: batch.results },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
}
