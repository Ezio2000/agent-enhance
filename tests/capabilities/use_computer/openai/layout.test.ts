import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  resolveLayout,
  serviceExecutable,
  type LayoutPaths,
  type LayoutProbe,
} from "../../../../packages/capabilities/use_computer/openai/src/layout.ts";
import { runtimeEnvironment } from "../../../../packages/capabilities/use_computer/openai/src/runtime.ts";

const APP = "/Applications/ChatGPT.app";
const RESOURCES = join(APP, "Contents", "Resources");
const ROOT = join(RESOURCES, "cua_node");
const CODEX_HOME = "/Users/test/.codex";
const PLUGIN = join(CODEX_HOME, "plugins", "cache", "openai-bundled", "unified-computer-use");
const SERVICE_APP = join(CODEX_HOME, "computer-use", "Codex Computer Use.app");
const SERVICE = join(SERVICE_APP, "Contents", "MacOS", "SkyComputerUseService");
const NODE = join(ROOT, "bin", "node");
const REPL = join(ROOT, "bin", "node_repl");
const CODEX = join(RESOURCES, "codex");
const MODULES = join(ROOT, "lib", "node_modules");

const manifest = (command: string, args: string[], env: Record<string, string> = {}) =>
  JSON.stringify({ mcpServers: { cua_repl: { command, args, env } } });

/** In-memory filesystem; no test reads the real disk. */
function probe(files: Record<string, string>, dirs: string[] = [], executables: string[] = []): LayoutProbe {
  const present = new Set([...Object.keys(files), ...dirs]);
  const runnable = new Set(executables);
  return {
    realpath: async (path) => {
      if (!present.has(path)) throw new Error(`ENOENT: ${path}`);
      return path;
    },
    exists: async (path) => present.has(path),
    executable: async (path) => runnable.has(path),
    readText: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    entries: async (path) => {
      const prefix = `${path}/`;
      return [...present]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length))
        .filter((name) => !name.includes("/"));
    },
  };
}

/** A shipped bundle plus optional materialized plugin directories. */
function environment(
  options: {
    manifests?: Array<{ version: string; body: string }>;
    files?: Record<string, string>;
    dirs?: string[];
    executables?: string[];
  } = {},
): LayoutProbe {
  const files: Record<string, string> = {
    [NODE]: "",
    [REPL]: "",
    [CODEX]: "",
    [SERVICE]: "",
    ...options.files,
  };
  const dirs = [APP, RESOURCES, ROOT, MODULES, SERVICE_APP, ...(options.dirs ?? [])];
  const executables = [NODE, REPL, CODEX, SERVICE, ...(options.executables ?? [])];
  for (const entry of options.manifests ?? []) {
    dirs.push(join(PLUGIN, entry.version));
    files[join(PLUGIN, entry.version, ".mcp.json")] = entry.body;
  }
  return probe(files, dirs, executables);
}

test("the materialized manifest supplies the launch command, so a renamed launcher needs no extra code", async () => {
  const renamed = join(MODULES, "@oai", "cua-repl", "bin", "cua-repl.mjs");
  const layout = await resolveLayout({
    app: APP,
    codexHome: CODEX_HOME,
    probe: environment({
      manifests: [{ version: "26.908.40834", body: manifest(NODE, [renamed]) }],
      files: { [renamed]: "" },
    }),
  });
  assert.equal(layout.command, NODE);
  assert.deepEqual(layout.args, [renamed]);
  assert.equal(layout.manifest, join(PLUGIN, "26.908.40834", ".mcp.json"));
  assert.equal(layout.repl, REPL);
  assert.equal(layout.service, SERVICE);
});

test("an older launcher generation is read from the same manifest, so both share one code path", async () => {
  const legacy = join(PLUGIN, "26.903.61454", "scripts", "launch.mjs");
  const layout = await resolveLayout({
    app: APP,
    codexHome: CODEX_HOME,
    probe: environment({
      manifests: [{ version: "26.903.61454", body: manifest(NODE, [legacy]) }],
      files: { [legacy]: "" },
    }),
  });
  assert.deepEqual(layout.args, [legacy]);
});

test("the latest pointer outranks a numerically newer version directory", async () => {
  const pinned = join(MODULES, "pinned.mjs"),
    newer = join(MODULES, "newer.mjs");
  const layout = await resolveLayout({
    app: APP,
    codexHome: CODEX_HOME,
    probe: environment({
      manifests: [
        { version: "latest", body: manifest(NODE, [pinned]) },
        { version: "26.999.99999", body: manifest(NODE, [newer]) },
      ],
      files: { [pinned]: "", [newer]: "" },
    }),
  });
  assert.deepEqual(layout.args, [pinned]);
});

