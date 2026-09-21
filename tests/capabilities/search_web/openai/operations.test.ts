import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";
import { WebSchema, type WebArgs } from "../../../../packages/capabilities/search_web/openai/src/schema.ts";
import type { SearchCommands } from "../../../../packages/capabilities/search_web/openai/src/types.ts";
import { validateSearchRequest } from "../../../../packages/capabilities/search_web/openai/src/validation.ts";
import { searchRequest, webTool } from "../../../../packages/capabilities/search_web/openai/src/tool.ts";
import { WebClient } from "../../../../packages/capabilities/search_web/openai/src/client.ts";
import { WebOutputStore } from "../../../../packages/capabilities/search_web/openai/src/output.ts";

const ctx = {
  cwd: "/unused",
  model: { id: "gpt-6-astra", provider: "openai-codex" },
  sessionManager: {
    getSessionId: () => "test-session",
    buildContextEntries: () => [],
  },
} as unknown as ExecutionContext;
const examples: WebArgs[] = [
  { finance: [{ ticker: "BTC", type: "crypto", market: "" }] },
  { weather: [{ location: "China, Shanghai, Shanghai", start: "2028-02-29", duration: 1 }] },
  {
    sports: [
      {
        fn: "schedule",
        league: "nba",
        team: "LAL",
        opponent: "BOS",
        date_from: "2026-09-01",
        date_to: "2026-09-30",
        num_games: 3,
        locale: "en-US",
      },
    ],
  },
  { time: [{ utc_offset: "+08:00" }, { utc_offset: "-03:30" }] },
];

test("each new web operation is valid on its own and sports.tool is internally fixed", () => {
  for (const args of examples) {
    assert.ok(Value.Check(WebSchema, args));
    const request = searchRequest(args, ctx);
    assert.equal(request.model, "gpt-5.6-luna");
    assert.doesNotThrow(() => validateSearchRequest(request));
    if (args.sports)
      assert.deepEqual(
        request.commands.sports,
        args.sports.map((o) => ({ ...o, tool: "sports" })),
      );
    if (args.finance) assert.equal(request.commands.finance![0]!.market, "");
  }
  assert.equal(
    Value.Check(WebSchema, { sports: [{ fn: "standings", league: "epl", tool: "sports" }] }),
    false,
  );
  assert.ok(Value.Check(WebSchema, { search_query: [{ q: "hello" }], external_web_access: "indexed" }));
  assert.equal(Value.Check(WebSchema, { search_query: [{ q: "hello" }], api_key: "secret" }), false);
});

test("new web commands batch with existing search and preserve structured results", async () => {
  const args: WebArgs = Object.assign({ search_query: [{ q: "test" }], include_context: false }, ...examples);
  const structured = [
    { type: "finance", ticker: "BTC" },
    { type: "weather", location: "Shanghai" },
  ];
  const tool = webTool({
    artifacts: new WebOutputStore("/unused"),
    client: () =>
      new WebClient(
        async () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/", headers: {} }),
        async (url, init) => {
          assert.match(String(url), /alpha\/search$/);
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, "gpt-5.6-luna");
          for (const key of ["search_query", "finance", "weather", "sports", "time"])
            assert.ok(body.commands[key]);
          assert.equal(body.commands.sports[0].tool, "sports");
          assert.equal(body.settings.allowed_callers[0], "direct");
          return new Response(
            JSON.stringify({
              output: "turn0finance0 turn0forecast0 turn0sports0 turn0time0",
              results: structured,
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      ),
  });
  for (const model of [ctx.model, { ...ctx.model!, provider: "anthropic", id: "other-model" }, undefined]) {
    const result = await tool.execute("call", args, undefined, undefined, { ...ctx, model });
    assert.deepEqual(result.details!.results, structured);
    assert.match((result.content[0] as { text: string }).text, /turn0sports0/);
  }
});

test("new web operations validate enums, real dates, date ranges, counts and offsets", () => {
  const invalid = [
    { finance: [{ ticker: "x", type: "other" }] },
    { finance: [{ ticker: "x", type: "equity", market: "US" }] },
    { weather: [{ location: "Shanghai", start: "2026-02-29" }] },
    { weather: [{ location: "Shanghai", duration: 0 }] },
    { sports: [{ fn: "scores", league: "nba" }] },
    { sports: [{ fn: "standings", league: "invalid" }] },
    { sports: [{ fn: "schedule", league: "epl", date_from: "2026-09-02", date_to: "2026-09-01" }] },
    { sports: [{ fn: "schedule", league: "epl", num_games: 0 }] },
    { time: [{ utc_offset: "+24:00" }] },
    { time: [{ utc_offset: "+08:60" }] },
    { time: [{ utc_offset: "8" }] },
    { time: Array(11).fill({ utc_offset: "+00:00" }) },
    { time: [] },
  ];
  for (const commands of invalid)
    assert.throws(() =>
      validateSearchRequest({ id: "s", model: "gpt-6-astra", commands: commands as SearchCommands }),
    );
});
