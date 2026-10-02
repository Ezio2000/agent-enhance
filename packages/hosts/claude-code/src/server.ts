import { readdirSync, rmSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CapabilityRegistry } from "../../../core/src/registry.ts";
import { PreferenceStore, emptyPreferences } from "../../../integrations/services/src/preferences.ts";
import { ModuleCatalog, type Catalog } from "../../../integrations/services/src/catalog.ts";
import { ServiceRuntime } from "../../../integrations/services/src/runtime.ts";
import { fileSources, sourcePaths } from "../../../integrations/services/src/sources/files.ts";
import { watchServiceSources } from "../../../integrations/services/src/watch.ts";
import { StaticCredentialResolver } from "../../../core/src/auth.ts";
import type { ExecutionContext, ToolDefinition, ToolResult } from "../../../core/src/contracts.ts";
import { hostPid, listen, readSession, socketPath, type ControlRequest } from "./control.ts";
import { transcriptHistory } from "./history.ts";
import { preview } from "./preview.ts";
import { HOST_ID, SERVER_NAME, artifactRoot, runDirectory } from "./paths.ts";
import { orderSchema, toolTitle } from "./display.ts";

/** Host features this adapter provides (approval via MCP elicitation, task-settled via the Stop hook). */
export const SUPPORTED_REQUIREMENTS = new Set(["approval", "task-settled"]);
const MANAGE_ACTIONS = ["status", "reset", "ask", "auto", "revoke"];
// Claude Code runs an MCP tool concurrently only when it declares readOnlyHint; use_computer drives one shared desktop.
const SERIAL_TOOLS = new Set(["use_computer"]);
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

/** Single MCP server exposing discovered capabilities (one process per Claude Code session). */
export async function serve(options: ServeOptions): Promise<void> {
  const { home, catalog } = options;
  const store = new PreferenceStore(home, HOST_ID, emptyPreferences);
  const manager = new ModuleCatalog(catalog, options.moduleDirectory);
  const registry = new CapabilityRegistry();
  const credentials = new StaticCredentialResolver({});
  const runtime = new ServiceRuntime({
    modules: manager,
    registry,
    services: (entry) => ({ artifactRoot: artifactRoot(home, entry.capability, entry.provider), preview }),
  });
  const sourceOptions = { home };
  const pid = hostPid();
  const errors = new Map<string, string>();
  const server = new Server(
    { name: "cc-enhance", version: options.version },
    { capabilities: { tools: { listChanged: true } } },
  );
  let connected = false;
  let signature = "";
  let tools: ToolDefinition<any, any>[] = [];

  const computer = () => registry.list().find((e) => e.instance.manage);
  const providers = (capability: string) =>
    registry
      .list()
      .filter((e) => e.module.manifest.capability === capability)
      .map((e) => e.module.manifest.provider)
      .filter((provider, index, all) => all.indexOf(provider) === index);
  const listing = () => [
    ...tools.map((tool) => ({
      name: tool.name,
      description: describe(tool),
      inputSchema: orderSchema(JSON.parse(JSON.stringify(tool.parameters))),
      annotations: {
        title: toolTitle(tool.name, providers(tool.name), tool.label),
        ...(SERIAL_TOOLS.has(tool.name) ? {} : { readOnlyHint: true }),
      },
    })),
    ...(computer()
      ? [
          {
            name: "manage_computer",
            annotations: { title: toolTitle("manage_computer", [], "桌面管理") },
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
    (syncing = syncing
      .catch(() => {})
      .then(async () => {
        try {
          await runtime.synchronize(fileSources(sourceOptions), store.load(), {
            features: SUPPORTED_REQUIREMENTS,
          });
          errors.delete("config");
          await publish();
        } catch (error) {
          errors.set("config", errorText(error));
        }
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
    await synchronize();
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
      if (!tool) throw new Error(`Tool ${name} has no available service connection; use /cc-enhance status.`);
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
    } finally {
      await synchronize();
    }
  });

  const control = async (request: ControlRequest): Promise<unknown> => {
    await syncing;
    if (request.op === "settled") {
      await registry.lifecycle("task_settled", () => true);
      await synchronize();
    } else if (request.op === "refresh") {
      await synchronize();
      return runtime.describe();
    } else if (request.op === "notice") return registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    else if (request.op === "status")
      return {
        loaded: registry.list().map((e) => e.id),
        services: runtime.snapshot.connections.map(
          ({ credentials: _credentials, ...connection }) => connection,
        ),
        capabilities: runtime.states,
        errors: { ...runtime.snapshot.errors, ...Object.fromEntries(errors) },
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
  const sock = socketPath(pid, SERVER_NAME);
  const controlServer = listen(sock, control);
  const stopWatching = watchServiceSources([store.path, ...sourcePaths(sourceOptions)], () => {
    void synchronize();
  });
  await synchronize();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    stopWatching();
    controlServer.close();
    rmSync(sock, { force: true });
    const deadline = setTimeout(() => process.exit(0), 5000);
    deadline.unref();
    await syncing.catch(() => {});
    await runtime.dispose().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await server.connect(new StdioServerTransport());
  connected = true;
}
