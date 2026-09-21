import test from "node:test";
import assert from "node:assert/strict";
import { ImageClient } from "../../../../packages/capabilities/gen_image/openai/src/client.ts";
import { WebClient } from "../../../../packages/capabilities/search_web/openai/src/client.ts";
import {
  IMAGE_DEFAULTS,
  type ImageRequest,
} from "../../../../packages/capabilities/gen_image/openai/src/types.ts";
import { auth, image, search, json } from "../helpers.ts";

test("image edit sends fixed defaults and URL references without SDK translation", async () => {
  const request: ImageRequest = {
    ...image,
    ...IMAGE_DEFAULTS,
    images: [{ image_url: "https://example.com/source.png" }],
    background: "transparent",
    size: "2048x1152",
  };
  const client = new ImageClient(auth, async (url, init) => {
    assert.equal(String(url).split("/codex/")[1], "images/edits");
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    assert.equal(new Headers(init?.headers).get("x-codex-image-turn-id"), "turn1");
    return json({ data: [{ b64_json: "aGVsbG8=" }] });
  });
  assert.equal((await client.images(request, { turnId: "turn1" })).data.data.length, 1);
});

test("generation has no images field and uses generations route", async () => {
  await new ImageClient(auth, async (url, init) => {
    assert.match(String(url), /images\/generations$/);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ...IMAGE_DEFAULTS,
      ...image,
      size: "auto",
      background: "auto",
    });
    return json({ data: [{ b64_json: "aGVsbG8=" }] });
  }).images(image);
});

test("stream parses progress and final events; ignores partial image as final", async () => {
  const events = [
    { type: "image_generation.partial_image", partial_image_index: 0, b64_json: "cGFydGlhbA==" },
    {
      type: "image_generation.completed",
      b64_json: "ZmluYWw=",
      output_format: "png",
      usage: { total_tokens: 12 },
    },
  ];
  const seen: number[] = [];
  const client = new ImageClient(
    auth,
    async () =>
      new Response(events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const result = await client.images({ ...image, stream: true }, { onProgress: (e) => seen.push(e.index!) });
  assert.deepEqual(seen, [0]);
  assert.equal(result.data.data[0]?.b64_json, "ZmluYWw=");
  assert.deepEqual(result.data.usage, { total_tokens: 12 });
});

test("stream truncation, malformed JSON, error event, and empty images are failures", async () => {
  for (const body of [
    'data: {"type":"image_edit.partial_image","b64_json":"x"}\n\n',
    "data: not-json\n\n",
    'data: {"type":"error","message":"failed"}\n\n',
  ]) {
    await assert.rejects(
      new ImageClient(
        auth,
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      ).images({ ...image, stream: true }),
    );
  }
  await assert.rejects(new ImageClient(auth, async () => json({ data: [] })).images(image), /1–10/);
  await assert.rejects(
    new WebClient(auth, async () => new Response("<html>login</html>")).search(search),
    /invalid JSON/,
  );
});
