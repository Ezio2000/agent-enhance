var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/capabilities/use_computer/native/src/index.ts
import { join as join4 } from "node:path";

// packages/core/src/config.ts
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function enhanceHome() {
  return process.env.AGENT_ENHANCE_HOME ?? join(homedir(), ".agent-enhance");
}

// packages/capabilities/use_computer/native/src/manifest.ts
var manifest = {
  apiVersion: 1,
  id: "use_computer/native",
  capability: "use_computer",
  provider: "native",
  kind: "tool",
  version: "0.3.0",
  platforms: ["darwin"],
  requires: ["task-settled"]
};

// packages/capabilities/use_computer/native/src/session.ts
import { spawn as spawn2 } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/capabilities/use_computer/native/src/documentation.ts
var DOCUMENTATION = `# Agent Enhance native computer API
All methods are async. JS bindings persist until task settlement/reset; prefer var for reusable bindings.
print(value) emits text. The last expression is also displayed. screenshot() emits PNG automatically.

computer.help() returns this documentation.
computer.getState() -> {apps:[{id,name,pid,active,hidden}], permissions, generation}
computer.listApps() -> AppInfo[]
computer.getApp(bundleId) -> App (does not launch/focus)
computer.launchApp(bundleId, {foreground?:boolean}) -> App (default background)
computer.wait(ms) (0..30000, bounded by the call deadline)

App: {id,name,pid}; app.listWindows() -> [{id,title,bounds,minimized}]
app.getWindow(id) -> Window. Copy the exact opaque window ID from listWindows().

Window methods:
observe({depth?:number}) -> {snapshot,window,bounds,elements,truncated}
  elements: {id,parent?,role,title?,description?,identifier?,value?,enabled?,focused?,bounds?,actions,valueWritable}
screenshot() -> {window,bounds,width,height,scaleX,scaleY} plus PNG output
activate(); setBounds({x?,y?,width?,height?}); minimize(); restore()
performAction(elementId, actionName); setValue(elementId, string|number|boolean); menu(titlePath:string[], options?)
click({element?:id, point?:{x,y}, button?:"left"|"right"|"middle", count?:1|2|3}, options?)
pressKey(keys:string[], options?); typeText(text:string, options?)
moveMouse(point, options?); mouseDown(point, options?); mouseUp(point, options?)
drag({from:point,to:point,duration_ms?:number,button?:string}, options?)
scroll({point,x?:number,y?:number}, options?) (pixel deltas)
keyDown(key, options?); keyUp(key, options?)
withKeys(keys, asyncCallback, options?) -> callback result; releases acquired keys in finally

options: {mode?:"background"|"foreground", element?:id, button?:"left"|"right"|"middle"}
Default background. withKeys requires explicit foreground and gives its callback the same mode.
Modes never fall back automatically. Background click is one AXPress on an observed element.
Background keyboard requires options.element: an observed element whose AX focus and owning window can be confirmed.
Prefer setValue for writable controls. Keyboard delivery reports dispatched/effectConfirmed:false; verify by observing.
Raw keys, mouse input, drag, scroll and modifier-mouse combinations require explicit foreground.
Named keys: command, control, option, shift, return, tab, escape, space, delete, forwarddelete,
left/right/up/down, home/end/pageup/pagedown, f1..f12; layout characters work as keys. Use typeText for Unicode text.
Coordinates are window-relative logical points; multiply by screenshot scaleX/scaleY for image pixels.
Observe or screenshot before coordinate input. Geometry changes invalidate the coordinate observation.
A new observe invalidates that window's previous element IDs. Never guess IDs or replay failed actions.
Held input is released at every call boundary, including errors/cancellation; holds never span tool calls.
Side effects execute in submission order, even with Promise.all. Await all operations; detached work is rejected.
Only macOS system permissions apply. Missing permissions produce instructions; no host app-approval modes.
`;

// packages/capabilities/use_computer/native/src/worker-source.ts
var WORKER_SOURCE = String.raw`
(async () => {
  const { start } = await import('node:repl');
  const { PassThrough, Writable } = await import('node:stream');
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const { inspect } = await import('node:util');
  const calls = new AsyncLocalStorage();
  const scopes = new AsyncLocalStorage();
  let next = 0;
  const pending = new Map();
  const output = (value) => {
    const call = calls.getStore();
    if (!call?.active) throw new Error('The JS call has ended. Detached output/actions are not allowed.');
    const text = typeof value === 'string' ? value : inspect(value, {depth:12,maxArrayLength:2000,maxStringLength:32000,colors:false});
    if (call.textBytes < 1024 * 1024) {
      const bounded = Buffer.from(text).subarray(0, 1024 * 1024 - call.textBytes).toString('utf8').replace(/\uFFFD$/, '');
      call.textBytes += Buffer.byteLength(bounded);
      call.content.push({type:'text',text:bounded});
      process.send({type:'output',id:call.id,block:{type:'text',text:bounded}});
    }
  };
  const rpc = (method, params = {}) => {
    const call = calls.getStore();
    if (!call?.active) return Promise.reject(new Error('The JS call has ended. No action was executed.'));
    const id = ++next;
    const promise = new Promise((resolve,reject) => {
      pending.set(id,{resolve,reject});
      process.send({type:'native',id,callId:call.id,method,params});
    });
    call.pending.add(promise);
    promise.then(() => call.pending.delete(promise), () => call.pending.delete(promise));
    return promise;
  };
  let documentation = '';
  const options = (window, opts) => {
    const scope = scopes.getStore();
    if (scope && (scope.window !== window || (opts?.mode && opts.mode !== scope.mode))) {
      throw new Error('An input scope cannot change its target window or mode.');
    }
    return {...opts,mode:opts?.mode ?? scope?.mode ?? 'background'};
  };
  class Window {
    constructor(id) { this.id=id; }
    [inspect.custom]() { return {window:this.id}; }
    invoke(method, params={}, opts={}) { return rpc(method,{...params,...options(this.id,opts),window:this.id}); }
    observe(opts={}) { return this.invoke('observe',opts); }
    async screenshot() {
      const result = await this.invoke('screenshot');
      const call = calls.getStore();
      const bytes = Buffer.byteLength(result.image ?? '', 'base64');
      if (call.images < 4 && call.imageBytes + bytes <= 24*1024*1024) {
        call.images++; call.imageBytes+=bytes;
        call.content.push({type:'image',data:result.image,mimeType:result.mimeType});
        process.send({type:'output',id:call.id,block:{type:'image',data:result.image,mimeType:result.mimeType}});
      } else output('[Screenshot omitted: maximum 4 images / 24 MiB per call.]');
      const {image,...meta}=result; return meta;
    }
    activate() { return this.invoke('activate',{}, {mode:'foreground'}); }
    setBounds(rect) { return this.invoke('setBounds',rect); }
    minimize() { return this.invoke('minimize'); }
    restore() { return this.invoke('restore'); }
    performAction(element,action) { return this.invoke('performAction',{element,action}); }
    setValue(element,value) { return this.invoke('setValue',{element,value}); }
    menu(path,opts={}) { return this.invoke('menu',{path},opts); }
    click(target,opts={}) { return this.invoke('click',target,opts); }
    pressKey(keys,opts={}) { return this.invoke('pressKey',{keys},opts); }
    typeText(text,opts={}) { return this.invoke('typeText',{text},opts); }
    keyDown(key,opts={}) { return this.invoke('keyDown',{key},opts); }
    keyUp(key,opts={}) { return this.invoke('keyUp',{key},opts); }
    moveMouse(point,opts={}) { return this.invoke('moveMouse',{point},opts); }
    mouseDown(point,opts={}) { return this.invoke('mouseDown',{point},opts); }
    mouseUp(point,opts={}) { return this.invoke('mouseUp',{point},opts); }
    drag(path,opts={}) { return this.invoke('drag',path,opts); }
    scroll(delta,opts={}) { return this.invoke('scroll',delta,opts); }
    async withKeys(keys,callback,opts={}) {
      const selected = options(this.id,opts);
      if (selected.mode !== 'foreground') throw new Error('withKeys requires mode: foreground.');
      if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length || typeof callback !== 'function') {
        throw new Error('withKeys requires unique keys and an async callback.');
      }
      return scopes.run({window:this.id,mode:selected.mode},async()=>{
        const acquired=[];
        let failure;
        try {
          for (const key of keys) { await this.keyDown(key,selected); acquired.push(key); }
          return await callback();
        } catch(error) {
          failure=error;
          throw error;
        } finally {
          // Attempt all releases even if one fails; the host also ends the native call.
          const errors=[];
          for (const key of acquired.reverse()) { try { await this.keyUp(key,selected); } catch(error) { errors.push(error); } }
          if(errors.length) {
            const all=failure ? [failure,...errors] : errors;
            const error=new AggregateError(all,'Input scope release failed; host cleanup follows. '+all.map(error=>error.message ?? String(error)).join('; '),{cause:failure});
            error.code=failure?.code ?? errors[0]?.code;
            error.indeterminate=all.some(error=>error.indeterminate===true);
            throw error;
          }
        }
      });
    }
  }
  class App {
    constructor(info) { Object.assign(this,info); }
    [inspect.custom]() { return {id:this.id,name:this.name,pid:this.pid}; }
    listWindows() { return rpc('listWindows',{app:this.id}); }
    async getWindow(id) {
      if (!(await this.listWindows()).some(window=>window.id===id)) throw new Error('Window ID does not belong to this app. List windows again.');
      return new Window(id);
    }
  }
  const computer={
    help:()=>documentation,
    getState:()=>rpc('getState'),
    listApps:async()=>(await rpc('getState')).apps,
    getApp:async(app)=>new App(await rpc('getApp',{app})),
    launchApp:async(app,opts={})=>new App(await rpc('launchApp',{app,...opts})),
    wait:async(ms)=>{
      const call=calls.getStore();
      if (!call?.active || !Number.isFinite(ms) || ms<0 || ms>30000) throw new Error('wait requires 0..30000 ms within an active call.');
      await new Promise(resolve=>setTimeout(resolve,ms));
      if(!call.active) throw new Error('Call ended while waiting.');
    }
  };
  const input=new PassThrough();
  const shell=start({input,output:new Writable({write(chunk,encoding,done){done();}}),terminal:false,prompt:'',useGlobal:false});
  const log=(...args)=>output(args.map(value=>typeof value==='string'?value:inspect(value,{depth:12,colors:false})).join(' '));
  Object.assign(shell.context,{computer,print:output,console:{log,info:log,warn:log,error:log}});
  // The default REPL evaluator routes thrown/await errors through its domain instead
  // of its callback. Observe that channel as well; otherwise an error hangs the call.
  let evaluationError;
  shell._domain.on('error',error=>{
    // An old timer retains its originating call's async context. It must not reject
    // an unrelated evaluation that happens to be active when that timer fires.
    if(calls.getStore()?.active) evaluationError?.(error);
  });
  const evaluate=code=>new Promise((resolve,reject)=>{
    const finish=(error,value)=>{evaluationError=undefined; error?reject(error):resolve(value);};
    evaluationError=error=>finish(error);
    shell.eval(code+'\n',shell.context,'use_computer',finish);
  });
  let executing=false;
  process.on('message',async message=>{
    if(message.type==='nativeResult') {
      const item=pending.get(message.id); if(!item) return;
      pending.delete(message.id);
      if(message.error) { const error=new Error(message.error.message); Object.assign(error,message.error); item.reject(error); }
      else item.resolve(message.result);
      return;
    }
    if(message.type!=='execute') return;
    if(executing) { process.send({type:'result',id:message.id,error:{message:'JS worker is busy.'},content:[]}); return; }
    executing=true;
    documentation=message.documentation;
    const call={id:message.id,active:true,pending:new Set(),content:[],textBytes:0,images:0,imageBytes:0};
    await calls.run(call,async()=>{
      let failure;
      try {
        if(message.fresh) output(documentation);
        const result=await evaluate(message.code);
        // Drain submitted RPCs even if code forgot await; native outcomes are not abandoned.
        const settled=await Promise.allSettled([...call.pending]);
        const rejected=settled.find(result=>result.status==='rejected');
        if(rejected) throw rejected.reason;
        if(result!==undefined) output(result);
      } catch(error) {
        failure={message:error?.stack ?? String(error),code:error?.code,indeterminate:error?.indeterminate};
        await Promise.allSettled([...call.pending]);
      } finally { call.active=false; executing=false; }
      process.send({type:'result',id:message.id,content:call.content,error:failure});
    });
  });
  process.on('disconnect',()=>process.exit(0));
  process.send({type:'ready'});
})().catch(error=>{process.stderr.write(String(error.stack ?? error));process.exit(1);});
`;

// packages/capabilities/use_computer/native/src/runtime.ts
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, access } from "node:fs/promises";
import { connect } from "node:net";
import { join as join2, dirname as dirname2 } from "node:path";
import { release } from "node:os";
import { gunzipSync } from "node:zlib";

// packages/capabilities/use_computer/native/src/payload.ts
async function nativePayload() {
  return Buffer.from("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", "base64");
}

// packages/capabilities/use_computer/native/src/runtime.ts
var NativeError = class extends Error {
  code;
  indeterminate;
  constructor(error) {
    super(String(error.message));
    this.code = error.code;
    this.indeterminate = error.indeterminate === true;
  }
};
var NativeConnection = class {
  constructor(socket, dispose = async () => ({})) {
    this.socket = socket;
    this.dispose = dispose;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 64 * 1024 * 1024) return this.fail(new Error("Native output exceeds 64 MiB."));
      for (; ; ) {
        const newline = this.buffer.indexOf(10);
        if (newline < 0) break;
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        try {
          const reply = JSON.parse(line.toString());
          const item = this.pending.get(reply.id);
          if (!item) continue;
          this.pending.delete(reply.id);
          if (reply.error) item.reject(new NativeError(reply.error));
          else item.resolve(reply.result);
        } catch {
          this.fail(new Error("Invalid native runtime response."));
          break;
        }
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on(
      "close",
      () => this.fail(new Error("Native runtime disconnected. Observe before further actions."))
    );
  }
  info = {};
  next = 0;
  pending = /* @__PURE__ */ new Map();
  buffer = Buffer.alloc(0);
  closed = false;
  closing;
  get alive() {
    return !this.closed;
  }
  fail(error) {
    this.closed = true;
    this.socket.destroy();
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("Native runtime is closed."));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }
  close() {
    return this.closing ??= (async () => {
      let cleanup = {};
      if (!this.closed) {
        try {
          cleanup = await Promise.race([
            this.request("shutdown"),
            new Promise((_, reject) => {
              const timer = setTimeout(() => reject(new Error("Native shutdown timed out.")), 1500);
              timer.unref();
            })
          ]);
        } catch (error) {
          cleanup.error = String(error);
        }
      }
      this.fail(new Error("Native runtime closed."));
      return { ...cleanup, ...await this.dispose() };
    })();
  }
};
var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function materialize(root) {
  const payload = await nativePayload();
  const hash = createHash("sha256").update(payload).digest("hex");
  const destination = join2(root, "native-computer", hash);
  const app = join2(destination, "Agent Enhance Computer.app");
  try {
    await access(join2(app, "Contents", "MacOS", "ComputerRuntime"));
    return app;
  } catch {
  }
  await mkdir(dirname2(destination), { recursive: true });
  const stage = await mkdtemp(join2(dirname2(destination), ".unpack-"));
  try {
    const archive = JSON.parse(gunzipSync(payload).toString());
    for (const file of archive.files) {
      const target = join2(stage, file.path);
      await mkdir(dirname2(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data, "base64"), { mode: file.mode });
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
    }
    return app;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
async function startNative(root, signal) {
  if (process.platform !== "darwin" || Number(release().split(".")[0]) < 23)
    throw new Error("use_computer/native requires macOS 14 or newer.");
  signal?.throwIfAborted();
  const app = await materialize(root);
  signal?.throwIfAborted();
  const workspace = await mkdtemp("/tmp/ae-computer-");
  const path = join2(workspace, "rpc.sock"), ready = join2(workspace, "pid");
  await mkdir(join2(root, "native-computer"), { recursive: true });
  const launcher = spawn(
    "/usr/bin/open",
    [
      "-W",
      "-n",
      "-g",
      app,
      "--args",
      "--socket",
      path,
      "--input-lock",
      `/tmp/agent-enhance-computer-input-${process.getuid()}.lock`,
      "--ready-file",
      ready,
      "--parent-pid",
      String(process.pid)
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "", launchError, pid;
  launcher.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  launcher.on("error", (error) => {
    launchError = error;
  });
  const dispose = async () => {
    if (!pid) {
      try {
        pid = Number(await readFile(ready, "utf8"));
      } catch {
      }
    }
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
      const deadline = Date.now() + 2500;
      while (alive(pid) && Date.now() < deadline) await delay(25);
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
      const killedDeadline = Date.now() + 500;
      while (alive(pid) && Date.now() < killedDeadline) await delay(25);
    }
    launcher.kill("SIGTERM");
    await rm(workspace, { recursive: true, force: true });
    return { nativeStopped: !alive(pid), workspaceRemoved: true };
  };
  try {
    const deadline = Date.now() + 1e4;
    let socket;
    while (!socket) {
      signal?.throwIfAborted();
      if (launchError) throw launchError;
      if (launcher.exitCode !== null) throw new Error(`Native application exited during startup: ${stderr}`);
      if (Date.now() >= deadline)
        throw new Error(`Native runtime did not connect within 10 seconds. ${stderr}`);
      socket = await new Promise((resolve) => {
        const candidate = connect(path);
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", () => {
          candidate.destroy();
          resolve(void 0);
        });
      });
      if (!socket) await delay(50);
    }
    const connection = new NativeConnection(socket, dispose);
    const aborted = () => {
      void connection.close();
    };
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      connection.info = await Promise.race([
        connection.request("hello"),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Native handshake timed out.")), 3e3);
          timer.unref();
        })
      ]);
      pid = connection.info.pid;
      if (connection.info.protocol !== 1 || !Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("Unsupported native runtime handshake.");
      signal?.throwIfAborted();
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", aborted);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
}

// packages/capabilities/use_computer/native/src/session.ts
var READ_ONLY = /* @__PURE__ */ new Set(["getState", "getApp", "listWindows", "observe", "screenshot"]);
var errorJSON = (error) => ({
  message: error?.message ?? String(error),
  code: error?.code,
  indeterminate: error?.indeterminate
});
var ComputerSession = class {
  constructor(root, factory = startNative) {
    this.root = root;
    this.factory = factory;
  }
  native;
  worker;
  queue = Promise.resolve();
  actionQueue = Promise.resolve();
  releases = Promise.resolve();
  epoch = 0;
  generation;
  sessionId;
  active;
  stopCall;
  startup;
  lastCleanup;
  used = false;
  status() {
    return {
      connected: this.native?.alive === true && this.worker?.connected === true,
      generation: this.generation,
      jsState: this.worker ? "available" : "not_initialized",
      permissions: this.native?.info.permissions ?? "not_checked",
      nativePid: this.native?.info.pid,
      workerPid: this.worker?.pid,
      defaultMode: "background",
      lastCleanup: this.lastCleanup
    };
  }
  recoveryNotice() {
    return this.used && (!this.native?.alive || !this.worker?.connected) ? "Computer runtime was reset/disconnected. Previous JS bindings and element/window IDs are invalid. Observe fresh state; never replay failed actions automatically." : void 0;
  }
  serial(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {
    });
    return job;
  }
  async initialize(signal) {
    const native = await this.factory(this.root, signal);
    if (signal?.aborted) {
      await native.close();
      signal.throwIfAborted();
    }
    this.native = native;
    this.generation = native.info.generation ?? randomUUID2();
    const child = spawn2(process.execPath, ["--input-type=module", "--eval", WORKER_SOURCE], {
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    this.worker = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    await new Promise((resolve, reject) => {
      const readyTimeout = setTimeout(() => reject(new Error("JS worker startup timed out.")), 5e3);
      const abort = () => reject(new Error("Computer startup cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => {
        clearTimeout(readyTimeout);
        signal?.removeEventListener("abort", abort);
      };
      child.on("error", (error) => {
        finish();
        reject(error);
        if (child === this.worker) this.active?.reject(error);
      });
      child.on("exit", (code, exitSignal) => {
        finish();
        const error = new Error(`Computer JS worker exited (${exitSignal ?? code}). ${stderr}`);
        reject(error);
        if (child === this.worker) this.active?.reject(error);
      });
      child.on("message", (message) => {
        if (child !== this.worker) return;
        if (message.type === "ready") {
          finish();
          resolve();
        } else if (message.type === "output" && this.active?.id === message.id)
          this.active?.content.push(message.block);
        else if (message.type === "result" && this.active?.id === message.id) this.active?.resolve(message);
        else if (message.type === "native") {
          const submitted = this.active;
          const op = async () => {
            if (!submitted || submitted !== this.active || submitted.id !== message.callId || native !== this.native)
              throw new Error("The owning call ended. Queued action was not executed.");
            try {
              const result = await native.request(message.method, {
                ...message.params,
                callId: submitted.id
              });
              if (message.method === "getState" && result?.permissions)
                native.info.permissions = result.permissions;
              if (submitted.operations.length < 128)
                submitted.operations.push({
                  method: message.method,
                  effectful: !READ_ONLY.has(message.method),
                  outcome: result?.outcome ?? "observed"
                });
              if (child.connected) child.send({ type: "nativeResult", id: message.id, result });
            } catch (error) {
              const detail = errorJSON(error);
              if (submitted.operations.length < 128)
                submitted.operations.push({
                  method: message.method,
                  effectful: !READ_ONLY.has(message.method),
                  error: detail
                });
              if (child.connected) child.send({ type: "nativeResult", id: message.id, error: detail });
            }
          };
          const job = this.actionQueue.then(op);
          this.actionQueue = job.catch(() => {
          });
        }
      });
    });
  }
  run(call) {
    const submittedEpoch = this.epoch;
    return this.serial(async () => {
      if (submittedEpoch !== this.epoch)
        throw new Error("Computer session was reset; queued call was not executed.");
      call.signal?.throwIfAborted();
      if (this.sessionId && this.sessionId !== call.sessionId) await this.release("session_change");
      if (this.native && (!this.native.alive || !this.worker?.connected))
        await this.release("transport_failure");
      this.sessionId = call.sessionId;
      this.used = true;
      const controller = new AbortController();
      this.startup = controller;
      const signal = call.signal ? AbortSignal.any([controller.signal, call.signal]) : controller.signal;
      const fresh = !this.native;
      const operations = [];
      let cleanup;
      let deadline;
      let aborted;
      const expired = new Promise((_, reject) => {
        const stop = (message) => {
          controller.abort();
          reject(new Error(message));
        };
        deadline = setTimeout(
          () => stop(
            `Computer Use timed out after ${call.timeoutMs} ms. Completed actions are not undone; observe before continuing.`
          ),
          call.timeoutMs
        );
        aborted = () => stop("Computer Use cancelled. Completed actions are not undone.");
        call.signal?.addEventListener("abort", aborted, { once: true });
        this.stopCall = () => stop("Computer session reset. Queued actions were not executed.");
      });
      let content = [];
      try {
        const execution = async () => {
          if (!this.native) await this.initialize(signal);
          const native = this.native, worker = this.worker;
          const check = () => {
            signal.throwIfAborted();
            if (submittedEpoch !== this.epoch || native !== this.native || worker !== this.worker)
              throw new Error("Computer session changed. No further action was executed.");
          };
          check();
          const id = randomUUID2();
          await native.request("beginCall", { callId: id });
          check();
          const response2 = await new Promise((resolve, reject) => {
            this.active = { id, operations, content, resolve, reject };
            worker.send({ type: "execute", id, code: call.code, documentation: DOCUMENTATION, fresh });
          });
          check();
          this.active = void 0;
          await this.actionQueue;
          check();
          cleanup = await native.request("endCall");
          check();
          return response2;
        };
        const response = await Promise.race([execution(), expired]);
        content = response.content ?? [];
        if (response.error)
          return {
            content,
            error: response.error,
            generation: this.generation,
            freshRuntime: fresh,
            operations,
            cleanup
          };
        return { content, generation: this.generation, freshRuntime: fresh, operations, cleanup };
      } catch (error) {
        controller.abort();
        this.active = void 0;
        await this.release("call_failure");
        return {
          content,
          error: errorJSON(error),
          freshRuntime: fresh,
          operations,
          cleanup: this.lastCleanup
        };
      } finally {
        clearTimeout(deadline);
        if (aborted) call.signal?.removeEventListener("abort", aborted);
        this.stopCall = void 0;
        this.startup = void 0;
      }
    });
  }
  release(reason) {
    const worker = this.worker, native = this.native;
    this.worker = void 0;
    this.native = void 0;
    this.generation = void 0;
    this.active = void 0;
    this.actionQueue = Promise.resolve();
    if (!worker && !native) return this.releases;
    const cleanup = async () => {
      if (worker?.connected) worker.disconnect();
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            worker.kill("SIGKILL");
          }, 500);
          worker.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const detail = await native?.close();
      this.lastCleanup = {
        reason,
        ...detail,
        workerStopped: !worker || worker.exitCode !== null || worker.signalCode !== null
      };
    };
    const job = this.releases.then(cleanup, cleanup);
    this.releases = job.catch(() => {
    });
    return job;
  }
  endTurn(isIdle = () => true) {
    return this.serial(async () => {
      if (isIdle()) {
        await this.release("task_settled");
        this.used = false;
      }
    });
  }
  async reset(reason = "reset") {
    this.epoch++;
    this.startup?.abort();
    this.stopCall?.();
    const previous = this.queue;
    const shutdown = this.release(reason);
    const barrier = Promise.all([previous, shutdown]).then(() => this.release(reason));
    this.queue = barrier.catch(() => {
    });
    await barrier;
  }
};

// packages/capabilities/use_computer/native/src/output.ts
import { mkdir as mkdir2, mkdtemp as mkdtemp2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join3 } from "node:path";
var ComputerOutput = class {
  constructor(root) {
    this.root = root;
  }
  async format(sessionId, result) {
    let directory;
    const dir = async () => {
      if (!directory) {
        const parent = join3(
          this.root,
          sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "ephemeral"
        );
        await mkdir2(parent, { recursive: true });
        directory = await mkdtemp2(join3(parent, "call-"));
      }
      return directory;
    };
    const content = [], images = [], texts = [];
    let totalBytes = 0;
    for (const block of result.content) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      if (block.type !== "image" || typeof block.data !== "string") continue;
      const bytes = Buffer.from(block.data, "base64");
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        texts.push("[Invalid native PNG screenshot omitted.]");
        continue;
      }
      if (images.length >= 4 || totalBytes + bytes.length > 24 * 1024 * 1024) {
        texts.push("[Screenshot omitted: maximum 4 images / 24 MiB per call.]");
        continue;
      }
      totalBytes += bytes.length;
      const path = join3(await dir(), `screenshot-${images.length + 1}.png`);
      await writeFile2(path, bytes);
      images.push(path);
      content.push({ type: "image", data: block.data, mimeType: "image/png" });
    }
    const raw = texts.join("\n\n");
    const lines = raw.split("\n");
    let bounded = lines.slice(0, 2e3).join("\n");
    if (Buffer.byteLength(bounded) > 48 * 1024) {
      bounded = Buffer.from(bounded).subarray(0, 48 * 1024).toString("utf8").replace(/\uFFFD$/, "");
    }
    let fullOutputPath;
    if (bounded !== raw) {
      fullOutputPath = join3(await dir(), "output.txt");
      await writeFile2(fullOutputPath, raw);
    }
    const text = [
      result.freshRuntime ? `Fresh native computer runtime (${result.generation ?? "startup failed"}).` : "",
      bounded,
      result.error ? `${result.error.message}
Actions may have partially completed. Observe before continuing; no action was replayed.
Operations: ${JSON.stringify(result.operations)}` : result.operations.some((operation) => operation.error) ? `Native operation failures handled by the script: ${JSON.stringify(result.operations.filter((operation) => operation.error))}. Observe to verify the final state.` : "",
      fullOutputPath ? `[Truncated to 2000 lines / 48 KiB. Full output: ${fullOutputPath}]` : "",
      images.length ? `Screenshots: ${images.join(", ")}` : ""
    ].filter(Boolean).join("\n\n");
    content.unshift({
      type: "text",
      text: text || "Computer script completed with no output. Observe to verify effects."
    });
    return {
      content,
      details: {
        status: result.error ? "error" : "completed",
        generation: result.generation,
        freshRuntime: result.freshRuntime,
        operations: result.operations,
        cleanup: result.cleanup,
        images,
        fullOutputPath
      }
    };
  }
};

// node_modules/typebox/build/system/memory/memory.mjs
var memory_exports = {};
__export(memory_exports, {
  Assign: () => Assign,
  Clone: () => Clone,
  Create: () => Create,
  Discard: () => Discard,
  Metrics: () => Metrics,
  Update: () => Update
});

// node_modules/typebox/build/system/memory/metrics.mjs
var Metrics = {
  assign: 0,
  create: 0,
  clone: 0,
  discard: 0,
  update: 0
};

// node_modules/typebox/build/system/memory/assign.mjs
function Assign(left, right) {
  Metrics.assign += 1;
  return { ...left, ...right };
}

// node_modules/typebox/build/guard/guard.mjs
var guard_exports = {};
__export(guard_exports, {
  Entries: () => Entries,
  EntriesRegExp: () => EntriesRegExp,
  Every: () => Every,
  EveryAll: () => EveryAll,
  GraphemeCount: () => GraphemeCount2,
  HasPropertyKey: () => HasPropertyKey,
  IsArray: () => IsArray,
  IsBigInt: () => IsBigInt,
  IsBoolean: () => IsBoolean,
  IsClassInstance: () => IsClassInstance,
  IsConstructor: () => IsConstructor,
  IsDeepEqual: () => IsDeepEqual,
  IsEqual: () => IsEqual,
  IsFunction: () => IsFunction,
  IsGreaterEqualThan: () => IsGreaterEqualThan,
  IsGreaterThan: () => IsGreaterThan,
  IsInteger: () => IsInteger,
  IsLessEqualThan: () => IsLessEqualThan,
  IsLessThan: () => IsLessThan,
  IsMaxLength: () => IsMaxLength2,
  IsMinLength: () => IsMinLength2,
  IsMultipleOf: () => IsMultipleOf,
  IsNull: () => IsNull,
  IsNumber: () => IsNumber,
  IsObject: () => IsObject,
  IsObjectNotArray: () => IsObjectNotArray,
  IsString: () => IsString,
  IsSymbol: () => IsSymbol,
  IsUndefined: () => IsUndefined,
  IsUnsafePropertyKey: () => IsUnsafePropertyKey,
  IsValueLike: () => IsValueLike,
  Keys: () => Keys,
  ShiftLeft: () => ShiftLeft,
  Symbols: () => Symbols,
  Values: () => Values
});

// node_modules/typebox/build/guard/string.mjs
function IsBetween(value, min, max) {
  return value >= min && value <= max;
}
function IsZeroWidthJoiner(value) {
  return value === 8205;
}
function IsHighSurrogate(value) {
  return IsBetween(value, 55296, 56319);
}
function IsRegionalIndicator(value) {
  return IsBetween(value, 127462, 127487);
}
function IsVariationSelector(value) {
  return IsBetween(value, 65024, 65039);
}
function IsCombiningMark(value) {
  return IsBetween(value, 768, 879) || IsBetween(value, 6832, 6911) || IsBetween(value, 7616, 7679) || IsBetween(value, 65056, 65071);
}
function CodePointLength(value) {
  return value > 65535 ? 2 : 1;
}
function ConsumeModifiers(value, index) {
  while (index < value.length) {
    const point = value.codePointAt(index);
    if (IsCombiningMark(point) || IsVariationSelector(point)) {
      index += CodePointLength(point);
    } else {
      break;
    }
  }
  return index;
}
function NextGraphemeClusterIndex(value, clusterStart) {
  const startCP = value.codePointAt(clusterStart);
  let clusterEnd = clusterStart + CodePointLength(startCP);
  clusterEnd = ConsumeModifiers(value, clusterEnd);
  while (clusterEnd < value.length - 1 && value[clusterEnd] === "\u200D") {
    const nextCP = value.codePointAt(clusterEnd + 1);
    clusterEnd += 1 + CodePointLength(nextCP);
    clusterEnd = ConsumeModifiers(value, clusterEnd);
  }
  if (IsRegionalIndicator(startCP) && clusterEnd < value.length && IsRegionalIndicator(value.codePointAt(clusterEnd))) {
    clusterEnd += CodePointLength(value.codePointAt(clusterEnd));
  }
  return clusterEnd;
}
function IsGraphemeCodePoint(value) {
  return IsHighSurrogate(value) || IsCombiningMark(value) || IsVariationSelector(value) || IsZeroWidthJoiner(value);
}
function GraphemeCount(value) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
  }
  return count;
}
function IsMinLength(value, minLength) {
  if (minLength === 0)
    return true;
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
    if (count >= minLength)
      return true;
  }
  return false;
}
function IsMaxLength(value, maxLength) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    index = NextGraphemeClusterIndex(value, index);
    count++;
    if (count > maxLength)
      return false;
  }
  return true;
}
function IsMinLengthFast(value, minLength) {
  if (minLength === 0)
    return true;
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMinLength(value, minLength);
    }
    index++;
    if (index >= minLength)
      return true;
  }
  return false;
}
function IsMaxLengthFast(value, maxLength) {
  let index = 0;
  while (index < value.length) {
    if (IsGraphemeCodePoint(value.charCodeAt(index))) {
      return IsMaxLength(value, maxLength);
    }
    index++;
    if (index > maxLength)
      return false;
  }
  return true;
}

// node_modules/typebox/build/guard/guard.mjs
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return IsEqual(typeof value, "bigint");
}
function IsBoolean(value) {
  return IsEqual(typeof value, "boolean");
}
function IsConstructor(value) {
  if (IsUndefined(value) || !IsFunction(value))
    return false;
  const result = Function.prototype.toString.call(value);
  if (/^class\s/.test(result))
    return true;
  if (/\[native code\]/.test(result))
    return true;
  return false;
}
function IsFunction(value) {
  return IsEqual(typeof value, "function");
}
function IsInteger(value) {
  return Number.isInteger(value);
}
function IsNull(value) {
  return IsEqual(value, null);
}
function IsNumber(value) {
  return Number.isFinite(value);
}
function IsObjectNotArray(value) {
  return IsObject(value) && !IsArray(value);
}
function IsObject(value) {
  return IsEqual(typeof value, "object") && !IsNull(value);
}
function IsString(value) {
  return IsEqual(typeof value, "string");
}
function IsSymbol(value) {
  return IsEqual(typeof value, "symbol");
}
function IsUndefined(value) {
  return IsEqual(value, void 0);
}
function IsEqual(left, right) {
  return left === right;
}
function IsGreaterThan(left, right) {
  return left > right;
}
function IsLessThan(left, right) {
  return left < right;
}
function IsLessEqualThan(left, right) {
  return left <= right;
}
function IsGreaterEqualThan(left, right) {
  return left >= right;
}
function IsMultipleOf(dividend, divisor) {
  if (IsBigInt(dividend) || IsBigInt(divisor)) {
    return BigInt(dividend) % BigInt(divisor) === 0n;
  }
  const tolerance = 1e-10;
  if (!IsNumber(dividend))
    return true;
  if (IsInteger(dividend) && 1 / divisor % 1 === 0)
    return true;
  const mod = dividend % divisor;
  return Math.min(Math.abs(mod), Math.abs(mod - divisor), Math.abs(mod + divisor)) < tolerance;
}
function IsClassInstance(value) {
  if (!IsObject(value))
    return false;
  const proto = globalThis.Object.getPrototypeOf(value);
  if (IsNull(proto))
    return false;
  return IsEqual(typeof proto.constructor, "function") && !(IsEqual(proto.constructor, globalThis.Object) || IsEqual(proto.constructor.name, "Object"));
}
function IsValueLike(value) {
  return IsBigInt(value) || IsBoolean(value) || IsNull(value) || IsNumber(value) || IsString(value) || IsUndefined(value);
}
function GraphemeCount2(value) {
  return GraphemeCount(value);
}
function IsMaxLength2(value, length) {
  return IsMaxLengthFast(value, length);
}
function IsMinLength2(value, length) {
  return IsMinLengthFast(value, length);
}
function Every(value, offset, callback) {
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      return false;
  }
  return true;
}
function EveryAll(value, offset, callback) {
  let result = true;
  for (let index = offset; index < value.length; index++) {
    if (!callback(value[index], index))
      result = false;
  }
  return result;
}
function ShiftLeft(array, true_, false_) {
  return IsEqual(array.length, 0) ? false_() : true_(array[0], array.slice(1));
}
function IsUnsafePropertyKey(key) {
  return IsEqual(key, "__proto__") || IsEqual(key, "constructor") || IsEqual(key, "prototype");
}
function HasPropertyKey(value, key) {
  return IsUnsafePropertyKey(key) ? Object.prototype.hasOwnProperty.call(value, key) : key in value;
}
function EntriesRegExp(value) {
  return Keys(value).map((key) => [new RegExp(`^${key}$`), value[key]]);
}
function Entries(value) {
  return Object.entries(value);
}
function Keys(value) {
  return Object.getOwnPropertyNames(value);
}
function Symbols(value) {
  return Object.getOwnPropertySymbols(value);
}
function Values(value) {
  return Object.values(value);
}
function DeepEqualObject(left, right) {
  if (!IsObject(right))
    return false;
  const keys = Keys(left);
  return IsEqual(keys.length, Keys(right).length) && keys.every((key) => IsDeepEqual(left[key], right[key]));
}
function DeepEqualArray(left, right) {
  return IsArray(right) && IsEqual(left.length, right.length) && left.every((_, index) => IsDeepEqual(left[index], right[index]));
}
function IsDeepEqual(left, right) {
  return IsArray(left) ? DeepEqualArray(left, right) : IsObject(left) ? DeepEqualObject(left, right) : IsEqual(left, right);
}

// node_modules/typebox/build/guard/globals.mjs
var globals_exports = {};
__export(globals_exports, {
  IsBigInt64Array: () => IsBigInt64Array,
  IsBigUint64Array: () => IsBigUint64Array,
  IsBoolean: () => IsBoolean2,
  IsDate: () => IsDate,
  IsFloat32Array: () => IsFloat32Array,
  IsFloat64Array: () => IsFloat64Array,
  IsInt16Array: () => IsInt16Array,
  IsInt32Array: () => IsInt32Array,
  IsInt8Array: () => IsInt8Array,
  IsMap: () => IsMap,
  IsNumber: () => IsNumber2,
  IsRegExp: () => IsRegExp,
  IsSet: () => IsSet,
  IsString: () => IsString2,
  IsTypeArray: () => IsTypeArray,
  IsUint16Array: () => IsUint16Array,
  IsUint32Array: () => IsUint32Array,
  IsUint8Array: () => IsUint8Array,
  IsUint8ClampedArray: () => IsUint8ClampedArray
});
function IsBoolean2(value) {
  return value instanceof Boolean;
}
function IsNumber2(value) {
  return value instanceof Number;
}
function IsString2(value) {
  return value instanceof String;
}
function IsTypeArray(value) {
  return globalThis.ArrayBuffer.isView(value);
}
function IsInt8Array(value) {
  return value instanceof globalThis.Int8Array;
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUint8ClampedArray(value) {
  return value instanceof globalThis.Uint8ClampedArray;
}
function IsInt16Array(value) {
  return value instanceof globalThis.Int16Array;
}
function IsUint16Array(value) {
  return value instanceof globalThis.Uint16Array;
}
function IsInt32Array(value) {
  return value instanceof globalThis.Int32Array;
}
function IsUint32Array(value) {
  return value instanceof globalThis.Uint32Array;
}
function IsFloat32Array(value) {
  return value instanceof globalThis.Float32Array;
}
function IsFloat64Array(value) {
  return value instanceof globalThis.Float64Array;
}
function IsBigInt64Array(value) {
  return value instanceof globalThis.BigInt64Array;
}
function IsBigUint64Array(value) {
  return value instanceof globalThis.BigUint64Array;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsSet(value) {
  return value instanceof globalThis.Set;
}
function IsMap(value) {
  return value instanceof globalThis.Map;
}

// node_modules/typebox/build/guard/index.mjs
var guard_default = guard_exports;

// node_modules/typebox/build/system/memory/clone.mjs
function FromClassInstance(value) {
  return value;
}
function IsTypeObject(value) {
  return guard_exports.HasPropertyKey(value, "~kind") || guard_exports.HasPropertyKey(value, "~unsafe");
}
function FromTypeObject(value) {
  const result = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    const descriptor = descriptors[key];
    if (guard_exports.HasPropertyKey(descriptor, "value")) {
      Object.defineProperty(result, key, { ...descriptor, value: FromValue(descriptor.value) });
    }
  }
  return result;
}
function FromPlainObject(value) {
  const result = {};
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    result[key] = FromValue(value[key]);
  }
  for (const key of guard_exports.Symbols(value)) {
    result[key] = FromValue(value[key]);
  }
  return result;
}
function FromObject(value) {
  return guard_exports.IsClassInstance(value) ? FromClassInstance(value) : IsTypeObject(value) ? FromTypeObject(value) : FromPlainObject(value);
}
function FromArray(value) {
  return value.map((element) => FromValue(element));
}
function FromTypedArray(value) {
  return value.slice();
}
function FromRegExp(value) {
  return new RegExp(value.source, value.flags);
}
function FromMap(value) {
  return new Map(FromValue([...value.entries()]));
}
function FromSet(value) {
  return new Set(FromValue([...value.values()]));
}
function FromValue(value) {
  return globals_exports.IsTypeArray(value) ? FromTypedArray(value) : globals_exports.IsRegExp(value) ? FromRegExp(value) : globals_exports.IsMap(value) ? FromMap(value) : globals_exports.IsSet(value) ? FromSet(value) : guard_exports.IsArray(value) ? FromArray(value) : guard_exports.IsObject(value) ? FromObject(value) : value;
}
function Clone(value) {
  Metrics.clone += 1;
  return FromValue(value);
}

// node_modules/typebox/build/system/settings/settings.mjs
var settings_exports = {};
__export(settings_exports, {
  Get: () => Get,
  Reset: () => Reset,
  Set: () => Set2
});
var settings = {
  immutableTypes: false,
  maxErrors: 8,
  useAcceleration: true,
  exactOptionalPropertyTypes: false,
  enumerableKind: false,
  correctiveParse: false,
  unionPrioritySort: true
};
function Reset() {
  settings.immutableTypes = false;
  settings.maxErrors = 8;
  settings.useAcceleration = true;
  settings.exactOptionalPropertyTypes = false;
  settings.enumerableKind = false;
  settings.correctiveParse = false;
  settings.unionPrioritySort = true;
}
function Set2(options) {
  for (const key of guard_exports.Keys(options)) {
    const value = options[key];
    if (value !== void 0) {
      Object.defineProperty(settings, key, { value });
    }
  }
}
function Get() {
  return settings;
}

// node_modules/typebox/build/system/memory/create.mjs
function MergeHidden(left, right) {
  for (const key of Object.keys(right)) {
    Object.defineProperty(left, key, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: right[key]
    });
  }
  return left;
}
function Merge(left, right) {
  return { ...left, ...right };
}
function Create(hidden, enumerable, options = {}) {
  Metrics.create += 1;
  const settings2 = settings_exports.Get();
  const withOptions = Merge(enumerable, options);
  const withHidden = settings2.enumerableKind ? Merge(withOptions, hidden) : MergeHidden(withOptions, hidden);
  return settings2.immutableTypes ? Object.freeze(withHidden) : withHidden;
}

// node_modules/typebox/build/system/memory/discard.mjs
function Discard(value, propertyKeys) {
  Metrics.discard += 1;
  const result = {};
  const descriptors = Object.getOwnPropertyDescriptors(Clone(value));
  const keysToDiscard = new Set(propertyKeys);
  for (const key of Object.keys(descriptors)) {
    if (keysToDiscard.has(key))
      continue;
    Object.defineProperty(result, key, descriptors[key]);
  }
  return result;
}

// node_modules/typebox/build/system/memory/update.mjs
function Update(current, hidden, enumerable) {
  Metrics.update += 1;
  const settings2 = settings_exports.Get();
  const result = Clone(current);
  for (const key of Object.keys(hidden)) {
    Object.defineProperty(result, key, {
      configurable: true,
      writable: true,
      enumerable: settings2.enumerableKind,
      value: hidden[key]
    });
  }
  for (const key of Object.keys(enumerable)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: enumerable[key]
    });
  }
  return result;
}

// node_modules/typebox/build/type/types/schema.mjs
function IsKind(value, kind) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], kind);
}
function IsSchema(value) {
  return guard_exports.IsObject(value);
}

// node_modules/typebox/build/type/types/deferred.mjs
function Deferred(action, parameters, options) {
  return memory_exports.Create({ "~kind": "Deferred" }, { type: "deferred", action, parameters, options }, {});
}
function IsDeferred(value) {
  return IsKind(value, "Deferred");
}

// node_modules/typebox/build/type/engine/readonly/instantiate_add.mjs
function AddReadonlyOperation(type) {
  return memory_exports.Update(type, { "~readonly": true }, {});
}
function AddReadonlyAction(type, options) {
  const result = memory_exports.Update(AddReadonlyOperation(type), {}, options);
  return result;
}
function AddReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_add.mjs
function AddOptionalOperation(type) {
  return memory_exports.Update(type, { "~optional": true }, {});
}
function AddOptionalAction(type, options) {
  const result = memory_exports.Update(AddOptionalOperation(type), {}, options);
  return result;
}
function AddOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/types/array.mjs
function _Array_(items, options) {
  return memory_exports.Create({ "~kind": "Array" }, { type: "array", items }, options);
}
function IsArray2(value) {
  return IsKind(value, "Array");
}
function ArrayOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items"]);
}

// node_modules/typebox/build/type/types/constructor.mjs
function Constructor(parameters, instanceType, options = {}) {
  return memory_exports.Create({ "~kind": "Constructor" }, { type: "constructor", parameters, instanceType }, options);
}
function IsConstructor2(value) {
  return IsKind(value, "Constructor");
}
function ConstructorOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "instanceType"]);
}

// node_modules/typebox/build/type/types/function.mjs
function _Function_(parameters, returnType, options = {}) {
  return memory_exports.Create({ ["~kind"]: "Function" }, { type: "function", parameters, returnType }, options);
}
function IsFunction2(value) {
  return IsKind(value, "Function");
}
function FunctionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "parameters", "returnType"]);
}

// node_modules/typebox/build/type/types/ref.mjs
function Ref(ref, options) {
  return memory_exports.Create({ ["~kind"]: "Ref" }, { $ref: ref }, options);
}
function IsRef(value) {
  return IsKind(value, "Ref");
}

// node_modules/typebox/build/type/types/generic.mjs
function Generic(parameters, expression) {
  return memory_exports.Create({ "~kind": "Generic" }, { type: "generic", parameters, expression });
}
function IsGeneric(value) {
  return IsKind(value, "Generic");
}

// node_modules/typebox/build/type/types/any.mjs
function Any(options) {
  return memory_exports.Create({ ["~kind"]: "Any" }, {}, options);
}
function IsAny(value) {
  return IsKind(value, "Any");
}

// node_modules/typebox/build/type/types/never.mjs
var NeverPattern = "(?!)";
function Never(options) {
  return memory_exports.Create({ "~kind": "Never" }, { not: {} }, options);
}
function IsNever(value) {
  return IsKind(value, "Never");
}

// node_modules/typebox/build/type/action/_add_optional.mjs
function AddOptionalDeferred(type, options = {}) {
  return Deferred("AddOptional", [type], options);
}
function AddOptional(type, options = {}) {
  return AddOptionalAction(type, options);
}

// node_modules/typebox/build/type/types/_optional.mjs
function Optional(type) {
  return AddOptional(type);
}
function IsOptional(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~optional");
}

// node_modules/typebox/build/type/types/properties.mjs
function RequiredArray(properties) {
  return guard_exports.Keys(properties).filter((key) => !IsOptional(properties[key]));
}
function PropertyKeys(properties) {
  return guard_exports.Keys(properties);
}
function PropertyValues(properties) {
  return guard_exports.Values(properties);
}

// node_modules/typebox/build/type/types/object.mjs
function _Object_(properties, options = {}) {
  const requiredKeys = RequiredArray(properties);
  const required = requiredKeys.length > 0 ? { required: requiredKeys } : {};
  return memory_exports.Create({ "~kind": "Object" }, { type: "object", ...required, properties }, options);
}
function IsObject2(value) {
  return IsKind(value, "Object");
}
function ObjectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "properties", "required"]);
}

// node_modules/typebox/build/type/types/unknown.mjs
function Unknown(options) {
  return memory_exports.Create({ ["~kind"]: "Unknown" }, {}, options);
}
function IsUnknown(value) {
  return IsKind(value, "Unknown");
}

// node_modules/typebox/build/type/types/cyclic.mjs
function Cyclic($defs, $ref, options) {
  const defs = guard_exports.Keys($defs).reduce((result, key) => {
    return { ...result, [key]: memory_exports.Update($defs[key], {}, { $id: key }) };
  }, {});
  return memory_exports.Create({ ["~kind"]: "Cyclic" }, { $defs: defs, $ref }, options);
}
function IsCyclic(value) {
  return IsKind(value, "Cyclic");
}

// node_modules/typebox/build/type/types/unsafe.mjs
function Unsafe(schema) {
  return memory_exports.Update(schema, { ["~unsafe"]: null }, {});
}
function IsUnsafe(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "~unsafe") && guard_exports.IsNull(value["~unsafe"]);
}

// node_modules/typebox/build/system/arguments/arguments.mjs
var arguments_exports = {};
__export(arguments_exports, {
  Match: () => Match
});
function Match(args, match) {
  return match[args.length]?.(...args) ?? (() => {
    throw Error("Invalid Arguments");
  })();
}

// node_modules/typebox/build/type/types/infer.mjs
function Infer(...args) {
  const [name, extends_] = arguments_exports.Match(args, {
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ ["~kind"]: "Infer" }, { type: "infer", name, extends: extends_ }, {});
}
function IsInfer(value) {
  return IsKind(value, "Infer");
}

// node_modules/typebox/build/type/types/dependent.mjs
function Dependent(if_, then_, else_, options = {}) {
  return memory_exports.Create({ "~kind": "Dependent" }, { if: if_, then: then_, else: else_ }, options);
}
function IsDependent(value) {
  return IsKind(value, "Dependent");
}
function DependentOptions(type) {
  return memory_exports.Discard(type, ["~kind", "if", "then", "else"]);
}

// node_modules/typebox/build/type/engine/enum/typescript_enum_to_enum_values.mjs
function IsTypeScriptEnumLike(value) {
  return guard_exports.IsObjectNotArray(value);
}
function TypeScriptEnumToEnumValues(type) {
  const keys = guard_exports.Keys(type).filter((key) => isNaN(key));
  return keys.reduce((result, key) => [...result, type[key]], []);
}

// node_modules/typebox/build/type/types/enum.mjs
function IsEnumValue(value) {
  return guard_exports.IsString(value) || guard_exports.IsNumber(value);
}
function Enum(value, options) {
  const values = IsTypeScriptEnumLike(value) ? TypeScriptEnumToEnumValues(value) : value;
  return memory_exports.Create({ "~kind": "Enum" }, { enum: values }, options);
}
function IsEnum(value) {
  return IsKind(value, "Enum");
}

// node_modules/typebox/build/type/types/intersect.mjs
function Intersect(types, options = {}) {
  return memory_exports.Create({ "~kind": "Intersect" }, { allOf: types }, options);
}
function IsIntersect(value) {
  return IsKind(value, "Intersect");
}
function IntersectOptions(type) {
  return memory_exports.Discard(type, ["~kind", "allOf"]);
}

// node_modules/typebox/build/system/hashing/hash.mjs
var hash_exports = {};
__export(hash_exports, {
  Hash: () => Hash,
  HashCode: () => HashCode
});

// node_modules/typebox/build/system/unreachable/unreachable.mjs
function Unreachable() {
  throw new Error("Unreachable");
}

// node_modules/typebox/build/system/hashing/hash.mjs
function InstanceKeys(value) {
  const propertyKeys = /* @__PURE__ */ new Set();
  let current = value;
  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (key !== "constructor" && typeof key !== "symbol")
        propertyKeys.add(key);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...propertyKeys];
}
function IsIEEE754(value) {
  return typeof value === "number";
}
var ByteMarker;
(function(ByteMarker2) {
  ByteMarker2[ByteMarker2["Array"] = 0] = "Array";
  ByteMarker2[ByteMarker2["BigInt"] = 1] = "BigInt";
  ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
  ByteMarker2[ByteMarker2["Date"] = 3] = "Date";
  ByteMarker2[ByteMarker2["Constructor"] = 4] = "Constructor";
  ByteMarker2[ByteMarker2["Function"] = 5] = "Function";
  ByteMarker2[ByteMarker2["Null"] = 6] = "Null";
  ByteMarker2[ByteMarker2["Number"] = 7] = "Number";
  ByteMarker2[ByteMarker2["Object"] = 8] = "Object";
  ByteMarker2[ByteMarker2["RegExp"] = 9] = "RegExp";
  ByteMarker2[ByteMarker2["String"] = 10] = "String";
  ByteMarker2[ByteMarker2["Symbol"] = 11] = "Symbol";
  ByteMarker2[ByteMarker2["TypeArray"] = 12] = "TypeArray";
  ByteMarker2[ByteMarker2["Undefined"] = 13] = "Undefined";
})(ByteMarker || (ByteMarker = {}));
var Accumulator = BigInt("14695981039346656037");
var [Prime, Size] = [BigInt("1099511628211"), BigInt(
  "18446744073709551616"
  /* 2 ^ 64 */
)];
var Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
var F64 = new Float64Array(1);
var F64In = new DataView(F64.buffer);
var F64Out = new Uint8Array(F64.buffer);
function FNV1A64_OP(byte) {
  Accumulator = Accumulator ^ Bytes[byte];
  Accumulator = Accumulator * Prime % Size;
}
function FromArray2(value) {
  FNV1A64_OP(ByteMarker.Array);
  for (const item of value) {
    FromValue2(item);
  }
}
function FromBigInt(value) {
  FNV1A64_OP(ByteMarker.BigInt);
  F64In.setBigInt64(0, value);
  for (const byte of F64Out) {
    FNV1A64_OP(byte);
  }
}
function FromBoolean(value) {
  FNV1A64_OP(ByteMarker.Boolean);
  FNV1A64_OP(value ? 1 : 0);
}
function FromConstructor(value) {
  FNV1A64_OP(ByteMarker.Constructor);
  FromValue2(value.toString());
}
function FromDate(value) {
  FNV1A64_OP(ByteMarker.Date);
  FromValue2(value.getTime());
}
function FromFunction(value) {
  FNV1A64_OP(ByteMarker.Function);
  FromValue2(value.toString());
}
function FromNull(_value) {
  FNV1A64_OP(ByteMarker.Null);
}
function FromNumber(value) {
  FNV1A64_OP(ByteMarker.Number);
  F64In.setFloat64(
    0,
    value,
    true
    /* little-endian */
  );
  for (const byte of F64Out) {
    FNV1A64_OP(byte);
  }
}
function FromObject2(value) {
  FNV1A64_OP(ByteMarker.Object);
  for (const key of InstanceKeys(value).sort()) {
    FromValue2(key);
    FromValue2(value[key]);
  }
}
function FromRegExp2(value) {
  FNV1A64_OP(ByteMarker.RegExp);
  FromString(value.toString());
}
var encoder = new TextEncoder();
function FromString(value) {
  FNV1A64_OP(ByteMarker.String);
  for (const byte of encoder.encode(value)) {
    FNV1A64_OP(byte);
  }
}
function FromSymbol(value) {
  FNV1A64_OP(ByteMarker.Symbol);
  FromValue2(value.toString());
}
function FromTypeArray(value) {
  FNV1A64_OP(ByteMarker.TypeArray);
  const buffer = new Uint8Array(value.buffer);
  for (let i = 0; i < buffer.length; i++) {
    FNV1A64_OP(buffer[i]);
  }
}
function FromUndefined(_value) {
  return FNV1A64_OP(ByteMarker.Undefined);
}
function FromValue2(value) {
  return globals_exports.IsTypeArray(value) ? FromTypeArray(value) : globals_exports.IsDate(value) ? FromDate(value) : globals_exports.IsRegExp(value) ? FromRegExp2(value) : globals_exports.IsBoolean(value) ? FromBoolean(value.valueOf()) : globals_exports.IsString(value) ? FromString(value.valueOf()) : globals_exports.IsNumber(value) ? FromNumber(value.valueOf()) : IsIEEE754(value) ? FromNumber(value) : guard_exports.IsArray(value) ? FromArray2(value) : guard_exports.IsBoolean(value) ? FromBoolean(value) : guard_exports.IsBigInt(value) ? FromBigInt(value) : guard_exports.IsConstructor(value) ? FromConstructor(value) : guard_exports.IsNull(value) ? FromNull(value) : guard_exports.IsObject(value) ? FromObject2(value) : guard_exports.IsString(value) ? FromString(value) : guard_exports.IsSymbol(value) ? FromSymbol(value) : guard_exports.IsUndefined(value) ? FromUndefined(value) : guard_exports.IsFunction(value) ? FromFunction(value) : Unreachable();
}
function HashCode(value) {
  Accumulator = BigInt("14695981039346656037");
  FromValue2(value);
  return Accumulator;
}
function Hash(value) {
  return HashCode(value).toString(16).padStart(16, "0");
}

// node_modules/typebox/build/system/locale/en_US.mjs
function en_US(error) {
  switch (error.keyword) {
    case "additionalProperties":
      return "must not have additional properties";
    case "anyOf":
      return "must match a schema in anyOf";
    case "boolean":
      return "schema is false";
    case "const":
      return "must be equal to constant";
    case "contains":
      return "must contain at least 1 valid item";
    case "dependencies":
      return `must have properties ${error.params.dependencies.join(", ")} when property ${error.params.property} is present`;
    case "dependentRequired":
      return `must have properties ${error.params.dependencies.join(", ")} when property ${error.params.property} is present`;
    case "enum":
      return "must be equal to one of the allowed values";
    case "exclusiveMaximum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "exclusiveMinimum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "format":
      return `must match format "${error.params.format}"`;
    case "if":
      return `must match "${error.params.failingKeyword}" schema`;
    case "maxItems":
      return `must not have more than ${error.params.limit} items`;
    case "maxLength":
      return `must not have more than ${error.params.limit} characters`;
    case "maxProperties":
      return `must not have more than ${error.params.limit} properties`;
    case "maximum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "minItems":
      return `must not have fewer than ${error.params.limit} items`;
    case "minLength":
      return `must not have fewer than ${error.params.limit} characters`;
    case "minProperties":
      return `must not have fewer than ${error.params.limit} properties`;
    case "minimum":
      return `must be ${error.params.comparison} ${error.params.limit}`;
    case "multipleOf":
      return `must be multiple of ${error.params.multipleOf}`;
    case "not":
      return "must not be valid";
    case "oneOf":
      return "must match exactly one schema in oneOf";
    case "pattern":
      return `must match pattern "${error.params.pattern}"`;
    case "propertyNames":
      return `property names ${error.params.propertyNames.join(", ")} are invalid`;
    case "required":
      return `must have required properties ${error.params.requiredProperties.join(", ")}`;
    case "type":
      return typeof error.params.type === "string" ? `must be ${error.params.type}` : `must be either ${error.params.type.join(" or ")}`;
    case "unevaluatedItems":
      return "must not have unevaluated items";
    case "unevaluatedProperties":
      return "must not have unevaluated properties";
    case "uniqueItems":
      return `must not have duplicate items`;
    case "~refine":
      return error.params.message;
    // deno-coverage-ignore - unreachable
    default:
      return "an unknown validation error occurred";
  }
}

// node_modules/typebox/build/system/locale/_config.mjs
var locale = en_US;
function Get2() {
  return locale;
}

// node_modules/typebox/build/type/types/_codec.mjs
var EncodeBuilder = class {
  constructor(type, decode) {
    this.type = type;
    this.decode = decode;
  }
  Encode(callback) {
    const type = this.type;
    const decode = IsCodec(type) ? (value) => this.decode(type["~codec"].decode(value)) : this.decode;
    const encode = IsCodec(type) ? (value) => type["~codec"].encode(callback(value)) : callback;
    const codec = { decode, encode };
    return memory_exports.Update(this.type, { "~codec": codec }, {});
  }
};
var DecodeBuilder = class {
  constructor(type) {
    this.type = type;
  }
  Decode(callback) {
    return new EncodeBuilder(this.type, callback);
  }
};
function Codec(type) {
  return new DecodeBuilder(type);
}
function Decode(type, callback) {
  return Codec(type).Decode(callback).Encode(() => {
    throw Error("Encode not implemented");
  });
}
function Encode(type, callback) {
  return Codec(type).Decode(() => {
    throw Error("Decode not implemented");
  }).Encode(callback);
}
function IsCodec(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~codec") && guard_exports.IsObject(value["~codec"]) && guard_exports.HasPropertyKey(value["~codec"], "encode") && guard_exports.HasPropertyKey(value["~codec"], "decode");
}

// node_modules/typebox/build/type/types/_immutable.mjs
function Immutable(type) {
  return AddImmutable(type);
}
function IsImmutable(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~immutable");
}

// node_modules/typebox/build/type/action/_add_readonly.mjs
function AddReadonlyDeferred(type, options = {}) {
  return Deferred("AddReadonly", [type], options);
}
function AddReadonly(type, options = {}) {
  return AddReadonlyAction(type, options);
}

// node_modules/typebox/build/type/types/_readonly.mjs
function Readonly(type) {
  return AddReadonly(type);
}
function IsReadonly(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~readonly");
}

// node_modules/typebox/build/type/types/_refine.mjs
function RefineAdd(type, refinement) {
  const refinements = IsRefine(type) ? [...type["~refine"], refinement] : [refinement];
  return memory_exports.Update(type, { "~refine": refinements }, {});
}
function Refine(...args) {
  const [type, check, error] = arguments_exports.Match(args, {
    3: (type2, check2, error2) => [type2, check2, error2],
    2: (type2, check2) => [type2, check2, () => "Refine Error"]
  });
  return RefineAdd(type, { check, error });
}
function IsRefinement(value) {
  return guard_exports.IsObjectNotArray(value) && guard_exports.HasPropertyKey(value, "check") && guard_exports.HasPropertyKey(value, "error") && guard_exports.IsFunction(value.check) && guard_exports.IsFunction(value.error);
}
function IsRefine(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "~refine") && guard_exports.IsArray(value["~refine"]) && guard_exports.Every(value["~refine"], 0, (value2) => IsRefinement(value2));
}

// node_modules/typebox/build/type/types/bigint.mjs
var BigIntPattern = "-?(?:0|[1-9][0-9]*)n";
function BigInt2(options) {
  return memory_exports.Create({ "~kind": "BigInt" }, { type: "bigint" }, options);
}
function IsBigInt2(value) {
  return IsKind(value, "BigInt");
}

// node_modules/typebox/build/type/types/boolean.mjs
function Boolean2(options) {
  return memory_exports.Create({ "~kind": "Boolean" }, { type: "boolean" }, options);
}
function IsBoolean3(value) {
  return IsKind(value, "Boolean");
}

// node_modules/typebox/build/type/types/identifier.mjs
function Identifier(name) {
  return memory_exports.Create({ "~kind": "Identifier" }, { name });
}
function IsIdentifier(value) {
  return IsKind(value, "Identifier");
}

// node_modules/typebox/build/type/types/integer.mjs
var IntegerPattern = "-?(?:0|[1-9][0-9]*)";
function Integer(options) {
  return memory_exports.Create({ "~kind": "Integer" }, { type: "integer" }, options);
}
function IsInteger2(value) {
  return IsKind(value, "Integer");
}

// node_modules/typebox/build/type/types/literal.mjs
var InvalidLiteralValue = class extends Error {
  constructor(value) {
    super(`Invalid Literal value`);
    Object.defineProperty(this, "cause", {
      value: { value },
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
};
function LiteralTypeName(value) {
  return guard_exports.IsBigInt(value) ? "bigint" : guard_exports.IsBoolean(value) ? "boolean" : guard_exports.IsNumber(value) ? "number" : guard_exports.IsString(value) ? "string" : (() => {
    throw new InvalidLiteralValue(value);
  })();
}
function Literal(value, options) {
  return memory_exports.Create({ "~kind": "Literal" }, { type: LiteralTypeName(value), const: value }, options);
}
function IsLiteralValue(value) {
  return guard_exports.IsBigInt(value) || guard_exports.IsBoolean(value) || guard_exports.IsNumber(value) || guard_exports.IsString(value);
}
function IsLiteralBigInt(value) {
  return IsLiteral(value) && guard_exports.IsBigInt(value.const);
}
function IsLiteralBoolean(value) {
  return IsLiteral(value) && guard_exports.IsBoolean(value.const);
}
function IsLiteralNumber(value) {
  return IsLiteral(value) && guard_exports.IsNumber(value.const);
}
function IsLiteralString(value) {
  return IsLiteral(value) && guard_exports.IsString(value.const);
}
function IsLiteral(value) {
  return IsKind(value, "Literal");
}

// node_modules/typebox/build/type/types/null.mjs
function Null(options) {
  return memory_exports.Create({ "~kind": "Null" }, { type: "null" }, options);
}
function IsNull2(value) {
  return IsKind(value, "Null");
}

// node_modules/typebox/build/type/types/number.mjs
var NumberPattern = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?";
function Number2(options) {
  return memory_exports.Create({ "~kind": "Number" }, { type: "number" }, options);
}
function IsNumber3(value) {
  return IsKind(value, "Number");
}

// node_modules/typebox/build/type/types/symbol.mjs
function Symbol2(options) {
  return memory_exports.Create({ "~kind": "Symbol" }, { type: "symbol" }, options);
}
function IsSymbol2(value) {
  return IsKind(value, "Symbol");
}

// node_modules/typebox/build/type/types/parameter.mjs
function Parameter(...args) {
  const [name, extends_, equals] = arguments_exports.Match(args, {
    3: (name2, extends_2, equals2) => [name2, extends_2, equals2],
    2: (name2, extends_2) => [name2, extends_2, extends_2],
    1: (name2) => [name2, Unknown(), Unknown()]
  });
  return memory_exports.Create({ "~kind": "Parameter" }, { name, extends: extends_, equals }, {});
}
function IsParameter(value) {
  return IsKind(value, "Parameter");
}

// node_modules/typebox/build/type/types/string.mjs
var StringPattern = ".*";
function String2(options) {
  return memory_exports.Create({ "~kind": "String" }, { type: "string" }, options);
}
function IsString3(value) {
  return IsKind(value, "String");
}

// node_modules/typebox/build/type/types/union.mjs
function Union(anyOf, options = {}) {
  return memory_exports.Create({ "~kind": "Union" }, { anyOf }, options);
}
function IsUnion(value) {
  return IsKind(value, "Union");
}
function UnionOptions(type) {
  return memory_exports.Discard(type, ["~kind", "anyOf"]);
}

// node_modules/typebox/build/type/engine/patterns/pattern.mjs
function ParsePatternIntoTypes(pattern) {
  const parsed = Pattern(pattern);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : [];
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/is_finite.mjs
function FromLiteral(_value) {
  return true;
}
function FromTypesReduce(types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType(left) ? FromTypesReduce(right) : false, () => true);
}
function FromTypes(types) {
  const result = guard_exports.IsEqual(types.length, 0) ? false : FromTypesReduce(types);
  return result;
}
function FromType(type) {
  return IsUnion(type) ? FromTypes(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : false;
}
function IsTemplateLiteralFinite(types) {
  const result = FromTypes(types);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/create.mjs
function TemplateLiteralCreate(pattern) {
  return memory_exports.Create({ ["~kind"]: "TemplateLiteral" }, { type: "string", pattern }, {});
}

// node_modules/typebox/build/type/engine/template_literal/decode.mjs
function FromLiteralPush(variants, value, result = []) {
  return guard_exports.ShiftLeft(variants, (left, right) => FromLiteralPush(right, value, [...result, `${left}${value}`]), () => result);
}
function FromLiteral2(variants, value) {
  return guard_exports.IsEqual(variants.length, 0) ? [`${value}`] : FromLiteralPush(variants, value);
}
function FromUnion(variants, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => FromUnion(variants, right, [...result, ...FromType2(variants, left)]), () => result);
}
function FromType2(variants, type) {
  const result = IsUnion(type) ? FromUnion(variants, type.anyOf) : IsLiteral(type) ? FromLiteral2(variants, type.const) : Unreachable();
  return result;
}
function DecodeFromSpan(variants, types) {
  return guard_exports.ShiftLeft(types, (left, right) => DecodeFromSpan(FromType2(variants, left), right), () => variants);
}
function VariantsToLiterals(variants) {
  return variants.map((variant) => Literal(variant));
}
function DecodeTypesAsUnion(types) {
  const variants = DecodeFromSpan([], types);
  const literals = VariantsToLiterals(variants);
  const result = Union(literals);
  return result;
}
function DecodeTypes(types) {
  return guard_exports.IsEqual(types.length, 0) ? Unreachable() : (
    // Literal('') :
    guard_exports.IsEqual(types.length, 1) && IsLiteral(types[0]) ? types[0] : DecodeTypesAsUnion(types)
  );
}
function TemplateLiteralDecodeUnsafe(pattern) {
  const types = ParsePatternIntoTypes(pattern);
  const result = guard_exports.IsEqual(types.length, 0) ? String2() : IsTemplateLiteralFinite(types) ? DecodeTypes(types) : TemplateLiteralCreate(pattern);
  return result;
}
function TemplateLiteralDecode(pattern) {
  const decoded = TemplateLiteralDecodeUnsafe(pattern);
  const result = IsTemplateLiteral(decoded) ? String2() : decoded;
  return result;
}

// node_modules/typebox/build/type/engine/record/record_create.mjs
function CreateRecord(key, value) {
  const type = "object";
  const patternProperties = { [key]: value };
  return memory_exports.Create({ ["~kind"]: "Record" }, { type, patternProperties });
}

// node_modules/typebox/build/type/engine/record/from_key_any.mjs
function FromAnyKey(value) {
  return CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_boolean.mjs
function FromBooleanKey(value) {
  return _Object_({ true: value, false: value });
}

// node_modules/typebox/build/type/types/tuple.mjs
function Tuple(types, options = {}) {
  const [items, minItems, additionalItems] = [types, types.length, false];
  return memory_exports.Create({ ["~kind"]: "Tuple" }, { type: "array", additionalItems, items, minItems }, options);
}
function IsTuple(value) {
  return IsKind(value, "Tuple");
}
function TupleOptions(type) {
  return memory_exports.Discard(type, ["~kind", "type", "items", "minItems", "additionalItems"]);
}

// node_modules/typebox/build/type/engine/readonly/instantiate_remove.mjs
function RemoveReadonlyOperation(type) {
  return memory_exports.Discard(type, ["~readonly"]);
}
function RemoveReadonlyAction(type, options) {
  const result = memory_exports.Update(RemoveReadonlyOperation(type), {}, options);
  return result;
}
function RemoveReadonlyInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveReadonlyAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_readonly.mjs
function RemoveReadonlyDeferred(type, options = {}) {
  return Deferred("RemoveReadonly", [type], options);
}
function RemoveReadonly(type, options = {}) {
  return RemoveReadonlyAction(type, options);
}

// node_modules/typebox/build/type/engine/optional/instantiate_remove.mjs
function RemoveOptionalOperation(type) {
  return memory_exports.Discard(type, ["~optional"]);
}
function RemoveOptionalAction(type, options) {
  const result = memory_exports.Update(RemoveOptionalOperation(type), {}, options);
  return result;
}
function RemoveOptionalInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveOptionalAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_remove_optional.mjs
function RemoveOptionalDeferred(type, options = {}) {
  return Deferred("RemoveOptional", [type], options);
}
function RemoveOptional(type, options = {}) {
  return RemoveOptionalAction(type, options);
}

// node_modules/typebox/build/type/engine/tuple/to_object.mjs
function TupleElementsToProperties(types) {
  const result = types.reduceRight((result2, right, index) => {
    return { [index]: right, ...result2 };
  }, {});
  return result;
}
function TupleToObject(type) {
  const properties = TupleElementsToProperties(type.items);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/composite.mjs
function IsReadonlyProperty(left, right) {
  return IsReadonly(left) ? IsReadonly(right) ? true : false : false;
}
function IsOptionalProperty(left, right) {
  return IsOptional(left) ? IsOptional(right) ? true : false : false;
}
function CompositeProperty(left, right) {
  const isReadonly = IsReadonlyProperty(left, right);
  const isOptional = IsOptionalProperty(left, right);
  const evaluated = EvaluateIntersect([left, right]);
  const property = RemoveReadonly(RemoveOptional(evaluated));
  return isReadonly && isOptional ? AddReadonly(AddOptional(property)) : isReadonly && !isOptional ? AddReadonly(property) : !isReadonly && isOptional ? AddOptional(property) : property;
}
function CompositePropertyKey(left, right, key) {
  return key in left ? key in right ? CompositeProperty(left[key], right[key]) : left[key] : key in right ? right[key] : Never();
}
function CompositeProperties(left, right) {
  const keys = /* @__PURE__ */ new Set([...guard_exports.Keys(right), ...guard_exports.Keys(left)]);
  return [...keys].reduce((result, key) => {
    return { ...result, [key]: CompositePropertyKey(left, right, key) };
  }, {});
}
function GetProperties(type) {
  const result = IsObject2(type) ? type.properties : IsTuple(type) ? TupleElementsToProperties(type.items) : Unreachable();
  return result;
}
function Composite(left, right) {
  const leftProperties = GetProperties(left);
  const rightProperties = GetProperties(right);
  const properties = CompositeProperties(leftProperties, rightProperties);
  return _Object_(properties);
}

// node_modules/typebox/build/type/engine/evaluate/narrow.mjs
function Narrow(left, right) {
  const result = Compare(left, right);
  return guard_exports.IsEqual(result, ResultLeftInside) ? left : guard_exports.IsEqual(result, ResultRightInside) ? right : guard_exports.IsEqual(result, ResultEqual) ? right : Never();
}

// node_modules/typebox/build/type/engine/evaluate/distribute.mjs
function IsObjectLike(type) {
  return IsObject2(type) || IsTuple(type);
}
function IsUnionOperand(left, right) {
  const isUnionLeft = IsUnion(left);
  const isUnionRight = IsUnion(right);
  const result = isUnionLeft || isUnionRight;
  return result;
}
function DistributeOperation(left, right) {
  const evaluatedLeft = EvaluateType(left);
  const evaluatedRight = EvaluateType(right);
  const isUnionOperand = IsUnionOperand(evaluatedLeft, evaluatedRight);
  const isObjectLeft = IsObjectLike(evaluatedLeft);
  const IsObjectRight = IsObjectLike(evaluatedRight);
  const result = isUnionOperand ? EvaluateIntersect([evaluatedLeft, evaluatedRight]) : isObjectLeft && IsObjectRight ? Composite(evaluatedLeft, evaluatedRight) : isObjectLeft && !IsObjectRight ? evaluatedLeft : !isObjectLeft && IsObjectRight ? evaluatedRight : Narrow(evaluatedLeft, evaluatedRight);
  return result;
}
function DistributeType(type, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeType(type, right, [...result, DistributeOperation(type, left)]), () => guard_exports.IsEqual(result.length, 0) ? [type] : result);
}
function DistributeUnion(types, distribution, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => DistributeUnion(right, distribution, [...result, ...Distribute([left], distribution)]), () => result);
}
function Distribute(types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => IsUnion(left) ? Distribute(right, DistributeUnion(left.anyOf, result)) : Distribute(right, DistributeType(left, result)), () => result);
}

// node_modules/typebox/build/type/engine/exclude/operation.mjs
function ExcludeType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [] : [left];
  return result;
}
function ExcludeUnion(types, right) {
  return types.reduce((result, head) => {
    return [...result, ...ExcludeType(head, right)];
  }, []);
}
function ExcludeOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExcludeUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/evaluate.mjs
function EvaluateDependent(if_, then_, else_) {
  const intersect = Intersect([if_, then_]);
  const excluded = ExcludeOperation(else_, if_);
  const result = EvaluateUnion([intersect, excluded]);
  return result;
}
function EvaluateEnum(values) {
  const result = values.map((value) => Literal(value));
  return EvaluateUnion(result);
}
function EvaluateIntersect(types) {
  const distribution = Distribute(types);
  const broadend = Broaden(distribution);
  const result = EvaluateUnionFast(broadend);
  return result;
}
function EvaluateTemplateLiteral(pattern) {
  const evaluated = TemplateLiteralDecode(pattern);
  const result = EvaluateType(evaluated);
  return result;
}
function EvaluateUnion(types) {
  const broadend = Broaden(types);
  const result = EvaluateUnionFast(broadend);
  return result;
}
function EvaluateType(type) {
  return IsDependent(type) ? EvaluateDependent(type.if, type.then, type.else) : IsEnum(type) ? EvaluateEnum(type.enum) : IsIntersect(type) ? EvaluateIntersect(type.allOf) : IsTemplateLiteral(type) ? EvaluateTemplateLiteral(type.pattern) : IsUnion(type) ? EvaluateUnion(type.anyOf) : type;
}
function EvaluateUnionFast(types) {
  const result = guard_exports.IsEqual(types.length, 1) ? types[0] : guard_exports.IsEqual(types.length, 0) ? Never() : Union(types);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_enum.mjs
function FromEnumKey(values, value) {
  const unionKey = EvaluateEnum(values);
  const result = FromKey(unionKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_integer.mjs
function FromIntegerKey(_key, value) {
  const result = CreateRecord(IntegerKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_intersect.mjs
function FromIntersectKey(types, value) {
  const evaluatedKey = EvaluateIntersect(types);
  const result = FromKey(evaluatedKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_literal.mjs
function FromLiteralKey(key, value) {
  return guard_exports.IsString(key) || guard_exports.IsNumber(key) ? _Object_({ [key]: value }) : guard_exports.IsEqual(key, false) ? _Object_({ false: value }) : guard_exports.IsEqual(key, true) ? _Object_({ true: value }) : _Object_({});
}

// node_modules/typebox/build/type/engine/record/from_key_number.mjs
function FromNumberKey(_key, value) {
  const result = CreateRecord(NumberKey, value);
  return result;
}

// node_modules/typebox/build/type/engine/record/from_key_string.mjs
function FromStringKey(key, value) {
  return guard_exports.HasPropertyKey(key, "pattern") && (guard_exports.IsString(key.pattern) || key.pattern instanceof RegExp) ? CreateRecord(key.pattern.toString(), value) : CreateRecord(StringKey, value);
}

// node_modules/typebox/build/type/engine/record/from_key_template_literal.mjs
function FromTemplateKey(pattern, value) {
  const types = ParsePatternIntoTypes(pattern);
  const finite = IsTemplateLiteralFinite(types);
  const result = finite ? FromKey(EvaluateTemplateLiteral(pattern), value) : CreateRecord(pattern, value);
  return result;
}

// node_modules/typebox/build/type/engine/evaluate/flatten.mjs
function FlattenType(type) {
  const result = IsUnion(type) ? Flatten(type.anyOf) : [type];
  return result;
}
function Flatten(types) {
  return types.reduce((result, type) => {
    return [...result, ...FlattenType(type)];
  }, []);
}

// node_modules/typebox/build/type/engine/record/from_key_union.mjs
function StringOrNumberCheck(types) {
  return types.some((type) => IsString3(type) || IsNumber3(type) || IsInteger2(type));
}
function TryBuildRecord(types, value) {
  return guard_exports.IsEqual(StringOrNumberCheck(types), true) ? CreateRecord(StringKey, value) : void 0;
}
function CreateProperties(types, value) {
  return types.reduce((result, left) => {
    return IsLiteral(left) && (guard_exports.IsString(left.const) || guard_exports.IsNumber(left.const)) ? { ...result, [left.const]: value } : result;
  }, {});
}
function CreateObject(types, value) {
  const properties = CreateProperties(types, value);
  const result = _Object_(properties);
  return result;
}
function FromUnionKey(types, value) {
  const flattened = Flatten(types);
  const record = TryBuildRecord(flattened, value);
  return IsSchema(record) ? record : CreateObject(flattened, value);
}

// node_modules/typebox/build/type/engine/record/from_key.mjs
function FromKey(key, value) {
  const result = IsAny(key) ? FromAnyKey(value) : IsBoolean3(key) ? FromBooleanKey(value) : IsEnum(key) ? FromEnumKey(key.enum, value) : IsInteger2(key) ? FromIntegerKey(key, value) : IsIntersect(key) ? FromIntersectKey(key.allOf, value) : IsLiteral(key) ? FromLiteralKey(key.const, value) : IsNumber3(key) ? FromNumberKey(key, value) : IsUnion(key) ? FromUnionKey(key.anyOf, value) : IsString3(key) ? FromStringKey(key, value) : IsTemplateLiteral(key) ? FromTemplateKey(key.pattern, value) : _Object_({});
  return result;
}

// node_modules/typebox/build/type/engine/record/instantiate.mjs
function RecordAction(key, value, options) {
  const result = CanInstantiate([key]) ? memory_exports.Update(FromKey(key, value), {}, options) : RecordDeferred(key, value, options);
  return result;
}
function RecordInstantiate(context, state, key, value, options) {
  const instantiatedKey = InstantiateType(context, state, key);
  const instantiatedValue = InstantiateType(context, state, value);
  return RecordAction(instantiatedKey, instantiatedValue, options);
}

// node_modules/typebox/build/type/types/record.mjs
var IntegerKey = `^${IntegerPattern}$`;
var NumberKey = `^${NumberPattern}$`;
var StringKey = `^${StringPattern}$`;
function RecordDeferred(key, value, options = {}) {
  return Deferred("Record", [key, value], options);
}
function Record(key, value, options = {}) {
  return RecordAction(key, value, options);
}
function RecordFromPattern(pattern, value) {
  return CreateRecord(pattern, value);
}
function RecordPatternToType(pattern) {
  const result = guard_exports.IsEqual(pattern, StringKey) ? String2() : guard_exports.IsEqual(pattern, IntegerKey) ? Integer() : guard_exports.IsEqual(pattern, NumberKey) ? Number2() : TemplateLiteralDecodeUnsafe(pattern);
  return result;
}
function RecordPattern(type) {
  return guard_exports.Keys(type.patternProperties)[0];
}
function RecordKey(type) {
  const pattern = RecordPattern(type);
  const result = RecordPatternToType(pattern);
  return result;
}
function RecordValue(type) {
  return type.patternProperties[RecordPattern(type)];
}
function IsRecord(value) {
  return IsKind(value, "Record");
}

// node_modules/typebox/build/type/types/rest.mjs
function Rest(type) {
  return memory_exports.Create({ "~kind": "Rest" }, { type: "rest", items: type }, {});
}
function IsRest(value) {
  return IsKind(value, "Rest");
}

// node_modules/typebox/build/type/types/this.mjs
function This(options) {
  return memory_exports.Create({ ["~kind"]: "This" }, { $ref: "#" }, options);
}
function IsThis(value) {
  return IsKind(value, "This");
}

// node_modules/typebox/build/type/types/undefined.mjs
function Undefined(options) {
  return memory_exports.Create({ "~kind": "Undefined" }, { type: "undefined" }, options);
}
function IsUndefined2(value) {
  return IsKind(value, "Undefined");
}

// node_modules/typebox/build/type/types/void.mjs
function Void(options) {
  return memory_exports.Create({ "~kind": "Void" }, { type: "void" }, options);
}
function IsVoid(value) {
  return IsKind(value, "Void");
}

// node_modules/typebox/build/type/script/mapping.mjs
function IntrinsicOrCall(ref, parameters) {
  return guard_exports.IsEqual(ref, "Array") ? _Array_(parameters[0]) : guard_exports.IsEqual(ref, "Capitalize") ? CapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ConstructorParameters") ? ConstructorParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Evaluate") ? EvaluateDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Exclude") ? ExcludeDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Extract") ? ExtractDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Index") ? IndexDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "InstanceType") ? InstanceTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Lowercase") ? LowercaseDeferred(parameters[0]) : guard_exports.IsEqual(ref, "NonNullable") ? NonNullableDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Omit") ? OmitDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Parameters") ? ParametersDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Partial") ? PartialDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Pick") ? PickDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Readonly") ? ReadonlyObjectDeferred(parameters[0]) : guard_exports.IsEqual(ref, "KeyOf") ? KeyOfDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Record") ? RecordDeferred(parameters[0], parameters[1]) : guard_exports.IsEqual(ref, "Required") ? RequiredDeferred(parameters[0]) : guard_exports.IsEqual(ref, "ReturnType") ? ReturnTypeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uncapitalize") ? UncapitalizeDeferred(parameters[0]) : guard_exports.IsEqual(ref, "Uppercase") ? UppercaseDeferred(parameters[0]) : CallConstruct(Ref(ref), parameters);
}
function Unreachable2() {
  throw Error("Unreachable");
}
var DelimitedDecode = (input, result = []) => {
  return input.reduce((result2, left) => {
    return guard_exports.IsArray(left) && guard_exports.IsEqual(left.length, 2) ? [...result2, left[0]] : [...result2, left];
  }, []);
};
var Delimited = (input) => {
  const [left, right] = input;
  return DelimitedDecode([...left, ...right]);
};
function GenericParameterExtendsEqualsMapping(input) {
  return Parameter(input[0], input[2], input[4]);
}
function GenericParameterExtendsMapping(input) {
  return Parameter(input[0], input[2], input[2]);
}
function GenericParameterEqualsMapping(input) {
  return Parameter(input[0], Unknown(), input[2]);
}
function GenericParameterIdentifierMapping(input) {
  return Parameter(input, Unknown(), Unknown());
}
function GenericParameterMapping(input) {
  return input;
}
function GenericParameterListMapping(input) {
  return Delimited(input);
}
function GenericParametersMapping(input) {
  return input[1];
}
function GenericCallArgumentListMapping(input) {
  return Delimited(input);
}
function GenericCallArgumentsMapping(input) {
  return input[1];
}
function GenericCallMapping(input) {
  return IntrinsicOrCall(input[0], input[1]);
}
function OptionalSemiColonMapping(input) {
  return null;
}
function KeywordStringMapping(input) {
  return String2();
}
function KeywordNumberMapping(input) {
  return Number2();
}
function KeywordBooleanMapping(input) {
  return Boolean2();
}
function KeywordUndefinedMapping(input) {
  return Undefined();
}
function KeywordNullMapping(input) {
  return Null();
}
function KeywordIntegerMapping(input) {
  return Integer();
}
function KeywordBigIntMapping(input) {
  return BigInt2();
}
function KeywordUnknownMapping(input) {
  return Unknown();
}
function KeywordAnyMapping(input) {
  return Any();
}
function KeywordObjectMapping(input) {
  return _Object_({});
}
function KeywordNeverMapping(input) {
  return Never();
}
function KeywordSymbolMapping(input) {
  return Symbol2();
}
function KeywordVoidMapping(input) {
  return Void();
}
function KeywordThisMapping(input) {
  return This();
}
function LiteralBigIntMapping(input) {
  return Literal(BigInt(input));
}
function LiteralBooleanMapping(input) {
  return Literal(guard_exports.IsEqual(input, "true"));
}
function LiteralNumberMapping(input) {
  return Literal(parseFloat(input));
}
function LiteralStringMapping(input) {
  return Literal(input);
}
function TemplateInterpolateMapping(input) {
  return input[1];
}
function TemplateSpanMapping(input) {
  return Literal(input);
}
function TemplateBodyMapping(input) {
  return guard_exports.IsEqual(input.length, 3) ? [input[0], input[1], ...input[2]] : [input[0]];
}
function TemplateLiteralTypesMapping(input) {
  return input[1];
}
function TemplateLiteralMapping(input) {
  return TemplateLiteralDeferred(input);
}
function DependentMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? Dependent(input[1], input[3], input[5]) : Dependent(input[1], input[3], Unknown());
}
function KeyOfMapping(input) {
  return input.length > 0;
}
function IndexArrayMapping(input) {
  return input.reduce((result, current) => {
    return guard_exports.IsEqual(current.length, 3) ? [...result, [current[1]]] : [...result, []];
  }, []);
}
function ExtendsMapping(input) {
  return guard_exports.IsEqual(input.length, 6) ? [input[1], input[3], input[5]] : [];
}
function BaseMapping(input) {
  return guard_exports.IsArray(input) && guard_exports.IsEqual(input.length, 3) ? input[1] : input;
}
function WithMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function FactorIndexArray(Type2, indexArray) {
  return indexArray.reduce((result, left) => {
    const _left = left;
    return guard_exports.IsEqual(_left.length, 1) ? IndexDeferred(result, _left[0]) : guard_exports.IsEqual(_left.length, 0) ? _Array_(result) : Unreachable2();
  }, Type2);
}
function FactorExtends(type, extend) {
  return guard_exports.IsEqual(extend.length, 3) ? ConditionalDeferred(type, extend[0], extend[1], extend[2]) : type;
}
function FactorWith(type, withClause) {
  return guard_exports.IsArray(withClause) && guard_exports.IsEqual(withClause.length, 0) ? type : WithDeferred(type, withClause);
}
function FactorMapping(input) {
  const [keyOf, type, indexArray, extend, withClause] = input;
  return FactorWith(keyOf ? FactorExtends(KeyOfDeferred(FactorIndexArray(type, indexArray)), extend) : FactorExtends(FactorIndexArray(type, indexArray), extend), withClause);
}
function ExprBinaryMapping(left, rest) {
  return guard_exports.IsEqual(rest.length, 3) ? (() => {
    const [operator, right, next] = rest;
    const Schema = ExprBinaryMapping(right, next);
    if (guard_exports.IsEqual(operator, "&")) {
      return IsIntersect(Schema) ? Intersect([left, ...Schema.allOf]) : Intersect([left, Schema]);
    }
    if (guard_exports.IsEqual(operator, "|")) {
      return IsUnion(Schema) ? Union([left, ...Schema.anyOf]) : Union([left, Schema]);
    }
    Unreachable2();
  })() : left;
}
function ExprTermTailMapping(input) {
  return input;
}
function ExprTermMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprTailMapping(input) {
  return input;
}
function ExprMapping(input) {
  const [left, rest] = input;
  return ExprBinaryMapping(left, rest);
}
function ExprReadonlyMapping(input) {
  return AddImmutableDeferred(input[1]);
}
function ExprPipeMapping(input) {
  return input[1];
}
function GenericTypeMapping(input) {
  return Generic(input[0], input[2]);
}
function InferTypeMapping(input) {
  return guard_exports.IsEqual(input.length, 4) ? Infer(input[1], input[3]) : guard_exports.IsEqual(input.length, 2) ? Infer(input[1], Unknown()) : Unreachable2();
}
function TypeMapping(input) {
  return input;
}
function PropertyKeyNumberMapping(input) {
  return `${input}`;
}
function PropertyKeyIdentMapping(input) {
  return input;
}
function PropertyKeyQuotedMapping(input) {
  return input;
}
function PropertyKeyIndexMapping(input) {
  return IsInteger2(input[3]) ? IntegerKey : IsNumber3(input[3]) ? NumberKey : IsSymbol2(input[3]) ? StringKey : IsString3(input[3]) ? StringKey : Unreachable2();
}
function PropertyKeyMapping(input) {
  return input;
}
function ReadonlyMapping(input) {
  return input.length > 0;
}
function OptionalMapping(input) {
  return input.length > 0;
}
function PropertyMapping(input) {
  const [isReadonly, key, isOptional, _colon, type] = input;
  return {
    [key]: isReadonly && isOptional ? AddReadonlyDeferred(AddOptionalDeferred(type)) : isReadonly && !isOptional ? AddReadonlyDeferred(type) : !isReadonly && isOptional ? AddOptionalDeferred(type) : type
  };
}
function PropertyDelimiterMapping(input) {
  return input;
}
function PropertyListMapping(input) {
  return Delimited(input);
}
function PropertiesReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    const isPatternProperties = guard_exports.HasPropertyKey(left, IntegerKey) || guard_exports.HasPropertyKey(left, NumberKey) || guard_exports.HasPropertyKey(left, StringKey);
    return isPatternProperties ? [result[0], memory_exports.Assign(result[1], left)] : [memory_exports.Assign(result[0], left), result[1]];
  }, [{}, {}]);
}
function PropertiesMapping(input) {
  return PropertiesReduce(input[1]);
}
function _Object_Mapping(input) {
  const [properties, patternProperties] = input;
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return _Object_(properties, options);
}
function ElementNamedMapping(input) {
  return guard_exports.IsEqual(input.length, 5) ? AddReadonlyDeferred(AddOptionalDeferred(input[4])) : guard_exports.IsEqual(input.length, 3) ? input[2] : guard_exports.IsEqual(input.length, 4) ? guard_exports.IsEqual(input[2], "readonly") ? AddReadonlyDeferred(input[3]) : AddOptionalDeferred(input[3]) : Unreachable2();
}
function ElementReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[1]));
}
function ElementReadonlyMapping(input) {
  return AddReadonlyDeferred(input[1]);
}
function ElementOptionalMapping(input) {
  return AddOptionalDeferred(input[0]);
}
function ElementBaseMapping(input) {
  return input;
}
function ElementMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ElementListMapping(input) {
  return Delimited(input);
}
function _Tuple_Mapping(input) {
  return Tuple(input[1]);
}
function ParameterReadonlyOptionalMapping(input) {
  return AddReadonlyDeferred(AddOptionalDeferred(input[4]));
}
function ParameterReadonlyMapping(input) {
  return AddReadonlyDeferred(input[3]);
}
function ParameterOptionalMapping(input) {
  return AddOptionalDeferred(input[3]);
}
function ParameterTypeMapping(input) {
  return input[2];
}
function ParameterBaseMapping(input) {
  return input;
}
function ParameterMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? Rest(input[1]) : guard_exports.IsEqual(input.length, 1) ? input[0] : Unreachable2();
}
function ParameterListMapping(input) {
  return Delimited(input);
}
function _Function_Mapping(input) {
  return _Function_(input[1], input[4]);
}
function _Constructor_Mapping(input) {
  return Constructor(input[2], input[5]);
}
function ApplyReadonly(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveReadonlyDeferred(type) : guard_exports.IsEqual(state, "add") ? AddReadonlyDeferred(type) : type;
}
function MappedReadonlyMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function ApplyOptional(state, type) {
  return guard_exports.IsEqual(state, "remove") ? RemoveOptionalDeferred(type) : guard_exports.IsEqual(state, "add") ? AddOptionalDeferred(type) : type;
}
function MappedOptionalMapping(input) {
  return guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "-") ? "remove" : guard_exports.IsEqual(input.length, 2) && guard_exports.IsEqual(input[0], "+") ? "add" : guard_exports.IsEqual(input.length, 1) ? "add" : "none";
}
function MappedAsMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? [input[1]] : [];
}
function _Mapped_Mapping(input) {
  return guard_exports.IsArray(input[6]) && guard_exports.IsEqual(input[6].length, 1) ? MappedDeferred(Identifier(input[3]), input[5], input[6][0], ApplyReadonly(input[1], ApplyOptional(input[8], input[10]))) : MappedDeferred(Identifier(input[3]), input[5], Ref(input[3]), ApplyReadonly(input[1], ApplyOptional(input[8], input[10])));
}
function ReferenceMapping(input) {
  return Ref(input);
}
function WithBigIntMapping(input) {
  return BigInt(input);
}
function WithNumberMapping(input) {
  return parseFloat(input);
}
function WithBooleanMapping(input) {
  return guard_exports.IsEqual(input, "true");
}
function WithStringMapping(input) {
  return input;
}
function WithNullMapping(input) {
  return null;
}
function WithUndefinedMapping(input) {
  return void 0;
}
function WithPropertyMapping(input) {
  return { [input[0]]: input[2] };
}
function WithPropertyListMapping(input) {
  return Delimited(input);
}
function WithObjectMappingReduce(propertyList) {
  return propertyList.reduce((result, left) => {
    return memory_exports.Assign(result, left);
  }, {});
}
function WithObjectMapping(input) {
  return WithObjectMappingReduce(input[1]);
}
function WithElementListMapping(input) {
  return Delimited(input);
}
function WithArrayMapping(input) {
  return input[1];
}
function WithValueMapping(input) {
  return input;
}
function PatternBigIntMapping(input) {
  return BigInt2();
}
function PatternStringMapping(input) {
  return String2();
}
function PatternNumberMapping(input) {
  return Number2();
}
function PatternIntegerMapping(input) {
  return Integer();
}
function PatternNeverMapping(input) {
  return Never();
}
function PatternTextMapping(input) {
  return Literal(input);
}
function PatternBaseMapping(input) {
  return input;
}
function PatternGroupMapping(input) {
  return Union(input[1]);
}
function PatternUnionMapping(input) {
  return input.length === 3 ? [...input[0], ...input[2]] : input.length === 1 ? [...input[0]] : [];
}
function PatternTermMapping(input) {
  return [input[0], ...input[1]];
}
function PatternBodyMapping(input) {
  return input;
}
function PatternMapping(input) {
  return input[1];
}
function InterfaceDeclarationHeritageListMapping(input) {
  return Delimited(input);
}
function InterfaceDeclarationHeritageMapping(input) {
  return guard_exports.IsEqual(input.length, 2) ? input[1] : [];
}
function InterfaceDeclarationGenericMapping(input) {
  const parameters = input[2];
  const heritage = input[3];
  const [properties, patternProperties] = input[4];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: Generic(parameters, InterfaceDeferred(heritage, properties, options)) };
}
function InterfaceDeclarationMapping(input) {
  const heritage = input[2];
  const [properties, patternProperties] = input[3];
  const options = guard_exports.IsEqual(guard_exports.Keys(patternProperties).length, 0) ? {} : { patternProperties };
  return { [input[1]]: InterfaceDeferred(heritage, properties, options) };
}
function TypeAliasDeclarationGenericMapping(input) {
  return { [input[1]]: Generic(input[2], input[4]) };
}
function TypeAliasDeclarationMapping(input) {
  return { [input[1]]: input[3] };
}
function ExportKeywordMapping(input) {
  return null;
}
function ModuleDeclarationDelimiterMapping(input) {
  return input;
}
function ModuleDeclarationListMapping(input) {
  return PropertiesReduce(Delimited(input));
}
function ModuleDeclarationMapping(input) {
  return input[1];
}
function ModuleMapping(input) {
  const moduleDeclaration = input[0];
  const moduleDeclarationList = input[1];
  return ModuleDeferred(memory_exports.Assign(moduleDeclaration, moduleDeclarationList[0]));
}
function ScriptMapping(input) {
  return input;
}

// node_modules/typebox/build/type/script/token/internal/match.mjs
function IsMatch(value) {
  return IsEqual(value.length, 2);
}
function Match2(input, ok, fail) {
  return IsMatch(input) ? ok(input[0], input[1]) : fail();
}

// node_modules/typebox/build/type/script/token/internal/take.mjs
function TakeVariant(variant, input) {
  return IsEqual(input.indexOf(variant), 0) ? [variant, input.slice(variant.length)] : [];
}
function Take(variants, input) {
  for (let i = 0; i < variants.length; i++) {
    const result = TakeVariant(variants[i], input);
    if (IsMatch(result))
      return result;
  }
  return [];
}

// node_modules/typebox/build/type/script/token/internal/char.mjs
function Range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i));
}
var Alpha = [
  ...Range(97, 122),
  // Lowercase
  ...Range(65, 90)
  // Uppercase
];
var Zero = "0";
var NonZero = Range(49, 57);
var Digit = [Zero, ...NonZero];
var WhiteSpace = " ";
var NewLine = "\n";
var UnderScore = "_";
var Dot = ".";
var DollarSign = "$";
var Hyphen = "-";

// node_modules/typebox/build/type/script/token/internal/trim.mjs
var LineComment = "//";
var OpenComment = "/*";
var CloseComment = "*/";
function DiscardMultilineComment(input) {
  const index = input.indexOf(CloseComment);
  const result = IsEqual(index, -1) ? "" : input.slice(index + 2);
  return result;
}
function DiscardLineComment(input) {
  const index = input.indexOf(NewLine);
  const result = IsEqual(index, -1) ? "" : input.slice(index);
  return result;
}
function TrimStartUntilNewline(input) {
  return input.replace(/^[ \t\r\f\v]+/, "");
}
function TrimWhitespace(input) {
  const trimmed = TrimStartUntilNewline(input);
  return trimmed.startsWith(OpenComment) ? TrimWhitespace(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? TrimWhitespace(DiscardLineComment(trimmed.slice(2))) : trimmed;
}
function Trim(input) {
  const trimmed = input.trimStart();
  return trimmed.startsWith(OpenComment) ? Trim(DiscardMultilineComment(trimmed.slice(2))) : trimmed.startsWith(LineComment) ? Trim(DiscardLineComment(trimmed.slice(2))) : trimmed;
}

// node_modules/typebox/build/type/script/token/internal/optional.mjs
function Optional2(value, input) {
  return Match2(Take([value], input), (Optional4, Rest2) => [Optional4, Rest2], () => ["", input]);
}

// node_modules/typebox/build/type/script/token/internal/many.mjs
function IsDiscard(discard, input) {
  return discard.includes(input);
}
function Many(allowed, discard, input, result = "") {
  return Match2(Take(allowed, input), (Char, Rest2) => IsDiscard(discard, Char) ? Many(allowed, discard, Rest2, result) : Many(allowed, discard, Rest2, `${result}${Char}`), () => [result, input]);
}

// node_modules/typebox/build/type/script/token/unsigned_integer.mjs
function TakeNonZero(input) {
  return Take(NonZero, input);
}
var AllowedDigits = [...Digit, UnderScore];
function TakeDigits(input) {
  return Many(AllowedDigits, [UnderScore], input);
}
function TakeUnsignedInteger(input) {
  return Match2(Take([Zero], input), (Zero2, ZeroRest) => [Zero2, ZeroRest], () => Match2(
    TakeNonZero(input),
    (NonZero2, NonZeroRest) => Match2(TakeDigits(NonZeroRest), (Digits, DigitsRest) => [`${NonZero2}${Digits}`, DigitsRest], () => []),
    // fail: did not match Digits
    () => []
  ));
}
function UnsignedInteger(input) {
  return TakeUnsignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/integer.mjs
function TakeSign(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedInteger(input) {
  return Match2(
    TakeSign(input),
    (Sign, SignRest) => Match2(UnsignedInteger(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Integer2(input) {
  return TakeSignedInteger(Trim(input));
}

// node_modules/typebox/build/type/script/token/bigint.mjs
function TakeBigInt(input) {
  return Match2(
    Integer2(input),
    (Integer3, IntegerRest) => Match2(Take(["n"], IntegerRest), (_N, NRest) => [`${Integer3}`, NRest], () => []),
    // fail: did not match 'n'
    () => []
  );
}
function BigInt3(input) {
  return TakeBigInt(input);
}

// node_modules/typebox/build/type/script/token/const.mjs
function TakeConst(const_, input) {
  return Take([const_], input);
}
function Const(const_, input) {
  return IsEqual(const_, "") ? ["", input] : const_.startsWith(NewLine) ? TakeConst(const_, TrimWhitespace(input)) : const_.startsWith(WhiteSpace) ? TakeConst(const_, input) : TakeConst(const_, Trim(input));
}

// node_modules/typebox/build/type/script/token/ident.mjs
var Initial = [...Alpha, UnderScore, DollarSign];
function TakeInitial(input) {
  return Take(Initial, input);
}
var Remaining = [...Initial, ...Digit];
function TakeRemaining(input, result = "") {
  return Match2(Take(Remaining, input), (Remaining2, RemainingRest) => TakeRemaining(RemainingRest, `${result}${Remaining2}`), () => [result, input]);
}
function TakeIdent(input) {
  return Match2(
    TakeInitial(input),
    (Initial2, InitialRest) => Match2(TakeRemaining(InitialRest), (Remaining2, RemainingRest) => [`${Initial2}${Remaining2}`, RemainingRest], () => []),
    // fail: did not match Remaining
    () => []
  );
}
function Ident(input) {
  return TakeIdent(Trim(input));
}

// node_modules/typebox/build/type/script/token/unsigned_number.mjs
var AllowedDigits2 = [...Digit, UnderScore];
function IsLeadingDot(input) {
  return IsMatch(Take([Dot], input));
}
function TakeFractional(input) {
  return Match2(Many(AllowedDigits2, [UnderScore], input), (Digits, DigitsRest) => IsEqual(Digits, "") ? [] : [Digits, DigitsRest], () => []);
}
function LeadingDot(input) {
  return Match2(
    Take([Dot], input),
    (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`0${Dot2}${Fractional}`, FractionalRest], () => []),
    // fail: did not match Fractional
    () => []
  );
}
function LeadingInteger(input) {
  return Match2(
    UnsignedInteger(input),
    (Integer3, IntegerRest) => Match2(
      Take([Dot], IntegerRest),
      (Dot2, DotRest) => Match2(TakeFractional(DotRest), (Fractional, FractionalRest) => [`${Integer3}${Dot2}${Fractional}`, FractionalRest], () => [`${Integer3}`, DotRest]),
      // fail: did not match Fractional, use Integer
      () => [`${Integer3}`, IntegerRest]
    ),
    // fail: did not match Dot, use Integer
    () => []
  );
}
function TakeUnsignedNumber(input) {
  return IsLeadingDot(input) ? LeadingDot(input) : LeadingInteger(input);
}
function UnsignedNumber(input) {
  return TakeUnsignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/number.mjs
function TakeSign2(input) {
  return Optional2(Hyphen, input);
}
function TakeSignedNumber(input) {
  return Match2(
    TakeSign2(input),
    (Sign, SignRest) => Match2(UnsignedNumber(SignRest), (UnsignedInteger2, UnsignedIntegerRest) => [`${Sign}${UnsignedInteger2}`, UnsignedIntegerRest], () => []),
    // fail: did not match unsigned integer
    () => []
  );
}
function Number3(input) {
  return TakeSignedNumber(Trim(input));
}

// node_modules/typebox/build/type/script/token/until.mjs
function TakeOne(input) {
  const result = IsEqual(input, "") ? [] : [input.slice(0, 1), input.slice(1)];
  return result;
}
function IsInputMatchSentinal(end, input) {
  return ShiftLeft(end, (left, right) => input.startsWith(left) ? true : IsInputMatchSentinal(right, input), () => false);
}
function Until(end, input, result = "") {
  return Match2(
    TakeOne(input),
    (One, Rest2) => IsInputMatchSentinal(end, input) ? [result, input] : Until(end, Rest2, `${result}${One}`),
    () => []
  );
}

// node_modules/typebox/build/type/script/token/span.mjs
function MultiLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, Rest3) => [`${Until2}`, Rest3], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function SingleLine(start, end, input) {
  return Match2(
    Take([start], input),
    (_, Rest2) => Match2(
      Until([NewLine, end], Rest2),
      (Until2, UntilRest) => Match2(Take([end], UntilRest), (_2, EndRest) => [`${Until2}`, EndRest], () => []),
      // fail: did not match End
      () => []
    ),
    // fail: did not match Until
    () => []
  );
}
function Span(start, end, multiLine, input) {
  return multiLine ? MultiLine(start, end, Trim(input)) : SingleLine(start, end, Trim(input));
}

// node_modules/typebox/build/type/script/token/string.mjs
function TakeInitial2(quotes, input) {
  return Take(quotes, input);
}
function TakeSpan(quote, input) {
  return Span(quote, quote, false, input);
}
function TakeString(quotes, input) {
  return Match2(TakeInitial2(quotes, input), (Initial2, InitialRest) => TakeSpan(Initial2, `${Initial2}${InitialRest}`), () => []);
}
function String3(quotes, input) {
  return TakeString(quotes, Trim(input));
}

// node_modules/typebox/build/type/script/token/until_1.mjs
function Until_1(end, input) {
  return Match2(Until(end, input), (Until2, UntilRest) => IsEqual(Until2, "") ? [] : [Until2, UntilRest], () => []);
}

// node_modules/typebox/build/type/script/parser.mjs
var If = (result, left, right = () => []) => result.length === 2 ? left(result) : right();
var GenericParameterExtendsEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [GenericParameterExtendsEqualsMapping(_0), input2]);
var GenericParameterExtends = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("extends", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterExtendsMapping(_0), input2]);
var GenericParameterEquals = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParameterEqualsMapping(_0), input2]);
var GenericParameterIdentifier = (input) => If(Ident(input), ([_0, input2]) => [GenericParameterIdentifierMapping(_0), input2]);
var GenericParameter = (input) => If(If(GenericParameterExtendsEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterExtends(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterEquals(input), ([_0, input2]) => [_0, input2], () => If(GenericParameterIdentifier(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [GenericParameterMapping(_0), input2]);
var GenericParameterList_0 = (input, result = []) => If(If(GenericParameter(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericParameterList_0(input2, [...result, _0]), () => [result, input]);
var GenericParameterList = (input) => If(If(GenericParameterList_0(input), ([_0, input2]) => If(If(If(GenericParameter(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericParameterListMapping(_0), input2]);
var GenericParameters = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericParameterList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericParametersMapping(_0), input2]);
var GenericCallArgumentList_0 = (input, result = []) => If(If(Type(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => GenericCallArgumentList_0(input2, [...result, _0]), () => [result, input]);
var GenericCallArgumentList = (input) => If(If(GenericCallArgumentList_0(input), ([_0, input2]) => If(If(If(Type(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallArgumentListMapping(_0), input2]);
var GenericCallArguments = (input) => If(If(Const("<", input), ([_0, input2]) => If(GenericCallArgumentList(input2), ([_1, input3]) => If(Const(">", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericCallArgumentsMapping(_0), input2]);
var GenericCall = (input) => If(If(Ident(input), ([_0, input2]) => If(GenericCallArguments(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [GenericCallMapping(_0), input2]);
var OptionalSemiColon = (input) => If(If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalSemiColonMapping(_0), input2]);
var KeywordString = (input) => If(Const("string", input), ([_0, input2]) => [KeywordStringMapping(_0), input2]);
var KeywordNumber = (input) => If(Const("number", input), ([_0, input2]) => [KeywordNumberMapping(_0), input2]);
var KeywordBoolean = (input) => If(Const("boolean", input), ([_0, input2]) => [KeywordBooleanMapping(_0), input2]);
var KeywordUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [KeywordUndefinedMapping(_0), input2]);
var KeywordNull = (input) => If(Const("null", input), ([_0, input2]) => [KeywordNullMapping(_0), input2]);
var KeywordInteger = (input) => If(Const("integer", input), ([_0, input2]) => [KeywordIntegerMapping(_0), input2]);
var KeywordBigInt = (input) => If(Const("bigint", input), ([_0, input2]) => [KeywordBigIntMapping(_0), input2]);
var KeywordUnknown = (input) => If(Const("unknown", input), ([_0, input2]) => [KeywordUnknownMapping(_0), input2]);
var KeywordAny = (input) => If(Const("any", input), ([_0, input2]) => [KeywordAnyMapping(_0), input2]);
var KeywordObject = (input) => If(Const("object", input), ([_0, input2]) => [KeywordObjectMapping(_0), input2]);
var KeywordNever = (input) => If(Const("never", input), ([_0, input2]) => [KeywordNeverMapping(_0), input2]);
var KeywordSymbol = (input) => If(Const("symbol", input), ([_0, input2]) => [KeywordSymbolMapping(_0), input2]);
var KeywordVoid = (input) => If(Const("void", input), ([_0, input2]) => [KeywordVoidMapping(_0), input2]);
var KeywordThis = (input) => If(Const("this", input), ([_0, input2]) => [KeywordThisMapping(_0), input2]);
var TemplateInterpolate = (input) => If(If(Const("${", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateInterpolateMapping(_0), input2]);
var TemplateSpan = (input) => If(Until(["${", "`"], input), ([_0, input2]) => [TemplateSpanMapping(_0), input2]);
var TemplateBody = (input) => If(If(If(TemplateSpan(input), ([_0, input2]) => If(TemplateInterpolate(input2), ([_1, input3]) => If(TemplateBody(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(TemplateSpan(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [TemplateBodyMapping(_0), input2]);
var TemplateLiteralTypes = (input) => If(If(Const("`", input), ([_0, input2]) => If(TemplateBody(input2), ([_1, input3]) => If(Const("`", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [TemplateLiteralTypesMapping(_0), input2]);
var TemplateLiteral = (input) => If(TemplateLiteralTypes(input), ([_0, input2]) => [TemplateLiteralMapping(_0), input2]);
var Dependent2 = (input) => If(If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const("else", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If(If(Const("if", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("then", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [DependentMapping(_0), input2]);
var LiteralBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [LiteralBigIntMapping(_0), input2]);
var LiteralBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [LiteralBooleanMapping(_0), input2]);
var LiteralNumber = (input) => If(Number3(input), ([_0, input2]) => [LiteralNumberMapping(_0), input2]);
var LiteralString = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [LiteralStringMapping(_0), input2]);
var KeyOf = (input) => If(If(If(Const("keyof", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [KeyOfMapping(_0), input2]);
var IndexArray_0 = (input, result = []) => If(If(If(Const("[", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(Const("[", input), ([_0, input2]) => If(Const("]", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => IndexArray_0(input2, [...result, _0]), () => [result, input]);
var IndexArray = (input) => If(IndexArray_0(input), ([_0, input2]) => [IndexArrayMapping(_0), input2]);
var Extends2 = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => If(Const(":", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExtendsMapping(_0), input2]);
var Base = (input) => If(If(If(Const("(", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(KeywordString(input), ([_0, input2]) => [_0, input2], () => If(KeywordNumber(input), ([_0, input2]) => [_0, input2], () => If(KeywordBoolean(input), ([_0, input2]) => [_0, input2], () => If(KeywordUndefined(input), ([_0, input2]) => [_0, input2], () => If(KeywordNull(input), ([_0, input2]) => [_0, input2], () => If(KeywordInteger(input), ([_0, input2]) => [_0, input2], () => If(KeywordBigInt(input), ([_0, input2]) => [_0, input2], () => If(KeywordUnknown(input), ([_0, input2]) => [_0, input2], () => If(KeywordAny(input), ([_0, input2]) => [_0, input2], () => If(KeywordObject(input), ([_0, input2]) => [_0, input2], () => If(KeywordNever(input), ([_0, input2]) => [_0, input2], () => If(KeywordSymbol(input), ([_0, input2]) => [_0, input2], () => If(KeywordVoid(input), ([_0, input2]) => [_0, input2], () => If(KeywordThis(input), ([_0, input2]) => [_0, input2], () => If(LiteralBigInt(input), ([_0, input2]) => [_0, input2], () => If(LiteralBoolean(input), ([_0, input2]) => [_0, input2], () => If(LiteralNumber(input), ([_0, input2]) => [_0, input2], () => If(LiteralString(input), ([_0, input2]) => [_0, input2], () => If(TemplateLiteral(input), ([_0, input2]) => [_0, input2], () => If(Dependent2(input), ([_0, input2]) => [_0, input2], () => If(_Object_2(input), ([_0, input2]) => [_0, input2], () => If(_Tuple_(input), ([_0, input2]) => [_0, input2], () => If(_Constructor_(input), ([_0, input2]) => [_0, input2], () => If(_Function_2(input), ([_0, input2]) => [_0, input2], () => If(_Mapped_(input), ([_0, input2]) => [_0, input2], () => If(GenericCall(input), ([_0, input2]) => [_0, input2], () => If(Reference(input), ([_0, input2]) => [_0, input2], () => [])))))))))))))))))))))))))))), ([_0, input2]) => [BaseMapping(_0), input2]);
var With = (input) => If(If(If(Const("with", input), ([_0, input2]) => If(WithObject(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithMapping(_0), input2]);
var Factor = (input) => If(If(KeyOf(input), ([_0, input2]) => If(Base(input2), ([_1, input3]) => If(IndexArray(input3), ([_2, input4]) => If(Extends2(input4), ([_3, input5]) => If(With(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [FactorMapping(_0), input2]);
var ExprTermTail = (input) => If(If(If(Const("&", input), ([_0, input2]) => If(Factor(input2), ([_1, input3]) => If(ExprTermTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTermTailMapping(_0), input2]);
var ExprTerm = (input) => If(If(Factor(input), ([_0, input2]) => If(ExprTermTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprTermMapping(_0), input2]);
var ExprTail = (input) => If(If(If(Const("|", input), ([_0, input2]) => If(ExprTerm(input2), ([_1, input3]) => If(ExprTail(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExprTailMapping(_0), input2]);
var Expr = (input) => If(If(ExprTerm(input), ([_0, input2]) => If(ExprTail(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprMapping(_0), input2]);
var ExprReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprReadonlyMapping(_0), input2]);
var ExprPipe = (input) => If(If(Const("|", input), ([_0, input2]) => If(Expr(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ExprPipeMapping(_0), input2]);
var GenericType = (input) => If(If(GenericParameters(input), ([_0, input2]) => If(Const("=", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [GenericTypeMapping(_0), input2]);
var InferType = (input) => If(If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("extends", input3), ([_2, input4]) => If(Expr(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Const("infer", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InferTypeMapping(_0), input2]);
var Type = (input) => If(If(InferType(input), ([_0, input2]) => [_0, input2], () => If(ExprPipe(input), ([_0, input2]) => [_0, input2], () => If(ExprReadonly(input), ([_0, input2]) => [_0, input2], () => If(Expr(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [TypeMapping(_0), input2]);
var PropertyKeyNumber = (input) => If(Number3(input), ([_0, input2]) => [PropertyKeyNumberMapping(_0), input2]);
var PropertyKeyIdent = (input) => If(Ident(input), ([_0, input2]) => [PropertyKeyIdentMapping(_0), input2]);
var PropertyKeyQuoted = (input) => If(String3(["'", '"'], input), ([_0, input2]) => [PropertyKeyQuotedMapping(_0), input2]);
var PropertyKeyIndex = (input) => If(If(Const("[", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(If(KeywordInteger(input4), ([_02, input5]) => [_02, input5], () => If(KeywordNumber(input4), ([_02, input5]) => [_02, input5], () => If(KeywordString(input4), ([_02, input5]) => [_02, input5], () => If(KeywordSymbol(input4), ([_02, input5]) => [_02, input5], () => [])))), ([_3, input5]) => If(Const("]", input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyKeyIndexMapping(_0), input2]);
var PropertyKey = (input) => If(If(PropertyKeyNumber(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIdent(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyQuoted(input), ([_0, input2]) => [_0, input2], () => If(PropertyKeyIndex(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [PropertyKeyMapping(_0), input2]);
var Readonly2 = (input) => If(If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ReadonlyMapping(_0), input2]);
var Optional3 = (input) => If(If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [OptionalMapping(_0), input2]);
var Property = (input) => If(If(Readonly2(input), ([_0, input2]) => If(PropertyKey(input2), ([_1, input3]) => If(Optional3(input3), ([_2, input4]) => If(Const(":", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [PropertyMapping(_0), input2]);
var PropertyDelimiter = (input) => If(If(If(Const(",", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(",", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [PropertyDelimiterMapping(_0), input2]);
var PropertyList_0 = (input, result = []) => If(If(Property(input), ([_0, input2]) => If(PropertyDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => PropertyList_0(input2, [...result, _0]), () => [result, input]);
var PropertyList = (input) => If(If(PropertyList_0(input), ([_0, input2]) => If(If(If(Property(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PropertyListMapping(_0), input2]);
var Properties = (input) => If(If(Const("{", input), ([_0, input2]) => If(PropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PropertiesMapping(_0), input2]);
var _Object_2 = (input) => If(Properties(input), ([_0, input2]) => [_Object_Mapping(_0), input2]);
var ElementNamed = (input) => If(If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [_0, input2], () => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ElementNamedMapping(_0), input2]);
var ElementReadonlyOptional = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => If(Const("?", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ElementReadonlyOptionalMapping(_0), input2]);
var ElementReadonly = (input) => If(If(Const("readonly", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementReadonlyMapping(_0), input2]);
var ElementOptional = (input) => If(If(Type(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementOptionalMapping(_0), input2]);
var ElementBase = (input) => If(If(ElementNamed(input), ([_0, input2]) => [_0, input2], () => If(ElementReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ElementReadonly(input), ([_0, input2]) => [_0, input2], () => If(ElementOptional(input), ([_0, input2]) => [_0, input2], () => If(Type(input), ([_0, input2]) => [_0, input2], () => []))))), ([_0, input2]) => [ElementBaseMapping(_0), input2]);
var Element = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ElementBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ElementBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ElementMapping(_0), input2]);
var ElementList_0 = (input, result = []) => If(If(Element(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ElementList_0(input2, [...result, _0]), () => [result, input]);
var ElementList = (input) => If(If(ElementList_0(input), ([_0, input2]) => If(If(If(Element(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ElementListMapping(_0), input2]);
var _Tuple_ = (input) => If(If(Const("[", input), ([_0, input2]) => If(ElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_Tuple_Mapping(_0), input2]);
var ParameterReadonlyOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Const("readonly", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [ParameterReadonlyOptionalMapping(_0), input2]);
var ParameterReadonly = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Const("readonly", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterReadonlyMapping(_0), input2]);
var ParameterOptional = (input) => If(If(Ident(input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => If(Const(":", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [ParameterOptionalMapping(_0), input2]);
var ParameterType = (input) => If(If(Ident(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(Type(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ParameterTypeMapping(_0), input2]);
var ParameterBase = (input) => If(If(ParameterReadonlyOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterReadonly(input), ([_0, input2]) => [_0, input2], () => If(ParameterOptional(input), ([_0, input2]) => [_0, input2], () => If(ParameterType(input), ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [ParameterBaseMapping(_0), input2]);
var Parameter2 = (input) => If(If(If(Const("...", input), ([_0, input2]) => If(ParameterBase(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(ParameterBase(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ParameterMapping(_0), input2]);
var ParameterList_0 = (input, result = []) => If(If(Parameter2(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ParameterList_0(input2, [...result, _0]), () => [result, input]);
var ParameterList = (input) => If(If(ParameterList_0(input), ([_0, input2]) => If(If(If(Parameter2(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ParameterListMapping(_0), input2]);
var _Function_2 = (input) => If(If(Const("(", input), ([_0, input2]) => If(ParameterList(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => If(Const("=>", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [_Function_Mapping(_0), input2]);
var _Constructor_ = (input) => If(If(Const("new", input), ([_0, input2]) => If(Const("(", input2), ([_1, input3]) => If(ParameterList(input3), ([_2, input4]) => If(Const(")", input4), ([_3, input5]) => If(Const("=>", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => [[_0, _1, _2, _3, _4, _5], input7])))))), ([_0, input2]) => [_Constructor_Mapping(_0), input2]);
var MappedReadonly = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("readonly", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("readonly", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedReadonlyMapping(_0), input2]);
var MappedOptional = (input) => If(If(If(Const("+", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("-", input), ([_0, input2]) => If(Const("?", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const("?", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])))), ([_0, input2]) => [MappedOptionalMapping(_0), input2]);
var MappedAs = (input) => If(If(If(Const("as", input), ([_0, input2]) => If(Type(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [MappedAsMapping(_0), input2]);
var _Mapped_ = (input) => If(If(Const("{", input), ([_0, input2]) => If(MappedReadonly(input2), ([_1, input3]) => If(Const("[", input3), ([_2, input4]) => If(Ident(input4), ([_3, input5]) => If(Const("in", input5), ([_4, input6]) => If(Type(input6), ([_5, input7]) => If(MappedAs(input7), ([_6, input8]) => If(Const("]", input8), ([_7, input9]) => If(MappedOptional(input9), ([_8, input10]) => If(Const(":", input10), ([_9, input11]) => If(Type(input11), ([_10, input12]) => If(OptionalSemiColon(input12), ([_11, input13]) => If(Const("}", input13), ([_12, input14]) => [[_0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12], input14]))))))))))))), ([_0, input2]) => [_Mapped_Mapping(_0), input2]);
var Reference = (input) => If(Ident(input), ([_0, input2]) => [ReferenceMapping(_0), input2]);
var WithBigInt = (input) => If(BigInt3(input), ([_0, input2]) => [WithBigIntMapping(_0), input2]);
var WithNumber = (input) => If(Number3(input), ([_0, input2]) => [WithNumberMapping(_0), input2]);
var WithBoolean = (input) => If(If(Const("true", input), ([_0, input2]) => [_0, input2], () => If(Const("false", input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [WithBooleanMapping(_0), input2]);
var WithString = (input) => If(String3(['"', "'"], input), ([_0, input2]) => [WithStringMapping(_0), input2]);
var WithNull = (input) => If(Const("null", input), ([_0, input2]) => [WithNullMapping(_0), input2]);
var WithUndefined = (input) => If(Const("undefined", input), ([_0, input2]) => [WithUndefinedMapping(_0), input2]);
var WithProperty = (input) => If(If(PropertyKey(input), ([_0, input2]) => If(Const(":", input2), ([_1, input3]) => If(WithValue(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithPropertyMapping(_0), input2]);
var WithPropertyList_0 = (input, result = []) => If(If(WithProperty(input), ([_0, input2]) => If(PropertyDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithPropertyList_0(input2, [...result, _0]), () => [result, input]);
var WithPropertyList = (input) => If(If(WithPropertyList_0(input), ([_0, input2]) => If(If(If(WithProperty(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [WithPropertyListMapping(_0), input2]);
var WithObject = (input) => If(If(Const("{", input), ([_0, input2]) => If(WithPropertyList(input2), ([_1, input3]) => If(Const("}", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithObjectMapping(_0), input2]);
var WithElementList_0 = (input, result = []) => If(If(WithValue(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => WithElementList_0(input2, [...result, _0]), () => [result, input]);
var WithElementList = (input) => If(If(WithElementList_0(input), ([_0, input2]) => If(If(If(WithValue(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [WithElementListMapping(_0), input2]);
var WithArray = (input) => If(If(Const("[", input), ([_0, input2]) => If(WithElementList(input2), ([_1, input3]) => If(Const("]", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [WithArrayMapping(_0), input2]);
var WithValue = (input) => If(If(WithBigInt(input), ([_0, input2]) => [_0, input2], () => If(WithNumber(input), ([_0, input2]) => [_0, input2], () => If(WithBoolean(input), ([_0, input2]) => [_0, input2], () => If(WithString(input), ([_0, input2]) => [_0, input2], () => If(WithNull(input), ([_0, input2]) => [_0, input2], () => If(WithUndefined(input), ([_0, input2]) => [_0, input2], () => If(WithObject(input), ([_0, input2]) => [_0, input2], () => If(WithArray(input), ([_0, input2]) => [_0, input2], () => [])))))))), ([_0, input2]) => [WithValueMapping(_0), input2]);
var PatternBigInt = (input) => If(Const("-?(?:0|[1-9][0-9]*)n", input), ([_0, input2]) => [PatternBigIntMapping(_0), input2]);
var PatternString = (input) => If(Const(".*", input), ([_0, input2]) => [PatternStringMapping(_0), input2]);
var PatternNumber = (input) => If(Const("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", input), ([_0, input2]) => [PatternNumberMapping(_0), input2]);
var PatternInteger = (input) => If(Const("-?(?:0|[1-9][0-9]*)", input), ([_0, input2]) => [PatternIntegerMapping(_0), input2]);
var PatternNever = (input) => If(Const("(?!)", input), ([_0, input2]) => [PatternNeverMapping(_0), input2]);
var PatternText = (input) => If(Until_1(["-?(?:0|[1-9][0-9]*)n", ".*", "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?", "-?(?:0|[1-9][0-9]*)", "(?!)", "(", ")", "$", "|"], input), ([_0, input2]) => [PatternTextMapping(_0), input2]);
var PatternBase = (input) => If(If(PatternBigInt(input), ([_0, input2]) => [_0, input2], () => If(PatternString(input), ([_0, input2]) => [_0, input2], () => If(PatternNumber(input), ([_0, input2]) => [_0, input2], () => If(PatternInteger(input), ([_0, input2]) => [_0, input2], () => If(PatternNever(input), ([_0, input2]) => [_0, input2], () => If(PatternGroup(input), ([_0, input2]) => [_0, input2], () => If(PatternText(input), ([_0, input2]) => [_0, input2], () => []))))))), ([_0, input2]) => [PatternBaseMapping(_0), input2]);
var PatternGroup = (input) => If(If(Const("(", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const(")", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternGroupMapping(_0), input2]);
var PatternUnion = (input) => If(If(If(PatternTerm(input), ([_0, input2]) => If(Const("|", input2), ([_1, input3]) => If(PatternUnion(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [_0, input2], () => If(If(PatternTerm(input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [PatternUnionMapping(_0), input2]);
var PatternTerm = (input) => If(If(PatternBase(input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [PatternTermMapping(_0), input2]);
var PatternBody = (input) => If(If(PatternUnion(input), ([_0, input2]) => [_0, input2], () => If(PatternTerm(input), ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [PatternBodyMapping(_0), input2]);
var Pattern = (input) => If(If(Const("^", input), ([_0, input2]) => If(PatternBody(input2), ([_1, input3]) => If(Const("$", input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [PatternMapping(_0), input2]);
var InterfaceDeclarationHeritageList_0 = (input, result = []) => If(If(Type(input), ([_0, input2]) => If(Const(",", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => InterfaceDeclarationHeritageList_0(input2, [...result, _0]), () => [result, input]);
var InterfaceDeclarationHeritageList = (input) => If(If(InterfaceDeclarationHeritageList_0(input), ([_0, input2]) => If(If(If(Type(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [InterfaceDeclarationHeritageListMapping(_0), input2]);
var InterfaceDeclarationHeritage = (input) => If(If(If(Const("extends", input), ([_0, input2]) => If(InterfaceDeclarationHeritageList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [InterfaceDeclarationHeritageMapping(_0), input2]);
var InterfaceDeclarationGeneric = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(InterfaceDeclarationHeritage(input4), ([_3, input5]) => If(Properties(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [InterfaceDeclarationGenericMapping(_0), input2]);
var InterfaceDeclaration = (input) => If(If(Const("interface", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(InterfaceDeclarationHeritage(input3), ([_2, input4]) => If(Properties(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [InterfaceDeclarationMapping(_0), input2]);
var TypeAliasDeclarationGeneric = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(GenericParameters(input3), ([_2, input4]) => If(Const("=", input4), ([_3, input5]) => If(Type(input5), ([_4, input6]) => [[_0, _1, _2, _3, _4], input6]))))), ([_0, input2]) => [TypeAliasDeclarationGenericMapping(_0), input2]);
var TypeAliasDeclaration = (input) => If(If(Const("type", input), ([_0, input2]) => If(Ident(input2), ([_1, input3]) => If(Const("=", input3), ([_2, input4]) => If(Type(input4), ([_3, input5]) => [[_0, _1, _2, _3], input5])))), ([_0, input2]) => [TypeAliasDeclarationMapping(_0), input2]);
var ExportKeyword = (input) => If(If(If(Const("export", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If([[], input], ([_0, input2]) => [_0, input2], () => [])), ([_0, input2]) => [ExportKeywordMapping(_0), input2]);
var ModuleDeclarationDelimiter = (input) => If(If(If(Const(";", input), ([_0, input2]) => If(Const("\n", input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [_0, input2], () => If(If(Const(";", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => If(If(Const("\n", input), ([_0, input2]) => [[_0], input2]), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ModuleDeclarationDelimiterMapping(_0), input2]);
var ModuleDeclarationList_0 = (input, result = []) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationDelimiter(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => ModuleDeclarationList_0(input2, [...result, _0]), () => [result, input]);
var ModuleDeclarationList = (input) => If(If(ModuleDeclarationList_0(input), ([_0, input2]) => If(If(If(ModuleDeclaration(input2), ([_02, input3]) => [[_02], input3]), ([_02, input3]) => [_02, input3], () => If([[], input2], ([_02, input3]) => [_02, input3], () => [])), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleDeclarationListMapping(_0), input2]);
var ModuleDeclaration = (input) => If(If(ExportKeyword(input), ([_0, input2]) => If(If(InterfaceDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(InterfaceDeclaration(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclarationGeneric(input2), ([_02, input3]) => [_02, input3], () => If(TypeAliasDeclaration(input2), ([_02, input3]) => [_02, input3], () => [])))), ([_1, input3]) => If(OptionalSemiColon(input3), ([_2, input4]) => [[_0, _1, _2], input4]))), ([_0, input2]) => [ModuleDeclarationMapping(_0), input2]);
var Module = (input) => If(If(ModuleDeclaration(input), ([_0, input2]) => If(ModuleDeclarationList(input2), ([_1, input3]) => [[_0, _1], input3])), ([_0, input2]) => [ModuleMapping(_0), input2]);
var Script = (input) => If(If(Module(input), ([_0, input2]) => [_0, input2], () => If(GenericType(input), ([_0, input2]) => [_0, input2], () => If(Type(input), ([_0, input2]) => [_0, input2], () => []))), ([_0, input2]) => [ScriptMapping(_0), input2]);

// node_modules/typebox/build/type/engine/patterns/template.mjs
function ParseTemplateIntoTypes(template) {
  const parsed = TemplateLiteralTypes(`\`${template}\``);
  const result = guard_exports.IsEqual(parsed.length, 2) ? parsed[0] : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/encode.mjs
function JoinString(input) {
  return input.join("|");
}
function UnwrapTemplateLiteralPattern(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function EncodeLiteral(value, right, pattern) {
  return EncodeTypes(right, `${pattern}${value}`);
}
function EncodeBigInt(right, pattern) {
  return EncodeTypes(right, `${pattern}${BigIntPattern}`);
}
function EncodeInteger(right, pattern) {
  return EncodeTypes(right, `${pattern}${IntegerPattern}`);
}
function EncodeNumber(right, pattern) {
  return EncodeTypes(right, `${pattern}${NumberPattern}`);
}
function EncodeBoolean(right, pattern) {
  return EncodeType(Union([Literal("false"), Literal("true")]), right, pattern);
}
function EncodeString(right, pattern) {
  return EncodeTypes(right, `${pattern}${StringPattern}`);
}
function EncodeTemplateLiteral(templatePattern, right, pattern) {
  return EncodeTypes(right, `${pattern}${UnwrapTemplateLiteralPattern(templatePattern)}`);
}
function EncodeTemplateLiteralDeferred(types, right, pattern) {
  const templateLiteral = TemplateLiteralAction(types, {});
  const result = EncodeType(templateLiteral, right, pattern);
  return result;
}
function EncodeEnum(values, right, pattern) {
  const evaluated = EvaluateEnum(values);
  return EncodeType(evaluated, right, pattern);
}
function EncodeUnion(types, right, pattern, result = []) {
  return guard_exports.ShiftLeft(types, (head, tail) => EncodeUnion(tail, right, pattern, [...result, EncodeType(head, [], "")]), () => EncodeTypes(right, `${pattern}(${JoinString(result)})`));
}
function EncodeType(type, right, pattern) {
  return IsEnum(type) ? EncodeEnum(type.enum, right, pattern) : IsInteger2(type) ? EncodeInteger(right, pattern) : IsLiteral(type) ? EncodeLiteral(type.const, right, pattern) : IsBigInt2(type) ? EncodeBigInt(right, pattern) : IsBoolean3(type) ? EncodeBoolean(right, pattern) : IsNumber3(type) ? EncodeNumber(right, pattern) : IsString3(type) ? EncodeString(right, pattern) : IsTemplateLiteral(type) ? EncodeTemplateLiteral(type.pattern, right, pattern) : IsTemplateLiteralDeferred(type) ? EncodeTemplateLiteralDeferred(type.parameters[0], right, pattern) : IsUnion(type) ? EncodeUnion(type.anyOf, right, pattern) : NeverPattern;
}
function EncodeTypes(types, pattern) {
  return guard_exports.ShiftLeft(types, (left, right) => EncodeType(left, right, pattern), () => pattern);
}
function EncodePattern(types) {
  const encoded = EncodeTypes(types, "");
  const result = `^${encoded}$`;
  return result;
}
function TemplateLiteralEncode(types) {
  const pattern = EncodePattern(types);
  const result = TemplateLiteralCreate(pattern);
  return result;
}

// node_modules/typebox/build/type/engine/template_literal/instantiate.mjs
function TemplateLiteralAction(types, options) {
  const result = CanInstantiate(types) ? memory_exports.Update(TemplateLiteralEncode(types), {}, options) : TemplateLiteralDeferred(types, options);
  return result;
}
function TemplateLiteralInstantiate(context, state, types, options) {
  const instantiatedTypes = InstantiateTypes(context, state, types);
  return TemplateLiteralAction(instantiatedTypes, options);
}

// node_modules/typebox/build/type/types/template_literal.mjs
function TemplateLiteralDeferred(types, options = {}) {
  return Deferred("TemplateLiteral", [types], options);
}
function IsTemplateLiteralDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "TemplateLiteral");
}
function TemplateLiteralFromTypes(types) {
  return TemplateLiteralAction(types, {});
}
function TemplateLiteralFromString(template) {
  const types = ParseTemplateIntoTypes(template);
  return TemplateLiteralFromTypes(types);
}
function TemplateLiteral2(input, options = {}) {
  const type = guard_exports.IsString(input) ? TemplateLiteralFromString(input) : TemplateLiteralFromTypes(input);
  return memory_exports.Update(type, {}, options);
}
function IsTemplateLiteral(value) {
  return IsKind(value, "TemplateLiteral");
}

// node_modules/typebox/build/type/extends/result.mjs
var result_exports = {};
__export(result_exports, {
  ExtendsFalse: () => ExtendsFalse,
  ExtendsTrue: () => ExtendsTrue,
  ExtendsUnion: () => ExtendsUnion,
  IsExtendsFalse: () => IsExtendsFalse,
  IsExtendsTrue: () => IsExtendsTrue,
  IsExtendsTrueLike: () => IsExtendsTrueLike,
  IsExtendsUnion: () => IsExtendsUnion,
  Match: () => Match3
});
function ExtendsUnion(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsUnion" }, { inferred });
}
function IsExtendsUnion(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsUnion") && guard_exports.IsObject(value.inferred);
}
function ExtendsTrue(inferred) {
  return memory_exports.Create({ ["~kind"]: "ExtendsTrue" }, { inferred });
}
function IsExtendsTrue(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "inferred") && guard_exports.IsEqual(value["~kind"], "ExtendsTrue") && guard_exports.IsObject(value.inferred);
}
function ExtendsFalse() {
  return memory_exports.Create({ ["~kind"]: "ExtendsFalse" }, {});
}
function IsExtendsFalse(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.IsEqual(value["~kind"], "ExtendsFalse");
}
function IsExtendsTrueLike(value) {
  return IsExtendsUnion(value) || IsExtendsTrue(value);
}
function Match3(result, true_, false_) {
  return IsExtendsTrueLike(result) ? true_(result.inferred) : false_();
}

// node_modules/typebox/build/type/extends/extends_right.mjs
function ExtendsRightInfer(inferred, name, left, right) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => ExtendsTrue(memory_exports.Assign(memory_exports.Assign(inferred, checkInferred), { [name]: left })), () => ExtendsFalse());
}
function ExtendsRightAny(inferred, _left) {
  return ExtendsTrue(inferred);
}
function ExtendsRightDependent(inferred, left, if_, then_, else_) {
  return Match3(ExtendsLeft(inferred, left, if_), (inferred2) => Match3(ExtendsLeft(inferred2, left, then_), (inferred3) => ExtendsTrue(inferred3), () => ExtendsFalse()), () => Match3(ExtendsLeft(inferred, left, else_), (inferred2) => ExtendsTrue(inferred2), () => ExtendsFalse()));
}
function ExtendsRightEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightIntersect(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsRightIntersect(inferred2, left, tail), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsRightTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(right);
  return ExtendsLeft(inferred, left, evaluated);
}
function ExtendsRightUnion(inferred, left, right) {
  return guard_exports.ShiftLeft(right, (head, tail) => Match3(ExtendsLeft(inferred, left, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsRightUnion(inferred, left, tail)), () => ExtendsFalse());
}
function ExtendsRight(inferred, left, right) {
  return IsAny(right) ? ExtendsRightAny(inferred, left) : IsDependent(right) ? ExtendsRightDependent(inferred, left, right.if, right.then, right.else) : IsEnum(right) ? ExtendsRightEnum(inferred, left, right.enum) : IsInfer(right) ? ExtendsRightInfer(inferred, right.name, left, right.extends) : IsIntersect(right) ? ExtendsRightIntersect(inferred, left, right.allOf) : IsTemplateLiteral(right) ? ExtendsRightTemplateLiteral(inferred, left, right.pattern) : IsUnion(right) ? ExtendsRightUnion(inferred, left, right.anyOf) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/any.mjs
function ExtendsAny(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsUnion(inferred);
}

// node_modules/typebox/build/type/extends/array.mjs
function ExtendsImmutable(left, right) {
  const isImmutableLeft = IsImmutable(left);
  const isImmutableRight = IsImmutable(right);
  return isImmutableLeft && isImmutableRight ? true : !isImmutableLeft && isImmutableRight ? true : isImmutableLeft && !isImmutableRight ? false : true;
}
function ExtendsArray(inferred, arrayLeft, left, right) {
  return IsArray2(right) ? ExtendsImmutable(arrayLeft, right) ? ExtendsLeft(inferred, left, right.items) : ExtendsFalse() : ExtendsRight(inferred, arrayLeft, right);
}

// node_modules/typebox/build/type/extends/bigint.mjs
function ExtendsBigInt(inferred, left, right) {
  return IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/boolean.mjs
function ExtendsBoolean(inferred, left, right) {
  return IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/parameters.mjs
function ParameterCompare(inferred, left, leftRest, right, rightRest) {
  const checkLeft = IsInfer(right) ? left : right;
  const checkRight = IsInfer(right) ? right : left;
  const isLeftOptional = IsOptional(left);
  const isRightOptional = IsOptional(right);
  return !isLeftOptional && isRightOptional ? ExtendsFalse() : Match3(ExtendsLeft(inferred, checkLeft, checkRight), (inferred2) => ExtendsParameters(inferred2, leftRest, rightRest), () => ExtendsFalse());
}
function ParameterRight(inferred, left, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ParameterCompare(inferred, left, leftRest, head, tail), () => IsOptional(left) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function ParametersLeft(inferred, left, rightRest) {
  return guard_exports.ShiftLeft(left, (head, tail) => ParameterRight(inferred, head, tail, rightRest), () => ExtendsTrue(inferred));
}
function ExtendsParameters(inferred, left, right) {
  return ParametersLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/return_type.mjs
function ExtendsReturnType(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsLeft(inferred, left, right);
}

// node_modules/typebox/build/type/extends/constructor.mjs
function ExtendsConstructor(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsConstructor2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["instanceType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/dependent.mjs
function ExtendsDependent(inferred, if_, then_, else_, right) {
  return Match3(ExtendsLeft(inferred, if_, right), () => ExtendsLeft(inferred, then_, right), () => ExtendsLeft(inferred, else_, right));
}

// node_modules/typebox/build/type/extends/enum.mjs
function ExtendsEnum(inferred, left, right) {
  const evaluated = EvaluateEnum(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/function.mjs
function ExtendsFunction(inferred, parameters, returnType, right) {
  return IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : IsFunction2(right) ? Match3(ExtendsParameters(inferred, parameters, right["parameters"]), (inferred2) => ExtendsReturnType(inferred2, returnType, right["returnType"]), () => ExtendsFalse()) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/integer.mjs
function ExtendsInteger(inferred, left, right) {
  return IsInteger2(right) ? ExtendsTrue(inferred) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/intersect.mjs
function ExtendsIntersect(inferred, left, right) {
  const evaluated = EvaluateIntersect(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/literal.mjs
function ExtendsLiteralValue(inferred, left, right) {
  return left === right ? ExtendsTrue(inferred) : ExtendsFalse();
}
function ExtendsLiteralBigInt(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBigInt2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralBoolean(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsBoolean3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralNumber(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteralString(inferred, left, right) {
  return IsLiteral(right) ? ExtendsLiteralValue(inferred, left, right.const) : IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, Literal(left), right);
}
function ExtendsLiteral(inferred, left, right) {
  return guard_exports.IsBigInt(left.const) ? ExtendsLiteralBigInt(inferred, left.const, right) : guard_exports.IsBoolean(left.const) ? ExtendsLiteralBoolean(inferred, left.const, right) : guard_exports.IsNumber(left.const) ? ExtendsLiteralNumber(inferred, left.const, right) : guard_exports.IsString(left.const) ? ExtendsLiteralString(inferred, left.const, right) : Unreachable();
}

// node_modules/typebox/build/type/extends/never.mjs
function ExtendsNever(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : ExtendsTrue(inferred);
}

// node_modules/typebox/build/type/extends/null.mjs
function ExtendsNull(inferred, left, right) {
  return IsNull2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/number.mjs
function ExtendsNumber(inferred, left, right) {
  return IsNumber3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/object.mjs
function ExtendsPropertyOptional(inferred, left, right) {
  return IsOptional(left) ? IsOptional(right) ? ExtendsTrue(inferred) : ExtendsFalse() : ExtendsTrue(inferred);
}
function ExtendsProperty(inferred, left, right) {
  return (
    // Right TInfer<TNever> is TExtendsFalse
    IsInfer(right) && IsNever(right.extends) ? ExtendsFalse() : Match3(ExtendsLeft(inferred, left, right), (inferred2) => ExtendsPropertyOptional(inferred2, left, right), () => ExtendsFalse())
  );
}
function ExtractInferredProperties(keys, properties) {
  return keys.reduce((result, key) => {
    return key in properties ? IsExtendsTrueLike(properties[key]) ? { ...result, ...properties[key].inferred } : Unreachable() : Unreachable();
  }, {});
}
function ExtendsPropertiesComparer(inferred, left, right) {
  const properties = {};
  for (const rightKey of guard_exports.Keys(right)) {
    properties[rightKey] = rightKey in left ? ExtendsProperty({}, left[rightKey], right[rightKey]) : IsOptional(right[rightKey]) ? IsInfer(right[rightKey]) ? ExtendsTrue(memory_exports.Assign(inferred, { [right[rightKey].name]: right[rightKey].extends })) : ExtendsTrue(inferred) : ExtendsFalse();
  }
  const checked = guard_exports.Values(properties).every((result) => IsExtendsTrueLike(result));
  const extracted = checked ? ExtractInferredProperties(guard_exports.Keys(properties), properties) : {};
  return checked ? ExtendsTrue(extracted) : ExtendsFalse();
}
function ExtendsProperties(inferred, left, right) {
  const compared = ExtendsPropertiesComparer(inferred, left, right);
  return IsExtendsTrueLike(compared) ? ExtendsTrue(memory_exports.Assign(inferred, compared.inferred)) : ExtendsFalse();
}
function ExtendsObjectToObject(inferred, left, right) {
  return ExtendsProperties(inferred, left, right);
}
function RecordMergeInferred(left, right) {
  return guard_exports.Keys(right).reduce((result, key) => {
    return {
      ...result,
      [key]: guard_exports.HasPropertyKey(left, key) ? IsUnion(result[key]) ? Union([...result[key].anyOf, right[key]]) : Union([left[key], right[key]]) : right[key]
    };
  }, left);
}
function ExtendsRecordComparer(properties, keys, type, result) {
  return guard_exports.ShiftLeft(keys, (left, right) => Match3(ExtendsLeft({}, properties[left], type), (inferred) => ExtendsRecordComparer(properties, right, type, RecordMergeInferred(result, inferred)), () => ExtendsFalse()), () => ExtendsTrue(result));
}
function ExtendsObjectToRecord(inferred, properties, _pattern, value) {
  const keys = guard_exports.Keys(properties);
  const result = ExtendsRecordComparer(properties, keys, value, inferred);
  return result;
}
function ExtendsObject(inferred, left, right) {
  return IsRecord(right) ? ExtendsObjectToRecord(inferred, left, RecordPattern(right), RecordValue(right)) : IsObject2(right) ? ExtendsObjectToObject(inferred, left, right.properties) : ExtendsRight(inferred, _Object_(left), right);
}

// node_modules/typebox/build/type/extends/record.mjs
function FromObject3(inferred, properties) {
  return guard_exports.IsEqual(guard_exports.Keys(properties).length, 0) ? ExtendsTrue(inferred) : ExtendsFalse();
}
function FromRecord(inferred, _leftKey, leftValue, _rightKey, rightValue) {
  return ExtendsLeft(inferred, leftValue, rightValue);
}
function ExtendsRecord(inferred, leftPattern, leftValue, right) {
  return IsRecord(right) ? FromRecord(inferred, RecordPatternToType(leftPattern), leftValue, RecordPatternToType(RecordPattern(right)), RecordValue(right)) : IsObject2(right) ? FromObject3(inferred, right.properties) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/string.mjs
function ExtendsString(inferred, left, right) {
  return IsString3(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/symbol.mjs
function ExtendsSymbol(inferred, left, right) {
  return IsSymbol2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/template_literal.mjs
function ExtendsTemplateLiteral(inferred, left, right) {
  const evaluated = EvaluateTemplateLiteral(left);
  return ExtendsLeft(inferred, evaluated, right);
}

// node_modules/typebox/build/type/extends/inference.mjs
function Inferrable(name, type) {
  return memory_exports.Create({ "~kind": "Inferrable" }, { name, type }, {});
}
function IsInferable(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "~kind") && guard_exports.HasPropertyKey(value, "name") && guard_exports.HasPropertyKey(value, "type") && guard_exports.IsEqual(value["~kind"], "Inferrable") && guard_exports.IsString(value.name) && guard_exports.IsObject(value.type);
}
function TryRestInferable(type) {
  return IsRest(type) ? IsInfer(type.items) ? IsArray2(type.items.extends) ? Inferrable(type.items.name, type.items.extends.items) : IsUnknown(type.items.extends) ? Inferrable(type.items.name, type.items.extends) : void 0 : Unreachable() : void 0;
}
function TryInferable(type) {
  return IsInfer(type) ? Inferrable(type.name, type.extends) : void 0;
}
function TryInferResults(rest, right, result = []) {
  return guard_exports.ShiftLeft(rest, (head, tail) => Match3(ExtendsLeft({}, head, right), () => TryInferResults(tail, right, [...result, head]), () => void 0), () => result);
}
function InferTupleResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Tuple(results) })) : ExtendsFalse();
}
function InferUnionResult(inferred, name, left, right) {
  const results = TryInferResults(left, right);
  return guard_exports.IsArray(results) ? ExtendsTrue(memory_exports.Assign(inferred, { [name]: Union(results) })) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/tuple.mjs
function Reverse(types) {
  return [...types].reverse();
}
function ApplyReverse(types, reversed) {
  return reversed ? Reverse(types) : types;
}
function Reversed(types) {
  const first = types.length > 0 ? types[0] : void 0;
  const inferrable = IsSchema(first) ? TryRestInferable(first) : void 0;
  return IsSchema(inferrable);
}
function ElementsCompare(inferred, reversed, left, leftRest, right, rightRest) {
  return Match3(ExtendsLeft(inferred, left, right), (checkInferred) => Elements(checkInferred, reversed, leftRest, rightRest), () => ExtendsFalse());
}
function ElementsLeft(inferred, reversed, leftRest, right, rightRest) {
  const inferable = TryRestInferable(right);
  return (
    // Rest Inferrable Right Means we delegate to TInferTupleResult to Generate a Result
    IsInferable(inferable) ? InferTupleResult(inferred, inferable["name"], ApplyReverse(leftRest, reversed), inferable["type"]) : guard_exports.ShiftLeft(leftRest, (head, tail) => ElementsCompare(inferred, reversed, head, tail, right, rightRest), () => ExtendsFalse())
  );
}
function ElementsRight(inferred, reversed, leftRest, rightRest) {
  return guard_exports.ShiftLeft(rightRest, (head, tail) => ElementsLeft(inferred, reversed, leftRest, head, tail), () => guard_exports.IsEqual(leftRest.length, 0) ? ExtendsTrue(inferred) : ExtendsFalse());
}
function Elements(inferred, reversed, leftRest, rightRest) {
  return ElementsRight(inferred, reversed, leftRest, rightRest);
}
function ExtendsTupleToTuple(inferred, left, right) {
  const instantiatedRight = InstantiateElements(inferred, State([], []), right);
  const reversed = Reversed(instantiatedRight);
  return Elements(inferred, reversed, ApplyReverse(left, reversed), ApplyReverse(instantiatedRight, reversed));
}
function ExtendsTupleToArray(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable["name"], left, inferrable["type"]) : guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsLeft(inferred, head, right), (inferred2) => ExtendsTupleToArray(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsTuple(inferred, left, right) {
  const instantiatedLeft = InstantiateElements(inferred, State([], []), left);
  return IsTuple(right) ? ExtendsTupleToTuple(inferred, instantiatedLeft, right.items) : IsArray2(right) ? ExtendsTupleToArray(inferred, instantiatedLeft, right.items) : ExtendsRight(inferred, Tuple(instantiatedLeft), right);
}

// node_modules/typebox/build/type/extends/undefined.mjs
function ExtendsUndefined(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : IsUndefined2(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/union.mjs
function ExtendsUnionSome(inferred, type, unionTypes) {
  return guard_exports.ShiftLeft(unionTypes, (head, tail) => Match3(ExtendsLeft(inferred, type, head), (inferred2) => ExtendsTrue(inferred2), () => ExtendsUnionSome(inferred, type, tail)), () => ExtendsFalse());
}
function ExtendsUnionLeft(inferred, left, right) {
  return guard_exports.ShiftLeft(left, (head, tail) => Match3(ExtendsUnionSome(inferred, head, right), (inferred2) => ExtendsUnionLeft(inferred2, tail, right), () => ExtendsFalse()), () => ExtendsTrue(inferred));
}
function ExtendsUnion2(inferred, left, right) {
  const inferrable = TryInferable(right);
  return IsInferable(inferrable) ? InferUnionResult(inferred, inferrable.name, left, inferrable.type) : IsUnion(right) ? ExtendsUnionLeft(inferred, left, right.anyOf) : ExtendsUnionLeft(inferred, left, [right]);
}

// node_modules/typebox/build/type/extends/unknown.mjs
function ExtendsUnknown(inferred, left, right) {
  return IsInfer(right) ? ExtendsRight(inferred, left, right) : IsAny(right) ? ExtendsTrue(inferred) : IsUnknown(right) ? ExtendsTrue(inferred) : ExtendsFalse();
}

// node_modules/typebox/build/type/extends/void.mjs
function ExtendsVoid(inferred, left, right) {
  return IsVoid(right) ? ExtendsTrue(inferred) : ExtendsRight(inferred, left, right);
}

// node_modules/typebox/build/type/extends/extends_left.mjs
function ExtendsLeft(inferred, left, right) {
  return IsAny(left) ? ExtendsAny(inferred, left, right) : IsArray2(left) ? ExtendsArray(inferred, left, left.items, right) : IsBigInt2(left) ? ExtendsBigInt(inferred, left, right) : IsBoolean3(left) ? ExtendsBoolean(inferred, left, right) : IsConstructor2(left) ? ExtendsConstructor(inferred, left.parameters, left.instanceType, right) : IsDependent(left) ? ExtendsDependent(inferred, left.if, left.then, left.else, right) : IsEnum(left) ? ExtendsEnum(inferred, left.enum, right) : IsFunction2(left) ? ExtendsFunction(inferred, left.parameters, left.returnType, right) : IsInteger2(left) ? ExtendsInteger(inferred, left, right) : IsIntersect(left) ? ExtendsIntersect(inferred, left.allOf, right) : IsLiteral(left) ? ExtendsLiteral(inferred, left, right) : IsNever(left) ? ExtendsNever(inferred, left, right) : IsNull2(left) ? ExtendsNull(inferred, left, right) : IsNumber3(left) ? ExtendsNumber(inferred, left, right) : IsObject2(left) ? ExtendsObject(inferred, left.properties, right) : IsRecord(left) ? ExtendsRecord(inferred, RecordPattern(left), RecordValue(left), right) : IsString3(left) ? ExtendsString(inferred, left, right) : IsSymbol2(left) ? ExtendsSymbol(inferred, left, right) : IsTemplateLiteral(left) ? ExtendsTemplateLiteral(inferred, left.pattern, right) : IsTuple(left) ? ExtendsTuple(inferred, left.items, right) : IsUndefined2(left) ? ExtendsUndefined(inferred, left, right) : IsUnion(left) ? ExtendsUnion2(inferred, left.anyOf, right) : IsUnknown(left) ? ExtendsUnknown(inferred, left, right) : IsVoid(left) ? ExtendsVoid(inferred, left, right) : ExtendsFalse();
}

// node_modules/typebox/build/type/engine/interface/instantiate.mjs
function InterfaceOperation(heritage, properties) {
  const result = EvaluateIntersect([...heritage, _Object_(properties)]);
  return result;
}
function InterfaceAction(heritage, properties, options) {
  const result = CanInstantiate(heritage) ? memory_exports.Update(InterfaceOperation(heritage, properties), {}, options) : InterfaceDeferred(heritage, properties, options);
  return result;
}
function InterfaceInstantiate(context, state, heritage, properties, options) {
  const instantiatedHeritage = InstantiateTypes(context, state, heritage);
  const instantiatedProperties = InstantiateProperties(context, state, properties);
  return InterfaceAction(instantiatedHeritage, instantiatedProperties, options);
}

// node_modules/typebox/build/type/action/interface.mjs
function InterfaceDeferred(heritage, properties, options = {}) {
  return Deferred("Interface", [heritage, properties], options);
}
function IsInterfaceDeferred(value) {
  return IsSchema(value) && guard_exports.HasPropertyKey(value, "action") && guard_exports.IsEqual(value.action, "Interface");
}
function Interface(heritage, properties, options = {}) {
  return InterfaceAction(heritage, properties, options);
}

// node_modules/typebox/build/type/engine/cyclic/check.mjs
function FromRef(stack, context, ref) {
  return stack.includes(ref) ? true : FromType3([...stack, ref], context, context[ref]);
}
function FromProperties(stack, context, properties) {
  const types = PropertyValues(properties);
  return FromTypes2(stack, context, types);
}
function FromTypes2(stack, context, types) {
  return guard_exports.ShiftLeft(types, (left, right) => FromType3(stack, context, left) ? true : FromTypes2(stack, context, right), () => false);
}
function FromType3(stack, context, type) {
  return IsRef(type) ? FromRef(stack, context, type.$ref) : IsArray2(type) ? FromType3(stack, context, type.items) : IsConstructor2(type) ? FromTypes2(stack, context, [...type.parameters, type.instanceType]) : IsFunction2(type) ? FromTypes2(stack, context, [...type.parameters, type.returnType]) : IsInterfaceDeferred(type) ? FromProperties(stack, context, type.parameters[1]) : IsIntersect(type) ? FromTypes2(stack, context, type.allOf) : IsObject2(type) ? FromProperties(stack, context, type.properties) : IsUnion(type) ? FromTypes2(stack, context, type.anyOf) : IsTuple(type) ? FromTypes2(stack, context, type.items) : IsRecord(type) ? FromType3(stack, context, RecordValue(type)) : false;
}
function CyclicCheck(stack, context, type) {
  const result = FromType3(stack, context, type);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/candidates.mjs
function ResolveCandidateKeys(context, keys) {
  return keys.reduce((result, left) => {
    return CyclicCheck([left], context, context[left]) ? [...result, left] : result;
  }, []);
}
function CyclicCandidates(context) {
  const keys = PropertyKeys(context);
  const result = ResolveCandidateKeys(context, keys);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/dependencies.mjs
function FromRef2(context, ref, result) {
  return result.includes(ref) ? result : ref in context ? FromType4(context, context[ref], [...result, ref]) : Unreachable();
}
function FromProperties2(context, properties, result) {
  const types = PropertyValues(properties);
  return FromTypes3(context, types, result);
}
function FromTypes3(context, types, result) {
  return types.reduce((result2, left) => {
    return FromType4(context, left, result2);
  }, result);
}
function FromType4(context, type, result) {
  return IsRef(type) ? FromRef2(context, type.$ref, result) : IsArray2(type) ? FromType4(context, type.items, result) : IsConstructor2(type) ? FromTypes3(context, [...type.parameters, type.instanceType], result) : IsFunction2(type) ? FromTypes3(context, [...type.parameters, type.returnType], result) : IsInterfaceDeferred(type) ? FromProperties2(context, type.parameters[1], result) : IsIntersect(type) ? FromTypes3(context, type.allOf, result) : IsObject2(type) ? FromProperties2(context, type.properties, result) : IsUnion(type) ? FromTypes3(context, type.anyOf, result) : IsTuple(type) ? FromTypes3(context, type.items, result) : IsRecord(type) ? FromType4(context, RecordValue(type), result) : result;
}
function CyclicDependencies(context, key, type) {
  const result = FromType4(context, type, [key]);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/extends.mjs
function FromRef3(_ref) {
  return Any();
}
function FromProperties3(properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType5(properties[key]) };
  }, {});
}
function FromTypes4(types) {
  return types.reduce((result, left) => {
    return [...result, FromType5(left)];
  }, []);
}
function FromType5(type) {
  return IsRef(type) ? FromRef3(type.$ref) : IsArray2(type) ? _Array_(FromType5(type.items), ArrayOptions(type)) : IsConstructor2(type) ? Constructor(FromTypes4(type.parameters), FromType5(type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes4(type.parameters), FromType5(type.returnType)) : IsIntersect(type) ? Intersect(FromTypes4(type.allOf)) : IsObject2(type) ? _Object_(FromProperties3(type.properties)) : IsRecord(type) ? Record(RecordKey(type), FromType5(RecordValue(type))) : IsUnion(type) ? Union(FromTypes4(type.anyOf)) : IsTuple(type) ? Tuple(FromTypes4(type.items)) : type;
}
function CyclicAnyFromParameters(defs, ref) {
  return ref in defs ? FromType5(defs[ref]) : Unknown();
}
function CyclicExtends(type) {
  return CyclicAnyFromParameters(type.$defs, type.$ref);
}

// node_modules/typebox/build/type/engine/cyclic/instantiate.mjs
function CyclicInterface(context, heritage, properties) {
  const instantiatedHeritage = InstantiateTypes(context, State([], []), heritage);
  const instantiatedProperties = InstantiateProperties({}, State([], []), properties);
  const evaluatedInterface = EvaluateIntersect([...instantiatedHeritage, _Object_(instantiatedProperties)]);
  return evaluatedInterface;
}
function CyclicDefinitions(context, dependencies) {
  const keys = guard_exports.Keys(context).filter((key) => dependencies.includes(key));
  return keys.reduce((result, key) => {
    const type = context[key];
    const instantiatedType = IsInterfaceDeferred(type) ? CyclicInterface(context, type.parameters[0], type.parameters[1]) : type;
    return { ...result, [key]: instantiatedType };
  }, {});
}
function InstantiateCyclic(context, ref, type) {
  const dependencies = CyclicDependencies(context, ref, type);
  const definitions = CyclicDefinitions(context, dependencies);
  const result = Cyclic(definitions, ref);
  return result;
}

// node_modules/typebox/build/type/engine/cyclic/target.mjs
function Resolve(defs, ref) {
  return ref in defs ? IsRef(defs[ref]) ? Resolve(defs, defs[ref].$ref) : defs[ref] : Never();
}
function CyclicTarget(defs, ref) {
  const result = Resolve(defs, ref);
  return result;
}

// node_modules/typebox/build/type/extends/extends.mjs
function Canonical(type) {
  return IsCyclic(type) ? CyclicExtends(type) : IsUnsafe(type) ? Unknown() : type;
}
function Extends(inferred, left, right) {
  const canonicalLeft = Canonical(left);
  const canonicalRight = Canonical(right);
  return ExtendsLeft(inferred, canonicalLeft, canonicalRight);
}

// node_modules/typebox/build/type/engine/evaluate/compare.mjs
var ResultEqual = "equal";
var ResultDisjoint = "disjoint";
var ResultLeftInside = "left-inside";
var ResultRightInside = "right-inside";
function Compare(left, right) {
  const extendsCheck = [
    IsUnknown(left) ? result_exports.ExtendsFalse() : Extends({}, left, right),
    IsUnknown(left) ? result_exports.ExtendsTrue({}) : Extends({}, right, left)
  ];
  return result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultEqual : result_exports.IsExtendsTrueLike(extendsCheck[0]) && result_exports.IsExtendsFalse(extendsCheck[1]) ? ResultLeftInside : result_exports.IsExtendsFalse(extendsCheck[0]) && result_exports.IsExtendsTrueLike(extendsCheck[1]) ? ResultRightInside : ResultDisjoint;
}

// node_modules/typebox/build/type/engine/evaluate/broaden.mjs
function BroadFilter(type, types) {
  return types.filter((left) => {
    return Compare(type, left) === ResultRightInside ? false : true;
  });
}
function IsBroadestType(type, types) {
  const result = types.some((left) => {
    const result2 = Compare(type, left);
    return guard_exports.IsEqual(result2, ResultLeftInside) || guard_exports.IsEqual(result2, ResultEqual);
  });
  return guard_exports.IsEqual(result, false);
}
function BroadenType(type, types) {
  const evaluated = EvaluateType(type);
  return IsAny(evaluated) ? [evaluated] : IsBroadestType(evaluated, types) ? [...BroadFilter(evaluated, types), evaluated] : types;
}
function BroadenTypes(types) {
  return types.reduce((result, left) => {
    return IsObject2(left) ? [...result, left] : (
      // push
      IsNever(left) ? result : (
        // ignore
        BroadenType(left, result)
      )
    );
  }, []);
}
function Broaden(types) {
  const broadened = BroadenTypes(types);
  const flattened = Flatten(broadened);
  return flattened;
}

// node_modules/typebox/build/type/engine/evaluate/instantiate.mjs
function EvaluateAction(type, options) {
  const result = memory_exports.Update(EvaluateType(type), {}, options);
  return result;
}
function EvaluateInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return EvaluateAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/call/distribute_arguments.mjs
function CollectDistributionNames(expression, result = []) {
  return (
    // Conditional
    IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? IsRef(expression.parameters[0]) ? CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], [...result, expression.parameters[0]["$ref"]])) : CollectDistributionNames(expression.parameters[2], CollectDistributionNames(expression.parameters[3], result)) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? IsDeferred(expression.parameters[1]) && guard_exports.IsEqual(expression.parameters[1].action, "KeyOf") && IsRef(expression.parameters[1].parameters[0]) ? [...result, expression.parameters[1].parameters[0]["$ref"]] : result : result
  );
}
function BuildDistributionArray(parameters, names) {
  return parameters.reduce((result, left) => [...result, names.includes(left.name)], []);
}
function ZipDistributionArray(arguments_, distributionArray, result = []) {
  return guard_exports.ShiftLeft(arguments_, (argumentLeft, argumentRight) => guard_exports.ShiftLeft(distributionArray, (booleanLeft, booleanRight) => ZipDistributionArray(argumentRight, booleanRight, [...result, [booleanLeft, argumentLeft]]), () => result), () => result);
}
function Expand(type) {
  return IsUnion(type) ? [...type.anyOf] : [type];
}
function Append(current, type) {
  return current.reduce((result, left) => [...result, [...left, type]], []);
}
function Cross(current, variants) {
  return variants.reduce((result, left) => {
    return [...result, ...Append(current, left)];
  }, []);
}
function Distribute2(zipped) {
  return zipped.reduce((result, left) => {
    return guard_exports.IsEqual(left[0], true) ? Cross(result, Expand(left[1])) : Cross(result, [left[1]]);
  }, [[]]);
}
function DistributeArguments(parameters, arguments_, expression) {
  const distributionNames = CollectDistributionNames(expression);
  const distributionArray = BuildDistributionArray(parameters, distributionNames);
  const zippedArguments = ZipDistributionArray(arguments_, distributionArray);
  return IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Conditional") ? Distribute2(zippedArguments) : IsDeferred(expression) && guard_exports.IsEqual(expression.action, "Mapped") ? Distribute2(zippedArguments) : [arguments_];
}

// node_modules/typebox/build/type/engine/call/resolve_target.mjs
function FromNotResolvable() {
  return ["(not-resolvable)", Never()];
}
function FromNotGeneric() {
  return ["(not-generic)", Never()];
}
function FromGeneric(name, parameters, expression) {
  return [name, Generic(parameters, expression)];
}
function FromRef4(context, ref, arguments_) {
  return ref in context ? FromType6(context, ref, context[ref], arguments_) : FromNotResolvable();
}
function FromType6(context, name, target, arguments_) {
  return IsGeneric(target) ? FromGeneric(name, target.parameters, target.expression) : IsRef(target) ? FromRef4(context, target.$ref, arguments_) : FromNotGeneric();
}
function ResolveTarget(context, target, arguments_) {
  return FromType6(context, "(anonymous)", target, arguments_);
}

// node_modules/typebox/build/type/engine/call/resolve_arguments.mjs
function AssertArgumentExtends(name, type, extends_) {
  if (IsInfer(type) || IsCall(type) || result_exports.IsExtendsTrueLike(Extends({}, type, extends_)))
    return;
  const cause = { parameter: name, expect: extends_, actual: type };
  throw new Error(`Argument for parameter ${name} does not satisfy constraint`, { cause });
}
function BindArgument(context, state, name, extends_, type) {
  const instantiatedArgument = InstantiateType(context, state, type);
  AssertArgumentExtends(name, instantiatedArgument, extends_);
  return memory_exports.Assign(context, { [name]: instantiatedArgument });
}
function BindArguments(context, state, parameterLeft, parameterRight, arguments_) {
  const instantiatedExtends = InstantiateType(context, state, parameterLeft.extends);
  const instantiatedEquals = InstantiateType(context, state, parameterLeft.equals);
  return guard_exports.ShiftLeft(arguments_, (left, right) => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, left), state, parameterRight, right), () => BindParameters(BindArgument(context, state, parameterLeft["name"], instantiatedExtends, instantiatedEquals), state, parameterRight, []));
}
function BindParameters(context, state, parameters, arguments_) {
  return guard_exports.ShiftLeft(parameters, (left, right) => BindArguments(context, state, left, right, arguments_), () => context);
}
function ResolveArgumentsContext(context, state, parameters, arguments_) {
  return BindParameters(context, state, parameters, arguments_);
}

// node_modules/typebox/build/type/engine/call/instantiate.mjs
function Peek(state) {
  const result = guard_exports.IsGreaterThan(state.callstack.length, 0) ? state.callstack[state.callstack.length - 1] : "";
  return result;
}
function IsTailCall(state, name) {
  const result = guard_exports.IsEqual(Peek(state), name);
  return result;
}
function CallDispatch(context, state, target, parameters, expression, arguments_) {
  const argumentsContext = ResolveArgumentsContext(context, state, parameters, arguments_);
  const returnType = InstantiateType(argumentsContext, State([...state["callstack"], target["$ref"]], state["visited"]), expression);
  return InstantiateType(argumentsContext, State([], []), returnType);
}
function CallDistributed(context, state, target, parameters, expression, distributedArguments) {
  return distributedArguments.reduce((result, arguments_) => [...result, CallDispatch(context, state, target, parameters, expression, arguments_)], []);
}
function CallImmediate(context, state, target, parameters, expression, arguments_) {
  const distributedArguments = DistributeArguments(parameters, arguments_, expression);
  const returnTypes = CallDistributed(context, state, target, parameters, expression, distributedArguments);
  const result = guard_exports.IsEqual(returnTypes.length, 1) ? returnTypes[0] : EvaluateUnion(returnTypes);
  return result;
}
function CallInstantiate(context, state, target, arguments_) {
  const instantiatedArguments = InstantiateTypes(context, state, arguments_);
  const resolved = ResolveTarget(context, target, arguments_);
  const name = resolved[0];
  const type = resolved[1];
  const result = IsGeneric(type) ? IsTailCall(state, name) ? CallConstruct(Ref(name), instantiatedArguments) : CallImmediate(context, state, Ref(name), type.parameters, type.expression, instantiatedArguments) : CallConstruct(target, instantiatedArguments);
  return result;
}

// node_modules/typebox/build/type/types/call.mjs
function CallConstruct(target, arguments_) {
  return memory_exports.Create({ ["~kind"]: "Call" }, { type: "call", target, arguments: arguments_ }, {});
}
function Call(target, arguments_) {
  return CallInstantiate({}, State([], []), target, arguments_);
}
function IsCall(value) {
  return IsKind(value, "Call");
}

// node_modules/typebox/build/type/engine/immutable/instantiate_remove.mjs
function RemoveImmutableOperation(type) {
  return memory_exports.Discard(type, ["~immutable"]);
}
function RemoveImmutableAction(type, options) {
  const result = memory_exports.Update(RemoveImmutableOperation(type), {}, options);
  return result;
}
function RemoveImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return RemoveImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/intrinsics/mapping.mjs
function ApplyMapping(mapping, value) {
  return mapping(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_literal.mjs
function FromLiteral3(mapping, value) {
  return guard_exports.IsString(value) ? Literal(ApplyMapping(mapping, value)) : Literal(value);
}

// node_modules/typebox/build/type/engine/intrinsics/from_template_literal.mjs
function FromTemplateLiteral(mapping, pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType7(mapping, evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/intrinsics/from_union.mjs
function FromUnion2(mapping, types) {
  const result = types.map((type) => FromType7(mapping, type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/intrinsics/from_type.mjs
function FromType7(mapping, type) {
  return IsLiteral(type) ? FromLiteral3(mapping, type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral(mapping, type.pattern) : IsUnion(type) ? FromUnion2(mapping, type.anyOf) : type;
}

// node_modules/typebox/build/type/action/capitalize.mjs
function CapitalizeDeferred(type, options = {}) {
  return Deferred("Capitalize", [type], options);
}
function Capitalize(type, options = {}) {
  return CapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/lowercase.mjs
function LowercaseDeferred(type, options = {}) {
  return Deferred("Lowercase", [type], options);
}
function Lowercase(type, options = {}) {
  return LowercaseAction(type, options);
}

// node_modules/typebox/build/type/action/uncapitalize.mjs
function UncapitalizeDeferred(type, options = {}) {
  return Deferred("Uncapitalize", [type], options);
}
function Uncapitalize(type, options = {}) {
  return UncapitalizeAction(type, options);
}

// node_modules/typebox/build/type/action/uppercase.mjs
function UppercaseDeferred(type, options = {}) {
  return Deferred("Uppercase", [type], options);
}
function Uppercase(type, options = {}) {
  return UppercaseAction(type, options);
}

// node_modules/typebox/build/type/engine/intrinsics/instantiate.mjs
var CapitalizeMapping = (input) => input[0].toUpperCase() + input.slice(1);
var LowercaseMapping = (input) => input.toLowerCase();
var UncapitalizeMapping = (input) => input[0].toLowerCase() + input.slice(1);
var UppercaseMapping = (input) => input.toUpperCase();
function CapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(CapitalizeMapping, type), {}, options) : CapitalizeDeferred(type, options);
  return result;
}
function LowercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(LowercaseMapping, type), {}, options) : LowercaseDeferred(type, options);
  return result;
}
function UncapitalizeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UncapitalizeMapping, type), {}, options) : UncapitalizeDeferred(type, options);
  return result;
}
function UppercaseAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType7(UppercaseMapping, type), {}, options) : UppercaseDeferred(type, options);
  return result;
}
function CapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return CapitalizeAction(instantiatedType, options);
}
function LowercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return LowercaseAction(instantiatedType, options);
}
function UncapitalizeInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UncapitalizeAction(instantiatedType, options);
}
function UppercaseInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return UppercaseAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/conditional.mjs
function ConditionalDeferred(left, right, true_, false_, options = {}) {
  return Deferred("Conditional", [left, right, true_, false_], options);
}
function Conditional(left, right, true_, false_, options = {}) {
  return ConditionalAction({}, State([], []), left, right, true_, false_, options);
}

// node_modules/typebox/build/type/engine/conditional/instantiate.mjs
function ConditionalOperation(context, state, left, right, true_, false_) {
  const extendsResult = Extends(context, left, right);
  return result_exports.IsExtendsUnion(extendsResult) ? Union([InstantiateType(extendsResult.inferred, state, true_), InstantiateType(context, state, false_)]) : result_exports.IsExtendsTrue(extendsResult) ? InstantiateType(extendsResult.inferred, state, true_) : InstantiateType(context, state, false_);
}
function ConditionalAction(context, state, left, right, true_, false_, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ConditionalOperation(context, state, left, right, true_, false_), {}, options) : ConditionalDeferred(left, right, true_, false_, options);
  return result;
}
function ConditionalInstantiate(context, state, left, right, true_, false_, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ConditionalAction(context, state, instantiatedLeft, instantiatedRight, true_, false_, options);
}

// node_modules/typebox/build/type/action/constructor_parameters.mjs
function ConstructorParametersDeferred(type, options = {}) {
  return Deferred("ConstructorParameters", [type], options);
}
function ConstructorParameters(type, options = {}) {
  return ConstructorParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/constructor_parameters/instantiate.mjs
function ConstructorParametersOperation(type) {
  const parameters = IsConstructor2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ConstructorParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ConstructorParametersOperation(type), {}, options) : ConstructorParametersDeferred(type, options);
  return result;
}
function ConstructorParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ConstructorParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/exclude.mjs
function ExcludeDeferred(left, right, options = {}) {
  return Deferred("Exclude", [left, right], options);
}
function Exclude(left, right, options = {}) {
  return ExcludeAction(left, right, options);
}

// node_modules/typebox/build/type/engine/exclude/instantiate.mjs
function ExcludeAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExcludeOperation(left, right), {}, options) : ExcludeDeferred(left, right, options);
  return result;
}
function ExcludeInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExcludeAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/action/extract.mjs
function ExtractDeferred(left, right, options = {}) {
  return Deferred("Extract", [left, right], options);
}
function Extract(left, right, options = {}) {
  return ExtractAction(left, right, options);
}

// node_modules/typebox/build/type/engine/extract/operation.mjs
function ExtractType(left, right) {
  const check = Extends({}, left, right);
  const result = result_exports.IsExtendsTrueLike(check) ? [left] : [];
  return result;
}
function ExtractUnion(types, right) {
  return types.reduce((result, head) => {
    return [...result, ...ExtractType(head, right)];
  }, []);
}
function ExtractOperation(left, right) {
  const evaluated = EvaluateType(left);
  const canonical = IsUnion(evaluated) ? evaluated.anyOf : [evaluated];
  const remaining = ExtractUnion(canonical, right);
  const result = EvaluateUnion(remaining);
  return result;
}

// node_modules/typebox/build/type/engine/extract/instantiate.mjs
function ExtractAction(left, right, options) {
  const result = CanInstantiate([left, right]) ? memory_exports.Update(ExtractOperation(left, right), {}, options) : ExtractDeferred(left, right, options);
  return result;
}
function ExtractInstantiate(context, state, left, right, options) {
  const instantiatedLeft = InstantiateType(context, state, left);
  const instantiatedRight = InstantiateType(context, state, right);
  return ExtractAction(instantiatedLeft, instantiatedRight, options);
}

// node_modules/typebox/build/type/engine/helpers/keys_to_indexer.mjs
function KeysToLiterals(keys) {
  return keys.reduce((result, left) => {
    return IsLiteralValue(left) ? [...result, Literal(left)] : result;
  }, []);
}
function KeysToIndexer(keys) {
  const literals = KeysToLiterals(keys);
  const result = Union(literals);
  return result;
}

// node_modules/typebox/build/type/action/indexed.mjs
function IndexDeferred(type, indexer, options = {}) {
  return Deferred("Index", [type, indexer], options);
}
function Index(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return IndexAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/object/from_cyclic.mjs
function FromCyclic(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType8(target);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_dependent.mjs
function FromDependent(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType8(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_intersect.mjs
function CollapseIntersectProperties(left, right) {
  const leftKeys = guard_exports.Keys(left).filter((key) => !guard_exports.HasPropertyKey(right, key));
  const rightKeys = guard_exports.Keys(right).filter((key) => !guard_exports.HasPropertyKey(left, key));
  const sharedKeys = guard_exports.Keys(left).filter((key) => guard_exports.HasPropertyKey(right, key));
  const leftProperties = leftKeys.reduce((result, key) => ({ ...result, [key]: left[key] }), {});
  const rightProperties = rightKeys.reduce((result, key) => ({ ...result, [key]: right[key] }), {});
  const sharedProperties = sharedKeys.reduce((result, key) => ({ ...result, [key]: EvaluateIntersect([left[key], right[key]]) }), {});
  const unique = memory_exports.Assign(leftProperties, rightProperties);
  const shared = memory_exports.Assign(unique, sharedProperties);
  return shared;
}
function FromIntersect(types) {
  return types.reduce((result, left) => {
    return CollapseIntersectProperties(result, FromType8(left));
  }, {});
}

// node_modules/typebox/build/type/engine/object/from_object.mjs
function FromObject4(properties) {
  return properties;
}

// node_modules/typebox/build/type/engine/object/from_tuple.mjs
function FromTuple(types) {
  const object = TupleToObject(Tuple(types));
  const result = FromType8(object);
  return result;
}

// node_modules/typebox/build/type/engine/object/from_union.mjs
function CollapseUnionProperties(left, right) {
  const sharedKeys = guard_exports.Keys(left).filter((key) => key in right);
  const result = sharedKeys.reduce((result2, key) => {
    return { ...result2, [key]: EvaluateUnion([left[key], right[key]]) };
  }, {});
  return result;
}
function ReduceVariants(types, result) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, CollapseUnionProperties(result, FromType8(left))), () => result);
}
function FromUnion3(types) {
  return guard_exports.ShiftLeft(types, (left, right) => ReduceVariants(right, FromType8(left)), () => Unreachable());
}

// node_modules/typebox/build/type/engine/object/from_type.mjs
function FromType8(type) {
  return IsCyclic(type) ? FromCyclic(type.$defs, type.$ref) : IsDependent(type) ? FromDependent(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect(type.allOf) : IsUnion(type) ? FromUnion3(type.anyOf) : IsTuple(type) ? FromTuple(type.items) : IsObject2(type) ? FromObject4(type.properties) : {};
}

// node_modules/typebox/build/type/engine/object/collapse.mjs
function CollapseToObject(type) {
  const properties = FromType8(type);
  const result = _Object_(properties);
  return result;
}

// node_modules/typebox/build/type/engine/helpers/keys.mjs
var integerKeyPattern = new RegExp("^(?:0|[1-9][0-9]*)$");
function ConvertToIntegerKey(value) {
  const normal = `${value}`;
  return integerKeyPattern.test(normal) ? parseInt(normal) : value;
}

// node_modules/typebox/build/type/engine/indexed/from_array.mjs
function NormalizeLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function NormalizeIndexerTypes(types) {
  return types.map((type) => NormalizeIndexer(type));
}
function NormalizeIndexer(type) {
  return IsIntersect(type) ? Intersect(NormalizeIndexerTypes(type.allOf)) : IsUnion(type) ? Union(NormalizeIndexerTypes(type.anyOf)) : IsLiteral(type) ? NormalizeLiteral(type.const) : type;
}
function FromArray3(type, indexer) {
  const normalizedIndexer = NormalizeIndexer(indexer);
  const check = Extends({}, normalizedIndexer, Number2());
  const result = (
    // indexer
    result_exports.IsExtendsTrueLike(check) ? type : IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Number2() : Never()
  );
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_cyclic.mjs
function FromCyclic2(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const result = FromType9(target);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_dependent.mjs
function FromDependent2(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_enum.mjs
function FromEnum(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_intersect.mjs
function FromIntersect2(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_literal.mjs
function FromLiteral4(value) {
  const result = [`${value}`];
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_template_literal.mjs
function FromTemplateLiteral2(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType9(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/indexable/from_union.mjs
function FromUnion4(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType9(left)];
  }, []);
}

// node_modules/typebox/build/type/engine/indexable/from_type.mjs
function FromType9(type) {
  return IsCyclic(type) ? FromCyclic2(type.$defs, type.$ref) : IsDependent(type) ? FromDependent2(type.if, type.then, type.else) : IsEnum(type) ? FromEnum(type.enum) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsLiteral(type) ? FromLiteral4(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral2(type.pattern) : IsUnion(type) ? FromUnion4(type.anyOf) : [];
}

// node_modules/typebox/build/type/engine/indexable/to_indexable_keys.mjs
function ToIndexableKeys(type) {
  const result = FromType9(type);
  return result;
}

// node_modules/typebox/build/type/engine/this/expand_this.mjs
function FromTypes5(properties, types) {
  return types.map((type) => FromType10(properties, type));
}
function FromType10(properties, type) {
  return IsArray2(type) ? _Array_(FromType10(properties, type.items)) : IsConstructor2(type) ? Constructor(FromTypes5(properties, type.parameters), FromType10(properties, type.instanceType)) : IsFunction2(type) ? _Function_(FromTypes5(properties, type.parameters), FromType10(properties, type.returnType)) : IsTuple(type) ? Tuple(FromTypes5(properties, type.items)) : IsUnion(type) ? Union(FromTypes5(properties, type.anyOf)) : IsIntersect(type) ? Intersect(FromTypes5(properties, type.allOf)) : IsThis(type) ? _Object_(properties) : type;
}
function ExpandThis(properties, type) {
  const result = FromType10(properties, type);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/from_object.mjs
function IndexProperty(properties, key) {
  const selectedType = key in properties ? properties[key] : Never();
  const result = ExpandThis(properties, selectedType);
  return result;
}
function IndexProperties(properties, keys) {
  return keys.reduce((result, left) => {
    return [...result, IndexProperty(properties, left)];
  }, []);
}
function FromIndexer(properties, indexer) {
  const keys = ToIndexableKeys(indexer);
  const variants = IndexProperties(properties, keys);
  const result = EvaluateUnion(variants);
  return result;
}
var NumericKeyPattern = new RegExp(IntegerKey);
function NumericKeys(keys) {
  const result = keys.filter((key) => NumericKeyPattern.test(key));
  return result;
}
function FromIndexerNumber(properties) {
  const keys = PropertyKeys(properties);
  const numericKeys = NumericKeys(keys);
  const variants = IndexProperties(properties, numericKeys);
  const result = EvaluateUnion(variants);
  return result;
}
function FromObject5(properties, indexer) {
  const result = IsNumber3(indexer) ? FromIndexerNumber(properties) : FromIndexer(properties, indexer);
  return result;
}

// node_modules/typebox/build/type/engine/indexed/array_indexer.mjs
function ConvertLiteral(value) {
  return Literal(ConvertToIntegerKey(value));
}
function ArrayIndexerTypes(types) {
  return types.map((type) => FormatArrayIndexer(type));
}
function FormatArrayIndexer(type) {
  return IsIntersect(type) ? Intersect(ArrayIndexerTypes(type.allOf)) : IsUnion(type) ? Union(ArrayIndexerTypes(type.anyOf)) : IsLiteral(type) ? ConvertLiteral(type.const) : type;
}

// node_modules/typebox/build/type/engine/indexed/from_tuple.mjs
function IndexElementsWithIndexer(types, indexer) {
  return types.reduceRight((result, right, index) => {
    const check = Extends({}, Literal(index), indexer);
    return result_exports.IsExtendsTrueLike(check) ? [right, ...result] : result;
  }, []);
}
function FromTupleWithIndexer(types, indexer) {
  const formattedArrayIndexer = FormatArrayIndexer(indexer);
  const elements = IndexElementsWithIndexer(types, formattedArrayIndexer);
  return EvaluateUnionFast(elements);
}
function FromTupleWithoutIndexer(types) {
  return EvaluateUnionFast(types);
}
function FromTuple2(types, indexer) {
  return (
    // length (intrinsic)
    IsLiteral(indexer) && guard_exports.IsEqual(indexer.const, "length") ? Literal(types.length) : IsNumber3(indexer) || IsInteger2(indexer) ? FromTupleWithoutIndexer(types) : FromTupleWithIndexer(types, indexer)
  );
}

// node_modules/typebox/build/type/engine/indexed/from_type.mjs
function FromType11(type, indexer) {
  return IsArray2(type) ? FromArray3(type.items, indexer) : IsObject2(type) ? FromObject5(type.properties, indexer) : IsTuple(type) ? FromTuple2(type.items, indexer) : Never();
}

// node_modules/typebox/build/type/engine/indexed/instantiate.mjs
function NormalizeType(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function IndexAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType11(NormalizeType(type), indexer), {}, options) : IndexDeferred(type, indexer, options);
  return result;
}
function IndexInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return IndexAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/instance_type.mjs
function InstanceTypeDeferred(type, options = {}) {
  return Deferred("InstanceType", [type], options);
}
function InstanceType(type, options = {}) {
  return InstanceTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/instance_type/instantiate.mjs
function InstanceTypeOperation(type) {
  return IsConstructor2(type) ? type["instanceType"] : Never();
}
function InstanceTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(InstanceTypeOperation(type), {}, options) : InstanceTypeDeferred(type, options);
  return result;
}
function InstanceTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return InstanceTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/keyof.mjs
function KeyOfDeferred(type, options = {}) {
  return Deferred("KeyOf", [type], options);
}
function KeyOf2(type, options = {}) {
  return KeyOfAction(type, options);
}

// node_modules/typebox/build/type/engine/keyof/from_any.mjs
function FromAny() {
  return Union([Number2(), String2(), Symbol2()]);
}

// node_modules/typebox/build/type/engine/keyof/from_array.mjs
function FromArray4(_type) {
  return Number2();
}

// node_modules/typebox/build/type/engine/keyof/from_object.mjs
function FromPropertyKeys(keys) {
  const result = keys.reduce((result2, left) => {
    return IsLiteralValue(left) ? [...result2, Literal(ConvertToIntegerKey(left))] : Unreachable();
  }, []);
  return result;
}
function FromObject6(properties) {
  const propertyKeys = guard_exports.Keys(properties);
  const variants = FromPropertyKeys(propertyKeys);
  const result = EvaluateUnionFast(variants);
  return result;
}

// node_modules/typebox/build/type/engine/keyof/from_record.mjs
function FromRecord2(type) {
  return RecordKey(type);
}

// node_modules/typebox/build/type/engine/keyof/from_tuple.mjs
function FromTuple3(types) {
  const result = types.map((_, index) => Literal(index));
  return EvaluateUnionFast(result);
}

// node_modules/typebox/build/type/engine/keyof/from_type.mjs
function FromType12(type) {
  return IsAny(type) ? FromAny() : IsArray2(type) ? FromArray4(type.items) : IsObject2(type) ? FromObject6(type.properties) : IsRecord(type) ? FromRecord2(type) : IsTuple(type) ? FromTuple3(type.items) : Never();
}

// node_modules/typebox/build/type/engine/keyof/instantiate.mjs
function NormalizeType2(type) {
  const result = IsCyclic(type) || IsDependent(type) || IsIntersect(type) || IsUnion(type) ? CollapseToObject(type) : type;
  return result;
}
function KeyOfAction(type, options) {
  return CanInstantiate([type]) ? memory_exports.Update(FromType12(NormalizeType2(type)), {}, options) : KeyOfDeferred(type, options);
}
function KeyOfInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return KeyOfAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/mapped.mjs
function MappedDeferred(identifier, type, as, property, options = {}) {
  return Deferred("Mapped", [identifier, type, as, property], options);
}
function Mapped(identifier, type, as, property, options = {}) {
  return MappedAction({}, State([], []), identifier, type, as, property, options);
}

// node_modules/typebox/build/type/engine/mapped/mapped_variants.mjs
function FromTemplateLiteral3(pattern) {
  const evaluated = EvaluateTemplateLiteral(pattern);
  const result = FromType13(evaluated);
  return result;
}
function FromUnion5(types) {
  return types.reduce((result, left) => {
    return [...result, ...FromType13(left)];
  }, []);
}
function FromEnum2(values) {
  const evaluated = EvaluateEnum(values);
  const result = FromType13(evaluated);
  return result;
}
function FromLiteral5(value) {
  const result = guard_exports.IsNumber(value) ? [Literal(`${value}`)] : [Literal(value)];
  return result;
}
function FromType13(type) {
  const result = IsEnum(type) ? FromEnum2(type.enum) : IsLiteral(type) ? FromLiteral5(type.const) : IsTemplateLiteral(type) ? FromTemplateLiteral3(type.pattern) : IsUnion(type) ? FromUnion5(type.anyOf) : [type];
  return result;
}
function MappedVariants(type) {
  const result = FromType13(type);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/mapped_operation.mjs
function CanonicalAs(instantiatedAs) {
  const result = IsTemplateLiteral(instantiatedAs) ? EvaluateTemplateLiteral(instantiatedAs.pattern) : instantiatedAs;
  return result;
}
function MappedVariant(context, state, identifier, variant, as, property) {
  const variantContext = memory_exports.Assign(context, { [identifier["name"]]: variant });
  const instantiatedAs = InstantiateType(variantContext, state, as);
  const canonicalAs = CanonicalAs(instantiatedAs);
  const instantiatedProperty = InstantiateType(variantContext, state, property);
  return IsLiteralNumber(canonicalAs) || IsLiteralString(canonicalAs) ? { [canonicalAs.const]: instantiatedProperty } : {};
}
function MappedProperties(context, state, identifier, variants, as, property) {
  return variants.reduce((result, left) => {
    return [...result, MappedVariant(context, state, identifier, left, as, property)];
  }, []);
}
function MappedObjects(properties) {
  return properties.reduce((result, left) => {
    return [...result, _Object_(left)];
  }, []);
}
function MappedOperation(context, state, identifier, type, as, property) {
  const variants = MappedVariants(type);
  const mappedProperties = MappedProperties(context, state, identifier, variants, as, property);
  const mappedObjects = MappedObjects(mappedProperties);
  const result = EvaluateIntersect(mappedObjects);
  return result;
}

// node_modules/typebox/build/type/engine/mapped/instantiate.mjs
function MappedAction(context, state, identifier, type, as, property, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(MappedOperation(context, state, identifier, type, as, property), {}, options) : MappedDeferred(identifier, type, as, property, options);
  return result;
}
function MappedInstantiate(context, state, identifier, type, as, property, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return MappedAction(context, state, identifier, instantiatedType, as, property, options);
}

// node_modules/typebox/build/type/engine/module/instantiate.mjs
function InstantiateCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateCyclic(declarationContext, key, declarations[key]) };
  }, {});
}
function InstantiateNonCyclics(context, declarations, cyclicKeys) {
  const declarationContext = memory_exports.Assign(context, declarations);
  const declarationKeys = guard_exports.Keys(declarations).filter((key) => !cyclicKeys.includes(key));
  return declarationKeys.reduce((result, key) => {
    return { ...result, [key]: InstantiateType(declarationContext, State([], []), declarations[key]) };
  }, {});
}
function InstantiateModule(context, declarations, options) {
  const cyclicCandidates = CyclicCandidates(declarations);
  const instantiatedCyclics = InstantiateCyclics(context, declarations, cyclicCandidates);
  const instantiatedNonCyclics = InstantiateNonCyclics(context, declarations, cyclicCandidates);
  const instantiatedModule = { ...instantiatedCyclics, ...instantiatedNonCyclics };
  return memory_exports.Update(instantiatedModule, {}, options);
}
function ModuleInstantiate(context, _state, declarations, options) {
  const instantiatedModule = InstantiateModule(context, declarations, options);
  return instantiatedModule;
}

// node_modules/typebox/build/type/action/non_nullable.mjs
function NonNullableDeferred(type, options = {}) {
  return Deferred("NonNullable", [type], options);
}
function NonNullable(type, options = {}) {
  return NonNullableAction(type, options);
}

// node_modules/typebox/build/type/engine/non_nullable/instantiate.mjs
function NonNullableOperation(type) {
  const excluded = Union([Null(), Undefined()]);
  return ExcludeAction(type, excluded, {});
}
function NonNullableAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(NonNullableOperation(type), {}, options) : NonNullableDeferred(type, options);
  return result;
}
function NonNullableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return NonNullableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/omit.mjs
function OmitDeferred(type, indexer, options = {}) {
  return Deferred("Omit", [type, indexer], options);
}
function Omit(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return OmitAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/indexable/to_indexable.mjs
function ToIndexable(type) {
  const collapsed = CollapseToObject(type);
  const result = IsObject2(collapsed) ? collapsed.properties : Unreachable();
  return result;
}

// node_modules/typebox/build/type/engine/omit/from_type.mjs
function FromKeys(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? result2 : { ...result2, [key]: properties[key] };
  }, {});
  return result;
}
function FromType14(type, indexer) {
  const indexable = ToIndexable(type);
  const indexableKeys = ToIndexableKeys(indexer);
  const omitted = FromKeys(indexable, indexableKeys);
  const result = _Object_(omitted);
  return result;
}

// node_modules/typebox/build/type/engine/omit/instantiate.mjs
function OmitAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType14(type, indexer), {}, options) : OmitDeferred(type, indexer, options);
  return result;
}
function OmitInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return OmitAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/parameters.mjs
function ParametersDeferred(type, options = {}) {
  return Deferred("Parameters", [type], options);
}
function Parameters(type, options = {}) {
  return ParametersAction(type, options);
}

// node_modules/typebox/build/type/engine/parameters/instantiate.mjs
function ParametersOperation(type) {
  const parameters = IsFunction2(type) ? type["parameters"] : [];
  const instantiatedParameters = InstantiateElements({}, State([], []), parameters);
  const result = Tuple(instantiatedParameters);
  return result;
}
function ParametersAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ParametersOperation(type), {}, options) : ParametersDeferred(type, options);
  return result;
}
function ParametersInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ParametersAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/partial.mjs
function PartialDeferred(type, options = {}) {
  return Deferred("Partial", [type], options);
}
function Partial(type, options = {}) {
  return PartialAction(type, options);
}

// node_modules/typebox/build/type/engine/partial/from_cyclic.mjs
function FromCyclic3(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType15(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_dependent.mjs
function FromDependent3(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_intersect.mjs
function FromIntersect3(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType15(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_union.mjs
function FromUnion6(types) {
  const result = types.map((type) => FromType15(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/partial/from_object.mjs
function FromObject7(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/partial/from_type.mjs
function FromType15(type) {
  return IsCyclic(type) ? FromCyclic3(type.$defs, type.$ref) : IsDependent(type) ? FromDependent3(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion6(type.anyOf) : IsObject2(type) ? FromObject7(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/engine/partial/instantiate.mjs
function PartialAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType15(type), {}, options) : PartialDeferred(type, options);
  return result;
}
function PartialInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return PartialAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/pick.mjs
function PickDeferred(type, indexer, options = {}) {
  return Deferred("Pick", [type, indexer], options);
}
function Pick(type, indexer_or_keys, options = {}) {
  const indexer = guard_exports.IsArray(indexer_or_keys) ? KeysToIndexer(indexer_or_keys) : indexer_or_keys;
  return PickAction(type, indexer, options);
}

// node_modules/typebox/build/type/engine/pick/from_type.mjs
function FromKeys2(properties, keys) {
  const result = guard_exports.Keys(properties).reduce((result2, key) => {
    return keys.includes(key) ? memory_exports.Assign(result2, { [key]: properties[key] }) : result2;
  }, {});
  return result;
}
function FromType16(type, indexer) {
  const indexable = ToIndexable(type);
  const keys = ToIndexableKeys(indexer);
  const applied = FromKeys2(indexable, keys);
  const result = _Object_(applied);
  return result;
}

// node_modules/typebox/build/type/engine/pick/instantiate.mjs
function PickAction(type, indexer, options) {
  const result = CanInstantiate([type, indexer]) ? memory_exports.Update(FromType16(type, indexer), {}, options) : PickDeferred(type, indexer, options);
  return result;
}
function PickInstantiate(context, state, type, indexer, options) {
  const instantiatedType = InstantiateType(context, state, type);
  const instantiatedIndexer = InstantiateType(context, state, indexer);
  return PickAction(instantiatedType, instantiatedIndexer, options);
}

// node_modules/typebox/build/type/action/readonly_object.mjs
function ReadonlyObjectDeferred(type, options = {}) {
  return Deferred("ReadonlyObject", [type], options);
}
function ReadonlyObject(type, options = {}) {
  return ReadonlyObjectAction(type, options);
}
var ReadonlyType = ReadonlyObject;

// node_modules/typebox/build/type/engine/readonly_object/from_array.mjs
function FromArray5(type) {
  const result = AddImmutable(_Array_(type));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_cyclic.mjs
function FromCyclic4(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType17(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_dependent.mjs
function FromDependent4(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_intersect.mjs
function FromIntersect4(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType17(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_object.mjs
function FromObject8(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: AddReadonly(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_tuple.mjs
function FromTuple4(types) {
  const result = AddImmutable(Tuple(types));
  return result;
}

// node_modules/typebox/build/type/engine/readonly_object/from_union.mjs
function FromUnion7(types) {
  const result = types.map((type) => FromType17(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/readonly_object/from_type.mjs
function FromType17(type) {
  return IsArray2(type) ? FromArray5(type.items) : IsCyclic(type) ? FromCyclic4(type.$defs, type.$ref) : IsDependent(type) ? FromDependent4(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect4(type.allOf) : IsObject2(type) ? FromObject8(type.properties) : IsTuple(type) ? FromTuple4(type.items) : IsUnion(type) ? FromUnion7(type.anyOf) : type;
}

// node_modules/typebox/build/type/engine/readonly_object/instantiate.mjs
function ReadonlyObjectAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType17(type), {}, options) : ReadonlyObjectDeferred(type);
  return result;
}
function ReadonlyObjectInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReadonlyObjectAction(instantiatedType, options);
}

// node_modules/typebox/build/type/engine/ref/instantiate.mjs
function RefInstantiate(context, state, type, ref) {
  return state.visited.includes(ref) ? type : ref in context ? InstantiateType(context, State(state["callstack"], [...state["visited"], ref]), context[ref]) : type;
}

// node_modules/typebox/build/type/engine/required/from_cyclic.mjs
function FromCyclic5(defs, ref) {
  const target = CyclicTarget(defs, ref);
  const partial = FromType18(target);
  const result = Cyclic(memory_exports.Assign(defs, { [ref]: partial }), ref);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_dependent.mjs
function FromDependent5(if_, then_, else_) {
  const evaluated = EvaluateDependent(if_, then_, else_);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_intersect.mjs
function FromIntersect5(types) {
  const evaluated = EvaluateIntersect(types);
  const result = FromType18(evaluated);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_union.mjs
function FromUnion8(types) {
  const result = types.map((type) => FromType18(type));
  return Union(result);
}

// node_modules/typebox/build/type/engine/required/from_object.mjs
function FromObject9(properties) {
  const mapped = guard_exports.Keys(properties).reduce((result2, left) => {
    return { ...result2, [left]: RemoveOptional(properties[left]) };
  }, {});
  const result = _Object_(mapped);
  return result;
}

// node_modules/typebox/build/type/engine/required/from_type.mjs
function FromType18(type) {
  return IsCyclic(type) ? FromCyclic5(type.$defs, type.$ref) : IsDependent(type) ? FromDependent5(type.if, type.then, type.else) : IsIntersect(type) ? FromIntersect5(type.allOf) : IsUnion(type) ? FromUnion8(type.anyOf) : IsObject2(type) ? FromObject9(type.properties) : _Object_({});
}

// node_modules/typebox/build/type/action/required.mjs
function RequiredDeferred(type, options = {}) {
  return Deferred("Required", [type], options);
}
function Required(type, options = {}) {
  return RequiredAction(type, options);
}

// node_modules/typebox/build/type/engine/required/instantiate.mjs
function RequiredAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(FromType18(type), {}, options) : RequiredDeferred(type, options);
  return result;
}
function RequiredInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return RequiredAction(instaniatedType, options);
}

// node_modules/typebox/build/type/action/return_type.mjs
function ReturnTypeDeferred(type, options = {}) {
  return Deferred("ReturnType", [type], options);
}
function ReturnType(type, options = {}) {
  return ReturnTypeAction(type, options);
}

// node_modules/typebox/build/type/engine/return_type/instantiate.mjs
function ReturnTypeOperation(type) {
  return IsFunction2(type) ? type["returnType"] : Never();
}
function ReturnTypeAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(ReturnTypeOperation(type), {}, options) : ReturnTypeDeferred(type, options);
  return result;
}
function ReturnTypeInstantiate(context, state, type, options = {}) {
  const instantiatedType = InstantiateType(context, state, type);
  return ReturnTypeAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/with.mjs
function WithDeferred(type, options) {
  return Deferred("With", [type, options], {});
}
function With2(type, options) {
  return WithAction(type, options);
}

// node_modules/typebox/build/type/engine/with/instantiate.mjs
function WithAction(type, options) {
  const result = CanInstantiate([type]) ? memory_exports.Update(type, {}, options) : WithDeferred(type, options);
  return result;
}
function WithInstantiate(context, state, type, options) {
  const instaniatedType = InstantiateType(context, state, type);
  return WithAction(instaniatedType, options);
}

// node_modules/typebox/build/type/engine/rest/spread.mjs
function SpreadElement(type) {
  const result = IsRest(type) ? IsTuple(type.items) ? RestSpread(type.items.items) : IsInfer(type.items) ? [type] : IsRef(type.items) ? [type] : [Never()] : [type];
  return result;
}
function RestSpread(types) {
  const result = types.reduce((result2, left) => {
    return [...result2, ...SpreadElement(left)];
  }, []);
  return result;
}

// node_modules/typebox/build/type/engine/instantiate.mjs
function State(callstack, visited2) {
  return { callstack, visited: visited2 };
}
function CanInstantiate(types) {
  return guard_exports.ShiftLeft(types, (left, right) => IsRef(left) ? false : CanInstantiate(right), () => true);
}
function InstantiateProperties(context, state, properties) {
  return guard_exports.Keys(properties).reduce((result, key) => {
    return { ...result, [key]: InstantiateType(context, state, properties[key]) };
  }, {});
}
function InstantiateElements(context, state, types) {
  const elements = InstantiateTypes(context, state, types);
  const result = RestSpread(elements);
  return result;
}
function InstantiateTypes(context, state, types) {
  return types.map((type) => InstantiateType(context, state, type));
}
function WithModifiers(type, instantiatedType) {
  const withOptional = IsOptional(type) ? AddOptionalAction(instantiatedType, {}) : instantiatedType;
  const withReadonly = IsReadonly(type) ? AddReadonlyAction(withOptional, {}) : withOptional;
  const withImmutable = IsImmutable(type) ? AddImmutableAction(withReadonly, {}) : withReadonly;
  return withImmutable;
}
function InstantiateDeferred(context, state, action, parameters, options) {
  return (
    // Modifiers
    guard_exports.IsEqual(action, "AddImmutable") ? AddImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveImmutable") ? RemoveImmutableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddReadonly") ? AddReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveReadonly") ? RemoveReadonlyInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "AddOptional") ? AddOptionalInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "RemoveOptional") ? RemoveOptionalInstantiate(context, state, parameters[0], options) : (
      // Actions
      guard_exports.IsEqual(action, "Capitalize") ? CapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Conditional") ? ConditionalInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "ConstructorParameters") ? ConstructorParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Evaluate") ? EvaluateInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Exclude") ? ExcludeInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Extract") ? ExtractInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Index") ? IndexInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "InstanceType") ? InstanceTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Interface") ? InterfaceInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "KeyOf") ? KeyOfInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Lowercase") ? LowercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Mapped") ? MappedInstantiate(context, state, parameters[0], parameters[1], parameters[2], parameters[3], options) : guard_exports.IsEqual(action, "Module") ? ModuleInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "NonNullable") ? NonNullableInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Pick") ? PickInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Parameters") ? ParametersInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Partial") ? PartialInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Omit") ? OmitInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "ReadonlyObject") ? ReadonlyObjectInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Record") ? RecordInstantiate(context, state, parameters[0], parameters[1], options) : guard_exports.IsEqual(action, "Required") ? RequiredInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "ReturnType") ? ReturnTypeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "TemplateLiteral") ? TemplateLiteralInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uncapitalize") ? UncapitalizeInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "Uppercase") ? UppercaseInstantiate(context, state, parameters[0], options) : guard_exports.IsEqual(action, "With") ? WithInstantiate(context, state, parameters[0], parameters[1]) : Deferred(action, parameters, options)
    )
  );
}
function InstantiateImmediate(context, state, type) {
  const instantiatedType = IsRef(type) ? RefInstantiate(context, state, type, type.$ref) : IsArray2(type) ? _Array_(InstantiateType(context, state, type.items), ArrayOptions(type)) : IsCall(type) ? CallInstantiate(context, state, type.target, type.arguments) : IsConstructor2(type) ? Constructor(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.instanceType), ConstructorOptions(type)) : IsFunction2(type) ? _Function_(InstantiateTypes(context, state, type.parameters), InstantiateType(context, state, type.returnType), FunctionOptions(type)) : IsDependent(type) ? Dependent(InstantiateType(context, state, type.if), InstantiateType(context, state, type.then), InstantiateType(context, state, type.else), DependentOptions(type)) : IsIntersect(type) ? Intersect(InstantiateTypes(context, state, type.allOf), IntersectOptions(type)) : IsObject2(type) ? _Object_(InstantiateProperties(context, state, type.properties), ObjectOptions(type)) : IsRecord(type) ? RecordFromPattern(RecordPattern(type), InstantiateType(context, state, RecordValue(type))) : IsRest(type) ? Rest(InstantiateType(context, state, type.items)) : IsTuple(type) ? Tuple(InstantiateElements(context, state, type.items), TupleOptions(type)) : IsUnion(type) ? Union(InstantiateTypes(context, state, type.anyOf), UnionOptions(type)) : type;
  const withModifiers = WithModifiers(type, instantiatedType);
  return withModifiers;
}
function InstantiateType(context, state, type) {
  const result = IsDeferred(type) ? InstantiateDeferred(context, state, type.action, type.parameters, type.options) : InstantiateImmediate(context, state, type);
  return result;
}
function Instantiate(context, type) {
  return InstantiateType(context, State([], []), type);
}

// node_modules/typebox/build/type/engine/immutable/instantiate_add.mjs
function AddImmutableOperation(type) {
  return memory_exports.Update(type, { "~immutable": true }, {});
}
function AddImmutableAction(type, options) {
  const result = memory_exports.Update(AddImmutableOperation(type), {}, options);
  return result;
}
function AddImmutableInstantiate(context, state, type, options) {
  const instantiatedType = InstantiateType(context, state, type);
  return AddImmutableAction(instantiatedType, options);
}

// node_modules/typebox/build/type/action/_add_immutable.mjs
function AddImmutableDeferred(type, options = {}) {
  return Deferred("AddImmutable", [type], options);
}
function AddImmutable(type, options = {}) {
  return AddImmutableAction(type, options);
}

// node_modules/typebox/build/type/action/evaluate.mjs
function EvaluateDeferred(type, options = {}) {
  return Deferred("Evaluate", [type], options);
}
function Evaluate(type, options = {}) {
  return EvaluateAction(type, options);
}

// node_modules/typebox/build/type/action/module.mjs
function ModuleDeferred(declarations, options = {}) {
  return Deferred("Module", [declarations], options);
}
function Module2(declarations, options = {}) {
  return ModuleInstantiate({}, State([], []), declarations, options);
}

// node_modules/typebox/build/type/engine/priority/priority.mjs
function Comparer(left, right) {
  const compareResult = Compare(left, right);
  const result = guard_exports.IsEqual(compareResult, "right-inside") ? 1 : guard_exports.IsEqual(compareResult, "disjoint") ? 1 : 0;
  return result;
}
function Insert(type, types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => guard_exports.IsEqual(Comparer(type, left), 1) ? Insert(type, right, [...result, left]) : [...result, type, ...types], () => [...result, type]);
}
function Sort(types, result = []) {
  return guard_exports.ShiftLeft(types, (left, right) => Sort(right, Insert(left, result)), () => result);
}
function Priority(types) {
  const result = Sort(types);
  return result;
}

// node_modules/typebox/build/type/script/script.mjs
function Script2(...args) {
  const [context, input, options] = arguments_exports.Match(args, {
    2: (script, options2) => guard_exports.IsString(script) ? [{}, script, options2] : [script, options2, {}],
    3: (context2, script, options2) => [context2, script, options2],
    1: (script) => [{}, script, {}]
  });
  const result = Script(input);
  const parsed = guard_exports.IsArray(result) && guard_exports.IsEqual(result.length, 2) ? InstantiateType(context, State([], []), result[0]) : Never();
  return memory_exports.Update(parsed, {}, options);
}

// node_modules/typebox/build/typebox.mjs
var typebox_exports = {};
__export(typebox_exports, {
  Any: () => Any,
  Array: () => _Array_,
  BigInt: () => BigInt2,
  Boolean: () => Boolean2,
  Call: () => Call,
  Capitalize: () => Capitalize,
  Codec: () => Codec,
  Conditional: () => Conditional,
  Constructor: () => Constructor,
  ConstructorParameters: () => ConstructorParameters,
  Cyclic: () => Cyclic,
  Decode: () => Decode,
  DecodeBuilder: () => DecodeBuilder,
  Dependent: () => Dependent,
  Encode: () => Encode,
  EncodeBuilder: () => EncodeBuilder,
  Enum: () => Enum,
  Evaluate: () => Evaluate,
  Exclude: () => Exclude,
  Extends: () => Extends,
  ExtendsResult: () => result_exports,
  Extract: () => Extract,
  Function: () => _Function_,
  Generic: () => Generic,
  Identifier: () => Identifier,
  Immutable: () => Immutable,
  Index: () => Index,
  Infer: () => Infer,
  InstanceType: () => InstanceType,
  Instantiate: () => Instantiate,
  Integer: () => Integer,
  Interface: () => Interface,
  Intersect: () => Intersect,
  IsAny: () => IsAny,
  IsArray: () => IsArray2,
  IsBigInt: () => IsBigInt2,
  IsBoolean: () => IsBoolean3,
  IsCall: () => IsCall,
  IsCodec: () => IsCodec,
  IsConstructor: () => IsConstructor2,
  IsCyclic: () => IsCyclic,
  IsDependent: () => IsDependent,
  IsEnum: () => IsEnum,
  IsEnumValue: () => IsEnumValue,
  IsFunction: () => IsFunction2,
  IsGeneric: () => IsGeneric,
  IsIdentifier: () => IsIdentifier,
  IsImmutable: () => IsImmutable,
  IsInfer: () => IsInfer,
  IsInteger: () => IsInteger2,
  IsIntersect: () => IsIntersect,
  IsKind: () => IsKind,
  IsLiteral: () => IsLiteral,
  IsNever: () => IsNever,
  IsNull: () => IsNull2,
  IsNumber: () => IsNumber3,
  IsObject: () => IsObject2,
  IsOptional: () => IsOptional,
  IsParameter: () => IsParameter,
  IsReadonly: () => IsReadonly,
  IsRecord: () => IsRecord,
  IsRef: () => IsRef,
  IsRefine: () => IsRefine,
  IsRest: () => IsRest,
  IsSchema: () => IsSchema,
  IsString: () => IsString3,
  IsSymbol: () => IsSymbol2,
  IsTemplateLiteral: () => IsTemplateLiteral,
  IsThis: () => IsThis,
  IsTuple: () => IsTuple,
  IsUndefined: () => IsUndefined2,
  IsUnion: () => IsUnion,
  IsUnknown: () => IsUnknown,
  IsUnsafe: () => IsUnsafe,
  IsVoid: () => IsVoid,
  KeyOf: () => KeyOf2,
  Literal: () => Literal,
  Lowercase: () => Lowercase,
  Mapped: () => Mapped,
  Module: () => Module2,
  Never: () => Never,
  NonNullable: () => NonNullable,
  Null: () => Null,
  Number: () => Number2,
  Object: () => _Object_,
  Omit: () => Omit,
  Optional: () => Optional,
  Parameter: () => Parameter,
  Parameters: () => Parameters,
  Partial: () => Partial,
  Pick: () => Pick,
  Readonly: () => Readonly,
  ReadonlyObject: () => ReadonlyObject,
  ReadonlyType: () => ReadonlyType,
  Record: () => Record,
  RecordKey: () => RecordKey,
  RecordPattern: () => RecordPattern,
  RecordValue: () => RecordValue,
  Ref: () => Ref,
  Refine: () => Refine,
  Required: () => Required,
  Rest: () => Rest,
  ReturnType: () => ReturnType,
  Script: () => Script2,
  String: () => String2,
  Symbol: () => Symbol2,
  TemplateLiteral: () => TemplateLiteral2,
  This: () => This,
  Tuple: () => Tuple,
  Uncapitalize: () => Uncapitalize,
  Undefined: () => Undefined,
  Union: () => Union,
  Unknown: () => Unknown,
  Unsafe: () => Unsafe,
  Uppercase: () => Uppercase,
  Void: () => Void,
  With: () => With2
});

// node_modules/typebox/build/schema/types/_refine.mjs
function IsRefine2(value) {
  return guard_exports.HasPropertyKey(value, "~refine") && guard_exports.IsArray(value["~refine"]) && guard_exports.Every(value["~refine"], 0, (value2) => guard_exports.IsObject(value2) && guard_exports.HasPropertyKey(value2, "check") && guard_exports.HasPropertyKey(value2, "error") && guard_exports.IsFunction(value2.check) && guard_exports.IsFunction(value2.error));
}

// node_modules/typebox/build/schema/types/schema.mjs
function IsSchemaObject(value) {
  return guard_exports.IsObject(value) && !guard_exports.IsArray(value);
}
function IsSchemaBoolean(value) {
  return guard_exports.IsBoolean(value);
}
function IsSchema2(value) {
  return IsSchemaObject(value) || IsSchemaBoolean(value);
}

// node_modules/typebox/build/schema/types/additionalItems.mjs
function IsAdditionalItems(schema) {
  return guard_exports.HasPropertyKey(schema, "additionalItems") && IsSchema2(schema.additionalItems);
}

// node_modules/typebox/build/schema/types/additionalProperties.mjs
function IsAdditionalProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "additionalProperties") && IsSchema2(schema.additionalProperties);
}

// node_modules/typebox/build/schema/types/allOf.mjs
function IsAllOf(schema) {
  return guard_exports.HasPropertyKey(schema, "allOf") && guard_exports.IsArray(schema.allOf) && schema.allOf.every((value) => IsSchema2(value));
}

// node_modules/typebox/build/schema/types/anchor.mjs
function IsAnchor(schema) {
  return guard_exports.HasPropertyKey(schema, "$anchor") && guard_exports.IsString(schema.$anchor);
}

// node_modules/typebox/build/schema/types/anyOf.mjs
function IsAnyOf(schema) {
  return guard_exports.HasPropertyKey(schema, "anyOf") && guard_exports.IsArray(schema.anyOf) && schema.anyOf.every((value) => IsSchema2(value));
}

// node_modules/typebox/build/schema/types/const.mjs
function IsConst(value) {
  return guard_exports.HasPropertyKey(value, "const");
}

// node_modules/typebox/build/schema/types/contains.mjs
function IsContains(schema) {
  return guard_exports.HasPropertyKey(schema, "contains") && IsSchema2(schema.contains);
}

// node_modules/typebox/build/schema/types/default.mjs
function IsDefault(schema) {
  return guard_exports.HasPropertyKey(schema, "default");
}

// node_modules/typebox/build/schema/types/dependencies.mjs
function IsDependencies(schema) {
  return guard_exports.HasPropertyKey(schema, "dependencies") && guard_exports.IsObject(schema.dependencies) && Object.values(schema.dependencies).every((value) => IsSchema2(value) || guard_exports.IsArray(value) && value.every((value2) => guard_exports.IsString(value2)));
}

// node_modules/typebox/build/schema/types/dependentRequired.mjs
function IsDependentRequired(schema) {
  return guard_exports.HasPropertyKey(schema, "dependentRequired") && guard_exports.IsObject(schema.dependentRequired) && Object.values(schema.dependentRequired).every((value) => guard_exports.IsArray(value) && value.every((value2) => guard_exports.IsString(value2)));
}

// node_modules/typebox/build/schema/types/dependentSchemas.mjs
function IsDependentSchemas(schema) {
  return guard_exports.HasPropertyKey(schema, "dependentSchemas") && guard_exports.IsObject(schema.dependentSchemas) && Object.values(schema.dependentSchemas).every((value) => IsSchema2(value));
}

// node_modules/typebox/build/schema/types/dynamicAnchor.mjs
function IsDynamicAnchor(schema) {
  return guard_exports.HasPropertyKey(schema, "$dynamicAnchor") && guard_exports.IsString(schema.$dynamicAnchor);
}

// node_modules/typebox/build/schema/types/dynamicRef.mjs
function IsDynamicRef(schema) {
  return guard_exports.HasPropertyKey(schema, "$dynamicRef") && guard_exports.IsString(schema.$dynamicRef);
}

// node_modules/typebox/build/schema/types/else.mjs
function IsElse(schema) {
  return guard_exports.HasPropertyKey(schema, "else") && IsSchema2(schema.else);
}

// node_modules/typebox/build/schema/types/enum.mjs
function IsEnum2(schema) {
  return guard_exports.HasPropertyKey(schema, "enum") && guard_exports.IsArray(schema.enum);
}

// node_modules/typebox/build/schema/types/exclusiveMaximum.mjs
function IsExclusiveMaximum(schema) {
  return guard_exports.HasPropertyKey(schema, "exclusiveMaximum") && (guard_exports.IsNumber(schema.exclusiveMaximum) || guard_exports.IsBigInt(schema.exclusiveMaximum));
}

// node_modules/typebox/build/schema/types/exclusiveMinimum.mjs
function IsExclusiveMinimum(schema) {
  return guard_exports.HasPropertyKey(schema, "exclusiveMinimum") && (guard_exports.IsNumber(schema.exclusiveMinimum) || guard_exports.IsBigInt(schema.exclusiveMinimum));
}

// node_modules/typebox/build/schema/types/format.mjs
function IsFormat(schema) {
  return guard_exports.HasPropertyKey(schema, "format") && guard_exports.IsString(schema.format);
}

// node_modules/typebox/build/schema/types/id.mjs
function IsId(schema) {
  return guard_exports.HasPropertyKey(schema, "$id") && guard_exports.IsString(schema.$id);
}

// node_modules/typebox/build/schema/types/if.mjs
function IsIf(schema) {
  return guard_exports.HasPropertyKey(schema, "if") && IsSchema2(schema.if);
}

// node_modules/typebox/build/schema/types/items.mjs
function IsItems(schema) {
  return guard_exports.HasPropertyKey(schema, "items") && (IsSchema2(schema.items) || guard_exports.IsArray(schema.items) && schema.items.every((value) => {
    return IsSchema2(value);
  }));
}
function IsItemsSized(schema) {
  return IsItems(schema) && guard_exports.IsArray(schema.items);
}

// node_modules/typebox/build/schema/types/maximum.mjs
function IsMaximum(schema) {
  return guard_exports.HasPropertyKey(schema, "maximum") && (guard_exports.IsNumber(schema.maximum) || guard_exports.IsBigInt(schema.maximum));
}

// node_modules/typebox/build/schema/types/maxContains.mjs
function IsMaxContains(schema) {
  return guard_exports.HasPropertyKey(schema, "maxContains") && guard_exports.IsNumber(schema.maxContains);
}

// node_modules/typebox/build/schema/types/maxItems.mjs
function IsMaxItems(schema) {
  return guard_exports.HasPropertyKey(schema, "maxItems") && guard_exports.IsNumber(schema.maxItems);
}

// node_modules/typebox/build/schema/types/maxLength.mjs
function IsMaxLength3(schema) {
  return guard_exports.HasPropertyKey(schema, "maxLength") && guard_exports.IsNumber(schema.maxLength);
}

// node_modules/typebox/build/schema/types/maxProperties.mjs
function IsMaxProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "maxProperties") && guard_exports.IsNumber(schema.maxProperties);
}

// node_modules/typebox/build/schema/types/minimum.mjs
function IsMinimum(schema) {
  return guard_exports.HasPropertyKey(schema, "minimum") && (guard_exports.IsNumber(schema.minimum) || guard_exports.IsBigInt(schema.minimum));
}

// node_modules/typebox/build/schema/types/minContains.mjs
function IsMinContains(schema) {
  return guard_exports.HasPropertyKey(schema, "minContains") && guard_exports.IsNumber(schema.minContains);
}

// node_modules/typebox/build/schema/types/minItems.mjs
function IsMinItems(schema) {
  return guard_exports.HasPropertyKey(schema, "minItems") && guard_exports.IsNumber(schema.minItems);
}

// node_modules/typebox/build/schema/types/minLength.mjs
function IsMinLength3(schema) {
  return guard_exports.HasPropertyKey(schema, "minLength") && guard_exports.IsNumber(schema.minLength);
}

// node_modules/typebox/build/schema/types/minProperties.mjs
function IsMinProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "minProperties") && guard_exports.IsNumber(schema.minProperties);
}

// node_modules/typebox/build/schema/types/multipleOf.mjs
function IsMultipleOf2(schema) {
  return guard_exports.HasPropertyKey(schema, "multipleOf") && (guard_exports.IsNumber(schema.multipleOf) || guard_exports.IsBigInt(schema.multipleOf));
}

// node_modules/typebox/build/schema/types/not.mjs
function IsNot(schema) {
  return guard_exports.HasPropertyKey(schema, "not") && IsSchema2(schema.not);
}

// node_modules/typebox/build/schema/types/oneOf.mjs
function IsOneOf(schema) {
  return guard_exports.HasPropertyKey(schema, "oneOf") && guard_exports.IsArray(schema.oneOf) && schema.oneOf.every((value) => IsSchema2(value));
}

// node_modules/typebox/build/schema/types/pattern.mjs
function IsPattern(schema) {
  return guard_exports.HasPropertyKey(schema, "pattern") && (guard_exports.IsString(schema.pattern) || schema.pattern instanceof RegExp);
}

// node_modules/typebox/build/schema/types/patternProperties.mjs
function IsPatternProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "patternProperties") && guard_exports.IsObject(schema.patternProperties) && Object.values(schema.patternProperties).every((value) => IsSchema2(value));
}

// node_modules/typebox/build/schema/types/prefixItems.mjs
function IsPrefixItems(schema) {
  return guard_exports.HasPropertyKey(schema, "prefixItems") && guard_exports.IsArray(schema.prefixItems) && schema.prefixItems.every((schema2) => IsSchema2(schema2));
}

// node_modules/typebox/build/schema/types/properties.mjs
function IsProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "properties") && guard_exports.IsObject(schema.properties) && Object.values(schema.properties).every((value) => IsSchema2(value));
}

// node_modules/typebox/build/schema/types/propertyNames.mjs
function IsPropertyNames(schema) {
  return guard_exports.HasPropertyKey(schema, "propertyNames") && (guard_exports.IsObject(schema.propertyNames) || IsSchema2(schema.propertyNames));
}

// node_modules/typebox/build/schema/types/recursiveAnchor.mjs
function IsRecursiveAnchor(schema) {
  return guard_exports.HasPropertyKey(schema, "$recursiveAnchor") && guard_exports.IsBoolean(schema.$recursiveAnchor);
}
function IsRecursiveAnchorTrue(schema) {
  return IsRecursiveAnchor(schema) && guard_exports.IsEqual(schema.$recursiveAnchor, true);
}

// node_modules/typebox/build/schema/types/recursiveRef.mjs
function IsRecursiveRef(schema) {
  return guard_exports.HasPropertyKey(schema, "$recursiveRef") && guard_exports.IsString(schema.$recursiveRef);
}

// node_modules/typebox/build/schema/types/ref.mjs
function IsRef2(schema) {
  return guard_exports.HasPropertyKey(schema, "$ref") && guard_exports.IsString(schema.$ref);
}

// node_modules/typebox/build/schema/types/required.mjs
function IsRequired(schema) {
  return guard_exports.HasPropertyKey(schema, "required") && guard_exports.IsArray(schema.required) && schema.required.every((value) => guard_exports.IsString(value));
}

// node_modules/typebox/build/schema/types/then.mjs
function IsThen(schema) {
  return guard_exports.HasPropertyKey(schema, "then") && IsSchema2(schema.then);
}

// node_modules/typebox/build/schema/types/type.mjs
function IsType(schema) {
  return guard_exports.HasPropertyKey(schema, "type") && (guard_exports.IsString(schema.type) || guard_exports.IsArray(schema.type) && schema.type.every((value) => guard_exports.IsString(value)));
}

// node_modules/typebox/build/schema/types/uniqueItems.mjs
function IsUniqueItems(schema) {
  return guard_exports.HasPropertyKey(schema, "uniqueItems") && guard_exports.IsBoolean(schema.uniqueItems);
}

// node_modules/typebox/build/schema/types/unevaluatedItems.mjs
function IsUnevaluatedItems(schema) {
  return guard_exports.HasPropertyKey(schema, "unevaluatedItems") && IsSchema2(schema.unevaluatedItems);
}

// node_modules/typebox/build/schema/types/unevaluatedProperties.mjs
function IsUnevaluatedProperties(schema) {
  return guard_exports.HasPropertyKey(schema, "unevaluatedProperties") && IsSchema2(schema.unevaluatedProperties);
}

// node_modules/typebox/build/schema/engine/_context.mjs
var CheckContext = class {
  constructor() {
    const indices = /* @__PURE__ */ new Set();
    const keys = /* @__PURE__ */ new Set();
    this.stack = [{ indices, keys }];
  }
  // ----------------------------------------------------------------
  // Stack
  // ----------------------------------------------------------------
  Push() {
    const indices = /* @__PURE__ */ new Set();
    const keys = /* @__PURE__ */ new Set();
    this.stack.push({ indices, keys });
    return true;
  }
  Pop() {
    this.stack.pop();
    return true;
  }
  // ----------------------------------------------------------------
  // Top
  // ----------------------------------------------------------------
  AddIndex(index) {
    this.GetIndices().add(index);
    return true;
  }
  AddKey(key) {
    this.GetKeys().add(key);
    return true;
  }
  GetIndices() {
    const top = this.stack[this.stack.length - 1];
    return top.indices;
  }
  GetKeys() {
    const top = this.stack[this.stack.length - 1];
    return top.keys;
  }
  Merge(results) {
    for (const context of results) {
      context.GetIndices().forEach((value) => this.GetIndices().add(value));
      context.GetKeys().forEach((value) => this.GetKeys().add(value));
    }
    return true;
  }
};
var ErrorContext = class extends CheckContext {
  constructor(callback) {
    super();
    this.callback = callback;
  }
  AddError(error) {
    this.callback(error);
    return false;
  }
};
var AccumulatedErrorContext = class extends ErrorContext {
  constructor() {
    super((error) => this.errors.push(error));
    this.errors = [];
  }
  AddError(error) {
    this.errors.push(error);
    return false;
  }
  GetErrors() {
    return this.errors;
  }
};

// node_modules/typebox/build/schema/engine/_refine.mjs
function CheckRefine(_stack, _context, schema, value) {
  return guard_exports.Every(schema["~refine"], 0, (refinement, _) => refinement.check(value));
}
function ErrorRefine(_stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.EveryAll(schema["~refine"], 0, (refinement, index) => {
    return refinement.check(value) || context.AddError({
      keyword: "~refine",
      schemaPath,
      instancePath,
      params: { index, message: refinement.error(value) }
    });
  });
}

// node_modules/typebox/build/schema/engine/additionalItems.mjs
function IsValid(schema) {
  return IsItems(schema) && guard_exports.IsArray(schema.items);
}
function CheckAdditionalItems(stack, context, schema, value) {
  if (!IsValid(schema))
    return true;
  const isAdditionalItems = value.every((item, index) => {
    return guard_exports.IsLessThan(index, schema.items.length) || CheckSchemaPushStack(stack, context, schema.additionalItems, item) && context.AddIndex(index);
  });
  return isAdditionalItems;
}
function ErrorAdditionalItems(stack, context, schemaPath, instancePath, schema, value) {
  if (!IsValid(schema))
    return true;
  const isAdditionalItems = value.every((item, index) => {
    const nextSchemaPath = `${schemaPath}/additionalItems`;
    const nextInstancePath = `${instancePath}/${index}`;
    return guard_exports.IsLessThan(index, schema.items.length) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema.additionalItems, item) && context.AddIndex(index);
  });
  return isAdditionalItems;
}

// node_modules/typebox/build/schema/engine/additionalProperties.mjs
function GetPropertyKeyAsPattern(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}$`;
}
function GetPropertiesPattern(schema) {
  const patterns = [];
  if (IsPatternProperties(schema))
    patterns.push(...guard_exports.Keys(schema.patternProperties));
  if (IsProperties(schema))
    patterns.push(...guard_exports.Keys(schema.properties).map(GetPropertyKeyAsPattern));
  return guard_exports.IsEqual(patterns.length, 0) ? "(?!)" : `(${patterns.join("|")})`;
}
function CheckAdditionalProperties(stack, context, schema, value) {
  const regexp = new RegExp(GetPropertiesPattern(schema));
  const isAdditionalProperties = guard_exports.Every(guard_exports.Keys(value), 0, (key, _index) => {
    return regexp.test(key) || CheckSchemaPushStack(stack, context, schema.additionalProperties, value[key]) && context.AddKey(key);
  });
  return isAdditionalProperties;
}
function ErrorAdditionalProperties(stack, context, schemaPath, instancePath, schema, value) {
  const regexp = new RegExp(GetPropertiesPattern(schema));
  const additionalProperties = [];
  const isAdditionalProperties = guard_exports.EveryAll(guard_exports.Keys(value), 0, (key, _index) => {
    const nextSchemaPath = `${schemaPath}/additionalProperties`;
    const nextInstancePath = `${instancePath}/${key}`;
    const nextContext = new AccumulatedErrorContext();
    const isAdditionalProperty = regexp.test(key) || ErrorSchemaPushStack(stack, nextContext, nextSchemaPath, nextInstancePath, schema.additionalProperties, value[key]) && context.AddKey(key);
    if (!isAdditionalProperty)
      additionalProperties.push(key);
    return isAdditionalProperty;
  });
  return isAdditionalProperties || context.AddError({
    keyword: "additionalProperties",
    schemaPath,
    instancePath,
    params: { additionalProperties }
  });
}

// node_modules/typebox/build/schema/engine/allOf.mjs
function CheckAllOf(stack, context, schema, value) {
  const results = schema.allOf.reduce((result, schema2) => {
    const nextContext = new CheckContext();
    return CheckSchema(stack, nextContext, schema2, value) ? [...result, nextContext] : result;
  }, []);
  return guard_exports.IsEqual(results.length, schema.allOf.length) && context.Merge(results);
}
function ErrorAllOf(stack, context, schemaPath, instancePath, schema, value) {
  const failedContexts = [];
  const results = schema.allOf.reduce((result, schema2, index) => {
    const nextSchemaPath = `${schemaPath}/allOf/${index}`;
    const nextContext = new AccumulatedErrorContext();
    const isSchema = ErrorSchema(stack, nextContext, nextSchemaPath, instancePath, schema2, value);
    if (!isSchema)
      failedContexts.push(nextContext);
    return isSchema ? [...result, nextContext] : result;
  }, []);
  const isAllOf = guard_exports.IsEqual(results.length, schema.allOf.length) && context.Merge(results);
  if (!isAllOf)
    failedContexts.forEach((failed) => failed.GetErrors().forEach((error) => context.AddError(error)));
  return isAllOf;
}

// node_modules/typebox/build/schema/engine/anyOf.mjs
function CheckAnyOf(stack, context, schema, value) {
  const results = schema.anyOf.reduce((result, schema2) => {
    const nextContext = new CheckContext();
    return CheckSchema(stack, nextContext, schema2, value) ? [...result, nextContext] : result;
  }, []);
  return guard_exports.IsGreaterThan(results.length, 0) && context.Merge(results);
}
function ErrorAnyOf(stack, context, schemaPath, instancePath, schema, value) {
  const failedContexts = [];
  const results = schema.anyOf.reduce((result, schema2, index) => {
    const nextContext = new AccumulatedErrorContext();
    const nextSchemaPath = `${schemaPath}/anyOf/${index}`;
    const isSchema = ErrorSchema(stack, nextContext, nextSchemaPath, instancePath, schema2, value);
    if (!isSchema)
      failedContexts.push(nextContext);
    return isSchema ? [...result, nextContext] : result;
  }, []);
  const isAnyOf = guard_exports.IsGreaterThan(results.length, 0) && context.Merge(results);
  if (!isAnyOf)
    failedContexts.forEach((failed) => failed.GetErrors().forEach((error) => context.AddError(error)));
  return isAnyOf || context.AddError({
    keyword: "anyOf",
    schemaPath,
    instancePath,
    params: {}
  });
}

// node_modules/typebox/build/schema/engine/boolean.mjs
function CheckSchemaBoolean(_stack, _context, schema, _value) {
  return schema;
}
function ErrorSchemaBoolean(stack, context, schemaPath, instancePath, schema, value) {
  return CheckSchemaBoolean(stack, context, schema, value) || context.AddError({
    keyword: "boolean",
    schemaPath,
    instancePath,
    params: {}
  });
}

// node_modules/typebox/build/schema/engine/const.mjs
function CheckConst(_stack, _context, schema, value) {
  return guard_exports.IsValueLike(schema.const) ? guard_exports.IsEqual(value, schema.const) : guard_exports.IsDeepEqual(value, schema.const);
}
function ErrorConst(stack, context, schemaPath, instancePath, schema, value) {
  return CheckConst(stack, context, schema, value) || context.AddError({
    keyword: "const",
    schemaPath,
    instancePath,
    params: { allowedValue: schema.const }
  });
}

// node_modules/typebox/build/schema/engine/contains.mjs
function IsValid2(schema) {
  return !(IsMinContains(schema) && guard_exports.IsEqual(schema.minContains, 0));
}
function CheckContains(stack, context, schema, value) {
  if (!IsValid2(schema))
    return true;
  return !guard_exports.IsEqual(value.length, 0) && value.some((item) => CheckSchema(stack, context, schema.contains, item));
}
function ErrorContains(stack, context, schemaPath, instancePath, schema, value) {
  return CheckContains(stack, context, schema, value) || context.AddError({
    keyword: "contains",
    schemaPath,
    instancePath,
    params: { minContains: 1 }
  });
}

// node_modules/typebox/build/schema/engine/dependencies.mjs
function CheckDependencies(stack, context, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.Every(guard_exports.Entries(schema.dependencies), 0, ([key, schema2]) => {
    return !guard_exports.HasPropertyKey(value, key) || (guard_exports.IsArray(schema2) ? schema2.every((key2) => guard_exports.HasPropertyKey(value, key2)) : CheckSchema(stack, context, schema2, value));
  });
  return isLength || isEvery;
}
function ErrorDependencies(stack, context, schemaPath, instancePath, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.EveryAll(guard_exports.Entries(schema.dependencies), 0, ([key, schema2]) => {
    const nextSchemaPath = `${schemaPath}/dependencies/${key}`;
    return !guard_exports.HasPropertyKey(value, key) || (guard_exports.IsArray(schema2) ? schema2.every((dependency) => guard_exports.HasPropertyKey(value, dependency) || context.AddError({
      keyword: "dependencies",
      schemaPath,
      instancePath,
      params: { property: key, dependencies: schema2 }
    })) : ErrorSchema(stack, context, nextSchemaPath, instancePath, schema2, value));
  });
  return isLength || isEvery;
}

// node_modules/typebox/build/schema/engine/dependentRequired.mjs
function CheckDependentRequired(_stack, _context, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.Every(guard_exports.Entries(schema.dependentRequired), 0, ([key, keys]) => {
    return !guard_exports.HasPropertyKey(value, key) || keys.every((key2) => guard_exports.HasPropertyKey(value, key2));
  });
  return isLength || isEvery;
}
function ErrorDependentRequired(_stack, context, schemaPath, instancePath, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEveryEntry = guard_exports.EveryAll(guard_exports.Entries(schema.dependentRequired), 0, ([key, keys]) => {
    return !guard_exports.HasPropertyKey(value, key) || guard_exports.EveryAll(keys, 0, (dependency) => guard_exports.HasPropertyKey(value, dependency) || context.AddError({
      keyword: "dependentRequired",
      schemaPath,
      instancePath,
      params: { property: key, dependencies: keys }
    }));
  });
  return isLength || isEveryEntry;
}

// node_modules/typebox/build/schema/engine/dependentSchemas.mjs
function CheckDependentSchemas(stack, context, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.Every(guard_exports.Entries(schema.dependentSchemas), 0, ([key, schema2]) => {
    return !guard_exports.HasPropertyKey(value, key) || CheckSchema(stack, context, schema2, value);
  });
  return isLength || isEvery;
}
function ErrorDependentSchemas(stack, context, schemaPath, instancePath, schema, value) {
  const isLength = guard_exports.IsEqual(guard_exports.Keys(value).length, 0);
  const isEvery = guard_exports.EveryAll(guard_exports.Entries(schema.dependentSchemas), 0, ([key, schema2]) => {
    const nextSchemaPath = `${schemaPath}/dependentSchemas/${key}`;
    return !guard_exports.HasPropertyKey(value, key) || ErrorSchema(stack, context, nextSchemaPath, instancePath, schema2, value);
  });
  return isLength || isEvery;
}

// node_modules/typebox/build/schema/engine/dynamicRef.mjs
function CheckDynamicRef(stack, context, schema, value) {
  const target = stack.DynamicRef(schema) ?? false;
  return IsSchema2(target) && CheckSchema(stack, context, target, value);
}
function ErrorDynamicRef(stack, context, _schemaPath, instancePath, schema, value) {
  const target = stack.DynamicRef(schema) ?? false;
  return IsSchema2(target) && ErrorSchema(stack, context, "#", instancePath, target, value);
}

// node_modules/typebox/build/schema/engine/enum.mjs
function CheckEnum(_stack, _context, schema, value) {
  return schema.enum.some((option) => guard_exports.IsValueLike(option) ? guard_exports.IsEqual(value, option) : guard_exports.IsDeepEqual(value, option));
}
function ErrorEnum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckEnum(stack, context, schema, value) || context.AddError({
    keyword: "enum",
    schemaPath,
    instancePath,
    params: { allowedValues: schema.enum }
  });
}

// node_modules/typebox/build/schema/engine/exclusiveMaximum.mjs
function CheckExclusiveMaximum(_stack, _context, schema, value) {
  return guard_exports.IsLessThan(value, schema.exclusiveMaximum);
}
function ErrorExclusiveMaximum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckExclusiveMaximum(stack, context, schema, value) || context.AddError({
    keyword: "exclusiveMaximum",
    schemaPath,
    instancePath,
    params: { comparison: "<", limit: schema.exclusiveMaximum }
  });
}

// node_modules/typebox/build/schema/engine/exclusiveMinimum.mjs
function CheckExclusiveMinimum(_stack, _context, schema, value) {
  return guard_exports.IsGreaterThan(value, schema.exclusiveMinimum);
}
function ErrorExclusiveMinimum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckExclusiveMinimum(stack, context, schema, value) || context.AddError({
    keyword: "exclusiveMinimum",
    schemaPath,
    instancePath,
    params: { comparison: ">", limit: schema.exclusiveMinimum }
  });
}

// node_modules/typebox/build/format/format.mjs
var format_exports = {};
__export(format_exports, {
  Clear: () => Clear,
  Entries: () => Entries2,
  Get: () => Get3,
  Has: () => Has,
  IsDate: () => IsDate2,
  IsDateTime: () => IsDateTime,
  IsDuration: () => IsDuration,
  IsEmail: () => IsEmail,
  IsHostname: () => IsHostname,
  IsIPv4: () => IsIPv4,
  IsIPv6: () => IsIPv6,
  IsIdnEmail: () => IsIdnEmail,
  IsIdnHostname: () => IsIdnHostname,
  IsIri: () => IsIri,
  IsIriReference: () => IsIriReference,
  IsJsonPointer: () => IsJsonPointer,
  IsJsonPointerUriFragment: () => IsJsonPointerUriFragment,
  IsRegex: () => IsRegex,
  IsRelativeJsonPointer: () => IsRelativeJsonPointer,
  IsTime: () => IsTime,
  IsUri: () => IsUri,
  IsUriReference: () => IsUriReference,
  IsUriTemplate: () => IsUriTemplate,
  IsUrl: () => IsUrl,
  IsUuid: () => IsUuid,
  Reset: () => Reset2,
  Set: () => Set3,
  Test: () => Test
});

// node_modules/typebox/build/format/date.mjs
var DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
var DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
function IsLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function IsDate2(value) {
  const matches = DATE.exec(value);
  if (!matches)
    return false;
  const year = +matches[1];
  const month = +matches[2];
  const day = +matches[3];
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && IsLeapYear(year) ? 29 : DAYS[month]);
}

// node_modules/typebox/build/format/time.mjs
var TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(?:Z|([+-])(\d\d):(\d\d))?$/i;
function IsTime(value, strictTimeZone = true) {
  const matches = TIME.exec(value);
  if (!matches)
    return false;
  const hr = +matches[1];
  const min = +matches[2];
  const sec = +matches[3];
  const tzSign = matches[4] === "-" ? -1 : 1;
  const tzH = +(matches[5] || 0);
  const tzM = +(matches[6] || 0);
  if (tzH > 23 || tzM > 59)
    return false;
  if (strictTimeZone && !matches[4] && value.toLowerCase().indexOf("z") === -1) {
    return false;
  }
  if (hr <= 23 && min <= 59 && sec < 60)
    return true;
  const utcMin = min - tzM * tzSign;
  const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
  return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
}

// node_modules/typebox/build/format/date_time.mjs
function IsDateTime(value, strictTimeZone = true) {
  const dateTime = value.split(/T/i);
  return dateTime.length === 2 && IsDate2(dateTime[0]) && IsTime(dateTime[1], strictTimeZone);
}

// node_modules/typebox/build/format/duration.mjs
var Duration = /^P((\d+Y(\d+M(\d+D)?)?|\d+M(\d+D)?|\d+D)(T(\d+H(\d+M(\d+S)?)?|\d+M(\d+S)?|\d+S))?|T(\d+H(\d+M(\d+S)?)?|\d+M(\d+S)?|\d+S)|\d+W)$/;
function IsDuration(value) {
  return Duration.test(value);
}

// node_modules/typebox/build/format/email.mjs
var Email = /^(?!.*\.\.)[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
function IsEmail(value) {
  return Email.test(value);
}

// node_modules/typebox/build/format/_puny.mjs
var PUNYCODE_BASE = 36;
var PUNYCODE_TMIN = 1;
var PUNYCODE_TMAX = 26;
var PUNYCODE_SKEW = 38;
var PUNYCODE_DAMP = 700;
var PUNYCODE_INITIAL_BIAS = 72;
var PUNYCODE_INITIAL_N = 128;
function Adapt(delta, numPoints, firstTime) {
  delta = firstTime ? Math.floor(delta / PUNYCODE_DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > (PUNYCODE_BASE - PUNYCODE_TMIN) * PUNYCODE_TMAX >> 1) {
    delta = Math.floor(delta / (PUNYCODE_BASE - PUNYCODE_TMIN));
    k += PUNYCODE_BASE;
  }
  return k + Math.floor((PUNYCODE_BASE - PUNYCODE_TMIN + 1) * delta / (delta + PUNYCODE_SKEW));
}
function Decode2(value) {
  const output = [];
  let n = PUNYCODE_INITIAL_N;
  let i = 0;
  let bias = PUNYCODE_INITIAL_BIAS;
  const delimIdx = value.lastIndexOf("-");
  if (delimIdx > 0) {
    for (let j = 0; j < delimIdx; j++) {
      const cp = value.charCodeAt(j);
      if (cp >= 128)
        throw new Error("Invalid punycode: non-basic before delimiter");
      output.push(cp);
    }
  }
  let inIdx = delimIdx < 0 ? 0 : delimIdx + 1;
  while (inIdx < value.length) {
    const oldi = i;
    let w = 1;
    let k = PUNYCODE_BASE;
    while (true) {
      if (inIdx >= value.length)
        throw new Error("Invalid punycode: unexpected end of input");
      const ch = value.charCodeAt(inIdx++);
      let digit;
      if (ch >= 97 && ch <= 122)
        digit = ch - 97;
      else if (ch >= 48 && ch <= 57)
        digit = ch - 48 + 26;
      else if (ch >= 65 && ch <= 90)
        Unreachable();
      else
        throw new Error("Invalid punycode: bad digit character");
      i += digit * w;
      const t = k <= bias ? PUNYCODE_TMIN : k >= bias + PUNYCODE_TMAX ? PUNYCODE_TMAX : k - bias;
      if (digit < t)
        break;
      w *= PUNYCODE_BASE - t;
      k += PUNYCODE_BASE;
    }
    const outLen = output.length + 1;
    bias = Adapt(i - oldi, outLen, oldi === 0);
    n += Math.floor(i / outLen);
    i %= outLen;
    output.splice(i, 0, n);
    i++;
  }
  return globalThis.String.fromCodePoint(...output);
}

// node_modules/typebox/build/format/_idna.mjs
function IsNonspacingMark(cp) {
  return new RegExp("\\p{Mn}", "u").test(String.fromCodePoint(cp));
}
function IsSpacingCombiningMark(cp) {
  return new RegExp("\\p{Mc}", "u").test(String.fromCodePoint(cp));
}
function IsEnclosingMark(cp) {
  return new RegExp("\\p{Me}", "u").test(String.fromCodePoint(cp));
}
function IsCombiningMark2(cp) {
  return IsNonspacingMark(cp) || IsSpacingCombiningMark(cp) || IsEnclosingMark(cp);
}
var RFC5892_DISALLOWED = /* @__PURE__ */ new Set([
  1600,
  // ARABIC TATWEEL
  2042,
  // NKO LAJANYALAN
  12334,
  // HANGUL SINGLE DOT TONE MARK
  12335,
  // HANGUL DOUBLE DOT TONE MARK
  12337,
  // VERTICAL KANA REPEAT MARK
  12338,
  // VERTICAL KANA REPEAT WITH VOICED ITERATION MARK
  12339,
  // VERTICAL KANA REPEAT MARK UPPER HALF
  12340,
  // VERTICAL KANA REPEAT WITH VOICED ITERATION MARK UPPER HALF
  12341,
  // VERTICAL KANA REPEAT MARK LOWER HALF
  12347
  // VERTICAL IDEOGRAPHIC ITERATION MARK
]);
var VIRAMA_CPS = /* @__PURE__ */ new Set([
  2381,
  2509,
  2637,
  2765,
  2893,
  3021,
  3149,
  3277,
  3387,
  3388,
  3405,
  3530,
  6980,
  7082,
  7083,
  43456,
  69702,
  69759,
  69817,
  69939,
  69940,
  70080,
  70197,
  70477,
  70722,
  70850,
  71103,
  71231,
  71350,
  72767,
  73028,
  73029
]);
function IsGreek(cp) {
  return new RegExp("\\p{Script=Greek}", "u").test(String.fromCodePoint(cp));
}
function IsHebrew(cp) {
  return new RegExp("\\p{Script=Hebrew}", "u").test(String.fromCodePoint(cp));
}
function IsHiragana(cp) {
  return new RegExp("\\p{Script=Hiragana}", "u").test(String.fromCodePoint(cp));
}
function IsKatakana(cp) {
  return new RegExp("\\p{Script=Katakana}", "u").test(String.fromCodePoint(cp));
}
function IsHan(cp) {
  return new RegExp("\\p{Script=Han}", "u").test(String.fromCodePoint(cp));
}
function IsArabicIndicDigit(cp) {
  return cp >= 1632 && cp <= 1641;
}
function IsExtendedArabicIndicDigit(cp) {
  return cp >= 1776 && cp <= 1785;
}
function IsVirama(cp) {
  return VIRAMA_CPS.has(cp);
}
function IsUnicodeLabel(value) {
  if (value.length === 0)
    return Unreachable();
  const cps = [...value].map((c) => c.codePointAt(0));
  const len = cps.length;
  if (cps[0] === 45 || cps[len - 1] === 45)
    return false;
  if (len >= 4 && cps[2] === 45 && cps[3] === 45)
    return false;
  if (IsCombiningMark2(cps[0]))
    return false;
  let hasJapanese = false;
  let hasArabicIndic = false;
  let hasExtendedArabicIndic = false;
  for (let i = 0; i < len; i++) {
    const cp = cps[i];
    if (RFC5892_DISALLOWED.has(cp))
      return false;
    if (IsHiragana(cp) || IsKatakana(cp) || IsHan(cp))
      hasJapanese = true;
    if (IsArabicIndicDigit(cp))
      hasArabicIndic = true;
    if (IsExtendedArabicIndicDigit(cp))
      hasExtendedArabicIndic = true;
    const prev = cps[i - 1], next = cps[i + 1];
    switch (cp) {
      case 183:
        if (prev !== 108 || next !== 108)
          return false;
        break;
      // MIDDLE DOT (Catalan)
      case 885:
        if (next === void 0 || !IsGreek(next))
          return false;
        break;
      // Greek KERAIA
      case 1523:
      case 1524:
        if (prev === void 0 || !IsHebrew(prev))
          return false;
        break;
      // Hebrew GERESH
      case 8204:
        if (prev === void 0 || prev < 128 && !IsVirama(prev))
          return false;
        break;
      case 8205:
        if (prev === void 0 || !IsVirama(prev))
          return false;
        break;
      case 12539:
        break;
    }
  }
  if (value.includes("\u30FB") && !hasJapanese)
    return false;
  if (hasArabicIndic && hasExtendedArabicIndic)
    return false;
  return true;
}
function IsAsciiLabel(value) {
  if (value.charCodeAt(0) === 45 || value.charCodeAt(value.length - 1) === 45)
    return false;
  if (value.length >= 4 && value.charCodeAt(2) === 45 && value.charCodeAt(3) === 45)
    return false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (!(ch >= 97 && ch <= 122 || // a-z
    ch >= 65 && ch <= 90 || // A-Z
    ch >= 48 && ch <= 57 || // 0-9
    ch === 45))
      return false;
  }
  return true;
}
function IsPuny(value) {
  return value.toLowerCase().startsWith("xn--");
}
function IsPunyLabel(value) {
  try {
    const payload = value.slice(4).toLowerCase();
    const lastHyphen = payload.lastIndexOf("-");
    if (lastHyphen === 0) {
      return false;
    }
    const decoded = Decode2(payload);
    if (!decoded)
      return false;
    return IsUnicodeLabel(decoded);
  } catch {
    return false;
  }
}
function IsIdnLabel(value) {
  if (value.length === 0 || value.length > 63)
    return false;
  return IsPuny(value) ? IsPunyLabel(value) : IsUnicodeLabel(value);
}
function IsLabel(value) {
  if (value.length === 0 || value.length > 63)
    return false;
  return IsPuny(value) ? IsPunyLabel(value) : IsAsciiLabel(value);
}

// node_modules/typebox/build/format/hostname.mjs
function IsHostname(value) {
  if (value.length === 0 || value.length > 253)
    return false;
  if (value.charCodeAt(value.length - 1) === 46)
    return false;
  for (const label of value.split(".")) {
    if (!IsLabel(label))
      return false;
  }
  return true;
}

// node_modules/typebox/build/format/idn_email.mjs
var IdnEmail = /^(?!.*\.\.)[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)*$/iu;
function IsIdnEmail(value) {
  return IdnEmail.test(value);
}

// node_modules/typebox/build/format/idn_hostname.mjs
function IsIdnHostname(value) {
  if (value.length === 0 || value.includes(" "))
    return false;
  const canonical = value.normalize("NFC").replace(/[\u002E\u3002\uFF0E\uFF61]/g, ".");
  if (canonical.length > 253)
    return false;
  for (const label of canonical.split(".")) {
    if (!IsIdnLabel(label))
      return false;
  }
  return true;
}

// node_modules/typebox/build/format/ipv4.mjs
function IsIPv4Internal(value, start, end) {
  let dots = 0;
  let num = 0;
  let digits = 0;
  let leading = 0;
  for (let i = start; i < end; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 46) {
      if (digits === 0 || num > 255 || leading === 48 && digits > 1)
        return false;
      dots++;
      num = 0;
      digits = 0;
      leading = 0;
    } else if (ch >= 48 && ch <= 57) {
      if (digits === 0)
        leading = ch;
      num = num * 10 + (ch - 48);
      digits++;
    } else {
      return false;
    }
  }
  return dots === 3 && digits > 0 && num <= 255 && !(leading === 48 && digits > 1);
}
function IsIPv4(value) {
  return IsIPv4Internal(value, 0, value.length);
}

// node_modules/typebox/build/format/ipv6.mjs
function InRange(ch) {
  return ch >= 48 && ch <= 57 || // 0-9
  ch >= 65 && ch <= 70 || // A-F
  ch >= 97 && ch <= 102;
}
function IsIPv6(value) {
  const length = value.length;
  if (length === 0)
    return false;
  let groups = 0;
  let compressed = false;
  let i = 0;
  if (value.charCodeAt(0) === 58 && value.charCodeAt(1) === 58) {
    if (length === 2)
      return true;
    compressed = true;
    i = 2;
  }
  while (i < length) {
    let digits = 0;
    const start = i;
    while (i < length && InRange(value.charCodeAt(i))) {
      i++;
      digits++;
    }
    if (digits === 0)
      return false;
    const next = value.charCodeAt(i);
    if (next === 46) {
      if (!IsIPv4Internal(value, start, length))
        return false;
      groups += 2;
      i = length;
      break;
    }
    if (digits > 4)
      return false;
    groups++;
    if (i === length)
      break;
    if (next !== 58)
      return false;
    i++;
    if (value.charCodeAt(i) === 58) {
      if (compressed)
        return false;
      if (value.charCodeAt(i + 1) === 58)
        return false;
      compressed = true;
      i++;
      if (i === length)
        break;
    }
  }
  return compressed ? groups <= 7 : groups === 8;
}

// node_modules/typebox/build/format/iri_reference.mjs
function TryUrl(value) {
  try {
    new URL(value, "http://example.com");
    return true;
  } catch {
    return false;
  }
}
function IsIriReference(value) {
  if (value.includes(" ")) {
    return false;
  }
  if (value.includes("\\")) {
    return false;
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return false;
  }
  if (/%(?![0-9a-fA-F]{2})/.test(value)) {
    return false;
  }
  if (value === "") {
    return true;
  }
  const colonIndex = value.indexOf(":");
  const hasValidSchemePrefix = colonIndex > 0 && // Colon must not be at the very beginning (e.g., ":foo")
  /^[a-zA-Z][a-zA-Z0-9+\-.]*$/.test(value.substring(0, colonIndex));
  if (hasValidSchemePrefix) {
    return TryUrl(value);
  } else {
    const looksLikeMalformedSchemeAndAuthority = value.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*)(\/\/)/);
    if (looksLikeMalformedSchemeAndAuthority && colonIndex === -1) {
      return false;
    }
    return TryUrl(value);
  }
}

// node_modules/typebox/build/format/iri.mjs
function IsIri(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// node_modules/typebox/build/format/json_pointer_uri_fragment.mjs
var JsonPointerUriFragment = /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i;
function IsJsonPointerUriFragment(value) {
  return JsonPointerUriFragment.test(value);
}

// node_modules/typebox/build/format/json_pointer.mjs
var JsonPointer = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
function IsJsonPointer(value) {
  return JsonPointer.test(value);
}

// node_modules/typebox/build/format/regex.mjs
function IsRegex(value) {
  if (value.length === 0) {
    return false;
  }
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

// node_modules/typebox/build/format/relative_json_pointer.mjs
var RelativeJsonPointer = /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/;
function IsRelativeJsonPointer(value) {
  return RelativeJsonPointer.test(value);
}

// node_modules/typebox/build/format/uri_reference.mjs
var UriReference = /^(?!.*[^\x00-\x7F])(?!.*\\)(?:(?:[a-z][a-z0-9+\-.]*:)?(?:\/\/[^\s[\]{}<>^`|]*)?|[^\s[\]{}<>^`|]*)(?:\?[^\s[\]{}<>^`|]*)?(?:#[^\s[\]{}<>^`|]*)?$/i;
function IsUriReference(value) {
  return UriReference.test(value);
}

// node_modules/typebox/build/format/uri_template.mjs
var UriTemplate = /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i;
function IsUriTemplate(value) {
  return UriTemplate.test(value);
}

// node_modules/typebox/build/format/uri.mjs
function IsAlpha(ch) {
  return ch >= 97 && ch <= 122 || ch >= 65 && ch <= 90;
}
function IsAlphaNumeric(ch) {
  return IsAlpha(ch) || ch >= 48 && ch <= 57;
}
function IsHex(ch) {
  return ch >= 48 && ch <= 57 || // 0-9
  ch >= 65 && ch <= 70 || // A-F
  ch >= 97 && ch <= 102;
}
function IsSchemeChar(ch) {
  return IsAlphaNumeric(ch) || ch === 43 || ch === 45 || ch === 46;
}
function IsUnreserved(ch) {
  return IsAlphaNumeric(ch) || ch === 45 || ch === 46 || // '-', '.'
  ch === 95 || ch === 126;
}
function IsSubDelim(ch) {
  return ch === 33 || ch === 36 || ch === 38 || ch === 39 || ch === 40 || ch === 41 || ch === 42 || ch === 43 || ch === 44 || ch === 59 || ch === 61;
}
function IsPchar(ch) {
  return IsUnreserved(ch) || IsSubDelim(ch) || ch === 58 || ch === 64;
}
function IsUri(value) {
  const length = value.length;
  if (length === 0)
    return false;
  if (!IsAlpha(value.charCodeAt(0)))
    return false;
  let i = 1;
  while (i < length) {
    const ch = value.charCodeAt(i);
    if (ch === 58)
      break;
    if (!IsSchemeChar(ch))
      return false;
    i++;
  }
  if (value.charCodeAt(i) !== 58)
    return false;
  i++;
  if (value.charCodeAt(i) === 47 && value.charCodeAt(i + 1) === 47) {
    i += 2;
    const authorityStart = i;
    let atPos = -1;
    for (let j = i; j < length; j++) {
      const ch = value.charCodeAt(j);
      if (ch === 64) {
        atPos = j;
        break;
      }
      if (ch === 47 || ch === 63 || ch === 35)
        break;
    }
    if (atPos !== -1) {
      for (let j = authorityStart; j < atPos; j++) {
        const ch = value.charCodeAt(j);
        if (ch === 91 || ch === 93)
          return false;
        if (ch === 37) {
          if (j + 2 >= atPos || !IsHex(value.charCodeAt(j + 1)) || !IsHex(value.charCodeAt(j + 2)))
            return false;
          j += 2;
        } else if (!IsUnreserved(ch) && !IsSubDelim(ch) && ch !== 58)
          return false;
      }
      i = atPos + 1;
    }
    if (value.charCodeAt(i) === 91) {
      i++;
      while (i < length && value.charCodeAt(i) !== 93)
        i++;
      if (value.charCodeAt(i) !== 93)
        return false;
      i++;
    } else {
      while (i < length) {
        const ch = value.charCodeAt(i);
        if (ch === 47 || ch === 63 || ch === 35 || ch === 58)
          break;
        if (ch < 128 && !IsUnreserved(ch) && !IsSubDelim(ch))
          return false;
        i++;
      }
    }
    if (value.charCodeAt(i) === 58) {
      i++;
      while (i < length) {
        const ch = value.charCodeAt(i);
        if (ch === 47 || ch === 63 || ch === 35)
          break;
        if (ch < 48 || ch > 57)
          return false;
        i++;
      }
    }
  }
  while (i < length) {
    const ch = value.charCodeAt(i);
    if (ch === 37) {
      if (i + 2 >= length || !IsHex(value.charCodeAt(i + 1)) || !IsHex(value.charCodeAt(i + 2)))
        return false;
      i += 2;
    } else if (ch > 127) {
      return false;
    } else if (!(IsPchar(ch) || ch === 47 || ch === 63 || ch === 35)) {
      return false;
    }
    i++;
  }
  return true;
}

// node_modules/typebox/build/format/url.mjs
var Url = /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu;
function IsUrl(value) {
  return Url.test(value);
}

// node_modules/typebox/build/format/uuid.mjs
var Uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function IsUuid(value) {
  return Uuid.test(value);
}

// node_modules/typebox/build/format/_registry.mjs
var formats = /* @__PURE__ */ new Map();
function Clear() {
  formats.clear();
}
function Entries2() {
  return [...formats.entries()];
}
function Set3(format, check) {
  formats.set(format, check);
}
function Has(format) {
  return formats.has(format);
}
function Get3(format) {
  return formats.get(format);
}
function Test(format, value) {
  return formats.get(format)?.(value) ?? true;
}
function Reset2() {
  Clear();
  formats.set("date-time", IsDateTime);
  formats.set("date", IsDate2);
  formats.set("duration", IsDuration);
  formats.set("email", IsEmail);
  formats.set("hostname", IsHostname);
  formats.set("idn-email", IsIdnEmail);
  formats.set("idn-hostname", IsIdnHostname);
  formats.set("ipv4", IsIPv4);
  formats.set("ipv6", IsIPv6);
  formats.set("iri-reference", IsIriReference);
  formats.set("iri", IsIri);
  formats.set("json-pointer-uri-fragment", IsJsonPointerUriFragment);
  formats.set("json-pointer", IsJsonPointer);
  formats.set("regex", IsRegex);
  formats.set("relative-json-pointer", IsRelativeJsonPointer);
  formats.set("time", IsTime);
  formats.set("uri-reference", IsUriReference);
  formats.set("uri-template", IsUriTemplate);
  formats.set("uri", IsUri);
  formats.set("url", IsUrl);
  formats.set("uuid", IsUuid);
}
Reset2();

// node_modules/typebox/build/schema/engine/format.mjs
function CheckFormat(_stack, _context, schema, value) {
  return format_exports.Test(schema.format, value);
}
function ErrorFormat(stack, context, schemaPath, instancePath, schema, value) {
  return CheckFormat(stack, context, schema, value) || context.AddError({
    keyword: "format",
    schemaPath,
    instancePath,
    params: { format: schema.format }
  });
}

// node_modules/typebox/build/schema/engine/if.mjs
function CheckIf(stack, context, schema, value) {
  const thenSchema = IsThen(schema) ? schema.then : true;
  const elseSchema = IsElse(schema) ? schema.else : true;
  return CheckSchema(stack, context, schema.if, value) ? CheckSchema(stack, context, thenSchema, value) : CheckSchema(stack, context, elseSchema, value);
}
function ErrorIf(stack, context, schemaPath, instancePath, schema, value) {
  const thenSchema = IsThen(schema) ? schema.then : true;
  const elseSchema = IsElse(schema) ? schema.else : true;
  const trueContext = new AccumulatedErrorContext();
  const isIf = ErrorSchema(stack, trueContext, `${schemaPath}/if`, instancePath, schema.if, value) ? ErrorSchema(stack, trueContext, `${schemaPath}/then`, instancePath, thenSchema, value) || context.AddError({
    keyword: "if",
    schemaPath,
    instancePath,
    params: { failingKeyword: "then" }
  }) : ErrorSchema(stack, context, `${schemaPath}/else`, instancePath, elseSchema, value) || context.AddError({
    keyword: "if",
    schemaPath,
    instancePath,
    params: { failingKeyword: "else" }
  });
  if (isIf)
    context.Merge([trueContext]);
  return isIf;
}

// node_modules/typebox/build/schema/engine/items.mjs
function CheckItemsSized(stack, context, schema, value) {
  return guard_exports.Every(schema.items, 0, (schema2, index) => {
    return guard_exports.IsLessEqualThan(value.length, index) || CheckSchemaPushStack(stack, context, schema2, value[index]) && context.AddIndex(index);
  });
}
function ErrorItemsSized(stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.EveryAll(schema.items, 0, (schema2, index) => {
    const nextSchemaPath = `${schemaPath}/items/${index}`;
    const nextInstancePath = `${instancePath}/${index}`;
    return guard_exports.IsLessEqualThan(value.length, index) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value[index]) && context.AddIndex(index);
  });
}
function CheckItemsUnsized(stack, context, schema, value) {
  const offset = IsPrefixItems(schema) ? schema.prefixItems.length : 0;
  return guard_exports.Every(value, offset, (element, index) => {
    return CheckSchemaPushStack(stack, context, schema.items, element) && context.AddIndex(index);
  });
}
function ErrorItemsUnsized(stack, context, schemaPath, instancePath, schema, value) {
  const offset = IsPrefixItems(schema) ? schema.prefixItems.length : 0;
  return guard_exports.EveryAll(value, offset, (element, index) => {
    const nextSchemaPath = `${schemaPath}/items`;
    const nextInstancePath = `${instancePath}/${index}`;
    return ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema.items, element) && context.AddIndex(index);
  });
}
function CheckItems(stack, context, schema, value) {
  return IsItemsSized(schema) ? CheckItemsSized(stack, context, schema, value) : CheckItemsUnsized(stack, context, schema, value);
}
function ErrorItems(stack, context, schemaPath, instancePath, schema, value) {
  return IsItemsSized(schema) ? ErrorItemsSized(stack, context, schemaPath, instancePath, schema, value) : ErrorItemsUnsized(stack, context, schemaPath, instancePath, schema, value);
}

// node_modules/typebox/build/schema/engine/maxContains.mjs
function IsValid3(schema) {
  return IsContains(schema);
}
function CheckMaxContains(stack, context, schema, value) {
  if (!IsValid3(schema))
    return true;
  const count = value.reduce((result, item) => CheckSchema(stack, context, schema.contains, item) ? ++result : result, 0);
  return guard_exports.IsLessEqualThan(count, schema.maxContains);
}
function ErrorMaxContains(stack, context, schemaPath, instancePath, schema, value) {
  const minContains = IsMinContains(schema) ? schema.minContains : 1;
  return CheckMaxContains(stack, context, schema, value) || context.AddError({
    keyword: "contains",
    schemaPath,
    instancePath,
    params: { minContains, maxContains: schema.maxContains }
  });
}

// node_modules/typebox/build/schema/engine/maximum.mjs
function CheckMaximum(_stack, _context, schema, value) {
  return guard_exports.IsLessEqualThan(value, schema.maximum);
}
function ErrorMaximum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaximum(stack, context, schema, value) || context.AddError({
    keyword: "maximum",
    schemaPath,
    instancePath,
    params: { comparison: "<=", limit: schema.maximum }
  });
}

// node_modules/typebox/build/schema/engine/maxItems.mjs
function CheckMaxItems(_stack, _context, schema, value) {
  return guard_exports.IsLessEqualThan(value.length, schema.maxItems);
}
function ErrorMaxItems(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaxItems(stack, context, schema, value) || context.AddError({
    keyword: "maxItems",
    schemaPath,
    instancePath,
    params: { limit: schema.maxItems }
  });
}

// node_modules/typebox/build/schema/engine/maxLength.mjs
function CheckMaxLength(_stack, _context, schema, value) {
  return guard_exports.IsMaxLength(value, schema.maxLength);
}
function ErrorMaxLength(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaxLength(stack, context, schema, value) || context.AddError({
    keyword: "maxLength",
    schemaPath,
    instancePath,
    params: { limit: schema.maxLength }
  });
}

// node_modules/typebox/build/schema/engine/maxProperties.mjs
function CheckMaxProperties(_stack, _context, schema, value) {
  return guard_exports.IsLessEqualThan(guard_exports.Keys(value).length, schema.maxProperties);
}
function ErrorMaxProperties(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMaxProperties(stack, context, schema, value) || context.AddError({
    keyword: "maxProperties",
    schemaPath,
    instancePath,
    params: { limit: schema.maxProperties }
  });
}

// node_modules/typebox/build/schema/engine/minContains.mjs
function IsValid4(schema) {
  return IsContains(schema);
}
function CheckMinContains(stack, context, schema, value) {
  if (!IsValid4(schema))
    return true;
  const count = value.reduce((result, item) => CheckSchema(stack, context, schema.contains, item) ? ++result : result, 0);
  return guard_exports.IsGreaterEqualThan(count, schema.minContains);
}
function ErrorMinContains(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinContains(stack, context, schema, value) || context.AddError({
    keyword: "contains",
    schemaPath,
    instancePath,
    params: { minContains: schema.minContains }
  });
}

// node_modules/typebox/build/schema/engine/minimum.mjs
function CheckMinimum(_stack, _context, schema, value) {
  return guard_exports.IsGreaterEqualThan(value, schema.minimum);
}
function ErrorMinimum(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinimum(stack, context, schema, value) || context.AddError({
    keyword: "minimum",
    schemaPath,
    instancePath,
    params: { comparison: ">=", limit: schema.minimum }
  });
}

// node_modules/typebox/build/schema/engine/minItems.mjs
function CheckMinItems(_stack, _context, schema, value) {
  return guard_exports.IsGreaterEqualThan(value.length, schema.minItems);
}
function ErrorMinItems(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinItems(stack, context, schema, value) || context.AddError({
    keyword: "minItems",
    schemaPath,
    instancePath,
    params: { limit: schema.minItems }
  });
}

// node_modules/typebox/build/schema/engine/minLength.mjs
function CheckMinLength(_stack, _context, schema, value) {
  return guard_exports.IsMinLength(value, schema.minLength);
}
function ErrorMinLength(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinLength(stack, context, schema, value) || context.AddError({
    keyword: "minLength",
    schemaPath,
    instancePath,
    params: { limit: schema.minLength }
  });
}

// node_modules/typebox/build/schema/engine/minProperties.mjs
function CheckMinProperties(_stack, _context, schema, value) {
  return guard_exports.IsGreaterEqualThan(guard_exports.Keys(value).length, schema.minProperties);
}
function ErrorMinProperties(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMinProperties(stack, context, schema, value) || context.AddError({
    keyword: "minProperties",
    schemaPath,
    instancePath,
    params: { limit: schema.minProperties }
  });
}

// node_modules/typebox/build/schema/engine/multipleOf.mjs
function CheckMultipleOf(_stack, _context, schema, value) {
  return guard_exports.IsMultipleOf(value, schema.multipleOf);
}
function ErrorMultipleOf(stack, context, schemaPath, instancePath, schema, value) {
  return CheckMultipleOf(stack, context, schema, value) || context.AddError({
    keyword: "multipleOf",
    schemaPath,
    instancePath,
    params: { multipleOf: schema.multipleOf }
  });
}

// node_modules/typebox/build/schema/engine/not.mjs
function CheckNot(stack, context, schema, value) {
  const nextContext = new CheckContext();
  const isSchema = !CheckSchema(stack, nextContext, schema.not, value);
  const isNot = isSchema && context.Merge([nextContext]);
  return isNot;
}
function ErrorNot(stack, context, schemaPath, instancePath, schema, value) {
  return CheckNot(stack, context, schema, value) || context.AddError({
    keyword: "not",
    schemaPath,
    instancePath,
    params: {}
  });
}

// node_modules/typebox/build/schema/engine/oneOf.mjs
function CheckOneOf(stack, context, schema, value) {
  const passedContexts = schema.oneOf.reduce((result, schema2) => {
    const nextContext = new CheckContext();
    return CheckSchema(stack, nextContext, schema2, value) ? [...result, nextContext] : result;
  }, []);
  return guard_exports.IsEqual(passedContexts.length, 1) && context.Merge(passedContexts);
}
function ErrorOneOf(stack, context, schemaPath, instancePath, schema, value) {
  const failedContexts = [];
  const passingSchemas = [];
  const passedContexts = schema.oneOf.reduce((result, schema2, index) => {
    const nextContext = new AccumulatedErrorContext();
    const nextSchemaPath = `${schemaPath}/oneOf/${index}`;
    const isSchema = ErrorSchema(stack, nextContext, nextSchemaPath, instancePath, schema2, value);
    if (isSchema)
      passingSchemas.push(index);
    if (!isSchema)
      failedContexts.push(nextContext);
    return isSchema ? [...result, nextContext] : result;
  }, []);
  const isOneOf = guard_exports.IsEqual(passedContexts.length, 1) && context.Merge(passedContexts);
  if (!isOneOf && guard_exports.IsEqual(passingSchemas.length, 0))
    failedContexts.forEach((failed) => failed.GetErrors().forEach((error) => context.AddError(error)));
  return isOneOf || context.AddError({
    keyword: "oneOf",
    schemaPath,
    instancePath,
    params: { passingSchemas }
  });
}

// node_modules/typebox/build/schema/engine/pattern.mjs
function CheckPattern(_stack, _context, schema, value) {
  const regexp = guard_exports.IsString(schema.pattern) ? new RegExp(schema.pattern, "u") : schema.pattern;
  return regexp.test(value);
}
function ErrorPattern(stack, context, schemaPath, instancePath, schema, value) {
  return CheckPattern(stack, context, schema, value) || context.AddError({
    keyword: "pattern",
    schemaPath,
    instancePath,
    params: { pattern: schema.pattern }
  });
}

// node_modules/typebox/build/schema/engine/patternProperties.mjs
function CheckPatternProperties(stack, context, schema, value) {
  return guard_exports.Every(guard_exports.Entries(schema.patternProperties), 0, ([pattern, schema2]) => {
    const regexp = new RegExp(pattern, "u");
    return guard_exports.Every(guard_exports.Entries(value), 0, ([key, prop]) => {
      return !regexp.test(key) || CheckSchemaPushStack(stack, context, schema2, prop) && context.AddKey(key);
    });
  });
}
function ErrorPatternProperties(stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.EveryAll(guard_exports.Entries(schema.patternProperties), 0, ([pattern, schema2]) => {
    const nextSchemaPath = `${schemaPath}/patternProperties/${pattern}`;
    const regexp = new RegExp(pattern, "u");
    return guard_exports.EveryAll(guard_exports.Entries(value), 0, ([key, value2]) => {
      const nextInstancePath = `${instancePath}/${key}`;
      const notKey = !regexp.test(key);
      return notKey || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value2) && context.AddKey(key);
    });
  });
}

// node_modules/typebox/build/schema/engine/prefixItems.mjs
function CheckPrefixItems(stack, context, schema, value) {
  return guard_exports.IsEqual(value.length, 0) || guard_exports.Every(schema.prefixItems, 0, (schema2, index) => {
    return guard_exports.IsLessEqualThan(value.length, index) || CheckSchemaPushStack(stack, context, schema2, value[index]) && context.AddIndex(index);
  });
}
function ErrorPrefixItems(stack, context, schemaPath, instancePath, schema, value) {
  return guard_exports.IsEqual(value.length, 0) || guard_exports.EveryAll(schema.prefixItems, 0, (schema2, index) => {
    const nextSchemaPath = `${schemaPath}/prefixItems/${index}`;
    const nextInstancePath = `${instancePath}/${index}`;
    return guard_exports.IsLessEqualThan(value.length, index) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value[index]) && context.AddIndex(index);
  });
}

// node_modules/typebox/build/schema/engine/_exact_optional.mjs
function IsExactOptional(required, key) {
  return required.includes(key) || settings_exports.Get().exactOptionalPropertyTypes;
}
function InexactOptionalCheck(value, key) {
  return guard_exports.IsUndefined(value[key]);
}

// node_modules/typebox/build/schema/engine/properties.mjs
function CheckProperties(stack, context, schema, value) {
  const required = IsRequired(schema) ? schema.required : [];
  const isProperties = guard_exports.Every(guard_exports.Entries(schema.properties), 0, ([key, schema2]) => {
    const isProperty = !guard_exports.HasPropertyKey(value, key) || CheckSchemaPushStack(stack, context, schema2, value[key]) && context.AddKey(key);
    return IsExactOptional(required, key) ? isProperty : InexactOptionalCheck(value, key) || isProperty;
  });
  return isProperties;
}
function ErrorProperties(stack, context, schemaPath, instancePath, schema, value) {
  const required = IsRequired(schema) ? schema.required : [];
  const isProperties = guard_exports.EveryAll(guard_exports.Entries(schema.properties), 0, ([key, schema2]) => {
    const nextSchemaPath = `${schemaPath}/properties/${key}`;
    const nextInstancePath = `${instancePath}/${key}`;
    const isProperty = () => !guard_exports.HasPropertyKey(value, key) || ErrorSchemaPushStack(stack, context, nextSchemaPath, nextInstancePath, schema2, value[key]) && context.AddKey(key);
    return IsExactOptional(required, key) ? isProperty() : InexactOptionalCheck(value, key) || isProperty();
  });
  return isProperties;
}

// node_modules/typebox/build/schema/engine/propertyNames.mjs
function CheckPropertyNames(stack, context, schema, value) {
  return guard_exports.Every(guard_exports.Keys(value), 0, (key, _index) => CheckSchema(stack, context, schema.propertyNames, key));
}
function ErrorPropertyNames(stack, context, schemaPath, instancePath, schema, value) {
  const propertyNames = [];
  const isPropertyNames = guard_exports.EveryAll(guard_exports.Keys(value), 0, (key, _index) => {
    const nextInstancePath = `${instancePath}/${key}`;
    const nextSchemaPath = `${schemaPath}/propertyNames`;
    const nextContext = new AccumulatedErrorContext();
    const isPropertyName = ErrorSchema(stack, nextContext, nextSchemaPath, nextInstancePath, schema.propertyNames, key);
    if (!isPropertyName)
      propertyNames.push(key);
    return isPropertyName;
  });
  return isPropertyNames || context.AddError({
    keyword: "propertyNames",
    schemaPath,
    instancePath,
    params: { propertyNames }
  });
}

// node_modules/typebox/build/schema/engine/recursiveRef.mjs
function CheckRecursiveRef(stack, context, schema, value) {
  const target = stack.RecursiveRef(schema) ?? false;
  return IsSchema2(target) && CheckSchema(stack, context, target, value);
}
function ErrorRecursiveRef(stack, context, _schemaPath, instancePath, schema, value) {
  const target = stack.RecursiveRef(schema) ?? false;
  return IsSchema2(target) && ErrorSchema(stack, context, "#", instancePath, target, value);
}

// node_modules/typebox/build/schema/engine/ref.mjs
function CheckRef(stack, context, schema, value) {
  const target = stack.Ref(schema) ?? false;
  const nextContext = new CheckContext();
  const result = IsSchema2(target) && CheckSchema(stack, nextContext, target, value);
  if (result)
    context.Merge([nextContext]);
  return result;
}
function ErrorRef(stack, context, _schemaPath, instancePath, schema, value) {
  const target = stack.Ref(schema) ?? false;
  const nextContext = new AccumulatedErrorContext();
  const result = IsSchema2(target) && ErrorSchema(stack, nextContext, "#", instancePath, target, value);
  if (result)
    context.Merge([nextContext]);
  if (!result)
    nextContext.GetErrors().forEach((error) => context.AddError(error));
  return result;
}

// node_modules/typebox/build/schema/engine/required.mjs
function CheckRequired(_stack, _context, schema, value) {
  return guard_exports.Every(schema.required, 0, (key) => guard_exports.HasPropertyKey(value, key));
}
function ErrorRequired(_stack, context, schemaPath, instancePath, schema, value) {
  const requiredProperties = [];
  const isRequired = guard_exports.EveryAll(schema.required, 0, (key) => {
    const hasKey = guard_exports.HasPropertyKey(value, key);
    if (!hasKey)
      requiredProperties.push(key);
    return hasKey;
  });
  return isRequired || context.AddError({
    keyword: "required",
    schemaPath,
    instancePath,
    params: { requiredProperties }
  });
}

// node_modules/typebox/build/schema/engine/type.mjs
function CheckTypeName(_stack, _context, type, _schema, value) {
  return (
    // jsonschema
    guard_exports.IsEqual(type, "object") ? guard_exports.IsObjectNotArray(value) : guard_exports.IsEqual(type, "array") ? guard_exports.IsArray(value) : guard_exports.IsEqual(type, "boolean") ? guard_exports.IsBoolean(value) : guard_exports.IsEqual(type, "integer") ? guard_exports.IsInteger(value) : guard_exports.IsEqual(type, "number") ? guard_exports.IsNumber(value) : guard_exports.IsEqual(type, "null") ? guard_exports.IsNull(value) : guard_exports.IsEqual(type, "string") ? guard_exports.IsString(value) : (
      // xschema
      guard_exports.IsEqual(type, "bigint") ? guard_exports.IsBigInt(value) : guard_exports.IsEqual(type, "constructor") ? guard_exports.IsConstructor(value) : guard_exports.IsEqual(type, "function") ? guard_exports.IsFunction(value) : guard_exports.IsEqual(type, "symbol") ? guard_exports.IsSymbol(value) : guard_exports.IsEqual(type, "undefined") ? guard_exports.IsUndefined(value) : guard_exports.IsEqual(type, "void") ? guard_exports.IsUndefined(value) : true
    )
  );
}
function CheckTypeNames(stack, context, types, schema, value) {
  return types.some((type) => CheckTypeName(stack, context, type, schema, value));
}
function CheckType(stack, context, schema, value) {
  return guard_exports.IsArray(schema.type) ? CheckTypeNames(stack, context, schema.type, schema, value) : CheckTypeName(stack, context, schema.type, schema, value);
}
function ErrorType(stack, context, schemaPath, instancePath, schema, value) {
  const isType = guard_exports.IsArray(schema.type) ? CheckTypeNames(stack, context, schema.type, schema, value) : CheckTypeName(stack, context, schema.type, schema, value);
  return isType || context.AddError({
    keyword: "type",
    schemaPath,
    instancePath,
    params: { type: schema.type }
  });
}

// node_modules/typebox/build/schema/engine/unevaluatedItems.mjs
function CheckUnevaluatedItems(stack, context, schema, value) {
  const indices = context.GetIndices();
  return guard_exports.Every(value, 0, (item, index) => {
    return (indices.has(index) || CheckSchema(stack, context, schema.unevaluatedItems, item)) && context.AddIndex(index);
  });
}
function ErrorUnevaluatedItems(stack, context, schemaPath, instancePath, schema, value) {
  const indices = context.GetIndices();
  const unevaluatedItems = [];
  const isUnevaluatedItems = guard_exports.EveryAll(value, 0, (item, index) => {
    const nextContext = new AccumulatedErrorContext();
    const isEvaluatedItem = (indices.has(index) || ErrorSchema(stack, nextContext, schemaPath, instancePath, schema.unevaluatedItems, item)) && context.AddIndex(index);
    if (!isEvaluatedItem)
      unevaluatedItems.push(index);
    return isEvaluatedItem;
  });
  return isUnevaluatedItems || context.AddError({
    keyword: "unevaluatedItems",
    schemaPath,
    instancePath,
    params: { unevaluatedItems }
  });
}

// node_modules/typebox/build/schema/engine/unevaluatedProperties.mjs
function CheckUnevaluatedProperties(stack, context, schema, value) {
  const keys = context.GetKeys();
  return guard_exports.Every(guard_exports.Entries(value), 0, ([key, prop]) => {
    return keys.has(key) || CheckSchema(stack, context, schema.unevaluatedProperties, prop) && context.AddKey(key);
  });
}
function ErrorUnevaluatedProperties(stack, context, schemaPath, instancePath, schema, value) {
  const keys = context.GetKeys();
  const unevaluatedProperties = [];
  const isUnevaluatedProperties = guard_exports.EveryAll(guard_exports.Entries(value), 0, ([key, prop]) => {
    const nextContext = new AccumulatedErrorContext();
    const isEvaluatedProperty = keys.has(key) || ErrorSchema(stack, nextContext, schemaPath, instancePath, schema.unevaluatedProperties, prop) && context.AddKey(key);
    if (!isEvaluatedProperty)
      unevaluatedProperties.push(key);
    return isEvaluatedProperty;
  });
  return isUnevaluatedProperties || context.AddError({
    keyword: "unevaluatedProperties",
    schemaPath,
    instancePath,
    params: { unevaluatedProperties }
  });
}

// node_modules/typebox/build/schema/engine/uniqueItems.mjs
function IsValid5(schema) {
  return !guard_exports.IsEqual(schema.uniqueItems, false);
}
function CheckUniqueItems(_stack, _context, schema, value) {
  if (!IsValid5(schema))
    return true;
  const set = new Set(value.map(hash_exports.Hash)).size;
  const isLength = value.length;
  return guard_exports.IsEqual(set, isLength);
}
function ErrorUniqueItems(_stack, context, schemaPath, instancePath, schema, value) {
  if (!IsValid5(schema))
    return true;
  const set = /* @__PURE__ */ new Set();
  const duplicateItems = value.reduce((result, value2, index) => {
    const hash = hash_exports.Hash(value2);
    if (set.has(hash))
      return [...result, index];
    set.add(hash);
    return result;
  }, []);
  const isUniqueItems = guard_exports.IsEqual(duplicateItems.length, 0);
  return isUniqueItems || context.AddError({
    keyword: "uniqueItems",
    schemaPath,
    instancePath,
    params: { duplicateItems }
  });
}

// node_modules/typebox/build/schema/engine/schema.mjs
function CheckSchemaPushStack(stack, context, schema, value) {
  return context.Push() && CheckSchema(stack, context, schema, value) && context.Pop();
}
function CheckSchema(stack, context, schema, value) {
  stack.Push(schema);
  const result = IsSchemaBoolean(schema) ? CheckSchemaBoolean(stack, context, schema, value) : (!IsType(schema) || CheckType(stack, context, schema, value)) && (!(guard_exports.IsObject(value) && !guard_exports.IsArray(value)) || (!IsRequired(schema) || CheckRequired(stack, context, schema, value)) && (!IsAdditionalProperties(schema) || CheckAdditionalProperties(stack, context, schema, value)) && (!IsDependencies(schema) || CheckDependencies(stack, context, schema, value)) && (!IsDependentRequired(schema) || CheckDependentRequired(stack, context, schema, value)) && (!IsDependentSchemas(schema) || CheckDependentSchemas(stack, context, schema, value)) && (!IsPatternProperties(schema) || CheckPatternProperties(stack, context, schema, value)) && (!IsProperties(schema) || CheckProperties(stack, context, schema, value)) && (!IsPropertyNames(schema) || CheckPropertyNames(stack, context, schema, value)) && (!IsMinProperties(schema) || CheckMinProperties(stack, context, schema, value)) && (!IsMaxProperties(schema) || CheckMaxProperties(stack, context, schema, value))) && (!guard_exports.IsArray(value) || (!IsAdditionalItems(schema) || CheckAdditionalItems(stack, context, schema, value)) && (!IsContains(schema) || CheckContains(stack, context, schema, value)) && (!IsItems(schema) || CheckItems(stack, context, schema, value)) && (!IsMaxContains(schema) || CheckMaxContains(stack, context, schema, value)) && (!IsMaxItems(schema) || CheckMaxItems(stack, context, schema, value)) && (!IsMinContains(schema) || CheckMinContains(stack, context, schema, value)) && (!IsMinItems(schema) || CheckMinItems(stack, context, schema, value)) && (!IsPrefixItems(schema) || CheckPrefixItems(stack, context, schema, value)) && (!IsUniqueItems(schema) || CheckUniqueItems(stack, context, schema, value))) && (!guard_exports.IsString(value) || (!IsMaxLength3(schema) || CheckMaxLength(stack, context, schema, value)) && (!IsMinLength3(schema) || CheckMinLength(stack, context, schema, value)) && (!IsFormat(schema) || CheckFormat(stack, context, schema, value)) && (!IsPattern(schema) || CheckPattern(stack, context, schema, value))) && (!(guard_exports.IsNumber(value) || guard_exports.IsBigInt(value)) || (!IsExclusiveMaximum(schema) || CheckExclusiveMaximum(stack, context, schema, value)) && (!IsExclusiveMinimum(schema) || CheckExclusiveMinimum(stack, context, schema, value)) && (!IsMaximum(schema) || CheckMaximum(stack, context, schema, value)) && (!IsMinimum(schema) || CheckMinimum(stack, context, schema, value)) && (!IsMultipleOf2(schema) || CheckMultipleOf(stack, context, schema, value))) && (!IsRef2(schema) || CheckRef(stack, context, schema, value)) && (!IsRecursiveRef(schema) || CheckRecursiveRef(stack, context, schema, value)) && (!IsDynamicRef(schema) || CheckDynamicRef(stack, context, schema, value)) && (!IsConst(schema) || CheckConst(stack, context, schema, value)) && (!IsEnum2(schema) || CheckEnum(stack, context, schema, value)) && (!IsIf(schema) || CheckIf(stack, context, schema, value)) && (!IsNot(schema) || CheckNot(stack, context, schema, value)) && (!IsAllOf(schema) || CheckAllOf(stack, context, schema, value)) && (!IsAnyOf(schema) || CheckAnyOf(stack, context, schema, value)) && (!IsOneOf(schema) || CheckOneOf(stack, context, schema, value)) && (!IsUnevaluatedItems(schema) || (!guard_exports.IsArray(value) || CheckUnevaluatedItems(stack, context, schema, value))) && (!IsUnevaluatedProperties(schema) || (!guard_exports.IsObject(value) || CheckUnevaluatedProperties(stack, context, schema, value))) && (!IsRefine2(schema) || CheckRefine(stack, context, schema, value));
  stack.Pop(schema);
  return result;
}
function ErrorSchemaPushStack(stack, context, schemaPath, instancePath, schema, value) {
  return context.Push() && ErrorSchema(stack, context, schemaPath, instancePath, schema, value) && context.Pop();
}
function ErrorSchema(stack, context, schemaPath, instancePath, schema, value) {
  stack.Push(schema);
  const result = IsSchemaBoolean(schema) ? ErrorSchemaBoolean(stack, context, schemaPath, instancePath, schema, value) : !!(+(!IsType(schema) || ErrorType(stack, context, schemaPath, instancePath, schema, value)) & +(!(guard_exports.IsObject(value) && !guard_exports.IsArray(value)) || !!(+(!IsRequired(schema) || ErrorRequired(stack, context, schemaPath, instancePath, schema, value)) & +(!IsAdditionalProperties(schema) || ErrorAdditionalProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDependencies(schema) || ErrorDependencies(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDependentRequired(schema) || ErrorDependentRequired(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDependentSchemas(schema) || ErrorDependentSchemas(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPatternProperties(schema) || ErrorPatternProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsProperties(schema) || ErrorProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPropertyNames(schema) || ErrorPropertyNames(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinProperties(schema) || ErrorMinProperties(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaxProperties(schema) || ErrorMaxProperties(stack, context, schemaPath, instancePath, schema, value)))) & +(!guard_exports.IsArray(value) || !!(+(!IsAdditionalItems(schema) || ErrorAdditionalItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsContains(schema) || ErrorContains(stack, context, schemaPath, instancePath, schema, value)) & +(!IsItems(schema) || ErrorItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaxContains(schema) || ErrorMaxContains(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaxItems(schema) || ErrorMaxItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinContains(schema) || ErrorMinContains(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinItems(schema) || ErrorMinItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPrefixItems(schema) || ErrorPrefixItems(stack, context, schemaPath, instancePath, schema, value)) & +(!IsUniqueItems(schema) || ErrorUniqueItems(stack, context, schemaPath, instancePath, schema, value)))) & +(!guard_exports.IsString(value) || !!(+(!IsMaxLength3(schema) || ErrorMaxLength(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinLength3(schema) || ErrorMinLength(stack, context, schemaPath, instancePath, schema, value)) & +(!IsFormat(schema) || ErrorFormat(stack, context, schemaPath, instancePath, schema, value)) & +(!IsPattern(schema) || ErrorPattern(stack, context, schemaPath, instancePath, schema, value)))) & +(!(guard_exports.IsNumber(value) || guard_exports.IsBigInt(value)) || !!(+(!IsExclusiveMaximum(schema) || ErrorExclusiveMaximum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsExclusiveMinimum(schema) || ErrorExclusiveMinimum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMaximum(schema) || ErrorMaximum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMinimum(schema) || ErrorMinimum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsMultipleOf2(schema) || ErrorMultipleOf(stack, context, schemaPath, instancePath, schema, value)))) & +(!IsRef2(schema) || ErrorRef(stack, context, schemaPath, instancePath, schema, value)) & +(!IsRecursiveRef(schema) || ErrorRecursiveRef(stack, context, schemaPath, instancePath, schema, value)) & +(!IsDynamicRef(schema) || ErrorDynamicRef(stack, context, schemaPath, instancePath, schema, value)) & +(!IsConst(schema) || ErrorConst(stack, context, schemaPath, instancePath, schema, value)) & +(!IsEnum2(schema) || ErrorEnum(stack, context, schemaPath, instancePath, schema, value)) & +(!IsIf(schema) || ErrorIf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsNot(schema) || ErrorNot(stack, context, schemaPath, instancePath, schema, value)) & +(!IsAllOf(schema) || ErrorAllOf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsAnyOf(schema) || ErrorAnyOf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsOneOf(schema) || ErrorOneOf(stack, context, schemaPath, instancePath, schema, value)) & +(!IsUnevaluatedItems(schema) || (!guard_exports.IsArray(value) || ErrorUnevaluatedItems(stack, context, schemaPath, instancePath, schema, value))) & +(!IsUnevaluatedProperties(schema) || (!guard_exports.IsObject(value) || ErrorUnevaluatedProperties(stack, context, schemaPath, instancePath, schema, value)))) && (!IsRefine2(schema) || ErrorRefine(stack, context, schemaPath, instancePath, schema, value));
  stack.Pop(schema);
  return result;
}

// node_modules/typebox/build/schema/resolve/resolve.mjs
var resolve_exports = {};
__export(resolve_exports, {
  DynamicRef: () => DynamicRef,
  Ref: () => Ref2
});

// node_modules/typebox/build/schema/pointer/pointer.mjs
var pointer_exports = {};
__export(pointer_exports, {
  Delete: () => Delete,
  Get: () => Get4,
  Has: () => Has2,
  Indices: () => Indices,
  Set: () => Set4
});
function AssertNotRoot(indices) {
  if (indices.length === 0)
    throw Error("Cannot set root");
}
function AssertCanSet(value) {
  if (!guard_exports.IsObject(value))
    throw Error("Cannot set value");
}
function AssertIndex(index) {
  if (guard_exports.IsUnsafePropertyKey(index))
    throw Error("Pointer contains unsafe property key");
}
function AssertIndices(indices) {
  for (const index of indices)
    AssertIndex(index);
}
function IsNumericIndex(index) {
  return /^(0|[1-9]\d*)$/.test(index);
}
function TakeIndexRight(indices) {
  return [
    indices.slice(0, indices.length - 1),
    indices.slice(indices.length - 1)[0]
  ];
}
function HasIndex(index, value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, index);
}
function GetIndex(index, value) {
  return guard_exports.IsObject(value) && !guard_exports.IsUnsafePropertyKey(index) ? value[index] : void 0;
}
function GetIndices(indices, value) {
  return indices.reduce((value2, index) => GetIndex(index, value2), value);
}
function Indices(pointer) {
  if (guard_exports.IsEqual(pointer.length, 0))
    return [];
  const indices = pointer.split("/").map((index) => index.replace(/~1/g, "/").replace(/~0/g, "~"));
  return indices.length > 0 && indices[0] === "" ? indices.slice(1) : indices;
}
function Has2(value, pointer) {
  let current = value;
  return Indices(pointer).every((index) => {
    if (!HasIndex(index, current))
      return false;
    current = current[index];
    return true;
  });
}
function Get4(value, pointer) {
  const indices = Indices(pointer);
  return GetIndices(indices, value);
}
function Set4(value, pointer, next) {
  const indices = Indices(pointer);
  AssertNotRoot(indices);
  AssertIndices(indices);
  const [head, index] = TakeIndexRight(indices);
  const parent = GetIndices(head, value);
  AssertCanSet(parent);
  parent[index] = next;
  return value;
}
function Delete(value, pointer) {
  const indices = Indices(pointer);
  AssertNotRoot(indices);
  AssertIndices(indices);
  const [head, index] = TakeIndexRight(indices);
  const parent = GetIndices(head, value);
  AssertCanSet(parent);
  if (guard_exports.IsArray(parent) && IsNumericIndex(index)) {
    parent.splice(+index, 1);
  } else {
    delete parent[index];
  }
  return value;
}

// node_modules/typebox/build/schema/resolve/ref.mjs
function MatchId(schema, base, ref) {
  if (schema.$id === ref.hash)
    return schema;
  const absoluteId = new URL(schema.$id, base.href);
  const absoluteRef = new URL(ref.href, base.href);
  if (guard_exports.IsEqual(absoluteId.pathname, absoluteRef.pathname)) {
    return ref.hash.startsWith("#") ? MatchHash(schema, base, ref) : schema;
  }
  return void 0;
}
function MatchAnchor(schema, base, ref) {
  const absoluteAnchor = new URL(`#${schema.$anchor}`, base.href);
  const absoluteRef = new URL(ref.href, base.href);
  return guard_exports.IsEqual(absoluteAnchor.href, absoluteRef.href) ? schema : void 0;
}
function MatchDynamicAnchor(schema, base, ref) {
  const absoluteAnchor = new URL(`#${schema.$dynamicAnchor}`, base.href);
  const absoluteRef = new URL(ref.href, base.href);
  return guard_exports.IsEqual(absoluteAnchor.href, absoluteRef.href) ? schema : void 0;
}
function MatchHash(schema, _base, ref) {
  if (ref.href.endsWith("#"))
    return schema;
  if (!ref.hash.startsWith("#"))
    return void 0;
  const fragment = decodeURIComponent(ref.hash.slice(1));
  if (!fragment.startsWith("/"))
    return void 0;
  return pointer_exports.Get(schema, fragment);
}
function Match4(schema, base, ref) {
  if (IsId(schema)) {
    const result = MatchId(schema, base, ref);
    if (!guard_exports.IsUndefined(result))
      return result;
  }
  if (IsAnchor(schema)) {
    const result = MatchAnchor(schema, base, ref);
    if (!guard_exports.IsUndefined(result))
      return result;
  }
  if (IsDynamicAnchor(schema)) {
    const result = MatchDynamicAnchor(schema, base, ref);
    if (!guard_exports.IsUndefined(result))
      return result;
  }
  return MatchHash(schema, base, ref);
}
function FromArray6(schema, base, ref) {
  return schema.reduce((result, item) => {
    const match = FromValue3(item, base, ref);
    return !guard_exports.IsUndefined(match) ? match : result;
  }, void 0);
}
function FromObject10(schema, base, ref) {
  return guard_exports.Keys(schema).reduce((result, key) => {
    const match = FromValue3(schema[key], base, ref);
    return !guard_exports.IsUndefined(match) ? match : result;
  }, void 0);
}
function FromValue3(schema, base, ref) {
  const nextBase = IsSchemaObject(schema) && IsId(schema) ? new URL(schema.$id, base.href) : base;
  if (IsSchemaObject(schema)) {
    const result = Match4(schema, nextBase, ref);
    if (!guard_exports.IsUndefined(result))
      return result;
  }
  if (guard_exports.IsArray(schema))
    return FromArray6(schema, nextBase, ref);
  if (guard_exports.IsObject(schema))
    return FromObject10(schema, nextBase, ref);
  return void 0;
}
function Ref2(schema, ref) {
  const defaultBase = new URL("http://unknown/");
  const initialBase = IsId(schema) ? new URL(schema.$id, defaultBase.href) : defaultBase;
  const initialRef = new URL(ref, initialBase.href);
  return FromValue3(schema, initialBase, initialRef);
}
function DynamicRef(root, base, dynamicRef, dynamicAnchors) {
  const fragmentTarget = dynamicRef.$dynamicRef.startsWith("#") ? Ref2(base, dynamicRef.$dynamicRef) : Ref2(root, dynamicRef.$dynamicRef);
  if (guard_exports.IsUndefined(fragmentTarget))
    return void 0;
  if (!IsSchemaObject(fragmentTarget) || !IsDynamicAnchor(fragmentTarget))
    return fragmentTarget;
  const fragment = new URL(dynamicRef.$dynamicRef, "http://unknown/").hash;
  if (fragment.startsWith("#/"))
    return fragmentTarget;
  const anchorTarget = dynamicAnchors.find((anchor) => anchor.$dynamicAnchor === fragmentTarget.$dynamicAnchor);
  return anchorTarget ?? fragmentTarget;
}

// node_modules/typebox/build/schema/engine/_stack.mjs
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _Stack_instances;
var _Stack_PushResourceAnchors;
var _Stack_PopResourceAnchors;
var _Stack_FromContext;
var _Stack_FromRef;
var Stack = class {
  constructor(context, schema) {
    _Stack_instances.add(this);
    this.context = context;
    this.schema = schema;
    this.ids = [];
    this.anchors = [];
    this.recursiveAnchors = [];
    this.dynamicAnchors = [];
  }
  // ----------------------------------------------------------------
  // Base
  // ----------------------------------------------------------------
  BaseURL() {
    return this.ids.reduce((result, schema) => new URL(schema.$id, result), new URL("http://unknown"));
  }
  Base() {
    return this.ids[this.ids.length - 1] ?? this.schema;
  }
  // ----------------------------------------------------------------
  // Stack
  // ----------------------------------------------------------------
  Push(schema) {
    if (!IsSchemaObject(schema))
      return;
    if (IsId(schema)) {
      this.ids.push(schema);
      __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PushResourceAnchors).call(this, schema);
    }
    if (IsAnchor(schema))
      this.anchors.push(schema);
    if (IsRecursiveAnchorTrue(schema))
      this.recursiveAnchors.push(schema);
    if (IsDynamicAnchor(schema))
      this.dynamicAnchors.push(schema);
  }
  Pop(schema) {
    if (!IsSchemaObject(schema))
      return;
    if (IsId(schema)) {
      this.ids.pop();
      __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PopResourceAnchors).call(this, schema);
    }
    if (IsAnchor(schema))
      this.anchors.pop();
    if (IsRecursiveAnchorTrue(schema))
      this.recursiveAnchors.pop();
    if (IsDynamicAnchor(schema))
      this.dynamicAnchors.pop();
  }
  Ref(ref) {
    return __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_FromContext).call(this, ref) ?? __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_FromRef).call(this, ref);
  }
  // ----------------------------------------------------------------
  // RecursiveRef
  // ----------------------------------------------------------------
  RecursiveRef(recursiveRef) {
    return IsRecursiveAnchorTrue(this.Base()) ? resolve_exports.Ref(this.recursiveAnchors[0], recursiveRef.$recursiveRef) : resolve_exports.Ref(this.Base(), recursiveRef.$recursiveRef);
  }
  // ----------------------------------------------------------------
  // DynamicRef
  // ----------------------------------------------------------------
  DynamicRef(dynamicRef) {
    const root = this.schema;
    return resolve_exports.DynamicRef(root, this.Base(), dynamicRef, this.dynamicAnchors);
  }
};
_Stack_instances = /* @__PURE__ */ new WeakSet(), _Stack_PushResourceAnchors = function _Stack_PushResourceAnchors2(schema, isRoot = true) {
  if (!IsSchemaObject(schema))
    return;
  const current = schema;
  if (!isRoot && IsId(current))
    return;
  if (!isRoot && IsDynamicAnchor(current))
    this.dynamicAnchors.push(current);
  for (const key of guard_exports.Keys(current))
    __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PushResourceAnchors2).call(this, current[key], false);
}, _Stack_PopResourceAnchors = function _Stack_PopResourceAnchors2(schema, isRoot = true) {
  if (!IsSchemaObject(schema))
    return;
  const current = schema;
  if (!isRoot && IsId(current))
    return;
  if (!isRoot && IsDynamicAnchor(current))
    this.dynamicAnchors.pop();
  for (const key of guard_exports.Keys(current))
    __classPrivateFieldGet(this, _Stack_instances, "m", _Stack_PopResourceAnchors2).call(this, current[key], false);
}, _Stack_FromContext = function _Stack_FromContext2(ref) {
  return guard_exports.HasPropertyKey(this.context, ref.$ref) ? this.context[ref.$ref] : void 0;
}, _Stack_FromRef = function _Stack_FromRef2(ref) {
  const root = this.schema;
  return !ref.$ref.startsWith("#") ? resolve_exports.Ref(root, ref.$ref) : resolve_exports.Ref(this.Base(), ref.$ref);
};

// node_modules/typebox/build/schema/errors.mjs
function Errors(...args) {
  const [context, schema, value] = arguments_exports.Match(args, {
    3: (context2, schema2, value2) => [context2, schema2, value2],
    2: (schema2, value2) => [{}, schema2, value2]
  });
  const settings2 = settings_exports.Get();
  const locale2 = Get2();
  const errors = [];
  const stack = new Stack(context, schema);
  const errorContext = new ErrorContext((error) => {
    if (guard_exports.IsGreaterEqualThan(errors.length, settings2.maxErrors))
      return;
    return errors.push({ ...error, message: locale2(error) });
  });
  const result = ErrorSchema(stack, errorContext, "#", "", schema, value);
  return [result, errors];
}

// node_modules/typebox/build/schema/check.mjs
function Check(...args) {
  const [context, schema, value] = arguments_exports.Match(args, {
    3: (context2, schema2, value2) => [context2, schema2, value2],
    2: (schema2, value2) => [{}, schema2, value2]
  });
  const stack = new Stack(context, schema);
  const checkContext = new CheckContext();
  return CheckSchema(stack, checkContext, schema, value);
}

// node_modules/typebox/build/value/check/check.mjs
function Check2(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return Check(context, type, value);
}

// node_modules/typebox/build/value/errors/errors.mjs
function Errors2(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const [_, errors] = Errors(context, type, value);
  return errors;
}

// node_modules/typebox/build/value/assert/assert.mjs
var AssertError = class extends Error {
  constructor(source, value, errors) {
    super(source);
    Object.defineProperty(this, "cause", {
      value: { source, errors, value },
      writable: false,
      configurable: false,
      enumerable: false
    });
  }
};
function Assert(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const check = Check2(context, type, value);
  if (!check)
    throw new AssertError("Assert", value, Errors2(context, type, value));
}

// node_modules/typebox/build/value/clean/from_array.mjs
function FromArray7(context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  return value.map((value2) => FromType19(context, type.items, value2));
}

// node_modules/typebox/build/value/clean/from_cyclic.mjs
function FromCyclic6(context, type, value) {
  return FromType19({ ...context, ...type.$defs }, Ref(type.$ref), value);
}

// node_modules/typebox/build/value/clean/from_intersect.mjs
function EvaluateIntersection(context, type) {
  const additionalProperties = guard_exports.HasPropertyKey(type, "unevaluatedProperties") ? { additionalProperties: type.unevaluatedProperties } : {};
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return IsObject2(evaluated) ? With2(evaluated, additionalProperties) : evaluated;
}
function FromIntersect6(context, type, value) {
  const evaluated = EvaluateIntersection(context, type);
  return FromType19(context, evaluated, value);
}

// node_modules/typebox/build/value/clean/additional.mjs
function GetAdditionalProperties(type) {
  const additionalProperties = guard_exports.HasPropertyKey(type, "additionalProperties") ? type.additionalProperties : void 0;
  return additionalProperties;
}

// node_modules/typebox/build/value/clean/from_object.mjs
function FromObject11(context, type, value) {
  if (!guard_exports.IsObject(value) || guard_exports.IsArray(value))
    return value;
  const additionalProperties = GetAdditionalProperties(type);
  for (const key of guard_exports.Keys(value)) {
    if (guard_exports.HasPropertyKey(type.properties, key)) {
      value[key] = FromType19(context, type.properties[key], value[key]);
      continue;
    }
    const unknownCheck = (
      // 1. additionalProperties: true
      guard_exports.IsBoolean(additionalProperties) && guard_exports.IsEqual(additionalProperties, true) || IsSchema(additionalProperties) && Check2(context, additionalProperties, value[key])
    );
    if (unknownCheck) {
      value[key] = FromType19(context, additionalProperties, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}

// node_modules/typebox/build/value/clean/from_record.mjs
function FromRecord3(context, type, value) {
  if (!guard_exports.IsObject(value))
    return value;
  const additionalProperties = GetAdditionalProperties(type);
  const [recordPattern, recordValue] = [new RegExp(RecordPattern(type)), RecordValue(type)];
  for (const key of guard_exports.Keys(value)) {
    if (recordPattern.test(key)) {
      value[key] = FromType19(context, recordValue, value[key]);
      continue;
    }
    const unknownCheck = (
      // 1. additionalProperties: true
      guard_exports.IsBoolean(additionalProperties) && guard_exports.IsEqual(additionalProperties, true) || IsSchema(additionalProperties) && Check2(context, additionalProperties, value[key])
    );
    if (unknownCheck) {
      value[key] = FromType19(context, additionalProperties, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}

// node_modules/typebox/build/value/clean/from_ref.mjs
function FromRef5(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType19(context, context[type.$ref], value) : value;
}

// node_modules/typebox/build/value/clean/from_tuple.mjs
function FromTuple5(context, schema, value) {
  if (!guard_exports.IsArray(value))
    return value;
  const length = Math.min(value.length, schema.items.length);
  for (let index = 0; index < length; index++) {
    value[index] = FromType19(context, schema.items[index], value[index]);
  }
  return guard_exports.IsGreaterThan(value.length, length) ? value.slice(0, length) : value;
}

// node_modules/typebox/build/value/clone/clone.mjs
function Clone2(value) {
  return Clone(value);
}

// node_modules/typebox/build/value/clean/from_union.mjs
function FromUnion9(context, type, value) {
  for (const schema of type.anyOf) {
    const clean = FromType19(context, schema, Clone2(value));
    if (Check2(context, schema, clean))
      return clean;
  }
  return value;
}

// node_modules/typebox/build/value/clean/from_type.mjs
function FromType19(context, type, value) {
  return IsArray2(type) ? FromArray7(context, type, value) : IsCyclic(type) ? FromCyclic6(context, type, value) : IsIntersect(type) ? FromIntersect6(context, type, value) : IsObject2(type) ? FromObject11(context, type, value) : IsRecord(type) ? FromRecord3(context, type, value) : IsRef(type) ? FromRef5(context, type, value) : IsTuple(type) ? FromTuple5(context, type, value) : IsUnion(type) ? FromUnion9(context, type, value) : value;
}

// node_modules/typebox/build/value/shared/union_priority_sort.mjs
function Modifiers(type, next) {
  for (const key of guard_default.Keys(type)) {
    if (guard_default.HasPropertyKey(next, key))
      continue;
    next[key] = type[key];
  }
  return next;
}
function FromProperties4(properties) {
  const result = {};
  for (const key of guard_default.Keys(properties))
    result[key] = FromType20(properties[key]);
  return result;
}
function FromPriorityTypes(types) {
  return FromTypes6(Priority(types));
}
function FromTypes6(types) {
  return types.map((type) => FromType20(type));
}
function FromType20(type) {
  const next = IsArray2(type) ? _Array_(FromType20(type.items), ArrayOptions(type)) : IsIntersect(type) ? Intersect(FromTypes6(type.allOf)) : IsUnion(type) ? Union(FromPriorityTypes(type.anyOf)) : IsObject2(type) ? _Object_(FromProperties4(type.properties)) : IsRecord(type) ? Record(RecordKey(type), FromType20(RecordValue(type))) : IsTuple(type) ? Tuple(FromTypes6(type.items)) : type;
  return Modifiers(type, next);
}
function UnionPrioritySort(type) {
  const result = FromType20(type);
  return result;
}

// node_modules/typebox/build/value/clean/clean.mjs
function Clean(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const sorted = settings_exports.Get().unionPrioritySort ? UnionPrioritySort(type) : type;
  return FromType19(context, sorted, value);
}

// node_modules/typebox/build/value/convert/try/try.mjs
var try_exports = {};
__export(try_exports, {
  Fail: () => Fail,
  IsOk: () => IsOk,
  Ok: () => Ok,
  TryArray: () => TryArray,
  TryBigInt: () => TryBigInt,
  TryBoolean: () => TryBoolean,
  TryNull: () => TryNull,
  TryNumber: () => TryNumber,
  TryString: () => TryString,
  TryUndefined: () => TryUndefined
});

// node_modules/typebox/build/value/convert/try/try_result.mjs
function IsOk(value) {
  return guard_exports.IsObject(value) && guard_exports.HasPropertyKey(value, "value");
}
function Ok(value) {
  return { value };
}
function Fail() {
  return void 0;
}

// node_modules/typebox/build/value/convert/try/try_array.mjs
function TryArray(value) {
  return guard_exports.IsArray(value) ? Ok(value) : Ok([value]);
}

// node_modules/typebox/build/value/convert/try/try_bigint.mjs
function FromBoolean2(value) {
  return guard_exports.IsEqual(value, true) ? Ok(BigInt(1)) : Ok(BigInt(0));
}
var bigintPattern = /^-?(0|[1-9]\d*)n$/;
var decimalPattern = /^-?(0|[1-9]\d*)\.\d+$/;
var integerPattern = /^-?(0|[1-9]\d*)$/;
function IsStringBigIntLike(value) {
  return bigintPattern.test(value);
}
function IsStringDecimalLike(value) {
  return decimalPattern.test(value);
}
function IsStringIntegerLike(value) {
  return integerPattern.test(value);
}
function FromString2(value) {
  const lowercase = value.toLowerCase();
  return IsStringBigIntLike(value) ? Ok(BigInt(value.slice(0, value.length - 1))) : IsStringDecimalLike(value) ? Ok(BigInt(value.split(".")[0])) : IsStringIntegerLike(value) ? Ok(BigInt(value)) : guard_exports.IsEqual(lowercase, "false") ? Ok(BigInt(0)) : guard_exports.IsEqual(lowercase, "true") ? Ok(BigInt(1)) : Fail();
}
function TryBigInt(value) {
  return guard_exports.IsBigInt(value) ? Ok(value) : guard_exports.IsBoolean(value) ? FromBoolean2(value) : guard_exports.IsNumber(value) ? Ok(BigInt(Math.trunc(value))) : guard_exports.IsNull(value) ? Ok(BigInt(0)) : guard_exports.IsString(value) ? FromString2(value) : guard_exports.IsUndefined(value) ? Ok(BigInt(0)) : Fail();
}

// node_modules/typebox/build/value/convert/try/try_boolean.mjs
function FromBigInt2(value) {
  return guard_exports.IsEqual(value, BigInt(0)) ? Ok(false) : guard_exports.IsEqual(value, BigInt(1)) ? Ok(true) : Fail();
}
function FromNumber2(value) {
  return guard_exports.IsEqual(value, 0) ? Ok(false) : guard_exports.IsEqual(value, 1) ? Ok(true) : Fail();
}
function FromString3(value) {
  return guard_exports.IsEqual(value.toLowerCase(), "false") ? Ok(false) : guard_exports.IsEqual(value.toLowerCase(), "true") ? Ok(true) : guard_exports.IsEqual(value, "0") ? Ok(false) : guard_exports.IsEqual(value, "1") ? Ok(true) : Fail();
}
function TryBoolean(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt2(value) : guard_exports.IsBoolean(value) ? Ok(value) : guard_exports.IsNumber(value) ? FromNumber2(value) : guard_exports.IsNull(value) ? Ok(false) : guard_exports.IsString(value) ? FromString3(value) : guard_exports.IsUndefined(value) ? Ok(false) : Fail();
}

// node_modules/typebox/build/value/convert/try/try_null.mjs
function FromBigInt3(value) {
  return guard_exports.IsEqual(value, BigInt(0)) ? Ok(null) : Fail();
}
function FromBoolean3(value) {
  return guard_exports.IsEqual(value, false) ? Ok(null) : Fail();
}
function FromNumber3(value) {
  return guard_exports.IsEqual(value, 0) ? Ok(null) : Fail();
}
function FromString4(value) {
  const lowercase = value.toLowerCase();
  const predicate = guard_exports.IsEqual(lowercase, "undefined") || guard_exports.IsEqual(lowercase, "null") || guard_exports.IsEqual(value, "") || guard_exports.IsEqual(value, "0");
  return predicate ? Ok(null) : Fail();
}
function TryNull(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt3(value) : guard_exports.IsBoolean(value) ? FromBoolean3(value) : guard_exports.IsNumber(value) ? FromNumber3(value) : guard_exports.IsNull(value) ? Ok(null) : guard_exports.IsString(value) ? FromString4(value) : guard_exports.IsUndefined(value) ? Ok(null) : Fail();
}

// node_modules/typebox/build/value/convert/try/try_number.mjs
var maxBigInt = BigInt(Number.MAX_SAFE_INTEGER);
var minBigInt = BigInt(Number.MIN_SAFE_INTEGER);
function FromBigInt4(value) {
  return value <= maxBigInt && value >= minBigInt ? Ok(Number(value)) : Fail();
}
function FromBoolean4(value) {
  return Ok(value ? 1 : 0);
}
function FromString5(value) {
  const coerced = +value;
  if (guard_exports.IsNumber(coerced))
    return Ok(coerced);
  const lowercase = value.toLowerCase();
  if (guard_exports.IsEqual(lowercase, "false"))
    return Ok(0);
  if (guard_exports.IsEqual(lowercase, "true"))
    return Ok(1);
  const result = TryBigInt(value);
  if (IsOk(result))
    return result.value <= maxBigInt && result.value >= minBigInt ? Ok(Number(result.value)) : Fail();
  return Fail();
}
function TryNumber(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt4(value) : guard_exports.IsBoolean(value) ? FromBoolean4(value) : guard_exports.IsNumber(value) ? Ok(value) : guard_exports.IsNull(value) ? Ok(0) : guard_exports.IsString(value) ? FromString5(value) : guard_exports.IsUndefined(value) ? Ok(0) : Fail();
}

// node_modules/typebox/build/value/convert/try/try_string.mjs
function TryString(value) {
  return guard_exports.IsBigInt(value) ? Ok(value.toString()) : guard_exports.IsBoolean(value) ? Ok(value.toString()) : guard_exports.IsNumber(value) ? Ok(value.toString()) : guard_exports.IsNull(value) ? Ok("null") : guard_exports.IsString(value) ? Ok(value) : guard_exports.IsUndefined(value) ? Ok("") : Fail();
}

// node_modules/typebox/build/value/convert/try/try_undefined.mjs
function FromBigInt5(value) {
  return guard_exports.IsEqual(value, BigInt(0)) ? Ok(void 0) : Fail();
}
function FromBoolean5(value) {
  return guard_exports.IsEqual(value, false) ? Ok(void 0) : Fail();
}
function FromNumber4(value) {
  return guard_exports.IsEqual(value, 0) ? Ok(void 0) : Fail();
}
function FromString6(value) {
  const lowercase = value.toLowerCase();
  const predicate = guard_exports.IsEqual(lowercase, "undefined") || guard_exports.IsEqual(lowercase, "null") || guard_exports.IsEqual(value, "") || guard_exports.IsEqual(value, "0");
  return predicate ? Ok(void 0) : Fail();
}
function TryUndefined(value) {
  return guard_exports.IsBigInt(value) ? FromBigInt5(value) : guard_exports.IsBoolean(value) ? FromBoolean5(value) : guard_exports.IsNumber(value) ? FromNumber4(value) : guard_exports.IsNull(value) ? Ok(void 0) : guard_exports.IsString(value) ? FromString6(value) : guard_exports.IsUndefined(value) ? Ok(value) : Fail();
}

// node_modules/typebox/build/value/convert/from_array.mjs
function FromArray8(context, type, value) {
  const result = try_exports.TryArray(value);
  return result.value.map((value2) => FromType21(context, type.items, value2));
}

// node_modules/typebox/build/value/convert/from_bigint.mjs
function FromBigInt6(_context, _type, value) {
  const result = try_exports.TryBigInt(value);
  return try_exports.IsOk(result) ? result.value : value;
}

// node_modules/typebox/build/value/convert/from_boolean.mjs
function FromBoolean6(_context, _type, value) {
  const result = try_exports.TryBoolean(value);
  return try_exports.IsOk(result) ? result.value : value;
}

// node_modules/typebox/build/value/convert/from_cyclic.mjs
function FromCyclic7(context, type, value) {
  return FromType21({ ...context, ...type.$defs }, Ref(type.$ref), value);
}

// node_modules/typebox/build/value/convert/from_enum.mjs
function FromEnum3(context, type, value) {
  return FromType21(context, Evaluate(type), value);
}

// node_modules/typebox/build/value/convert/from_integer.mjs
function FromInteger(_context, _type, value) {
  const result = try_exports.TryNumber(value);
  return try_exports.IsOk(result) ? Math.trunc(result.value) : value;
}

// node_modules/typebox/build/value/convert/from_intersect.mjs
function FromIntersect7(context, type, value) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType21(context, evaluated, value);
}

// node_modules/typebox/build/value/convert/from_literal.mjs
function FromLiteralBigInt(_context, type, value) {
  const result = try_exports.TryBigInt(value);
  return try_exports.IsOk(result) && guard_exports.IsEqual(type.const, result.value) ? result.value : value;
}
function FromLiteralBoolean(_context, type, value) {
  const result = try_exports.TryBoolean(value);
  return try_exports.IsOk(result) && guard_exports.IsEqual(type.const, result.value) ? result.value : value;
}
function FromLiteralNumber(_context, type, value) {
  const result = try_exports.TryNumber(value);
  return try_exports.IsOk(result) && guard_exports.IsEqual(type.const, result.value) ? result.value : value;
}
function FromLiteralString(_context, type, value) {
  const result = try_exports.TryString(value);
  return try_exports.IsOk(result) && guard_exports.IsEqual(type.const, result.value) ? result.value : value;
}
function FromLiteral6(context, type, value) {
  if (guard_exports.IsEqual(type.const, value))
    return value;
  return IsLiteralBigInt(type) ? FromLiteralBigInt(context, type, value) : IsLiteralBoolean(type) ? FromLiteralBoolean(context, type, value) : IsLiteralNumber(type) ? FromLiteralNumber(context, type, value) : IsLiteralString(type) ? FromLiteralString(context, type, value) : Unreachable();
}

// node_modules/typebox/build/value/convert/from_null.mjs
function FromNull2(_context, _type, value) {
  const result = try_exports.TryNull(value);
  return try_exports.IsOk(result) ? result.value : value;
}

// node_modules/typebox/build/value/convert/from_number.mjs
function FromNumber5(_context, _type, value) {
  const result = try_exports.TryNumber(value);
  return try_exports.IsOk(result) ? result.value : value;
}

// node_modules/typebox/build/value/convert/from_additional.mjs
function FromAdditionalProperties(context, entries, additionalProperties, value) {
  const keys = guard_exports.Keys(value);
  for (const [regexp, _] of entries) {
    for (const key of keys) {
      if (!regexp.test(key)) {
        value[key] = FromType21(context, additionalProperties, value[key]);
      }
    }
  }
  return value;
}

// node_modules/typebox/build/value/shared/optional_undefined.mjs
function IsOptionalUndefined(property, key, value) {
  return IsOptional(property) && guard_exports.IsUndefined(value[key]);
}

// node_modules/typebox/build/value/convert/from_object.mjs
function FromProperties5(context, type, value) {
  const entries = guard_exports.EntriesRegExp(type.properties);
  const keys = guard_exports.Keys(value);
  for (const [regexp, property] of entries) {
    for (const key of keys) {
      if (!regexp.test(key) || IsOptionalUndefined(property, key, value))
        continue;
      value[key] = FromType21(context, property, value[key]);
    }
  }
  return guard_exports.HasPropertyKey(type, "additionalProperties") && guard_exports.IsObject(type.additionalProperties) ? FromAdditionalProperties(context, entries, type.additionalProperties, value) : value;
}
function FromObject12(context, type, value) {
  return guard_exports.IsObjectNotArray(value) ? FromProperties5(context, type, value) : value;
}

// node_modules/typebox/build/value/convert/from_record.mjs
function FromPatternProperties(context, type, value) {
  const entries = guard_exports.EntriesRegExp(type.patternProperties);
  const keys = guard_exports.Keys(value);
  for (const [regexp, schema] of entries) {
    for (const key of keys) {
      if (regexp.test(key)) {
        value[key] = FromType21(context, schema, value[key]);
      }
    }
  }
  return guard_exports.HasPropertyKey(type, "additionalProperties") && guard_exports.IsObject(type.additionalProperties) ? FromAdditionalProperties(context, entries, type.additionalProperties, value) : value;
}
function FromRecord4(context, type, value) {
  return guard_exports.IsObjectNotArray(value) ? FromPatternProperties(context, type, value) : value;
}

// node_modules/typebox/build/value/convert/from_ref.mjs
function FromRef6(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType21(context, context[type.$ref], value) : value;
}

// node_modules/typebox/build/value/convert/from_string.mjs
function FromString7(_context, _type, value) {
  const result = try_exports.TryString(value);
  return try_exports.IsOk(result) ? result.value : value;
}

// node_modules/typebox/build/value/convert/from_template_literal.mjs
function FromTemplateLiteral4(context, type, value) {
  return FromType21(context, Evaluate(type), value);
}

// node_modules/typebox/build/value/convert/from_tuple.mjs
function FromTuple6(context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let index = 0; index < Math.min(type.items.length, value.length); index++) {
    value[index] = FromType21(context, type.items[index], value[index]);
  }
  return value;
}

// node_modules/typebox/build/value/convert/from_undefined.mjs
function FromUndefined2(_context, _type, value) {
  const result = try_exports.TryUndefined(value);
  return try_exports.IsOk(result) ? result.value : value;
}

// node_modules/typebox/build/value/convert/from_union.mjs
function FromUnion10(context, type, value) {
  const matched = type.anyOf.some((type2) => Check2(context, type2, value));
  if (matched)
    return value;
  const candidates = type.anyOf.map((type2) => FromType21(context, type2, Clone2(value)));
  const selected = candidates.find((value2) => Check2(context, type, value2));
  return guard_exports.IsUndefined(selected) ? value : selected;
}

// node_modules/typebox/build/value/convert/from_void.mjs
function FromVoid(_context, _type, value) {
  const result = try_exports.TryUndefined(value);
  return try_exports.IsOk(result) ? void 0 : value;
}

// node_modules/typebox/build/value/convert/from_type.mjs
function FromType21(context, type, value) {
  return IsArray2(type) ? FromArray8(context, type, value) : IsBigInt2(type) ? FromBigInt6(context, type, value) : IsBoolean3(type) ? FromBoolean6(context, type, value) : IsCyclic(type) ? FromCyclic7(context, type, value) : IsEnum(type) ? FromEnum3(context, type, value) : IsInteger2(type) ? FromInteger(context, type, value) : IsIntersect(type) ? FromIntersect7(context, type, value) : IsLiteral(type) ? FromLiteral6(context, type, value) : IsNull2(type) ? FromNull2(context, type, value) : IsNumber3(type) ? FromNumber5(context, type, value) : IsObject2(type) ? FromObject12(context, type, value) : IsRecord(type) ? FromRecord4(context, type, value) : IsRef(type) ? FromRef6(context, type, value) : IsString3(type) ? FromString7(context, type, value) : IsTemplateLiteral(type) ? FromTemplateLiteral4(context, type, value) : IsTuple(type) ? FromTuple6(context, type, value) : IsUndefined2(type) ? FromUndefined2(context, type, value) : IsUnion(type) ? FromUnion10(context, type, value) : IsVoid(type) ? FromVoid(context, type, value) : value;
}

// node_modules/typebox/build/value/convert/convert.mjs
function Convert(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return FromType21(context, type, value);
}

// node_modules/typebox/build/value/default/from_array.mjs
function FromArray9(context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let i = 0; i < value.length; i++) {
    value[i] = FromType22(context, type.items, value[i]);
  }
  return value;
}

// node_modules/typebox/build/value/default/from_cyclic.mjs
function FromCyclic8(context, type, value) {
  return FromType22({ ...context, ...type.$defs }, Ref(type.$ref), value);
}

// node_modules/typebox/build/value/default/from_default.mjs
function FromDefault(type, value) {
  if (!guard_exports.IsUndefined(value))
    return value;
  return guard_exports.IsFunction(type.default) ? type.default() : Clone2(type.default);
}

// node_modules/typebox/build/value/default/from_intersect.mjs
function FromIntersect8(context, type, value) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType22(context, evaluated, value);
}

// node_modules/typebox/build/value/default/from_object.mjs
function FromObject13(context, type, value) {
  if (!guard_exports.IsObject(value))
    return value;
  const knownPropertyKeys = guard_exports.Keys(type.properties);
  for (const key of knownPropertyKeys) {
    const propertyValue = FromType22(context, type.properties[key], value[key]);
    const isUnassignableUndefined = guard_exports.IsUndefined(propertyValue) && (IsOptional(type.properties[key]) || !guard_exports.HasPropertyKey(type.properties[key], "default"));
    if (isUnassignableUndefined)
      continue;
    value[key] = propertyValue;
  }
  if (!IsAdditionalProperties(type) || guard_exports.IsBoolean(type.additionalProperties))
    return value;
  for (const key of guard_exports.Keys(value)) {
    if (knownPropertyKeys.includes(key))
      continue;
    value[key] = FromType22(context, type.additionalProperties, value[key]);
  }
  return value;
}

// node_modules/typebox/build/value/default/from_record.mjs
function FromRecord5(context, type, value) {
  if (!guard_exports.IsObject(value))
    return value;
  const [recordKey, recordValue] = [new RegExp(RecordPattern(type)), RecordValue(type)];
  for (const key of guard_exports.Keys(value)) {
    if (!(recordKey.test(key) && IsDefault(recordValue)))
      continue;
    value[key] = FromType22(context, recordValue, value[key]);
  }
  if (!IsAdditionalProperties(type))
    return value;
  for (const key of guard_exports.Keys(value)) {
    if (recordKey.test(key))
      continue;
    value[key] = FromType22(context, type.additionalProperties, value[key]);
  }
  return value;
}

// node_modules/typebox/build/value/default/from_ref.mjs
function FromRef7(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType22(context, context[type.$ref], value) : value;
}

// node_modules/typebox/build/value/default/from_tuple.mjs
function FromTuple7(context, schema, value) {
  if (!guard_exports.IsArray(value))
    return value;
  const [items, max] = [schema.items, Math.max(schema.items.length, value.length)];
  for (let i = 0; i < max; i++) {
    if (i < items.length)
      value[i] = FromType22(context, items[i], value[i]);
  }
  return value;
}

// node_modules/typebox/build/value/default/from_union.mjs
function FromUnion11(context, schema, value) {
  for (const inner of schema.anyOf) {
    const result = FromType22(context, inner, Clone2(value));
    if (Check2(context, inner, result)) {
      return result;
    }
  }
  return value;
}

// node_modules/typebox/build/value/default/from_type.mjs
function FromType22(context, type, value) {
  const defaulted = IsDefault(type) ? FromDefault(type, value) : value;
  return IsArray2(type) ? FromArray9(context, type, defaulted) : IsCyclic(type) ? FromCyclic8(context, type, defaulted) : IsIntersect(type) ? FromIntersect8(context, type, defaulted) : IsObject2(type) ? FromObject13(context, type, defaulted) : IsRecord(type) ? FromRecord5(context, type, defaulted) : IsRef(type) ? FromRef7(context, type, defaulted) : IsTuple(type) ? FromTuple7(context, type, defaulted) : IsUnion(type) ? FromUnion11(context, type, defaulted) : defaulted;
}

// node_modules/typebox/build/value/default/default.mjs
function Default(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return FromType22(context, type, value);
}

// node_modules/typebox/build/value/pipeline/pipeline.mjs
function Pipeline(pipeline) {
  return (...args) => {
    const [context, type, value] = arguments_exports.Match(args, {
      3: (context2, type2, value2) => [context2, type2, value2],
      2: (type2, value2) => [{}, type2, value2]
    });
    return pipeline.reduce((result, func) => func(context, type, result), value);
  };
}

// node_modules/typebox/build/value/codec/callback.mjs
function Decode3(_context, type, value) {
  return type["~codec"].decode(value);
}
function Encode2(_context, type, value) {
  return type["~codec"].encode(value);
}
function Callback(direction, context, type, value) {
  if (!IsCodec(type))
    return value;
  return guard_exports.IsEqual(direction, "Decode") ? Decode3(context, type, value) : Encode2(context, type, value);
}

// node_modules/typebox/build/value/codec/from_array.mjs
function Decode4(direction, context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let i = 0; i < value.length; i++) {
    value[i] = FromType23(direction, context, type.items, value[i]);
  }
  return Callback(direction, context, type, value);
}
function Encode3(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsArray(exterior))
    return exterior;
  for (let i = 0; i < exterior.length; i++) {
    exterior[i] = FromType23(direction, context, type.items, exterior[i]);
  }
  return exterior;
}
function FromArray10(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode4(direction, context, type, value) : Encode3(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/from_cyclic.mjs
function FromCyclic9(direction, context, type, value) {
  value = FromType23(direction, { ...context, ...type.$defs }, Ref(type.$ref), value);
  return Callback(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/from_intersect.mjs
function MergeInteriors(interiors) {
  return interiors.reduce((results, interior) => ({ ...results, ...interior }), {});
}
function NonMatchingInterior(value, interiors) {
  for (const interior of interiors)
    if (!guard_exports.IsDeepEqual(value, interior))
      return interior;
  return value;
}
function Decode5(direction, context, type, value) {
  if (guard_exports.IsEqual(type.allOf.length, 0))
    return Callback(direction, context, type, value);
  const interiors = type.allOf.map((schema) => FromType23(direction, context, schema, Clean(schema, Clone2(value))));
  const structural = interiors.every((result) => guard_exports.IsObject(result));
  const exterior = structural ? MergeInteriors(interiors) : NonMatchingInterior(value, interiors);
  return Callback(direction, context, type, exterior);
}
function Encode4(direction, context, type, value) {
  if (guard_exports.IsEqual(type.allOf.length, 0))
    return Callback(direction, context, type, value);
  const exterior = Callback(direction, context, type, value);
  const interiors = type.allOf.map((schema) => FromType23(direction, context, schema, Clean(schema, Clone2(exterior))));
  const structural = interiors.every((result) => guard_exports.IsObject(result));
  if (structural)
    return MergeInteriors(interiors);
  return NonMatchingInterior(exterior, interiors);
}
function FromIntersect9(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode5(direction, context, type, value) : Encode4(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/from_object.mjs
function Decode6(direction, context, type, value) {
  if (!guard_exports.IsObjectNotArray(value))
    return value;
  for (const key of guard_exports.Keys(type.properties)) {
    if (!guard_exports.HasPropertyKey(value, key) || IsOptionalUndefined(type.properties[key], key, value))
      continue;
    value[key] = FromType23(direction, context, type.properties[key], value[key]);
  }
  return Callback(direction, context, type, value);
}
function Encode5(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsObjectNotArray(exterior))
    return exterior;
  for (const key of guard_exports.Keys(type.properties)) {
    if (!guard_exports.HasPropertyKey(exterior, key) || IsOptionalUndefined(type.properties[key], key, exterior))
      continue;
    exterior[key] = FromType23(direction, context, type.properties[key], exterior[key]);
  }
  return exterior;
}
function FromObject14(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode6(direction, context, type, value) : Encode5(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/from_record.mjs
function Decode7(direction, context, type, value) {
  if (!guard_exports.IsObjectNotArray(value))
    return value;
  const regexp = new RegExp(RecordPattern(type));
  for (const key of guard_exports.Keys(value)) {
    if (!regexp.test(key))
      continue;
    value[key] = FromType23(direction, context, RecordValue(type), value[key]);
  }
  return Callback(direction, context, type, value);
}
function Encode6(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsObjectNotArray(exterior))
    return exterior;
  const regexp = new RegExp(RecordPattern(type));
  for (const key of guard_exports.Keys(exterior)) {
    if (!regexp.test(key))
      continue;
    exterior[key] = FromType23(direction, context, RecordValue(type), exterior[key]);
  }
  return exterior;
}
function FromRecord6(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode7(direction, context, type, value) : Encode6(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/from_ref.mjs
function ResolveRef(direction, context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType23(direction, context, context[type.$ref], value) : value;
}
function FromRef8(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Callback(direction, context, type, ResolveRef(direction, context, type, value)) : ResolveRef(direction, context, type, Callback(direction, context, type, value));
}

// node_modules/typebox/build/value/codec/from_tuple.mjs
function Decode8(direction, context, type, value) {
  if (!guard_exports.IsArray(value))
    return value;
  for (let i = 0; i < Math.min(type.items.length, value.length); i++) {
    value[i] = FromType23(direction, context, type.items[i], value[i]);
  }
  return Callback(direction, context, type, value);
}
function Encode7(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  if (!guard_exports.IsArray(exterior))
    return value;
  for (let i = 0; i < Math.min(type.items.length, exterior.length); i++) {
    exterior[i] = FromType23(direction, context, type.items[i], exterior[i]);
  }
  return exterior;
}
function FromTuple8(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode8(direction, context, type, value) : Encode7(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/from_union.mjs
function Decode9(direction, context, type, value) {
  for (const schema of type.anyOf) {
    if (!Check2(context, schema, value))
      continue;
    const variant = FromType23(direction, context, schema, value);
    return Callback(direction, context, type, variant);
  }
  return value;
}
function Encode8(direction, context, type, value) {
  const exterior = Callback(direction, context, type, value);
  for (const schema of type.anyOf) {
    const variant = FromType23(direction, context, schema, Clone2(exterior));
    if (!Check2(context, schema, variant))
      continue;
    return variant;
  }
  return exterior;
}
function FromUnion12(direction, context, type, value) {
  return guard_exports.IsEqual(direction, "Decode") ? Decode9(direction, context, type, value) : Encode8(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/from_type.mjs
function FromType23(direction, context, type, value) {
  return IsArray2(type) ? FromArray10(direction, context, type, value) : IsCyclic(type) ? FromCyclic9(direction, context, type, value) : IsIntersect(type) ? FromIntersect9(direction, context, type, value) : IsObject2(type) ? FromObject14(direction, context, type, value) : IsRecord(type) ? FromRecord6(direction, context, type, value) : IsRef(type) ? FromRef8(direction, context, type, value) : IsTuple(type) ? FromTuple8(direction, context, type, value) : IsUnion(type) ? FromUnion12(direction, context, type, value) : Callback(direction, context, type, value);
}

// node_modules/typebox/build/value/codec/decode.mjs
var DecodeError = class extends AssertError {
  constructor(value, errors) {
    super("Decode", value, errors);
  }
};
function Assert2(context, type, value) {
  if (!Check2(context, type, value))
    throw new DecodeError(value, Errors2(context, type, value));
  return value;
}
function DecodeUnsafe(context, type, value) {
  const sorted = settings_exports.Get().unionPrioritySort ? UnionPrioritySort(type) : type;
  return FromType23("Decode", context, sorted, value);
}
var Decoder = Pipeline([
  (_context, _type, value) => Clone2(value),
  (context, type, value) => Default(context, type, value),
  (context, type, value) => Convert(context, type, value),
  (context, type, value) => Clean(context, type, value),
  (context, type, value) => Assert2(context, type, value),
  (context, type, value) => DecodeUnsafe(context, type, value)
]);
function Decode10(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return Decoder(context, type, value);
}

// node_modules/typebox/build/value/codec/encode.mjs
var EncodeError = class extends AssertError {
  constructor(value, errors) {
    super("Encode", value, errors);
  }
};
function Assert3(context, type, value) {
  if (!Check2(context, type, value))
    throw new EncodeError(value, Errors2(context, type, value));
  return value;
}
function EncodeUnsafe(context, type, value) {
  const sorted = settings_exports.Get().unionPrioritySort ? UnionPrioritySort(type) : type;
  return FromType23("Encode", context, sorted, value);
}
var Encoder = Pipeline([
  (_context, _type, value) => Clone2(value),
  (context, type, value) => EncodeUnsafe(context, type, value),
  (context, type, value) => Default(context, type, value),
  (context, type, value) => Convert(context, type, value),
  (context, type, value) => Clean(context, type, value),
  (context, type, value) => Assert3(context, type, value)
]);
function Encode9(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  return Encoder(context, type, value);
}

// node_modules/typebox/build/value/codec/has.mjs
function FromArray11(context, type) {
  return IsCodec(type) || FromType24(context, type.items);
}
function FromCyclic10(context, type) {
  return IsCodec(type) || FromRef9({ ...context, ...type.$defs }, Ref(type.$ref));
}
function FromIntersect10(context, type) {
  return IsCodec(type) || type.allOf.some((type2) => FromType24(context, type2));
}
function FromObject15(context, type) {
  return IsCodec(type) || guard_exports.Keys(type.properties).some((key) => {
    return FromType24(context, type.properties[key]);
  });
}
function FromRecord7(context, type) {
  return IsCodec(type) || FromType24(context, RecordValue(type));
}
function FromRef9(context, type) {
  if (visited.has(type.$ref))
    return false;
  visited.add(type.$ref);
  return IsCodec(type) || guard_exports.HasPropertyKey(context, type.$ref) && FromType24(context, context[type.$ref]);
}
function FromTuple9(context, type) {
  return IsCodec(type) || type.items.some((type2) => FromType24(context, type2));
}
function FromUnion13(context, type) {
  return IsCodec(type) || type.anyOf.some((type2) => FromType24(context, type2));
}
function FromType24(context, type) {
  return IsArray2(type) ? FromArray11(context, type) : IsCyclic(type) ? FromCyclic10(context, type) : IsIntersect(type) ? FromIntersect10(context, type) : IsObject2(type) ? FromObject15(context, type) : IsRecord(type) ? FromRecord7(context, type) : IsRef(type) ? FromRef9(context, type) : IsTuple(type) ? FromTuple9(context, type) : IsUnion(type) ? FromUnion13(context, type) : IsCodec(type);
}
var visited = /* @__PURE__ */ new Set();
function HasCodec(...args) {
  const [context, type] = arguments_exports.Match(args, {
    2: (context2, type2) => [context2, type2],
    1: (type2) => [{}, type2]
  });
  visited.clear();
  return FromType24(context, type);
}

// node_modules/typebox/build/value/create/error.mjs
var CreateError = class extends Error {
  constructor(type, message) {
    super(message);
    this.type = type;
  }
};

// node_modules/typebox/build/value/create/from_default.mjs
function FromDefault2(_context, schema) {
  return guard_exports.IsFunction(schema.default) ? schema.default(schema) : guard_exports.IsObject(schema.default) ? Clone2(schema.default) : schema.default;
}

// node_modules/typebox/build/value/create/from_array.mjs
function FromArray12(context, type) {
  if (IsUniqueItems(type) && !IsDefault(type))
    throw new CreateError(type, "Arrays with uniqueItems constraints must specify a default annotation");
  const length = IsMinItems(type) ? type.minItems : 0;
  return Array.from({ length }, () => FromType25(context, type.items));
}

// node_modules/typebox/build/value/create/from_bigint.mjs
function FromBigInt7(_context, type) {
  return IsExclusiveMinimum(type) ? BigInt(type.exclusiveMinimum) + BigInt(1) : IsMinimum(type) ? BigInt(type.minimum) : BigInt(0);
}

// node_modules/typebox/build/value/create/from_boolean.mjs
function FromBoolean7(_context, _type) {
  return false;
}

// node_modules/typebox/build/value/create/from_constructor.mjs
function FromConstructor2(context, type) {
  const instanceType = FromType25(context, type.instanceType);
  return class {
    constructor() {
      Object.assign(this, instanceType);
    }
  };
}

// node_modules/typebox/build/value/create/from_cyclic.mjs
function FromCyclic11(context, type) {
  return FromType25({ ...context, ...type.$defs }, Ref(type.$ref));
}

// node_modules/typebox/build/value/create/from_enum.mjs
function FromEnum4(context, type) {
  return FromType25(context, Evaluate(type));
}

// node_modules/typebox/build/value/create/from_function.mjs
function FromFunction2(context, type) {
  const returnType = FromType25(context, type.returnType);
  return () => returnType;
}

// node_modules/typebox/build/value/create/from_integer.mjs
function FromInteger2(_context, type) {
  return IsExclusiveMinimum(type) && guard_exports.IsNumber(type.exclusiveMinimum) ? type.exclusiveMinimum + 1 : IsMinimum(type) ? type.minimum : 0;
}

// node_modules/typebox/build/value/create/from_intersect.mjs
function FromIntersect11(context, type) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType25(context, evaluated);
}

// node_modules/typebox/build/value/create/from_literal.mjs
function FromLiteral7(_context, type) {
  return type.const;
}

// node_modules/typebox/build/value/create/from_never.mjs
function FromNever(_context, type) {
  throw new CreateError(type, "Cannot create TNever types");
}

// node_modules/typebox/build/value/create/from_null.mjs
function FromNull3(_context, _type) {
  return null;
}

// node_modules/typebox/build/value/create/from_number.mjs
function FromNumber6(_context, type) {
  return IsExclusiveMinimum(type) && guard_exports.IsNumber(type.exclusiveMinimum) ? type.exclusiveMinimum + 1 : IsMinimum(type) ? type.minimum : 0;
}

// node_modules/typebox/build/value/create/from_object.mjs
function FromObject16(context, type) {
  const required = guard_exports.IsUndefined(type.required) ? [] : type.required;
  return required.reduce((result, key) => {
    return { ...result, [key]: FromType25(context, type.properties[key]) };
  }, {});
}

// node_modules/typebox/build/value/create/from_record.mjs
function FromRecord8(_context, type) {
  if (IsMinProperties(type) && !IsDefault(type))
    throw new CreateError(type, "Record with the minProperties constraint must have a default annotation");
  return {};
}

// node_modules/typebox/build/value/create/from_ref.mjs
function FromRef10(context, type) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType25(context, context[type.$ref]) : (() => {
    throw new CreateError(type, "Unable to deref Ref");
  })();
}

// node_modules/typebox/build/value/create/from_string.mjs
function FromString8(_context, type) {
  const needsDefault = (IsPattern(type) || IsFormat(type)) && !IsDefault(type);
  if (needsDefault)
    throw Error("Strings with format or pattern constraints must specify default");
  const minLength = IsMinLength3(type) ? type.minLength : 0;
  return "".padEnd(minLength);
}

// node_modules/typebox/build/value/create/from_symbol.mjs
function FromSymbol2(_context, _type) {
  return Symbol();
}

// node_modules/typebox/build/value/create/from_template_literal.mjs
function FromTemplateLiteral5(context, type) {
  const decoded = TemplateLiteralDecode(type.pattern);
  if (IsString3(decoded))
    throw new CreateError(type, "Unable to create TemplateLiteral due to infinite type expansion");
  return FromType25(context, decoded);
}

// node_modules/typebox/build/value/create/from_tuple.mjs
function FromTuple10(context, type) {
  return Array.from({ length: type.minItems }, (_, i) => FromType25(context, type.items[i]));
}

// node_modules/typebox/build/value/create/from_undefined.mjs
function FromUndefined3(_context, _type) {
  return void 0;
}

// node_modules/typebox/build/value/create/from_union.mjs
function FromUnion14(context, type) {
  if (guard_exports.IsEqual(type.anyOf.length, 0)) {
    throw Error("Unable to create Union with no variants");
  }
  return FromType25(context, type.anyOf[0]);
}

// node_modules/typebox/build/value/create/from_void.mjs
function FromVoid2(_context, _type) {
  return void 0;
}

// node_modules/typebox/build/value/create/from_type.mjs
function FromType25(context, type) {
  return (
    // -----------------------------------------------------
    // Default
    // -----------------------------------------------------
    IsDefault(type) ? FromDefault2(context, type) : (
      // -----------------------------------------------------
      // Types
      // -----------------------------------------------------
      IsArray2(type) ? FromArray12(context, type) : IsBigInt2(type) ? FromBigInt7(context, type) : IsBoolean3(type) ? FromBoolean7(context, type) : IsConstructor2(type) ? FromConstructor2(context, type) : IsCyclic(type) ? FromCyclic11(context, type) : IsEnum(type) ? FromEnum4(context, type) : IsFunction2(type) ? FromFunction2(context, type) : IsInteger2(type) ? FromInteger2(context, type) : IsIntersect(type) ? FromIntersect11(context, type) : IsLiteral(type) ? FromLiteral7(context, type) : IsNever(type) ? FromNever(context, type) : IsNull2(type) ? FromNull3(context, type) : IsNumber3(type) ? FromNumber6(context, type) : IsObject2(type) ? FromObject16(context, type) : IsRecord(type) ? FromRecord8(context, type) : IsRef(type) ? FromRef10(context, type) : IsString3(type) ? FromString8(context, type) : IsSymbol2(type) ? FromSymbol2(context, type) : IsTemplateLiteral(type) ? FromTemplateLiteral5(context, type) : IsTuple(type) ? FromTuple10(context, type) : IsUndefined2(type) ? FromUndefined3(context, type) : IsUnion(type) ? FromUnion14(context, type) : IsVoid(type) ? FromVoid2(context, type) : void 0
    )
  );
}

// node_modules/typebox/build/value/create/create.mjs
function Create2(...args) {
  const [context, type] = arguments_exports.Match(args, {
    2: (context2, type2) => [context2, type2],
    1: (type2) => [{}, type2]
  });
  return FromType25(context, type);
}

// node_modules/typebox/build/value/equal/equal.mjs
function Equal(left, right) {
  return guard_exports.IsDeepEqual(left, right);
}

// node_modules/typebox/build/value/hash/hash.mjs
function Hash2(value) {
  return hash_exports.Hash(value);
}

// node_modules/typebox/build/value/parse/parse.mjs
var ParseError2 = class extends AssertError {
  constructor(value, errors) {
    super("Parse", value, errors);
  }
};
function Assert4(context, type, value) {
  if (!Check2(context, type, value))
    throw new ParseError2(value, Errors2(context, type, value));
  return value;
}
var Parser = Pipeline([
  (_context, _type, value) => Clone2(value),
  (context, type, value) => Default(context, type, value),
  (context, type, value) => Convert(context, type, value),
  (context, type, value) => Clean(context, type, value),
  (context, type, value) => Assert4(context, type, value)
]);
function Parse(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const checked = Check2(context, type, value);
  if (checked)
    return value;
  if (settings_exports.Get().correctiveParse)
    return Parser(context, type, value);
  throw new ParseError2(value, Errors2(context, type, value));
}

// node_modules/typebox/build/value/delta/diff.mjs
function CreateUpdate(path, value) {
  return { type: "update", path, value };
}
function CreateInsert(path, value) {
  return { type: "insert", path, value };
}
function CreateDelete(path) {
  return { type: "delete", path };
}
function AssertCanDiffObject(value) {
  if (guard_exports.IsObject(value) && guard_exports.IsEqual(guard_exports.Symbols(value).length, 0))
    return;
  throw new Error("Cannot create diffs for objects with symbols keys");
}
function* FromObject17(path, left, right) {
  if (!guard_exports.IsObject(right) || guard_exports.IsArray(right))
    return yield CreateUpdate(path, right);
  AssertCanDiffObject(left);
  AssertCanDiffObject(right);
  const leftKeys = guard_exports.Keys(left);
  const rightKeys = guard_exports.Keys(right);
  for (const key of rightKeys) {
    if (guard_exports.HasPropertyKey(left, key))
      continue;
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    yield CreateInsert(`${path}/${key}`, right[key]);
  }
  for (const key of leftKeys) {
    if (!guard_exports.HasPropertyKey(right, key))
      continue;
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    if (Equal(left, right))
      continue;
    yield* FromValue4(`${path}/${key}`, left[key], right[key]);
  }
  for (const key of leftKeys) {
    if (guard_exports.HasPropertyKey(right, key))
      continue;
    if (guard_exports.IsUnsafePropertyKey(key))
      continue;
    yield CreateDelete(`${path}/${key}`);
  }
}
function* FromArray13(path, left, right) {
  if (!guard_exports.IsArray(right))
    return yield CreateUpdate(path, right);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    yield* FromValue4(`${path}/${i}`, left[i], right[i]);
  }
  for (let i = 0; i < right.length; i++) {
    if (i < left.length)
      continue;
    yield CreateInsert(`${path}/${i}`, right[i]);
  }
  for (let i = left.length - 1; i >= 0; i--) {
    if (i < right.length)
      continue;
    yield CreateDelete(`${path}/${i}`);
  }
}
function* FromTypedArray2(path, left, right) {
  const typeLeft = globalThis.Object.getPrototypeOf(left).constructor.name;
  const typeRight = globalThis.Object.getPrototypeOf(right).constructor.name;
  const predicate = globals_exports.IsTypeArray(right) && guard_exports.IsEqual(left.length, right.length) && guard_exports.IsEqual(typeLeft, typeRight);
  if (predicate) {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      yield* FromValue4(`${path}/${index}`, left[index], right[index]);
    }
  } else {
    return yield CreateUpdate(path, right);
  }
}
function* FromUnknown(path, left, right) {
  if (left === right)
    return;
  yield CreateUpdate(path, right);
}
function* FromValue4(path, left, right) {
  return globals_exports.IsTypeArray(left) ? yield* FromTypedArray2(path, left, right) : guard_exports.IsArray(left) ? yield* FromArray13(path, left, right) : guard_exports.IsObject(left) ? yield* FromObject17(path, left, right) : yield* FromUnknown(path, left, right);
}
function Diff(current, next) {
  return [...FromValue4("", current, next)];
}

// node_modules/typebox/build/value/delta/edit.mjs
var Insert2 = _Object_({
  type: Literal("insert"),
  path: String2(),
  value: Unknown()
});
var Update2 = Object({
  type: Literal("update"),
  path: String2(),
  value: Unknown()
});
var Delete2 = _Object_({
  type: Literal("delete"),
  path: String2()
});
var Edit = Union([Insert2, Update2, Delete2]);

// node_modules/typebox/build/value/delta/patch.mjs
function IsRoot(edits) {
  return edits.length > 0 && edits[0].path === "" && edits[0].type === "update";
}
function IsEmpty(edits) {
  return edits.length === 0;
}
function Patch(current, edits) {
  if (IsRoot(edits))
    return Clone2(edits[0].value);
  if (IsEmpty(edits))
    return Clone2(current);
  const clone = Clone2(current);
  for (const edit of edits) {
    switch (edit.type) {
      case "insert": {
        pointer_exports.Set(clone, edit.path, edit.value);
        break;
      }
      case "update": {
        pointer_exports.Set(clone, edit.path, edit.value);
        break;
      }
      case "delete": {
        pointer_exports.Delete(clone, edit.path);
        break;
      }
    }
  }
  return clone;
}

// node_modules/typebox/build/value/repair/error.mjs
var RepairError = class extends Error {
  constructor(context, type, value, message) {
    super(message);
    this.context = context;
    this.type = type;
    this.value = value;
  }
};

// node_modules/typebox/build/value/repair/from_array.mjs
function MakeUnique(values) {
  const [hashes, result] = [/* @__PURE__ */ new Set(), []];
  for (const value of values) {
    const hash = Hash2(value);
    if (hashes.has(hash))
      continue;
    hashes.add(hash);
    result.push(value);
  }
  return result;
}
function FromArray14(context, type, value) {
  if (Check2(context, type, value))
    return value;
  const created = guard_exports.IsArray(value) ? value : Create2(context, type);
  const minimum = IsMinItems(type) && created.length < type.minItems ? [...created, ...Array.from({ length: type.minItems - created.length }, () => Create2(context, type))] : created;
  const maximum = IsMaxItems(type) && minimum.length > type.maxItems ? minimum.slice(0, type.maxItems) : minimum;
  const repaired = maximum.map((value2) => FromType26(context, type.items, value2));
  if (!IsUniqueItems(type) || IsUniqueItems(type) && !guard_exports.IsEqual(type.uniqueItems, true))
    return repaired;
  const unique = MakeUnique(repaired);
  if (!Check2(context, type, unique))
    throw new RepairError(context, type, value, "Failed to repair Array due to uniqueItems constraint");
  return unique;
}

// node_modules/typebox/build/value/repair/from_enum.mjs
function FromEnum5(context, type, value) {
  return FromType26(context, Evaluate(type), value);
}

// node_modules/typebox/build/value/repair/from_intersect.mjs
function FromIntersect12(context, type, value) {
  const instantiated = Instantiate(context, type);
  const evaluated = Evaluate(instantiated);
  return FromType26(context, evaluated, value);
}

// node_modules/typebox/build/value/repair/from_object.mjs
function FromObject18(context, type, value) {
  if (Check2(context, type, value))
    return value;
  if (!guard_exports.IsObjectNotArray(value))
    return Create2(context, type);
  const required = new Set(guard_exports.IsUndefined(type.required) ? [] : type.required);
  const result = {};
  for (const [key, schema] of guard_exports.Entries(type.properties)) {
    if (!required.has(key) && guard_exports.IsUndefined(value[key]))
      continue;
    result[key] = key in value ? FromType26(context, schema, value[key]) : Create2(context, schema);
  }
  const evaluatedKeys = guard_exports.Keys(type.properties);
  if (IsAdditionalProperties(type) && guard_exports.IsObject(type.additionalProperties)) {
    for (const key of guard_exports.Keys(value)) {
      if (evaluatedKeys.includes(key))
        continue;
      result[key] = FromType26(context, type.additionalProperties, value[key]);
    }
  }
  return result;
}

// node_modules/typebox/build/value/repair/from_record.mjs
function FromRecord9(context, type, value) {
  if (Check2(context, type, value))
    return value;
  if (guard_exports.IsNull(value) || !guard_exports.IsObject(value) || guard_exports.IsArray(value))
    return Create2(context, type);
  const recordKey = new RegExp(RecordPattern(type));
  const recordValue = RecordValue(type);
  const evaluatedKeys = /* @__PURE__ */ new Set();
  const result = {};
  for (const [key, value_] of guard_exports.Entries(value)) {
    if (!recordKey.test(key))
      continue;
    result[key] = FromType26(context, recordValue, value_);
    evaluatedKeys.add(key);
  }
  if (IsAdditionalProperties(type)) {
    for (const key of guard_exports.Keys(value)) {
      if (evaluatedKeys.has(key))
        continue;
      result[key] = FromType26(context, type.additionalProperties, value[key]);
    }
  }
  return result;
}

// node_modules/typebox/build/value/repair/from_ref.mjs
function FromRef11(context, type, value) {
  return guard_exports.HasPropertyKey(context, type.$ref) ? FromType26(context, context[type.$ref], value) : (() => {
    throw new RepairError(context, type, value, "Unable to de-reference target type");
  })();
}

// node_modules/typebox/build/value/repair/from_template_literal.mjs
function FromTemplateLiteral6(context, type, value) {
  const decoded = TemplateLiteralDecode(type.pattern);
  return FromType26(context, decoded, value);
}

// node_modules/typebox/build/value/repair/from_tuple.mjs
function FromTuple11(context, schema, value) {
  if (Check2(context, schema, value))
    return value;
  if (!guard_exports.IsArray(value))
    return Create2(context, schema);
  return schema.items.map((schema2, index) => FromType26(context, schema2, value[index]));
}

// node_modules/typebox/build/value/shared/union_score_select.mjs
function Deref(context, type, value) {
  return IsRef(type) ? guard_exports.HasPropertyKey(context, type.$ref) ? Deref(context, context[type.$ref], value) : (() => {
    throw new Error("Unable to Deref target");
  })() : type;
}
function ScoreVariant(context, type, value) {
  if (!(IsObject2(type) && guard_exports.IsObject(value)))
    return 0;
  const keys = guard_exports.Keys(value);
  const entries = guard_exports.Entries(type.properties);
  return entries.reduce((result, [key, schema]) => {
    const literal = IsLiteral(schema) && guard_exports.IsEqual(schema.const, value[key]) ? 100 : 0;
    const checks = Check2(context, schema, value[key]) ? 10 : 0;
    const exists = keys.includes(key) ? 1 : 0;
    return result + (literal + checks + exists);
  }, 0);
}
function UnionScoreSelect(context, type, value) {
  const schemas = type.anyOf.map((schema) => Deref(context, schema, value));
  let [select, best] = [schemas[0], 0];
  for (const schema of schemas) {
    const score = ScoreVariant(context, schema, value);
    if (score > best) {
      select = schema;
      best = score;
    }
  }
  return select;
}

// node_modules/typebox/build/value/repair/from_union.mjs
function RepairUnion(context, type, value) {
  const union = Union(Flatten(type.anyOf));
  const schema = UnionScoreSelect(context, union, value);
  return FromType26(context, schema, value);
}
function FromUnion15(context, type, value) {
  if (Check2(context, type, value))
    return Clone2(value);
  if (IsDefault(type))
    return Create2(context, type);
  return RepairUnion(context, type, value);
}

// node_modules/typebox/build/value/repair/from_unknown.mjs
function FromUnknown2(context, type, value) {
  if (Check2(context, type, value))
    return value;
  const converted = Convert(context, type, value);
  if (Check2(context, type, converted))
    return converted;
  return Create2(context, type);
}

// node_modules/typebox/build/value/repair/from_type.mjs
function AssertRepairableValue(context, type, value) {
  const unsupported = globals_exports.IsDate(value) || globals_exports.IsMap(value) || globals_exports.IsSet(value) || globals_exports.IsTypeArray(value) || guard_exports.IsConstructor(value) || guard_exports.IsFunction(value);
  if (unsupported) {
    throw new RepairError(context, type, value, "Value is not repairable");
  }
}
function AssertRepairableType(context, type, value) {
  const unsupported = IsConstructor2(type) || IsFunction2(type) || IsNever(type);
  if (unsupported) {
    throw new RepairError(context, type, value, "Type is not repairable");
  }
}
function CreateWhenUndefined(context, type, value) {
  return guard_exports.IsUndefined(value) && !IsUndefined2(type) ? Create2(context, type) : value;
}
function FinalizeRepair(context, type, repaired) {
  return IsRefine(type) ? Check2(context, type, repaired) ? repaired : Create2(context, type) : repaired;
}
function FromType26(context, type, value) {
  AssertRepairableValue(context, type, value);
  AssertRepairableType(context, type, value);
  const candidate = CreateWhenUndefined(context, type, value);
  const repaired = IsArray2(type) ? FromArray14(context, type, candidate) : IsEnum(type) ? FromEnum5(context, type, candidate) : IsIntersect(type) ? FromIntersect12(context, type, candidate) : IsObject2(type) ? FromObject18(context, type, candidate) : IsRecord(type) ? FromRecord9(context, type, candidate) : IsRef(type) ? FromRef11(context, type, candidate) : IsTemplateLiteral(type) ? FromTemplateLiteral6(context, type, candidate) : IsTuple(type) ? FromTuple11(context, type, candidate) : IsUnion(type) ? FromUnion15(context, type, candidate) : FromUnknown2(context, type, candidate);
  return FinalizeRepair(context, type, repaired);
}

// node_modules/typebox/build/value/repair/repair.mjs
function Repair(...args) {
  const [context, type, value] = arguments_exports.Match(args, {
    3: (context2, type2, value2) => [context2, type2, value2],
    2: (type2, value2) => [{}, type2, value2]
  });
  const repaired = FromType26(context, type, value);
  Assert(context, type, repaired);
  return repaired;
}

// node_modules/typebox/build/value/value.mjs
var value_exports = {};
__export(value_exports, {
  Assert: () => Assert,
  Check: () => Check2,
  Clean: () => Clean,
  Clone: () => Clone2,
  Convert: () => Convert,
  Create: () => Create2,
  Decode: () => Decode10,
  Default: () => Default,
  Diff: () => Diff,
  Encode: () => Encode9,
  Equal: () => Equal,
  Errors: () => Errors2,
  HasCodec: () => HasCodec,
  Hash: () => Hash2,
  Parse: () => Parse,
  Patch: () => Patch,
  Pointer: () => pointer_exports,
  Repair: () => Repair
});

// packages/capabilities/use_computer/native/src/tool.ts
var ComputerSchema = typebox_exports.Object(
  {
    code: typebox_exports.String({
      minLength: 1,
      maxLength: 32e3,
      description: "JavaScript using computer and print. Start with await computer.getState(); full API docs are returned on first execution."
    }),
    title: typebox_exports.Optional(
      typebox_exports.String({
        minLength: 1,
        maxLength: 80,
        description: "Short description of this desktop operation."
      })
    ),
    timeout_seconds: typebox_exports.Optional(
      typebox_exports.Integer({
        minimum: 1,
        maximum: 120,
        description: "Whole-call deadline including startup and system permissions; default 60 seconds."
      })
    )
  },
  { additionalProperties: false }
);
function computerTool(session, output) {
  return {
    name: "use_computer",
    label: "Computer Use",
    description: "Operate native macOS apps through the independent Agent Enhance runtime using JavaScript. Use computer.getState(), computer.getApp(bundleId), app.listWindows(), app.getWindow(windowId), then window.observe(). Full API documentation is emitted on first use; computer.help() returns it again. Prefer var for reusable bindings. print(value) emits output; window.screenshot() emits PNG and returns coordinate metadata. Only native UI is supported, including browsers through their macOS UI.\nDefault background delivery uses AX semantics; foreground input must explicitly set {mode:'foreground'}. Background keyboard needs an observed element; use setValue for writable controls. Raw key holds, pointer input, dragging and modifier-mouse combinations require foreground. withKeys(keys, asyncCallback, {mode:'foreground'}) scopes modifier keys. Observe fresh UI, use exact returned IDs, and never replay failed actions automatically.\nBindings persist until the task settles/reset, while held keys/buttons are released at every call boundary. Timeout/cancellation stops the script and clears queued actions without undoing completed effects. Native input can be accepted/dispatched without confirmed application effect: observe to verify. Returns bounded text and up to four PNG screenshots (24 MiB total), saved locally.",
    promptSnippet: "Operate native Mac applications with JavaScript, background AX actions and explicit foreground keyboard/mouse combinations",
    promptGuidelines: [
      "Prefer APIs/CLI when available; use use_computer for desktop UI tasks. Observe before acting and verify dispatched effects."
    ],
    parameters: ComputerSchema,
    async execute(_callId, args, signal, update, ctx) {
      if (!value_exports.Check(ComputerSchema, args)) throw new Error("Invalid use_computer arguments.");
      signal?.throwIfAborted();
      update?.({
        content: [{ type: "text", text: args.title ?? "Using the desktop\u2026" }],
        details: { status: "in_progress" }
      });
      const result = await session.run({
        code: args.code,
        timeoutMs: (args.timeout_seconds ?? 60) * 1e3,
        sessionId: ctx.sessionId,
        signal
      });
      const formatted = await output.format(ctx.sessionId, result);
      if (result.error)
        throw new Error(
          formatted.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
        );
      return formatted;
    }
  };
}

// packages/capabilities/use_computer/native/src/index.ts
function createComputer(services, session = new ComputerSession(services.runtimeRoot ?? join4(enhanceHome(), "runtimes"))) {
  return {
    tool: computerTool(session, new ComputerOutput(services.artifactRoot)),
    notice: () => session.recoveryNotice(),
    status: () => session.status(),
    async lifecycle(event, isIdle) {
      if (event === "task_settled") await session.endTurn(isIdle);
      else await session.reset(event);
    },
    async manage(action) {
      if (action === "reset") await session.reset(action);
      else if (action !== "status") throw new Error("Choose status / reset.");
      return JSON.stringify(session.status(), null, 2);
    },
    async dispose() {
      await session.reset("unload");
    }
  };
}
var index_default = { manifest, create: createComputer };
export {
  createComputer,
  index_default as default
};
