import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  ComputerApprovals,
  type ApprovalEvent,
} from "../../../../packages/capabilities/use_computer/openai/src/approvals.ts";
import { ComputerSession } from "../../../../packages/capabilities/use_computer/openai/src/session.ts";
import { createComputer } from "../../../../packages/capabilities/use_computer/openai/src/index.ts";
import { ComputerSchema } from "../../../../packages/capabilities/use_computer/openai/src/tool.ts";
import { Value } from "typebox/value";

const signal = new AbortController().signal;
const request = () => ({
  mode: "form",
  message: "Allow Safari?",
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "computer-use",
    tool_name: "get_app_state",
    tool_params: { app: "com.apple.Safari" },
    riskLevel: "high",
    persist: ["session", "always"],
  },
});

function sessionHarness() {
  let starts = 0;
  const session = new ComputerSession(async () => {
    starts++;
    return {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixture.mjs", import.meta.url))],
      cwd: process.cwd(),
      env: {},
      dispose: async () => {},
    };
  });
  const run = () =>
    session.run({
      code: "approve",
      title: "test",
      callId: "call",
      sessionId: "session",
      model: "other-provider-model",
      timeoutMs: 1000,
    });
  return { session, run, starts: () => starts };
}

test("default auto-app approves only ordinary application access without UI or reusable grants", async () => {
  const approvals = new ComputerApprovals();
  assert.equal(approvals.mode, "auto-app");
  for (const tool of [
    "get_app_state",
    "click",
    "press_key",
    "type_text",
    "scroll",
    "set_value",
    "drag",
    "perform_secondary_action",
    "paste",
    "select_text",
    "start_app",
  ]) {
    const events: ApprovalEvent[] = [];
    const params = { ...request(), _meta: { ...request()._meta, tool_name: tool } };
    const choose = async () => {
      throw new Error("Ordinary access must not prompt");
    };
    assert.deepEqual(await approvals.review(params, choose, signal, (e) => events.push(e)), {
      action: "accept",
    });
    assert.equal(events[0]?.reason, "auto_app_access");
    assert.equal(events[0]?.scope, "policy");
    assert.equal(events[0]?.app, "com.apple.Safari");
    assert.equal(
      events.some((e) => e.event === "prompt"),
      false,
    );
  }
  assert.deepEqual(await approvals.review(request(), undefined, signal), { action: "accept" });
  assert.deepEqual(approvals.list(), []);
});

test("auto-app does not authorize sensitive/action-level/unknown or unsupported approval requests", async () => {
  const approvals = new ComputerApprovals();
  const r = request();
  for (const params of [
    { ...r, _meta: { ...r._meta, codex_sensitive_action: true } },
    { ...r, _meta: { ...r._meta, requires_user_input: true } },
    { ...r, _meta: { ...r._meta, codex_request_type: "approval_request" } },
    { ...r, _meta: { ...r._meta, strict_auto_review: true } },
    { ...r, _meta: { ...r._meta, tool_name: "unknown" } },
    { ...r, _meta: { ...r._meta, tool_name: "start_audio_recording" } },
    { ...r, _meta: { ...r._meta, connector_id: "other" } },
    { ...r, _meta: { ...r._meta, tool_params: { app: "com.apple.Safari", text: "send this" } } },
    { ...r, _meta: { ...r._meta, persist: [] } },
    { ...r, mode: "url" },
    { ...r, requestedSchema: { type: "object", properties: { password: { type: "string" } } } },
    { ...r, requestedSchema: undefined },
  ])
    assert.deepEqual(await approvals.review(params, undefined, signal), { action: "decline" });
  let prompts = 0;
  const sensitive = { ...r, _meta: { ...r._meta, codex_sensitive_action: true } };
  assert.deepEqual(
    await approvals.review(
      sensitive,
      async (_title, choices) => {
        prompts++;
        assert.deepEqual(choices, ["Deny", "Allow once"]);
        return "Allow once";
      },
      signal,
    ),
    { action: "accept" },
  );
  assert.equal(prompts, 1);
  assert.deepEqual(await approvals.review(sensitive, undefined, signal), { action: "decline" });
});

test("switching to ask cannot reuse automatic access, and clearing cancels stale dialog/queued grants", async () => {
  const approvals = new ComputerApprovals();
  await approvals.review(request(), undefined, signal);
  approvals.setMode("ask");
  assert.deepEqual(await approvals.review(request(), undefined, signal), { action: "decline" });
  let release!: (choice: string) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = approvals.review(
    request(),
    async () => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      }); // Simulate a UI ignoring abort.
    },
    signal,
  );
  const queued = approvals.review(request(), async () => "Allow this app for this agent session", signal);
  const rejected = [assert.rejects(pending), assert.rejects(queued)];
  await ready;
  approvals.setMode("auto-app"); // A policy change must cancel both old approvals.
  release("Allow this app for this agent session");
  await Promise.all(rejected);
  assert.deepEqual(approvals.list(), []);
  approvals.setMode("ask");
  assert.deepEqual(await approvals.review(request(), undefined, signal), { action: "decline" });
  approvals.setMode("auto-app");
  assert.deepEqual(await approvals.review(request(), undefined, signal), { action: "accept" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(approvals.review(request(), undefined, controller.signal));
});

test("default session automatically approves across runtime reconnection and reports policy in diagnostics", async () => {
  const h = sessionHarness();
  try {
    assert.equal(h.session.status().approvalMode, "auto-app");
    for (let i = 0; i < 2; i++) {
      const result = await h.run();
      assert.equal(result.bridgeApprovalMode, "auto-app");
      assert.equal(result.bridgeApprovals[0].reason, "auto_app_access");
      assert.deepEqual(h.session.status().approvedApps, []);
      await h.session.endTurn();
    }
    assert.equal(h.starts(), 2);
    await h.session.setApprovalMode("ask");
    const denied = await h.run();
    assert.equal(denied.bridgeApprovalMode, "ask");
    assert.equal(denied.bridgeApprovals[0].reason, "no_ui");
    assert.equal(denied.isError, true);
    await h.session.reset();
    assert.equal(h.session.status().approvalMode, "ask");
  } finally {
    await h.session.reset();
  }
});

test("management exposes auto/ask; revoke switches to ask instead of silently reapproving", async () => {
  const h = sessionHarness();
  const management = createComputer({ artifactRoot: "/unused" }, h.session);
  try {
    assert.match(JSON.stringify(management.status!()), /auto-app/);
    assert.equal(h.starts(), 0);
    await management.manage!("ask");
    assert.equal(h.starts(), 0);
    assert.equal(h.session.status().approvalMode, "ask");
    await h.session.approvals.review(request(), async () => "Allow this app for this agent session", signal);
    await management.manage!("auto");
    assert.equal(h.session.status().approvalMode, "auto-app");
    assert.deepEqual(h.session.status().approvedApps, []);
    await h.run();
    await management.manage!("revoke");
    assert.equal(h.session.status().approvalMode, "ask");
    assert.equal(h.session.status().connected, false);
    assert.deepEqual(await h.session.approvals.review(request(), undefined, signal), { action: "decline" });
    assert.equal(
      Value.Check(ComputerSchema, { code: "await cua.getState()", approvalMode: "auto-app" }),
      false,
    );
  } finally {
    await h.session.reset();
  }
});
