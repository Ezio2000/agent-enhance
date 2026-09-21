import { randomUUID } from "node:crypto";
import {
  ComputerApprovals,
  type Choose,
  type ApprovalEvent,
  type ApprovalTrace,
  type ComputerApprovalMode,
} from "./approvals.ts";
import { ComputerMcp, type Json, type ShutdownReport } from "./mcp.ts";
import { officialRuntime, type Runtime } from "./runtime.ts";

export interface ComputerCall {
  code: string;
  title: string;
  timeoutMs: number;
  callId: string;
  sessionId: string;
  model: string;
  signal?: AbortSignal;
  choose?: Choose;
}
interface CleanupReport {
  reason: string;
  generation?: string;
  hook: "ok" | "error" | "skipped";
  elapsedMs: number;
  shutdown?: ShutdownReport;
}
const REINITIALIZE =
  "Computer runtime is disconnected. All previous JS variables/app bindings are invalid. On the next call execute exactly await cua.getState() or var app = await cua.getApp('bundle.id'), read the returned documentation/state, then continue. Do not replay previous UI actions automatically.";
const UNCERTAIN =
  "The runtime connection remains open, but JS kernel state is uncertain after an error. Do not assume old bindings survived; use a cua entry API to reacquire the app and observe fresh state before any further action. If initialization fails, stop and request a runtime reset. Never replay failed clicks, typing or sends blindly; respect denial/user intervention.";
