import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { basename, join } from "node:path";
import { runDirectory } from "./paths.ts";
import { writeFileAtomic } from "./lock.ts";

// MCP servers, hooks and management commands of one Claude Code session are all descendants of the
// same Claude Code process. Its PID keys the per-session control sockets and session file.

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "env"]);
function processTable(): Map<number, { ppid: number; comm: string }> {
  const table = new Map<number, { ppid: number; comm: string }>();
  if (process.platform === "win32") return table;
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 5000 });
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) table.set(Number(match[1]), { ppid: Number(match[2]), comm: basename(match[3]!.trim()) });
    }
  } catch {
    /* Without ps only the direct parent is known. */
  }
  return table;
}
/** The nearest non-shell ancestor: the host process that spawned this MCP server. */
export function hostPid(): number {
  const table = processTable();
  let pid = process.ppid;
  while (SHELLS.has(table.get(pid)?.comm.replace(/^-/, "") ?? "") && (table.get(pid)?.ppid ?? 1) > 1)
    pid = table.get(pid)!.ppid;
  return pid;
}
/** Ancestors of the current process, nearest first (used by hooks/CLI to find their session's servers). */
export function ancestors(): number[] {
  const table = processTable();
  const result: number[] = [];
  let pid = process.ppid;
  while (pid > 1 && !result.includes(pid)) {
    result.push(pid);
    pid = table.get(pid)?.ppid ?? 0;
  }
  return result;
}
const socketPattern = /^(\d+)-([a-z_]+)\.sock$/;
export const socketPath = (pid: number, capability: string) =>
  join(runDirectory(), `${pid}-${capability}.sock`);
export const sessionPath = (pid: number) => join(runDirectory(), `${pid}.session.json`);
/** Sockets of the closest ancestor that has any, i.e. the calling Claude Code session. */
export function sessionSockets(): { pid: number; sockets: Record<string, string> } | undefined {
  let files: string[];
  try {
    files = readdirSync(runDirectory());
  } catch {
    return;
  }
  const byPid = new Map<number, Record<string, string>>();
  for (const file of files) {
    const match = socketPattern.exec(file);
    if (!match) continue;
    const pid = Number(match[1]);
    byPid.set(pid, { ...byPid.get(pid), [match[2]!]: join(runDirectory(), file) });
  }
  for (const pid of ancestors()) if (byPid.has(pid)) return { pid, sockets: byPid.get(pid)! };
}

export interface SessionInfo {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}
export async function writeSession(pid: number, info: SessionInfo): Promise<void> {
  await writeFileAtomic(sessionPath(pid), JSON.stringify(info));
}
export function readSession(pid: number): SessionInfo {
  try {
    return JSON.parse(readFileSync(sessionPath(pid), "utf8")) as SessionInfo;
  } catch {
    return {};
  }
}

export type ControlRequest =
  { op: "settled" } | { op: "notice" } | { op: "status" } | { op: "manage"; action: string };
export type ControlHandler = (request: ControlRequest) => Promise<unknown>;
export function listen(path: string, handler: ControlHandler): Server {
  mkdirSync(runDirectory(), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = "";
      void (async () => {
        try {
          socket.end(
            JSON.stringify({ ok: true, result: await handler(JSON.parse(line) as ControlRequest) }) + "\n",
          );
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, error: (error as Error).message }) + "\n");
        }
      })();
    });
    socket.on("error", () => {});
  });
  server.listen(path);
  server.unref();
  return server;
}
export function send(path: string, request: ControlRequest, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Control request timed out."));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => (buffer += chunk));
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(buffer) as { ok: boolean; result?: unknown; error?: string };
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error));
      } catch {
        reject(new Error("Malformed control reply."));
      }
    });
  });
}
