import test from "node:test";
import assert from "node:assert/strict";
import { validateSearchRequest } from "../../../../packages/capabilities/search_web/openai/src/validation.ts";
import { search } from "../helpers.ts";

test("search validation checks operations, query count, domains and location", () => {
  assert.throws(() => validateSearchRequest({ ...search, commands: {} }));
  assert.throws(
    () => validateSearchRequest({ ...search, commands: { search_query: Array(4).fill({ q: "x" }) } }),
    /medium or long/,
  );
  assert.doesNotThrow(() =>
    validateSearchRequest({
      ...search,
      commands: { search_query: Array(4).fill({ q: "x" }), response_length: "long" },
    }),
  );
  assert.throws(() =>
    validateSearchRequest({ ...search, settings: { filters: { allowed_domains: ["https://openai.com"] } } }),
  );
  assert.throws(() =>
    validateSearchRequest({ ...search, commands: { open: [{ ref_id: "file:///etc/passwd" }] } }),
  );
  assert.throws(() =>
    validateSearchRequest({
      ...search,
      settings: { user_location: { type: "approximate", timezone: "not/a/timezone" } },
    }),
  );
});
