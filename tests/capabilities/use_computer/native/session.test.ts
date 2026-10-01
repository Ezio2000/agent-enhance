import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ComputerIsolation } from "../../../../packages/capabilities/use_computer/native/src/isolation.ts";
import { ComputerSession } from "../../../../packages/capabilities/use_computer/native/src/session.ts";
import { ComputerOutput } from "../../../../packages/capabilities/use_computer/native/src/output.ts";
import type {
  NativeRuntime,
  Json,
} from "../../../../packages/capabilities/use_computer/native/src/runtime.ts";
function harness(
  failRelease = false,
  isolation: ComputerIsolation = "shared",
  observation: Json = { elements: [{ id: "element-1", title: "Button" }] },
) {
  const requests: { method: string; params: Json }[] = [];
  let starts = 0,
    closes = 0;
  const held = new Set<string>();
  const factory = async (): Promise<NativeRuntime> => {
    starts++;
    return {
      alive: true,
      info: { generation: `generation-${starts}`, pid: 123, permissions: { accessibility: true } },
      async request(method, params = {}) {
        requests.push({ method, params });
        switch (method) {
          case "getState":
            return { apps: [{ id: "test.app", name: "Test", pid: 123 }] };
          case "getApp":
          case "launchApp":
          case "restartApp":
            return { id: "test.app", name: "Test", pid: 123 };
          case "listWindows":
            return [{ id: "window-1", title: "Test" }];
          case "observe":
            return observation;
          case "restoreUserFocus":
            return { restored: true, delivery: "focus-recovery" };
          case "keyDown":
            held.add(params.key);
            break;
          case "keyUp":
            if (failRelease)
              throw Object.assign(new Error("Foreground focus changed before key release"), {
                code: "FOCUS_CHANGED",
              });
            held.delete(params.key);
            break;
          case "click":
            if (params.element === "denied")
              throw Object.assign(new Error("AX operation indeterminate"), {
                code: "AX_ERROR",
                indeterminate: true,
              });
            break;
          case "endCall": {
            const count = held.size;
            held.clear();
            return { releasedKeys: count };
          }
        }
        return { outcome: "accepted" };
      },
      async close() {
        closes++;
        held.clear();
        return { nativeStopped: true, workspaceRemoved: true };
      },
    };
  };
  return {
    session: new ComputerSession("/tmp/unused-computer-root", factory, isolation),
    requests,
    held,
    starts: () => starts,
    closes: () => closes,
  };
}
const run = (session: ComputerSession, code: string, timeoutMs = 3000, signal?: AbortSignal) =>
  session.run({ code, timeoutMs, sessionId: "test-session", signal });
