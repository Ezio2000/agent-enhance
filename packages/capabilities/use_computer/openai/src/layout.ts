import { constants } from "node:fs";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

/** Filesystem surface the resolver needs. Injected so tests never touch the real disk. */
export interface LayoutProbe {
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  executable(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  entries(path: string): Promise<string[]>;
}

/** Everything the bridge needs to start the official runtime and sanitize its environment. */
export interface LayoutPaths {
  app: string;
  codexHome: string;
  resources: string;
  root: string;
  command: string;
  args: string[];
  node: string;
  repl: string;
  codex: string;
  modules: string;
  service: string;
  /** Materialized plugin manifest the launch command was read from; always set on success. */
  manifest: string;
}

/** Materialized values the bridge is willing to adopt, each revalidated before it is trusted. */
const ADOPTED = [
  "NODE_REPL_NODE_PATH",
  "CUA_REPL_NODE_REPL_PATH",
  "NODE_REPL_NODE_MODULE_DIRS",
  "CODEX_CLI_PATH",
  "SKY_CUA_SERVICE_PATH",
] as const;
type Adopted = (typeof ADOPTED)[number];

const bundledProbe: LayoutProbe = {
  realpath: (path) => realpath(path),
  exists: async (path) => {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  executable: async (path) => {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText: (path) => readFile(path, "utf8"),
  entries: async (path) => {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
};

function inside(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

/** Order version directories numerically, so 26.908.40834 sorts after 26.903.61454. */
function byVersion(left: string, right: string): number {
  const a = left.split(/\D+/).filter(Boolean).map(Number);
  const b = right.split(/\D+/).filter(Boolean).map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.localeCompare(right);
}

/** Resolve the signed Sky service executable; an override may name its app bundle or binary. */
export function serviceExecutable(codexHome: string, configured?: string): string {
  const override = configured ?? process.env.SKY_CUA_SERVICE_PATH;
  if (override) {
    if (!isAbsolute(override)) throw new Error("SKY_CUA_SERVICE_PATH must be an absolute path.");
    return override.endsWith(".app")
      ? join(override, "Contents", "MacOS", "SkyComputerUseService")
      : override;
  }
  return join(
    codexHome,
    "computer-use",
    "Codex Computer Use.app",
    "Contents",
    "MacOS",
    "SkyComputerUseService",
  );
}

interface Materialized {
  file: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
interface Materialization {
  launch?: Materialized;
  problems: string[];
}

function adoptedEnv(value: unknown): Record<string, string> {
  const source = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const adopted: Record<string, string> = {};
  for (const key of ADOPTED) {
    const entry = source[key];
    if (typeof entry === "string" && entry) adopted[key] = entry;
  }
  return adopted;
}

/**
 * The desktop app materializes a self-consistent launch recipe per plugin version. Reading that manifest
 * keeps discovery independent of launcher file names, which the app has already renamed once (the bare
 * `scripts/launch.mjs` of 26.903 became `@oai/cua-repl/bin/cua-repl.mjs` in 26.908). Every path is validated
 * against the application bundle and CODEX_HOME before it is trusted; nothing here is discovered per version.
 */
async function materialized(
  pluginDir: string,
  probe: LayoutProbe,
  roots: readonly string[],
): Promise<Materialization> {
  const names = await probe.entries(pluginDir);
  const pinned = names.includes("latest") ? ["latest"] : [];
  const versions = names
    .filter((name) => name !== "latest" && !name.startsWith("."))
    .sort(byVersion)
    .reverse();
  const problems: string[] = [];
  for (const name of [...pinned, ...versions]) {
    const directory = join(pluginDir, name);
    const file = join(directory, ".mcp.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await probe.readText(file));
    } catch (error) {
      problems.push(
        `${file}: ${error instanceof SyntaxError ? "invalid JSON" : "no materialized plugin manifest"}`,
      );
      continue;
    }
    const servers =
      manifest !== null && typeof manifest === "object"
        ? (manifest as { mcpServers?: unknown }).mcpServers
        : undefined;
    const raw =
      servers !== null && typeof servers === "object"
        ? (servers as Record<string, unknown>).cua_repl
        : undefined;
    const server =
      raw !== null && typeof raw === "object"
        ? (raw as { command?: unknown; args?: unknown; env?: unknown })
        : undefined;
    const command = typeof server?.command === "string" ? server.command : "";
    const declared = Array.isArray(server?.args)
      ? server.args.filter((value): value is string => typeof value === "string")
      : [];
    const args = declared.map((value) => (isAbsolute(value) ? value : join(directory, value)));
    const launcher = args[0];
    if (!command || !launcher || !isAbsolute(command)) {
      problems.push(
        `${file}: no materialized cua_repl launch command (enable Computer Use in the desktop app, then restart it)`,
      );
      continue;
    }
    if (!inside(command, roots) || !inside(launcher, roots)) {
      problems.push(`${file}: the launch command points outside the application bundle and CODEX_HOME`);
      continue;
    }
    if (!(await probe.executable(command))) {
      problems.push(`${file}: ${command} is not executable`);
      continue;
    }
    if (!(await probe.exists(launcher))) {
      problems.push(`${file}: ${launcher} is missing`);
      continue;
    }
    return { launch: { file, command, args, env: adoptedEnv(server?.env) }, problems };
  }
  return { problems };
}

/**
 * Resolve the installed official runtime. The materialized plugin manifest is the only source for the launch
 * command: there is no hardcoded launcher path and no per-version branch. An unusable manifest reports the
 * locations and reasons it inspected instead of silently trying a different control path.
 */
export async function resolveLayout(options: {
  app: string;
  codexHome: string;
  probe?: LayoutProbe;
}): Promise<LayoutPaths> {
  const probe = options.probe ?? bundledProbe;
  const codexHome = options.codexHome;
  let app: string;
  try {
    app = await probe.realpath(options.app);
  } catch {
    throw new Error(
      `Official Computer Use runtime not found: ${options.app} does not exist. Point OPENAI_CODEX_COMPUTER_APP at the installed desktop application.`,
    );
  }
  const resources = join(app, "Contents", "Resources");
  const root = join(resources, "cua_node");
  const roots = [resources, codexHome];
  const pluginDir = join(codexHome, "plugins", "cache", "openai-bundled", "unified-computer-use");
  const found = await materialized(pluginDir, probe, roots);
  if (!found.launch) {
    const detail = found.problems.length ? found.problems.join("; ") : "no plugin directory was found";
    throw new Error(
      `Official Computer Use runtime not found in ${app}. ${detail}. Inspected ${pluginDir}; start the desktop app once with Computer Use enabled so it materializes the plugin. Nothing is downloaded automatically.`,
    );
  }
  const launch = found.launch;
  const notes = [...found.problems];
  const adopt = async (key: Adopted, fallback: string, mode: "exists" | "executable"): Promise<string> => {
    const candidate = launch.env[key];
    if (!candidate) return fallback;
    const usable =
      isAbsolute(candidate) &&
      inside(candidate, roots) &&
      (await (mode === "executable" ? probe.executable(candidate) : probe.exists(candidate)));
    if (!usable) {
      notes.push(`materialized ${key}=${candidate} is unusable; using ${fallback}`);
      return fallback;
    }
    return candidate;
  };
  const node = await adopt("NODE_REPL_NODE_PATH", launch.command, "executable");
  const repl = await adopt("CUA_REPL_NODE_REPL_PATH", join(root, "bin", "node_repl"), "executable");
  const codex = await adopt("CODEX_CLI_PATH", join(resources, "codex"), "executable");
  const modules = await adopt("NODE_REPL_NODE_MODULE_DIRS", join(root, "lib", "node_modules"), "exists");
  let configuredService = process.env.SKY_CUA_SERVICE_PATH;
  const materializedService = launch.env.SKY_CUA_SERVICE_PATH;
  if (!configuredService && materializedService) {
    if (
      isAbsolute(materializedService) &&
      inside(materializedService, roots) &&
      (await probe.exists(materializedService))
    )
      configuredService = materializedService;
    else
      notes.push(
        `materialized SKY_CUA_SERVICE_PATH=${materializedService} is unusable; using the per-user default`,
      );
  }
  const service = serviceExecutable(codexHome, configuredService);
  const required: Array<{ label: string; path: string; executable: boolean }> = [
    { label: "node", path: launch.command, executable: true },
    { label: "launcher", path: launch.args[0] ?? "", executable: false },
    { label: "node_repl", path: repl, executable: true },
    { label: "codex", path: codex, executable: true },
    { label: "node_modules", path: modules, executable: false },
    { label: "Sky service", path: service, executable: true },
  ];
  const missing: string[] = [];
  for (const item of required) {
    if (!item.path || !(await (item.executable ? probe.executable(item.path) : probe.exists(item.path))))
      missing.push(`${item.label} (${item.path || "unresolved"})`);
  }
  if (missing.length) {
    const detail = notes.length ? ` ${notes.join("; ")}.` : "";
    throw new Error(
      `Official Computer Use runtime is incomplete in ${app}: missing or not executable: ${missing.join(", ")}.${detail} Verified manifest: ${launch.file}.`,
    );
  }
  return {
    app,
    codexHome,
    resources,
    root,
    command: launch.command,
    args: launch.args,
    node,
    repl,
    codex,
    modules,
    service,
    manifest: launch.file,
  };
}
