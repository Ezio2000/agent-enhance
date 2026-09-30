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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

test(
  "controlled native UI: isolated text/mouse/keyboard, sibling refusal, expectations and active-action cancellation",
  { skip: process.platform !== "darwin" || process.env.NATIVE_COMPUTER_LIVE !== "1", timeout: 120000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "enhance-native-ui-"));
    const cache = join(enhanceHome(), "runtimes");
    const fixturePids: number[] = [],
      fixturePaths: string[] = [];
    const session = new ComputerSession(join(root, "isolated"), (_root, signal, policy) =>
      startNative(cache, signal, policy),
    );
    const shared = new ComputerSession(
      join(root, "shared"),
      (_root, signal, policy) => startNative(cache, signal, policy),
      "shared",
    );
    let native;
    let original: any;
    const helper = join(root, "desktop-state");
    const stateSource = join(root, "desktop-state.swift");
    await writeFile(
      stateSource,
      `import AppKit
import CoreGraphics
import Foundation
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
if CommandLine.arguments.count == 3 {
 let state = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String: Any]
 NSRunningApplication(processIdentifier: state["pid"] as! Int32)?.activate(options: [])
 let point = CGPoint(x: state["x"] as! Double, y: state["y"] as! Double)
 if CGEvent(source: nil)!.location != point {
  let e = CGEvent(mouseEventSource: CGEventSource(stateID: .privateState), mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)!
  e.flags = []; e.post(tap: .cghidEventTap)
 }
 RunLoop.current.run(until: Date().addingTimeInterval(0.4))
}
let p = CGEvent(source: nil)!.location
let state: [String: Any] = ["pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "x": p.x, "y": p.y, "clipboard": NSPasteboard.general.changeCount]
print(String(data: try JSONSerialization.data(withJSONObject: state), encoding: .utf8)!)
`,
    );
    await exec("swiftc", [stateSource, "-o", helper]);
    const desktopState = async () => JSON.parse((await exec(helper, [])).stdout);
    try {
      original = await desktopState();
      await writeFile(join(root, "original.json"), JSON.stringify(original));
      native = await startNative(cache);
      assert.ok(
        Object.values(native.info.permissions).every(Boolean),
        `Native UI test requires OS grants: ${JSON.stringify(native.info.permissions)}. No UI success is claimed.`,
      );
      assert.equal(native.info.isolation, "isolated-only");
      assert.equal(native.info.directedPointer, true);
      const payload = JSON.parse(
        gunzipSync(await readFile("dist/native/computer-runtime.json.gz")).toString(),
      );
      const ids: Record<string, string> = {};
      for (const name of ["background", "front"]) {
        const app = join(root, name, "Agent Enhance Computer.app");
        ids[name] = `com.agent-enhance.fixture.${name}.${process.pid}`;
        for (const file of payload.files) {
          const target = join(root, name, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(file.data, "base64"), { mode: file.mode });
        }
        const plist = join(app, "Contents/Info.plist");
        await writeFile(
          plist,
          (await readFile(plist, "utf8")).replace("com.agent-enhance.computer", ids[name]),
        );
        await exec("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
        fixturePaths.push(app);
        await exec("open", ["-n", "-g", app, "--args", "--fixture"]);
        await sleep(800);
        await native.request("beginCall", { callId: "fixtures" });
        try {
          const state = await native.request("getState", { callId: "fixtures" });
          const fixture = state.apps.find((a: any) => a.id === ids[name]);
          assert.ok(fixture, `Fixture ${name} did not launch`);
          fixturePids.push(fixture.pid);
          let ready = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            try {
              const list = await native.request("listWindows", { app: ids[name], callId: "fixtures" });
              ready = list.length === 3 && list.every((w: any) => w.bounds.width > 0);
              if (ready) break;
            } catch (error) {
              if (attempt === 29) throw error;
            }
            await sleep(100);
          }
          assert.ok(ready, "Fixture accessibility windows must be ready");
        } finally {
          await native.request("endCall");
        }
      }
      const run = async (code: string, owner = session, timeoutMs = 10000) => {
        const result = await owner.run({ code, sessionId: "native-ui", timeoutMs });
        assert.equal(
          result.error,
          undefined,
          JSON.stringify({
            error: result.error,
            operations: result.operations,
            content: result.content.filter((c) => c.type === "text").slice(-1),
          }),
        );
        return result;
      };
      const inspect = async (expression: string, owner = session) => {
        const printed = await run(`print(JSON.stringify(${expression}));`, owner);
        return JSON.parse(printed.content.at(-1)!.text!);
      };
      await run(
        `var front=await computer.getApp(${JSON.stringify(ids.front)}); var fw=await front.listWindows(); var frontWin=await front.getWindow(fw.find(w=>w.title==='Agent Enhance Computer Fixture').id); await frontWin.activate(); var userSnapshot=await frontWin.observe();`,
        shared,
      );
      let userState = await desktopState();
      const assertUnchanged = async () =>
        assert.deepEqual(
          await desktopState(),
          userState,
          "isolated CU must preserve user app, physical cursor and clipboard",
        );
      await run(
        `var app=await computer.getApp(${JSON.stringify(ids.background)}); var windows=await app.listWindows(); var win=await app.getWindow(windows.find(w=>w.title==='Agent Enhance Computer Fixture').id); var state=await win.observe();`,
      );
      const refresh = async () => {
        await run("state=await win.observe()");
        return inspect("state");
      };
      let state = await inspect("state");
      const row = (s: any, id: string) => {
        const e = s.elements.find((e: any) => e.identifier === id);
        assert.ok(e, id);
        return e;
      };
      const local = (s: any, e: any, dx = 10, dy = 10) => ({
        x: e.bounds.x - s.bounds.x + dx,
        y: e.bounds.y - s.bounds.y + dy,
      });
      const button = row(state, "fixture-button");
      await run(`await win.click({element:${JSON.stringify(button.id)}}); await computer.wait(100)`);
      state = await refresh();
      assert.equal(row(state, "fixture-count").value, "count: 1");
      let field = row(state, "fixture-text");
      await run(
        `await win.replaceText(${JSON.stringify(field.id)},'A中🙂Z'); await win.selectText(${JSON.stringify(field.id)},{location:1,length:3}); await win.typeText('X',{element:${JSON.stringify(field.id)},expect:{element:${JSON.stringify(field.id)},value:'AXZ'}})`,
      );
      state = await refresh();
      assert.equal(row(state, "fixture-text").value, "AXZ");
      let area = row(state, "fixture-text-area");
      await run(
        `await win.replaceText(${JSON.stringify(area.id)},'seed'); await win.selectAll(${JSON.stringify(area.id)}); await win.typeText('ALL',{element:${JSON.stringify(area.id)},expect:{element:${JSON.stringify(area.id)},value:'ALL'}})`,
      );
      state = await refresh();
      area = row(state, "fixture-text-area");
      await run(`await win.replaceText(${JSON.stringify(area.id)},'A中🙂Z',{range:{location:0,length:3}})`);
      state = await refresh();
      area = row(state, "fixture-text-area");
      assert.equal(area.value, "A中🙂Z");
      const split = await session.run({
        code: `await win.selectText(${JSON.stringify(area.id)},{location:3,length:1})`,
        sessionId: "native-ui",
        timeoutMs: 10000,
      });
      assert.equal(split.error?.code, "INVALID_ARGUMENT");
      // Make the insertion point deterministic, then require a shortcut effect before subsequent typing.
      await run(
        `await win.replaceText(${JSON.stringify(area.id)},'seed'); await win.selectText(${JSON.stringify(area.id)},{location:4,length:0})`,
      );
      const failed = await session.run({
        code: `await win.pressKey(['command','a'],{element:${JSON.stringify(area.id)},expect:{element:${JSON.stringify(area.id)},selectedRange:{location:0,length:4},timeout_ms:150}}); await win.typeText('LATE',{element:${JSON.stringify(area.id)}})`,
        sessionId: "native-ui",
        timeoutMs: 10000,
      });
      assert.equal(failed.error?.code, "EFFECT_MISMATCH");
      assert.equal(failed.operations.filter((op: any) => op.method === "typeText").length, 0);
      assert.equal(row(await refresh(), "fixture-text-area").value, "seed");
      await assertUnchanged();
      const screenshot = await run("await win.screenshot()");
      assert.ok(screenshot.content.some((c) => c.type === "image" && c.mimeType === "image/png"));
      state = await refresh();
      area = row(state, "fixture-text-area");
      const canvas = row(state, "fixture-canvas"),
        from = local(state, canvas, 20, 20),
        to = { x: from.x + 100, y: from.y + 35 };
      await run(
        `await win.withKeys(['shift'],async()=>{await win.drag({from:${JSON.stringify(from)},to:${JSON.stringify(to)}})},{element:${JSON.stringify(area.id)}}); await computer.wait(100)`,
      );
      state = await refresh();
      assert.equal(row(state, "fixture-input").value, "drag: true shift: true");
      await run(
        `await win.click({point:${JSON.stringify(from)},count:2}); await win.click({point:${JSON.stringify(from)},button:'right'}); await win.moveMouse(${JSON.stringify(to)});`,
      );
      state = await refresh();
      const scroll = row(state, "fixture-scroll"),
        scrollAt = local(state, scroll, 30, 30);
      await run(`await win.scroll({point:${JSON.stringify(scrollAt)},y:180}); await computer.wait(200)`);
      state = await refresh();
      assert.notEqual(row(state, "fixture-scroll-state").value, "scroll: 0");
      await assertUnchanged();
      // The user's app is active: raw directed input must refuse even an inactive sibling; AX writes may address that sibling.
      await run(
        `var userApp=await computer.getApp(${JSON.stringify(ids.front)}); var uw=await userApp.listWindows(); var userMain=await userApp.getWindow(uw.find(w=>w.title==='Agent Enhance Computer Fixture').id); var userSibling=await userApp.getWindow(uw.find(w=>w.title==='Agent Enhance Computer Sibling').id); var us=await userSibling.observe(); var ue=us.elements.find(e=>e.identifier==='fixture-sibling-text'); await userSibling.replaceText(ue.id,'AX sibling');`,
      );
      const refusal = await session.run({
        code: "await userSibling.typeText('FORBIDDEN',{element:ue.id})",
        sessionId: "native-ui",
        timeoutMs: 10000,
      });
      assert.equal(refusal.error?.code, "ISOLATION_REQUIRED");
      const fore = await session.run({
        code: "await userMain.activate()",
        sessionId: "native-ui",
        timeoutMs: 10000,
      });
      assert.equal(fore.error?.code, "ISOLATION_REQUIRED");
      await assertUnchanged();
      // Independent WKWebView DOM state is exposed by a fixture label, not inferred from RPC acceptance.
      await run(
        "var webWin=await app.getWindow(windows.find(w=>w.title==='Agent Enhance Computer Web').id); var ws=await webWin.observe();",
      );
      let ws;
      for (let i = 0; i < 15; i++) {
        ws = await inspect("ws");
        if (ws.elements.some((e: any) => e.role === "AXTextArea")) break;
        await run("await computer.wait(100); ws=await webWin.observe()");
      }
      const webText = ws.elements.find((e: any) => e.role === "AXTextArea");
      assert.ok(webText, "WK textarea AX tree");
      await run(
        `await webWin.replaceText(${JSON.stringify(webText.id)},'A中🙂Z'); await webWin.selectText(${JSON.stringify(webText.id)},{location:1,length:3}); await webWin.typeText('X',{element:${JSON.stringify(webText.id)},expect:{element:${JSON.stringify(webText.id)},value:'AXZ'}}); await computer.wait(200); ws=await webWin.observe();`,
      );
      ws = await inspect("ws");
      let dom = JSON.parse(row(ws, "fixture-web-state").value);
      assert.equal(dom.text, "AXZ");
      const webView = ws.elements.find((e: any) => e.role === "AXWebArea");
      assert.ok(webView);
      const at = local(ws, webView, 250, 120),
        end = { x: at.x + 100, y: at.y + 20 };
      const textID = ws.elements.find((e: any) => e.role === "AXTextArea").id;
      await run(
        `await webWin.withKeys(['shift'],async()=>{await webWin.drag({from:${JSON.stringify(at)},to:${JSON.stringify(end)}})},{element:${JSON.stringify(textID)}}); await webWin.click({point:${JSON.stringify(at)},count:2}); await webWin.click({point:${JSON.stringify(at)},button:'right'}); await webWin.scroll({point:${JSON.stringify(local(ws, webView, 70, 200))},y:-160}); await computer.wait(250); ws=await webWin.observe();`,
      );
      dom = JSON.parse(row(await inspect("ws"), "fixture-web-state").value);
      console.log(
        "WKWebView modifier drag effect:",
        dom.events.some((e: any) => e.type === "pointermove" && e.target === "c" && e.shift),
      );
      assert.ok(dom.events.some((e: any) => e.type === "dblclick" && e.target === "c"));
      assert.ok(dom.events.some((e: any) => e.type === "contextmenu" && e.target === "c"));
      assert.ok(
        dom.events.every((e: any) => e.command === false),
        "no silently added Command",
      );
      assert.ok(dom.scrollY > 0);
      await assertUnchanged();
      // A simultaneous shared session supplies automated user input; its modifiers must not leak into isolated text.
      await run(
        "userSnapshot=await frontWin.observe(); var ff=userSnapshot.elements.find(e=>e.identifier==='fixture-text-area'); await frontWin.setValue(ff.id,''); await frontWin.click({element:ff.id},{mode:'foreground'});",
        shared,
      );
      userState = await desktopState();
      const user = run(
        "await frontWin.withKeys(['shift'],async()=>{for(var i=0;i<10;i++){await frontWin.pressKey(['b']);await computer.wait(60);}},{mode:'foreground',element:ff.id});",
        shared,
      );
      user.catch(() => {});
      await sleep(80);
      state = await refresh();
      area = row(state, "fixture-text-area");
      await run(
        `await win.replaceText(${JSON.stringify(area.id)},''); for(var j=0;j<5;j++){await win.typeText('b',{element:${JSON.stringify(area.id)}}); await computer.wait(30);} await computer.wait(100);`,
      );
      await user;
      assert.equal(row(await refresh(), "fixture-text-area").value, "bbbbb");
      await run("userSnapshot=await frontWin.observe()", shared);
      assert.equal(
        (await inspect("userSnapshot", shared)).elements.find(
          (e: any) => e.identifier === "fixture-text-area",
        ).value,
        "BBBBBBBBBB",
      );
      await assertUnchanged();
      // Cancel an in-flight five-second native drag; original-route release must finish before the 1.5-second shutdown fallback.
      state = await refresh();
      area = row(state, "fixture-text-area");
      const pending = session.run({
        code: `await win.withKeys(['shift'],async()=>{await win.drag({from:${JSON.stringify(from)},to:${JSON.stringify(to)},duration_ms:5000});print('LATE')},{element:${JSON.stringify(area.id)}})`,
        sessionId: "native-ui",
        timeoutMs: 10000,
      });
      await sleep(220);
      const started = Date.now();
      await session.reset("live-native-drag-cancel");
      const cancelled = await pending;
      assert.ok(cancelled.error);
      assert.ok(Date.now() - started < 1500);
      const cleanup = session.status().lastCleanup!;
      assert.equal(cleanup.nativeStopped, true);
      assert.equal(cleanup.workspaceRemoved, true);
      assert.equal(cleanup.error, undefined);
      assert.equal(cleanup.releasedKeys, 1);
      assert.deepEqual(cleanup.releaseErrors, []);
      assert.ok(!cancelled.content.some((c) => c.type === "text" && c.text === "LATE"));
      assert.equal(session.status().connected, false);
      await assertUnchanged();
      await session.endTurn();
      await shared.endTurn();
    } catch (error) {
      console.error("Native UI failure:", error);
      if (native) {
        await native.request("beginCall", { callId: "debug" });
        console.log(
          "Fixture processes:",
          (await native.request("getState", { callId: "debug" })).apps.filter((a: any) =>
            fixturePids.includes(a.pid),
          ),
        );
        await native.request("endCall");
      }
      throw error;
    } finally {
      await session.reset();
      await shared.reset();
      await native?.close();
      for (const pid of fixturePids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already stopped */
        }
      }
      await sleep(100);
      for (const app of fixturePaths) await exec(LSREGISTER, ["-u", app]).catch(() => {});
      if (original) {
        const restored = JSON.parse((await exec(helper, ["restore", join(root, "original.json")])).stdout);
        if (restored.pid !== original.pid) console.log("Desktop restoration:", { original, restored });
        assert.equal(restored.x, original.x);
        assert.equal(restored.y, original.y);
        assert.equal(restored.clipboard, original.clipboard);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
