import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";
import { voiceTool } from "../../../../packages/capabilities/gen_voice/minimax/src/tool.ts";
import { VoiceArtifactStore } from "../../../../packages/capabilities/gen_voice/minimax/src/artifacts.ts";
import { VoiceClient } from "../../../../packages/capabilities/gen_voice/minimax/src/client.ts";

const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(120, 7)]);
const context = (cwd: string) =>
  ({
    cwd,
    model: { provider: "anthropic", id: "other" },
    sessionId: "session",
    host: "test",
  }) as unknown as ExecutionContext;

test("tool saves an exclusive mp3 original and reports real per-call usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "minimax-voice-tool-"));
  try {
    const client = {
      speak: async () => ({
        data: {
          audio: mp3,
          extraInfo: { usageCharacters: 22, audioLength: 2412, audioFormat: "mp3" },
          traceId: "trace-9",
        },
        requestId: "req-3",
      }),
    } as unknown as VoiceClient;
    const tool = voiceTool({ artifacts: new VoiceArtifactStore(root), client: () => client });
    const result = await tool.execute(
      "call",
      {
        text: "今天天气不错。",
        model: "speech-2.8-turbo",
        voice_id: "female-shaonv",
        emotion: "happy",
        speed: 1.1,
      },
      undefined,
      undefined,
      context(root),
    );
    const text = String(result.content[0]!.text);
    assert.match(text, /Voice: .*voice-1\.mp3 \(\d+ bytes\)/);
    assert.match(
      text,
      /"今天天气不错。" · speech-2\.8-turbo · female-shaonv · elapsed [\d.]+s · 22 chars used\n/,
    );
    assert.doesNotMatch(text, /quota/); // the daily char allowance is server-side; never fabricated
    const voice = result.details!.voice as { path: string };
    assert.deepEqual(await readFile(voice.path), mp3);
    assert.equal((await stat(voice.path)).mode & 0o777, 0o600);
    assert.equal((result.details as Record<string, any>).extraInfo.usageCharacters, 22);
    assert.equal(result.details!.emotion, "happy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid arguments fail before any client call", async () => {
  const root = await mkdtemp(join(tmpdir(), "minimax-voice-invalid-"));
  try {
    const tool = voiceTool({
      artifacts: new VoiceArtifactStore(root),
      client: () => {
        throw new Error("unexpected network");
      },
    });
    for (const args of [
      { text: " " },
      { text: "x", emotion: "excited" },
      { text: "x", speed: 3 },
      { text: "x", pitch: -13 },
      { text: "x", voice_id: "" },
      { text: "x", model: "speech-1.0" },
    ]) {
      await assert.rejects(
        tool.execute("call", args as never, undefined, undefined, context(root)),
        (error) => error instanceof Error && !error.message.includes("unexpected network"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
