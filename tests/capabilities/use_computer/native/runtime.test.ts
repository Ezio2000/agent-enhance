import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import {
  startNative,
  NativeConnection,
  withInstalledNative,
} from "../../../../packages/capabilities/use_computer/native/src/runtime.ts";
import { createComputer } from "../../../../packages/capabilities/use_computer/native/src/index.ts";
import { ComputerSchema } from "../../../../packages/capabilities/use_computer/native/src/tool.ts";
import { Value } from "typebox/value";
test("an exited installer releases its OS lock without manual recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-native-crash-"));
  const source = new URL(
    "../../../../packages/capabilities/use_computer/native/src/runtime.ts",
    import.meta.url,
  ).href;
  const childFile = join(root, "child.mts");
  await writeFile(
    childFile,
    `import {withInstalledNative} from ${JSON.stringify(source)}; await withInstalledNative(${JSON.stringify(root)},Buffer.from(${JSON.stringify(samplePayload("v1").toString("base64"))},'base64'),async()=>{console.log('locked');await new Promise(()=>{});});`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", childFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Installer did not acquire its lock: " + stderr)),
        5000,
      );
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Installer exited before lock: " + stderr));
      });
    });
    const stopped = once(child, "exit");
    child.kill("SIGKILL");
    await stopped;
    const started = Date.now();
    await withInstalledNative(root, samplePayload("v2"), async (app) =>
      assert.equal(await readFile(join(app, "Contents/MacOS/ComputerRuntime"), "utf8"), "v2"),
    );
    assert.ok(Date.now() - started < 5000);
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
const samplePayload = (value: string, valid = true) =>
  gzipSync(
    Buffer.from(
      JSON.stringify({
        files: [
          {
            path: `Agent Enhance Computer.app/Contents/${valid ? "MacOS/ComputerRuntime" : "incomplete"}`,
            data: Buffer.from(value).toString("base64"),
            mode: 0o755,
          },
        ],
      }),
    ),
  );
test("native upgrades keep the real bundle path and serialize installation through launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-native-install-"));
  let appPath = "";
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const held = new Promise<void>((resolve) => (finish = resolve));
  try {
    const first = withInstalledNative(root, samplePayload("v1"), async (app) => {
      appPath = app;
      enter();
      await held;
      assert.equal(await readFile(join(app, "Contents/MacOS/ComputerRuntime"), "utf8"), "v1");
    });
    await entered;
    const second = withInstalledNative(root, samplePayload("v2"), async (app) => {
      assert.equal(app, appPath);
      assert.equal(await readFile(join(app, "Contents/MacOS/ComputerRuntime"), "utf8"), "v2");
    });
    finish();
    await Promise.all([first, second]);
    await withInstalledNative(root, samplePayload("v2"), async (app) => assert.equal(app, appPath));
    await writeFile(
      join(root, "native-computer/instances", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid }),
    );
    await assert.rejects(
      withInstalledNative(root, samplePayload("v3"), async () =>
        assert.fail("Do not replace a running bundle"),
      ),
      (error: any) => error.code === "RUNTIME_UPGRADE_REQUIRED",
    );
    assert.equal(await readFile(join(appPath, "Contents/MacOS/ComputerRuntime"), "utf8"), "v2");
    await rm(join(root, "native-computer/instances", `${process.pid}.json`));
    await access(join(root, "native-computer/install.lock"));
    await assert.rejects(
      withInstalledNative(root, samplePayload("broken", false), async () =>
        assert.fail("Invalid app must not launch"),
      ),
    );
    assert.equal(await readFile(join(appPath, "Contents/MacOS/ComputerRuntime"), "utf8"), "v2");
  } finally {
    finish?.();
    await rm(root, { recursive: true, force: true });
  }
});
test("failed launches and cancellation release or avoid installation ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-native-install-"));
  try {
    await assert.rejects(
      withInstalledNative(root, samplePayload("v1"), async () => {
        throw new Error("launch failed");
      }),
      /launch failed/,
    );
    await access(join(root, "native-computer/install.lock"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      withInstalledNative(
        root,
        samplePayload("v2"),
        async () => assert.fail("Cancelled launch"),
        controller.signal,
      ),
      /cancelled/,
    );
    await withInstalledNative(root, samplePayload("v1"), async (app) =>
      assert.equal(await readFile(join(app, "Contents/MacOS/ComputerRuntime"), "utf8"), "v1"),
    );
    {
      await writeFile(join(root, "native-computer/install.lock"), "2147483647\n");
      await withInstalledNative(root, samplePayload("v2"), async (app) =>
        assert.equal(await readFile(join(app, "Contents/MacOS/ComputerRuntime"), "utf8"), "v2"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
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
