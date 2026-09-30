import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DOCUMENTATION } from "./documentation.ts";
import { WORKER_SOURCE } from "./worker-source.ts";
import { startNative, type NativeRuntime, type Json } from "./runtime.ts";
export interface ComputerCall {
  code: string;
  timeoutMs: number;
  sessionId: string;
  signal?: AbortSignal;
}
export interface ComputerResult {
  content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[];
  error?: Json;
  generation?: string;
  freshRuntime: boolean;
  operations: Json[];
  cleanup?: Json;
}
const READ_ONLY = new Set(["getState", "getApp", "listWindows", "observe", "screenshot"]);
const errorJSON = (error: any): Json => ({
  message: error?.message ?? String(error),
  code: error?.code,
  indeterminate: error?.indeterminate,
});
export class ComputerSession {
  private native?: NativeRuntime;
  private worker?: ChildProcess;
  private queue: Promise<unknown> = Promise.resolve();
  private actionQueue: Promise<unknown> = Promise.resolve();
  private releases: Promise<void> = Promise.resolve();
  private epoch = 0;
  private generation?: string;
  private sessionId?: string;
  private active?: {
    id: string;
    operations: Json[];
    content: ComputerResult["content"];
    resolve(message: Json): void;
    reject(error: Error): void;
  };
  private stopCall?: () => void;
  private startup?: AbortController;
  private lastCleanup?: Json;
  private used = false;
  constructor(
    private root: string,
    private factory: (root: string, signal?: AbortSignal) => Promise<NativeRuntime> = startNative,
  ) {}
  status() {
    return {
      connected: this.native?.alive === true && this.worker?.connected === true,
      generation: this.generation,
      jsState: this.worker ? "available" : "not_initialized",
      permissions: this.native?.info.permissions ?? "not_checked",
      nativePid: this.native?.info.pid,
      workerPid: this.worker?.pid,
      defaultMode: "background",
      lastCleanup: this.lastCleanup,
    };
  }
  recoveryNotice(): string | undefined {
    return this.used && (!this.native?.alive || !this.worker?.connected)
      ? "Computer runtime was reset/disconnected. Previous JS bindings and element/window IDs are invalid. Observe fresh state; never replay failed actions automatically."
      : undefined;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  private async initialize(signal?: AbortSignal): Promise<void> {
    const native = await this.factory(this.root, signal);
    if (signal?.aborted) {
      await native.close();
      signal.throwIfAborted();
    }
    this.native = native;
    this.generation = native.info.generation ?? randomUUID();
    const child = spawn(process.execPath, ["--input-type=module", "--eval", WORKER_SOURCE], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.worker = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    await new Promise<void>((resolve, reject) => {
      const readyTimeout = setTimeout(() => reject(new Error("JS worker startup timed out.")), 5000);
      const abort = () => reject(new Error("Computer startup cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => {
        clearTimeout(readyTimeout);
        signal?.removeEventListener("abort", abort);
      };
      child.on("error", (error) => {
        finish();
        reject(error);
        if (child === this.worker) this.active?.reject(error);
      });
      child.on("exit", (code, exitSignal) => {
        finish();
        const error = new Error(`Computer JS worker exited (${exitSignal ?? code}). ${stderr}`);
        reject(error);
        if (child === this.worker) this.active?.reject(error);
      });
      child.on("message", (message: any) => {
        if (child !== this.worker) return;
        if (message.type === "ready") {
          finish();
          resolve();
        } else if (message.type === "output" && this.active?.id === message.id)
          this.active?.content.push(message.block);
        else if (message.type === "result" && this.active?.id === message.id) this.active?.resolve(message);
        else if (message.type === "native") {
          const submitted = this.active;
          const op = async () => {
            if (
              !submitted ||
              submitted !== this.active ||
              submitted.id !== message.callId ||
              native !== this.native
            )
              throw new Error("The owning call ended. Queued action was not executed.");
            try {
              const result = await native.request(message.method, {
                ...message.params,
                callId: submitted.id,
              });
              if (message.method === "getState" && result?.permissions)
                native.info.permissions = result.permissions;
              if (submitted.operations.length < 128)
                submitted.operations.push({
                  method: message.method,
                  effectful: !READ_ONLY.has(message.method),
                  outcome: result?.outcome ?? "observed",
                });
              if (child.connected) child.send({ type: "nativeResult", id: message.id, result });
            } catch (error) {
              const detail = errorJSON(error);
              if (submitted.operations.length < 128)
                submitted.operations.push({
                  method: message.method,
                  effectful: !READ_ONLY.has(message.method),
                  error: detail,
                });
              if (child.connected) child.send({ type: "nativeResult", id: message.id, error: detail });
            }
          };
          const job = this.actionQueue.then(op);
          this.actionQueue = job.catch(() => {});
        }
      });
    });
  }
  run(call: ComputerCall): Promise<ComputerResult> {
    const submittedEpoch = this.epoch;
    return this.serial(async () => {
      if (submittedEpoch !== this.epoch)
        throw new Error("Computer session was reset; queued call was not executed.");
      call.signal?.throwIfAborted();
      if (this.sessionId && this.sessionId !== call.sessionId) await this.release("session_change");
      if (this.native && (!this.native.alive || !this.worker?.connected))
        await this.release("transport_failure");
      this.sessionId = call.sessionId;
      this.used = true;
      const controller = new AbortController();
      this.startup = controller;
      const signal = call.signal ? AbortSignal.any([controller.signal, call.signal]) : controller.signal;
      const fresh = !this.native;
      let callGeneration: string | undefined;
      const operations: Json[] = [];
      let cleanup: Json | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let aborted: (() => void) | undefined;
      const expired = new Promise<never>((_, reject) => {
        const stop = (message: string) => {
          controller.abort();
          reject(new Error(message));
        };
        deadline = setTimeout(
          () =>
            stop(
              `Computer Use timed out after ${call.timeoutMs} ms. Completed actions are not undone; observe before continuing.`,
            ),
          call.timeoutMs,
        );
        aborted = () => stop("Computer Use cancelled. Completed actions are not undone.");
        call.signal?.addEventListener("abort", aborted, { once: true });
        this.stopCall = () => stop("Computer session reset. Queued actions were not executed.");
      });
      let content: ComputerResult["content"] = [];
      try {
        const execution = async (): Promise<Json> => {
          if (!this.native) await this.initialize(signal);
          callGeneration = this.generation;
          const native = this.native!,
            worker = this.worker!;
          const check = () => {
            signal.throwIfAborted();
            if (submittedEpoch !== this.epoch || native !== this.native || worker !== this.worker)
              throw new Error("Computer session changed. No further action was executed.");
          };
          check();
          const id = randomUUID();
          await native.request("beginCall", { callId: id });
          check();
          const response = await new Promise<Json>((resolve, reject) => {
            this.active = { id, operations, content, resolve, reject };
            worker.send({ type: "execute", id, code: call.code, documentation: DOCUMENTATION, fresh });
          });
          check();
          this.active = undefined;
          await this.actionQueue;
          check();
          cleanup = await native.request("endCall");
          check();
          return response;
        };
        const response = await Promise.race([execution(), expired]);
        content = response.content ?? [];
        if (response.error)
          return {
            content,
            error: response.error,
            generation: this.generation,
            freshRuntime: fresh,
            operations,
            cleanup,
          };
        return { content, generation: this.generation, freshRuntime: fresh, operations, cleanup };
      } catch (error) {
        controller.abort();
        this.active = undefined;
        await this.release("call_failure");
        // Initialization may still be unwinding after Promise.race; its abort signal prevents retaining resources.
        return {
          content,
          error: errorJSON(error),
          generation: callGeneration,
          freshRuntime: fresh,
          operations,
          cleanup: this.lastCleanup,
        };
      } finally {
        clearTimeout(deadline);
        if (aborted) call.signal?.removeEventListener("abort", aborted);
        this.stopCall = undefined;
        this.startup = undefined;
      }
    });
  }
  private release(reason: string): Promise<void> {
    const worker = this.worker,
      native = this.native;
    this.worker = undefined;
    this.native = undefined;
    this.generation = undefined;
    this.active = undefined;
    this.actionQueue = Promise.resolve();
    if (!worker && !native) return this.releases;
    const cleanup = async () => {
      if (worker?.connected) worker.disconnect();
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            worker.kill("SIGKILL");
          }, 500);
          worker.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const detail = await native?.close();
      this.lastCleanup = {
        reason,
        ...detail,
        workerStopped: !worker || worker.exitCode !== null || worker.signalCode !== null,
      };
    };
    const job = this.releases.then(cleanup, cleanup);
    this.releases = job.catch(() => {});
    return job;
  }
  endTurn(isIdle: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      if (isIdle()) {
        await this.release("task_settled");
        this.used = false;
      }
    });
  }
  async reset(reason = "reset"): Promise<void> {
    this.epoch++;
    this.startup?.abort();
    this.stopCall?.();
    const previous = this.queue;
    const shutdown = this.release(reason);
    // New calls queue after the reset barrier; teardown must never dispose their resources.
    const barrier = Promise.all([previous, shutdown]).then(() => this.release(reason));
    this.queue = barrier.catch(() => {});
    await barrier;
  }
}
