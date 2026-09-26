import { mkdirSync, readdirSync, rmSync, watch } from "node:fs";
import { dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CapabilityRegistry } from "../../../core/src/registry.ts";
import { ConfigStore } from "../../../core/src/config.ts";
import { ModuleManager, type Catalog } from "../../../core/src/modules.ts";
import type { ExecutionContext, ToolDefinition, ToolResult } from "../../../core/src/contracts.ts";
import { ClaudeCodeCredentialResolver } from "./credentials.ts";
import { hostPid, listen, readSession, socketPath, type ControlRequest } from "./control.ts";
import { transcriptHistory } from "./history.ts";
import { preview } from "./preview.ts";
import { HOST_ID, artifactRoot, runDirectory } from "./paths.ts";

/** Host features this adapter provides (approval via MCP elicitation, task-settled via the Stop hook). */
export const SUPPORTED_REQUIREMENTS = new Set(["approval", "task-settled"]);
const MANAGE_ACTIONS = ["status", "reset", "ask", "auto", "revoke"];
export interface ServeOptions {
  home: string;
  catalog: Catalog;
  moduleDirectory: string;
  version: string;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
function removeStaleSockets(): void {
  try {
    for (const file of readdirSync(runDirectory())) {
      const pid = Number(/^(\d+)[-.]/.exec(file)?.[1]);
      if (pid && !alive(pid)) rmSync(`${runDirectory()}/${file}`, { force: true });
    }
  } catch {
    /* Nothing to clean. */
  }
}
function toMcp(result: ToolResult<any>): CallToolResult {
  return {
    content: result.content.map((part) =>
      part.type === "image"
        ? { type: "image", data: part.data, mimeType: part.mimeType }
        : { type: "text", text: part.text },
    ),
  };
}
function describe(tool: ToolDefinition<any, any>): string {
  const guidelines = tool.promptGuidelines?.length
    ? `\n\nGuidelines:\n- ${tool.promptGuidelines.join("\n- ")}`
    : "";
  return tool.description + guidelines;
}

/** One MCP server per capability, so Claude Code shows `plugin:cc-enhance:<capability>`. */
export async function serve(capability: string, options: ServeOptions): Promise<void> {
  const { home, catalog } = options;
  if (!catalog.modules.some((e) => e.capability === capability && e.kind === "tool"))
    throw new Error(`Unknown tool capability: ${capability}`);
  const store = new ConfigStore(home, HOST_ID);
  const manager = new ModuleManager(home, catalog, options.moduleDirectory);
  const registry = new CapabilityRegistry();
  const credentials = new ClaudeCodeCredentialResolver(home);
  const pid = hostPid();
  const errors = new Map<string, string>();
  const server = new Server(
    { name: `cc-enhance-${capability}`, version: options.version },
    { capabilities: { tools: { listChanged: true } } },
  );
  let connected = false;
  let signature = "";
  let tools: ToolDefinition<any, any>[] = [];

  const computer = () => registry.list().find((e) => e.instance.manage);
  const listing = () => [
    ...tools.map((tool) => ({
      name: tool.name,
      title: tool.label,
      description: describe(tool),
      inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
    })),
    ...(computer()
      ? [
          {
            name: "manage_computer",
            title: "manage_computer",
            description:
              "Manage the use_computer bridge: status, reset (stop runtime and drop JS state), ask (confirm each app access), auto (auto-approve ordinary app access, default), revoke (clear session app grants and switch to ask).",
            inputSchema: {
              type: "object",
              properties: { action: { type: "string", enum: MANAGE_ACTIONS } },
              required: ["action"],
              additionalProperties: false,
            },
          },
        ]
      : []),
  ];
  const publish = async () => {
    tools = registry.tools();
    const next = JSON.stringify(listing());
    if (next === signature) return;
    signature = next;
    if (connected) await server.sendToolListChanged().catch(() => {});
  };

  let syncing: Promise<void> = Promise.resolve();
  const synchronize = () =>
    (syncing = syncing.then(async () => {
      let config;
      try {
        config = store.load();
      } catch (error) {
        errors.set("config", errorText(error));
        return;
      }
      errors.delete("config");
      for (const key of Object.keys(registry.defaults)) delete registry.defaults[key];
      Object.assign(registry.defaults, config.defaults);
      const wanted = new Set(config.autoload.filter((id) => id.startsWith(`${capability}/`)));
      for (const entry of registry.list()) {
        const id = entry.module.manifest.id;
        if (wanted.has(id)) continue;
        try {
          await registry.unload(id);
          errors.delete(id);
        } catch (error) {
          errors.set(id, errorText(error)); // Busy: retried on the next change.
        }
      }
      for (const id of wanted) {
        if (registry.get(id)) continue;
        try {
          const entry = manager.find(id);
          const missing = entry.requires?.filter((r) => !SUPPORTED_REQUIREMENTS.has(r)) ?? [];
          if (entry.kind !== "tool" || missing.length)
            throw new Error(`Claude Code host lacks: ${missing.join(", ") || "request interception"}`);
          const module = await manager.load(id);
          registry.load(module, {
            artifactRoot: artifactRoot(home, module.manifest.capability, module.manifest.provider),
            preview,
          });
          errors.delete(id);
        } catch (error) {
          errors.set(id, errorText(error));
        }
      }
      await publish();
    }));

  const context = async (signal: AbortSignal): Promise<ExecutionContext> => {
    const session = readSession(pid);
    const elicitation = !!server.getClientCapabilities()?.elicitation;
    return {
      cwd: session.cwd ?? process.cwd(),
      sessionId: session.sessionId ?? `claude-code-${pid}`,
      host: HOST_ID,
      credentials,
      signal,
      history: await transcriptHistory(session.transcriptPath),
      choose: elicitation
        ? async (title, choices, choiceSignal) => {
            const reply = await server.elicitInput(
              {
                mode: "form",
                message: title,
                requestedSchema: {
                  type: "object",
                  properties: { choice: { type: "string", title: "Choice", enum: choices } },
                  required: ["choice"],
                },
              },
              { signal: choiceSignal, timeout: 10 * 60_000 },
            );
            const choice = reply.action === "accept" ? reply.content?.choice : undefined;
            return typeof choice === "string" ? choice : undefined;
          }
        : undefined,
    };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await syncing;
    return { tools: listing() };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    await syncing;
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === "manage_computer") {
        const target = computer();
        if (!target) throw new Error("use_computer is not enabled.");
        const action = String((args as Record<string, unknown>).action);
        if (!MANAGE_ACTIONS.includes(action)) throw new Error(`Choose ${MANAGE_ACTIONS.join(" / ")}.`);
        return { content: [{ type: "text", text: await target.instance.manage!(action) }] };
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Tool ${name} is not enabled; use /cc-enhance to enable a provider.`);
      const token = extra._meta?.progressToken;
      let progress = 0;
      const onUpdate =
        token === undefined
          ? undefined
          : (update: ToolResult<any>) => {
              const message = update.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken: token, progress: ++progress, ...(message ? { message } : {}) },
                })
                .catch(() => {});
            };
      const ctx = await context(extra.signal);
      return toMcp(await tool.execute(String(extra.requestId), args, extra.signal, onUpdate, ctx));
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorText(error) }] };
    }
  });

  const control = async (request: ControlRequest): Promise<unknown> => {
    await syncing;
    if (request.op === "settled") await registry.lifecycle("task_settled", () => true);
    else if (request.op === "notice") return registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    else if (request.op === "status")
      return {
        capability,
        loaded: registry.list().map((e) => e.module.manifest.id),
        errors: Object.fromEntries(errors),
        status: Object.fromEntries(
          registry
            .list()
            .flatMap((e) => (e.instance.status ? [[e.module.manifest.id, e.instance.status()]] : [])),
        ),
      };
    else if (request.op === "manage") {
      const target = computer();
      if (!target) throw new Error("use_computer is not enabled in this session.");
      return target.instance.manage!(request.action);
    }
  };

  removeStaleSockets();
  const sock = socketPath(pid, capability);
  const controlServer = listen(sock, control);
  mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dirname(store.path), (_event, file) => {
    if (file && !String(file).startsWith(`${HOST_ID}.json`)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void synchronize(), 150);
  });
  await synchronize();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    watcher.close();
    controlServer.close();
    rmSync(sock, { force: true });
    const deadline = setTimeout(() => process.exit(0), 5000);
    deadline.unref();
    await registry.dispose().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await server.connect(new StdioServerTransport());
  connected = true;
}
