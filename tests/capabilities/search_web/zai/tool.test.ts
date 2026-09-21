import test from "node:test";
import assert from "node:assert/strict";
import { zaiWebTool, ZaiOutputStore } from "../../../../packages/capabilities/search_web/zai/src/tool.ts";
import { RefStore } from "../../../../packages/capabilities/search_web/zai/src/refs.ts";
import type { ZaiWebClient } from "../../../../packages/capabilities/search_web/zai/src/client.ts";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";

const context: ExecutionContext = {
  cwd: process.cwd(),
  sessionId: "s1",
  host: "test",
  credentials: { resolve: async () => ({ status: "missing", guidance: "x" }) },
};

function fakeClient(
  searches: Record<string, unknown> = {},
  reads: Record<string, unknown> = {},
): ZaiWebClient & { searchBodies: unknown[]; readBodies: unknown[] } {
  const searchBodies: unknown[] = [];
  const readBodies: unknown[] = [];
  return {
    searchBodies,
    readBodies,
    async webSearch(request: any) {
      searchBodies.push(request);
      const data = searches[request.search_query];
      if (!data) throw new Error(`unexpected query ${request.search_query}`);
      return { data, requestId: "r1" };
    },
    async readUrl(request: any) {
      readBodies.push(request);
      const data = reads[request.url];
      if (!data) throw new Error(`unexpected url ${request.url}`);
      return { data, requestId: "r2" };
    },
  } as unknown as ZaiWebClient & { searchBodies: unknown[]; readBodies: unknown[] };
}

const deps = (client: ZaiWebClient) => ({
  client: () => client,
  artifacts: new ZaiOutputStore("/unused"),
  refs: new RefStore(),
});

test("search assigns z-references; open resolves them and passes reader options", async () => {
  const client = fakeClient(
    { q1: { search_result: [{ title: "T1", link: "https://a.example/1", content: "snip" }] } },
    { "https://a.example/1": { reader_result: { title: "T1", content: "page body" } } },
  );
  const tool = zaiWebTool(deps(client));
  const result = await tool.execute(
    "c1",
    {
      search_query: [{ q: "q1", recency: 3, domains: ["a.example"] }],
      open: [{ ref_id: "z1" }],
      return_format: "text",
      no_cache: true,
    },
    undefined,
    undefined,
    context,
  );
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /\[z1\] T1/);
  assert.match(text, /## Opened: T1/);
  assert.match(text, /page body/);
  assert.equal(client.searchBodies.length, 1);
  assert.deepEqual(client.searchBodies[0], {
    search_query: "q1",
    search_engine: "search_std",
    search_domain_filter: "a.example",
    search_recency_filter: "oneWeek",
    content_size: undefined,
    location: undefined,
  });
  assert.deepEqual(client.readBodies[0], {
    url: "https://a.example/1",
    timeout: 20,
    no_cache: true,
    return_format: "text",
    retain_images: undefined,
    no_gfm: undefined,
    keep_img_data_url: undefined,
    with_images_summary: undefined,
    with_links_summary: undefined,
  });
});

test("open accepts direct URLs and unknown references fail with the stored list", async () => {
  const client = fakeClient({}, { "https://x.example/doc": { reader_result: { content: "doc" } } });
  const tool = zaiWebTool(deps(client));
  const direct = await tool.execute(
    "c1",
    { open: [{ ref_id: "https://x.example/doc" }] },
    undefined,
    undefined,
    context,
  );
  assert.match(direct.content[0]?.type === "text" ? direct.content[0].text : "", /doc/);
  await assert.rejects(
    tool.execute("c2", { open: [{ ref_id: "z9" }] }, undefined, undefined, context),
    /Unknown reference z9.*no stored references/,
  );
});

test("openai-only commands are rejected by the native schema; empty batches error", async () => {
  const tool = zaiWebTool(deps(fakeClient()));
  await assert.rejects(
    tool.execute("c1", { click: [{ ref_id: "z1", id: 1 }] } as never, undefined, undefined, context),
    /Invalid search_web\/zai arguments/,
  );
  await assert.rejects(tool.execute("c1", {} as never, undefined, undefined, context), /Nothing to do/);
});

test("reference numbering continues across calls and resets on session change", async () => {
  const client = fakeClient({
    q1: { search_result: [{ title: "A", link: "https://a/1" }] },
    q2: { search_result: [{ title: "B", link: "https://b/1" }] },
  });
  const store = new RefStore();
  const tool = zaiWebTool({ client: () => client, artifacts: new ZaiOutputStore("/unused"), refs: store });
  await tool.execute("c1", { search_query: [{ q: "q1" }] }, undefined, undefined, context);
  await tool.execute("c2", { search_query: [{ q: "q2" }] }, undefined, undefined, context);
  assert.equal(store.resolve("z2")?.url, "https://b/1");
  await tool.execute("c3", { search_query: [{ q: "q1" }] }, undefined, undefined, {
    ...context,
    sessionId: "s2",
  });
  assert.equal(store.resolve("z2"), undefined); // previous session refs cleared
  assert.equal(store.resolve("z1")?.url, "https://a/1"); // re-populated by the s2 call
});
