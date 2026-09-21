import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  imageTool,
  promptSnippetText,
  formatResetIn,
  quotaLine,
} from "../../../../packages/capabilities/gen_image/openai/src/tool.ts";
import { ImageArtifactStore } from "../../../../packages/capabilities/gen_image/openai/src/artifacts.ts";
import { ImageClient } from "../../../../packages/capabilities/gen_image/openai/src/client.ts";
import { png } from "../../../fixtures/openai/fixtures.ts";
import { ctx, json } from "../../../fixtures/openai/helpers.ts";

const quotaHeaders = {
  "x-codex-plan-type": "pro",
  "x-codex-primary-used-percent": "12",
  "x-codex-primary-reset-after-seconds": "576590",
};
const okImage = { data: [{ b64_json: png().toString("base64") }], output_format: "png" };

test("quota headers surface in progress updates, summary text and details", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-progress-"));
  try {
    const updates: { text: string; details?: Record<string, unknown> }[] = [];
    const client = new ImageClient(
      async () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/", headers: {} }),
      async () => json(okImage, 200, quotaHeaders),
    );
    const tool = imageTool({ client: () => client, artifacts: new ImageArtifactStore(root) });
    const result = await tool.execute(
      "call",
      { prompt: "A blue whale icon" },
      undefined,
      (update) => {
        updates.push({ text: String(update.content[0]?.text), details: update.details });
      },
      ctx(root),
    );
    assert.ok(updates.length >= 1);
    assert.match(updates[0]!.text, /Generating image\(s\) with gpt-image-2\.5-flare/);
    assert.match(updates[0]!.text, /"A blue whale icon"/);
    const text = String(result.content[0]?.text);
    assert.match(
      text,
      /"A blue whale icon" · gpt-image-2\.5-flare · elapsed [\d.]+s · quota 12% used · resets in 6d 1\dh/,
    );
    const details = result.details as Record<string, unknown>;
    assert.equal(typeof details.elapsedSeconds, "number");
    const quota = details.quota as { plan?: string; usedPercent?: number; resetAt?: number };
    assert.equal(quota.plan, "pro");
    assert.equal(quota.usedPercent, 12);
    assert.ok(quota.resetAt! > Date.now());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing quota headers degrade silently with no quota line", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-progress-"));
  try {
    const client = new ImageClient(
      async () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/", headers: {} }),
      async () => json(okImage),
    );
    const tool = imageTool({ client: () => client, artifacts: new ImageArtifactStore(root) });
    const result = await tool.execute(
      "call",
      { prompt: "A blue whale icon" },
      undefined,
      undefined,
      ctx(root),
    );
    assert.doesNotMatch(String(result.content[0]?.text), /quota/);
    assert.equal((result.details as Record<string, unknown>).quota, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ticker emits periodic progress updates and is cleaned up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "enhance-progress-"));
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  try {
    const updates: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      images: async () => {
        await gate;
        return { data: okImage, quota: undefined };
      },
    } as unknown as ImageClient;
    const tool = imageTool({ client: () => client, artifacts: new ImageArtifactStore(root) });
    const execution = tool.execute(
      "call",
      { prompt: "slow generation" },
      undefined,
      (update) => updates.push(String(update.content[0]?.text)),
      ctx(root),
    );
    t.mock.timers.tick(1000);
    t.mock.timers.tick(1000);
    release();
    await execution;
    assert.equal(updates.length, 3);
    assert.match(updates[1]!, /⏱ 1s/);
    assert.match(updates[2]!, /⏱ 2s/);
    t.mock.timers.tick(5000);
    assert.equal(updates.length, 3, "settled execution must clear its ticker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failures are annotated with prompt, elapsed time and quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-progress-"));
  try {
    const client = {
      images: async () => {
        throw new Error("OpenAI HTTP 200 (moderation_blocked): rejected by the safety system.");
      },
    } as unknown as ImageClient;
    const tool = imageTool({ client: () => client, artifacts: new ImageArtifactStore(root) });
    await assert.rejects(
      tool.execute("call", { prompt: "cosplay at the beach" }, undefined, undefined, ctx(root)),
      (error) => {
        assert.match(String((error as Error).message), /moderation_blocked/);
        assert.match(String((error as Error).message), /Prompt: "cosplay at the beach" · elapsed \d+s/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatting helpers", () => {
  assert.equal(promptSnippetText("short prompt"), "short prompt");
  assert.equal(promptSnippetText(`  multi\n  line  `.repeat(10)).length, 61);
  assert.equal(formatResetIn(Date.now() + 576590 * 1000), "6d 16h");
  assert.equal(formatResetIn(Date.now() + 3600 * 1000), "1h 0m");
  assert.equal(quotaLine(undefined), "");
  assert.equal(quotaLine({ usedPercent: 12, resetAt: Date.now() + 60_000 }), "quota 12% used · resets in 1m");
  assert.equal(quotaLine({ plan: "pro" }), "");
});