export class ComputerSession {
  readonly approvals: ComputerApprovals;
  private client?: ComputerMcp;
  private tools: Json[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private choose?: Choose;
  private trace?: ApprovalTrace;
  private sessionId?: string;
  private turnId?: string;
  private generation?: string;
  private epoch = 0;
  private used = false;
  private uncertain = false;
  private lastCleanup?: CleanupReport;
  constructor(
    private runtime: () => Promise<Runtime> = officialRuntime,
    approvalMode: ComputerApprovalMode = "auto-app",
  ) {
    this.approvals = new ComputerApprovals(approvalMode);
  }
  async setApprovalMode(mode: ComputerApprovalMode, reason = "approval_mode_change"): Promise<void> {
    // Invalidate pending approvals before waiting for runtime cleanup.
    this.approvals.setMode(mode);
    await this.reset(reason);
  }
  status() {
    const connected = this.client?.alive ?? false;
    return {
      connected,
      generation: connected ? this.generation : undefined,
      jsState: !connected ? "not_initialized" : this.uncertain ? "unknown" : "available",
      approvalMode: this.approvals.mode,
      approvedApps: this.approvals.list(),
      lastCleanup: this.lastCleanup,
    };
  }
  recoveryNotice(): string | undefined {
    return !this.used
      ? undefined
      : !this.client?.alive
        ? REINITIALIZE
        : this.uncertain
          ? UNCERTAIN
          : undefined;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  run(call: ComputerCall): Promise<Json> {
    const submittedEpoch = this.epoch;
    return this.serial(async () => {
      if (submittedEpoch !== this.epoch)
        throw new Error("Computer session was reset; queued action was not executed.");
      call.signal?.throwIfAborted();
      if (this.sessionId && this.sessionId !== call.sessionId) await this.close();
      this.sessionId = call.sessionId;
      this.choose = call.choose;
      this.used = true;
      const started = Date.now();
      let freshRuntime = false;
      const events: (ApprovalEvent & { elapsedMs: number })[] = [];
      this.trace = (event) => {
        if (events.length < 64) events.push({ ...event, elapsedMs: Date.now() - started });
      };
      try {
        if (!this.client?.alive) {
          await this.releaseRuntime("reconnect");
          const epoch = this.epoch;
          const runtime = await this.runtime();
          if (call.signal?.aborted || epoch !== this.epoch) {
            await runtime.dispose();
            throw new Error("Computer startup cancelled; no action was executed.");
          }
          const client = new ComputerMcp(runtime, (p, s) =>
            this.approvals.review(p, this.choose, s, this.trace),
          );
          this.client = client;
          try {
            this.tools = await client.initialize(call.signal);
            if (!this.tools.some((t) => t.name === "js") || !this.tools.some((t) => t.name === "turn_ended"))
              throw new Error("Incompatible Computer runtime: js/turn_ended tools are required.");
            this.generation = randomUUID();
            this.uncertain = false;
            freshRuntime = true;
          } catch (e) {
            await this.releaseRuntime("startup_failure");
            throw e;
          }
        }
        this.turnId ??= randomUUID();
        const result = await this.client!.call(
          "js",
          { code: call.code, title: call.title, timeout_ms: call.timeoutMs },
          {
            "x-codex-turn-metadata": {
              session_id: this.sessionId,
              turn_id: this.turnId,
              call_id: call.callId,
              model: call.model,
            },
          },
          call.timeoutMs + 5000,
          call.signal,
        );
        // Surface errors without reissuing side effects. A runtime may have reset its JS kernel.
        this.uncertain = !!result.isError;
        return {
          ...result,
          bridgeGeneration: this.generation,
          bridgeApprovals: events,
          bridgeApprovalMode: this.approvals.mode,
          bridgeFreshRuntime: freshRuntime,
          bridgeRecovery: this.recoveryNotice(),
        };
      } catch (error) {
        // pi persists failed tool text, but does not retain details from thrown errors.
        this.uncertain = true;
        const failedGeneration = this.generation;
        if (this.client && !this.client.alive) await this.releaseRuntime("transport_failure");
        const diagnostic = { ...this.status(), failedGeneration, approvals: events };
        throw new Error(
          `${(error as Error).message}\n${this.recoveryNotice()}\nComputer bridge diagnostics: ${JSON.stringify(diagnostic)}`,
          { cause: error },
        );
      } finally {
        this.choose = undefined;
        this.trace = undefined;
      }
    });
  }
  endTurn(isIdle: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      // A different extension may have started work while this cleanup was queued.
      if (!isIdle() || !this.client) return;
      const started = Date.now();
      let hook: CleanupReport["hook"] = "skipped";
      try {
        if (this.client.alive && this.turnId && this.sessionId) {
          const r = await this.client.call(
            "turn_ended",
            {
              hook_event_name: "Stop",
              session_id: this.sessionId,
              turn_id: this.turnId,
            },
            {},
            3000,
          );
          hook = r?.isError ? "error" : "ok";
        }
      } catch {
        hook = "error";
      } finally {
        // Hook success does not prove cursor release, but stopping the bridge-owned Sky
        // service does. Disconnect only when pi settles, not at low-level agent_end
        // (which can precede automatic retries).
        await this.releaseRuntime("agent_settled", hook, started);
      }
    });
  }
  /** Immediate stop also interrupts an in-flight call or approval. */
  async close(): Promise<void> {
    this.epoch++;
    this.approvals.clear();
    await this.releaseRuntime("close");
  }
  /** Orderly cleanup must not invalidate work queued for the next user task. */
  private async releaseRuntime(
    reason: string,
    hook: CleanupReport["hook"] = "skipped",
    started = Date.now(),
  ): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    this.client = undefined;
    this.tools = [];
    this.turnId = undefined;
    this.generation = undefined;
    this.uncertain = false;
    if (!client) return;
    await client.close();
    this.lastCleanup = {
      reason,
      generation,
      hook,
      elapsedMs: Date.now() - started,
      shutdown: client.shutdown,
    };
  }
  async reset(reason = "reset"): Promise<void> {
    this.epoch++; // Invalidate queued work and startup before attempting bounded cleanup.
    const client = this.client;
    const started = Date.now();
    let hook: CleanupReport["hook"] = "skipped";
    if (client?.alive && this.sessionId && this.turnId) {
      try {
        const result = await client.call(
          "turn_ended",
          { hook_event_name: "Interrupt", session_id: this.sessionId, turn_id: this.turnId },
          {},
          1500,
        );
        hook = result?.isError ? "error" : "ok";
      } catch {
        hook = "error";
      }
    }
    this.approvals.clear();
    await this.releaseRuntime(reason, hook, started);
    await this.close();
    await this.queue;
    await this.close();
  }
}