const bind = "var app = await computer.getApp('test.app'); var win = await app.getWindow('window-1');";
test("print retains every argument, including observation diagnostics and large arrays", async () => {
  const h = harness();
  try {
    const result = await run(
      h.session,
      "print('count:',56,'truncated:',false); print('modes:',{AXEnhancedUserInterface:-25208}); print(); print('rows:',Array.from({length:150},(_,i)=>i));",
    );
    assert.equal(result.error, undefined);
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    assert.match(text, /count: 56 truncated: false/);
    assert.match(text, /modes: \{ AXEnhancedUserInterface: -25208 \}/);
    assert.match(text, /149/);
    assert.doesNotMatch(text, /more items/);
  } finally {
    await h.session.reset();
  }
});
test("incomplete embedded observations warn even when scripts print only the element array", async () => {
  const h = harness(false, "shared", { elements: [], webContent: { status: "pending", attempts: 6 } });
  try {
    const result = await run(
      h.session,
      bind + "var observation=await win.observe({depth:60}); print(observation.elements)",
    );
    assert.equal(result.error, undefined);
    assert.match(
      result.content.map((c) => c.text ?? "").join("\n"),
      /OBSERVATION_INCOMPLETE[\s\S]*partial tree/,
    );
    assert.equal(h.requests.filter((r) => r.method === "observe").length, 1);
    assert.equal(h.requests.filter((r) => r.method === "click").length, 0);
  } finally {
    await h.session.reset();
  }
});
test("explicit accessibility launch/restart forwards options once and returns fresh app handles", async () => {
  const h = harness(false, "isolated-only");
  try {
    const result = await run(
      h.session,
      "var launched=await computer.launchApp('test.app',{accessibility:true}); var restarted=await computer.restartApp('test.app',{accessibility:true}); print(launched.id,restarted.id)",
    );
    assert.equal(result.error, undefined);
    assert.equal(result.content.at(-1)?.text, "test.app test.app");
    assert.deepEqual(
      h.requests
        .filter((r) => ["launchApp", "restartApp"].includes(r.method))
        .map((r) => [r.method, r.params.app, r.params.accessibility]),
      [
        ["launchApp", "test.app", true],
        ["restartApp", "test.app", true],
      ],
    );
  } finally {
    await h.session.reset();
  }
});
test("explicit focus recovery is available in isolation without an arbitrary activation target or input replay", async () => {
  const h = harness(false, "isolated-only");
  try {
    const result = await run(h.session, "print(await computer.restoreUserFocus('other.app'))");
    assert.equal(result.error, undefined);
    assert.match(result.content.at(-1)?.text ?? "", /restored: true/);
    const requests = h.requests.filter((r) => !["beginCall", "endCall"].includes(r.method));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "restoreUserFocus");
    assert.deepEqual(Object.keys(requests[0]!.params), ["callId"]);
  } finally {
    await h.session.reset();
  }
});
test("keyboard aliases normalize before dispatch and duplicate modifier scopes hold nothing", async () => {
  const h = harness();
  try {
    const result = await run(
      h.session,
      bind +
        "await win.pressKey(['Command','Return']); await win.withKeys(['CMD'],async()=>{await win.pressKey(['A'])}); await win.keyDown('Ctrl'); await win.keyUp('Control'); await win.pressKey(['constructor']);",
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(
      h.requests.filter((r) => r.method === "pressKey").map((r) => r.params.keys),
      [["command", "return"], ["a"], ["constructor"]],
    );
    assert.deepEqual(
      h.requests.filter((r) => r.method === "keyDown").map((r) => r.params.key),
      ["command", "control"],
    );
    assert.deepEqual(
      h.requests.filter((r) => r.method === "keyUp").map((r) => r.params.key),
      ["command", "control"],
    );
    assert.equal(h.held.size, 0);
    const count = h.requests.filter((r) => r.method === "keyDown").length;
    const duplicate = await run(h.session, "await win.withKeys(['Command','cmd'],async()=>{})");
    assert.match(duplicate.error!.message, /unique keys/);
    assert.equal(h.requests.filter((r) => r.method === "keyDown").length, count);
  } finally {
    await h.session.reset();
  }
});
test("real Node REPL retains await bindings and resets only at task settlement", async () => {
  const h = harness();
  try {
    const first = await run(h.session, "var counter = await Promise.resolve(10); counter");
    assert.equal(first.error, undefined);
    assert.equal(first.freshRuntime, true);
    assert.match(first.content[0]!.text!, /native computer API/);
    const second = await run(h.session, "counter += 2; counter");
    assert.equal(second.content.at(-1)!.text, "12");
    assert.equal(second.freshRuntime, false);
    await h.session.endTurn(() => false);
    assert.equal(h.session.status().connected, true);
    await h.session.endTurn();
    assert.equal(h.session.status().connected, false);
    const third = await run(h.session, "typeof counter");
    assert.equal(third.content.at(-1)!.text, "undefined");
    assert.equal(h.starts(), 2);
  } finally {
    await h.session.reset();
  }
});
test("foreground combination uses one API path, inherits mode and releases modifiers", async () => {
  const h = harness();
  try {
    const result = await run(
      h.session,
      bind +
        " await win.withKeys(['shift'], async () => { await win.click({element:'element-1'}); }, {mode:'foreground'});",
    );
    assert.equal(result.error, undefined);
    const input = h.requests.filter((x) => ["keyDown", "click", "keyUp"].includes(x.method));
    assert.deepEqual(
      input.map((x) => x.method),
      ["keyDown", "click", "keyUp"],
    );
    assert.ok(input.every((x) => x.params.mode === "foreground"));
    assert.equal(h.held.size, 0);
  } finally {
    await h.session.reset();
  }
});
test("misplaced delivery mode fails before a click is dispatched instead of silently using background", async () => {
  const h = harness();
  try {
    const result = await run(h.session, bind + " await win.click({element:'element-1',mode:'foreground'});");
    assert.match(result.error!.message, /separate options argument/);
    assert.equal(h.requests.filter((x) => x.method === "click").length, 0);
    assert.equal(h.held.size, 0);
  } finally {
    await h.session.reset();
  }
});
test("error after an accepted step releases held input, reports uncertainty, never replays", async () => {
  const h = harness();
  try {
    const result = await run(
      h.session,
      bind +
        " await win.withKeys(['shift'], async () => { await win.click({element:'element-1'}); await win.click({element:'denied'}); }, {mode:'foreground'});",
    );
    assert.match(result.error!.message, /indeterminate/);
    assert.equal(h.requests.filter((x) => x.method === "click").length, 2);
    assert.equal(h.held.size, 0);
    assert.ok(result.operations.some((x) => x.error?.indeterminate));
    assert.equal((await run(h.session, "app.id")).content.at(-1)!.text, "test.app");
  } finally {
    await h.session.reset();
  }
});
test("release failure preserves the original action error and host cleanup releases the held key", async () => {
  const h = harness(true);
  try {
    const result = await run(
      h.session,
      bind +
        " await win.withKeys(['shift'],async()=>{await win.click({element:'denied'});},{mode:'foreground'});",
    );
    assert.match(result.error!.message, /AX operation indeterminate/);
    assert.match(result.error!.message, /Foreground focus changed before key release/);
    assert.equal(result.error!.code, "AX_ERROR");
    assert.equal(result.error!.indeterminate, true);
    assert.equal(result.cleanup!.releasedKeys, 1);
    assert.equal(h.held.size, 0);
    assert.equal(h.requests.filter((x) => x.method === "click").length, 1);
    assert.deepEqual(
      result.operations.filter((x) => x.error).map((x) => x.error.code),
      ["AX_ERROR", "FOCUS_CHANGED"],
    );
  } finally {
    await h.session.reset();
  }
});
test("raw key hold is released at normal call boundary and scopes cannot switch windows/modes", async () => {
  const h = harness();
  try {
    const result = await run(h.session, bind + " await win.keyDown('shift',{mode:'foreground'});");
    assert.equal(result.cleanup!.releasedKeys, 1);
    assert.equal(h.held.size, 0);
    const conflict = await run(
      h.session,
      "await win.withKeys(['shift'],async()=>win.click({element:'element-1'},{mode:'background'}),{mode:'foreground'});",
    );
    assert.match(conflict.error!.message, /cannot change/);
    assert.equal(h.held.size, 0);
  } finally {
    await h.session.reset();
  }
});
test("timeout kills a stuck JS worker and starts a fresh generation without replay", async () => {
  const h = harness();
  try {
    await run(h.session, bind);
    const timeout = await run(
      h.session,
      "await win.keyDown('shift',{mode:'foreground'}); print('before timeout'); while(true) {}",
      100,
    );
    assert.match(timeout.error!.message, /timed out/);
    assert.ok(timeout.content.some((c) => c.text === "before timeout"));
    assert.equal(h.held.size, 0);
    assert.equal(h.session.status().connected, false);
    assert.equal(h.requests.filter((x) => x.method === "keyDown").length, 1);
    const next = await run(h.session, "await computer.getState()");
    assert.equal(next.error, undefined);
    assert.equal(h.starts(), 2);
  } finally {
    await h.session.reset();
  }
});

test("cancellation retains the started generation in diagnostics while clearing live state", async () => {
  const h = harness();
  const controller = new AbortController();
  const outputRoot = await mkdtemp(join(tmpdir(), "ae-cancel-output-"));
  try {
    const pending = run(
      h.session,
      bind + "var cancelMarker=1; await win.keyDown('shift',{mode:'foreground'}); await computer.wait(1000);",
      3000,
      controller.signal,
    );
    const deadline = Date.now() + 2000;
    while (!h.requests.some((request) => request.method === "keyDown") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(h.requests.some((request) => request.method === "keyDown"));
    controller.abort();
    const cancelled = await pending;
    assert.match(cancelled.error!.message, /cancelled/);
    assert.equal(cancelled.freshRuntime, true);
    assert.equal(cancelled.generation, "generation-1");
    assert.equal(h.session.status().generation, undefined);
    assert.equal(h.held.size, 0);
    const formatted = await new ComputerOutput(outputRoot).format("cancel-generation", cancelled);
    const text = formatted.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(text, /Fresh native computer runtime \(generation-1\)/);
    assert.doesNotMatch(text, /startup failed/);
    const recovered = await run(h.session, "print(typeof cancelMarker)");
    assert.equal(recovered.generation, "generation-2");
    assert.ok(recovered.content.some((block) => block.text === "undefined"));
  } finally {
    controller.abort();
    await h.session.reset();
    await rm(outputRoot, { recursive: true, force: true });
  }
});
test("isolated-only rejects foreground options and direct entry paths before native dispatch", async () => {
  const h = harness(false, "isolated-only");
  try {
    for (const code of [
      "await win.activate()",
      "await win.click({point:{x:1,y:1}},{mode:'foreground'})",
      "await win.invoke('activate')",
      "await computer.launchApp('test.app',{foreground:true})",
      "await computer.restartApp('test.app',{foreground:true})",
    ]) {
      const result = await run(h.session, bind + code);
      assert.equal(result.error?.code, "ISOLATION_REQUIRED");
      assert.equal(result.error?.details.dispatched, false);
    }
    assert.equal(
      h.requests.filter((r) => ["activate", "click", "launchApp", "restartApp"].includes(r.method)).length,
      0,
    );
  } finally {
    await h.session.reset();
  }
});
test("background scopes inherit the element and release on exception; semantic APIs preserve ranges", async () => {
  const h = harness(false, "isolated-only");
  try {
    const result = await run(
      h.session,
      bind +
        "await win.withKeys(['shift'],async()=>{await win.typeText('B');throw new Error('scope failure');},{element:'element-1'});",
    );
    assert.match(result.error!.message, /scope failure/);
    assert.equal(h.held.size, 0);
    const scope = h.requests.filter((r) => ["keyDown", "typeText", "keyUp"].includes(r.method));
    assert.deepEqual(
      scope.map((r) => r.method),
      ["keyDown", "typeText", "keyUp"],
    );
    assert.ok(scope.every((r) => r.params.mode === "background" && r.params.element === "element-1"));
    assert.equal(
      (
        await run(
          h.session,
          "await win.selectAll('element-1');await win.selectText('element-1',{location:1,length:3});await win.replaceText('element-1','X',{range:{location:1,length:3}});",
        )
      ).error,
      undefined,
    );
    assert.deepEqual(h.requests.find((r) => r.method === "replaceText")?.params.range, {
      location: 1,
      length: 3,
    });
  } finally {
    await h.session.reset();
  }
});

test("a timed-out native call boundary cannot later evaluate code or disturb a fresh session", async () => {
  let starts = 0,
    resolveOld!: () => void;
  const session = new ComputerSession("/tmp/unused-computer-root", async () => {
    const old = ++starts === 1;
    return {
      alive: true,
      info: { generation: `generation-${starts}` },
      async request(method) {
        if (old && method === "beginCall")
          await new Promise<void>((resolve) => {
            resolveOld = resolve;
          });
        return method === "getState" ? { apps: [] } : {};
      },
      async close() {
        return { nativeStopped: true };
      },
    };
  });
  try {
    const first = await run(session, "print('old evaluation')", 200);
    assert.match(first.error!.message, /timed out/);
    const next = run(session, "await computer.wait(100); print('new evaluation')");
    await new Promise((resolve) => setTimeout(resolve, 50));
    resolveOld();
    const second = await next;
    assert.equal(second.error, undefined);
    assert.ok(second.content.some((c) => c.text === "new evaluation"));
    assert.ok(!second.content.some((c) => c.text === "old evaluation"));
  } finally {
    await session.reset();
  }
});
test("abort interrupts a call and reset prevents queued actions", async () => {
  const h = harness();
  try {
    await run(h.session, "await computer.getState()");
    const abort = new AbortController();
    const running = run(
      h.session,
      "await computer.wait(5000); await computer.getState()",
      5000,
      abort.signal,
    );
    setTimeout(() => abort.abort(), 50);
    assert.match((await running).error!.message, /cancelled/);
    const active = run(h.session, "await computer.wait(5000)", 5000);
    const queued = run(h.session, "await computer.getState()");
    const rejected = assert.rejects(queued, /reset/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.session.reset();
    await active;
    await rejected;
    assert.equal(h.session.status().connected, false);
  } finally {
    await h.session.reset();
  }
});
test("calls submitted during reset wait for cleanup and retain their new runtime", async () => {
  let starts = 0,
    stopped!: () => void;
  const session = new ComputerSession("/tmp/unused-computer-root", async () => {
    const number = ++starts;
    return {
      alive: true,
      info: { generation: `generation-${number}` },
      async request() {
        return {};
      },
      async close() {
        if (number === 1)
          await new Promise<void>((resolve) => {
            stopped = resolve;
          });
        return { nativeStopped: true };
      },
    };
  });
  try {
    assert.equal((await run(session, "var before=1;")).error, undefined);
    const reset = session.reset();
    const next = run(session, "var after=2; after");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(starts, 1, "new native startup must wait for reset cleanup");
    stopped();
    await reset;
    assert.equal((await next).error, undefined);
    assert.equal(session.status().connected, true);
    assert.equal((await run(session, "after")).content.at(-1)!.text, "2");
  } finally {
    await session.reset();
  }
});
test("late callbacks cannot dispatch actions after a call ends", async () => {
  const h = harness();
  try {
    await run(h.session, "setTimeout(() => { computer.getState().catch(()=>{}); },100); 'scheduled'");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(h.requests.filter((x) => x.method === "getState").length, 0);
  } finally {
    await h.session.reset();
  }
});
test("a detached error from an old call does not reject the next evaluation", async () => {
  const h = harness();
  try {
    await run(h.session, "setTimeout(()=>{throw new Error('old timer');},60); 'scheduled'");
    const next = await run(h.session, "await computer.wait(150); 'next call survived'");
    assert.equal(next.error, undefined);
    assert.equal(next.content.at(-1)!.text, "next call survived");
  } finally {
    await h.session.reset();
  }
});
test("Promise.all side effects execute in submission order", async () => {
  const h = harness();
  try {
    const result = await run(
      h.session,
      bind + "await Promise.all([win.click({element:'first'}),win.click({element:'second'})]);",
    );
    assert.equal(result.error, undefined);
    assert.deepEqual(
      h.requests.filter((x) => x.method === "click").map((x) => x.params.element),
      ["first", "second"],
    );
    assert.ok(h.requests.filter((x) => x.method === "click").every((x) => x.params.mode === "background"));
  } finally {
    await h.session.reset();
  }
});

test("complete operation traces retain late caught failures; expectations cannot apply to releases", async () => {
  const h = harness();
  try {
    const result = await run(
      h.session,
      bind +
        "for(var i=0;i<140;i++)await computer.getState();try{await win.click({element:'denied'});}catch(e){print(e.code)}",
    );
    assert.equal(result.error, undefined);
    assert.equal(result.operations.at(-1)?.error.code, "AX_ERROR");
    assert.equal(result.operations.filter((o) => o.method === "getState").length, 140);
    assert.ok(result.content.some((c) => c.text === "AX_ERROR"));
    const scope = await run(
      h.session,
      "await win.withKeys(['shift'],async()=>{}, {expect:{element:'element-1',value:'x'}})",
    );
    assert.equal(scope.error?.code, "INVALID_ARGUMENT");
    assert.equal(h.requests.filter((r) => r.method === "keyDown").length, 0);
  } finally {
    await h.session.reset();
  }
});

test("saved failure images can be emitted without replaying desktop operations", async () => {
  const h = harness();
  const root = await mkdtemp(join(tmpdir(), "ae-image-artifact-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const png = join(root, "saved.png");
    await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const result = await run(h.session, "await computer.showImage(" + JSON.stringify(png) + ")");
    assert.equal(result.error, undefined);
    assert.equal(result.content.filter((c) => c.type === "image").length, 1);
    assert.equal(result.operations.length, 0);
    assert.deepEqual(
      h.requests.map((r) => r.method),
      ["beginCall", "endCall"],
    );
    await writeFile(png, "invalid");
    const bad = await run(h.session, "await computer.showImage(" + JSON.stringify(png) + ")");
    assert.match(bad.error!.message, /PNG artifacts/);
  } finally {
    await h.session.reset();
    await rm(root, { recursive: true, force: true });
  }
});
