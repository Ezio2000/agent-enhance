import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  ComputerSession,
  type ComputerCall,
} from "../../../../packages/capabilities/use_computer/openai/src/session.ts";
import type { Runtime } from "../../../../packages/capabilities/use_computer/openai/src/runtime.ts";
import { ComputerMcp } from "../../../../packages/capabilities/use_computer/openai/src/mcp.ts";

function harness() {
  let starts = 0,
    disposals = 0;
  const runtime = async (): Promise<Runtime> => {
    starts++;
    return {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixture.mjs", import.meta.url))],
      cwd: process.cwd(),
      env: {},
      dispose: async () => {
        disposals++;
      },
    };
  };
  return {
    session: new ComputerSession(runtime, "ask"),
    runtime,
    starts: () => starts,
    disposals: () => disposals,
  };
}
const call = (code: string, extra: Partial<ComputerCall> = {}): ComputerCall => ({
  code,
  title: "test",
  callId: "call-1",
  sessionId: "session-1",
  model: "gpt-6-astra",
  timeoutMs: 1000,
  ...extra,
});
const count = (r: any) => JSON.parse(r.content[0].text).counter;

test("MCP persists within a run, but disconnects and discards JS state at turn cleanup", async () => {
  const h = harness();
  try {
    const [a, b] = await Promise.all([h.session.run(call("slow")), h.session.run(call("next"))]);
    assert.equal(count(a), 1);
    assert.equal(count(b), 2);
    assert.equal(h.starts(), 1);
    const meta = JSON.parse(a.content[0].text).meta["x-codex-turn-metadata"];
    assert.equal(meta.session_id, "session-1");
    assert.equal(meta.model, "gpt-6-astra");
    await h.session.endTurn();
    assert.equal(h.session.status().connected, false);
    assert.equal(h.session.status().generation, undefined);
    assert.equal(h.disposals(), 1);
    const c = await h.session.run(call("next"));
    assert.equal(count(c), 1);
    assert.notEqual(JSON.parse(c.content[0].text).meta["x-codex-turn-metadata"].turn_id, meta.turn_id);
    assert.notEqual(c.bridgeGeneration, a.bridgeGeneration);
    assert.equal(h.starts(), 2);
  } finally {
    await h.session.reset();
  }
  assert.equal(h.disposals(), 2);
});

test("turn cleanup preserves app grants, is idempotent, and allows queued next-run work", async () => {
  const h = harness();
  try {
    await h.session.run(call("warmup"));
    await h.session.approvals.review(
      {
        mode: "form",
        message: "Allow Calculator?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_id: "computer-use",
          tool_name: "get_app_state",
          tool_params: { app: "com.apple.calculator" },
          persist: ["session"],
        },
      },
      async () => "Allow this app for this agent session",
      new AbortController().signal,
    );
    const cleanup = h.session.endTurn();
    const next = h.session.run(call("next"));
    await cleanup;
    assert.equal(count(await next), 1);
    assert.deepEqual(h.session.status().approvedApps, ["com.apple.calculator"]);
    await h.session.endTurn();
    await h.session.endTurn();
    assert.equal(h.disposals(), 2);
    assert.equal(h.session.status().connected, false);
    assert.deepEqual(h.session.status().approvedApps, ["com.apple.calculator"]);
    await h.session.reset();
    assert.deepEqual(h.session.status().approvedApps, []);
  } finally {
    await h.session.reset();
  }
});

test("turn cleanup disconnects even when the official hook returns an error", async () => {
  const h = harness();
  try {
    await h.session.run(call("cleanup-error"));
    await h.session.endTurn();
    assert.equal(h.session.status().connected, false);
    assert.equal(h.disposals(), 1);
    assert.equal(count(await h.session.run(call("next"))), 1);
  } finally {
    await h.session.reset();
  }
});

test("session approval survives a stalled native call and reconnect; decisions are traceable", async () => {
  const h = harness();
  try {
    let prompts = 0;
    const choose = async () => {
      prompts++;
      return "Allow this app for this agent session";
    };
    const first = await h.session.run(call("approve", { choose }));
    assert.equal(first.bridgeApprovals[1].scope, "session");
    const controller = new AbortController();
    const stalled = h.session.run(call("approve-hang", { choose, signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(stalled, /cache_hit/);
    const next = await h.session.run(call("approve", { choose }));
    assert.equal(prompts, 1);
    assert.equal(next.bridgeApprovals[0].event, "cache_hit");
    assert.deepEqual(h.session.status().approvedApps, ["com.apple.Safari"]);
  } finally {
    await h.session.reset();
  }
});

test("abort stops owned runtime and next call starts fresh, without retrying", async () => {
  const h = harness();
  try {
    await h.session.run(call("warmup"));
    const controller = new AbortController();
    const p = h.session.run(call("hang", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(p, /cancelled/);
    assert.equal(h.starts(), 1);
    assert.equal(count(await h.session.run(call("next"))), 1);
    assert.equal(h.starts(), 2);
  } finally {
    await h.session.reset();
  }
});

test("crash, invalid JSON and kernel errors never replay actions", async () => {
  const h = harness();
  try {
    await assert.rejects(h.session.run(call("crash")), /exited/);
    await assert.rejects(h.session.run(call("malformed")), /Invalid JSON/);
    const error = await h.session.run(call("error"));
    assert.equal(error.isError, true);
    assert.equal(h.starts(), 3);
  } finally {
    await h.session.reset();
  }
});

test("request deadline kills a stuck MCP process without retry", async () => {
  const h = harness();
  const client = new ComputerMcp(await h.runtime(), async () => ({ action: "decline" }));
  try {
    await client.initialize();
    await assert.rejects(client.call("js", { code: "hang" }, {}, 20), /timed out/);
    assert.equal(client.alive, false);
    assert.equal(h.starts(), 1);
  } finally {
    await client.close();
  }
  assert.equal(h.disposals(), 1);
});

test("reset cancels queued actions and does not leave a startup process alive", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = new ComputerSession(async () => {
    await gate;
    return h.runtime();
  });
  const first = s.run(call("next"));
  const second = s.run(call("next"));
  const firstRejected = assert.rejects(first, /cancelled/);
  const secondRejected = assert.rejects(second, /reset/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reset = s.reset();
  release();
  await Promise.all([firstRejected, secondRejected, reset]);
  assert.equal(s.status().connected, false);
  assert.equal(h.disposals(), 1);
});
