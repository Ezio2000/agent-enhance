import test from "node:test";
import assert from "node:assert/strict";
import { VideoClient } from "../../../../packages/capabilities/gen_video/xai/src/client.ts";
import { VIDEO_DEFAULTS, VIDEO_MODEL } from "../../../../packages/capabilities/gen_video/xai/src/types.ts";

const auth = async () => ({ baseUrl: "https://api.x.ai/v1/", headers: { Authorization: "Bearer token" } });
const request = { ...VIDEO_DEFAULTS, prompt: "animate this", image: { url: "https://example.com/a.png" } };
const mp4 = Buffer.from("fake-mp4");

function mockApi(opts: {
  start?: (body: unknown) => Response | Promise<Response>;
  poll?: (n: number) => Response | Promise<Response>;
  download?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  onStart?: () => void;
}): typeof fetch {
  let polls = 0;
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/videos/generations")) {
      opts.onStart?.();
      const body = JSON.parse(String(init?.body));
      return opts.start?.(body) ?? Response.json({ request_id: "vid-1" });
    }
    if (u.endsWith("/videos/vid-1")) {
      polls++;
      return (
        opts.poll?.(polls) ?? Response.json({ status: "done", video: { url: "https://cdn.example/out.mp4" } })
      );
    }
    if (u.startsWith("https://cdn.example/")) {
      assert.equal(init?.headers, undefined);
      return opts.download?.(u, init) ?? new Response(mp4);
    }
    throw new Error(`unexpected url ${u}`);
  }) as typeof fetch;
}

test("start, poll until done, and download without auth headers", async () => {
  let polls = 0;
  const client = new VideoClient(
    auth,
    mockApi({
      poll: (n) => {
        polls = n;
        if (n === 1) return Response.json({ status: "pending" });
        return Response.json({ status: "done", video: { url: "https://cdn.example/out.mp4" } });
      },
    }),
    0,
  );
  const result = await client.videos(request);
  assert.equal(result.requestId, "vid-1");
  assert.deepEqual(Buffer.from(result.bytes), mp4);
  assert.equal(polls, 2);
});

test("202 poll is treated as in-progress; failed and expired do not retry the start", async () => {
  for (const [status, pattern] of [
    ["failed", /failed on the server/],
    ["expired", /expired/],
  ] as const) {
    let starts = 0;
    const client = new VideoClient(
      auth,
      mockApi({
        onStart: () => {
          starts++;
        },
        poll: () => Response.json({ status, video: { url: "https://cdn.example/out.mp4" } }),
      }),
      0,
    );
    await assert.rejects(client.videos(request), pattern);
    assert.equal(starts, 1);
  }
  let starts = 0;
  const client = new VideoClient(
    auth,
    mockApi({
      onStart: () => {
        starts++;
      },
      poll: (n) =>
        n === 1
          ? new Response("{}", { status: 202 })
          : Response.json({ status: "done", video: { url: "https://cdn.example/out.mp4" } }),
    }),
    0,
  );
  await client.videos(request);
  assert.equal(starts, 1);
});

test("zero rate limit explains token recognition without asserting exhausted subscription; no retry", async () => {
  let calls = 0;
  const client = new VideoClient(
    auth,
    async () => {
      calls++;
      return Response.json({ error: "Requests per Minute (actual/limit): 0/0" }, { status: 429 });
    },
    0,
  );
  await assert.rejects(client.videos(request), /does not prove.*weekly allowance is exhausted/);
  assert.equal(calls, 1);
});

test("401/403/server errors retain status and do not retry", async () => {
  for (const status of [401, 403, 500]) {
    let calls = 0;
    const client = new VideoClient(
      auth,
      async () => {
        calls++;
        return Response.json({ error: { message: "backend reason" } }, { status });
      },
      0,
    );
    await assert.rejects(client.videos(request), new RegExp(`HTTP ${status}: backend reason`));
    assert.equal(calls, 1);
  }
});

test("missing request_id or download URL is not reported as a generated video", async () => {
  await assert.rejects(
    new VideoClient(auth, mockApi({ start: () => Response.json({ request_id: "" }) }), 0).videos(request),
    /no request_id/,
  );
  await assert.rejects(
    new VideoClient(auth, mockApi({ poll: () => Response.json({ status: "done", video: {} }) }), 0).videos(
      request,
    ),
    /no download URL/,
  );
});

test("cancellation is propagated and an already-cancelled call never resolves auth", async () => {
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  const client = new VideoClient(
    async () => {
      throw new Error("unexpected auth");
    },
    undefined,
    0,
  );
  await assert.rejects(client.videos(request, { signal: controller.signal }), /user cancelled/);
});

test("timeout aborts the in-flight poll without retrying start", async () => {
  let starts = 0;
  const client = new VideoClient(
    auth,
    mockApi({
      onStart: () => {
        starts++;
      },
      poll: () => Response.json({ status: "pending" }),
    }),
    1,
  );
  await assert.rejects(client.videos(request, { timeoutMs: 20 }), /timed out/);
  assert.equal(starts, 1);
});
