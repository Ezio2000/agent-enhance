import test from "node:test";
import assert from "node:assert/strict";
import { VoiceClient } from "../../../../packages/capabilities/gen_voice/minimax/src/client.ts";
import { VOICE_DEFAULTS } from "../../../../packages/capabilities/gen_voice/minimax/src/types.ts";

const auth = async () => ({
  baseUrl: "https://api.minimaxi.com/v1/",
  headers: { Authorization: "Bearer sk-cp-test" },
});
const mp3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]); // "ID3" header + junk
const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("speak posts fixed audio_setting and decodes hex audio into MP3 bytes", async () => {
  let calls = 0;
  const client = new VoiceClient(auth, async (url, init) => {
    calls++;
    assert.ok(String(url).endsWith("t2a_v2"));
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "speech-2.8-turbo",
      text: "你好",
      stream: false,
      voice_setting: { voice_id: "female-shaonv", speed: 1.1, vol: 1, pitch: 2, emotion: "happy" },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    });
    return json({
      data: { audio: mp3.toString("hex"), status: 2 },
      extra_info: { usage_characters: 2, audio_length: 800, audio_format: "mp3" },
      trace_id: "t-1",
      base_resp: { status_code: 0, status_msg: "success" },
    });
  });
  const result = await client.speak({
    model: "speech-2.8-turbo",
    text: "你好",
    stream: false,
    voice_setting: { voice_id: "female-shaonv", speed: 1.1, vol: 1, pitch: 2, emotion: "happy" },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
  });
  assert.deepEqual(Buffer.from(result.data.audio.subarray(0, 3)), Buffer.from("ID3"));
  assert.equal(result.data.extraInfo!.usageCharacters, 2);
  assert.equal(result.data.traceId, "t-1");
  assert.equal(calls, 1); // exactly one request; no quota side-call
  assert.equal(VOICE_DEFAULTS.model, "speech-2.8-hd");
});

test("base64-looking audio is rejected: the channel is hex, verified live", async () => {
  const client = new VoiceClient(auth, async () =>
    json({ data: { audio: mp3.toString("base64") }, base_resp: { status_code: 0 } }),
  );
  await assert.rejects(
    client.speak({
      model: "speech-2.8-hd",
      text: "x",
      stream: false,
      voice_setting: { voice_id: "male-qn-qingse", speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
    /missing hex audio/,
  );
});

test("business errors surface verbatim with an English hint", async () => {
  const failing = new VoiceClient(auth, async () =>
    json({
      data: { audio: "" },
      base_resp: { status_code: 2067, status_msg: "Token Plan 用量上限" },
    }),
  );
  await assert.rejects(
    failing.speak({
      model: "speech-2.8-hd",
      text: "x",
      stream: false,
      voice_setting: { voice_id: "v", speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
    /2067/,
  );
});
