import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, access } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join, dirname } from "node:path";
import { release } from "node:os";
import { gunzipSync } from "node:zlib";
import { nativePayload } from "./payload.ts";
export type Json = Record<string, any>;
export interface NativeRuntime {
  info: Json;
  readonly alive: boolean;
  request(method: string, params?: Json): Promise<any>;
  close(): Promise<Json>;
}
export class NativeError extends Error {
  readonly code?: string;
  readonly indeterminate: boolean;
  constructor(error: Json) {
    super(String(error.message));
    this.code = error.code;
    this.indeterminate = error.indeterminate === true;
  }
}
export class NativeConnection implements NativeRuntime {
  info: Json = {};
  private next = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private closing?: Promise<Json>;
  get alive(): boolean {
    return !this.closed;
  }
  constructor(
    private socket: Socket,
    private dispose: () => Promise<Json> = async () => ({}),
  ) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 64 * 1024 * 1024) return this.fail(new Error("Native output exceeds 64 MiB."));
      for (;;) {
        const newline = this.buffer.indexOf(10);
        if (newline < 0) break;
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        try {
          const reply = JSON.parse(line.toString());
          const item = this.pending.get(reply.id);
          if (!item) continue;
          this.pending.delete(reply.id);
          if (reply.error) item.reject(new NativeError(reply.error));
          else item.resolve(reply.result);
        } catch {
          this.fail(new Error("Invalid native runtime response."));
          break;
        }
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () =>
      this.fail(new Error("Native runtime disconnected. Observe before further actions.")),
    );
  }
  private fail(error: Error): void {
    this.closed = true;
    this.socket.destroy();
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
  request(method: string, params: Json = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Native runtime is closed."));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }
  close(): Promise<Json> {
    return (this.closing ??= (async () => {
      let cleanup: Json = {};
      if (!this.closed) {
        try {
          cleanup = await Promise.race([
            this.request("shutdown"),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(() => reject(new Error("Native shutdown timed out.")), 1500);
              timer.unref();
            }),
          ]);
        } catch (error) {
          cleanup.error = String(error);
        }
      }
      this.fail(new Error("Native runtime closed."));
      return { ...cleanup, ...(await this.dispose()) };
    })());
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function materialize(root: string): Promise<string> {
  const payload = await nativePayload();
  const hash = createHash("sha256").update(payload).digest("hex");
  const destination = join(root, "native-computer", hash);
  const app = join(destination, "Agent Enhance Computer.app");
  try {
    await access(join(app, "Contents", "MacOS", "ComputerRuntime"));
    return app;
  } catch {
    /* unpack */
  }
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), ".unpack-"));
  try {
    const archive = JSON.parse(gunzipSync(payload).toString());
    for (const file of archive.files as { path: string; data: string; mode: number }[]) {
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data, "base64"), { mode: file.mode });
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    return app;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function startNative(root: string, signal?: AbortSignal): Promise<NativeRuntime> {
  if (process.platform !== "darwin" || Number(release().split(".")[0]) < 23)
    throw new Error("use_computer/native requires macOS 14 or newer.");
  signal?.throwIfAborted();
  const app = await materialize(root);
  signal?.throwIfAborted();
  // /tmp keeps the Unix socket below macOS's 104-byte path limit.
  const workspace = await mkdtemp("/tmp/ae-computer-");
  const path = join(workspace, "rpc.sock"),
    ready = join(workspace, "pid");
  await mkdir(join(root, "native-computer"), { recursive: true });
  const launcher: ChildProcess = spawn(
    "/usr/bin/open",
    [
      "-W",
      "-n",
      "-g",
      app,
      "--args",
      "--socket",
      path,
      "--input-lock",
      `/tmp/agent-enhance-computer-input-${process.getuid!()}.lock`,
      "--ready-file",
      ready,
      "--parent-pid",
      String(process.pid),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "",
    launchError: Error | undefined,
    pid: number | undefined;
  launcher.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  launcher.on("error", (error) => {
    launchError = error;
  });
  const dispose = async (): Promise<Json> => {
    if (!pid) {
      try {
        pid = Number(await readFile(ready, "utf8"));
      } catch {
        /* never launched */
      }
    }
    if (alive(pid)) {
      try {
        process.kill(pid!, "SIGTERM");
      } catch {
        /* already stopped */
      }
      const deadline = Date.now() + 2500;
      while (alive(pid) && Date.now() < deadline) await delay(25);
      if (alive(pid)) {
        try {
          process.kill(pid!, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
      const killedDeadline = Date.now() + 500;
      while (alive(pid) && Date.now() < killedDeadline) await delay(25);
    }
    launcher.kill("SIGTERM");
    await rm(workspace, { recursive: true, force: true });
    return { nativeStopped: !alive(pid), workspaceRemoved: true };
  };
  try {
    const deadline = Date.now() + 10000;
    let socket: Socket | undefined;
    while (!socket) {
      signal?.throwIfAborted();
      if (launchError) throw launchError;
      if (launcher.exitCode !== null) throw new Error(`Native application exited during startup: ${stderr}`);
      if (Date.now() >= deadline)
        throw new Error(`Native runtime did not connect within 10 seconds. ${stderr}`);
      socket = await new Promise<Socket | undefined>((resolve) => {
        const candidate = connect(path);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", () => {
          candidate.destroy();
          resolve(undefined);
        });
      });
      if (!socket) await delay(50);
    }
    const connection = new NativeConnection(socket, dispose);
    const aborted = () => {
      void connection.close();
    };
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      connection.info = await Promise.race([
        connection.request("hello"),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Native handshake timed out.")), 3000);
          timer.unref();
        }),
      ]);
      pid = connection.info.pid;
      if (connection.info.protocol !== 1 || !Number.isSafeInteger(pid) || pid! <= 0)
        throw new Error("Unsupported native runtime handshake.");
      signal?.throwIfAborted();
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", aborted);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
}
