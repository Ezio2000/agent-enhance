import test from "node:test";
import assert from "node:assert/strict";
import { ComputerSession } from "../../../../packages/capabilities/use_computer/native/src/session.ts";
import type {
  NativeRuntime,
  Json,
} from "../../../../packages/capabilities/use_computer/native/src/runtime.ts";
function harness() {
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
            return { id: "test.app", name: "Test", pid: 123 };
          case "listWindows":
            return [{ id: "window-1", title: "Test" }];
          case "observe":
            return { elements: [{ id: "element-1", title: "Button" }] };
          case "keyDown":
            held.add(params.key);
            break;
          case "keyUp":
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
    session: new ComputerSession("/tmp/unused-computer-root", factory),
    requests,
    held,
    starts: () => starts,
    closes: () => closes,
  };
}
const run = (session: ComputerSession, code: string, timeoutMs = 3000, signal?: AbortSignal) =>
  session.run({ code, timeoutMs, sessionId: "test-session", signal });
const bind = "var app = await computer.getApp('test.app'); var win = await app.getWindow('window-1');";
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
