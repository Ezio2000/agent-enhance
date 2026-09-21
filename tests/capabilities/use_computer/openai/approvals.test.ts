import test from "node:test";
import assert from "node:assert/strict";
import { ComputerApprovals } from "../../../../packages/capabilities/use_computer/openai/src/approvals.ts";
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

test("explicit session approval caches only same-app ordinary access; revoke clears it", async () => {
  const a = new ComputerApprovals("ask");
  let prompts = 0;
  const choose = async () => {
    prompts++;
    return "Allow this app for this agent session";
  };
  assert.deepEqual(await a.review(request(), choose, signal), { action: "accept" });
  assert.deepEqual(await a.review(request(), choose, signal), { action: "accept" });
  assert.equal(prompts, 1);
  a.clear();
  assert.deepEqual(await a.review(request(), undefined, signal), { action: "decline" });
});

test("sensitive requests do not reuse grants; headless and unsupported flows fail closed", async () => {
  const a = new ComputerApprovals("ask");
  await a.review(request(), async () => "Allow this app for this agent session", signal);
  const sensitive = { ...request(), _meta: { ...request()._meta, codex_sensitive_action: true } };
  assert.deepEqual(await a.review(sensitive, undefined, signal), { action: "decline" });
  assert.deepEqual(
    await a.review(
      sensitive,
      async (_title, choices) => {
        assert.equal(choices.length, 2);
        return "Allow once";
      },
      signal,
    ),
    { action: "accept" },
  );
  assert.deepEqual(
    await a.review(
      { ...request(), requestedSchema: { type: "object", properties: { password: { type: "string" } } } },
      async () => "Allow once",
      signal,
    ),
    { action: "decline" },
  );
  assert.deepEqual(await a.review({ ...request(), mode: "url" }, async () => "Allow once", signal), {
    action: "decline",
  });
  assert.deepEqual(
    await a.review(
      { ...request(), _meta: { ...request()._meta, strict_auto_review: true } },
      async () => "Allow once",
      signal,
    ),
    { action: "decline" },
  );
});

test("once is not cached and aborted approval never grants access", async () => {
  const a = new ComputerApprovals("ask");
  await a.review(request(), async () => "Allow once", signal);
  assert.deepEqual(a.list(), []);
  const c = new AbortController();
  await assert.rejects(
    a.review(
      request(),
      async () => {
        c.abort();
        return "Allow this app for this agent session";
      },
      c.signal,
    ),
  );
  assert.deepEqual(a.list(), []);
});