test("a launch command outside the bundle and CODEX_HOME is rejected in favour of a valid version", async () => {
  const valid = join(MODULES, "valid.mjs");
  const layout = await resolveLayout({
    app: APP,
    codexHome: CODEX_HOME,
    probe: environment({
      manifests: [
        { version: "latest", body: manifest("/usr/bin/env", [valid]) },
        { version: "26.908.40834", body: manifest(NODE, [valid]) },
      ],
      files: { [valid]: "" },
    }),
  });
  assert.deepEqual(layout.args, [valid]);
  assert.equal(layout.manifest, join(PLUGIN, "26.908.40834", ".mcp.json"));
});

test("a materialized but unlaunchable cua_repl reports that Computer Use is not enabled", async () => {
  await assert.rejects(
    resolveLayout({
      app: APP,
      codexHome: CODEX_HOME,
      probe: environment({ manifests: [{ version: "26.908.40834", body: manifest("node", []) }] }),
    }),
    (error: Error) => {
      assert.match(error.message, /enable Computer Use in the desktop app/);
      return true;
    },
  );
});

test("a missing plugin cache reports the inspected location instead of guessing a launcher path", async () => {
  await assert.rejects(
    resolveLayout({ app: APP, codexHome: CODEX_HOME, probe: environment() }),
    (error: Error) => {
      assert.ok(error.message.includes(PLUGIN));
      assert.match(error.message, /materializes the plugin/);
      return true;
    },
  );
});

test("valid materialized env overrides are adopted and unusable ones fall back", async () => {
  const alternate = join(ROOT, "bin", "node_repl_alt"),
    launcher = join(MODULES, "launcher.mjs");
  const layout = await resolveLayout({
    app: APP,
    codexHome: CODEX_HOME,
    probe: environment({
      manifests: [
        {
          version: "26.908.40834",
          body: manifest(NODE, [launcher], {
            CUA_REPL_NODE_REPL_PATH: alternate,
            CODEX_CLI_PATH: "/nonexistent/codex",
          }),
        },
      ],
      files: { [launcher]: "", [alternate]: "" },
      executables: [alternate],
    }),
  });
  assert.equal(layout.repl, alternate);
  assert.equal(layout.codex, CODEX);
});

test("an incomplete bundle names every path that failed verification", async () => {
  const launcher = join(MODULES, "launcher.mjs");
  const files = {
    [NODE]: "",
    [launcher]: "",
    [join(PLUGIN, "26.908.40834", ".mcp.json")]: manifest(NODE, [launcher]),
  };
  await assert.rejects(
    resolveLayout({
      app: APP,
      codexHome: CODEX_HOME,
      probe: probe(files, [APP, RESOURCES, ROOT, MODULES, join(PLUGIN, "26.908.40834")], [NODE]),
    }),
    (error: Error) => {
      assert.match(error.message, /node_repl/);
      assert.match(error.message, /codex/);
      assert.match(error.message, /Sky service/);
      return true;
    },
  );
});

test("the runtime environment stays computer-only, sanitized, and pinned to the private Sky pipe", () => {
  const layout: LayoutPaths = {
    app: APP,
    codexHome: CODEX_HOME,
    resources: RESOURCES,
    root: ROOT,
    command: NODE,
    args: [join(MODULES, "launcher.mjs")],
    node: NODE,
    repl: REPL,
    codex: CODEX,
    modules: MODULES,
    service: SERVICE,
    manifest: join(PLUGIN, "26.908.40834", ".mcp.json"),
  };
  const env = runtimeEnvironment(layout, "/tmp/pi-abcd1234.sock");
  assert.equal(env.CUA_REPL_ENABLED_SURFACES, "computer");
  assert.equal(env.NODE_REPL_TRUSTED_SERVICES, JSON.stringify({ sky: "@oai/sky/service" }));
  assert.equal(env.SKY_CUA_SERVICE_NATIVE_PIPE_PATH, "/tmp/pi-abcd1234.sock");
  assert.equal(env.CODEX_CLI_PATH, CODEX);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(
    Object.keys(env).some((key) => key.startsWith("BROWSER_")),
    false,
  );
});

test("a Sky service override may name either the app bundle or its binary", () => {
  assert.equal(serviceExecutable(CODEX_HOME, SERVICE_APP), SERVICE);
  assert.equal(serviceExecutable(CODEX_HOME, SERVICE), SERVICE);
  assert.equal(serviceExecutable(CODEX_HOME), SERVICE);
});
