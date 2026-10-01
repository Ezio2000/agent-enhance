import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveLayout, type LayoutPaths } from "./layout.ts";

export { serviceExecutable } from "./layout.ts";

export interface Runtime {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

// The signed Sky service lives in the app group container. A bridge-owned instance on a
// private socket keeps it fully independent of any ChatGPT desktop process.
const SKY_SOCKET_DIR = join(
  homedir(),
  "Library",
  "Group Containers",
  "2DC432GLL2.com.openai.sky.CUAService",
  "IPC",
);
const SERVICE_START_TIMEOUT_MS = 10_000;
const SERVICE_STOP_TIMEOUT_MS = 1_500;

/** Private socket name stays well under the macOS 104-byte sun_path limit. */
export function privateSocketPath(): string {
  return join(SKY_SOCKET_DIR, `ae-${randomBytes(4).toString("hex")}.sock`);
}

/** Minimal environment for the service: no host credentials, loaders or safety flags.
 * Resources leads PATH: the service resolves the packaged codex there and spawns its own
 * codex app-server (auth status + computer-use policy) for every cua operation. */
function serviceEnvironment(layout: LayoutPaths, socket: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homedir(),
    TMPDIR: tmpdir(),
    PATH: `${layout.resources}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    CODEX_HOME: layout.codexHome,
    SKY_CUA_SERVICE_NATIVE_PIPE_PATH: socket,
  };
  for (const key of ["USER", "LOGNAME", "__CF_USER_TEXT_ENCODING"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Do not forward OAuth credentials, NODE_OPTIONS, loader injection, or safety-override flags.
 * Surfaces stay computer-only, and the trusted Sky service is stated explicitly rather than
 * inherited from whatever a launcher happens to default to. */
export function runtimeEnvironment(layout: LayoutPaths, socket: string): NodeJS.ProcessEnv {
  return {
    HOME: homedir(),
    TMPDIR: tmpdir(),
    PATH: `${join(layout.root, "bin")}:${layout.resources}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    CODEX_HOME: layout.codexHome,
    CODEX_CLI_PATH: layout.codex,
    CUA_REPL_NODE_REPL_PATH: layout.repl,
    CUA_REPL_ENABLED_SURFACES: "computer",
    NODE_REPL_NODE_PATH: layout.node,
    NODE_REPL_NODE_MODULE_DIRS: layout.modules,
    NODE_REPL_TRUSTED_CODE_PATHS: layout.modules,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
    SKY_CUA_SERVICE_NATIVE_PIPE_PATH: socket,
  };
}

function listening(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socket);
    const done = (value: boolean) => {
      probe.destroy();
      resolve(value);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

async function awaitService(socket: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Sky Computer Use service exited before it started listening (${child.signalCode ?? child.exitCode}).`,
      );
    if (await listening(socket)) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Sky Computer Use service did not start listening on ${socket} within ${timeoutMs} ms.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopService(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + SERVICE_STOP_TIMEOUT_MS;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function removeSocket(socket: string): Promise<void> {
  await rm(socket, { force: true });
  await rm(`${socket}.lock`, { force: true });
}

/** User-configured application bundle only; never discover executables from the project. */
export async function officialRuntime(): Promise<Runtime> {
  if (process.platform !== "darwin") throw new Error("use_computer currently supports macOS only.");
  const app = process.env.OPENAI_CODEX_COMPUTER_APP ?? "/Applications/ChatGPT.app";
  if (!isAbsolute(app)) throw new Error("OPENAI_CODEX_COMPUTER_APP must be an absolute application path.");
  const layout = await resolveLayout({ app, codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex") });
  // Start a bridge-owned Sky service on a private socket before node_repl connects. The
  // shipped @oai/sky client prefers SKY_CUA_SERVICE_NATIVE_PIPE_PATH, so it never touches a
  // shared ChatGPT service, and this instance dies with the bridge-owned connection.
  await mkdir(SKY_SOCKET_DIR, { recursive: true });
  const socket = privateSocketPath();
  const child = spawn(layout.service, [], { env: serviceEnvironment(layout, socket), stdio: "ignore" });
  let cwd: string | undefined;
  try {
    await awaitService(socket, child, SERVICE_START_TIMEOUT_MS);
    cwd = await mkdtemp(join(tmpdir(), "agent-enhance-computer-"));
    await symlink(layout.modules, join(cwd, "node_modules"), "dir");
  } catch (error) {
    await stopService(child);
    await removeSocket(socket);
    if (cwd) await rm(cwd, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    command: layout.command,
    args: layout.args,
    cwd,
    env: runtimeEnvironment(layout, socket),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await stopService(child);
      await removeSocket(socket);
      await rm(cwd!, { recursive: true, force: true });
    },
  };
}
