import test from "node:test";
import assert from "node:assert/strict";
import { HTTPTransport, responseError } from "../../../packages/transports/zai/src/http.ts";
import { resolveZaiAuth, zaiCodingBase } from "../../../packages/transports/zai/src/auth.ts";
import { StaticCredentialResolver } from "../../../packages/core/src/auth.ts";
import type { ExecutionContext } from "../../../packages/core/src/contracts.ts";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const context = (baseUrl?: string): Pick<ExecutionContext, "credentials"> => ({
  credentials: new StaticCredentialResolver({
    "zai/coding-plan": { kind: "api_key", secret: "test-secret-value-1234567890", baseUrl },
  }),
});

test("coding base maps each allowlisted platform onto the coding tool path", () => {
  assert.equal(zaiCodingBase(undefined), "https://api.z.ai/api/coding/paas/v4/");
  assert.equal(zaiCodingBase("https://api.z.ai/api/coding/paas/v4"), "https://api.z.ai/api/coding/paas/v4/");
  assert.equal(
    zaiCodingBase("https://open.bigmodel.cn/api/coding/paas/v4"),
    "https://open.bigmodel.cn/api/coding/paas/v4/",
  );
  assert.throws(() => zaiCodingBase("https://evil.example.com/api"), /Refusing/);
  assert.throws(() => zaiCodingBase("https://api.z.ai/api?x=1"), /Refusing/);
});

test("resolveZaiAuth sends the plan key only to the derived coding origin", async () => {
  const auth = await resolveZaiAuth(context("https://api.z.ai/api/coding/paas/v4"));
  assert.equal(auth.baseUrl, "https://api.z.ai/api/coding/paas/v4/");
  assert.equal(auth.headers.Authorization, "Bearer test-secret-value-1234567890");
});

test("error envelopes: REST error object, gateway msg object, risk-control hint", () => {
  const rest = responseError({ error: { code: "1113", message: "Insufficient balance" } }, 429);
  assert.equal(rest.code, "1113");
  assert.match(rest.message, /subscription quota/);
  const gateway = responseError({ code: "1001", msg: "no Authorization", success: false }, 200);
  assert.equal(gateway.code, "1001");
  assert.match(gateway.message, /Reauthenticate/);
  const risk = responseError({ error: { code: "1302", message: "blocked" } }, 403);
  assert.match(risk.message, /Risk-control/);
  assert.doesNotMatch(responseError({ error: { message: "x" } }, 500).message, /Risk-control/);
});

test("post unwraps JSON, propagates request ids and never retries", async () => {
  let calls = 0;
  const http = new HTTPTransport(
    async () => ({ baseUrl: "https://api.z.ai/x/", headers: {} }),
    async () => {
      calls++;
      return calls === 1
        ? json({ ok: true, request_id: "req-1" })
        : json({ error: { code: "1214", message: "bad params" } }, 400);
    },
  );
  const result = await http.post(
    "web_search",
    { a: 1 },
    {
      timeoutMs: 1000,
    },
  );
  assert.deepEqual(result.data, { ok: true, request_id: "req-1" });
  assert.equal(result.requestId, undefined); // header id absent; capability falls back to body id
  assert.equal(calls, 1);
  await assert.rejects(http.post("reader", {}, { timeoutMs: 1000 }), /Zai HTTP 400/);
});
