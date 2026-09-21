import test from "node:test";
import assert from "node:assert/strict";
import { WebClient } from "../../../../packages/capabilities/search_web/openai/src/client.ts";
import { auth, search, json } from "../helpers.ts";

test("search uses exact Codex route, POST, no redirects and fresh auth per request", async () => {
  let calls = 0;
  const client = new WebClient(
    async () => {
      calls++;
      return auth();
    },
    async (url, init) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/alpha/search");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-secret");
      assert.deepEqual(JSON.parse(String(init.body)), search);
      return json({ output: "Results", results: [] }, 200, { "x-request-id": "req1" });
    },
  );
  assert.equal((await client.search(search)).requestId, "req1");
  await client.search(search);
  assert.equal(calls, 2);
});
