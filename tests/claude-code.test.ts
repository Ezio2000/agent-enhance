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
import {
  ClaudeCodeCredentialResolver,
  CredentialStore,
} from "../packages/hosts/claude-code/src/credentials.ts";
import { claudeHistory } from "../packages/hosts/claude-code/src/history.ts";
import { importPi } from "../packages/hosts/claude-code/src/login.ts";

const bundle = resolve("dist/cc-enhance.mjs");
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "cce-"));
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    AGENT_ENHANCE_HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    CC_ENHANCE_RUN_DIR: join(root, "run"),
  };
  const cli = async (...args: string[]) =>
    (await promisify(execFile)(process.execPath, [bundle, "cli", ...args], { env, timeout: 20_000 })).stdout;
  return { root, env, cli, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("claude-code CLI enables tool modules and refuses request controls", async () => {
  const box = await sandbox();
  try {
    assert.match(
      await box.cli("openai", "gen_image", "enable"),
      /Enabled gen_image\/openai[\s\S]*codex login/,
    );
    assert.match(await box.cli("openai", "fast", "enable").catch((e) => e.stdout), /request interception/);
    const status = await box.cli("status");
    assert.match(status, /gen_image\/openai\s+\S+\s+enabled, installed; auth: missing/);
    assert.match(status, /fast\/openai.*unsupported/);
    const config = JSON.parse(
      await readFile(join(box.env.AGENT_ENHANCE_HOME, "hosts", "claude-code.json"), "utf8"),
    );
    assert.deepEqual(config.autoload, ["gen_image/openai"]);
    assert.match(await box.cli("openai", "gen_image", "disable"), /Disabled/);
  } finally {
    await box.cleanup();
  }
});

test("claude-code MCP server hot-loads enabled providers and bridges hooks", async () => {
  const box = await sandbox();
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bundle, "serve", "view_pdf"],
        env: box.env,
      }),
    );
    assert.deepEqual((await client.listTools()).tools, []);
    const changed = new Promise<void>((done) =>
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => done()),
    );
    await box.cli("opencode", "view_pdf", "enable");
    await changed;
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name),
      ["view_pdf"],
    );
    assert.equal((tools[0]!.inputSchema.properties as Record<string, unknown>).provider !== undefined, true);
    const pdf = join(box.root, "a.pdf");
    await writeFile(pdf, "%PDF-1.4\n%%EOF\n");
    const result = await client.callTool({ name: "view_pdf", arguments: { path: pdf, prompt: "x" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /login opencode/);

    // Hooks spawned by the same parent process find this server's control socket.
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
    assert.match(await box.cli("status"), /view_pdf: view_pdf\/opencode/);
  } finally {
    await client.close();
    await box.cleanup();
  }
});

test("claude-code credentials: stored API keys, Pi import, Codex auth file", async () => {
  const box = await sandbox();
  const saved = { ...process.env };
  Object.assign(process.env, box.env);
  try {
    const home = box.env.AGENT_ENHANCE_HOME;
    const resolver = new ClaudeCodeCredentialResolver(home);
    const request = { provider: "zai", channel: "coding-plan", acceptedKinds: ["api_key"] } as const;
    assert.equal((await resolver.resolve(request, { interactive: false })).status, "missing");
    assert.match(await box.cli("login", "zai", "k-1", "--cn"), /Saved zai\/coding-plan/);
    const ready = await resolver.resolve(request, { interactive: false });
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.status === "ready" && ready.credential, {
      kind: "api_key",
      secret: "k-1",
      baseUrl: "https://open.bigmodel.cn",
    });

    await mkdir(box.env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeFile(
      join(box.env.PI_CODING_AGENT_DIR, "auth.json"),
      JSON.stringify({
        "opencode-go": { type: "api_key", key: "oc-1" },
        "minimax-cn": { type: "api_key", key: "sk-cp-1" },
        xai: { type: "oauth", access: "a", refresh: "r", expires: 0 },
      }),
    );
    const report = await importPi(home);
    assert.match(report, /opencode-go → opencode\/go/);
    assert.match(report, /xai \(OAuth is not shared/);
    const file = await new CredentialStore(home).read();
    assert.deepEqual(file.credentials["minimax/token-plan"], {
      kind: "api_key",
      key: "sk-cp-1",
      baseUrl: "https://api.minimaxi.com",
    });
    assert.equal(file.credentials["zai/coding-plan"]?.kind, "api_key"); // untouched

    const payload = Buffer.from(
      JSON.stringify({
        exp: Date.now() / 1000 + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acc" },
      }),
    ).toString("base64url");
    await mkdir(box.env.CODEX_HOME, { recursive: true });
    await writeFile(
      join(box.env.CODEX_HOME, "auth.json"),
      JSON.stringify({ tokens: { access_token: `h.${payload}.s`, refresh_token: "r" } }),
    );
    const codex = await resolver.resolve(
      { provider: "openai", channel: "codex", acceptedKinds: ["oauth"] },
      { interactive: false },
    );
    assert.equal(codex.status === "ready" && codex.credential.accountId, "acc");
  } finally {
    process.env = saved;
    await box.cleanup();
  }
});

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
