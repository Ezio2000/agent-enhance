import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { claudeHistory } from "../packages/hosts/claude-code/src/history.ts";

const bundle = resolve("dist/cc-enhance.mjs");
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "cce-"));
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    AGENT_ENHANCE_HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    XDG_DATA_HOME: join(root, "data"),
    OPENAI_CODEX_COMPUTER_APP: join(root, "NoChatGPT.app"),
    CC_ENHANCE_RUN_DIR: join(root, "run"),
  };
  const cli = async (...args: string[]) =>
    (await promisify(execFile)(process.execPath, [bundle, "cli", ...args], { env, timeout: 20_000 })).stdout;
  return { root, env, cli, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("claude-code transcript history keeps only user/assistant text", () => {
  const lines = [
    { type: "user", message: { role: "user", content: "find cats" } },
    { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
    { type: "user", message: { role: "user", content: "<command-name>/x</command-name>" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "sure" },
          { type: "tool_use", id: "t", name: "x", input: {} },
        ],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "r" }] },
    },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(claudeHistory(lines), [
    { role: "user", content: "find cats" },
    { role: "assistant", content: "sure" },
  ]);
});

const waitForChange = (client: Client) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP tools/list_changed not received")), 5000);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      clearTimeout(timer);
      resolve();
    });
  });
const writePi = async (box: Awaited<ReturnType<typeof sandbox>>, credentials: Record<string, unknown>) => {
  await mkdir(box.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(join(box.env.PI_CODING_AGENT_DIR, "auth.json"), JSON.stringify(credentials));
};

test("Claude Code discovers existing credentials and stores only optional preferences", async () => {
  const box = await sandbox();
  try {
    assert.match(await box.cli("services"), /No service connections/);
    await writePi(box, { "opencode-go": { type: "api_key", key: "fixture" } });
    assert.match(await box.cli("services"), /pi:opencode-go/);
    assert.match(await box.cli("status"), /view_pdf\/opencode @ pi:opencode-go: available/);
    assert.match(await box.cli("prefer", "view_pdf", "pi:opencode-go"), /Preferred/);
    assert.match(await box.cli("exclude", "view_pdf"), /Excluded/);
    const preferences = JSON.parse(
      await readFile(join(box.env.AGENT_ENHANCE_HOME, "preferences", "claude-code.json"), "utf8"),
    );
    assert.deepEqual(preferences, {
      version: 1,
      preferred: { view_pdf: "pi:opencode-go" },
      excluded: ["view_pdf"],
    });
    assert.match(await box.cli("status"), /view_pdf\/opencode @ pi:opencode-go: excluded/);
    assert.match(await box.cli("include", "view_pdf"), /Included/);
    assert.match(await box.cli("login", "import-pi"), /services.*status/);
    assert.match(await box.cli("openai", "gen_image", "enable"), /services.*status/);
  } finally {
    await box.cleanup();
  }
});

test(
  "Claude Code observes login/logout and exclusions live and preserves session hooks",
  { timeout: 20_000 },
  async () => {
    const box = await sandbox(),
      client = new Client({ name: "test", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args: [bundle, "serve"], env: box.env }),
      );
      assert.deepEqual((await client.listTools()).tools, []);
      const added = waitForChange(client);
      await writePi(box, { "opencode-go": { type: "api_key", key: "fixture" } });
      await added;
      let tools = (await client.listTools()).tools;
      assert.deepEqual(
        tools.map((t) => t.name),
        ["view_pdf", "view_video"],
      );
      assert.equal(tools[0]!.annotations?.title, "PDF 理解 view_pdf · opencode");
      const keys = Object.keys(tools[0]!.inputSchema.properties as Record<string, unknown>);
      assert.equal(keys[0], "prompt");
      assert.ok(keys.indexOf("service") > keys.indexOf("path"));
      const result = await client.callTool({
        name: "view_pdf",
        arguments: { path: "not-a-file", prompt: "x", provider: "xai" },
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /INVALID_ARGUMENTS/);
      const excluded = waitForChange(client);
      await box.cli("exclude", "view_pdf");
      await excluded;
      assert.deepEqual(
        (await client.listTools()).tools.map((t) => t.name),
        ["view_video"],
      );
      const included = waitForChange(client);
      await box.cli("include", "view_pdf");
      await included;
      assert.equal((await client.listTools()).tools.length, 2);
      const hook = spawn(process.execPath, [bundle, "hook", "stop"], {
        env: box.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      hook.stdin.end(JSON.stringify({ session_id: "s-1", transcript_path: "/nonexistent", cwd: box.root }));
      assert.equal(await new Promise((done) => hook.on("exit", done)), 0);
      const session = JSON.parse(
        await readFile(join(box.env.CC_ENHANCE_RUN_DIR, `${process.pid}.session.json`), "utf8"),
      );
      assert.equal(session.sessionId, "s-1");
      assert.match(await box.cli("status"), /loaded: .*view_pdf\/opencode@pi:opencode-go/);
      const removed = waitForChange(client);
      await writePi(box, {});
      await removed;
      assert.deepEqual((await client.listTools()).tools, []);
    } finally {
      await client.close();
      await box.cleanup();
    }
  },
);

test("Claude Code exposes discovered providers once and descriptions fit its MCP limit", async () => {
  const box = await sandbox(),
    client = new Client({ name: "test", version: "1" });
  try {
    await writePi(box, {
      "openai-codex": { type: "oauth", access: "fixture", refresh: "r", expires: Date.now() + 3600000 },
      xai: { type: "oauth", access: "fixture", refresh: "r", expires: Date.now() + 3600000 },
      "opencode-go": { type: "api_key", key: "fixture" },
      "minimax-cn": { type: "api_key", key: "sk-cp-fixture" },
      minimax: { type: "api_key", key: "sk-cp-fixture-global" },
      zai: { type: "api_key", key: "fixture" },
      "zai-coding-cn": { type: "api_key", key: "fixture-cn" },
    });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [bundle, "serve"], env: box.env }),
    );
    const tools = (await client.listTools()).tools;
    const image = tools.filter((t) => t.name === "gen_image");
    assert.equal(image.length, 1);
    assert.deepEqual((image[0]!.inputSchema.properties!.provider as any).enum, ["minimax", "openai", "xai"]);
    for (const tool of tools)
      assert.ok(tool.description!.length <= 2048, `${tool.name}: ${tool.description!.length}`);
    assert.ok(!tools.some((t) => ["fast", "verbosity", "image_detail"].includes(t.name)));
  } finally {
    await client.close();
    await box.cleanup();
  }
});

test("Claude Code plugin declares existing commands and one MCP server", async () => {
  const manifest = JSON.parse(await readFile(".claude-plugin/plugin.json", "utf8"));
  assert.equal(manifest.commands.length, 2);
  for (const path of [...manifest.commands, manifest.hooks, manifest.mcpServers])
    assert.ok((await readFile(path, "utf8")).length);
  const mcp = JSON.parse(await readFile(manifest.mcpServers, "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["x"]);
});
