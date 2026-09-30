import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { startNative } from "../../../../packages/capabilities/use_computer/native/src/runtime.ts";
import { ComputerSession } from "../../../../packages/capabilities/use_computer/native/src/session.ts";
import { enhanceHome } from "../../../../packages/core/src/config.ts";
const exec = promisify(execFile);
test(
  "controlled native UI: background AX, Unicode input, screenshot, modifier drag and stale IDs",
  {
    skip: process.platform !== "darwin" || process.env.NATIVE_COMPUTER_LIVE !== "1",
    timeout: 60000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "enhance-native-ui-"));
    const native = await startNative(join(enhanceHome(), "runtimes"));
    const session = new ComputerSession(root, async () => native);
    const fixturePids: number[] = [];
    try {
      assert.ok(
        Object.values(native.info.permissions).every(Boolean),
        `Native UI test requires OS grants: ${JSON.stringify(native.info.permissions)}. No UI success is claimed.`,
      );
      const payload = JSON.parse(
        gunzipSync(await readFile("dist/native/computer-runtime.json.gz")).toString(),
      );
      for (const name of ["background", "front"]) {
        const app = join(root, name, "Agent Enhance Computer.app");
        for (const file of payload.files) {
          const target = join(root, name, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(file.data, "base64"), { mode: file.mode });
        }
        const plist = join(app, "Contents/Info.plist");
        await writeFile(
          plist,
          (await readFile(plist, "utf8")).replace(
            "com.agent-enhance.computer",
            `com.agent-enhance.fixture.${name}`,
          ),
        );
        await exec("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
        await exec("open", ["-n", "-g", app, "--args", "--fixture"]);
        await new Promise((resolve) => setTimeout(resolve, 600));
        await native.request("beginCall", { callId: "fixtures" });
        try {
          const state = await native.request("getState", { callId: "fixtures" });
          const fixture = state.apps.find((a: any) => a.id === `com.agent-enhance.fixture.${name}`);
          assert.ok(fixture, `Fixture ${name} did not launch`);
          fixturePids.push(fixture.pid);
        } finally {
          await native.request("endCall");
        }
      }
      const run = async (code: string) => {
        const result = await session.run({ code, sessionId: "native-ui", timeoutMs: 10000 });
        assert.equal(result.error, undefined, result.error?.message);
        return result;
      };
      const inspect = async (expression: string) => {
        // Explicit print avoids inspect adding quotes around a string expression.
        const printed = await run(`print(JSON.stringify(${expression}));`);
        return JSON.parse(printed.content.at(-1)!.text!);
      };
      const apps = await inspect("await computer.listApps()");
      assert.equal(apps.find((a: any) => a.active)?.id, "com.agent-enhance.fixture.front");
      await run(
        "var app=await computer.getApp('com.agent-enhance.fixture.background'); var windows=await app.listWindows(); var win=await app.getWindow(windows[0].id); var state=await win.observe();",
      );
      let state = await inspect("state");
      const button = state.elements.find((e: any) => e.identifier === "fixture-button");
      assert.ok(button);
      await run(
        `await win.click({element:${JSON.stringify(button.id)}}); await computer.wait(100); state=await win.observe();`,
      );
      state = await inspect("state");
      assert.ok(state.elements.some((e: any) => e.value === "count: 1" || e.title === "count: 1"));
      const field = state.elements.find((e: any) => e.identifier === "fixture-text");
      assert.ok(field);
      await run(`await win.setValue(${JSON.stringify(field.id)},'后台中文😀'); state=await win.observe();`);
      state = await inspect("state");
      assert.equal(state.elements.find((e: any) => e.identifier === "fixture-text").value, "后台中文😀");
      const after = await inspect("await computer.listApps()");
      assert.equal(
        after.find((a: any) => a.active)?.id,
        "com.agent-enhance.fixture.front",
        "background AX must not activate target",
      );
      const freshField = state.elements.find((e: any) => e.identifier === "fixture-text");
      await run(
        `await win.click({element:${JSON.stringify(freshField.id)}},{mode:'foreground'}); await win.pressKey(['command','a'],{mode:'foreground'}); await win.typeText('前台文字✅',{mode:'foreground'}); await computer.wait(150); state=await win.observe();`,
      );
      state = await inspect("state");
      assert.equal(state.elements.find((e: any) => e.identifier === "fixture-text").value, "前台文字✅");
      const screenshot = await run("await win.screenshot()");
      assert.ok(screenshot.content.some((c) => c.type === "image" && c.mimeType === "image/png"));
      const canvas = state.elements.find((e: any) => e.identifier === "fixture-canvas");
      assert.ok(canvas, "fixture canvas must appear in AX observation");
      const from = { x: canvas.bounds.x - state.bounds.x + 30, y: canvas.bounds.y - state.bounds.y + 30 };
      const to = { x: from.x + 150, y: from.y + 50 };
      await run(
        `await win.withKeys(['shift'],async()=>{await win.drag({from:${JSON.stringify(from)},to:${JSON.stringify(to)}});},{mode:'foreground'}); await computer.wait(150); state=await win.observe();`,
      );
      state = await inspect("state");
      assert.ok(
        state.elements.some(
          (e: any) => e.value === "drag: true shift: true" || e.title === "drag: true shift: true",
        ),
      );
      const stale = await session.run({
        code: `await win.click({element:${JSON.stringify(button.id)}})`,
        sessionId: "native-ui",
        timeoutMs: 10000,
      });
      assert.match(stale.error!.message, /old observation|STALE|Element/);
      await session.endTurn();
      assert.equal(session.status().connected, false);
      assert.equal(session.status().lastCleanup!.nativeStopped, true);
    } finally {
      await session.reset();
      await native.close();
      for (const pid of fixturePids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* fixture already closed */
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
