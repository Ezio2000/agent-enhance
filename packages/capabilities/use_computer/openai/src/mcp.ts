import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Runtime } from "./runtime.ts";

export type Json = Record<string, any>;
export type ElicitationHandler = (params: Json, signal: AbortSignal) => Promise<Json>;
export interface ShutdownReport {
  pid?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processGroupStopped: boolean;
  signalsSent: NodeJS.Signals[];
  workspaceRemoved: boolean;
  elapsedMs: number;
}
const MAX_FRAME = 64 * 1024 * 1024;

/** One persistent, bounded MCP stdio connection. No automatic replay of UI actions. */
export class ComputerMcp {
  private child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; dispose(): void }>();
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private stopped = false;
  private lifetime = new AbortController();
  private activeSignal?: AbortSignal;
  private approvalPending = 0;
  private closing?: Promise<void>;
  private shutdownReport?: ShutdownReport;
  get shutdown(): ShutdownReport | undefined {
    return this.shutdownReport;
  }
  constructor(
    private runtime: Runtime,
    private elicit: ElicitationHandler,
  ) {
    this.child = spawn(runtime.command, runtime.args, {
      cwd: runtime.cwd,
      env: runtime.env,
      stdio: "pipe",
      detached: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4096);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`Computer runtime exited (${signal ?? code}). ${this.stderr}`)),
    );
  }
  get alive(): boolean {
    return !this.stopped;
  }
  private send(message: Json): void {
    if (this.stopped)
      throw new Error(
        "Computer runtime is closed. Start a new call to reconnect; previous actions will not be replayed.",
      );
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: Json, timeoutMs = 30_000, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    if (this.stopped) return Promise.reject(new Error("Computer runtime is closed."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.fail(
          new Error(
            "Computer Use cancelled. The runtime was stopped; already completed desktop actions cannot be undone.",
          ),
        );
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(
              `Computer Use timed out (${method}; ${this.approvalPending ? "waiting for an approval response" : "waiting for runtime response"}). Runtime stopped; do not blindly retry an action.`,
            ),
          ),
        timeoutMs,
      );
      const dispose = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, dispose });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }
  async initialize(signal?: AbortSignal): Promise<Json[]> {
    const info = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: { elicitation: {} },
        clientInfo: { name: "agent-enhance", version: "0.2.0" },
      },
      30_000,
      signal,
    );
    if (info.protocolVersion !== "2024-11-05")
      throw new Error(`Unsupported Computer MCP protocol: ${info.protocolVersion}`);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools: Json[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, 30_000, signal);
      if (!Array.isArray(result.tools)) throw new Error("Invalid Computer MCP tool catalog.");
      tools.push(...result.tools);
      if (!result.nextCursor) return tools;
      cursor = result.nextCursor;
    }
    throw new Error("Computer MCP tool catalog has too many pages.");
  }
  async call(name: string, args: Json, meta: Json, timeoutMs: number, signal?: AbortSignal): Promise<Json> {
    this.activeSignal = signal;
    try {
      return await this.request("tools/call", { name, arguments: args, _meta: meta }, timeoutMs, signal);
    } finally {
      this.activeSignal = undefined;
    }
  }
  private receive(chunk: Buffer): void {
    if (this.stopped) return;
    if (this.buffer.length + chunk.length > MAX_FRAME) {
      this.fail(new Error("Computer MCP output exceeds 64 MiB."));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const index = this.buffer.indexOf(10);
      if (index < 0) break;
      const line = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      if (!line.trim()) continue;
      try {
        this.message(JSON.parse(line));
      } catch {
        this.fail(new Error("Invalid JSON-RPC from Computer runtime."));
        return;
      }
    }
  }
  private message(m: Json): void {
    if (!m || m.jsonrpc !== "2.0") throw new Error("Invalid RPC");
    if (m.method && m.id !== undefined) {
      void this.serverRequest(m);
      return;
    }
    const pending = this.pending.get(m.id);
    if (!pending) return;
    this.pending.delete(m.id);
    pending.dispose();
    if (m.error) pending.reject(new Error(`Computer MCP: ${m.error.message ?? "request failed"}`));
    else pending.resolve(m.result);
  }
  private async serverRequest(m: Json): Promise<void> {
    const signal = this.activeSignal
      ? AbortSignal.any([this.activeSignal, this.lifetime.signal])
      : this.lifetime.signal;
    let response: Json;
    try {
      if (m.method === "ping") response = { result: {} };
      else if (m.method === "elicitation/create") {
        this.approvalPending++;
        try {
          response = { result: await this.elicit(m.params ?? {}, signal) };
        } finally {
          this.approvalPending--;
        }
      } else
        response = {
          error: { code: -32601, message: "This agent bridge does not support this server request." },
        };
    } catch {
      response = { result: { action: "decline" } };
    }
    if (!this.stopped) {
      try {
        this.send({ jsonrpc: "2.0", id: m.id, ...response });
      } catch {
        /* closed */
      }
    }
  }
  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    for (const p of this.pending.values()) {
      p.dispose();
      p.reject(error);
    }
    this.pending.clear();
    void this.close(true);
  }
  close(interrupt = false): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.lifetime.abort();
    for (const p of this.pending.values()) {
      p.dispose();
      p.reject(new Error("Computer runtime closed."));
    }
    this.pending.clear();
    this.closing = (async () => {
      const started = Date.now();
      const pid = this.child.pid;
      const signalsSent: NodeJS.Signals[] = [];
      const groupAlive = () => {
        if (!pid) return false;
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      };
      const waitForGroup = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (groupAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      };
      const kill = (signal: NodeJS.Signals) => {
        if (pid && groupAlive()) {
          try {
            process.kill(-pid, signal);
            signalsSent.push(signal);
          } catch {
            /* Report surviving group below. */
          }
        }
      };
      // Let EOF close native pipes normally before escalating. Check the whole owned group,
      // not only the launcher: an exited launcher can leave descendants holding native pipes.
      // Cancellation/transport failure skips the EOF grace period and signals immediately.
      this.child.stdin.end();
      if (!interrupt) await waitForGroup(300);
      kill("SIGTERM");
      await waitForGroup(700);
      kill("SIGKILL");
      await waitForGroup(500);
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      let workspaceRemoved = true;
      try {
        await this.runtime.dispose();
      } catch {
        workspaceRemoved = false;
      }
      this.shutdownReport = {
        pid,
        exitCode: this.child.exitCode,
        signal: this.child.signalCode,
        processGroupStopped: !groupAlive(),
        signalsSent,
        workspaceRemoved,
        elapsedMs: Date.now() - started,
      };
    })();
    return this.closing;
  }
}
