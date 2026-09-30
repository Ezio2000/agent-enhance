import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import {
  startNative,
  NativeConnection,
} from "../../../../packages/capabilities/use_computer/native/src/runtime.ts";
import { createComputer } from "../../../../packages/capabilities/use_computer/native/src/index.ts";
import { ComputerSchema } from "../../../../packages/capabilities/use_computer/native/src/tool.ts";
import { Value } from "typebox/value";
test("factory/status do not start native processes; only status/reset management exists", async () => {
  const instance = createComputer({ artifactRoot: "/tmp/not-used" });
  assert.equal((instance.status!() as any).connected, false);
  assert.equal((instance.status!() as any).permissions, "not_checked");
  await assert.rejects(instance.manage!("ask"), /status \/ reset/);
  await instance.dispose!();
  assert.ok(Value.Check(ComputerSchema, { code: "await computer.getState()" }));
  assert.ok(!Value.Check(ComputerSchema, { code: "x", approvalMode: "ask" }));
});
test("native framing handles fragmented replies, typed uncertainty and idempotent shutdown", async () => {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const result =
          JSON.stringify(
            request.method === "uncertain"
              ? {
                  id: request.id,
                  error: { code: "AX_ERROR", message: "Uncertain effect", indeterminate: true },
                }
              : { id: request.id, result: { releasedKeys: 1 } },
          ) + "\n";
        socket.write(result.slice(0, 5));
        socket.write(result.slice(5));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect((server.address() as any).port, "127.0.0.1");
  await once(socket, "connect");
  let disposed = 0;
  const native = new NativeConnection(socket, async () => {
    disposed++;
    return { nativeStopped: true };
  });
  try {
    assert.deepEqual(await native.request("getState"), { releasedKeys: 1 });
    await assert.rejects(
      native.request("uncertain"),
      (error: any) => error.code === "AX_ERROR" && error.indeterminate,
    );
    const [first, second] = await Promise.all([native.close(), native.close()]);
    assert.deepEqual(first, second);
    assert.equal(disposed, 1);
    assert.equal(first.releasedKeys, 1);
    assert.equal(native.alive, false);
    await assert.rejects(native.request("getState"), /closed/);
  } finally {
    await native.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("native disconnect rejects pending work without resubmission", async () => {
  let requests = 0;
  const server = createServer((socket) =>
    socket.on("data", () => {
      requests++;
      socket.destroy();
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connect((server.address() as any).port, "127.0.0.1");
  await once(socket, "connect");
  const native = new NativeConnection(socket);
  try {
    await assert.rejects(native.request("click"), /disconnected/);
    assert.equal(requests, 1);
    assert.equal(native.alive, false);
  } finally {
    await native.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test(
  "bundled native application starts without ChatGPT, login or plugin discovery",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "enhance-native-test-"));
    const previous = process.env.OPENAI_CODEX_COMPUTER_APP;
    process.env.OPENAI_CODEX_COMPUTER_APP = "/does-not-exist/ChatGPT.app";
    let native;
    try {
      native = await startNative(root);
      assert.equal(native.info.protocol, 1);
      assert.ok(native.info.pid > 0);
      await assert.rejects(native.request("getState", { callId: "finished" }), /owning JS call/);
      await native.request("beginCall", { callId: "read-only" });
      await assert.rejects(native.request("beginCall", { callId: "other-call" }), /already active/);
      const state = await native.request("getState", { callId: "read-only" });
      assert.ok(Array.isArray(state.apps));
      await native.request("endCall");
      await assert.rejects(native.request("getState", { callId: "read-only" }), /owning JS call/);
      const cleanup = await native.close();
      assert.equal(cleanup.nativeStopped, true);
      assert.equal(cleanup.workspaceRemoved, true);
    } finally {
      await native?.close();
      await rm(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.OPENAI_CODEX_COMPUTER_APP;
      else process.env.OPENAI_CODEX_COMPUTER_APP = previous;
    }
  },
);
