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
        try {
          for (const key of keys) { await this.keyDown(key,selected); acquired.push(key); }
          return await callback();
        } finally {
          // Attempt all releases even if one fails; the host also ends the native call.
          const errors=[];
          for (const key of acquired.reverse()) { try { await this.keyUp(key,selected); } catch(error) { errors.push(error); } }
          if(errors.length) throw new AggregateError(errors,'Input scope release failed; host cleanup follows.');
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
  return Buffer.from("H4sIAAAAAAACE+y9a5OyzLYg+Fc69ldPtIiKeiL6AwgoFKKo3JwPEwoKKIpVXlA7+r/PWpkJYlU9l3efjo6JmWLHfh9LIclcue63/J//OmWXj2A9XJ7if/3nv0IuWPJdYdPsCY3WstMW2ptmsG5yXUHgO90et1w3epvNstUVWny4bnNcq91aLledZmfdDRvL1r/+41+bJF2f/vWf/9f//NdxecYxxWh9OP835RAvD8H6v/Wz/fFyXn/89+XxWO9nhzP8eKr/3/0sXM+S6LA8Xz7WdfxruqYzO8GYe/j7X//Z4rn/+Fe4PC9h0Inca63cPAr3zj3g0+tqyyWjWSvXEild7c3rYpBeFg8ucZzpwJhHyeTRepv0VWXOmbbrSKo2lE5Lz+Q0VXKs3U237mJizLpXy5Py1cC+GtzUnvYla66kc6cv3oytCN85Yy0Rk+VwygVydjWaYTO8t+MAxlrM2tsVz12n6lQJ7j0r2Pfyhadza/t2DJrWGedm7Kfcoq/V+tsbvCN9hH2Jh3seS7d3mcw0fEcyibIuzH0byq23/vz2sfB2tcU+PS28Udfgz+l6Tr7fLV2TMx5f7rlP+j3ydz/a0XH6XfJ5yTvtyUFvrAbO48s9+C6L3ZO2ZwvPvIaevoXxrpV79clweg9d+wpz1Iv3eqmeBnyvEezNNLh3L29pflkNpfuKz16fHUyPftMin4tnV02Jw7X7bv5cm/XpPcW8DmG6dMMslPMr+Zv9FuydeCW3biNZzOF994Wrnuj88uuf1mYkx8DY33LYq3eDv1395iINDuZxxbcuwYDs2+6Pa+Abx89zCod6YzHrvtwX8s5xwcdcdTz4jc53q+D8u0ZTTwEW9F39HtnjX8O61/c9M/X67VMw1K/LpFuFYXVfYd74fbu5cNPDcmh9gjV952guwhzyK4MnGcPgn+tlY6xLekvaDIdfxquuvfr8C/6Ntk94VWFK39EiOLRQzcV8Fu02/e7xT3vwJ9j+GS9amZFk17d5LzB207nXMLkV7IVe3VdGcy84ue+dl571X8Xd+9/hbiubHvR45TpNmNtH0LzNlwMVnpkOgr16Xngh7N35sVGlU+iG+upgdu3BrbG4N4742VUl2eade7hPAffN7mzgnIIB7GXzZvquObGbt9HS1e++p7eNeyyF3vS6clWEQ9duStcQ6AFhvFFu1wWfXmbeNF15o+Pb7I94d4H3cQvX+t9A43/GT9jHX+Fjec/Mbe9Xjfz/MI1rf8OfrCUPe7dfXP/P4d6fYWrvnceq6dx93nkYjz/M63/3++6t93/A467BcAr8uw3j/5d5cv7PefKr/FsNets/8cvv1rBy089z4oKDkxJ5/9f8HOf/D2HN6XHAO0+Z+F/ba6BX5W9wfuUlvfDtbv2/io8s3EYCvHUH/w+MA+xnc3Ek+4if+cURdMTdf00u/RU/KPVDoIG/xZ/f48X21zhd+fyECchqxifh/v/xP/71v/7jHyn22mGT/fdjmpzO//9S47cludCt3JkD6+BcFoNbOnNBdB6mR1DZ06BQhba3B7Co42of1Hy+dzb26mHhtjnDdS4g5i8+b1/w+2DocAtPgy00uWCPsAF40G2XpztQr/bT08IG9ufaxfZ3g+b0vnTbh8mOjqkp5ZiR9ddjOq2FazbCgZoAXL8Z27yuPAl+d+42rDMcpOcFoHT5+zdwsAfqdsnDnJxpO/h2TNWylfz383JKlf3r81vxMrq3kMxK2MKeEVKcq6YJ9xxXnnO2m7CHA+fslDj4dU9Gc+tC2MaX9dzmjp2qoNaeEbYFqVfYEruvPbfJWOYxGKgni7/FQXP0zZrbc4q76db3pnRd1fUXJPpfJMvRMhjP6sVv08vhnOzXTwrtNUsKvV8F4RqJcGkS/GeIn8RcFC34RzI08oscKfRLctn4H+UyJn+MxZ/r5/q5fq6f6+f6uX6un+vn+rl+rp/r5/q5fq6f6+f6uX6un+vn+rl+rp/r5/q5fq6f6+f6uX6un+vn+rl+rp/r5/q5fq6f6+f6uX6un+vn+rl+rp/r5/q5fq6f6+f6uX6un+vn+rl+rp/r5/q5fq6f6+f6uX6un+vn+rl+rp/r5/q5fq6f6+f6uX6un+vn+rl+rv+T16gudDYt7KUq0bapGv7ngf9RpAD+tOk3cA2w0aqCbValjdeQpCnnLKeOPvnl2NY/mwoZ34wGdPyp6qrfDaCQ/wblrCrXUOyzTyr+RyKNYe3yZ6/R4xZezL08o/Y2juL4zsuXsqXmbP6TTBcj+i2H8Pi6KOXrVGD+TZMLXf1R/Rbeb0+d2H6FfxbD+NjPVmxFxU/ym2ZpX17Vhy/YVAbV+ft87xI0rdf3fwO/Uz/oU/jJmlS0yDXEAwyq/M3+wPy3RXfg38OvLxo5m7/BTYtvo363/xV+3+wjzp83r6uDyS0avUfIp/twaH0PP0WSCvhp4qh4XrQQftFfLArmHzTD4+JgNbwmdn927gt38S38fMVi8OvPpBJpJaV4/1/Aj65FdjbB3tmvhiYXpN/BTxRnxf7L0XNsZdf/O6Ii+NdcugvOdHr7peucFoPG7lv4yfFbMX/3uRetWfRvwI/XG0v3xgF+fAu/nZIz+Em78ktdGsF7+v8Ufr5nPla8ya2db+mXm4sMfsPnInrk/drfwY/vJcu9uVm5DrcckC7m3+Pf4GYW8HtEp+L509z65j3Rn+BnxsFw2gDc+BZ+E3XH4AecuvhJvi3+HfjhIRbhoPsL+pVObsTg18/Lb1dq9vfwe+Ift/akNMh/wf/0eFnAb/bkH777j/Fvijixwc7nwSH9Fn4tMn8Cv+ccxtLyH8NP7cVBo3dfeNav5AdXwk+u4N+/Bz/s0H9fW7+AX/+2KuBXWcTJzf8efitef/eBt68G6iPAA0vc7/HPVE8F/DbPpU5X37yn/wv4Xf39cevxjTQcxAQvfoF/c7eQH/2slE124/TNuL+QH03nAnt1Wai9Ix5i80v5q0mbAn61kqj6ovcP4Ldw482CHIhk/1b+rgel/Mj6xU/DeAfvkT+NasAY2S/0I4mMz00lR1E3Ftcb2w2rov8on6ACkj76siv0fXlJChaDz2HVtL6sb6qotuX05DnXnhf7FBT8dYBzrepfo0+z9vF1nV/J90/4oVjOVPI4czJPTZvJ106xP/tyIVK0xv3J/x38xpMKpt/Cr6aNCvg9YT9J5G/251vttsTvJh7SMr2SEzm+h18UF/CrYLSmWd/A7/fyaek24gXvEBz/Fn5KX/nKHySRvP9v8JuIalnDe4vxP5G6Veo/FSjtnhj4fAvZr9Erelb3h28/wmJ9ZH8+qaV6id8t2Xp5v/yX/Jvtj5muhnq6OIye+P1JVBwK/evtqX+Nde6b/bHFr9rfc3+onMXDdRaPb+E37q8L+D1XK0eH6Ct+oyhW/oTfTVyX+S38unqr4D/PPZmQ9/8z/OancThQXvmD9YoTh7yEXzn2Tu/+A/yuvOMTf3jV//vbAn6RuCvxO4P3/5VSjvbTwXx8ef838MvfCv21T23Lz0ZpZYBf2U8rvnFe8a2v/NV6ffxU6A9fRhp9aw9/uhalPgXjz5V0POMcZeZYFVIs7EvpSaFGySIiMdKq43+eBYcwUAqsjPr5GMYYAX5SaunnAjxvPyWRT/4zBvoxRriAPI9GYjDGO06FpV7wG5QnC6J25kR8wd9972/Mnp0BuDYIfqnLEVWs/wSi0XQeQdI7LV3tuhimp8Xz1lVpZEtvvCAebtyj1bzmRjSsyfb+bN+fTKyAP+6ptmR/M5wfjqV+9h0tZTgRMr4hj79ZG5nfmIq6CuuWRgRSlngNPfNugCzzyfz1+ZocSMZdrKS9W7vwfVRlupL/dBrgrKWP4YF7gw9nsd8rnr3OB2kS7NX7etZ7OcjR4NQ8UM7HsN/eP78/XctTig6jq3XvScFQMpaeVc4/+Dr/PuMs1+KkI4ODuYLuFBx215dDJel4sDYT+AC8IzXT4LA4ksPh9ou774IOyffuy3vPLU68wmfIXAcwJq+SA12fB02O6KaoUYmPBd6/0zOFRKNhtkE3SFez3vMASq7yriask1fv/r53+f0cwI7b69dVVMI/e4U//rEDQPXdv4O/iYfEDVZNPK2KrusP7/9yf4mUg8/rH/U/rICg7d+tH2SZHcJvUgZ78/iLeQxhLflykG6D/BW/l1/wQ36T/h4/ZDwYtbK/l0Xld6NRnMbVBvgpdN7OE4fEF6WETuLr/gBzmv3N/iyuodvesVOyfjOP0XW67+FpYRSno1/RZ4Xv/hV+pGffDdOZ3f0tDGZUV9Tn+a/ok/H5v4P/3Eddw23LgAtc6OnpjE+53+JDw9wCPqSrXennKPjFU32Uv9Jnm8Gjyq9Bt06I3nNvS8Z+2sa/X42OPpV/lfVJ1mLV/8o/qU3fJ3yUflZU92WfvvBUCj/rK/yK6w/jI13YF5Q5sJanfYdLVsRP67/W97nyZf3MZ0TgwPwfhB4sz9kt3W5lbIJf2mf8WlC/GOJXI2hSeBrM50DmfaCfKb1/wu/qvHH9miR+wV+qP/zl+BR/K/voU2/3F/gOCvz8M3wdc2ZP9SpufA9fe8BH+V/Dd+4ifJXP8P28/v6bepL+Zv3TgXpHP8UnHP4VfrX+bv1TsHElwF0z+/P6ixf9cf36nCM6wCstfL//fWuo/dX6AZ6c7+afaeFX+//2d+vvzeeD3uEzX/jF+qVzPvqb9U/A9kn95vQY7h25HPtX+E+13z+u3/Yc4K1TgdDBrITt6DlChX+J+lnM/2L9qnOBsYEGGjb62F5O+TyM/oZ+xyD//mr+eJj3N/x3VNof3/HHP84fZDvf3oJMAbu5vV3PvvBfgh9f9OMk4qS/GX/Qe/xx/6Tgr9YP+u950f9ePsx+I1//gn899ab7l/EDHFJ7OlW+jldx/4kaxXSZxstOK17dgVzeBKgbvoRPgSSoXKD20SddGmS47/O9HeApyG8RdaoL6AiXcAh6zcDhF+7tivEzozG9rvjbdjlQj2gbuAM8PddRFu4iDt0bZxziLewBwNTMfBd431e6O5tJC9bTiOF9j3Xh/omelqgA9r2PEOjvSg5G7Et6haUG9dY/wCZWPR7/37pUR0vWjuRwqms58K9qalEt9+fa4WOmpY1cSWCjo1u9Fk/6IJNn/kGZaWexBt9PQ0lLgGIEcXcQLUmLuuJkpk2irhIdb8peb9t3XRhHG3xOkKw3MO71JFjoSRiOknUP/r+A5z2r3hC1uZY+FOWur2/RxIFxFHuUzbVT48Pp9kX4vleLwiXoMTAneUz+jm8rkf5tkb+TdGXRv2fysC4YR1e0+jXCA42MnPU60w5DYRKZMA8taTY1WAesb6/f1knLYc9qsC5eScxFGK8s5yZ5trq2nF6Y80vLsRNYk+pZzqKAkwXwqMG48kw7qaEawFwTQySwibUbx5RT+LvHJXrjso36FoHhcKY1HA7nDd/fLttdH/DRAtgC3Ov1m2dj/GcO8+MUV22LNSdXeLUX1ezc2kqh5BcwArgdmsIgGMOa1NHGv+XjE/3OtHCdo2Ruaok98nF+ddVn84s6ML+GbCfyTZLoOnfqxgsm2c7K+6IuObCmFPbyNAJYTEM5m9Th4hJ5s47EUIYxb87RQ3zQJv0+jClPFyuE69Zr5rA2mPegRVjXOGrKsOZ4JHGanRjTDcC+4bWE21nbzm1+S8bgnEOO+5yYG3hXB7iqKA/FUagDTlm5F4wmQ04UKfwTuSPDe2zPF0b1Wr3e06JmMxeHFuwD19v7LTKOuc4mYiRnjbWP8DfU9SLE+UVdDfa90QP8NcMwli5ElMOcgmF2EWHt2lwMpQbiJcyxDXN0O1uLzlEXizlus+AOc4RxpdWUjYvzNPfyrQdsg8LPckLJ2amOzSVSZ0T9L8na1JNNW0tyb+qQcU+Idyri3HQRa9ed6tsgX5agK8+MI7PxgF9dorB+rddnmtk7ieIkltHXD/NecBFuDa5pr9zNzSoeJZtO5t5aZH5eCO/c9LQk7GQriXyn3wDnmpfkQHCR4C7QhZIx+gzh3nr2jngwjhJC8/PDUG7ZJHwy03h1PSG4ULOceL70jinO41LyR3lP8E//6NG94YEGasodFSdY49Xb1vH7rcMDTh7WgpmHwDtGSdMFvDls4FleGHP4HewJ8InNCia2Q7jrOdJKbWswGhrg/UI/G+E+Zznes2vfopp6IEpaz8vF7jF2ZXhfd/LmO1YBpwvM48DmgXCpxRziW10wRxt4L/KoUfJoSJ6I75kM+zhvm9wP+BJQfAnbMLcjwRs5OhG6OthsbQuH7clhcyVzkbORhfMb6DfA4Wa96wgN5BWu0rFqyjWnsNnA/m8XjRZ7di1oAYHDdtXQ8DtrFRV8bA1wEuD/N8EQ3wg/a9N7YH8cm+6P3uy0iDyDdYEElyRYF+4tsIGGh/winviTeKCARJTv8q2v+oTItYni2xl+6gJSxy6uqQ6/D9RR8btGYQm/T+N58XtfdcvnHbHEyfEWKBl5K8B9nAj4Gcc92HLxnDMux+Xy8r0zAstR0rEJLIUVtUOBZ0ySnNLjGumVwG2b3W6wh+NTk74nPtF3co2On5F7VMcfEf60ovAV3jSArfyh7Ojz01sukbFW22wS08/SIljgM5f8GZaeiQdZML0tnQvvLgj/OgxGoXa7rwERCtw04rmjqKOp07Mt2HNxl7TsHWjWRDu+AU8GPmREZRycUxI5R75jaxbwg+VgtOhromQmm3mmRGQNhrQ8z8he55I25jxfbrlERZz7B26mDRUyTfX8lFkcrMG2vl+DYrA1cPLrGpJFX/y316BbMczPyfzbTotEhdd740SmfAZxIRIGeYEL0Q0/C84Hbkd2ztHv3t0wk+or/9QZ/3TdHNZ7gfnBXh86wsAfiFEf1l5TeHxY2ZubLdCR54oXalHgvsxwTXP/fBkre3kzBYxvzQTU+oCGroLIaQSuYY/wTiMFhX6yAgOypqSEb+2N+TzW8rWoAr/uiiDHPFFB/cEWp7hetwWyuitOt3V1KjlkLJBPSP9wfyimdl+c1OfI5+8g8zcB8mRYsxhQ/PXlrI3rh986tcSTCH6fGq0hkWUGypuxFRDZBPPmcN4z4yxW4G5sAjlbkfHuhrl07ELHsTZ1F+bZ45VhvXHZueRZkJNWa0fl5AL1MjkLa5QHnR2Z8sVgk10iHA/0o912aEksx2YUgp1DYgCjrRdFqFdcUoXME2CrbxJJuu38TNx0nZlqMd0tzpeEHg8ykQ1voP0jLc69fSJSWjbzjNxbr22vA4D5COAzkE4SfT/M02qtCC+cN4fFM02RyKgVxamTY6g2kRNNDt65A3mx3hI/Uikr9NGA6ESbTZbnbG7Ai/N0hM91Sk+iifL85M1Wvcm8kL+7fc1WnNncTuc2l2pby5FUwGvhAbJiXc/muf9ljK3Hi4Jm4Tv1a2oCDd1UrzGVYO7q7obr3dcr9KRfrQqNWgdV0JAccM0Nzc+rNLpdSxbqh7s76M1Cn8JId2Okj4L24Lvxdi+hHsn4w+4rfzBMd9pluOILA04FWkIZWxNzAje1m3ctKVAG5B7Aib5lEbyZ+hLRVRzMkRn0mqCrlD5xAfT+Feod6x7wLy/bXTdUd1yA7qjEuJ4gpjy88WFFsIeJDxoc2cN3h8BRziOkYT5CXTIqdEnUAdZxR2L6pM7djXBJ5m7Vb87ZRjvjjuM7XMz0yqb1pDFD2kmUnuS6ah9nBBceztbBe1dNIhfwgntaZUxNkUxt4+hxALJyTQKqesLZyKNVTrFvdcC11TLeL/b+Rb7VlCLONvaaVjhItUsZb5UBnt4gtBvmuMlZcmtMYjqz1rlbT+Q6x6F+c6jf8pq4y+lam7A/YbDNgBr6hJfaA7LPqD9cGgrRH3o7Xu/s7gbMAXRy/m4DbMI3+cPaAS0hHVy2HyLiaSfULtwzPxl5Qj6OBxKhpXMP+JIx8c5T1BPqvZDgA/AOj9Brf6cAjzgKk2adjFmLAnwO7ZMTwBNsiRHoyziOc4e/56vtUd906vW8a8j5WeqdfAnHmVk9pb5OrmQ+1hX5zH73an/O0eYIAHcf3F5vwFpBR9eSzRl4M8wp6GTLDTzH8WgTqXE0InAiOq7ngs2a4jr0BfJX1GMD0LXDVbaPRoQvTkLTovQf0jWGPfxX33oNlEmNzMio8yI4ZCsLn9kbng28oHkiOizJSVEQ3rAHtTglNAKwQ/4L84R3NbPI5krZsSD33+kauFML8FGx4N7JSAV9dy71YU6rkYK4m9lU5g6JPOorMrWl+EhQLbmUTetrJpJ53fUujOOAvjgidAb2BAf2rDwcg2wfhNIC14g6qjoCuXDF/MS3SJJbVkR1+IaaKUR/n63423f6ex329syPt4PehNocF7Q5zEwiuu/NO9l5xfZbpFZVtyKwLO2/pIk8OB7B8yOFPt8EvjgA/ofP+A59xmhLrhoeV/vpNeQS4ZnfEhNZ6dXnjIeg7LaWdB1pyL3aFBHRm3XOZjZFq7Qp3lp21aYQNl3paVMkI1GsyIkx6PMgEy2SpEBtipZF5CPYU8iXcC/5BrGDOk+cuUUKwbPlI9YjoHF6P66bwI3IiatFZSXq+knT0wTzZoAeyueRMonfLHqf1/Rn/tkcK1upJQJ9PHKJ6BcWwKJpSQN4fhjoYPNTvjENCIzgM/B8jspbkehcfI/MsZZEIpEXgFsqyHGkAZ5voR6Woc5x2foKkaEE/y6CNKlTO8hh8OpkHwgvKr+vggQ4CDoXn9eUmcVslyXY2tKo4K+ZmCtM9m87IuEVhzrqQiO7xXQh4DnwL6wrzQFmoOMc3xmPb9a2NtkPnN84mhN+Qfi6PYsYX1/no37x3ntsSfS55L14V/3mxXNqt6tajHPZ1yo5m3o/WGWieSJznwRqSOWbf+O2Q11QA5H+bWoXtSq3d33QiWdTziFupQ7quyCnLv0qX52I4x3Rg2EftVIWN8dRT6S2QQDzA9hPlOCTrm66F4nQxNSzid5S7l8UqaA/Cfcb5Qkje0ZwGeSecKd41akTfGa0UM/ecrGETxZrDD7bWR32mcB8fFkibD6m5L5OBTZaP5hkb72MwmZ9C15goxklbvxz2KR9RUE9ZTuwEmK3nMAgEJn+YQnqtc7Whf6qkOT7ExwBGaSs6oSmCZ6jvrvFf8n6ajHwFeTL40MLfSSLo6TJnY/zRAW5ArrjCgwQlCt9RfXAlpA7fbSh3NtMrPpfeP2DkDLYXD5lP3M/Haxh7+YHWK+zyGZ+yvuo46boD022tbzQaU+9RkOjuvI6Mcj3oDvN/D2NgiAcNwLl4ze3bhPf3qEmiN05WW+I+vYqc69U342PEdUzFsuI2vsn0+Aiwjf6dtSZh3FDwzFBdaO+qwX6nyKXUzeIV4rawPU3JuN0jPstGEPAvb41E2tCZ35zLGehbd18B7xb7ogxyl6bwEWN0S+1meZPuHAKbzC46EmLevvx+xxk4/QA99tg+/jnfQD3bfbAhzw+B941cNEHukRdaRHh/e94/wztIte/Ej1Ezi7XFuPBd30pIb1EKMMjDXWKFY49yoBPqOiDth79OlHJxsm0HilMVqaZQu6F99iBD/t1YM/i3+zZvT59IE25phIh7nPqkdKDsSG6owv3HRaAi22UeXvQ6drj+KTivb63C5WbnnQE8mpBGtYYDmbjTYvRFOACmc95QGThRqK6cp6Cjd4EPc8m0RMYH/2pios0r3zap0k9Qp4lTA49ig/1rLsBPUI5DOP3Z+AB3lFbwjvMeYND+fR+zSVqE06PxK7zG4MRwj2QzK3Xtsr7vfSB98fk/sNQkDYdKgsnD/kmqvyVo37BWpQQ3A3CAc29Ax2fU/3pvrcNPTMFGb0r9P1ObQvAUFg8AO3cwwB9UsLoAXY1+poc4Euburq66QAPM2m2ranvneW2h3Cty23Qf0YqN+CoPnvgsDal5xFZEEiSfFOHiqJMFGvzodtoFybNOnlfOpgBrW62dB/MOp07jrHC+ib6vI7vEyQP4QmyuK2Jw2kH4LNWAE9Xh6dPdGPhPgLuJnFp/2+jwk8K771s9ZqlMJ89k4+DyXONMIf7JC/kz0wGXJj683Mot594M9h0Cc/kfA1p2dnZFVqWGsHOvnXWaUr9u1yjfaB+LdWul/h2yLvM3xxPQPYaa3GezXA/kV98MN/IHPDc4uqMRjWCj9ZUreJjOOvXI33pM7sawMziHByJBYTII3rzx1HdRBLQ2qAG61lEXXSZiL/gH0RnB51EF/B9K6xno+9L7GY0809rkOMmxosGdmJciKQBfHgAz6pFGtiw+Vzbf1wobbcoT7089pRvGjuB4mGSO2CcUL4E+HMOxR76wKJwdkSfQIY0JuQN+t0UYwsczWEFOhuoZ+SPlmdHk8vV7gpeE/BfzloTtAfhuwvXdWzVhXmedDHGuI5GfE80xpOhj0PmrEpsh/BCar+BqgTvaI1AR8xIfeveuB4pf+tcM+pHXCrmtz44vW4z+z5yXu17nuGcCjJ1MOdMx2Y2IfrgnrqxU/jgar/zwXXG26hW5VGeI7/yKO9G/UIT5e0X/All2btI1wd8HnRSb4E1HCCX2yBbiP9tSXTBvTndEv8X7FOjZpf32w65v2/g/ahzP3pMfhIfg7cSKE/aZNdrQHjfNGV8z+hJrrK4+k3nsbCT2qKwE2r1zK/b1EdE7WXA6bteu8QZjm0B/IBewah2/Cnxg5xhPq7asWg8rZ4X8bQz9YvPz8C7xYnTRduhKVpWdzq9IS9ShsKd0rpd35H3TXexmXitnPBtc9JmfLuuWjH1McHzyH/tcXKje2nWZqLErbm96cWA/3w7pzox2CuYs2whj2xlzF6pCf3MeNornWyx8ek6OcqXQGev96JyjXVhMC/mkBkR6hGu0vGs2sy/1IgOMo5kOo9CTunSC1/wdHW0bh7XaLejLurrbaaLftSI3IR3yKcReUfu2FgfmTQjRRivWoS3+UuC3UjPwMNMvv4gMYiZiDoFH1k01qXP5LPJDe3o2uq7e5HEWpA2M9BdAtCDX+l0NeSQTjXEh8Hye/1FwvEd36rE0roVGpzVI4SbMY1gvwShVehTI0558uCN1AA9Avnfy/vrNTm7IdxFyv9e4r8O8oYb4u8c6JSH//fQZ5u4rcLueeD+MLuX8rCHN1tRO6wpmA+e0kF87lFaHxA6mMutgg7WE5vwD5DnxNf2lMPHpxym/hhNAL0Yx63f7APlk2aPB3yzbdCRA/TVuhGxg5VIp7Yx38L7Ca6pO72Ka+nEquAaxgqjC84R7CFCA+kE3T/zFchy6s8lz8sfwN9NM4ybFG8cieAb2HD5OLH66NMNLxhbB3LCmHODxZzN/YL878V/9tn/jzq7SfIFQlMjvo3ciyf5S/zUMBfnM9DvjbtsXZwvgf1bXuox9l49BrwN/OTJQtugv3WjUr4TPUZQEe9K+V5XZynhl9dUj5cAf20YYmyWwJ/aOjO9w2GsI+pj+RvqjXLL7VJ6SNO7kjxtz/FCx72cu+oRY7u3necxfDG6pZ7RcBoc42eXbdx98jKwa926BbyM6FKt2Zi+45zex+cPtOcUEmf8aus+ul1qhyyk2Ys911816N6DrassJlbDmVMaQXvuqXu27cKe8z/Zc3c9YPYc2raCJPOEH4Q3tLH2k4jtkXxW+aFD7F7t1e6twGYpbsIA9dk1GrEEtyYfObU3cc/dO9tzeLc3CxW91NmUzajwT6DtvyP8wGjPF+4t9ZtWhD6lpdverZpg2495jBEYi2CbXUP0AfBqe5zSuKApP0AWTvo8xUoDdJ+40L9/ZT81iJ5AYiHdOVfNATGTZdvC3CGQn+MZlm0AXaU7zEOENa38FvutNsLfMAY9Xl0pP1345DeSawM63p48A/ZKjHJ6KANNtOvAn+qUVuN9hLmNaJdOO8T+3A8C8r7EsCYxjtdi47UspMEceG1tkwv6imP8m+Q4YdxFH3fpmFlE38kBphFblo63VpBPBpjrc+iO47Qn0vftizUo9Zzh1Ch58PKUxRIEecP20sH3RXQ+XO/9QG1b1T0PqX+2k13yQBILmX6JBl32jvcChh8MHnlzNRGfsoUH2YJjvjF9iei4feQ3n2TL5uOBssXbgC04+MJ/fuk/sJwp6LvDkytSf6Dk5d0iJgs6jzVbdas0IywHzmk16FL7udNi+33hLQpLvaZEN9TZulx+q3GRzg8t9He0p/OhKAwnAK9+hr7kBotDXt/JukGW+Xmf2JWXmo1jjaNVl+hTXO9xoDEPc15v4Bp3JwCG0SHEfIlY/gLIl9EE1m60lDI36s2MS78f8NnLkNah+nzv9JkfCMy/AzT5YRH4p/03ZTu0YhYnNOLDwm2nwV7llsg7QCe8DNqswE5+n4mcRPc/7Y9RPt/QZuui38dsbkmejT5L0Qeg4z3CDMfeS/nStcTqPFqAH9Z+m13qCtgr0Z3wUBjD5zQyRtIiRVu61ZRwPTCfxjFomseZtpeZb6a13jt0XuOzJm1sTca99MeE0Qny3CV7B/wHbIp7wOJWa6S7cTK+k7jVXib2C/DCi1Dk+dSzgZhROWoTH7Npl/4i9PF/3Gg8k58H1KfZkFDujuMJGdNPFV0Cup3mO9ThCG2hL4bQOcynLRB6FUzjVuh99yv6wTCGvO13q7qerwiv+j5aG6IIOHbGuCDB5V/p/atb+ozrAdbtncMSazbc22/weW/O+9YQaD6fzYfazDqIoSSRWISzBtuaxCLmHepju1xsStMMt+VMmuA69vIGJFE4iDHWmhMfy+pZ7h0pO/S1Xe6Mh6w4wnf123Y4Q1+8tBELHaZlceporvb6qLMllq5HwKRBLicAm5byEvON9EKmLZ8+yq4wGeao3xgczHFHeeJ1b8arwU1fEFx/lnu3d+g/SkZHsdADYPFEJzgcfruPw0de7GM4Edk+xifK99g+zk7tT76lJcwMx+4JS4/kwl3KGLJ8AB0lBTsJ9+pE4Ltl7+wsREp7h9ZMHmIOYwP2yZyLhyxUemSf1BpH9im0zeqYGcZ5l0OHQ91ntfvtmByMOYIxo2Lv+XFe7H2N+rMutYzt/WFb8DUqLwVNpnKwyeWLqOflgwX6hNS3cVLvEN/c+ayNt7V+YScDDgyH1Odt+s0b8j1+FBGctG7xKJldj/EV45c8zJnJXxgb6Ex9Azxx5nK2GRO/jzmxGznNT3BdpCPhbYiJwrXx51xSuX7BHFMSKyb+s23fw/kYWPuk3sMB8BX4vr9L2k8dB/QYO9PANrdEwhe2H1JUrAF5sDQuZSfwEHnN5hQurnRO9obMSTY0sgY78Gf+biOs5S7Jl1o6OdWd9meSz8Xx5keCqduSfn1WSu0B9i7VR5K6z6unlQJaCeFbAKv1Kps1OEKDsL+0rKo150nMzedrPtZJk5zKoPbMqTyZqYx5cEWs/k7ipOmc5HllJ8Qn4quc7+g4l4H9pAWd6hkR2I6eDvd47J7yXXYf48Ak3gmwaY9G67bWDxacgrYw0Fw+jqYC8Nd3EeNoEcmNvPJhGqom53vTFNc7ZjyKAx4FfMqIPZLrwmn23thSnUy7PuOgGZHBpvxeyOAm1iQ9ZTDIFiqDgf+rAYH13ohTppf4NtkHYfBxJvYW7OV5TPPKJlPnzvBrgLqaYB4GiF+nz/g13JwIfuUlfr27RIbsaa4exshBiRf3ah4MgU6f+7tDPoY8Y7KZ7tD3O6iRdxumE2+LXI7a5VT4fd86pS/31PD2oz57XySwuKAwkT9KvLw3gjG1Yw/Wpu5gHAflV2PAUb/lsoF7jLqoK9K8H2pX6YfsqV9g7H2KOSLqaD3PzB7ZZz0meYE9Ai9uTOZnHOYsJwl54xrXcTc+Kve9XQOR+oBI/tSBzXkjKM0TlbENbUVjgY090tN4q9yIvzwdvim8vrh90g3g+9H3egHSW0voY143XQfoBNti7BXyj3FcL8Z2YewVh3pPCHzYuWP9G37vw9irPWOq46MmWwrFJzvEmIWsYAz5hroV545JzHA/SajvTZ82gUe6PbCjLj2CA2A3ilW9YjJ/L+TIWOFK/aNZ2zpCRPXDyZ76l81l/Yx8sobpDQDnrcfgbCv+XNsdheWwDX+jH5vo6mAXf1B4eqcly8F01hyTVUlax3vu+vP+fvMD5aZake3D2qmQbUc2HzW5Ytx433u1Wb3sPrKozQowe7FZpfp7YROWMUjOLGKQl6IOX9hFavNCco+o7Sq9xGm1t/FOr10pr7Rozmx9wTuc5WHRC8rmwj67jK0X3rHXHzZ3a9u5LgytCcB9T3jFW/1AeIU3vaJeM/uk1/gX4g82rjT3NXsfk3ykSq7DuObjuxE+HIlDuQcaOzpQXcJ7q8FygE7RP4L+CpfoJ+phhrIzXoOlZ2jUv74OCW14a3jHeB/VNnSdClvnaqA2Vnszg7X+Zp1JbVHI/nEKfN434N0ayPW8qtP1Ln4h1wOq6xRrf661V4v+sNYkPVhihbeB7KD4COuacq7N623uCcslWdehViP5KYD7ICuIDU1xcScwviOoIEvEgufU62ooNijvbbaXjG6XyAfHSSOPKN0OgG6NWrrtkVyWU0/cK5hneKRjnhqLlNonjFcRXiquo4KXToWSlzIa5RLj7FE4eDWryDsxzHm4IfbuGnOVjOxxCdgY23WbxZAxtjzbFnmNw3oD5F2b/MujH1vZitTnfthhz0rY9w7IRWoX7vfFHrB3N8YBob0WgVF0a5FcgMO1frNFk/pPe66LhXFx1KY5lY3QaTFZEHtsTgra4RemOyz22JsmBDsR4RuDXvy08Ug8UJp6JAbXafu0S0dN6ZB8d9BLol2f2fARvt9aRQPqzzpc0S8O8HNGNH9FwXcTf54Ja8CeIfZA3FhEL3lDnBOCgOQWXQ/HlNK//DEzeqelZ3LEVwp0mBa6aqtd6KoW6KrAS4eD3lSZIK+8K7tbF2yLfGhZTP7vCvl/e5H/chbT/Spx/DFGHz3B5eBR6v+2SPAI8JPRxFcaGMfZPi/u94Le9ZXGheFwQuBkuxGzKXLUCQBOW8Lzh8M99bnVj6fNiughxRz7NZzjdjhlhSQvtjONFY+2Lt+63mmdwnU9Qn+3BfdPFBvzpzhVvBKcrb3miCy06+2Fn07kS3xpEZ7+xPtDIVPCTuaOyzyUU5voyU8/bGvVvVB7+5Gg/01R3JZ8Z3pVLSYqEMou0R692HlpzX7aeY5kYS6KvQvRzvvkb/C8DqFn0IsG/uRNo3ryIupOrVg+JlePxj2CeE/91/at5CHaEPX3Ww44u4klfeu3mG9ubzI9zNyeWZzSb1D9G3hgQX+mowYYVzqfSf0PxsWz5tqi+tiM5dd0GqRmQhh97Ar/P39hfnj0xZ2YDKkxu9bG7yJqM3k+wP9S6oRTzH+3vMWM+hEGA6MlUbras30hedaHtlj4m7nehvepThDKB9QJhE6L6BtxRPrFmcmqk7PYiQoERHJdYrpm/dZa+WVp7i4xJb/ZJXTmr1j+CqfeHjl9hiQaYizE1bFHH+qQ8P93koMBa6D7HQ3alNeqvRlXqVkTMQd3Tp7vNFiNzW/8F+MdT8Yx2s3S96s8bfhqziPQ+k4Yoc8H99DxydjA53gmD51lrCeLVUR5q7cLpcZTzxnW6Z6Ve+htAYZHaTMn9uZHYRN0GnRc7dx4H8dTnnzem0W9znSBftpVxvxiToZ+zit5dgS0r81hPjVqM2H+q5LkPslHbdtPelepfDE2y23mj0cv/Mkhf/PA+/d2l/IkZoOBLPOe+rR5oc8N/S5HcNPhc5QFN3VHcxeXcvZYazSXRO0wn+Gc5JJoFK9RXhxbhMbjqv/ItMX2S9443f/Lme37rEF5H4vb2uMRyedLzzsq15cJs39qExKnVDHuPIp8IgPjo0jzS33PJ7kUPj9oYRU8rs8i69O3qwU24UI7dsCJ1D8w9WOg6dVWZPpHl47dKvunjdA25a1ZfyjhfnHk99LWQ3nSKviBQJ/V47VM/DFbL2rNRmuK1znjESuKJ6xmKESeKSx29LcOx2qnuIY/oDmOagDSHWhyOPHRv078m+uHSP2bxK3b16IiT6LDkTowwfgQSr0HeInBFbyE+AdHuDcU9o3zaRy3qO516VFcvBvGBsxJkgvulLSGth7eo1CZvCD7W9AsF3XizbaGtXaxrGC1zq23AzstJHAAHa4hyu35AJ8PmGxwFnK29VEnBl3Gs2bV30L4rWWiPXXC+hV1V7VPmg9Nm3SdqE/50E3Z1in+dieRfppSP8aG4KOJeDpOxCbNK1GZnk/iM7Q2EMfDvOFTOO2z3NQC/3omtXcFWs+H3wnjR0RovUVxjPGvC/CvJeEhY/lM3r+0GX/ah0pRjwdw1TfimcIVbN9lw2LjXgG29tOmS+wW4c2XwZ7GGZA3aHEgcWPkJx+MJwvLjOZ9XQa74j7kU8CXKC6fwgPyT5pDieuhtSoXEW2COvPBFXGiAh44LtWPRqF6YfGQim+B5PPlRq+JPdteZPjubq5W22x5pr6GggaSZoT1BvkA7JkmzPP6yMRPvpZYUIyA+klwjnIW9k6EV7XX8ZEv8ykPNvUlXBqFfhGvEefqdVuMi5pyos8I4oqNt8n2Z5o7RXMK3TKnEGBa+hvRNnpjY16nFC8Inxqk3Gpgv/p4a9GOI7lahznGIWfYGXoH8HNoHvoLrOA33shiKgcvvQL/Qj9C2o8YXjK6SwzJFU8kr5vSqvExLflyXbVPJ8KP/Wp9qUb0NjHsEt2+jTg2404Mx/BeVvda6GRgOzz3epTwWDcBeD36WNPcWz6i+HxxXIa3vH03AK/AplSBFpiMe3vzWC6/JpiHNavNuvssPuLXMB6T8AiLKwFIX5BKP1ZsN4HnXSOrjEXdOJrHF1sUhrdcPy4+66u7IubkKEYZc0qMOda+2JmFPv2BkrRDtmdUZ85yrJEaox8Y40ktJtvhWQu+O7C9TpyjBrIqIT3PhrSuxNq/4P2e7nfax5zKawE/gcsoDV9SjeqqdQ5tbarLm1I1xjGOlo3SNuR6ttplfphhhPy9YQTkvRGJWWEtl5nDnM6guxxXbiosbPitzehxUPb6P84mdQ1jUEXOHJN1L3yL1FcojeNqn56XdiI8fVvXzD1RnbBd7zrrGalLk6/XSKV+X8us0drjQYHDTD4aZ4vBrk19nSiXktkJ7UexWeRfTLYCuafl5cgv5Y4vCusrfmdul35EZHE1HwPtNKKf9esrt7db2GivJvp5RvPaXTsv/NKkfUmoOCDTW9jFlcjFE5n/0wfd3iVG4YPmTJovG8pTjJ/SZ4D/9dHHPD6hXtbbjeMm8ihhdlJobp4LoonV/5uMxmox16Uxzj32dFo09Wto381s8rh1RefV7gBeucM6nwXw62VL6xM7D0xzkdQetKr289bfdrsbEWVPhLqERuXq7Q44XfEX6qOgMeqvo0mq2UTWg40ZEn+50bv6B9KjLhWf9i7YXpI22sRav0XxIeyrTxu4CnsO/ejJireYH33ADVGH2PrLSGJ+bpvZO/EHwp/wosLe2WeFPz8r9KIi56D0VxvxofSP03p1gP+skD8zqqMlbZYzQffD4Kmf4iBMhqsXPVverCiP32Zcz0e/rtaIqH5YyNy09BMDDnbYOwtbqd6z+sgDZqx+yDuLl4jlanXoutDGbGPdE/pkOexdwWe0Rmi1LPz6zXNGfZpIE07RV+BI/NrO+lTVr4lf9qO4v5bseWovq4XswdyKpNVg9JRq1jgxeOa3TWWtLxot/xnHlzMvpHMzgtYHkw0s/kNy483JwrqLUb82qMQWBNlbEjj6BX8g99ZDPt2FA2qfRcHmXMtPZG6FfYJ5+nWkpxmL6Sg7SosflDfIrTlH/X/8pcviNvLCylAWsT4bdB/CdskzhL68LPJHm9SXZUzBduLJZ5RnqAtifwOqT1E/69CjsFe1yx77VDmHYN9rzOThdC4ejphbTvB3We8BQ1buVk091mntYjHexX3SKBlzYHjMz6PSOOHTphqYr35b77wrbSwnZJ9BX52b+PluGstmgvC9iK/1vLCH4QX1USXS81oSn3Lq0/C3/otPo2ZGpU+jGp9OLB3rezEXRVR3zzxfwesOqM/X0ZOwh7lXOvYjedErpv6e6hV0rvdeROe9krP8TD6bQ89cspxPpaA54ocDvUswOieyfyRvvg2wN7LTOKf+xUJmcwFlUuNE4Yn9fgn9iu47WY3Ssr6U1l4iLVvMtvCetsWhQ+sOGf2Tsc7hCXkLjd2irnF0mf92fEb/bZyeqP9WHVAbta463ZT0NHE4UbC2B0Ljc2fDnnPudF+xhsPHZIQL7cVX6oSY1y1+7NjZEj0T+LBcm7aly7RFcFnmHjrqku+oS/atDGml0Jngb9Cj0pMuEZ2D2XSY04H0bVvl3yL5nelzO0XHmkGsSwm7tx7Bh3QEv1NaGV2o7wN4yKjL6mCH0zHJLShth8hhsO8xm1ov/raofjJpkL09nZO+VdQiUjsPdD9q4517yTi6NYhueu69jw+DDtFp+L3A/M1xyvi/7VrwfS2jtnQRU8VeUFZFXhjx9jUuWupEE9JvhKy/u1Pg84rYNNhbZGvR3iKYh729iqxPycAhvLKuS/DZxRoUMsaC2s1kjEWL9OazguWAdjmTgB5ALidKwYMAj1vY60Kk8uIcvtP6jUEjKuziS+oyXxnoEDp/2YY76psG3ddzWe5OzWX6rtHDeETSxxjuleRAVfXdKGoQfdcu9d0dZ1N9l9jMSLOhdhmaF9+THstBjyOxrEq+i4A5Kaj73uyhTmpVUw9133jKZKYdWE/7dq9PbzGMx/LkqR8QY5rtah5qYndbOA7GKRcc0knvkw4M4/AYl+xltCdL2bPF7Bc9W/Rnr5iDRflj53QqcvLNyWzq0XiL00A8FN6SK/UNrjVWY3cIUA9yb+nKxV5wJv5m0d/210KnvRZ9KZquxfwmj8aL/+Fu+BLhC57D8qnekI+O4/kHWf9+SHO0eP3IfCWX4fQeuu0tzQ/YD3OWD1aNedW76JPbaNRWVruAdYFEdU3V7Y+oT7NGZKYkt8dDrpgv2dd6lq45Gpu2UW9Maqj/054jWrOa53HoWTQ3wIpdBq820p8wml0Izgq0N07B36j9Uc+0ni1VYzxqj/rDPZSPd36tWbRGfY/9P2xS81bQuiYoGxv9lCY24OGSesCboIs6l4CPfxsTrMauo8CXFAKbr3HBtqmwuOAsF62K/VvbnjjGW3bj7ZYj6/yYFXpAm8a6zUPCYloFP361YTCXnNTwXSoxH2Ekq0gPUafVKuJNKonb8ObHhdWf59xIi34bb8q5It40Qd+5JEVkZ2tKN1deYkBi7+lvnZsjWu8TNtFH9LWfx9vlzOp9TiPxpW9Qn8uZLx446MxuK/NGuLE4Wu9jOZLtOLoqjttFvY9V7Rt07x8+1pU5peaonFMzRP/XVuAsGmufET/B11i7KXCsTjW6vtb7dmbPWLuk2ruGbjdM/btYe2t9+FWsXTSLmmj3WZdUH8cXjsmiw637G1l02AuoDxi9mPZPVbmF/a19k//OvhEUtG+2j0eRJ2Qwf3FhT0yuU8BBYxIMkS5AL9KK3GrjWV/XaM6ior6u4tvPG41BXqlxEWvqgspKzEEG/rUt+Bf6n5w98VtIKNuZD/BsJkoi3VTi2/u2Js8zDRajasxYjIpvlDGqVfqquyDNJ9gfhdghmx7K54EeXyzqO1z6Vj8vYhlTzBd4xjPGkynyhdbmQPLHjicR87PAXqf1jDOfX9ss/3niYX2nDPZXkW/J6+cjq/FbLltF/Of62InP2uYiZ47EoSXOevpEfEejPpHAmOMeSMuTyHLR2bwXjJecVEvKKP9NyT7qt9bCL/q2kDjUapNRWbNg/lBOtWZRn+0p3fuH/ZjSOBT1x9t7nR9He47Fn9RpVok/SY0+mfNu25mgD6w+QR5+bZppqOikx/Uzz+yZU1bg53Vf8dlok4G8+ybePHmYRbyZdCCt4hjQBPExG4TZk55sQdlzjfroUW9Kp4WcHoRU/yJ6oonx4jLnchw3uRe9MOk9Sn0v4R4lf04+HoxG21L+GxrdeViDJOdnfbsQSNtYtAMzkfi0KjUeQJvtBclRuDZZLDDcZr1Hi9qSR9rjTm5N98yW3N8LWzI4ha+2ZPhqSw42k0KGzNGOn6COKCo60TGZDj0/kX2/uEyOeEfMDRwUuYH5Dv0tZW5gQ7OTuuXEJvPBveQXCKLHavQmx0cuvuz5la+M/8KDEj2lfjMiI5OA+MrbYMM+yDk/ZDziU6M2gzx8m4kXh+j2WK+4jIAh3JW7Z2ff4VrFp34g+KTIowKfjuScBrShWNy4U/DIXlWu1l58g92srNHvUPtfADhclgA/uO8lN5i8b/wwivcJOc0rk9Y7n8iUR6zFm+4kXqNvTZz0kZfNpxPKy9yQK3jZuBkTv9OiQ/CozFU1em0mr7OXuMM61iaEh4xrrD8jN94B3zqLOpP3gFQv8v5Q+LiZvO8+iL9S4vTrC87Q3oO3BfoBG3PWe2R4LvOzLy3m72iJNLacFvnh2Id4OM1YLqdP6uxGpy7Nhen4xDYYWm20nfgCv5ej1Qt+bz75SuS6SfB7aKXEzhE3hAdQmxnjZGAL2y2Wg2lMyl4CF6L3moAbNGeY0R/se7Zw08NyaBFeLLzQ6SqbyczXeqU0Gcox7klU+Fo1qZrvS/uudSr+1uuI+Vv7c5inKJN+kUSPr3+o2NNtFZpMjkUPloskDPEAB9qPMnjaeQNi0E1I78mKrehr6D8mtgnjeWgrxuRwMjqGXRkDi3tFkkcuDhf4vNK1MP9j3rfIv1J/nsld4A8D7K+b7uV7B3TXhcvyngcEfHQO+XMOSzI12iuzMocMXdt0DkplDrvnGFZlDB/HgDlY+G5Fib7Ma4N0CL8ZkXt9AJ3IrdWOxv74gY+492Veiwhx7Mu89riXX+cVPMeozGvRImPkvevnecF3dZzXkMxrocnNDvZQK1qo1TdcHgM+dYq/O82eNg6jybZB+K++9RdiOT+vMr+dOHztR0rnNyvnZ1fnZ5VjOJUxUrLGh8x3CUxnkrSXb+oIRnrIza6ij5PgDvS+2EWTzUkaacA/yNxqhO5gbv73c4u+n1v/27n5388t/tPcovPXucX10N6b8QVbzH+ljRbyiy+0scqk6BvauD7HqNJGjYwxmqxynI+kKbjfdg4jjSab3NoJegcYqLSfib1aruDeRm1erI3PePAYypT3UkfJBM3TWSzREoYPvfCTa6dXP+pyxPylwWH2K39pHNqFv7SXMX/pJnn1l6qj3Z/8pZp02Xld4lM8qb14xPpVJtgDQHmbcWQNx2def+tLXn+hyzGZUL/ZsUp7S5JcAbbOSg6QoRXxVNav912QvCGtK56OkkfzqLKeXNT3edjgv1Pic700ijyI1GW6Aujw17cuzf0ZWifaT4b4Rx936h+lNj5X2PghtfHVRzGPTNh87GjcrWUxnrYmH2DtV5bLEnXDp5+MyB/0k0XJnfot0MfZc4sYNsaEN83MfbdZ3654hvcBnllAK3gO2+SN+ftQx6q95hoBnFf5a3wI5nEh8hNwsk9zr7CHs13EhVp5UTM64Fj/Uh/zP+WsLeABVDS1slrjGGNeqNGSy5oKKSJ+l4vba4QD84pnroIt+zYzdpU4WKLP0IZ11a3POznW8YC996a8+M9IzNmfGWkltwyeS6SqTrTH597EbkbX0AWa0vLZKOxbgwaeaVC9l7xjRnIT7WduYkrX0el1xaLPxa0W7QxLeeLeZDhgdQ4z2tOKa1y66I+M3IzI6lQegHx/w7yeqWjTGtvet7k91GeccDfMSVoOHbpPT3oQv9CD16J9a0o7YojPzow4X3g6xkfP2Dv4xkVtFpduKECnaMeTcwzHDW3Mxgj73/qdapV7ic6snazCr9Qoagg/59pzgU9yVku/Ios9XV71450wugksX57kmasc9Zt0u3YZ1xFO8Hmc1rs052L+rFmk/REaqPMU9j3HZyQn3/yQaN6TNYnNk1TyRkNWS974tlEJb7w3IyX6jZ9OO6hMlzuea0Pmq3M4Z6+eQtd5wqzIZxaZT7RpxVU4VnCXwNEYjRgcrR7tUfUVjnwFDvrI/kuYNtq0N30RG8ZciJlBbXC0L7enm0htSn0KKtw43TBdZq2gLvxFl/GtvvWNLhNj3dhXXUZ7jlGVx+TM5JnRrvisEglw9a3sD8H67gtvE5H6vNx6UdvXvGznOYkVeGibzt/IWrB3/pn2UMR+w5fklNOeLENYWxpJyjNvn8SHSe6NKfmeRXhQ9NIPqA82zYtf7xGZCtAp4f0T4VTmfR6pX+ClHuIQWC+ytdWFvR3vaM9+nM+zJgPzr0d5TvJik9CbcoS20Pd0rZ/r9ennPd0LQ7VV1peIeAY5wdmFwnotFj6A93Hylj/9BlLx+VucXsobmmtW+KswD7ki9yr0JAwG9HMRryb4hP1uaA48fXd0zpmfYhGLv4trTfK8Gh/bm80JkU/f+m1Mt5GuDg6xySu29Q7orAn8kOVzRXptaDlg8+O9hLaOXZHR1rRDaAtzOoy0ki+CfgZSP/RB46znxk5JhGo+yNcY9UYsbOvAwpalp54VIG+K+znr+bAmeSV3Hc/tkN2gh76mdV0mORuHhNrDBNf5VFhYn/I/LnF2ZbWoV1IhLpG8/f2InHVBcm0HCZVzeQX38pH2gnvSqeyvR3vThh+ZG+AYA9pPBvZ3OCPnc9Q5tBlhS0mvDs+KyJnrAAeQp1GAc1z3Shqov0UlDSxLGqD8+qOrlHzqeCo+x4inKxn7Qs+vVxpnc6heE6yy3BgRWAGHcK452s10bHJ2e2Xs5ek5th/Qz8NFNqZ9K3mf5IkCjrF/NUHxJPSf8r0NhftFIzbP1VZ9yrPtanx2m4Msv0UjGod47U3TvZb1zWVNBekBzV/iyZX2hVFYDc9Zpn1hsD6kIeYlr13l9CwEldjj3/j+x0fWB3Vzeu2Dqg/Fp+/fGdsNx7KV3oz5/oWFS9mVwEUqf65vfun7V771/d9yi9JrFtEcf5ZTBzTrHXvjJq1d3pJaXvQpEltf2GByBtAib+LZrh8sh/VzbS/20Vg+ZR/6rYjvn78WuU3ySEa+S3MXumI4i6k/seliHNWhuVcveVeErm8rrpCZAc3t4y/EIa3su8Ggd1wdWI/wNq3DqvhbtznToZn/Cc8NWgpyfi19QvQUeWUqkvxDgm/bVbeM5cQG7fFqBg2x8P/nEfObaKs56ck/4+p3kncfvfZKsBNzaF3fUO5gf9e8vWO1ldZrf1fpvV7u+cs+NjSRw1p2GoeOumJbmB72Rc2A3OmivCG1TujTikjefem7fsYWdIH2eH24ulnEJsfJDPkO6rlah9Wsgt2piN7+WtQf9wXSG/N3fbBqJDcvqZ8mNOexfvPWfdJ7Zlzb09PwJrGWSzSW0Y4kKj/qpKfjZGUxn2iLfX+lPVrnU2pL0N5Yk05e7Y0FNhDoSEZOeRs5vyDqXQtflohtwyQ1HoPc7EcyhQPFi+sBz1eMq3J2R3SnocRV7UymO7lsTluU433C40EHv0Zvn3Lwat1Cf7sU/RRoPYlgLnuFHf744GjOmBUYrP4Q5WTVJmC+8oMHDEoc59jDzOhS23FBcwEr/QOq+bZREPRrkwDPoIoI/CTrzOr/qJ8QzwKytKJmccDiSuSYO8SbEfGFkjwt1LkGD9pfJQyeeUR65xJxHOvjNrFeew7UP/kg3VXRd2B6E6kvuTYm+Z6RjrxAWHXlUjefXLqlbj5561Kbyu5MmN/3aND8z3ptS94vhCyW4En3hWc+ZrzT/nUsoTuJ5xrVndZof77krWmk90b//ORBxrGiK3zlQ14nK2pu26jXJg+ujXgnyO+9oh8fie+xfnxzDtecPgRaF7NuUZ4FdtwrDqHtGG9ZHf+6VitwZtIj8Q3pNpnU+1gHHzaw3nNE6ozxPKs2i6+8iR+Mn7UKfjYWaX3OIS5ipbzSr8TfWc/Dij8+sq4ii7+TY84Brx4n5Lku7rMw1Vg8si2K+Ssuvtom8Us8ROifPopaVFrbU1PmOZ3bNS1iBY16/7UWtRonWF+KvAA5G7zEW0kfph3tZZKyfhbEd1/km5/Nd9pbeHimdSHMt0R1jo/89GJ35SvMaUsdVCGYfqtenjkT3QvtZXyuB8Qma73KdAdkA6cTOxz7jKoDh531Mxu85B0k2aXoffeaU2DORFVLrGPpP5uP94dWOZckuNCc1EZ7fmK9aoVeUW9xOKGtvt/TWvXS/qwHQz0Nmqax8NKXPhsAC4fkE5H846hzITV7KYdnjzoDpxUCLT3QJmB5hqPgqPUZvpW5nt61zPUM6jR/80u979dcgPdzkQtgX8l5ZZfBOV3b02sINhHOvaDlO9Bybif6dlbUfD/zqeWWvZLF3+j4Yk2V8i6jN/GF3oQZN6G43Cl44F58qdtG+drJNl2Sa2mam0hgOZrTEeAp9mvrI7yrOe8vPLBHzijbdXaMD846lH+fuvqk68QW8aVijNP13VsD448vNKO+N1jPDpSNPs0DL+q0sD9y8kF7YJHeyDVhvOTLfn3Mt8Tqo/qC6jZL/yfMu/mxo3E00L+H9Pycms07nDZcxKuhoyAvvFRi5kQ+TpJNaYuOfbnsdXBvniWiT1TqXGyqN+0/IunX9mAiX17zJeu4HmH1oRHYsTUIw3ZMc6aL3E30A8yWhdzKv+g7HVbHeWrwWC873h4Q10hfT8OnMdU66jh252IxHUcb88Qv8Jon0JdtclaHuXDbDWuvjrAPTkLPutgI4v2d5jt1yvp6k/h0gd++k/ypstf1fMTy8z+wtoPUdfoF7xXU1Vup5wC+7VZ2pXdZxJ2jSo8RfdwiNcIG8c2387ymfkQRq+kn/Br09Zb2zENBmR2fSa+ul1pI0iPGwO+fZ9ulNBfzGxyODFpvX9TtgQ6KvIOeS8fdjY+SXmpFTybmP69nKx7tTywpvesfRa2gGSzImltF/crZBw5ijBFGUcE7Flbh+7SetdPZOSp7J6wksTgX9TAcbRbI88Wi9q9SQ6VT+xjPRNpmUct65gUC/jfpeRbVc4f0OLAn8UJjuQ6gK262LJrWFWf9IZ4/JmLf2hryryk3fsllGrwBLmEN5r5eqWM14w2twxxtEE4f2crpkvrLuufcZ/65h3WVm4jmNZI+w7Xog+49yXM28OzVMdzj0vnKMdmfrvVSBzpl+k7QxBzIoyF2RVYf0apN2BJySdOCUOqdbGlm9dT6OglPRL5NWuTsnA3SYtqTLexJSXmgY6BP6zJCudN/0B6HqjdrFTrKbbQrcFD9FOeu+Lm+xrkHiU3j3HFR8zRrM39kzSpi825Lfs09qcTlNb5R5J0cWQ3DdUdzpkA/0FA/E5Y012w7d+om0ycFI2B5BFHrTmuRWI+IZ84P2AnXpdvmmC4iAJxNlpeMNXmjhGM5QX3sv8z4oqlMyrNGC7tLm2EvyKM69qhPYo9nSkukBovkWBhx7PNmGgyn6eLZ26Tqn/MrPohaVV5U/b/CW39P61x6pI/YLSB5EVivxfJ6Zn2R5QYJFLamuVYaLAdEwLo+lGlCN3qRaR2uWstF+UFoWIVuv6BjXtiYGM+KBoweWD0MyKa366Bqy7U/lMKWM8yl/05toR7pxXJcjSo23XZ9Fkt63+A5LlN/vgOYlfVWC6xPZv1gZM7DejyTxkMOtN8Z9neUbYqzLs8XOHtF+Bi908JdcNV87zbtpdhYDZx9iDhrV/uGTLVRqIIdrzbQHu/U4hxpR7jzQnF/56Xn3JTYDGNDeZ7ho7w/yLlDOfAO3RertunMaKcwznmBePfSryQkfrj2PmD+MXoOl3ppEh7HVXsdkHNkF5/0X/T7RMMPYqsWPY3me0ksfVXLU1TquNNTRP1D/eh3/tzkQZ8BWWgfdFbPnQlvb/fSltP3d8R9/UrynIlOkHS0l7zpaddGnXXTpTrrsy/hLnrtSygKDzaujz7bDM+LBrzcOuy8Us7NaB34+6GkRw+T0Uj/V+xcQ/plUhue7PEjLnTKDdYzVWoH5eEU9Hcp7N+0G9M12XnSrAar99VHPLpfy/zBmJ1HcGE23sO5v2EP/mHthr3H82cdsAo0d2xZXRoHj0i+K8Znv8bBr691HAirVgEr8h45iz+Uok6ydrIq/WBq8f1EfH5cynWyb+yWKfqvNsTnifnSo7XBzlnV5NdzVtcn61u7RReBHnzin4pG3/bylJI7jbk19DrDmyL2OarojQwvjkl3Q3Nu5/6d8ajNqahHHNeVai9e0nd4zvJXF2+kv3DPx7y19pfeuztQ90WDns9L/Vt+9Ldx6aTVKOqJ/v2YtFLiLKmRpvQJ925jMr9Bdyc+9b/YUsszd/D8Lz5n8ebaiNVgtZGexnE/icretQBjrlav7j+BLa9P+lNCPwUNZ0V8yN9m/JL5OGfajcHbKOnbvMpVni4M65hjdTwatB/H0+dF62wFvXYt+GwqUD9qUTeRCOw9oZUzX2rvVJxzoDVlHPdKcjorPC2sZ/6y+8I35OWkOPO4zL/dlmcbDxylyM9l53RTnjdVWO0x8w1vxx9l7m3kfZR2fkS+Rx44ree/sWG2+UdUsWEQzuvd/vpCn0SnNZA+H++tok/w4KPar6mWCB+M/+7HcTtn9dGf8jYAvsy28S9r6m9MTGm6FEjNw2sOjyJMZhqj4Ub/5YyT2PgofQ+xM09Nx1alib2jNQ8vvRfDj02T4Ok3tQ8i+Z7W/pdnJj+yN7K/d0N3Hp0iDwd7bDx7bRC6tytxwNVtQnvPEFybvJ0Lf7NN/BZFfKbSB4Ij8ox8w3SDNzy/hvlsm+0NlXN0L9OY9rZ5+kOWvNOeYh/d6NXmRn9IUPpD4us7idWmHwsvdQLK/6k/hNXaEX9ImE3S0YDUr6Yo51pzXW65Y9bn53NsE312RCd4W56YH9E5k3uN3nlFzlnBcxixbu+TD8U/iCTHwDi+9PUJohT4xlEbbXTQS7RJLBsPIg8DfVT4Omg/tdk75XONK/rwHY/wvwn62IKi3n0XMbutW66pVzfYmrxr9/p9vPZL7rM2Lnq3qre6Qfseuj1+YZN3P/Nayj3Zg0wkNU76fffa+7Bcly7fv12X/Eb7bpa128PbYqjHQPZML3yuxbsWa3Hc17WUPQ9LeF/56d13w5fYM4WjcCRwPJjbYN87rWhvBrOAIWfDe6ev75UmJQy7RM/RDt4f4Ej7Wmr8sYAjtxlWaqPRxqI9wDH2YNEeF40PseBlce295GVxg3z+XU8ZBfvHJPUBwn28dd4xz/Umwf3dKfZu2VqecBZf+8ZFSoTx0PprH+/uQNCWB3a2HtH110Lw2sNuPKiTENk4Phzz8j1Hlu+ZLVs2jY/Ncu0lPjZ6e/YeVRqqo8ST6XfnZdBeJXv5nlDdicd8Ss0S5h2f+ij+zs8fLOn5NWVOAusvR3yWGtpUiHPMd/+iK5DYQ9FToTGzv+17tr3uz+naojVCkkpzzOKTSPW/xYr1qyh0dWvcF1/klvKOeWJTD/MK9asLYzlOznKy9mMWe22X/S9BX90//atUX01wn8zR+qb3w7zE1TXa/5RGboWeWeDpueBh6yPsbUrgtMP9pXzMfL2f2lEFLTK7ltN3xTh9gf721V5y3ooxp2umt3+yz/u1xUG/rj7ZZsADfFbTpb6DDJqzGqwVJg1NipzdU/F5LBBb4GlPuSy+d/1ke1RlT+ujza1ySvOf/QFUz33fYW4Uy/k1is/bK9HtqV1i+UbhexZfY3q1qvyNglWK/muQDbvQ0+NwkF5XoGcL4+gyEGndBU/qrMVJrGYG8/8V/k9TJOd5/bpO4PAeFXZ8v0/zzWtiLZUo7l1qv4p3om7SLXSTOeObnU5U6CYCOxfjXazqONHkXWR6nrjOCv2wLvxtn0yb9t0Q7Nc+mf8Pce/WpaiyRAv/IB9ERdRHEFBQVFBQfFNRbipWeUHr138ZkZmIVVZ3r33OON/eY43uqvYCSWRkXGbM+R1Xdqu0EKcgACbIDVcLZy8pW84TyOyD80FBHT1UTvy6zDn6rsR261gT+7u/M6XRICnzZjJu6HlI5946e9S7f2Kmh6tNgZmeud7Y8zqu7ZmUN7Nf4lCVFyOo4iFvJuBY5wWO1X5iOUL/g/n8DPrK7gL1kzBODXhPmc4vv+JMk8OpiDfj/ZXFxF18phjDzi9l7qpK0j2Va5GTtlfdWbxODTUpG+aoNjmtP/zEJV59xs1WwiXO7krBA3Quc5D/Jf9lnA3Eznh8feJ5NnJonTvhBK6NcvYi9k9AronbKSzP3YXJiXEOcA6MIlcSnnmGIvks/k+y+2dI/QOtUQPW2+LrK826ddqnl1CIBXq9SKjwzFmqut2A3PTHHAMOSVLcpFyaTQHw0s85Aix00s8wSp+BQ3ug26m5iAOfOTKdI5DpHMtaspWfswpwyLHvcEvfAYfLG3znubjOMm/ECvvNOEMDZ612/jFD0wN9bagPH6geQqk+nK/r+2tAY2vlXsUeN9VCILFDiPrSB/V25FoI05zPwRqsV6fO11AX4vVhVv8s1Ygng5TXiDmngSzEo+mkY4TVtKuKK+tFE2McVk92MY9pnOQijqpSPyFcxIHwS++30f7kvd+RU2H5l0c1wYsayudJ/r2GQjE+4VCatoaMN6VmMt6UxofP69bXK/Km4LwA2hztxx96MfPZxTxc3awFfee2Dn/O7zWvkYj644jTsXB+b5IeRrcj78k3bNC8eN+TT25ZTmf3hhDj0PdQ7inG5zmg83FrqFOIU5v1qz8O3PcfPks1WONaGzAOjcuJ1cGI0cJZhD7EDFGrEbDiU+EVg1v5eM7d25JVYAbH+HviFxeTnNcO39U++gPG10q5zk6fn0cSA507tQ/AeCaLjGE8szLGc5cfoVahjfpM2yR8xVsZH0kx/zEax0VN1PrAvydOfY3x+jovnTG5KQr/cBYKlHtQ/5BfzkKqa8mwvJVkd2RYgfUAahi52UwP5fPLTBbtnMTV25+8zwkgXvH8iqi+eXF+9Vc4m69+5SMrnp1ov9nLDLLXM1angLmqrkZrAsBPe/rYMM0Ml+P24eyK16pc5OxuWauH7sN4mXGM3XgcQR3ZmACvb68hu7/o3wz3OZ5DAsS6yN9mtl9ixIjX7wVDi6UyLuLHPG2/u2OaArtn/Flwz1pxPQwxhl+MfmLJhsHiBR+G+DG4T68PYne2Xal3hERpxoohtzgHEa8hoWb9HHqzkp0qL/2Bgjf4MVx1u5WAYjSkl/iZxLsP3S3ntN/O3WnKZzd4fHe88bnkVs4xNa9nq5rlKz57GzczNkPQvgqM+xL2EmDAcE8Bn8+WvobVdivHFcMG3uB9j7FAz+dXbLovqfUvqkcDXA1nEfaq5H2RmK0ynEwfwO1M4ifaO4oucpkbYgqSQ9J8PQYcq9paL6ZWPza0UN1zrlnERfDncd0zvJMocC4GfQ99u6KG+VJ/K/hZ1z/W58bWR1q2eW0vOrLaYY+tT5WtT5PXuGkt9PR5Aa1WcoYaPvYnYP/ZRbwTfo93vsfcBcYQ574uqEMIc182xyRa33QI1idae51s2injupFhj0nmqAk5lfhDZ6kHe6CiyJxPKU5VnDHa34KFk6zrtf1vOkuAvzCulFt0E8NMl3PaNAB7Ocp4/fyFz6YNuP79oAd6c4lyWded/UtezWvkC9OH3B7XKW87ZIsY10WJb4l8hv/Kt0Su5wR4hQdqudA5L7uY8zpCTcw7LA9eEmijG3ndgOnTketbnjaH2n45hhmID59r2FaonpAZQzwoq73wg+lU4pp9NGivYYT1/M9cLmnBRBbzyZ2LwzhIpyvwbdlmEVLep3s0iqcd6JN8SnkRn/7sk7B6utoEruZj+3NS1jr4H/rYSndZ5K17CAZY3roPLZq3OoL+bfbFN/G7by2KPb5msvEfYo9wrRbcASyHNUU6o7yWiln3NerWvGhbFflrcuIY06kpF3V9igUkMazJ+mXIkyUtgH+FcR8sNluG5QqPHDOsdu84H9wQdQuuA+bVO6seBlZ8znp4LM1Zh1HuxuLLnPVGrwSvM7m2NFpteLyzM4UiTrkvczqDO10dfpvBNT42bAY3XAVsBreOOtjP83izzP86g6te95ikgJ7bY+5Phmf9Ed5IHC/XjaONOvPXh1zpbrhu2RUxCv+M47jLZ85X0GXctUuO40g5jsNJPkpx+muMrm43PEZXOI7jxOPJlf8aTx6x1aHmoDXvhn0WG8fLoreyBN6xW/2+Xx4d4B7NmKZAfQXPkqzVDYNdWhuq5cjND7O94Wv8ETaPrH4xYPzCB+j1r78umOetxZDPIdg0z2v9gWuFYseCVibmGefR1VhOs6Lncf1wLvhWdqfXteJYX7Ze+njN1ysMaa9s0p197vL2kK6LN+7TeVTv0uQ6UWH/t3XR+LqEYbEuis3WRa7oA2hokXg4hv02jocHFg/38H0sHl7AD+rpbiW0b7vN10yP2jvarL4ymF/x83fk7Fo3c1X+hWMEtNlle1Do18jI2XGDvK/C12j7lf0x7+vHK8bZsSZn8ad038O6tHtMP6tJ9x+sSw3cOGpyDk9ffsO8rXs51gU/j7geT71NrrEoX2le3LCDkgZn+czBOubtROuYQXdphpttGGHfrU/iP4HcemWaA6571e3hfe5qimpbstocKpEVCYZ/7gSnHHq7jUNI1zssr/cmxxmzs7WjWhfc57QoL7bUfyyL/KM/XnIf1Ftmz5mqE+cBGP/Km5pgPoU8AI0N80Hbif/ig9TTX3kAZK2SOjlZM/XOXIcWTq5Xoe25+nxq1M7AxxlWcsBFZqhpuKU4kS45N2c78gzyppF4CxF68zP/XCefmXXpWgztGfj5PsNLXZ0zi3vOK3oOAX9/j5yZiregeViuGGNhkQezEfZHbYgd76Bz7bapjg7VzW733RXqW9J44IdOvTTvLeHsvpsb1Kq3/6pfPDlPkZenGvHrQO1iEts9WGznbIAbvyXzeP9a/P6ZW1J9Avb7NfpIdu97/UMr6WyKK4P//jqOgwPVNtj2WA5hTvt7ahcdylnfaBi8RysZ015Ja+/RY3iDrJlBTnzd2Fyzi8/ZEpvaIPc9xC9gd4BtqF2B/3+VgE4AXL/PelbXFceuZDSW8Joh44SNJgfO1ahtfez5CD7qXCpXjdlE2JoFSq2nufeWC7r20Tvetqo4ju091mPe6IcDP+wWOO0bukg5x0CDdtQm6zckz262A+3S/Sj+WhK7DA2c5/Cv+pnpAUYO1ijQtiyIibb0PkRwV9ArWXGd2TnDqJz14IrznJTTbKfUbBf1RYFf9dN0379nVnl9Ty8FHcs2nfkhtviqu7MX9qhrufUgp++Lf9FPF3TXFWKlZTI+sHzRproIZ7QZAfK/CPMsneSGKY+xchpjmbcY/82IvxaxSnUBOodxMttzXPV47HGN+2Q23+nM925lsYt65ebhg/lunAs9msYzVq62vQHq4UANd2pWr8liZtOZavCFA1aLIef9CL6P5HBVEncEXJeD8wQ4Pu4nvp4dA+ZNx9GUXuO5tshzWp+HObZr1KO/B+548owTfn9CF2dZuwd6P19uhd4v4Ie6/B7N2PdFOvsDee7lEo9DO94VnDmY49G/N43i78ul/fx70+8WemTTHauJ7P/G4bHlOSOvg7vzF43f6Crz3xuSGXsUh+Um4hOH5WKNU6Pz8lW+nxHzgpghmWM2tk8tiyKv/DRBP/sgcl2TynPtS9cJa1rwjBS+DHyBSOOt/d5m+75XcWkfxgsznKk8v/Rh8koyXjPcV1LVXs4ic2lzGxI9YT92tM5iIYxof0XTbU/3po6tXplOqziyS+eVa5D9tF8VeBYSY6hNysPQd9WI1xBRzwWOXQHPUfqnn2TNE/ZESOzK93Ez4z36kNa0Pva81zQYuJwn7HDCax46qLFRWzZs7YXPMkce1Vi503363tdBff0sU5zW3Rt3EbdXw77QcqkgJnhoosZc5qzkyUCr55jr0fdgP1TA+dffewge7E+o/7tz0IuvdUPgaAS8YbJJiS21884qJ/8+J//OeJQMkAGl/+tUETv/5Kq67YS8KcmVCewtyrHlnvfIseV3ObeXOl3BOgEnmKGK6wfjJiRBhAV9XEN9fDG+8KzgCweu9dEyNxE/QNZ3eaKxhL4Q8HfJArVWDpJO0mUb1mIeqo9odNaQrwJTPsx9I742JPqE9bi/rsfqpL2sxwR0FXE9Qvtf12OmkvhJ7MB1YB6mzD9mcE1R6jPebXm0hOcG63MOJ1HisznaFdbZZ37t6gIveMQ4Vcl3tcl3DS1yPlTDLtdVUIWGDdco5CHlxqjEXsp84JfMfvfVn5Jz36E+bqF2qY/b0c9Qs41Jz9/JrD0A7tHgpBXco8Ee9HGXqFv44Jq5+7jENxpf0hLfaN+hGlujxQo5X89zxjeacr5Rv+AbbSFfPPm3iPON+q98o4vxifKN+gXfqL6lMWkUF3yjty7jzQAe2FRj+jrLJPs60TNWWTdWpfiQBPcnxKWHmynWfuaCvrG9zmsMaK8ceF5dzL3O7M9bNlpibX7n/Hb+FvFHbU91Jv4l/rjoG7inufw29kAdtl9ij16Q/Yw93LT9p9ijzfQWXmKPqfFL7JEu4PlK/Q/gPzwMw/Yukv8x/pjw+GO+qdvl+KPAOwEWg2Mfe/NyTCwuQ36+hOPokTL9rivNE01niXXOqcbqBGOwf4g91EfKMcEyff6At5UTpr/q2YzrrBI2Ej4Lr20nFIPkoPbJOINZ0fAWcw5p4ChCTutLLYe411epPhabA9sZ53ItUIXPZfuT5vhb4PxKqgnHWBvnYNmheepygzOeBW8HjXecLZ+lRx4Tlexf62OE5/uaYx3IWWNtR0V9hWv2nblmnyfSejFoDND+dpTQ2DZm+gCwnhbv0TsJiz/8rJuz3ALew2NBd56/xADL1xgg017ilOzZx4/No5vQunar5TNtsM4bHYPsRccAfLaxZPVzYgPow9cy+AGsi+85Hxqto+OZd8F7V+7ZOqT+6aDe3eSBr08Rq4v8nnbR++72EBtENRNwvV40DbY+PLcosTmP6nXE8CYin4FBzgnNM5hGXqb6Iq3FT/0Z06RfgO1K49MRavHQP3mpxRsxPMNKt6jFJ62qTOM/i2vSk3hmNa9FyzrTO4CY54n129OY5zFcoy1Vq/rquCpmRrkdYL9taxQxLedtyb0q+KlqR74jHwDgkK5JNy60TPdezjFG12SeMc3SfofaPOh0zPx9G3U4hAbkjhZodCAf8NxzYeYYf6e+YOYz+jtiQ66dzrW4ye7vtuk1ye9y4nLi5jIv8KL4uylokTF+Cqrvnqf+S31uSaLgPF2BL+1ODaavxTUzyLU6oOGiT58/i9/1Gcj7GCf3YWNiXIZxBMYsHHc6MAtsun2cUR2ts1jkOKPJNqU8rDNXAl8g9WoHeo7ZKddM+OxOqZbrMGqs5o6w4vlnd/ajR9x08fdU3wHjeZyh8mI2zxOh/hF85ixj166ZI65rFu1X8yAL+O8nVGM2XuYpVmzws+I5fpZ/OJtKqPBrpXzZsbipj6J1z/P57w3Gw34kz55xRlWl3gfoRk+8tvqYyu2PHOOnBdlxEdu7S6yrQo+H4nHwdzliTFLc6/jvsFeTIwIgaEwGvJm2nUp6PKAYG2UEn704IxfRR8Nm162FStHb6No0xhhGX35dPy89xpXedWyaR5JnS3nhcW66bkA/trPIMe78RK0UZ0OfO/qVGGZwZdA4fvqaBOdyD+hb8N+RY3FsYd3yFSfzmaU0ntQa5LM72wc+KwdnU2neSOyY8b/fWA9kKVmleZFk06L+gs6a9Q8Dpg8Yd5leiitiDXe7RBu5XjjmwnGiEj7u3EmCDcNQQZ6XMH4g5La0OV7KKOOlnOI1qPsD+eSV82KuC17MjL6X4S8EiquqGmk5byqf9VuaNyVyzGdRhvB8aS3zbGTlvOlGtS2eedME+aTce2ub7hjOsjdm55izhnPJz/kZ9oFnWMjPsBBea/DX0jNMLOIM7S0erZjHKp1vuaSvTJrLzo9Yi/qRy8Y1n9VVg+u3uqqR/qdcVn/BJso6ncOKzflzDussEa8EWAqBnnvPsx6wlKVzHvVMS2d89nrG+695vvKGU7SYC4J/49rK+nkcmzHjxaqcMLduveqbTzKpZ1AM+Oq4p+cQw4CrFYNxIhDvHJiz1Jl4tY7KeLEUV3c8N3XlVsr5sOwSj9KbtegezDIutHr33BrDfuWY8x89slavef46oX+u+J/839nPa/oz68+y2oCaCf7mb7UBL+a1AaNu8NpA5IdlG9eEcm2g7/qgw43++Z0O96QaSpYE/YXDEv4fi5M+pzp8X383SDxero3mQqk2KpLr6NPcxIidPVm3S0brVeV6/MP8aCDuOasYlDfgLLH90BwXucVnwOuaqEE8gXq72Hc/YB9UVAt0IUfsd2vknbV5DT5av+Ydh04EZ2cX+yj/Vn93q/a3+jvnCuvCZ73w6DJfUHnJOZ7x7EN7z52LdfkSb+7ZpnPzI+cD9l+2m8tveXN7ov/Kmzto1ahuwv9b3lxnLf+dM5fVkjTXtGmMWt/SnoGD95Jfz2UNpklEtXA6bZlp3nsHA9bigvMPZM/eIee9gH7SVWAzgRyv9+B4oY2azQ33L+dFuIn4eaFMe/y8UA2/tJcaw6/wdS9hD5DY1vS3vaTPNayrg/P8p/1Tl7/CP+4f8e3+Een+iQ331/0z2Yi/7p+tavyH/bMfwXORhl317/unf/5gGFol+Bq97KGXGfonRuTu09rmc6Zihbka42FDLgxPzSi/JLn3YK0IC5JDLJdKGYu1ZftvSPaVFbcStg4X/Ux+dx2zs1iY5ySmCen8QdwKObZjOFYZ3+9ZkJ+YGspBd6mdNY5b23sK23dQp5IG2pnpdeZP7hnnRnlF9/sMuF7O37SyiC+R2LWOdscmaulkFsz/9yVzq9Dzi2qkzzOb1R3iOMQ6N+psAZdp13djaRM+5+CQ84vEoFYDeSTU24VyZpDr6MQkr78wra0T5Z4peCDWTbfMPcPqDK1st3Rl3vdoXWMxlDnfJblO/aqUNdKucP3jcILXqB5VVZzvKG8xyEz7lJ+MYuKLz9/D56v9NXBK3Ez8rqEeNGbwuWHbMDjvDMnxay6bxegIjM93G3+EdN7AI2ts1lKSn8fk/lce5v7qvUPnWRjVmTSwgF/MqLatSagZfcaxY8/8SwW4CQOIZe5Nbh9Zl/U/z/pzvtj0jYITaW61lYLz+6tfJ3bygFrElF1nBbWKkuEMbZNp1t/dI2r3DMOCvdHWDvrdrugpwy5JxB+/8rAQPyCAXiNyr+h1WueH2uwV1ho4ba65xX0u+a5FYMsVl8SHVeS1H6Y4ExcFtVqQHoa7qVrVN5/j8rMLRFqzjbiO3xf4noTk/rMx7gnQxfInPQ30L5eKMW7yOUqy9iSGblVbMKOLvKZ0DjcpME/EB0Z3oV+/27qpCouONPYq+HyrOLu1p3MRwFsMNQO0s80O8IZi9BZn6YCeOH1GYvu534mfTMLyfj+MKeZSyDgmNRmEbF9L1gC4Uy2SUyeYM3zn40wfI3NesWDduptZptcYB2uQBC+xZk+SERPhlLk40wHZbw+oXz7s+1P7nPaLUJMT/UYP9zmcYz7o20i2zHC8raLnhdjbcSSHvNetxjKfl5a6FZnmbZ4os7qliPaJcyx3GACWHvc3n0cyCv55k3u1+LzJqMo54s5N43Wmi9XgpLf+VdBnItZvKq+zDuts6NH588m2tXlZN8NhPKbOO+5a13E5d+1bzlpDFRhn7cJgnLVwFqjZypcpln/5abH7MmhsQHkkvvlyxNiNj+2/5ZWVXc7ihMmyyuOEFnsfjRPql4f8mldWQuQvBm1x6A1kv/UGqhXcXzmxiQ185495Orr2T1zv4nWWbsbPknEc79i8VjaOlzse25h6wRMZL8T/NEcnLc7f5ug6yHNm9PbC0o0r6yk/ez6zjz7XD2FcK+RcOSwyxjUSXuj1CPpXlr7O+mI+tzRu95dnPOluo49t+Jz9dcjz3XghtafZcP1iT1bUKexJq+mzvbfzNP2NPYV6u9qeYBwZhlCTsUtzCFY8n9vSkPonsB2oh4moi/KCXS/4R850ZrL1gmsOdtm2IXzzp8SXricDXkct8xZQbvXjCvG1RnQr5j9Ni9aOyTVRmyU2EfKau/dDt4Pm4q819OM3nlnko8AZwOGAzQA+eWVBi2qRv/BnNBd5Cbv/gsPPJKvTZnkxxZIZ1wnDwSGeCHH5i88O2gJwhD0WH8B9zHEEscbwAXNa81wYyEMGdSDyGW3+GS7mWXlRn+f33X/2DiDX2uVPbBNZp0qxd0J8f4fj3j2Oe78x3Ptosjx2GJdsd4f1VW8OtfXwO85dHrWhti4XusHxXEJurh84d3P+f1ufxPtHfRKZz9e0n/lWHwgLwe6WFGt+1WSuGdepRK1tTvOtxiSnnCsu2L+aZTgfgjW/olaXsWe2WxWYD1vS9i2061bFZ35zt+L4cpHG9+qiwFHqO64jN6nR9wkbxG3dLPsFt6W6deQFb21TqwqYwPyWueBPzN/zD8yrugrvmVbupbpEHfCvvGc628P1hj/zqrr5KVEeluh4Vmje5DjknqoHOgc+/KxwboU25bEx9hL3r+GCa5ZHzS3iMa+ND1bvI6vE+HVdi10X4gfrfQ973ZMucACf9+/fs9jnefk9bgDvMXm+1gW8x/eec9CC57g6poALuKr3CoNd/j1/i3n+5n+pr/lbu8yvMvr84LOaP/jUj3j/w06JqwxiW9QoNOvXsClh7Rxw/RbF9Y+oFniylmSG6/dqG1xPNadnbPeev84ZSoOoyXuWuBdQJ4rzYxWz5vP667wD4IpkxvGzjVkPuHGNBsGOzz/ZO44ROzxrwe/j0W+1nqzM7814RqVxs+BBbB5DGqM4VVpz4P63xBmUjxNzy/fJMu3SGVF3UKFnqLdpnHlMqyaMz+GD2WdyY98trvn9j+ucd/wHZ0GzPFtbmhFbZBn2sCj/8ZXpKkenlzrwm1hlgXHmD55zvg7dSOQ1S6NPeV/73pHq7CBWivatpYDOeJCzssxxSHxG1GCvzT56N66dmv0fPidiv+z6hkqDP6eP/oY+p21fY1wlb55TPAxyVo8NzkwLoRVyDkVsMKOGBcX/QC9o5kPfSfcy6OF4Dbl6n/vgD6D/5ywTOltzhX2F/Sk9ZJwUEmKZoCgzD5mGXC4zDTtnw7kkcAZ6QrJCnLGm2nUy7XnJ+zrteen6lX6Oz7R3ZD7f7fjsc0I+263oGft+jc91awvWZ/J93mNzbKhrKiON9arUuwY6flJAznv1kRj42evIvOUlHqWXOcXSdbkNOstrVeZFLGRpcjHnUeAJOGeW8tJ3yaHWeit4fr/xTUT9gM+Lqp0645oT8/zJNVeuJ+bjMAlYTH0dh6uA+vTKgfuTA6/TSzLl8W/WuX3XjnwOOxnT9116XZhJ8Os058r3xlho2Ko4b9M6CWjG9bX4D3V6cm0tGzQnoM95WL7iZ8h1pWw/0tnoroS4BfqsRXgGM+jpAyfLdpbFZlh6Lc5u1UZ0pgZirbtw+/6+YwZSzXQOxnNns2sF58iBVxVjomP13uit1Pzyfv+tX+PT/I1/IM/gS5JrNb4HlYXLztNLF/zKgc+ivnnu13K/jfihd/OXj4XNPi9RAp4DD/cCq/s9cvu1npwjz8W+U6U8UBX8/nHsBvJf6v8/7rXgn3it//tw76X6/86lMZhzamD93xXf1/8b9vf6f/K2/m/sV8Tmmv58lCwXirCcO1iPKPcFQPN4GkU/5iONH/ORWYb9d7LH7UQx7oIpr+edlOSBzRd+HfdkwOsy+amPtxdzFnNi/9mqU4w25XIz91+s/yx1aM+v5jd86D9XZsX8QN0cgj7eOpGpbQTMFzdk/qyu4yje5H/Zn92lwPdn/2jzmHQeyKX9Gczb5f0Z2BHZL42TA7z1lei2IXt5STtl/4Jfw34SzD9I8NnLbvHZsdsgNnPeTo3aCDjNYPbk2sLe6Queb2YcPq/U7vwN1cb6+mB1mLSID73RjcWUJH65BHIHsIlhMD0BD6RhwL3nNfo7B2a/hCW1nYnW0y+vcaNXQ27MvA81wff9C9sLFE8fkb/fM8Rets6sz0BsPyB2WC/xpK5rMbG/T8qh9az5fx2hVkX2xSfby2/5V/O7hPP54b3uhmZOQlCoaRK7WVKeNYXyqS7s7UtNffGZwT1EDeTUZXvQvVcr5yFwnNFjSFEuuf6KI1q/zBKXZ/+f813PWS7grroLJEdqa+n9QXXiV3hdehN1g8r5GXKCmaL8p1l94BzckBjocY0js8D4z7dYJy7zATQWzOch9tA+hPy1zpBiaPb7/Hk+Qv5f8MB9i82esc9klHO/KzVYHW06rZRiHx6rYo1Q6NPXLNfJ51ooYsuCk31mXDJj2BSWi0ggz2wg9a19cZ4PMlbbWJQ4Bogt3Ph+bf06Qx8cn/reG8YxcGqVZ+jZrBH2E6PZRv6LT1CCO/cJakMr5iA3dsknbFbN1zPbndD+zuWSQ/7V+2W2SAMeC21yuQRGvjXCqTxC/BvwWwTrJOusDB5j65dd69ucP8NTlGLrch3QWSsF1+fLbL87tyEf4HP9O/I9SZ3N9O9UgdWMI/Bj0tAx38706+btdaY/0Ruh/K8z/SO7RWf6p3Fk3A4vM/0P4MTPq8gH4kMtw2K1jBf9PvK6Mbx/H1Lc/V3v2lpcKeH1YMY/fJkVJ3nl5hDBDD5i2+AMSuX/bXZ/wK7/7ex+r94vz+6LF4q1Q+28SlRds9l9acw4bL39HXzRSWOz+13bn/lp20SdukeL7bkXXAj0r6c98W/9a2vN69KyU3DpVtn7WF26dclf+tcG9K+l3QKkwDJvLvwZf/79/PK7jT+eX53351ednl8GXZt355fbYdf55vwSsv5/Ob/c2hVnBXr5v5xfMJOhN1r+6/lVzlPWNeB21daN4Cq/YM39b9yacb6G+HF2PAe2Z46DjmBoPzloXs4vS/lg59cR9mydx+9nHt8ui35xTmfZIFfKJMnHWtF/eU80YLyF5xLH4GDzJz9c5nrpieXYlp8Z2v3M7c7B9QYepXrztzNjMGc8ycQnGfj6P/Zd0jWvgYye31Nj72P2Pbt8m4MC/Bz2XTbqCWoo5HPs1U+8jv0/xeur13i9tWU1U2+JNnd13bfxulc/v8br48/V/6t4PfvHeD0txeuCaJXi9dAQyvH6yPugZ4hQb7F4/VgHvGgioR8px+u7aeP3eD3erv6WT/fMT342zw+85hVNV3npbHZ6wku87kC8XiM+wfHf99vU7FCHmuj/EL9vul9/9H93yoPy3f8ZUKgZJ8bqV//ndc6/+r9aBlQD/+z//NoH2GK7F/6z/+u3rLL/A98WMt6FMY8X98VM5rroJ7s8lrzQ2OxjzusDDsx3bClnRB24EN/Uacr5+hx4NdCfSS8a1/iesIQL3a+K+YlOxmuBzTqrJU67TLtj94q7JL6gDzVMrGV1Kacr/Tvlev3G2TXzD9cBfWafMV0Hfi9wb8O3Oo9wDyzuPt2+1TXez9nmknw6cfv28HmBfR8UXs9BMZbydZavf5gqzJ9s+ezdwH/qUAsy48ePZItxQb/BUhS+/9B+ibNfeQSevp+cI8V1JuMljz+sJeVzvjeqTIulivOvgPOpN2SuwSsNoiPrreaS2TnSvlEx71/5Pu/v14t5//WK4171UVae99c+y/P+8iQKUM/jT/v/wc4C5C9Sa6m+g+/5Z/4ebZKIGnzHQX2IOkm+yHOo9AKb1UdloQ3Xyvhyekv8fXkG9cxnUK1cwPlxch1dch4dtmO0MdAhjPd+wVW/4NyT/2kvyj2/yC0OXCshDjlnk72/hZx32C5xENvH6/Pv5Aykc061L1et7S7tNJ0MPkTkZGmHnU2edxaPHc45DGEW4WtnTOabPnl9opKfl48b+dn6ygKRXUvfrWPt2BChwI1rpLr7I86ydlKZc5aj75ldtxY2WytagvMMSTXPK0r/hpxewyLHjRn/iujbqsz8BPU5FovTuN0/dWOu1L5WdZ/ZV1xb2gwbNCC5jU3v35nRP2ezuMlnVEGjJljLdyHF5zSLaS8K4zfGkVP2CXmBz0AOPbr3o11HULbxufhOfblnWKDJ+QXTymvSJM8cH6bVXbVKnoOMzyHz+XPYPmB+2K49llCbwhniiOSboTDZiX3srYlWl9nraHHwqb3C3APaq+fD+0i+OTrj/LA2iQ74eojL16B/FzdCja4LzOwsZaqnSLVLXYZHm8rYcz1+hq/x2NCmc9skj8vpzHGEWgT5LquCDSnBHtd7KrfPFS2MakJofpF9cU9JLq2/zatP3lxT5PKzb4q2WuZnLZ4/7ANXoX5T0S3652jMfCediTxurcDEmvjY35R9JvKZdalWzueS14sVD3ii0SfLWP/GuPDlbDt/q0U/bQBsf43+DvL7FGyCzSwCf0qTYp9rB7DLcVKZEJu7IXKoKylP3MEGfMMttIr4ctixaD7b8AS/3rmA7ldsn8q1rSPEiP+3Y8v0H2JL4Pwk64N8ny6tV1nIG8o0+SStbzIOGTrzeLBorWJeTWmcufBhn0iq1aHrafnE9j6h7jNcy+W6D+OW8ej5Mgrib+fLDz6ZQ93i+3/mcxywcUnK58v0I3/BJeh0VkgA8bznLDf9U4IJe+RU+S/zE4L8+ef5CbrfvuO/BWrf3Z7FcQpdElu2RFZP/MgpjkE7GLymNfB/jT/nwUcJXyD2vS7yZjg2xSS8j1nrr++hGHIz/HUGYwXfL01qIZ81+Q/z32pLh7Vydx/56+z3MeF+npzfr+eGLmLf+t/8hHjQ/sFPDLN+Zv/mI2yfc5NMTuEPH7H833xE9uojFiLj6w3huY+TZBy+9REKzACWfYQ+kv9/8RHZv/qIZdlHJPdt2Ud0172yj2jXWD3Tm0XUR8w7aFtKKH33EdqH8LuPGN53f/MRYU/mMajo8zOgr4RlHzGU0tcYdJWqlCOvcTqHRewipzKdw6Q2q2ZjLy/482hN8sDxG8RW1zx3qIs/8Ct09l0ynS3v3frC/1l89yO2q/49rtMX7SLf6NlYdzGXWJcWM7bPejQmQvwF1E4MleFVeP701KqhvXpJveyKuTZP5Fp1HZDpw9hRc3P6pyBCbFJo6DYWMj/HfVFj2ibkObJ9StaM9296EuctfsZjuAcD+ULyFWIX/WhLYpJPBepIa9Yv1EWGV5nTmkQD85qCb6FaCbuLl3oG+e4Dr6Oxeoa13PKc9bYX+dlTX5TxAQuqL/HsNSxulK9kos1/wQW8xtSdRc55YM6oSEXnqO32B8014Hm3DHiO6uYO13MguUjloSWKpNqdKtatKn3g6aB8O3URrk8VVzrOGJNkSlmbyAc+cOs5xPC5XeltbDpzrCzmoF843MqzTKmJlF8FDZ/zMNfPlRtqVhi0t9I7fOuttBjPTUbyTYwLH6j5lCiVpEquPdct+FyaU4nTbn8xlY8T4it6v67R+HCbk+sDXAnk8jTPSltHXA+yX3t91APB2RAke4KZdpqHIBalf1pSXnmb5Jf9DuW2KGqjcx7fXwq87XPOp05rmd782c8LqzvKTTF45vfzSqkm0X7+fVvK+w8S45dYjOyJV2ngM/0snumXSnIDE2LswfkGz3gEzziHvWtNyM/HAfnZ/xpHGH/Ra3EbVc49Vs7JnBPMOShML24SRTPEOzvQoyrHO11nTWfd/rF+5nX3f6yfifLb+lmMtZjIX8i/9g9GJ/vX/oGv/pf6mVPbQP0s1LN/7n9/Sna5foacijwXzV7rXPlzjqJe0kRs8fPn4L7Uv9Rso7O6p8Cwk2k8nIGP3ZKzsD4PJUVf8TjEgvcdeDxE6z3o//F7KE6FnQf8Z+Lr9iuY9b7Q86e6Ls2T3eq1W3DwRqA5906LLA4Uw9pFZrLYNcj+M6azfj61j3KgKMht2vNCptFkTzkv4KpU05rj3xEbx3zY0qbnD2iKlXRdJ03cf3FdCCmWjHI3ZFgrCUmqy+155lHuL16fw1gqfMZS+HPOfz5TzilxjvzGnRvkKcTfSPp5o0Ds0Fz5FPs/9ydrYZ7T3Bpr2Qe13tHPUDP6yub3vJ+RbAj5t8jrQvq6XRZ46W/z3FfWw2vOCzyavuLn3sArcxY0suxbTj22LapJ5f6x99wi8VZtU/egd1X0q556eg9T1MJ7HX1rfq+koZkf3ek3TEIubw8O5R4+1l54REiO/pWmd5KnI59LNSWfl4ImYhx6FPtLtQpBc0xL71VNMDtyxc1XIbnIh/ZYuIDb9Aqbcn/RCQQ8PtPMrWIsVTdbKdlTHo+FBH5fNbu4bljHp/6YVWN8mwfO1dvE+vaLzeHfmz78XW2tbRZbYDxhNliscuA856AbPMQeancPNcrXvn34oy58/PrRu2/92ru/FrMJ09mSxbejOeZO8v3tbILRXLzOJoTRPf/Hfv1w/6ItPo2+cesg3/4LVw68L3yZLU+h1/+cp7GAnz/9hZ8/jXDvhBNrshPYjMKkeSvPKFgtgfbUNZhRCGWPzSj4QUj7bZsTcuqaM43PKIziuYtYkP6H/RrvwzxJ0Cywu5IF9gRzK1efcQGvi3kFFvPHHtd+jxWP17j7+0U55h8P5NeY309lHvNPASsmgJ2Sz1zI3OZ4TLx1KRZ161Gu5w7WmhsdD2L9LY2XlWqIs1FtR0DdHAtr2rs28i7v1ID8vYX8gLsv6Fmcw99smerirJaF3U7XICV66twaz7O8Eo08m+Ha/oH/4Xn+5SKcf+tm+1v/aM3jnydnMXIQr+UnXpOcf58/eT6L2DnjeKInb3E+DvewZiQem9N66fwze9ZLXcqrdtzCDGg+6dhd7DUXsyo5voZ8h8DP2F95NsK+x/WGJx2P++VOzS33nuvHV24AD+KJ8W+8ANrIxVgp/zv/BOg/K/PKtjx7AbFBj8+gvMFJZd9wUs4edInitYc1ifP+a6A990XBx4z9VNFDjZ3rtcdzst/XpeZxnvZurVgX0yuvSyM92j/XZfDbuvT1GfFd9l/rPxp89nx3tL9xDx8Y5gTweVST8GpxnHDM+45++MJD98tsJdpoqe8lFbMDxA/ugb823nkUc7YXBqwuIJT5cJmW3IvdNYqZt3MxP5Vkvm7RGvaB6XmyGgT4B+6Pbswf9T3m0yqh53FMhFxzy/7oy/xWp/wj53W0dEPsUf17/a0bIb/bUX5d/wKD32x9wxgWGIr3vcRNkk1rFveznsv4x75O7V/0giLJZVj8xzi64+vJs9783WavLp/R6C5nBf53b5VtNjjk/8FmeyfnP/JXsvWbTw75/731m9d4bTfeu3SfXxon8Te9pYFr8/WLFXw9xqF/Xb+Ky32hupzy9RvujfL6XQ7hf9nzJ/s/r59C9/8h/LZ+/+ALd55G9cbtePucuXIYRslBXNFFl+l+5PNjf9iPG4/50kp0cjkeoac75f1omNnP/aj8ykF/meX/0/mL+edXM/12/n7nRClmYp6zwG8xCQtDMi92MavmttmsmhSUcDwvM8OPlJ79O2KPOb4eeUT+uoa7vczXsO5yn9Zr2i911WX6cw27v66hNAOf9j+sX4PqCpTWr1Ws3y8zbv+GlyBrkmmF5tfHjM/kj03Kq/EQ1kf52e996jjhDGBvVvi7uDNj/q7+1/0aSTPu7/rmhO/XVVrmKxBOB/k/7NfhcoT82veOJsv/GL8ElcW3+OXK++PHX+a2/g03Q2x0oIwLrHoq8JmeeMZ8YK95fqupBrjaeyoU9npzBdZH5jH67/a6TUVur4/iOfZO47K9Dpab/2Kv9RnFifwJf/vt/Fjs9t/93z/0tvA+/7EH3jm0We0cdR1YLel5Nr3HMoSzGccyDGsWte1F/fCcp3K5hgDWOgamhfUcqWnwa/61Zq53Rrxm7glCof8xK+PzbWn+igH0oKaX/Yr/E87/iv/7fn5X99/iz89D+Du+aqMUeoDltXuHbSN7XJ7x/pJ1GvJ9m6dn6oN3V780L/yCqZQGyyHrSRD/XRvStZX+YW1PFl9bN8352g5m5Xkom+lZ/OPa7tMM62DIf6aT69t6sIZz2/PQN9hQt0pjUxAOZoes6+4uy4HaNONdI+u7fN/CPHZY2ZOP6JwNJVCaRr6V9ak90sck/w82tKfZ9ASu77GfQl54p3xGdSGjHKzQdw2grrLA+kFvw/C6vjmC+kFnSrWX1bXkY51lAXo0tVpe0kPPr8kGPhs0bFWXcQ3V5qIUuLRPEDRB0/fi5t95hEIzB53WjfwL10pkJfOGfLv7WGepa5vCL00FjB1GindHnpNnPaYLusHGdJiWNYHV3B5BPZ1xDcL6PczONZKc8FWfXFy3kTJY6i17VM91Qeui4+hiMi3XIerJPflF7xrjF01/6DahpmvR441UzpkpSJY5QBvcOYDDA96bwPaayqLWUJcnBXBNezyDU92juR3Us4E7ZUTsYGmEjbYt9+3K1D92JKNmUhsNkB/98wRz0OsuznxZ/VBxU9WZReTZLdjsirehHGPEX7jk2sfnGdUJupiUUxjtwYb7zqHG5h8Z/+3iMUX+DzcpaRp9PWjtqbbTUGdrYmAeWetcqR2W9NdOxCb72ThNUW8wkPfAU1Wykw6xk9rEDf/P7GSc+oWdfLq0HqassT7+n+2kg9r2ycaRf7ETK9Je7SSZGAz7ng7cV02VNPxN3+s3O2lLXcekdnL/YSfI3/bGfxjGvtYg31MVDpUyTxrVuca5PnJ9i74qzn12vomzbj+HeTQNcDJ2RftgXGtLEusZO/FeJ+sQbKI3/KexKPNZEEsxo01Qs920tYiUL1c4DHejdli9L+w95cXrTSdVdaM2QRfDudGcqSF1R32yhi0nuAsmrHm17WVNyOfzpiQ8huR7a+freQTnI3DAS6OaBr3nXHDvnfQxXAbq51BGzT7k0TF2gdI5b5Sp3dFhn4uVJHPo92+QZ85fXFTRm8OyODPkpcshnjMgtnP1LfHZQV7/Ob/qkRyx6UIMt1RIvMzPvFG86VgQc5E1rQZ6jdixg3s03l3MuAG8MPvRdRwdHYrJH4FNQD30cu6aSpfkVsR2Z0btIjDe9w72CaCHBbqiC4PYQVPqi31+DiXMvmEOBzngjVSRsCkFPuIOPSCGwbj0+JmH64bTlrBvVybySFSiOfi/ztlSVHE6pxjac9scJwcHnw3Fj5p4jQs7suRJZLTpXhXsFDBWbTdRRBtqOLnRHYcrh/bpNVMFnkWdnEmaTmIBl5yTpgc8fTXyOsAMyKEPzx71Y+T0wLnBJdct9H8dGqt2eifrWUdCrHpEebCFBWAsw1JcXuwNGrP9+P0po58/WgckR50g9wTYz2mBe6S9o57l1f8+Y/aHKQnIo0hsdNk3ZF3YEPsc0LU8OSyWI//VJeNjwvg5FGIPdP5Hg+/u1+8w5zqk2mPx1y2r4e8fQwP4OgPK1YI9HshFujbZl8cm8eORAj5NDg1JrjE+EMohNoiRR83sVGC+BK4hTaT6Dfp//R7tHebYE7yXOCTkHf4deeO1jUE52CO8npVG+VK7ArPTC3CeNWzOowGxMeBpNZ1yHyzW7Fp268y1aR2uU4kd3HPGRQe7loVSnM/3GHJV/vy9NPc05B4k3ykNZnc6c7CwJarX/Op/XvwfPKdja+Zfamw9bLgGiEuGaX24jDAPAW1EZTrqn2Z+rW3KujXe6nXLrZu7SBnG3tfBIPFXYDN9qFTfLUC/oeHbxHf1rF1F4jjn9pbEXxSD1ZNaG9BzUCuyKavNSR/2W6FJsutn/aZN+zXXa/779Xs0597mBuP5H84Qs3EYdZEzMzb3U8ZtB2f9WvApx+RZN0XhJT9P5sCHWatdIU/5oufPIqW1xEuQVPAzBHJPhi5qoxw4UCck/TXiZcMGLgfg6ZQmMG+bNyt5ZZPbCfER7kKTKX+kRvYQOdrNW146U4a3EqclOfthdmK3ofxzskK5Y9dcV/tcJ364Qr5nX8HvqZudvKL3ZMit0qhBzg7njjolMtPTaEijTpd8BsnB7NL5kzdPNq6J4P84i5Y1RxNay7s8CdvtMbnGYdwgz3fS9kSRcZO6x+pdrsiXkGrytoh/uTiUb01JcTYeNQCq93kNtCWi0UX42O5NNWeYdtjrE60K5xHtxUULG/PPeg3521tZJDONAI3xnra+gIPd6dIem8A502tMH0eVhu0KzZldmLV44Ql9kGe8Re2PEOzYIHacTdWjqIpLTaX8IFtpIOBMerKuhVQXWMfvuouUY385y+i5XfQ5TeDLo3ow/LrBz4KWQcOFuaOapGT4maXec3T7yjDeUhKqwRL4xOe3GiK1n2PVCoz7YxvrNuah5z6xGxm44yOXc/4J45TWWGpqE2tdo0+X8uqNv+jzqQl0FryWEvvYxvUJ761oJ8oN2qL3RNa3s2J63Osp4C1qP54B7IGeQHXuQBfRN0SF91CrlXBp09pvMKb8oCN63ZeOPY5X7O8jm/xbwq7/JZb09+TfbHKmk1h0VeM2ewQ9IQs0slI4K+tmZRz1qznT8BgGlKtU9NjrL5cB9Grd0rMbO4zDtNG5M+z7OkVcq9IDXOv1O6412tm0VqhOLWRhwXPmLgBZOMUd513cV9R3WIFq9Pao4VTSuIlJzKJijcqdUh5cd2QAx7CIe/VhbqCnujiL8H63D1q/Xvn9MJ+uzsm63nZqhfIbVklsif2gUTSn64ccj4fOeYm+7rDn+6MplHm21lk76YM9qlQ/oy0HOrGdu7ukumsT1OIZbVYjZvMy9Yncjp+a5+1tsp3k9DxwiH3vuR2KNYO+5+iDxq5PXrtpREa02Zu35z0dA/VixI766aQkP15/0ufiuAnb7x2f6lvfXMh/1vkLr3wd1r0HNYJan+ob7YdbwAzMm5/rQ6exBo09G3i8dfPm6r530M8BzrzuhyuyV/35SFjNO9cN1Ar9scw4nxPKQ/cY3hy1ytd5lrB5e9AZ231xDlzdpvjfJeXHHGfsM77YrL8Y4Hd6i81hD/+eM70cwZ+b+IxaJP4NW3Tenz7DNtPoJDGclUuUu3NpJEu+J7Fu1pNGbeB0UVDva7er6us61F906LXvra58Y5+lNheKYelQw0sTtOGDWkf+03iYM56FRiU+ZuzMpXxnYoXtj9qN5aEO+O1xdAISvFtI7Z/7WfKeriSfK4AFMV4xIjtJPVMe2JZg0DOKxPP9GmDnZHY9TCM0HkZTZjs+v9cD8z/x6MbsO1lyWyQ+WYUAgMa4j0RgMVLkTzDOPtRQPyav1Il/r2x6+gP5AMnrkxXVoYbrmw6zp01dQ6WCfuRK34vcP9cBO2PxmqzgAvW4VoL2OZEhBo9sPNs++5VoObGpLnuP2u2I/jxRDWKrlTqJ9ZUMdTATe5FfqW+05AfwRwjsvi5tGfxAw1Zt4CWVLeIPtlTvK6c8ijxGkRSjQ2PWXdZNON4cajBhNGY6bXjGj0PGmSrYT82vuoefWQnnY5hT94/asx9wreG/CXPAWHskX9E7YcWl8YpzAPcH82Dq46Bv8LraJ+Z/8FrIGUR5aKk2D9nz5L71HHXNuCb6T59CfIdNX0/28yfwY0tm1uY8i1XkKSGfyf1Lq/AvEMefxsYkAn7mPI0rxdlOvseAOcHW53HihhO7fSLXkpI8oVWh3yMEVLvnMGI2aHI/Gq9rzEaYDyI2eGHn6NLFuGb4OWX3DBycKtT4eshZ/zll99Hiz/Rao/aQNCM6096LA5VklJV6xZgcZTdVdw6Jp0YucHxAbmOOF4KvivXdk4OHnONTGkN525x9/2/fE3/y7wnHhuIYx9CUNREwfBvU0QOuatS3+FzNl2/qD5hrPMZ5eX+SGJetDT7P1azCvpvZotAqx0fgMxYtWvfUN2EH6p49gcSh48MdsL+OPwMtpwuJzGEuUKOaYpDH6cIk5ZpN1ayh0n5mRO/VzLe+DtdE9Z1ydYM58S6LUgGxazeX2+E6Iwk54EkDxD2TPcn2tNkeUj1Wsi736WgSE/shcWlqeuRsJ/FI/yUHb7psbVPIt4d7h625Z5Oc+6g0Q28kNzYi2InNtQKuyXCG/vTS12AGg8TCm9zHdb3xXMPd2NL22IZr5f5IGgzJKaOe7tTWR5PZqs3OmSr4EUnLXDqP0/i8hOU5m2HWUlMaBxT7g+511G3Ql9G67+1fuTZhRlrIpPH5E14fMp0hue+Ez3uJR0e+H4JWNhDQ7tg+6FAdB7LOBzen9ezVoE9tgN5PiTO1Dj6ly9f/GjfAP2EO6T71wlZfUDe91MF2zp+0Fq0753Y5BpF6wQjWiM6Z/3IudO8WXaf5/sq4S3cwrw3amkN4/89rhPeBlgLksZImU37XviNNud2Q2NYSsUbE18RK1h7/zh3mLCNziOdRSyjOaqknNOn5Qb9Pba0N8kzq/vxeW9rf+U+9whbQbyvrOteAWKTITcb3QaF/KeX3Z1yr4fcbwBTG4qsTeZZM8yqu2F6krw96DHFlYR/GcYUx8jhKBzgfMaY62jnZ44OQ5tpf80bE4jFuF8wXFP6c7BODXfdd0mWR+22KwqzUI74v11TLMWY6dE//WtgV2tQ8pZja2/QZgwUzygFwwzVoQ15g3A7eFWOpuU3srH4ZFHod5XXdZf2b+3797oDVX+yulFPEm1J/w+yqmu01qsFQjq+dQycJFiOYT+xo7NwguQjJkZJs0z2+xNWqSDn4QS81FynPIvNR5LkxLb7CBq8er0nUt9FmhHE1eQ4mnYe4ZNzeDgE+I5HrEP6yD3pLk9qjGxY2ZWgNFs+U7fGwro8As51ivsjXKCD5WAkXLXU/BXzWosvORuaHK+cV7FmptaF71rObL7nyQBmweNF+5mSIob+AzQGGPpBrOGN3AQ3p8cGkfQD/zPRCwOe1LywWnc3AT8SyJpc15mOT+6rnGVQPmL2ajWu8mdKaQc3gNlKJG6M3saJ/6NTWB+frz7FiFLZzqs054LED8+23ScIikPa7mkWtwvK9DtQsBkINY3zQgCH7fJogZtzsZzNiO7bB+N5aoIFi32GGXTeE7X6ULDbKTD02VdH3mObPl6YVMfQgdmctA37eJfScdqLS87Br+Hy4PiBq+4yy1fyebtJYWs5ZGWN8en1m48g0q2UfoQgz0Ap1KD8X8LuNQSdWyyfvY7yiv/mM9Tb9bDhzsXf1ok/Tt+tFHFo5C/DcDcqXNdL9vPFiX6OIatd+ucso/KZzMz6TGPhcUzJ4rxB1QPcmrOgzxi296IJW9GJN4toAZ0UmFR1rdHlFjhD3H+v1vDLe4etd0IoZfmL+Xf3cHFZ2UZseC3emBWFW2wHGhPMvm2Hi4uFly55DcxGyWs6J3J9ep7YwTAL8zGowS8h/ajUgezAgzzIg8UbgqNnipqJfuauUZ0Z3DwrHosgz2tep5BXtYb/rHy1roXsd7iZiWL27B9DvkRZf6EOLOXIB6oMk/gp16HmaqjCrSn0ROOROtSp+9yjItTvwDlZsA+qaZryTzHuLxlKSluYsFzkdJlhbGG7uoHvk36vsNcA/Jo22asFjJy6wrkViK18K1A65nu/13jrXiI+DY/bB+aEqRxNiOnu37smuMHG2S/QdlS+Kjc0FfGZ6VqU5A62XVDPjy2I5Yri2KB5Sv/Xzp444YGfSWLnLqKv6Wldn2ulT1aA68zvisklMW1NRS334pv4cSDaejRy/9Ox/7EegxTMn/zVIvtcYw9z6Q81sgZ5RPci3js4A+p36kM0eBG4Nvu9BcfrD0exAOfI3rBastx9M58OKZyarCSyrjBON/NwEzIQxF1g/wLceOFu46wgmibdtAeqfcjYzUhF5dO5zg+vPQM+nCz0fqNtv91ML5jKJzcD83Zv+ndIyCs302vYFdxqbAejSVEV113BAv9mIXdA7gdmVeAQYBzhf7Xp0Wvecx3R42vO5MOmanA30JaPOA/b6impBBRqc3/XbmZ0Nsgr48+ST4q7PXtUwCi7/ZFEPoX5/LuMstsnYYrHowH0Ad9PngKxHf9vrgu0nlGdkNNrMH6w2dR1hrFDrnMdRx8E627lzyxCX2i73huN7/UK1wvbBAfYkD8s02JObSbTQurR+EVnGVmF6W6DjZl/Qp0/77emko6dqfw29zAPOMla6VKdMM17zVqZ/U2irH/a0dnYp8HMUZyLUhmuD+tGlj5y7kkv54jvAMbOEWI5ryl1GoNvi+GqW3FqoxXtnvWTpKLAZ6XiA56B6DXit+Oaxa5Ho+UJioBHVMsbxJ/xfDn6Y7NEV+ti0BX5YFcmhjnnrpd14qFV9tezw+hfOyKLGMdRd5yHrk1dJTOuuFs55+VpHP5L9cGb+mGI4oIbmzUOpZ11p3SygftQb0RpKfR46oFvfXNCZvuZM6Vq6YOYMz7Ohc4uINRsbOe4rAfvTcjCdnTqwPnWGP6Kz410L7YRiHpbEtjFvHu0q5bj5aZPkTFzw+kf9cwc+epTdeBzNckLQwoFrzci+FEEHLUYu4Adgm4YzXzGsTRN0jWrdFK/hMgRsyQPOiSXOpDldoahTkH/34N+JH+3DnNv2xvLO+ePO5r9qFs69yMjXOvihTSPeuP7Rndgu7eElfVuhz5ns69wY70Pq4xnOwIDnop6OE3o/iyXVDmzFdM5d8Tsix2+OhYUdzAB/E4GWlfHUsqqxHqKF5xeewd3+Ee/DTScO+bxNjH5dJ2unRzBzVLnepUl2+Y7/pv7rMNw5SRY/KIfpjiQBVpfiVnczNdtO2e9nEN+zv7tqtuSvd5NsAdc/bNolDkay5sTPLs5XNn+D/h98enMlgo9qD0FHLzApLuLn+WHEu3CiyaAdHgR5k75/sRm94gfJfrZWlJdCX3+osLYNl5yTPajqvOqvJDN3+Un9pJejbuKhY+fyG/w38Xd270b93aILWpXSsgbn9i/4jdisyG3y2Nv2LALN1TZoMfThWkvfj9dvbbrkbLMHYb8dyn1bi/NdNdcb6s/7n8PrNtW2iNgpzQW9nrQxtYJ+j/aHctlfTAM7InkV+XOS3XMj6hvks1K4/sXhSq9/LuH123+4fq9xGoHveMUPzoATpEJsdEL83ehI61Dbu0LP0Vrj1HzkCl3n5fv++X4EeBUj/iKx/Yz8iXjdvQq9lQB15Cy7el9IW5thdoYs3wmgd98kdvHy/F7jB5zthDruuTLzz5Wpn1bIZynss+D8zre0vky+72Ai/rpxJnHHZauRn3eRmvmPAns5GVIMaP5y1r95fszvjKHnOLvLT/sE3/f2/gFbR+4/X5J16Jixva7qszvlahUsY+rvEe9p34kfaYg2/KyNk2RAseQ5xCuwz/n+iXZLweiH5DrOkymr41Ex6zB6pIkjzfokht+tehvZfIzP7pWex5+qr1R7siLU1uhjqzKzO3z+/qK+lT904RiG5PNrJvl9uF3j67DOfdf7UOcfETvbbj97zj1UFpsJ/CnD9TQm1fFU7tfBPmHNwP6UOcQP8l04j17iP7em0LWwA3IehXQOdWwzvtGI25ZKrerd818iHoPcP9RPaw7q2fSrNeL/tzlgeJbwnH1ct+3xMkAtu2/xZ4pxGrXtNDbHgAcLI7BHYp8X0Ns0yfOwyPPwiQ9v9WCGZVdrUO02PE/Zn9Xs3KXaU3WKCaKxcu0H/gLi3Tq77gq5bvJn2oJ5thvq3eAM23C4OjVKWGOwBwNyX1h7em/O898QZ7FXNfC/Ebn2huVP4VrHUXdQYODEj5d1/XZ2fItfcb+3SYxTJWs5IWsymTXZPQd4LepdVkGnRkkpZgpt1oXruKg9eh3wsy+N7BO9D+Ul5v4V/0bsL+gqoumS+A7qVqifUsVYwNicSL6fkrwradSjo9zdJJ/6kNYXpLwu7x6yHIzmWFPb5Va/2lbY+oP/DAdRYIoDg3z+9E78ZP9AX4cxjePkxCeQ8/UubHyqiQj2PSSRt0ztm3w22Hftm31/O3/0M0j5qP1pXv+Gv/bQ/yF2DrXTH4x75hpVBzbPLY49aZAD5xrxeTXIs3bF+wGnC/uF+pDic+5wHo8ja8D8Jp29PXZJnJLS2BjXPEAf+gN/tsTrCit3A3woiatrGdT7x/HBxFmXywVn4BfpldpOK6tOad2xA3Uk0AC+hpGJs6vHmmRYB/qdzvM7a+z8zjvQf8ZrsNn3x3nF7FpLsmDkOdVXNrW/3nBmd82uXsafzofK17lH4lC57P+mFgPs4mvbP+xXIHY7AtuFPvXWv9B7WGermN9Dwedh5jAnIuNZgzi+7cNCXvYi/sDrT3o2SUbIc6ffz7CW3ZfvP5DrV4wuv196/2SPkufVtSbEbozX94df0Kvrcv8Ldp8ehp5NuT1Ae3i8iQRFCM1HejDh9+NNONkD/t7GXPx7/DHUhcMwgPfvdMMIdKGbJg0hDSPAFcLvo82evJd8hkasHNZTfH2/KvDvX5L4uWnGC5dce5/k4KmtNh0ZrvWd/gp/vyKkpmMrZfsl6xeYhuu+Pj/j3J/OdP31+cH3k+t102SG/GgR8xU//T++f7Ij/tTTZeC14Nf1M/6gWCfD7VMbKtZfJzF6g+TiupL/+f1hA7os7DUMP09sXiG+HM4t6JWMyf4zF9t908jhnKm8xq95YHQ6CluD0fP6VW7XY/u7/VYgx7zGnz3av+xT7u9wj3jtWfObP13Z+HmQM5N8Ld4YxuOGGP1PGtdhnARnTm/am4hTqy8aWqjAPub4cbVLuVgRS0n2Aju/h0pwwH0dbRRBLq5d6GhdissarQ5dzJ27FI+urOfw+vLzR/uXVItie+ka/GI/sH9IPJYzXgn4nPpv5/8TPwvr9YB5FjqX8KDnEOxrEge5eVNcCGG5Zm2TexfsiqHQuqYqTprWeKtYqlANpZz42M3dghhxNju2Z3Zn3KQ6d2sb40yhc5Bo/XW0tY9w7w2sr32MRmM3/M49v43tp055hfpLB311zRChHjMOcE+qArEn8lxkIVRyrW7uoB7r7zVTST4V4sfM9QVq1aNkYaeG9hitHooMOPRADQaJPeswvKIiaWnzHlamOfmzATbrz5TAMc18u1EZJvpK/pMky00QtydY1NjH5xTubffBNLC27QPc2/jWKum+P8wKar8ne4PzcpiblNZflbexRffPzw/jL3x2JBev3v7b82O9z399flO4vz2/v4DeXwo5MTy73s9nN5xapWeXuAbWsOC5JYo06xjyBuIpFTDiYTV988wWDnDjm8kiJ88sHm0eitI5+0rQ3ZNn5lSm6pH4pKE8nR03sG8jS691BUFB/fprbOH3WYFKF079fP5bdDf4DGR/k7D1L2GKsR6we4v/reQZ8V1XrLn6xzZg+ehZj3Psa4PGjEesUQzvZ4ozd5Q4oLX8IDbYbFdn8XD79XuuC3NyZk2uoWYgZ/aZ2Nf+IsAMTi8C3wu1ougFY64ZMcOgisW/2SRvlkOsLal3ResqdG6MXctV0qhO6UBroLbMGTQO0n69lrcdmfw3vStKON4ojhFBv+cdHhxx+cMz1Tkmf/+M7b/MX/TJ9e82k0sqhtPNTqP51XHW1I4NEqePgpwsKNTcSXybb8MesVvtnhI7lCa5Ko72tIZXawCuMwANv61JzuVbJjks/hOSaq7lkUjWnqQSoDUt0lnEc0Li/Y4Amn6pEDUB35kSmwuXbCbjbJFlnWRVbRLesUZvxFDT9C/VAeD6ATe1G5FrsjSSW5whb9kpwOdW37PapCmOQ7Ff8DIYEZsvJ/81yXs/M1/B2VyzuQ3DPs6WHHXKx+KGz5ofcGqABlVE1sEjsUnQ6bnE/0D9OFC+zDRvtvKKtaxi72rN8i9zvHEn4X6CtdHxtkP2KvAO3gdUW/oyscieq2hHRZQdE/ZY4thLwGJqxKcJMvFt5HM7gjzZk/gxGkGNL1TqxH5kVyM5uGKNdwGcgz34rDF8lks+y/bIZ+3JvZmgBUXuRdA09wB41dF4oyuwDx1j1lPFRYp1OrnvkIMQZnVNDfil3NSGnEd2oW9yNOE18W5v3NvYH69OR5OQ2PFNSZPqQ0sjZ9IpcC+PvrwAXQ6N5HfOA2fyxPd+cnn4K36/chdh76qt5djQjv07zY9MoeKYHZIXYj902j9gDQPxPPHQIes0kytJW66oS+SJPIwC6HMscH/FEBtIk3TDeiQGyZ2gDk/y4IYNczpXOkv/aQj4XM1qe8nsHtYyA7sf5VCTH+lg+3dVtHzKmbnvAM/u7gF+YJMjD5fVT4DXc6hArpr7XbKPTrxmv1WzqSJwrpUHs89jcWb15TXGP9tFZuHrAGOPr9XRRo2L/kDuF6wNi2Qd9uBjd86e2JyHdrZ5LInNtSdJb4f1kF7O5r9nR10VTSRanKmAOyX7T65YU+C7JzHx7Av6fBE5+2RtaveJ7Qtuj+QNJB03x4E8Sc9mYXe2MZsH9smQg3SiycS27uQ+1GPDJufxPYXPAr+yN3F+ye6biLex+rHiPkaKopthWw7J2aXYNpzjUw36tE2sE8O5R+yc/Dd1gN9Yp7Zp69hvfEBtXAQc4I7VgpIZnFWtHPoGEYk/Z1Vbo7MP5GfiuUmMRfxmVdikUO/afptzUvPL4ff6S3l+qX8+0LNYF45kr/pHC/t66t7R+u4SewX9NnC6ntbYRyJn4zS4wc8+468ndgVaK4uMxhXYn9GnGn3GlcTrMNwG+CGpZ68ZHoLYaD0DLC3YadYXTbBFEtMPte25Z5G0g/hLG3lHSU4fKPD6udgWwsnNOhmJO6xKXznlzzQu3kfve/2Xzm9UUf8gbdbkyqiOsenHUBnrGBM3if0F6+RrKlfaxPZG7gRqFTBziT2SEGdkU5K/kWvyVuA3M3JvlynMUY80ODeIPRnkUCLnzw5mHOq5AnVAZWJSzTlyprShZukuoAbUbkcwc3fOYJaC4+za42TX4zyGFtvHwI97X7SoXsteP8AZs2GzVI26IQ3OGzbXCz1RcvbUoYf/IY1dn86ELrKTA3XFSn36IHFie8j9HPgLh+ReDskLFZwTYX4msEZQc5yT11zJf4cp1FuUL1wb0BMQSd7a3ejkucHeh7PuUnuM9xi7Xmd0Zm0QwFxfCs8OXyM9Tj/q9+ONJHJ+EWezpHtOTiBuFHIB+qqtajA1DdovW5LXN2u1KsSWs6m0Qsz2T/5zY1KvNuw+tY3Wp7Les9+TayR7SJSXJN5jNSmc8cJ1gJj9BM/Xsy7w2qEF/Qf2XGdGCs91uINe4oI+V/uLPEuh7pN82sI+8Eg2mP80ZyPZnk46qkbs7usof3Bb9tbyJNreKO9tcKex9mbq/9YHoj3p1/l/jGd6EeKHjkw3ynGwfmR3dtCXqtVCyl0+7+VsnhZnPKxixoP1ikfzrmJce3ri172vTX0fQ62axFzian4/Bf2U5BI1qP9lkuwvsW9HfNTe9fPpMPryG+Z+OW9Oly7xPUlEPmd02xyc0/qwu8Hn2OPYBy5r2496U6gfb9PszWy1Mh2GznO2mnzWHnLLpi/1rCX2NbVliLXPyV5is5KIjzWUM+Uun1U2rLdn9KHHaNwEEqQUHI4NAetbd7avRPCPq1I/4A/zuzjPOQZ+z0qk92SGXQNsD8Wstg8cv+WAbleYdyZ0/ameaFTvheX114r1l+msyWjbpfz/SzrfROKBfcXQ+j0nDpXq3dWWOa/73lsMY4L37t8zlrMP1qyn9dXnuj6DM1DQ3qskzxnafAZCqD1iiiee+GP2nrkPZ6002lzws++LjOsQAU4FcaP93OP9asByze4pn0mo6uzaqnevsqSYVL3/wNn1SpHgGYrZ3ayz425C+7Ae0/Xe+BTjMbF9joe76orupjXTrY2I70+7xMYmM46VILmqTXznVd/wfjjUykkc+TA3UYJz8DC3LY3EJV5vAHPwtljUVWpv+DOgjrJu3jYx+w6xrgYHcoaBttDRqIW76/i4AzzGncQpW8DfaHPKzW0GQQTnQljmGJAox4Bx1XR/IXhTN+1Mpa8OxGZQx/cyEqtF18XUoDw+Brk/b7YfkRRFmbjXM8k99zXgkIWz5aqbfceDjaKeab89Ft2ao8w0b+dpOvIAgf7umfnR0kxVSLn5SI607lYd2APjeKCDfvxdIa9HPmCL4iYuHfJ9wwC0+HaNbBYh93J1HCsK8Qv7zdFE3OpEIb839sEdMEJ+E/dw/DWfUB2p2uU+juc6nc2YQ++H/DefAd+Eorl8luPkUBylQv7hdT4QfUBvOmwXc4bCODloeXG9J2elZq1dn9rPqim82I9mUy7RzVapiI8AsQYCWRuwHxpDErt5ap9qJG6zY7jfr2wShZgXVSHH1LBW/+IT/hC/o/24gIFYRRh7Q3z80A7VEh6GrFFdg1lNsh8pp87XIqMzXcAzm9HfbXbZIfI5xms42koj/vuNQn9P/LisMz8C8wWtXmnO3SU+YL6lnCuOJ8P3WbtqNpieOf7FvF/Ds8ZmRmG/Ii+WfwwAvyvUKUfJIgDclEDOprZC+/yReas+MZ+zbl9kc5mAP9AoxkWIWsitQOweMA+LOui2Xa7jc/im/46zlAvUiclbwTKcRIA7Q9u1uO2Se1zoqAkMGKTZpUGel0pxioD1cwHrV/PZvUx3VZLjKQean5xr3YxzGsWaztfZtD2eC0GMd3SpFuNuzXhv7iwudekMKVxjs0e5AIFnHbgILMjnod8L+braH4O9Bs4Ie4Xhnc7kr9fAWVDPpQfiJ2HWrYKcy5oInJxmjroGUQjXBTwKgD0lZ8RwsVaEGYm3RsuHVXCjwj40ZoCR7WRyRWfzjljzEBzjyelQw17rTrKEKb9HEmflkrWZQj3sEhns2pJTk+Jg8P4m9P4AF3aqTUo1wWskaoCN2a0prrPWwHsh54OL5/YrL4gaLKA2Z9lTf1KR7Yp++MnzQdbcmkQB2pQRNs42zMVQLZl4uAU8VHCKyufLyKG8Dm2oRayS0wmxkoyzY9v5bpOAl9QpPqaR9fB+KT6mC/dV2V84zpkEe7hGYTVUAkdn66wVr99UGaa6kuw1W3vODVqhSzGFS5JZJX0n+IVbJkBuGZvPOgeOBn0nGziTNPDV5Pydxsb3s9Hq7pbG9Z6WzjTynd2Nzfk4IGbNx+FKY3He6AGfkZtkz6mPHNfsM9D+4boEqmso379d17CjbPrKeTUfRYEWV2B2FEFJ468sDzkfYYSaINLQRQ68xF48DPuV5wa4d0heUO3ZT76asL1ZSYY4wTOgsbDBnuvj2GthjCp0vKP8wnvTUgzuB0XbU+wFOe/cNEDem6vmuWyNPuDc7+K5D3UNEgqlRgh7uDFOQi1n/C1AZ1Hmafnq0/kBjTgkkquaVaq/8Hv/i9UPsa+a54hLWVfLvAVDZesldOaZnO+MA47WtGP9C3wMcFlvRcbtoFvGDniMUsBDmqo4GzA82f4BGO4vioesQ24HvsRtyNK9/TK/BvM6a9TrCVsLyP8adVEVpxZ77q84xKOXT2eXHfjPmHGE7EaAlfb0BV2jPnLs9Mm59uVuYz4vb4YOP38+FLY/+tMIfCnxvfYCeZ2ECasb+uSZ5tr/R9uXramqLN0+kBdih3oJAgoqnaDoXQkKgl3ZoT79yYhIbKqcc639730u1ldzVSlNNpHRjBiD/MG9wv1B9rsK4PfK5ySG34lqy4Yxf+wx6ufc4t8aSXEdNg6IBZ9/wMLV+F7v0l5vgL9oAqeJniNPptEG/BHYRIhJo4R6ItGOlQ+X+A/580W+o7MD/EDhdd8wH3k14VxWDRXf4X6gPowJx3fDGd5yC3w82C/AC8pPvCDOL/j9H/vmobYAPHh3X14VnJ29o1OM/eoq8bF3Grxm2GPx/JCvN8CejAkTFSQB2quKaigQS1Qj0sBZWyPUMnPmPPY0OtYxfX6uUn58zjr2398/7XE7b6Q+1Kg4l+ekXh+FUdfvNpL55EcfP4v3JoDhnoi94hyrSy3uv6S5gmd2IEXKGvnA4B1HMWG1mM9s8JpEWfNnwI9qxC3o2TtqEte9cbcJ4rpB2wQ/7ziZeNMen2uMheJzxjV3yKCCP/bol2LPHzR2o3DRRQvZk/ez9zlhY7PpUp88ew+/0y3eY8TtoDLWSKtqKmIBy2GfL3rise8+mK0xPp1+UU/8vPXC6181LgeOIb9PvpKi5iM5NsXVt4ERriPM13zNp7xHdpwcuX/fTfazrovYcXjOOmnSGpdzcc1x+rjm0LfomlVjH2NNQVYak27r0QebjEJa9+gPiv2M7LpXjTN+zrTg/LJiX2S2+hL7dI9azUFMyiCzHhik0ME99J67+Lv//OQg9luTFw7sOp5jMc/VVCrsrBAVjDFOlSrWwxHHXOU4ZtDIVcEeRWPkCBkksE/lnfXguGNxZ+rU+T5yFdxHLGailS5TP0GwL/KPwBWRky5OhexXadXq8DFldtObUF46ApxBteb3wH+eVvgZGaVlzVvTtfLJ1/hdz8/inBGgkcPHyN4NYuGBtfz7+XNFTednf8W6vbOYH0R2iM0hxB687hRArhLjSBN9RNBnZ2etNyLMfzRFPQ9mO++7dAv5gC7zfYlHslZKdoqD2GlNCtwh+Kg3rpcTfWGeL8e+oF5mPMasBljvbZedGwOOQYc9w8ZVBg0WlbinoA5lIMZb1OYCCBonC29/i8lW/rPvopNPFe9++VTnK2rYl999qsYHnyo2Xn2qoxXPO5wn5VvO0acqM58qz6lnTXayx71Q20e6b9H+ezWT62Z3ibcmSZWCR+U1nmfjKWWr+lgdk9Nsndhc6Mjdd3zh7sOchRaaz5yFG79z9/3An9RCB3OxbN5aUzsBjEc5du8W+lCICRL6LE7WzIhdS4+HywK/z2J322C2VzYQv7JMhooQ9DxpKwFf1UjZXqOFC34SYDr0s33nnk67POr08F1z6xj8yN8OOyH4ebrKvj+J+nJx/eFKuAc682tuPUdhaxfy3cPKLTE64Lew78Bn9DARJLa2bmzswf55Zgh+ljRaLh1v1NMjiZ3xIf8Oux7k4XLE+eTsuqMVW4u62Kj8Y/5u9IKBNAORMC75DmMs5ofxPq5j5bZTeW4r9WHfwxk1czhn52Voq5K/43Pdw/4BsJmYx4Few9llCho9/kqcaVzPsUTcEZJdK2GMxfy3XgV7n5TlQpIiTdPTADj3KpVvFXlGpR723pza+YNTMnF7ZKt71GsAnF+YA9VprzV3RpwV/FNl9vcB2P5qXhojb1qJvi9e1+DLOCuOlbccjJVN4L5cyew0UXpzwpS6L1ik6V/yH70jP/uYHxx5L/zUU+BV06E2tYKYL3ak3thgzz9gcxuM9E3bx3h2Yy5X7AyYjznfSqWSK7CG19AHVXClrAueBuoFKu9Emg927YSuzeLJDfUHmrKrEsdr/pZbUkSlnNHeFSSe3+R7dzXpFLHeIDG8NTO3WttzhN97V14e++R76fp7vprFYZ0G/B7ykV/d4ayjA7/i0iN7BePjtL2X/o+pUp/0ZNKBEtg4Uj/5a6wibJDLl61NteCVFlVab5fq+DibVNbzrfMWfzWEqlFeJA7QFgDPL4sLbPI/Oa/rndnSYBLzdVQVbWle8My0JMRRDmwP9MvA9wqRg7uxJmzUcvrCzbqcIaYA7SPgQtQKnAFYW1mxfXYKCh6FPfAl8b7/84n3ww/2Ac3j0fGQy435RYDnqULfeUg8H1oH+m3dwaNHfiFRv2AvyDzKQ7zPr8fOt4oL6yIDX9OsXyi+TDc/eFWl+Mm/6/zmVR1JVe57UF6Zmfb9jnqUMH9zodq2ftm8cBGw+Pmx98OZtmPnlB47BX+riXXCWaX+6LeGs1JRu3RWAv8/Oysd1MXRkoVgJ/qO8xBRL6AIvUkUcw+6GHMf3/luS/GseN/qxnl731AKH+879hseC3scr2JQPK25msuxSBRPv49J3JLWNA4rY8Lz68hHrE114t2hdypfJzLoqIhhs80mT1p+Yf94RBw6JTXJHz1tXd6P/zZ+bF0rD3uWB3WuvbEj7lXnLMWcc8l2yB9vPMcS7CHWOVVVextP18R81SWjedG74yP2XU7GZ3A1mv6I+TQsZrTSYxP1I7cb7NeX0d/fB8siF7SNyMeqaDvMt25e3wNzgueXd3ms89KqD/3w0Nd5Bs1Hm/vPeS0e8z7LmHgPX7gmiFdP1PVu0R9Xz9Gfacew70R6b2YTZsV5dd1Sn+9lTLwOdwl6zoG3WVDJP7PvylXSdInzUDP/Tqb7Q2/q6zlV9NPCfaj/3E5r5UubfDmX7Htcq04xf8drh8wu6OkY/b+FqEBjMOUkHn1xqj+lmhXU65q7WBoW+wL+G5zGZAs03C9djv9ImnIRx9D3tcQSQGsLY3lNAE61c5f3rWYdPp47K7l3HeJP5P2jZm/sO3+yFxnWI8BerPY14vZpf230t/0jSf7f7YVuSxZ7F+ctD4XrSpQL/eovu01nj39POG/LluaDjR/PiZTiDczLx/5j8P8X95jnirQj1Jan4CvOiNtzeWL+VHk3Bk4EgfSPRYk0ey/Bg58E1xZwtwZfKfC5jnfI91qdIp/rDHqPicNkNK20R8jH3RExD6hAH7aqkmZkRR9NTQB+2Qlgdjg3OCwOjIEgtoD8c/dksS9W81hlaz/kPMBCHc8ixAaqD2yg5KJ/jXOYW1iAonGTkJIQ6jY58otLrZ07Jb5x5JedAb9sVxshZgq4aSf4LgntBeCe1fAdp+Rf4Hfw3bvEL5K3nMQnzhVVp/5iNi5DQ4HYwsn07pTdO0DtXC9CPe2hIcNPVTWshB2Z1F89Y+f/gs7q7wc/XK+lcBuZFxxWhNXbGLXFauw5jzO6+TyjYwXwBA/udSWeFDw5loR9jTn3BS5i56gQx35NErs7/Pf5kX1UHJ7bY36N3Rv5bB9ELdR4S0e1ncYxJMdXXk+s0Y71DvDXMn8yMGtUa3Mr8VutbTDsPOI+YZJDjY2tye8OnpWwB/SXXOyqJvFcrHJLO+Dn1H/5OVircSXUzyKtZZhfNuZQLmS2pcZr0WfyA0srnRlDrmmKHMVmTBoIpvl1U7hNGMsPHSF/glzXSxfy95WNvym98KmbaVAP8L7IbUz6y4D76Y2PfLyqagfqkHXjWug1j6dsDdyaDuDLJM5HuXiuQYf4kZH7WNvgHgt0WnvEqSzgvSY7/FyUbOBz8N6qWoP3dr2Ogz/ljrerQKEFdKMztgfqc4xxn2u/4GSmde+G6XPNF3uE9rpWxevjWnY+rOW9RNopZ3f6vo6U+iyE8++/uSdwQAvS+3sZ7ECT+JiDjvKNbFH+v75P7dKS+H1o7mDNVFL9uZ4yHc/3Qfzk9rc2a+JW2+birAb8HX/Q3+gdjzyfNgsTc7VoMB8Ga/28PwNina0lyoMKuxFqrlLOjsU9GezzSXwm3AHkECA5A31a55G6Ad484EvYcm7nC+KlH/W9wBG7Zv9hXyWsoX6wr4HzsK/TgvsAz0lNKmysHZS55jvbI6CBDJpVzTs795ldN7nGJdh5do0u6jysd8wO7/Fcadn9CfKFu+6U9uIKxnpMe4BtLJg/nJeM5oXZe001OhLV4m+JeeTzxddhG3Q6waYurO246MPTr/pHPEk92nI8gBG+2SglLRdcLGd1ZjuVsRcIps7xJLKXRej3Akcp4klk9SVPZEt9vzjP9alYJZx8126Rv/Ol7MZlxJyb5lJyf/kWDtTnhXYZ6ybgWyRZlde6jHH+5lucy3WpqHX98C3g3uBb6K7607dAu1op5xKvcfXU40+b+ui/e/MfHM7hurYKWzWjswnmajxPyZYSB7wOfa3MB79AXl0n/ZSBZa16Jcw9s3Vd+AB9zk0fklaMe6lzvBXmLbbATcXPOf0tFkWNkQn1CUs7t4hDOxfOrV2KO2X0+832t8TWA/h8k2uZYxy0KCaMwxK3zWqgjdo29SvCuDE/AvyX2YtvHfZ20pJdG+JVDer0iLuv9LZ+0Sselx3I51NvVvkarECn5pj3DlaGvRQT+PvzjJrEeEbN6LljW+B8KusSP4NuEvdLM2slw/y6Xo94Vu9BOywwXdKyzdaNkXs9ie0GO4HCsyTLVtiyE++oUswQXEccGyZ2gwbpn8ygj82Req7Kc/jMJ0jb5C8Q19zIDwttl+TjuNuSzXPgu5ad83E/zvBaFix4dj5UlhK+5xeceWsto9yYWZaKuYE1AFJZyFM1QC2vqU1aR34yKHwUyO1k6gu/8jmdwDVIJ+KoEDagBn15WiwNKafkyRRn3tPdwY4l4vgm2xip7mPNzcv5y5pbOW7MdY462rvO0YzqamZOmlzM566VC3/qusZr9S858iWMW/S+O5pr5MMSZQC1Ygy0gxhIzDmHzsjgcz65I8ISdDdkHh+BD8PG+4UzkrgYZRAfphjvLtEaXoYKi7M048GNTPetifYcknNVdy6xfRR0JNRbTzRmU/fEP9ji9nSj+U8/RH/1Q+JXP4T2Ovkh+vhhA9wo/nWOcruclvCem8Jv3j3u64OWzYrum4M+FIxbgr66hzn6nE07cCk4mdhpirimbitzyp8zGDL/p+Kwc4Nr10vseSQJfZHcKXVVGBv7f/0+qVly/gfvY6SNP71P0z7y9wl84F4u3gfWx//+feLa/+R9pMGH94FnkTQH3gf2hVTRX98Hs2XkX+H7eFzzg96nhu/j8bOF3ud55nh/Xm9tOOxfeJj/8j4SxmjgS/y4Rr8kFXFCQnW+qdtF3UX2fmHxfmq1zmy6r3wtRbgjvGta3uG7Do6qvW4phy7i6yKRY2ydEtesyqx4qTigFQC5GZ/npHqq8CvGoby/4QMH5CX8W/8F8YxJXJ8HdIHMF87mCsRswHcafE0a2bwW6eesUZlPjHUYK2eMdwa9b8jZMFuqs7MhRe6wGuecja45cHeA7rFCeLnxNcteeMRq0988YqtpSSKfDLTm2sCpAbjX++R7XpxhtlfDMwwxZFWjfGmNI9CFsTaylBOXz6JHPL7aoicWnF2iQjrs7LzCXPl1cSk98sHsHPDzIa2tMa2tMfqYXfMRa3GfdrhsXdvnuNtGjvPjyRQIn9wUsObboJ5IqJke2yHgjdh53M6lJ08DPj/1RI8w15P2mK0teCDanRo9uxncYY3srm3CoUbzosY82OmoD0TYupPAcyFz1HME3cqBHUbIS63wz2xVhz9jFWtSqF+CdVrkSeuR3388bVEHDPgZV8Zylh6M3/07mB/QIccC/S1C3sD+hFp1qtQ9TO96yqkMGKA5njPfg8BuAT44qpJ2hdTm6xlwwCeqsbBx7mjFHmF7tl7kT2gO5GiFOa74ArxwkDv9ljRhQ/rnXzQP69MR8YvrynfPn4+mpwr0zjHft1xo3aQTWAM1F/NT1Wru4Wc2A9d98IEaKQu2PahLJoaxGvvOqL4O2yPIMU52IuVu3rgVCWMNeOZOob1jzufKrmUi1yP07OC9xJa3s5bAXY3+hBwFWDffsWdo6+QbnNsx9w2GaZX7YR7pfjA/TCnfaOxNg/T1XJ+wucxPkAZV8qugNtdAXLUOr0y+2PmlHgO+QY6+2DDUi7m8ln3un0DfKLt/F+6v7Lc5x4CVVqf2g6se82J71FFk391ciu+uRm2HfLQb858DyI8sr1Vuw8Zzh/wUJd6R/zxvd1/9Z8AOsPX95j9nS5/8Z+UEWL4p+M/7TV7US3No/OG9CWUtMDuE+WPzVIPc57ga8dxnrRySb8TmZRBnVLcbh+rHul0vsHndrkp65UXdLh22C22HQRKM/IbqVaJlUbdzxrI/HhuaZDV4vS5RXup1EFNB/vYlX7uqwnitooR0FpFVV3rX0PsX/XOIa1HkN4zqG2+rukJ+wD7hX42Smicl6COSOY+eUqecalCDHB7UNlKow21IZ8tgZyZgrbVcjW2vjLpXU7B/Qkb6yPkRa1XKMoyZHYnnvG8zyrFHOsHanR4EznDZ1oagOxdM6p/wj4Sr7nz/xhWy5986uqhdION56O5lwtorpzrYGF7r4Zys7CUkVXpg17T7CuuCxDcIuLXAwTzE+lQFzloXe8ifmlt6pSn5caMaTGNvum4DDzBb58bK9yIda+N5M0Jc6qSu1MdVrFnc1D9qa8FYidbWJHvD/t2En4Ek3lXEGI5I27DMbJmuCEEdxx70usxDzvcz4jNwnsIBadXcKhnpqG13gO0Zvp77+Uf+1Lf+gWnRPwB9JGy+lebM1tVum2zX1gMOOsTrsDF76QPt5YTLUFeLtS6UmA0qV6BXzxtJbbOqxmkgQA3XL4/C3kk+r8atmOJPsMeAa5pPEz2JjjyHrxxG1Z/9cxUFuMdy0tADrvSJjZyK5Qn0jJyZf9XC+By0tRO5+HcVObsQhwl2VicOYjqHMtvUleZdeWjUZTFw9RjUj+caq8oUet6rFvy/A5jUvAM4pwx5BnSdnYeCAmelVAe+OQ3OK/Zvh/dDDuZSHXps2LOlSYvyZjXgElNRHwqfy2j5WMtBrJbgE76INBWZnR2kV46j06ivZV25EVZu0KLcAOgTVgbVmNc6lJ1lwz5WG1enpGlLroUV4ZqMWdx2KWI8iThLbx/sB/Aq58tMaDRrgj2qn8JyxmxBdBKaVhY8+M2t4Ap5wnbaM6CnADBsVKlm/ty9N4I+F6gLgX7UiHlrKx84V08mnPEjwNkFMZz5Th8x9ckvjBHMnWCtZi20FyfzjH0PWMuB67RhfKFn/OgAXvof7J8K3AcB7HuD+oHYOELf6UqWSQNONoRSZBQ9qC6shwj6L9dtQWVrm/fAx+U24IBGHlvTgpqnfoa4BFjT0Jf/wAmy8ThRXexmePMY62cecCjKl/vIKbXybGOOLm1DD/csxj8Bj0IXz5a7D/xFbPx9O0bVINm0loKdThGvPVgJ3tlB3KCXUR9pMkzHSnk06nXYnByw9x16gUF/LmVnuXMFnG3rJsH8e7pK9v0K/UctP7/mPlvvwQiwzH32nwzzyJ57/G2tKk3C/Iy/AQOFWp6T/Bu0HycBx1IkyElBtqxjVP3UQ93PSNY7ricDn25VKsnOBeOiAc4n+EGoownY6u1V1O/c14L6ErSZ/7BVf8e/x6TxCVxcwH+B+ukX6wW7WVUJ737KWvEqjDNb6JYedizbKNcUdE7qXW8nHNtkEluKU+qdit6gZh1lx0Q5vWCOC/kr0l2Yh6RFJrG4pqTkow5q+gDnyRr3reKdC9+pcS60+UAbla1h0j2FfCbiy3MrrUNun7RdtxuKmQbwfagPMRt/FTTEBay+mzxGuMSEPdyU6sCrY77+LrXqlKsahfV3fE/AefG3O8L4VNb11/FuthCzT1onnYaC52a3LlO9dcTWhiEa3oHiwLaMeOmoVMKeUSsug7QW9b2w+IHN0iXmmhaL8q5eojynUvcNbj8u7Ozo4mYrpVIzfnBQ9YiLxTsV49c+kwZ4+Y/jF+u/xm84OPEagn5tzamvfLjs0P2SWzN+H8f9Au6B2kuatMQazID06zxIZb/Uv9m+Af7VvOUgJ6dfh9i++zf+zpJ+Mnx7KaMD2XMcpTlnMYTqtNtqIvixApyLN+Qo+/n9U60L58klrTqa3okc0IyV9GBZBmx5OVhsVdijf/L/OJ+fjj1ilRDOIQ+u51wSxE+ALQBdt4KL6wd/7XXOMXmrDHUikCf77/yrxD+aejVhzjGswQJ0iJgVQrzKSS89NIJZHH9pu2rBZ7n+9P6VHnAaLVfg688icXz5k34q9PTEwSIboT4k+H/El1MaQc9s4IRxOe5Eo+vLuNi7ypnnaDM+Bv7q0UdTvgPHAuQ6lvszSMkNC/404C9WdqUSWxaD+vQXB7HbPL6P/0mnmGu+U4ZzPItHdkI1s3Be9p3kjYv0wR/uBVc+huNp5sD4I6/3h/7FgYw5BbYkK4+5gFw8u++ZdMzs8oRzN0Je4YD7yjGJ95Y9j5zh95VhNFBeuNzubI2JoqwcCq6qo4X6LE/+Nq83evAP1nxHlCzIRQN/MsRWs+L5d6j3uEUOhj/y59UE4MutALfneIR1Q4h7taFW28cXu1R+1I9g/IG/lvnk09MY8JzeiMVHgp+LPVsoX9r8/r7xfv9N9PH+kENZakeeK785gNUPBOmP/MVQE1nOhM5OLqsshpX1I/GAfuAPhs8x/8squJQ7f+FSVt/3P3AGGHOuk5Pj82fmH57/L/O3nbD45hvzSJFRkdnfJPTLkHf4jT8x9Soav19lcCGckuaCOqeyG0KPZuXBH2naowqNl+dbXH9sfC2B/lc8grp18MLhp01yzvVGOnAszvfA9or2APBHD/5O0Af94pwFd86Nri2WJ7i/APxpr/efjA+cV2FRpjrmOCyBnVnd4P9f73+dHHmerNnm92/i/Y23+0fi1xz0wd74g4PFZlJmfh/4IO4Lf/X+cn/yzxf6E7OP3+/mH75//fT9aC7//v52ki9/f988Dn5/fzTvfPj+5tP3K0fl0/3bH77fLf/b+4efvr+pfvr+9fDh/edfH8Yvm5w+fF8+BL+/v/wSPtx/c778/v76cPj9/elX+dP9X+fPH4MvJdhDtCuBAedx6ggD5MVua9NJ+OCfhtSrg/vYz7NuTw9Gem8P6iWS7hijjkB6Sgr9jEprvR921U5Y9Js//YcP/KlGSfvQf7FMPvDv/oh/FiaLwWqoAZKrG+MubAyBxZ4tFXoQutLSzUFD6y6Rnl5lxOIM5g+pBvF5DZY+nGfJcLhE7tfhMNSAa0cwkDvuxuLmG8SuGtYe/Joj6naG56IA/donrdqP5QKPBjwMLG53MZ4IqN8+dfwb1tfnr/27mXE9p3FuE15h5w/f8ApmafrAK7hZW2FxwdIREt6bq1muAFh55VRgifvxG5b4KDoq5bZ85CFj8UKXnS8rrVyLR5d4ir5hcoYcI+bAFcpdCdqwDP7ib/zHNCT9HntkKO8YtXT9xH+sLZ9NSyAYY47/8CbODz6Rzu4N/9ErbTp8XjTgHlywp45GppEGwg7qI9/Uo2DCOR1bPs6XO3r2Iqw4NlZepnBGG288Fw7kk75Iz8urcv3vIqcZnxq8J+9TL4JXkbXXPqLRIP7+kdP8gb+Lg0YsPXqh3+I9odd13VzGtQIxZ6TsNc4NinnCKvr8YbmCnHIpYqND6tNlvmV9BL3XsM6DRGf+f1bgN65A7GOd9x/1c1CMAHN8caHvDfm8dEzjuho89JSWsN4WUNRUq4Ml+By10IG+P8jJgE79HHJwOseejNk+m57WKua9k6wBc3v90H+IPEzuHDklemxc6yf/dL2V8Ka6LTLfVbsksBY6mnCIcQ0ogpe3MtVWVZ//FOrIf9a3V0XN6JJiX3kX9dj57xGDUQXOLv8INkxkG7SD/A9pXMe4EnhJbgMLcQ46aaX5/g7rB8N5iuNUEVjMfQL9M+Ak6MD3sPex7kWoozOtrKEvN4C+vEmgi/fjw35hzkidrx51iGutC7otLPy/ci3drE71jVq5bUKePoZrQ2/jN1vDa6wV5c2QxV1pva5QnqoBNZLYiUu1cW/IPn9sGWx+oivGzpvVOJhEnUUTsUygg/eTf607U6yxu9V7znS0LKvQe+552020qED97+C98Hdir+OyrCl1CbkkqC8dxwXjUU/PGogdsZFXgtaHt60ozWhc2Y5T4ESFaytANEHjlin1tE2acmw9d7Z3T+rdlbryzX9XFtXmj+vLwhdwGF8TqEXpVrRusbhlEITpYfG0/2xcXHb2DGXQQ275eaMFvSK1EejfDFoq+3+npKwRj63ap9xdztKtE5nrobXQBMEXGm3gN0EulaF9Eq5bnY3Tynfhp7xyrku2tmuqdb5mwAGcZbbXrtsnjCvFosZllBZJdygVcf0pumHsABptbK6Z/QauF1G5km4iW5eQTwd/HvR5T7VgwvzZ3bJEnH9wXtXYGphzLZve1FjwnvSy5maXAp8CAjhKPeAaj8fxbCIQv9yqU+eaOcBX2LtSIgD4f70G5OZV6P1jBq/Vo1yB1DZLfpwuMjwnysg/x+z4cPlLv3cwD6mmqj/HXy+3VNBQ4lxyqp3Oyf9c1e59yN+Va17G3r/eEnL7MgQ+zPZQh36Eig7cm/oo7MWdrAe6uCY7Y+3UcfpuXqop0t5cXZ2Mjf+XqvTmMP7V2miOdYnJTLP86xfUIUq14DhyTnnHOgPHVntbEbgfHm/gTMsg1LCy1UM71Z5yDrPlvrWsYb6OtOpwn+t1OnvaI+DlRa7SsSQO4HVlOe4JoRT4nsP+3h3UdcqXNfFv18wPkdtr2Vhz3cIL2Axx2BeJt8AvtKV7zNgl9AzEWSDFD84Clef/p8ABF26g10y7zyYucMDFo8F6MAvW6Lc02TrxoH8vr80GD74B4Ldj1x1DLn/d9dk1nO1YiLrtc1gCfeDZFD63wFoO6EpwXrdu1HnldYNoCN9lPk54/NPFd+lsROR1i1953VK7RjaiDviLaoG/eOO+PD41Af+sP0N8ysw+EN4mvQFHrOsRtrVuG8DRaVqA3x0lWD8DrD7vAa7XcvIZ+uzdRjL14famJ3Ul3yBmhLyIfHYgf9EpdbHO2VZbfpf5XMch9dcrB3le7xYYb29B2KAq7lPoox7sbif0haCGgRxMKq8jBqCzdq0pkycf29fgUXtjGzkvaU3OuaN9zb6hr+KU7eIz56MTSsAJiRyqZay9l172p27XHTWtsePI9pZrXa/tUSPeFlJZlKbXm9er/uZfDMqRO6a9aZDPaYVaG/ghlsO9JJagdyVlNrjUugtp+S7kyVW4DfyUrYkQeVn7Tggc0wKzGyVTlvY9pRkOO1kVchbmqrJDHtDZXjathSl8Cxsz6DjyLAsbXleHWloYLU5GpybpYgN7wnaldv7gUFl2jsBtENWcAoPYoloKYgjZeuI9l2wcQ9LsObXr1hZT1aLthVjX6bnf4J+KZcQrNl/8U+ar27sv0ORB/3TXfPNPh0rE1/rDP6UxA//02f/eeOCThR98d2/9eC2xf1jA2lmcV4ighGdS7M/PVDos6ZnmR/HtmbTe85n+DQff2zPZkuf/rqmXrbhWK3yM63iD+jXIUW6r/QcHwhDsHnueaMb3uaTDPu9fIsA8lMA+/tRfeaufstiqjFizKcd6yZj/U33MMQOOqO44ksQ5Eo6I1Ye+D2HnMl/yrnJt0AA4q0djXk+qEn8mWwt3in2yU45+vgw5RZkwblXC8X2snwNmhV3vi+KIykTy9UYwkGBdTiLmS6TO+Ib6gr/jL+nEezljL3uLv7R2/oi/Rn6DDYG79AWTx19tx3Wol1OcZ2BLuX2a4DrmmIl2FW0UaEucdBWfH8fNYeP26/kjxUT8jZOuw2MHMceV5hJtoDYsbCGzLRKzeXd27rP9cIhLkpxEp8r8wGs51St710nS+hhrxnbxroISv73r7HT8V+9axJq9t75VpSU6Drt/h7mPXfLvrSP37aU9cDYv3Y5RZfu8ivFWQPUrZk/JD7sNzPAUPHyeib7j/akGcNEq9XFL4jqch830X/g8aS9fku5RXE6gTh/82eeZcv7iF/vZ8ZX///azakYv9hNqVj/tZ6edPexn2gmJ17tZ5zHbaXy00loV/ZH7rKh7A1YS9OmxF3TYnCKOOcxlpe5+E8ZtTVij2UrUyZcdIIfJsgXrtQHzw+KMGvoIxvwLfX1vgdcOkWu6OmBbHnSznriRaaUtMT9cdErdJcYxVWOZyMpqfDvrxJs3XHmIQZyKdm3GeW2m4hxwOsouhboy4Jx6kCeZqM2P+zTunHieJL9P39buJMp+rF2H4lRYu0+uofWntQscAmxMbpxDgO25+85p7ySK59cGjJmoHqaUw5ksmx/31co88n5WL31/tgbE4PzZfHU88vy15wvrYl9Z7/xqP/eVbH7kWx0eHmNYvgZ1g/gUQjEstEAn0/OKMDgs9kA+QbSpALCD+NHhGnmw5jtXsMVTwKr8jt+HzIbW40ieoRa1xeKAFjt3yhmsmfQAZ1D5fNIh38Vjx4T3T9VEazvlsR27f3bFM1/Ked/U1AG++Ghs0PNN1xWw9ahluGyz+zSAa36q1O8px4SO3Q5h2JRpBdfMWZ0Spm2W7mx8L9ongxVxQ86QI+UH5mJasTuLo8eeldnjiisB/zzzryzkL9OEtb8ywyVoRs3ufbU70PR6o7r1lsw2lyIzMqwwug9Va+CyMXHqa/+yklm8OLKYD9pl8WKJxxSm7Rk+jweayAPSAW4pZT8HfhfACkxP1Z/YzNWyt9uMpoWvyfeMsv+C8xh59Oy6lEl2Bprgy2cc2lokuUE5p644GbQLLW6cAy2/ko8x3yP//Yt+2Fv+tAf82hPIfdRUqhOrEufcLQnYawf85nXSfFoZ7hfySJX6XJcWMAoJ73tOuZ7yEDiIlszXOa/0I9YxzuOQawwHyIULHOzrSiZR/hk00Ihr6dQrEfeZsbq2CWPZnhLGDWrjUYN65uSIcpuTQKdcQ4B7abYjfehaKdlUyBe6efqmQvfeDIIftoutgzti3vyq0dxO5+x9bqpUqgFuf+W7LN7cKNcr5mIqibVBImT2bsBp2XGkkgd99YjPrgXTB+6Nj4E4vOUUF0MOj79/6Vxh6zmamC3i7XzzF81h6gWZCPYP8pYqfT/1BHP4zqGSVgpdq9c+ShXzlsYkhppr3BPHklz0G41OlEuulVZ+hfPd3Kz1gOMVx1Xi09oNT8VYp7vUaxW2C/9fw3m4oR47zEsQ+fyzydCqhcyfm+CBP5JK4uxLgvXUPgPO8CbZcXx88pESB2tFBz6aW8LiZI4rp5zshN7t1OvzXLBS97pSgXezVrcKz1Obi+lHn3sqlnkc4Nze89QH/2ccEFRMpfC5fZXoLkWh8LmlV59bH5Q2RzwPNGWMdtYVFPC3X2MI5AcRbqb5Vd7DvSBv3ha5HvI8vr7zKDefz/N2L+BRXn91gOcGsE3vZxTyKI9M9LeJR7n3xqNMnK4mx8eX4rpN9kFD7Igc+MXZwcZzCdzCVegxAI58uehr9R3SWQccPNsXLF5Gm+ltl8zHPsi8F02QZKEJ3IBR0lWa0XHRwXNld0bcCdRkmrvKiefhQAOowKiArgbX1RNIp0oWHeZfCXfLUmN719Lu36AZksqf8L8bV8mOTuBE2G/f6TmYCx72zjLzMyN7WmfrL71uB4kYeJzPZrkLzOFjXUuRQ/WCmbdDnr+fGOhB/0T7rnIn7e1HvcAQ8mLf/at6weveVHLZfHIWWZsV1JNR68laeXRdu9uHMX/of2/L17wknSWqefSYLzknfMvubuocdwUYD+RCJrsIfJXcLmIfP9QRvHS3xc8zW8bOWKtWdaL5HnoWcs6tBziRwXiO2go7UdHnBT4pPJHeyCxM9wPk900yge9F0BoPyCbrqwrqUZjfVqxCrkX8urTQ/24Nd8CRdhUCp6jpA14z9WN5pJx6zNaqR8QolhQV3xO4NuA5LqDlZG5UOi9Wd8jVuj29+0Xnz7W68Qp9VmkwQtuC+VE/KXo5UuKnpP5FbU9YrRPlZJaoFz7fSQnFeO4MNS+NdmnVEpArYihHCupv4XttECPrsvfM9Q5pfS0Ejt2E8bshR1qcVFFTwySdDqgT5hVYfwfIDTdLSU0g2wb9IbXoC3RsSnSWW6lwzwvdAKzHVXievAY8T4IVS5ABEDsXp/D1v4o+RuixYO9SD1tFX+PuBu+JPrXGccEnDTDpC+DbqUhT1CCB829aWYLvXgpmNzbeU6wRhRIb6+pulvUNrxfHlE/wv3sxcTEeYS1fka98aKHuCdh5mNfYTmYpcsaMUf/9ahb67xrgEroKdNnvr2XKc3uId1Ud4MIbPsdB7eH6Yn6Ftb5wX4LN7e5x3tYOj7qVLPbVBfpWxOkS8TkBLrfBEuskLTsZBiJx1E/qxJ27UuzlbCg5CqyXhsT7mMQx5KiO/qP+zHwhxBdD7csYwDUMyGVbtRY76wQDvuc4pao3+hGLXl5i0azIv8/e8u8tP0sjX+4wuzlc3t5i0tHz/iutvfXHbHxYYN3Z4jsr287SrzA7640d68Jcxm2OWFm7oUO9SA9nJq7ZKZtfFo92jr2trObGvTqTLSevRyHY6LzeQY2wPGV+jnDMMNeYLCPl8D154Z9ja7QFel333ojFbSbV39hYdA6EkYWzBjikgB9B2lp0rnBuIntpchtS1oJ6CFzEiD0EXsuIx3/mgfqhgb/Ga7bQdy3FnTvnJHC433GhdV1/4REB/8YsNBqefLNjzgvNbTPHubpzwAoHnQbPNYmQ14D79+D+yq7eEj5cX/4qru8J/BbWvri+444NczQ2vZFfXN/vN7B34ydXWFr/5nHreQR4nbTnzoqc7YPPsnePHzhwo4M4Yzj3d6htA7Wl0Vuuj/P3ht7OIT0+7HcM3SPnDocxpfpt5G73ySVF35/Xb6B2iPpGSt29YT+Zgpz/dhNz/HBWCz/y1POXPDXEgo0irzJhZ7rMddNtb6kZem0sQb3S64Xxa85aiJ/1I+CF0fy0nMclKcN9EzfybcVkdlGo+MqhkW2MFvUulNjat7xOrwt4OdCiE1CL7iA3cnfYCdsbx8uGVg+w76eWJYE9TYY6O2uigYE1Lz1gNlhcv+A/mW0ra5jvEM5pdMspH8Xs7Tev1SikpwE2N93T309t5CI7p8GNY5TL1/ECdGZEp1cuYq6i5gFzfVR5D+MyGyEGdygUtnn/XQaM0D/wzy7uUsFV/s3uvfaQB8/Anphlg43NYaVLpc6a84y7o4L30V8CnxTznc3TCHt4ydc0giH37XbMd6sDvm8OPlCIeejfPpBV2nDMRN5/517t3qX/uw9067Q/8Dbe9xvOU3Dwie/v+TxSPBpsH71dkprZ53PYUjjaZTQNllGwRg1J0Hu2HRmwmHb6TZx+qVvRMV745KMvvaTw0e3+nHz0pbB789ENe/Dw0d03H73/8NGdNezV9zwS25tpyF7C2hiyw2tlzL5buh0rQp60wkirFP2k0GsEPN1+bZ/EvvTQ1z6v2ldYb2/vH7elHuop2wgZBj1T0FNVVkpdag91tgeTqGWvh31jHLl0bamt5j7Vr+yYfKx0ovwcZ+d5H+Daz5OSD5+j+Uj9S5ntwwbb0zJgINKC54ydzSvO9yWad+BfvwoZaKUlwIHmEL9ZsMQ+0Z5/i3s1X+q5vQf3JHDS0bOw567bCXATsv1iDmPIIcezj/23kZ4vQshrVVHX0PZ6PO6uU0/aGO7N+8PP2hfPO7jT52cQo4+cxGkGY8zsWRme8SyVehcHOBDKktKsMTunTvNFplxoGe/vu+01X6jKr1hmt6V5ujRL8B+bJ/mmUnyTBIU+Y3k3GhaYLtI+AX+mck6215jsEGq+AjY7DKHH+mDERT8hxuGgt0l8r4hbSQ2OzcYcA3FdgBZa1ShZaUnPi7jv1I6t1dcN9V22FRanXx4YD31rQF6/t/mgn0n4nvxGvevRzSVeGjjvJB94TSsKrAXiCmDPUB9TvZvuSXijEOoirWuOejfpoW/IyEtYB/15nrObXaeyxHs229mkLvndGui+BeBPTiSOn6utgJNFac78DnD4s/NryHzeFK/zrM8WPHyo51AbOuQ/n8eo9VdKmleqI0QLlTRP4NxU4P7EkaiUmC1PlnT2ra7j+Zju2df585FO6ZIcuTrq2G2f9dpn3UERao1RxxQd8JWVNvYSDcPs2t4XPers/HNKUoI5dXb+BZUIe5kyOv9Ktjlk55/Nzj+b7bueh5qHGxZngK7rXmZrUPWcrezVBbWThfYpz/seYsarg0nCxnzhbjJVaNRrowM7D0JD0jbufT2crpDzuiIK2SCU0sPa4fk3WAuDeZfjysqaF46Bs7kK6xV7W9wt5YrObeQzYuc9s8OxUrcg7OL5vuZuAZ+3NrMyrzN9ZQ6dg/OhCfs6OMK+ZvHEhWvEaEvqw66w9aScxxPOWYv2o8ntx4tPxfyUYQ551NJmAc+zCudyM/4y8ilAk5i/qwgSFMLC28aUpbqWTxELknF+MahrlNh9PdEKVM6TqWM/QXTY7+G6dXtj59vrKhzIYnxnvkbcRrvbC03AqciLrhwzX7ZRxs+u2GddNrcjNh8s5uvK+ZL9fdo1btD3akOPzVLjtWuR569WtAYFrRLlH/NXvsh1t1wnezuL+ofuf1bHfs9fKR9rxisHnkecDqVHXaYDWhTKLgt9ypMs5vOPPoI5irmPMNbf8pPx4Ro/fIQ3Xxl9hDd/+kOeRNt/8hF2ahg+fF1HHnJfN921W49cmHxFmPFHPRN2PqUa50vdie3TP/H/w/NXUduXHQHoNwM327xF3EvAOTetmGD/vDng4YQYcWNKz3jGb1njHpfUGu/F8B2N+atr1bvBGaZVRIgFwj/w8IfIwy9dYCChT2BYcBalO6fF52Xq0bz81nYcv+aEgdcRsNHEvwF+bVLJ0Sd6hk71eQtLZWIXabKJJ+a21o5Wstvy2hZzeN5qW5eW8+9rxsAlOoeeMt154VW7Xx1e05oLUEPfsLNtAT4vaUHElSvF8xHgCKy6R1wdiC+EWgVhBVch4AUTIx3XgbsiZzG1VotL3Q7yWm2M4CpvnPpajW6gRyLEgPWC/EuL41/ZuuBYqDHFt8D9ifxawdzhvH3M379xjaoeaG+B3xKgrijUveGsmIhe/i/Oike89MTl/fGsyABLh/G/rNRlA3PgylZejhPC2lH8/3/B2Q1XV/NRk1auLfAL0qh/MtOA2ZzJrGf515UOPA294MCxdmPi5Lp0HmfELAddp50NVBrI8+YUeJ577hR4nglqcEIvo2CtXcyfyzDeYBOdC+Q/v9VNSXvWPY24VdffdFz8Tfu1rsti+T3Wve8G1KV2ojzA+bsk/gsfq90d+5vyi60xLuNXnI2gYT/zB/s7bHAu1qWzfLO/+oHefbQHfkDoNbi9YoMoZ878CGvl5uhfnU7HX/VW6VrNob7UeLM/s0xtuFo9jqQKm0dTt6J2paVifVVmc7mE/Dtz8I/P+iq0XMF69glPJe8od1/B2mqAe2DLjO6ztop9eRbzsVPOjZ26/l2l+qppd0B3lnlM6AuAlhRyKjdznuv9tlvjvlPoPv3SbmTxwdEVr40f/iPzcdg4ho6mx63ela1dl9mga6SzMyPY5uz/g/BWkZVmKHibaeO69SL2u2Vkjtlzmvepr9qnirtAXG7Af7ou1FsnqnVuUL11i3VUiAWetdTtLpNaUsF7LZW2MziLKY+Y/cojAj+C2D3aZAOYLyUECzEaUD4K1kE0bXOs1FJGfCeUQJS9bBdY0hPWGPruke553k7Av8k+6ldyXYzSqtt/4KQDC3OJmPtdR6BZOgbOnQn0BAA/DrM1V4kd01i/1a3QFDz2XCPw6ZS14MJ5EiaVJtVyjNkM+AdAN2g9rvacJdT23+on6VpY3tiasfSCD2FoLU8VwJdWFisIGyTM4bnIjaJfhQnXi37NtWEcglqk50HLJzs6anMfQhLVJd+rk10Fa2TZe/zt/+Dg9CeY78+xFxr4hJTdYo7+0bMPxeqW8Zi0kvUFdvlV1s5cq3RuHHjNT4jesX9W+Vdvyh9rfi+apS94kBOYImvj8Hx8E3D0bC/inIn9SbnQaRKVwUOzaRVqyHkymq7bWEfXPdCf2/M6pqMyn1/IS9oUc/gbw0WdHAnilSbgDZT67UifFcZRLnDsg7Qp6jKlDuWTXORjiR3HKdUAdy4OSu23s6yTyXQ+1TpW/jjLZopU6C0SVjXgtQTta9z/X2NVUYNQes3/PeMf0obH+Gf638c/xwCx49ALwe4n/Zv4x0cupeZFeuAmWx3UtKq2ud9e47+/dQoNVOTuiBfQZwQ2Bfi7L4eccGy+MOC8wXK5PSt+gg7TVFyQHmQV1jXyOplwfsWjef1Vi1u5x9efuCUNdG7fz8DJBmqG4n2G1xCHJep9StS3M3Di/8pfs7O1/eqTm/KyOcLvOm99U5po3QLu35+6b31TiXJ5aJll4lPzF/RosVb9/YqncpvE2YA57fu60AqWxc6N1ir7zGBQ57UspayNd/0XbSbnJ4ZHXRxrP/Gf1CMTx1CziuDnLvMBG+/LaN/YeaNCv4jc8tm+A54Dp6ROy3TOL5bMpkbRvct8QlNNmE3dVrFfZNkWBD9rVGr9+hPPfoK6sGFxDoAM4ncrbsN4iNM74W9Kq0SL6fyvWpkBsecf8O8Os/m11fKyO5j3cqEl0M+ptjtbyNg7Plx+iYS/Hxklv2tU2fq+LdLwHPPeNcpf27zuWRHuhO0E3ruvmGspCRulfIHchs7twaTq/q/91d/92y/+a2eM+YP/jf/KfFc/fuz17pfzr/1X6Sw+/Ncp6Dopu8F8x3McoxHH92Auo9Z84i/nXK9ntlD2LdT3jtUzr1PNcQ/BCvjQe9jbjDmGR+y+YQlS5zF/P+pVECO/17QwRo7+3nu4Es+co1qs1XbXAed5c7f0XPnbc/VEacGfq6Zrb7F7sjjHD563fxO7R2+xO2gTEV5FfNVlcgfHB19jmIdPP1JK5i98b/A8qkm8dRUF68GrOjyPuJwTL3z+o39kcdsVvJG+x/uAvgZoZ3szD/f3idcUoH90OtjxfCH03pC4MuiFIsAI7Oo4jtl7p/Nq5TSdNDI8m1dvmpVb6LPpM1/0KkxzM5fZ3kICI8A1NcJqsp9tHeq79Btvfg+LYwwvSzYO6HkqsQS6nhN0iNj1J+086q4vpDW5tqbsWs81MINr7WZZr+duJVFSt+wnPC+7xmDNnrUhhJv2EZ413VGP3Gr6pVNc0euB2gC0D8H3kn2xQB2KIzQ1fO0DOvN1Y49bLV67zy/YB2R50AckS299QMYZz82svUR+zZV8xbKM/JjTP/P3gU4cm7OUcyjMzmWYs8p+gHNmRq1Kocvaaz7wvaAd0+o5BU7Chvwz8/mmraL/Cp+13x/Bs3bfepYSnT9rRQK+UM7L8tY/76NOJvnnB6qDiLZVpbn0HSecaT3kpZzIpGG21nRYH6MY+KsJp8/7xzgnyUJUq0LR94V8P4eQ9AhWnZIEZ8fgW8KYeAAFP87pWlr1zqh1uo66oIn+4JB59u+L0tIr1vSpCdd89HZrojyq4T3Z2VG+BjHqD0EcYa2CE/VMtfvWyir+PbJWGvz7skb7IMqc97JZqe138Lzd3/MHczfwdtDTE8J3h5ER5dU/648+9H9L+Q7iEqgHYI6X16nZ+bXmusB3yEmMdFO7dZSD/nv9cF1r6Ou7VameDcnfqfTsmcW/58j7CX4H3OeGvddsnSSIra8Npg/eqvI5iXSHYrGow/6+WO5kfO+ZfGFxHH+epirJlW5pXS64St78D1yP+Bnhywed9YTFtcvqmXMwZQMYk1J1dANfmnjY2Pm6GtnLEcewyex59zLU/odHxLDlwfDKfKvBsPsL/yYwf181EU/B/GheZ2I2TW7GUNv37oSjm91qPn9HwIiFyk65BIWfococj9EoJd6J+AozcRmUCLfl7H7qy76uP+J/WtdYHCMD31F0TZjtDGPidPgz/6IP65ntrzbz8QGPuxxBnrMKtaudOPi+83oW6WItBzvxAPn71enI61UQ54Me7k+tcdE5Yv7wn9ffVUcuOdAWh32g3swlagqku0lziL0Toj4wsNYeert+8uTnAr3WPGPn1iINjpznQVQ290fPN/Tokpbjc9wW6ynyx//mz4J8LPAyXuSsWy942+pqbrh2AjFiffiId9z+ynN6o93al3Pgl5PqyOe4BJIBp4/c3tKOOJulHWmBSLsp9hxBDiaQIK+gIw9Pfnq/P4tlVLhP1m0+nkHYymI8szrje+Awn2d8l4epezXwnuyzprQ3VmOnD5oD3j3prxxv5u3WatVJrJV/nyFv6BX6hOVcBp7Uq4x8d6/rB+wsxAwltleWLttzFR/4VwfM5zvIh2Phj6ajeB3WBDa+lVaOepbAAQjPIJ/gGebwDOM7cPWpGospWCx4M1wJc3PDDvhI7Dm7r88j4PPMeV3gPf8/NsFuKMXYOHPuF0fgF8M8wdycYG6af5obfA7JBJ4BzD3dz2n9ivj3k4Jz0ZMGbC4U9cFNxp7jp34I2UmwCR7hy8BmKIXNiJnNcIj/D/lCWTwAsTbgZz3NgX3fTu6zjO+x6m/+S+CTYtee0XyuBjbyJzp6h/Mnljh/YsvvChJyKDpnqLMDpyFwKIpD0Nru7KTADyEXwmIB5Lb+8By3g8/8c/zbyKgDF5kMvsH1UZt55395468AvWpmQ2em/uSoxFwE8r6BxgUfh9tfxmHO9mszZXu6b3dpTwe70XVHuLBIetwfejiGMBZmyuKCQZnObLfAt4Ht+Uasp5X6B65bArwU5et4CjxkznLeY+OxKMbj9j4e3WI8joujAvk40KZ22Zg+9KnVP+oPc/vlelzPVWD3LqHehmKwWHr47MNStsmSrZXzIwaRpZHUc5V66pCPbMflLG8wG2N7JeUgMTt8B0zoFXg4r6YiNLd4BmoGxPybIeesagIRn7VaQUP9aCcIs9GrnwA+Wdw+kk+mYq+7NcqJHyiFfbO3BcBCsNjAkoFPsuRN1y1DBp/KybrWkY3jcY2aSuAXdRzAFdx16hMV+v63KfcauhWGdnaUDSvK7fWwq+aBP2Dbroz4D+OWU55ySIbfOj7/pnfzImdWnZNfU6fxfvBwQv3j5/5bhcy+LF2ZxYHVnD3HkJ3LzvXBkw5cEpCXFZ+FaVmXItVemZRbx/dUtrEnte26dQQddND2bqqq0Cirgu2dIzNZuMIYOcemQuG/gi8lGv0+W6v91But0YkHPVLKyfbEDnSUFmtzuav0SSdpZGEfZgrcTSOpjZj6kmSADKW5CvIMbLzbcaZizvz82/gqof9aaRkd6Bcbxmz9dqXA+Wbzq16yuHHNS6Mc+C+kkp9PPTlyrka+CDs0pqvLj/EeMru9lZjtLZ2T44Fj5MTh6ELn+fue71T/QX8d9j/wC+IceP/Z+EtT+T8Z/4nQBT0ANgfHK58D4YhY5ZJBc+D9ngPp+/I6B8evOuZm2sJjHrbv82D+aR4GpEFWEdg8MD/oGDs22BGnBvNQdsjflRaJYYXTn+t/hGMuEFasSWM/PsQYzyoq15k1ID5y6jl/tzLsU3H4rRN2K+I68Xvkm4++uJZUKWkcKNcdcz69H9wOp7/P33+zf7Am/e/nz4W5m9T53E3KJ8TI93XkM245MeevJD3UxXx3+eZ8DqTNuj5QL5Hqhohh+jBHvkPaX7/2ygbmyP64VxLUa+6LAnF8XHkvf06/V/H3OM6HA9XzYvIZn9wZH/rvYVwdzkNqrqo+Yl6NTmyfyhblB61E+S4w6WBH3zBqkAOEnpssqRSYQTqbVIudB7tycu8DrzJqxpUK/qCO5V7rkXqCHKqhR5AjWDMfJ+uyew/vSjJURLsRnjWINSWx1z9xXTyohZoCi3dYXGK6UYe0ouAsZmfOdRHveQ8z1kvlpiSLuX7Nsb7XIL7QX7HH5/wpYDRWyxO/50kG33PkQg+nJimNZdfRvYlSnxQcK3VpiZoQPVEOgTvtoPpQe5j2RMQYKYcvKxUwj8piA+SFu72Ob9z8jvn4/ozjIP6DWG7Um/DYcwf9SO4wrHsslmv1hhn0tA0NeeOkWRj23Alw/vPPXyn227DYr0WfDwYJ9VvejNaBer5d+Jxpb9hnv4EHOzIl6E3Rh2yeVu71+uLv2+jvf8ivre5VHwJYsbeBOUAf2P1sf5G7O/UEZ8D9gMkcct2rMEH95lOFcKown2nvu8AET80S6tRZ5GumQatO41Xog8BarJqzFHoU9TK9i9Bo13yTHYNqJYOcMsxfdFOg5yY2cd8ev3eEc4b+TT908Jo/OADyl76LevaLA2AEfReCn6VjvPeTA4DZ6lEkN37jHwmDzny0yq1cOiYF/2G5peXjDNaNUBtNj8Id+zS8U9GHkY7nZRbTg+6Yxe6xgbkqAwdCKtmn+7XmwTqAte5dc7z3vHe4YN4nNr8xzs2an+3u8T3/mWlj8gvtI+aJBMQamKtafTryWKwstS3qO6yfeP26h/Zf/VYf9n9ZvwpgGxaJuM9/zKGRywXfG423LF+kgk/eZevfLvjkE4zVHnoJG6WMtQITagXT0chcWNB7pgAfed4F/njx3n47P4jvncXPpR5hmFgMpjSjSoXX6KnuaOD5gfbHWfv3O/RntfLZLhMcf1uGGA94/LULztsANRVKx/w3/79vxzJyI5rWwrfThfTgn7fe+efZXKYwlwrqTUA+CfjnAXcEc5m7MvRy9aEnLZoyO9Ep7ES0z/9gJ6Dvyl667Jr4joWdiJidwH4K0z7jHtchJ+ZjFvLsEe9eP6J3H0aDQ3/yg/9H2VpnXl9VhKDrsLPomkl6q7i2bpfKNeYzQK+kzewO+3wULfFsFs6nIft7tVxzevTezYM8X5MHAXOQgV7EjPkw6V5YEmchW6vDb47NullHnXSpxB36e94JbPj03YYTDm+2/7x++yo7G7LqYAZ1v0qeddW4UYKa8onqj31ug9rfwAkfN2LsndxuIcfKcR8Y282+famod7FYAvkhb8QxYkShDPHk0Oi82qLto19L8IE3/xlrxuW9RPyH21olYzHTUjb1mpNZXH82neQZxPnjOdQNdmBPDnLG4l3r2GC2orAfkKdOcpVrb0DfX/RF98e4DdcEz/1lxpjZf7am7CFbU6aqGWWB9/HIc9RWuGcb072UD8x+/NSPUZW6hGcX2/uhUq9Rf0T9pDYc4k1s0POwuarkZSFLrsxnrKs0tx3kmgSM4MkYsmeUVTjTWzvop6/EiJUjfhl7A9yTMummFDa3TXuTrc92W9N16H0MST8Benqu9wT734RSA/qHdMzXjpCIvmFjDBnvBewBBr6A4/qJn4wb9wMFs8x2a2w9M993JnVsA/rfemzslfKlXVEzzH2Wr8wm37dBgLGxOTjMhZXSvrQFuYzvbYn5pOHwvrYomoFWZZfFx7oY9SjnWavmTk/og19yRkyGclAENj65SRj7qLlb9LE/YxBBj1U10EdhpBrygwNyKw7OG+JMaXzIofI9sPlT/EP5sOhKGiPBYgtNceVP9ROeuwO8aRly7+LiIvyBP/5n/hP41qRnL8qm8ej5wF6UmsN8EoOtNbGuQC1vArk0M1Mz22lBT+tk58ynMtknl2q67Awr/q3UVxPOKQCasM86pizr52X50cfiof2D/t60fFNztj+K3oZJDNd35qiBLA2jk4b1WMAtQH8G22/R/Dd/Ofnkbt9TTu1vqWS2f+KVZNlAPMwM43NDaR5iO9CrvLdrAFqliR84kY+9caDBUrlZibGjGm0P+cbvKpy/8irKr1WhW5WYf1TUj8iXffR6QK8paBJoMfN/L8XvajCWLH6WROAJlVn8aEhRSPhyeIa5XDMzdl3/RrieyqQ+y76MWbcJsdB31OVnFx0Lh1EGeelUbgAfA9VEOmL/nIAfe563Cp9xI6qjFdWWfNCzKePvlAnxptYmuTPdqqKYYJ9GFXo9rzP6d+loM5+R3bMin4Cza7FHbFfxrjI7B1yIaYIWjJcGfWruNdmA+pGrJzWd7UuoCV+7CcX/r9onn+PHiY+1gbhRBnt7iaBXUZjAviD+BM6z6MtwvooDt00xulv5FaOrpfRRd2Mxevtbpxqiz/xpwGIvQEOB2Wyp5wIupM6es75sGKtx3YH6K+SlQIs5g7L+h/rb7/PrxnlZmW2TCTcH+gipV5savJ6tf+3g7DoueS8C9MkwexHTvgtII9joIidq3DL1jM4sZmds0AK51yFXVwI7bee8N3XglBOu73U84Bk82HAOWrZn7rVDE3OT5QA+jz3aYSKX2xHVeyfAu7q9iEafvgP6L6DJUq05Yr8MlEakd/5F+b7PZ9YKtKf0ztizHKgHpBBrG2xsdZX5sZnKxjuSVThXLNSZksacKyDz2To3lhL+bQxaSmNJhXU0vtG/oX7RpZy5rBZ99o4LYzPMAaOaA79wXNJ65UIHStlt+zrm/2DuvOWQ53m5ZlrBg/eTp/Jn/r3IP3de65Nena+tJtQ+R8jHtTJNZ7OG+t69dyG/COOhZL7NCzww5kevZEdsxTGwd4CN+ymF+QxLwNtwAR4GpUS9ymzeCE86/SK/pVlujdekewNYfqxfen36G/LNQm2PvfvXAg5jFt86JW1N++Gz74z43pj5Gg3Yy9YQdEJV2A8SzhnMS0Tz0rVU3qfv3J2iP9kzJTgTWgJwCQCXk12WQtCHFhBzCjG4kt9g7JjNXpYtpT7WCCsIuLlktYMYBGLR3Pda8WOcgPPoj2fmn/SvPu6/YS4995+QG1z7YfEVQvw6XFxe9p98XhR4SbATrW+JtI8EeZPhfsP9t1OustJC3UfJVqUh6uLied+ZxI/9xuJU93x4zEH8tzmA+MXHXEmO9cxhbyWz+bRlZmcnjtuBGMNLUE8b9IOPUstlC460d6+aKrmcpwXGXpkhPgHW15DvCeqtRM4Ja4e5J8hl1eCkeWjnfd4L07/5D84rR9SR5//RNrPLc9ucAcRE7LUbPMZEv1zZ87ybD/shXdP+YM9b8D+RTt5gUcbxrrtSqTrE2nQcbp+1X3Zu1fZkl7TKvPlfjS2bZQfiN43X5aqA58C1e8W168DajaZX7Nuc7EGDA2sVp06Z6gjiI7/yfrb9LX/3On4b52X8FseCd7e1h/2ht+uv49fb56/jV9lye9KXHv5Hs6Q69mlll7VgcCj6xBAfUkppTQbjZaFnRjmSJ/cOs9+mg+MC8dsdxsW0mNU1JO1lnRmPdaYit/tkg+eHPkI+VOYPDAZewHP+yYc83j/5vz/sr/Jqf0fCq/3tdoZkf0cQjyi7Q2/5Yn/j5ubR+4oYIbDBFowZ6idF0H8w2bED7dEPBv0px6LOf06u4BRjHBEs/hKrVSAHa4IGYA4xcuyysctdtpYz1aG9O3JMzULtVch9z3fzb+Ihc12qRw8zFmfwM43WW4LrLYH9wtebWao/15vyab2dnT/UT1/PL+V1/KSOROM3Bn9D2V1689fza7B5ckb1xE4/Ip9kWGfjx/E1p6bI9uu0LKtKM7qDpqokUN8a4GfGRv7ETZyTSuNSjOf3vxhP1KeEsZRhLCUH8jwC84VHhilpoK8HsYBPvy/W5v6xNnUV9TCZ31q3k2D76L1OGvljTC1LeI6p/GlMT5vsH/bvKX7Zv6PjsqgfwVkvDtqV1/3r7bOX/Ruvt9JP+3dqtnA8Uf9dIT5sGcdy0ji+jmWrsSzGsvt/XZs4nshDGwG3rqrm/sc1OaU1ucbxW8Nz8PEbWfk/2MB/MX7Sy/iNjwtew8nQPxi2hdfxC+BQeY5fZfPP50eNzo/kuIlfzg+9lhXnR/jfnc0bV4e843PczJdxox4qtJEDtJH9zdfDRo4Ph3+ykZg/+oyfm76O4e31DAniiMYwkPHMN6/31zH8aoQvY5h0NvwMsQA/zcdvCv5ozX76o+HTH41mWcEJcNpQ3WoLeCxRb6bFmDIX6J/HFHF5N4OdLcyWOHLh69C+fokLnmez+Dibb/LjbGZ+5b3gchD73dlzfAFU+Rjf6Z/OoD+cPx72aKnxvtSTM8DgjDpbJdQawijjvXzg83a2eahpRurX49FUaC0B23KDsb+yWEsQQj+Gmgb0GQ5dyEvVdJfFmmBTA1hTojyZkt+4N6RK3QnlPcWeejBaXs1iXbz5FLz/4AU/u70jjo3Z86bM+WY8QDkou2lv8KrHB3Edm4tB2Xfh/EtIHy9/5Y9nsS7xB73o7U1IY8+KKwfOYVTbU+3yek5WG+o912ZX9j2NY33/pr8M/dQvPccNxBvFlXl3vImgzuXH15bXm0P+n533OuFytqB3vx5G53LxuRLqCvvX3EqWa3arb0mrzLLXPrGxfqkZ+1k1EXherj5SenWssym965k0cVHfyX67XpwW1+u/XW+mX6qV/azrHmfOp+vpxfUqCtQ49e30tWflDTtlbnzETgHfaC+IPRaXeKL0kwvU6ISzYerVDljPB7y+al55H4HafuOOWn2tH30EP7lAb0aIXKDSuOARXrzyCBujgPff7CMIHf+C3yW9R1nvL5N85gNXXrzPa/IyUk/mqoa1aBarx/tWTx6NphVLVzemPWigdiVbN601YLoHmm4to0rHX5mKPtOtsH1TsbbA/MoIfNXB7moQ/00py5QgkfMus6nsJ2j8lVXhZz3zVWPiA3/JH+wn+EBkQ1cDM9xST9016Dc43x7gx3lORsfcu2ICn8YwDWoT6He8dX/7r9B/FHWHMeThEZvcKe8AT2AtZhUxoz69T7boI/6N+Adytu63I+LFLcH+bEXUI0U5DXa9e20FPenQv3d0iN+yF/kxnAHEs3oz5l+JYGbIA7pZPzS6Ucs3ElVvye22oICtQBylpMLZaUq9g0c6SPma/JPTN/DmzRyXePPGd87JHiU39CWVxVWSIsgZR+VdxXAePEZNNoe1RXqrFT6gzGyRcMQz2lQ1/PwePm9t+xLXrhWNhU/81eCb0zOL1pdDPI8x+IWVlVTSqg7ig/fZg8fL45y2gOM8av0T5VaHxH3rPj83snmeGrkFllPOPT9FnRbej8r23aBLa2Fa8AnhPTwp5lxyNx3541123mdqr3ylsTZgzKAn85qSarhSd7twP9BAyIaRduW1uqsQoJ2TBi2d2+FKtYR4O1TYwfcYRpKKhUXJHreAQ0GK8dmYRwe2vjGD3GbXuGaI5cPx/DaGBcakA8+SDOUK2z+D8Frol29n4sBLOI+fpjTnXQ9wd1AbmbFrNIkn6Yx6ydL1xuzjzdcmI72i3TRZBn5HN3Qd0dgQ92bLiQETKXaq0EctA14vGd153jug+mC3Qz3W0Zjzrsx3oV70aW8M0ItvsvN7/pXuuvj8gFNZDcbTRB8iR702HC7WzM6qdqIK8iPvAjnLxVobhspO2Es0FlijTNMs5thMp6TmVLscmO4g5lyFdWdZnhCXaa9cOWfffO0sy9egCvoyIjuLV9faqcZ54I522YOfZ/YTbLeEcfkv242x92Nuf/dNQ67+gLZk0MbsqmgtbM67oUMfyQ3O8uiG9dTOsmFcrk8uF7QvfavgW9Sxz8RYWFxb1/+WfvOdXbONubwD/uiyi+rwOMz3D2O7708csdc48rOlzDW4ix61cVbwTOvZF/AdII/H7J3H42qlURaTDxGRjgSzUXGT2ahKyGK21meeYsxP1zi/wBnGH3K4cxny0+hvrmdqwVltZpyzOlZHg2imHA6I2XMsHnOdKtCrI6+Aa29vAjcP8efwv0/WVeDikTr492gJ/EErSBxIlKv5jV8D/XXga1DqK5300U5rwJ8EHccZKdv7snc12Npj/82M/rKRh8K2VtvK+cjpLcIus4Fj4PwGn3pleDwm3jRU5KmZOch9AXyHQ0NOCA+31No9AbTMctsrD0FvjI3B14Pnvb5sj6uIW8NeceJdY37wMBqUx2FiriY+aszrP7GtT7/xl35o9ZN+6OmTfuj8C2tUn/U3kZdswaxmpF5hb+OY4PNFSxb3Sk9983NyqRZnQMd8zY8gVr52joMd9+df/Ke90uD9SKW4h3NWWUIOVFGllitVXjQWq//gf+r2cQi1+yghDekA8whtyD375GMIMz8t3zI2VKtkk0EdAvhShXl9ND0uIE99RD5i4mD+nhL2djlHnQXI6bN11h4LaH+qWM9la1dKMX+5PlVZzNYEjLh+gv4nRYxVwHSqq2Wms/hbuSZKNXc0YX8mjLjL/Ey8JuZ93vbOv8mfyU0gj5M6xvLL1Vd50KnS+fKoS4xncN7vIH7QVtT/b4zZOTjNbw6LVeRySWN+j3fo+Ne0cT4yv+a0UTE2SuUS1Wod4kZG/mNZVCAXxMZqXnvwCNpCltz9JIVz8cZ8PRH0y2bjQhetD/gvyM+txwpiMG7H3ndXX4+/2d/Yszmr8eTI4kd2L+CqJpwcrBfA5eDZssT4kv1tY045z18Lcpojdp9pZcfvg9978haWjDzs7dl9zJPONu0ic9j12Xm/0ZAnrtXbddgYXSCfup0gV1eOPAX7VBnIugTcDl/jgkcQ+qAqK7ucgP07ncIX+ydXNB8wFiv5ahR9kS95klKipISh6XatYzTSrfYC7p/LFbmpy9iP1UQOkoE7k4v9a1ihK4i63I4lQ3D9rlKGGt30iFhhSxwjBkup58iP5imndSaVTA2e30pBoLLgO3UKP0k0oVcU4mVN74fa1ba2SE2ZqXlzlkh2ajl07ep0qtRriJZi54/+4AM2pxxja++2O9LiqPssPnBKErUdl6qydML6t5VNMqU+IR29GfbGov31vG1LqVc99KX1pJLvTtpFT7S8ftLO7OdVP2kn+OmvBqQ1UdJdqO3WxzjHKzUATkkN10A9wdpogmsEPrfGejz7TJ/9zNnPAft5ZD+H7OeO/TThuz7/7p3564lffLfdUZoz1Qh10f1yBS3blq/QV+0hX1qf7ZUc9gqsg3JJvQrnNXLbvcUmxc960GbX7AMfQArcA/T/GXx+A1qwdcChlHr4/d/5H7RfamG/ChsbDq/lUnoK2DXf+zcxTzZIKYbW0P/qjIZPn2m+c4Ma8FiBbuVgFmF88sa18Im/xoH7f7HzBnDjbM8wf1a7EwcanHlwrxpypuln4vULl7s50KdZq0UqvWApjM0Q42Dml+1yrj04UXag1fdayxd7m8Gjjj+OIU9V7yKmGPrKK8CrsUM91YWJePA+xJlun+vjhsgBA3E3+88QLXFAuIsx+helOvgqE7UZOBfk8EHch1Cpi+R7tlGLDPxKWUO+M/w8s+3EGTJcsed2p94pctn9l0nBVyG9jiFgbl+473/6gVPwAYVBm7BVXcx5gA/ogA8oIPce4q30N14BCXrzW+VHrG/Fs4RqZDXgxKzUSXNIePCLxnJS9GT8P+K+ZUtVJdj2g2wIiKhNEBBQEVRU7KkoCCpW+UD9+psRkahVy7X3PuOcMW6jRhWWQD4j4zmnM+3+fJ6eXO8y1qjWw5DjdACv9Sxk6x7m1vXm6wzmpV3gvLTJp3J2i06uVmtTOfBa4mkQ90m2MB1E/ei/5OsH9CFYK1PMYcgRDwnX1Nt62lOueCWdJTz/Runtu9BGJafaLepXugPu5y/VFCLQB8N0/8f66e+dZ337TIX4dIj1gAuwQ2j9gA3AbO09zP38i7A3qr/m3of3It4J073NdpfjaAtaPl5Gasj2Nvs9hDU5/N+tgUGn88camC7Sf18D22nCMddgDUzs1a81kFQSbtsoWtf52xoI8+DzGhiO0k9r4PS2BorB1qH5ojXwyf/Pa9imICegnQM7Rv7xSP3O16C3Ac9Rzfc+5T/3N9U8sAn70JtFTcIwm6pw5FyGiPesXYYFxwCraxfV5nmhE9BjcqPMXUVdc7tISvvaFmV7kPjbcnwGqPMzubo9wr75lH83Wx+mUDP+Cz/gd/wNbT1od8vul753sD+JX6OY9IgPD3N5XG/DjG3APLgFjoQ4BrcHl33gC/zSEUdP2Cly8y0elBbhpsQtF1pijHgKPX1YnfJxYLKxlx8tWg8F2ycb4hWHuVizdV+wNXNUBgOD2/Hh79qLz/gNv/MvmH6HNvweY4ho7920N77WWEgQ40xrQr5kpH6qMcezbB8TPmprNiMsCnMIU9WuE55Dp25zrPAq1E0T/jkbV8i73R4A5+2JvaC39RL7K53FsTJYWGUt4CZfUa23XmH7re1/rD+LXH7ONlm7EqFs17aWU7sWo/i9XU7xt3bF4o929ZT2j3ZZo2e7dJu3qy+ZWM/+V/yM9/G3TmuVbOU01DGXdTufhRxj91H6DwvOD1LmRKVjUW/zvGrXxrzqWoh+/rMKfhff0PPFEbk69ALmq6IXozbUeO53F+CCebB2uh3tWQsn6KhDy5zHGu4f/OX+e3l/b0C5cuHMp/biu51kyfshaKqiLtaESQB1LV4MsRmo3zrOgGukUkUbuSfzfNFePpQDlCk6Owd1XqtLNmPHRHzhojkk/a7pGWGAejz8r1v+b/j8H9kp/TVhiKMyq3cSH9ymTQ1lRXtKOQTLaVy9vs1xuzV9x/2o2j7XcQSb+yQqW8RVMTfke5ndNcIHspTOFz0TOdnEc4663BacG4jNmBv73iQBP+gx1+VooqMck1pt4jhzo62ejyGI2l+YGvr1j8BF3eG1GtXLPkdZ3wTMXxynYKFTrmj1GhNGmQ7tpf+ZOr53v9t6JD/P05SvMSmHPg/xzEGutzPsEbauDchR+5bh+fvoBvfJs6Uup+s27SGxq1K8yvQPLZK1yWJJvibAL+FrYsrXhGCeO80y/83e1mt8be+gzrqnzRou99nGo35kfuE56wBGWiPi+WUnOEdn+ubl2xVb+SAe0p7em3vqW2+5Itt+afvc55CAa4P1/7Jb8/7Lg+1uQ75vs3ImDFymT0CdwqGNc3gSv1zSpcylNYXxnPD2JxGOXT8dSQP6rhCl8unF5XRhJ8YGMdQtkDXrOCZ5vvKGZKPVAas6H1n9lzwH/p/GzObrryCM60tE87V3asG9x9/L7j3kK/nJEbonfrxLi/ffqbDvfs9h77Eza8bPmUpcjyk2cq3egkxQ1Se+DdhNuN+rLb+N+Yjb3jnie1eeFtCmqqjabExa+QbyB5I4Jl+hKG5KXW7UO67GcI+xXXfrxAPE7JGY5maFbXvjTXnzbRbI3QS4cpMu4OEhzpWv551D8x3nCZHD6Yz0dBtjkAbXhwElu61gsbwxgvaDH8qJ49JOlp02x5eKfZ7zObMt3MPDSbqlvrhav4m+PcyfucTDFW97uWbQB5rd3eUCzn1REyh/QQPMhXRFnEnzzh/4ab3rkubiYRsQI+DtPol74PMaJOdNidWFMQLoO50rcbMfo37n07nSyFFvw/u3jZrBz4a1Yu610o5Pd5lF9Zsy+Di1kdpqF8Hd9QArn4/BOQ45xtbaQVwboGgSAMsLMfiRC4fZ5DLfn2bRk1FqlnW46Vg41RADeK2Ve5bZdDHi6DJ96SZQoAPW3RqxeMhWnXRk4h5E/qo4HLnW97h9eOiyfgF7d6y6RdsotCbmfKQAOUr5mYOB9sRnieqANeMrptNEvoipFGPugF6/4HcWtF7xvq5E7ROR30rcQ3wafVx1JlckDddEp2/EQazdvSrEY0KoqbDbh1CX2zq0aeSk3x3pA38FYDa0z7qhVtQQxgU4PXABVry+GsI8d3mu1hr2p6Itb89c7GmtwrFpvmc/4vdoV+uKvWs8c/8Qe3KI2OmObbzicZfUych3xWyZtVqOBdRyQc5rNN9W2yV2FsTGL1sRSv0A3wF8t+xMcHCcIDa5ss4ek0H6qm+RP2R0hJqaagVk+mn7ib+DCe9vXfrNXw+13Vm9qlaYXU3YTIC3I8H71/F4XXKjhYcZ1NXdIIY8K1BvYu/U3t65fNUPJWmlcvL+GP/ayef1Ui0txnqppi4XkkYybo/6Klv3yznkFaKM6nnDq4z250HmWGRPjpZsHXPsC6YnrJ56AnvPI3i0uN0NOR/MnkSfRbokflA2frLinCuln+Sr9np2nZ1FzhCcTBAPGUI8Du9h8rf/IB8eO09HOp8HgZ3PZ9K7UMZg7gvs+6Z1KmMo/obrr2rBc/9mI+TSvYop+k0LoSNr8ctf38i2vd2KnxsrKz/OZI6TOJ4T1mTJ4bLXNze8FrENRcVo8Zo7dq73QUZdpd0vP4a+RfykjmU/13aX6k15XMCiuMDdudJ58ho34Lb21j62q1FDHUHxoOSH+7b4Z8/2PMekkY+P+rO9ujy8cTxtpm+3ELv4Kom7qJNc5+pPfPx6xuT3Ot3ceF6oLvtYe4y5TEGmDx+Q3xm5YG/9aKe190sOyvUMcmfKMd661zXpAsDntK3T+Q1nSdiEc3I72vgYt8W9WfprYcwVrl8nG37OhlO6F+t2QY5NuC66b2V8Pgw+H61KHG8Q+79VhDOmZs/6vzCW56wPs7zf35R57IZEtZJQu+GoQohx8THTN8sc8+oldVPqb03pi020w1XORb2s5Vymgk4yuVPbHWmdfm3U9/4B+THpWdi/yn5Z4qz9gf+2ZrKtMcM+KnoHOEKOS4z54Xo7bfA5TG8enAKScfWf8r5/PL7qXZZ5Veb9qMRVuFcZz5plzujXPuN1FkyvWdNZLPHvs7Fc4veHVrOcY/2AeZF0zj/E9IF8scs1yWwf9NxsTTIB/RmFhf7yng95Wg0Jz03SwcsaVcjRtqqBjmfhkytX6a0HwO1VrWzba7XM1b20YuLojGgMLmKps7cq2/264GeiU2+gzAGZgnNzaj2Ab4lisM5LV4TzI4L1hfq20r7J5dkC+EClLjJrkl1pTnXk07Mlnme4rP86+8WZCDaPdmxw+5fZOOjTzcGnuwJ8Db53FLvich1S5bqEDlhk1znJgu3sDDUoD8CTC0XQOUp7d6eH4Puf8z4Ebg61bC2QZUv6LPWFY0znSYhn5kD2n75qizDca+s0jgqe69U7PhbWRJh3WrVlFt+Am4I97w2fM7H7q7rdXoVsFrP3vATMSQghyN2NNcyZ8fnaRNsiTecFceqEfE+Xa8ywy3lL/HXM581IFJo3LvP0m/LiWPSAs+XY3XyjHXNe8nFia9Iif0XvinYbezZcg49h4EjYVrTbLy206RtkR/Oaasjf1Jj+LsNaPdXCpw/LWiO/I5O1Urm/q4p7q+NnCs0ZttmaKLAmYuvJbe56m+8KxyBuPHyONW+dd0+fyFg8AmfbNY1f8YxBcl/j2O0Kriv2t1PIg7m4OZcpI9AXZ3EBfAZfoO9AbSzkPdanpI+GB1WxBK+c60oto3GZ4ZhXzVDv8JwKrP/cD9LvFP0hJ1Pk/CsU11O9ZMPX9HT2Mb/0HS/6JtOeLXV6d/R9w3vn9DmMvYT7djvEvcxsN5St8liNxg7N79DrvPsTLMt/6SHV5qTVp7r32mArrEs/pueAzvLdDgh3VyY+n951wc+NxhTnTnEd4Yc/yk7qpT/Khog7rhUTMEXRrn/MVqCjkr+636rRmpRi2n8X8Yv6Mop++lftZ7sG7ChR21XCSmBSGGSCda5hLLDQ2y2I53ns/FFSCCTj9RA4LMUUamJy4KzEa7nGrishXH955XXzzX4CjiqhOaG8pZOjJpDXYfuTCH2WNuSyDFWvawgxzPFiZbzn12n6rTMYIIeM4RlhmBPvzH5g42eSkySxTli77IWAgcrGZvqal54XPnolLoGPn8Pe2TtJhveBDH1UKSY/ifo8x/8SC+FLZ+woaovwY8M5vmMU7qdTlXL9xj74l4UcdAYk7mCftYO4MY4SEXGfRrwODnEpfcAY2oBf3TBF4I8UPfDRtvVjqwZ1cckCfCU/7c9/GT/wvYQWvaPgsYxQuqzQF7nvHRKV91PYUT8FcXcAnpH0GKA9se+E1BfU8xqX+BiVdTtozxo8R04NyZ96d9eIwaQW8H+7QzrlGzbzFvLEu5T3tt5ueG54bxni+RvOc857d1XUXY3aFqgVatskmJX57ak2Z+/bPmpX2I+KqtX4HBR0f4YyZs7P5xHwjspyQfNzmXZpffS+y/XRCGOeK9k6fNNZ6QlxY8PmyRb22i1ROadO5Px1rga7bbxpVBVNFEu/8A/7Sa0ojfFt4k/mNuBSAC9lQ004NswW6jR6etCmGv8C+CprMeW0iC74WztMpl9qOF/u9gE4LLEN/WQ65Pca+sP2L/nSLo+Ar79MpHW8LWatK/lBAEP3DL79gTCLo9ERZLmNPBmFSJ8NsSZzzvEIAfsQ486zgK21a9BUfFGC82KF++Wv66/EMpBh3x4a73mxmpsuZOTqGIXS+oR5LZJ7jMu5qNu0jy+VBfVLisgGuFLMYGrRuVnNJzXKRQb+5/Mpsa8HZ7eqTU4o19CXUtoGTN9bkbzUUuJLX0LekDyX1aL0YVGNsjednZHf8iknwEe4NCn2YoOfTAybdNbo0zGtC6aHLg88nkA1nRq2YbUmjqvSrn1Mrg2SuRvIOUd7c63nwozvsUqarIpnPgCzJSc94mnaiSe2X684RnrVDHoa8Z0JXmIWWsnRzMaTySPKE+I4B04aLlWeR2vu2TOSlK+JYEr7zNy9sPIiiNOzs2zTK31BaYv7gyOwswfpbIyxLEGUvLLNcRyVNf0WvBzjeZAvDhz3aukDdtcXwuxcLkNqDzuzl+QDTC7IIeluFw1qK5Ohd7XkgU9zTNEF2fnkngd/5c7MDB6XBntjwnmtB2Lywihu5PIen+NOVmUuJuQB33tHzFGp5vfMf8OZ3l4TinG09oNkDwYP1PYWeL4sc1izymCScN2c5xufxGGjyX29bF2Fen6aoq/RrFvDEepY6vDB9ZYc3p8PkoS/B/zevcsgpnhTQy/wHQLaqg7UI9b3ZV0u6RHXb/JjNgZJZVXKyt7tzrEEe0PI82ikOeVpX4qmivwXbtmvL4O4e1Qb+XTh+0wfZF0CGcDsai4v5peC56LpZ1OwgojaivqhfrN4PZmAeLERyLbW+FEN1TSfHQzApfuv8g9iz5QLh0FDis9vi0n9+X7MhZPc70uMcax03pC57OD8cehf/iE3uDzsg4+X6QOVimqX50a68rmPxcN4q+uuTAH2+9m4Yk6qvpwNnpytUR2wEtBGyC0DfStM3ooUa6oYtEb3btIekTxjbf3C62FRXues7df2mGPYXpqOFZMMb/gZna1sT7aHucrxCE6DZAtt9P2mn7THOWK23AGnhK1B288qeOY2j5Rj1TL1xoLJ3bg8n3DNL2fGu29df3EohC8OBTyf3eu8M3k/nzPkTgC9YbmuEK7+3IY9gO8PwmLU253nM/cRTiPItwVejDd+Q+ReGEwhB/YQe12b9GfWl+Fwz77X2V3Y+4T5zDmDbhHzfIvFtJ5EHSbLB+KTFwHkw2Mpk3z4wrVhbruKz+uFaopdHZHNTrnI9QPPUYpqN643XGB/KKbZBa4BtfjBi1Bbcl/b6krywV27sIfyXvaNMRk2p7ZK64fNmdrm+zcGX/OXgbmyA8K4Ag45lPmnFdU5ngu1It0NPHPQr33dT+6rfeuu/j6X1vGyR3nT5wLke3ssk4zRrmArVn1aX0PIaUasGsk9t32V1rl0clxsF5PxfhZwuQ95M3Ddf54DHDezUWS4L+C8XIA+5GeLcv8s4dwtMtonTC9sD1EfUqzj9WcO/3e+xjgZ053aY36GszXtxsTPyNa0jPKGja/68geXvJbxIKkvi/eaif5Tf+R+TXfRxus4lFrZPHjPxQGu7H6OcfIG5vQ7PpOTl6CuTYzddDhpmWyMoI6kHuwcL0Db5cbuOck/1yzTB8Vfa5bdN4Xn1cA+dSHe0VjQuszms+FutRftbTjgsa3kuNybAuiWDWa3xXLM9etZ94rrdq9jfLO/0IlZhOpnUhf9mg7Vn6TpkrjDWtKFcpTd0Rk8nvk4S8HG1/k6v2Itojc8c//MtcHPY9nCur/vEenphmPExDe4fM492M1UW12DGM5BYjqmiteSVOC50ZlTXGXKFMvGEnDHzgXGILYVtkfvyxrVzb3wqvWdogXf5VmmDJwz1QDVUHder0PUQ5ev+p7J/VsmvI4YY4A1LtfddY/HVCvb9oLXMJA+MjlzfSYcrVadp00eeuR/wFrJ/HYPJKc5SHfLUvfwJieuexB30KSi4PWjwf5WlJe+1KS4Ub3MPZb0gudmQJwyDT1+dr50wvjx1JnIP2k5OdeZIE+ddCYfeYtAZwJvG85RCnrdIC2GFCMXm+ui1JnqfIwshfxRP3Qm0PdQZ/JHZOcvvafO1Pim3MG4opLet7hy/W4/fteZvszsTWfSuM60p/xbyOdbcv/qbJrj2lDd5bveVDHzd70JdAmR7oV8mTTxuE6OPvT+nNcRSaFiiWA7IA4Km9M1s9F1hWSCMiWd5Mkr704gqQ3xiGBNxuw5Oc0T4G4jtsic5hfqf0BvSfPoQPgM10spc5ZcZzo/daaqFP7QmcRGzHWm7WzJ95XiTqjGu0H5ycodntXIuUyTuN6UbjguTvl+E9/P5F8G56qex3ucj562GQilnc3sKD8a3vpQjxmvqE6WfFCtH7ZUVVJtxdpBLfT+v+RvVYS764azAn3lY3HK9T/kzFbarknn4ZA45JhsQec32CkLpUZyfI74xoKYv3CXJpC3L7bgDKtf0uoEn3litsR5bQBfZW3oAk+dzfZwpahLwdiqKp7G9mK7t9KZ3SWqAun+7tdbHBd9KhcpKH2KGjrwaq2HH6SafH/3CWjEwyW5b9xcutqPrt+TgOLFlA+YKNNSriwbz/oF1cgS8XISwbdzmAaQZxS/+7TBj1iVMsJ51spYJuaY1n/WhNW5f00qlM5xRrIGanycj5hHf8GPAb4rm8tuHfDz7sDZCfwry5LzU2jJiBcC9WNDlPmi4FE+FsQYMJ/qq/1nPtXeqQccbwxxwRv5dcJ9f8ZwX+YhbgFJhK3v69M/7GhVkZ0JWPOCtY/qAmru2GZGPgSw7Xh7zGlyK+3ZC8oPdthriMmxVjx3R7nZEZcRc3xu2wi88yVyYrYYLcp/ehjIWZCgXlbtZGV8M14Qh48Utef4vwnOi+S0AvIvMftrMuc5RqA3EF5a64i4AVlwawTBDblH2VhCbu8yQzlG3J5elD39r4DVRmvW9fyD+WfO+lN+Q56lzXRWA/kOJoBrimO0W/A68rF6yHV5hCsHc9Tu+yd20zKEHDCwKSX6rHLOEceqIvDxvBVPvtXeOeRnuAClgtftWy3AIDYXJOdcwFYbQQ7FJAbOnTp7/5G9f/D+/oC//3vKz/fl8ywTA2rHtb9CXtiwrDUYLjBfDfSniU18XXgmp74grwh7W9wbWN+HPoltJy75eRG3LSA5x9YsUOtAbs2ss+Q1l8Ugnky5nL4Mtsa8zGVvHwlvdpN+Ww9Lgnff6Pzi766Nlzzmhb5/HWAxPvnsB/5f7UeRuFjGzO4APsFhwnTbQMac3rrUf/l6h5dG6et9SM9cX9cLDieKdQTdC7WFnWfHEdc1EBPoOO2TbTGK3/21/p8+wH1tXpQx0f+J/2/fm23ZuEsy68dZguvNWH1ylnUHW3OOtsj5bA9SI6Z8YiZzcd9zmdvIz1P7GcNZt/V8gXE+jIPqc+7/voGd1Ql/yq+Ja2/FJtg21y7FvXbwPqrbaEFdW6RE5v4/8jfBGmsVLuSrbg9z0ltEQJtndmuujUC/U6GutdDvsdnd4+fH4Qp0BvgscQu1ORwzmwdwb5xe7qE89+2SJwDt8cWeYiX6/HBEvbfmu1hPP+cYqWxP6z6vGY+U+zOeuWHXqy+8TqKTl+hCh9fljjBX64+63K3cUV88yOks7ih2kjxlzWMm19RXDgmXQ/3tQ6yceK084DuCLCOcx1OrCSGDQTqa83ryAzjZYGxm2ul9bKJp8c9jw/NO51wHrt6C6+nJDdnaL2aJEM2c3c/8gU1emapP36YbHFYvfqxevuiUuAAUa67h731zvt/JkTW5z0eifT0Md2vwj6r6iTB1b3EZn9o+AqHG8X5ysiWYvR0f5qXfMzxUcBx6rXRZm1yYaIn7P9qX5vFb+7yhFcEZ2e74Tx2djflNKp45VQtmL6flWd/s9J+84tj2jPUxWi5xXNWpBcxI4E85wXhPb9803jOVY/jl4xXUThcZ1K5q7SH6mfe0/yvMJhWXwB05ELFeWJXexnF2XXJbGcdxtef1/dCGSxKNSzvF3KU892gvYVti05FONM9LaGNwKttYQPwLPjNqUE/bdzQV+MQywvziz4Hz+C6JJ8TYrU4IZ6TlLPfufT4Vd8tsW3kSgA4O+cZslvwaPXf9WLzkXC9XJPvV5gxyKmj8tKhxwL7dfeATbgKnSRX+F8C5gv7XNy7lCeW2PWYd6YXN21a6ky2PKTclnl96jXLul9t6IceAwnr/Xn0bzYbCUpLVRrZvva091E2Uifwadzal7+M+7bz3AWrNzObPGNSzNid8q835nj25ek9it5VzOyrBZ3amdmm3HcP4yaO0IWyCk6jD92E9bbTj+/5tTbN/2b+YCzkKMd+nTvtBRb+CdouXVWb+YH/d9/4uavNnjg1r27FjvPUXuO+S06isySI5BXb3RPJpre322dtamy4X/n9Ya+abvCuCoI5jcFpp7H2OCm0EGQvw9mUcAdcB8HA+vsje92Gcgigrz6Nl2edwWpdCZic3sm31Nc+1fLMTXn3eLMN3GdWYqq8+B/ceynyolwnPTQ2w1DdNL3EFje8zVUK8sklcygjxXf5trJDvI8C9jZVuFD9zNkb3C+WD/nq2k/NnTxsgAhRbez4767w9e/F4f3audJzXs9fr88dnmyv+7ImEz9bPz2eP3uXNdBM+9z+z6ay9+uTvzRXOPR8Bx2hhIs9zUTFMn/wD7hjINfW8JTbLdQ2D8Fz/dit+xnzlS7qYFSXmxmRDfDzIC9PbqIBpABgM43GJjdI4I4brg99jKX138zobZhuRf455s8588xyP4eXzeDjcjnlMFbGg+pHlhMdowzH2Y0X9YOOdzsqxCnZl35LtrHj1bUf1386NY5MqOm8f+nZP5zMsWANlW2+zACxm8Ce16DfKObiOaH2DLwoxzIY/7cNNNf6zvvj8X/CPfF571wJdbTjJn/rr2gNMwIjZLpPaR9sQarppb02nr1qA9Jvnnim9q8xz5qqm/3V6ypCozuy4FbNhxJ30q55vHv/Bv/jEZ1LUHY1bIcoyclqtjHaZVzupAYes2YQ5CawJ6lezWq60k/Wzhu1VvwzxHlOmM6GpibWqM++Cb+ZP/ATO9/iH/b1zIXYJ8uYAz7nFvqV6zcl8cSr1YbY2rpMyZ+Y6of2hhw92JumaohmZGnRsTQWurQix16r34AJL4a/1g6JGmFgbwEmeuM/3MnnkBN9w1nX0Rnhy2H6sKiWndUet+qZoQnvG1QnnOc8DaE/fyo2RTzxLRtfW2i7Kuz/wBzfN3UXB82bzd/wsxPZn5/aY5PabDAgKwjhpGPvKfG+eVlLwE+foAxYO2/fnL34+EiZOExkGFSdZcPvWV9QzYpBeOsN7OF0ptvqsm5TfcdoIR/1kLqCcEXwHaWGMw1n1Yg3v0RT3FvCjyH7o1dRgrz8qQ+C1k8nHNZyXY3Yx0ZdatS03X0zn7Aj/kbucK6o7p/UZxDLWmKlNTWVjD7Jz1AuedrnuMoHQPqJiYAX90bL5Fp9h59b7tdGpRJYjzoNnbnltqvL8ZAMECz7TJmxJjBEdp+rTt11j9u2Ky7KbULzyABRXI93xMZl9+U+bYcoxMYsPHJRV+c/63THhpp1aXYV8LiLp7hRzKP/G2vhkyHOZI/WLn8lVwEvCeMM7Nh685w1/Bu27cv9TXwoBKhN/7v9CgAQy2A893Gebxgbq8jQV47mRAnr8BsZhlgoxxdgN0L1HpS4O1iLTR1Bvqvk/9RGxpQzS25TXMU/Nc1RIf6m/3D3lFWAbVhTb4XW9koZ4UauVocdlm0UFPvNXIfsMr6W3a8DURb4IwIR3J73R69za58+c21ktLPmPFStalGdR/JLjTpXJA0XBM8iUar7DsayQjwhrVMq5/og/B37m2ZrWUGGBLDh9feb/fsP/0RttnJNRjfjE0S6usvODGV5Ufx2A7QzzpK+5vHBLefFFOVR1bvuwfc3t61722hfM1hpHWEttM1nRP77O21b2Rf5xdz7IKce7Zit9h+MazuHaf2JO6DdeE73JBR6/2ESIJ4rjqgzqkydWAPvOeZJxfWY5fMWGvvMJfs7mKbrv+edgn/Bz/Jm/Ff3CKdzEP8ZvwuTe9HHkOMuKd6V83TX68G3wiVTv0zH8/1P9L467ycZkc82/eDv1dYoy8lb4vTKupa+t3585szWOZQH6yhZBeF95kFxXP44jirGATSH89Am4m3Wa703ys91M4DAevNdPP3POBKgDv8R38quf3FUE5+LB0lS5xBx1F+efn4FdD1zCwzXIq6AnqE88ttHxiUUmtiTKwQbbv5iWtq9+DF9+GLZ3FqMd+WHOQpkDu0N+KODmLXGfaY5K/CuME//0X5H/D3kyjiGPZyJ2RQV1woPH9Y9C6Sczrn/4UDf/0j+YNqK+6R/j7u6j/rHe1rqgg66QL3vzb/mXwFMpIjdKkmpZrDVBB5DPFW2QNOhc2HUALwb4HfQRxcK3QWyjLyk8dAi7CPyL5z9ybUAu/+X9IO9yZp8N2GcTyB1sM31jPfyZN6i0JyHVEoY28L3he4w/3/GL/0iueDzwUkAM3XjFcOyZF/k72wZbR1jB+No2u7vFzETkhgKcC7F2/AaQy1/zx7//A//M95DDMwT7Yq1N7AvkD3NuolHbao/0nWJYofFX/gm6v4f3s3EZzHI/iof/hv+P5xvyz9tCS4sK8nkP5+iD2o91jP1FvvbEbO6Y3F+WUW4UDJguD6sldmUBnMkZ8nENbI5nDVjgTI+q+OAHT1uA8dUZjQ9S5It26o/ZXHqqb8T1W80eAbY14LY3Sd/YTfyy7nDXAr6YYUJ477iWVM4B6JccgJMnt93QPhwRg/ydAzAADkAHOAD9Udud+sABOAYOQKHTj5heO5sS/2G74xPvnGOnwTfw7XWB6wliWzXhoNWLudNebb5HfnPjow0nyX/4v72qrss6xl/G+uFbl6URlzGGFCCn3+7F6adXcY7/eAfgDYSAu1oZray9Znz1dB32jJSP83PWVxPQFU1mn1YGRqFBPlcUprkuYf0cYKaw+w3Azp58GV+OqWuD7dSHulR9PU4g9mejntk5HkjWb/LWzi+5nzj+NXBpBTeMGQccPxNqx3bkj56tCP9aKRL8fGFSjmpfIFn8iWfpP+J3uN4oXXBf9XGC+CPFBds5lYCTLiKfCPIrHIIXbwvivrI1WahP233rrg3VO2dxXNaRCBWnn85c0KnanpBqSjy3B1Ei6sHW1VyoV9aAw9BaxTfgDtLxPO4dx4SDAHmeZ90w+BgHhs/We882Oi2qkTqM68HBuhFvn7Fd7zg/pU68i6HX8oHDD3jP18RnOW676ft6BCxX5D5vx+/8n47eePRHoWg4HlvIqyHG3Ik37mAT9yHTd25N4kFErhz1LX/+UL3FFapJN4R6I664CNHF1pXmmcTJt3ly8sXIycfrjJ+cfIifbgD/0Rj46VeA4Vn4wFHXbMeI1wu4LwZwL1nsnq3od9pMN9moIdQtu+BHWQGnh+8zeb1r6jHY+RnwL63UAHmWkMtHHeq5Puk/fTx+Vy1zGpsBxoZmGVuXV1qX37Quma27NSkXHOu+kf8nsz9zy/zEn/yTvxQwffQprb9pfYo+teJE64/N1w++2cQK1HL97blM9Bf/sv7cdDp/X3/9wUZj62/P1t/80/rbK+5xyM8w/41/imTt77VXfV970Z9rD3A9N4lr1+rsXPZMj8mchh/eJEEyqzWfyb+MyaaWkwabqnIP6PwA7PuiohJPTFFXauKdnbtGjThKj1yesX2VVkcjy+I16JyjlLhdZH/obMUQ8i2kAVsXmgocbkW3TfWcfZyz8Dzsq01fU0N2SBeoM+D3ZvC9fW80jsE2glhhH9bJUkQbH/R3cwUronKhnEmvPuQ+Nrscr/Zf+DX+E/9LOwH+tFzk+U7oYh3EzS7Wmu7OkLM+Q3yDFp6VZ0F+5p0g/rVaMZLYKH2VTP4mKps7+/2cZDpMjzDJ3vmI47pkBS7sKwGwawyN+IgD5CNGPGPFmPi8lv9tbcCaO8Uld+Eo8nYvDu6Ro5S8xCSnnLgqvniJQS9fabYtum/rYw6444hL6jztB/3B9KfmPdu6/rXF9CEHsNRk5Gp/zT07J/TvYYDnBfJ6/uS/9b3YRb+MO1gXXrpA7KzuthgngHkRDWb0DuDJ8/76jnJ9MZnThzPv8WF92dtbwfTMc1OD/DwmmyB3I1LD8N9lU8kNxw6+oYY8EZ3Bdjx+1kadohsEnRGHGY5Tl2qsM/LVTiCHI7K9ZAgJVdWjy7FBa5W4HXC+xlN5nvjJZ94x8WP+TU54wIeLD3X3nCd8dmM64ObMdJ3GBnS73CW8H3dpTrDeo32gGmNoQzZy5tGQyQoH1+1JKDjmPcYVEUtXl0dTzA+GXD2md43+4F7m8qW/6ZTrS2brq56V3Mtz0Lsg96rtY35GYts1B9aWgWtLBY5HwFScxgpTFUmWaO/8ywPMt+iRTxRwVoWKVuKtAp+H8RBANq5KXNZEw3Fn3xn6MG/NtgrnUwi1/DXkQAr1/HsPOi5xNUM8ZIQ8fsCf7UclB3QaNEA/gzUhUr5oCvqZDTrg8Ei5oX/of5tqh+l/fayvHR/2uizi36P8ZLSEX/rfDPW/zp/PB/3PLpBblffHVRPUU9l6PVF/mP6nusrAm5uiagpmADogOzs7rF+V0/IXfgv+L5J0zsW21cdow56roG8dxhzDNkrzTXYq88dBF0Sdi63rL6W7I/zCqJYvghPWIp6zZvySK8TjJQRpTQjiBDiGH1mqNeI5m5txzTfY50Y6VpAjnY2DWjG3VajzjbEeddQ++C8edMivOaXv/LvFt/zk323GlaCI0yFrf9ASAH/quxqN2P7fOHa16TAZ6YjSZqmps3GgLLAW4BN+GbuvV43UDcqY4nIyLwZ9ztYK8PF2lNEM0vmkITOEovaK9TePr89znJ3V1TriYN0tYfO0N2S2Bl2PrafMUu4TxJ5mwptz9abfDujHaAvJgAG0B7tVqGyjEcmTxagftY2yjordWweiAENyvGyr3bofsHtLO0/+N/xlyHeqa9vN0N3WBJj7zS9ua1+gmhExCIBjLg4cXk8NdtjQ3u1Eg+1t5Gjfjkccr4L8IG4Vedq7ebvUk4mXudN86ibGi8/6zVZL8OwLvSauj4y1Bc7HIEKdamvE6YTtbSYTq8wOOkFuHPhaNsv0ezmn8wdsUXmFnCfI9QxY+siZy8Z7vNj+Ay9VS0V+6x+ck2estdKADygokA8I8TQEidnnWR/OxshVUafIiX/SH21alsHlDZyPOnE8d0HesX0oI/4ocQfs/+R/D9n5J3D+99BLp5jrDOff/R/OvwJ95a/zz9V5+1m7ZqCbR9DmRwF2ZQtqwJYq1vMZj4znlQjjQZs4lfBvA+WyTut8eMZY/CIrcwPSqjm/z8rYoWJGXfKdNvORzUx5fp5Jg2Q0euYHYe0ZcH5gLcUmCDmWQdwaqf9TPvpI/ZOPflIFv/6ffPQOzj+c6V+D/87f7XP+bvszf/cR/H1U6/Vbfiyf8uMB8iMocX1mNp8f7T7I5tDWVjYL1Jl/wH3BMQKpP17FJx5vtpDKPVIB7HCQk456Oe2UgeNQrcBMVe4QKwtBP7yoTJbUrwnF5pisWAQxl92pNeQ8DUpv4jx5wFeEbfKRh+rv+KFao/uf5If94PqxgPIjzey/yo8kHcYf5IcdlvLD/ig/rqVtQ5xepZzIjXdd9vamy/5FfjCddF7/m/yogUw3T//EyYb6RvONkw1y5tm9Yx947QzitWvKuAb8Zj4MVbJb7omZqc3hEPiFn3IjQblhbn7Ijcpv/LXJQvssP3rZS36Mi/8iP+Rf8uNNfwYd6gw6Us9Duwv5KE/cvjf1m2pocfOI/TGYDg35NXMuN3zii/QNxFzpbe5Mv5kLvHb0ECr62XzmYNWgFmOH9WTKJdn7VAscKe05fEejuX/ON40/2+Otlsn6QPNUrOMOW4PCTSAdU6jU8UxG3l3EXKnUPfR3xEcBuUXDm5AB7zTgjEwL5VZneoIil/gCw9Vc1evjjq+m9/K5MdNPopGDebDVJvBE1UUR+UvHI2VhqB/r321PYna0RTpe41tb7ujzlzyo/zd5kPxdHrjzDpcH9j/Jg1kQ/CkPurvOmzzI/yoP/i3/9T/aH3E/4/Wnuz7WAGjVv9ofgdDnmF9kfxA21rhb2h9Qb8jOjb/ZH+13+0N+2h/c72uLFtofIdi20Z/2x0ySldreL3X/N/vDJl6YLcwJWztS/g/ctR5y1z7eucfPTI9hOoWGOgVxNj44J6t9ngC3h4lcotOQc4naYGMatOfZfmX2pvG0U8hPrXlvtnf121N/4NdN4j/wG8n/18C8KKFejysuYWOA/8/54f9j4+RXBaa/s35NQP//4WdE/YnsK+hjbQW4B802yFSoVxff7O2iALvGzcC2VUOww4CfA/72qV5k2xsy+xvlN9kwokOcVQPOI4y6S29cGRL23ATrrij389zKB2lBcgNsmLv7TTYMk0FprghGiWPai6BdE6hHPywUbY45E1Jg/Cf7BblE1DnXEdKamKXjRga27RY4L80p2i9Zab8MUbdMgdMK1gvon+m37WP86v+j/nGoA8/D/0r/sB39v+gf7cD+U96YE/0/yZt/xi9nusdN20Lt0qwGtQNneE8E5zXkSgLfA8TVbaVPGIEDR/CWPnDAxJWVxuz+FmBcYpOMjiMi7zHIqdg7rEwj8UxxLDBdRq2sCsO3m91Yi/QjO4eWEnA+Ku7jjrXF9yKDub2jLNDzgfwgvEJZ36rByKm0fW3gagLkPTGVFTHIJB101GYPn2Muv6lOdcb6cDIcw5JuhSl04fwtmJ4mxjLWk+jx9a3G7E8s9HW2mSAeFOna5GeDs/XI7rHye1gjH5Pwp89TCSOYe69d/1v8RWL7ZuTcBQnzabAu8slPJPWWPsahoJ3eGHCBrHUP1ouwWQ7ZeNXfx1uK+XgDTjSOd87Gu2NIswnguip6/aG13QNyDbnMJmgKiG341QKM8vB05fvIaV3i7y1blfHA1sBmjAcGG2dTsEBPWQPfmJ7fU7kc5xZiqemzE/k0QGaTTncnP5uzvUVa68R0Fh24YGzWFyHAuIXLzoHaYwr2kO7OmbweTwFLeOyGvsKkdKm//OGjg1y1nPJ4zfaQ8mBrqGfdlX6lx7lv/7xvvYv8kvtL/kf+cbb+2RhXbc+YSMCXPJysgC/ZdO8e+wx43Pie2IDfCzjFjWmX6iQXH/eC6L/m5rUXcG76bG5kNjdq293mTGbI7N4HYmQOlhLtA6yBBV1R/Bqk0pZwojt8fmJHNWTB8iFnnIkwqAHZjqGOVi/O7nZTy+U1xBNZu03si0990agvBsR4T56/WRrs3UyPPWsD46DV49ndZ/3WdB1/j3XVbmYwHn5heE6bjcWqr6H/VP7FG0D7CHBj7HP0BTkXl7i6vZb7xzMGP2NEx96Y9uzTfvycfyizMTnBWXYxfu8T4GsS+JzcHcQegVyeADkkB4rWdv5JTlUKPjfZbzm1+yGnKi85VUP50mvI73KqrOW9hukPOdV8l1OzNepl07R4ySk9PeOaFadoSxfsfCBfAcRouNyKTSEAbH4ddJm+ObZPQgfifRrkdZybHeCc8IEjemd0VOBUKUKI50y0OFS0mOPuicMt1aJxvznIuw9zuEFcY5R10KcZ2FrR0fcnvfwL7qWckXJv/rx3fRjxtfdP8We2zzqYx1MR9tW33A93KwWEedgWKniOAb8d2lycb9Ueq1Fbc5IV60wGfFNFUgm2vdEQ+fTsQbRr6rs3Ljxhbz6sYD8eWU3i3dPgO0xHrc5hHYBvBOpoa2/3KGsV6uNde01ya+y3zCrFRJMB5atqfWbT3jsL/zd/IDubHdKXef7KElFGeU3x3awXFTPmGMuSwdpO2NbAZ8/6PYt1GXgF2By1LfCryYZRaK2iogLPYsl1oKhjwt6AsRpZB9YvZtvue9ENxqBud1dzJx0/mJ3vWTbtvw3h7x96VL9RIC7qYOM2WftNqSZ32V7YGJbWH4W7jYFchdzvSXsac+DsTVUqChPyaBuKlhEOwmp5XF7JJ3UTiqSqxJiXU2EDxcfKGqtWTZfNC/It8Lz1j/oH7XPQVyHPi/UHc658ykFAjlMmz26uuvG9uMvz96Nqnj0KxNCJ1BvwywJG+HGsH5LNUGR2euSyuT7AXENs94lvGR3ypVzj+MdsH0WJE9eavmoNnzkHoxutqe7KBJ7GZgAYlqpL3MahWLMhZn+J7wO+pxQ7b5T8QJ2g0Fc3regFd2d107/1ADFqb/hdqFUezjkXSxY+c7E+8Tf+df/w/EvIT8f6b8qfa1WoPZDj58iUH2gGbYfnzx6J60ZsAW+QS36AKeRlyentPggy73IJW6td8oZjAtxJM1uXgQcI820c5ABoWx5fX/Xn+mbvsDF3Yfk94rXXTJfYEj7ewWI/AfEsFwrpW3DOzh298b33ZgPEiwA9d2B7e114PZfJBbb2TJ7jvXMliClFqH8hv88Uz1bAxQoqlEsOnLMGx0jdgR8pjisG2lI2xMrRtvrFmSmU7U37bvHGV9ZwMF8n0jE3/m/x62lQVCRN9uRuUTEE9IF7cs+vmHvCzgD7ZTCGWtOeqoENAPjKXcCCsMVu3xi5ozQy0sCZsf8x0Rd457OmXTq4Vk1mT7eHTE4JQafuY18Db7zKvfNpp11SjOEauvAY8pqZb/Dh9Vfsf8R3XuZftPVGuLKYdtG3bNtfLv2hno5XW0WtCOa9bXSke+DL95qdxN450eUuYmT7y8WRfU/X5cEOrn/3X1eqXV1uI0b1UNUfbJ8tu1Hmxbatkc/M7Q+iupivdw3K0wB/smLB3ydmh8dVWdPlYQzXaZAXQzYerjBy/R3T36p5D/ttdOTw2W8HOIuH/nKHsnDot9x7XGFt7ygDlKu+N3ZNqvFp9zXiMO7gu9XP/N2SpbET/qHhGDBdQhZq9oWNgbaKE42NsTHon+92yEbPr7Rl0uOkLzZWRVHRxfK57/a/WrmyNhEHouGrTbY2pMKas3G685ilzuTTOlpYxy/k1YI1AeMyQk7g/9txaAlhENykh+V8qh//S//Xv/tvQP9n9q5cD6ubgPyNMP8rbWioXp+t2ZMmzdTus3/LwzfEF5XCv93HFmABQcxxa4OPRz1Anfv63/xfxD/vsB+FnR2IaSC9cDBojwKfKLvWFKfk/ZpTDQ07G2Y61ao3Mc7+i0f+1izzTx2B/TSzks90CxQB9vVayh/wN1gkJ8ciO/+8DrNhhMQnvzBwABbreMD63FltQd6AzDwMQJZ5mEtrN5ieMS4MI26CH+QKuU4jqL/oaEz/jZBT8t/1X3r/7b4RUq1xAz+R7PM2Mdn9Vg+jAa+H7SV9woGtNhP040JR10i16qM2YLIfvE+6+B1xLLfym+wlH/AEMB52LvLptEHva+f8OZbSte88//m3LUBcySCrN+DfBlvjALUJN6b3GuxnoHSCB/GQaMDl59wAzwHy4p1MfWETq/HYzgTMQccYF9jdO+CpYzr/IaEFz/P3pRnlJA0EkWrRNrk0DigPr+Y/AJeZ/CcRcHyx5zfyyaOsqea55QHFyzHBgu0bZbiheP1N4HyKYgMwcNm5ntfTEhNv74iUZyK4FGspsAZndEVOKasoz+851IxIzOarjNXWoCVIZuswdKH2Bfy3Qo/jYYyMJtgJiUo5tbftG78nnaux6/OafKyHXHEsZxN9iKl/cwviaHBmCdRiyKFSRFBTdgGuPtp7A/+j/dsB+wH0rsMQ/Jtgn0ehhtgodiaZ95nP9NRtSjh27P0r66KXe0etA56VzfZCEY1aZh84WFdsvH1m3wRQD4h5eg76Vycr8EduQI+6Q75Y51e+mAD2NbSF2ZKooxRe1kR/m891WeIFlr1E9VPNX6JyB/lX8XsdifF7PUecM8oWNfC9Qi5rQbzG4LecsWdemQ5yYDqI/EO3YePKdJWtF8SeXwW/sRQ+c74wJ/vujOdszQUz+0P+g7ZlCm1c8ftYnzU+GOzcszkXL8Sucj2LG8Mw9uIjYckPNqoX11XO03MUexnKktZqD7nw0NaJK6gVY4C5bigTDCalmwMjqN+s4Eupmfuf/CczX1FPiB3zrt+RrwZwfOC+ocPn3LwfJswGsVLAhmV6slYAaKyvH3d4sJH+Xs4nxwOEdsXEf4Q+Xt6mRdPjuJKD1VA8CzzfBeZBFHz0FXtUL/hnu4ALBmuTWXtGwZ/xH+LfMQCffc7GrqGqr7gX669xuv7lub3JkNcPC1N1mCfNrteCeIPP5uYYdRIosSxAJkm0rnE+ksUGOZtGzz7o+YLXMr3J3z7PhcS9c6vsRxyHHjG/YLzES1rpgSz5sU7R7ocalmOOnJWH6iOQHCW4E/4q5Vq4xWCvgo/5Rw3wp/MT61dNfn6eyzheE/ZSPT2ret2z/LZuIZ8XO6sMtgZqmaU14jpbp6Hu2zpgOW2vYC6Cz2Iko57dOvg3f2XtwTZlR8qOrw/9rqbfXqOJuCqKkV1KW8hmz6wnWl9l+8dhTYTxswJ2xnp3XS5cu428VScb45ZFHfgCm3GlrzMdAWwjW4MzalfTP+kvf8sfJQ7HCXIlX6tvNR5L+eVLgFwgIwYbHHKcTLmgnFFf0zjW2UyNLMdFXXJAdf82s4OTjSssN0tdZXJguLnmAo5LUWeatHcnvhWIXbkQG02/myUOn315YjbroAfrkQU868M/67eJdwSwySI4DkZyZtQF4J8W6vXD7KgEGHdm94oUkwxIRkC9C5O7uS63jmqJd4U22t6pAp5XD0hwWoS7uQZ8hSPy+yCICOVLHdsqtT+8M1t7FDmgn0Ps+GIFNvqqIhnPWszVC8VONYMavbYu+2wOq7G+KhKNcwl+bwLi/I2lmV81glvrw/yN8/OpeWd24LRpI16TfTJnwJfjVX2ovWg+wAe08qnufOIAhw3e88B7oKbmMLZPO/cgUH091qsrvbnnsrNpd7Ah1/+O2GNVyBm/xcP+gOkh0WLoQIwZfdWsX2w+nEi/dVN//IA6GZvyiSFWWdpPaK+P89OpaVScpbeyOb5Uv3qbzYh35ZBAPiL4Kdk83KJoR3XxK61Zxo8Bk/WCvh+mk2Z3trcBi//XuVflawv1pxvWempbgdZFJbN+8ox/qP8HbmXA9QsAb57pKRDjhPNWwBoweaRbcLYXo7Flj/yDGvmDQl25VF8oAu8xjJeXC/eC8ogM0puJE/Yf9h/6v6DNdRttessZsvdsmH5wHRgdvV607Iv30qnHbYvO9YfYZzq1DPXakQ618s0b02/CCvm5DeSRQH7VO+ro0jo2oagR43UjkcnlRLDAl1pycPblL64Psj3YEgE/21lOqqQPvvu1mO0hzf8NP4FzHlDNXVOgcXVXJvFfPCCWDTW8JEOBE80b+7gfw8eoxvTtSrWycO5wRjGbgOnsIereTMeAPs0BL36F9kOOuvHKOvbZu+4Zs2fShOkMZ61Yn0DPPfnhIWJy99yBOWH/b2whPxTqWJo55TJaX32V2Yl54t7t5HwPE/Oete1odVa3Vq0/tBPzEYzs8arOTveZtzVrPvt8CJnmQjayl5FrbK1ZwK5brK+u2z4yubyEGHXrbkhOfZ0mXcLi2xWD827U+36qVR7oUQLWA7JzyggVAWv/CdzWSC0kRiQ8OIjn4VzKle2uS3XsK+V+tMMqs502Wcx04/pGP9uX0v6qNiFvd0y5yYcF8hYb6NsATE+os5xF8QtXXLIC7+nfecvbVNo54FPsMxfyTCuIIR2Bag9xxXf+kA/zD770OeqNtZC1d/Lku3dXh9J+GUOu1SWdOuQ/mjP7SF8ZR3buuU531Sr8wbYB/2OyQWa6f79iZBrTIUxJKLyhd+Z1xnXAvQ0V1yBsJAl0Xe4ffNOLpbG1HI0O3mql/sf8kRtifgP+R/seP/l8EBsynMYlB68/SC5DjHV6KtN/2Rmt2V3A3lkQZwzcL44I64T4cltP/t+Q468i/282/sj/a3tVzv/bPzyxf/j97bf725/uDw8HeP/yvnrnVP3IPyxl3sf3KyX/sNk8UF0s1pgR93CZly0kMH+20p3rH/mHfa7rrtI8NT6/p1K+R13lxGk7USk36wPPsZl8fg/yVgHXV2w5nE/CKMcI521il8/0B3HmVz/N2ww5mRTVyEt7+tIWziUmEuF/b+V5qR8Pdmi/sX0KnzsJ8W4hf6eBbZDEuORyywCzN/nas+d/qYaXOKunT97fcv5E/wL2Q17Z8pr6UWVb4hdIo6zkpzh2X9jOorPguFgPa6T0BMDpzJdJiZW1/epy7L+ropafJd2nLXwStYX9hsm+7ZffVxSOaVVJWl3Mpz61NM6PTjgWHJ+ukp0Mn7iPm5xH7XvFOfuWYkgcf3uxy3NxZ1FZD4S4JOA7MILhW/1REMfcd9J44w5zrnfhvJJa6UKaCFAH2AUdKYb8lX1v0x7Lo/AEPg+nYhQ3WDPNIL5JQewUMz8D3wLImOHYUhWNHeJqO2e6+gj0D8i1Yrp5nemg4q1yOBrPOon20sA62TPUlujAaMHeJfdm2hGJWQY3+8LatJjWi2jmn8m2A+z0BPRUN13GrMNZ5x2/ZxSeWxWIPUGewiax+4DXsDH7/c0OcjyFHufyrATBrRhsJ5AaP1rG5xVy+KhqA2KqQ4fpYkMnbgZMf93t7ta0okxBWvGaJQ283sweliAO4brYn97pzNqdrPaTS0Tj3E9ncQ415xmMXzVxto/oZ5tW5o82FdimeP/3NrHmNkGn3p1Zm6rKxvCoTYEXd1cetanG2uStdcT9sHYacWUMto8iH+XnVRfqSCK0u+S4wvb388yEeqUiqaBN329hrpfa0u8Zs3P9ipH7Tc6D02/qsjPD56OuJHhxTr6xF/acyvS5maXL4wy/51Vtdl4S5zHTB1Qel0AHIY9LrMnWMYW4MpAKrJ3SK8DF6Zy0J4alA36INvEys7VZhRiHejIEvXB0OcJc4eH0Wm2zjq1Q569IhWEcb0VFnZNPolqw9cnO824U9Y4hvbP+XuvPhJ3F2tqDunOQN7Mw0WKv+c0kuqDy3PWH7NWhzQPeZthfEyYsoS8QR5nCu3j+MJv/qt6Y982wrRZRW634mZcIBtpLi2qzq8tqDbkvGkvHZ+cnu8Z4CRsz4Gm1B5EmPipZwmMVI12WbZ04mxV4F+U0sTObjWeBMdns7b2h0S7Gvqeydyroz+DvbCOnJXsn64/F5qnt8ViaBni6g9VRFC77PulHwD09egB+DLOnNPj7jZeP2SNN75wVk9jWNcHW622/Yu3R3z/5rha5FztUwQyxIXXV9GLgM0cfMHDbxnXBmnlKTcQcaLYPACumYP2m58Z+T3PVZnu2WuC8HtSgbPNKvbFnGLfCiOv3w2ytFDd2T6VQ1ycT+t5fte1kinb2t4d1qv6pHzl/tvfnsx32bI+e/WzfUikm8OybGm5dzoki0bMrTIepmGMVbKEp1KEO/IIwtyaA5yLl4Lu56LLo61QPdmJ/OzrJ8paAshxyW4aUn5KfDDf76o11yJfcu+Sz2jZ6I/E+n5rZeiQy3do32Pf6kCsJ+AHsDOhuhWKP+PdLJmMikFs+yB1mq1jqYJO1ob46GeN33/1v7mAjeIm16nMsnAzkpgv5Sx9kVPcpoyAvDGVnDlQ2X4A1BRwFkGMKfmGNyaBZzY6W6dFE2519zvafVICTrmJrHJvvirxN1fzQJtyBzTLNszv8XTQ24HNSZsgJqsuCA2tf8bIUcm4hf3f7EA4RP0O7VkA8p6Ge9+6cGwS+M5mibSsYQmMzBL9l1udYPICdYFDd5VfP0pMB67vcJn75m1Pi5msCcrpt54Q5DfNV4vkfVlxXitJ8sMWz88H35KmN+EIJcbMsy3vFc1zmXIJdFB5s9qMFg3hu+4TvZBCPUkI8SnL29Bk2Ap9zM5ojqnFAfvsWU2DsMs7vFCn5X8bfk7ex3d375EdZEkb59t7nWEN6Hm3pf0fk7q1+9zL8/NvifsTzkOuUMul0VVG1MY5hnNISm8x/f35DxHYqGtMX1HZV55x0zP5owjpRVIE+L56ff+Hn3mn95GCkz0ObbKfWvY78wwq/Fhv1vNSv5naJ/ckWJtm9sxzkzjOfIizHDfCjQ5gl4Ki1rJLXzz6klzZhqDnj6wed+bBnZ0AF7KwogfpvKaecFWGSQfFvL8PYqL/MZvQ7Jh5K6zIlvtcZjVdnRe2LbuwZE/fIn9E7ngjT3l71nnbHU38WRPeLeJvM4XpJbU/4+xFrALAv1tYLf8pcH/rPtc90Y+/Icy72FuF1mAtTxPx7VSi5cPrpqFY/YmxI2LW3+ZMfrH6JZ1WvwWtzhFYdaiiRt29ekM+C2YTrXn6/GZwPDGpqkW9V5nyrwB9SAY5oqg+TnCr5jNm6OeSVofzyKSKW6zaySjxn1r8Lx364SOX3wNey7ZGNUq0GKq1ncWSUdqOTBBwjviGonPNaVswc8Gzu+k01u1vCyjpvSq5rWsNjjeT1y9Yi/pCB96xTgFzfqsC+cyCebPtW9EvcKNMAfGjgkUCMO86fKkBsl+0t5NBtIX/AArHn2EZXZ+2uWmLbHL7Q/zaINSt+4uRV/E0rcLCPkLfI7KV6wOtohNYB+Ol68hufsZ4nI6oRSpGfvEK4+mLN5vwPvXTM9zLT+6GNa963NeAa+OK0TRgqWNMI9dnbYnZYcC69GHwlIcYz2+z9pqOVXGQQ05s467jk3KO66nXCcZczlKeizWsCFReK02CNTLi9cogVLSRsvboQl3VCrzVD+W07+u6Bj9cduQJozNqWzzmy2jFhdMqTuLQ/27TGSxkaEiwGfCew37+TlNwCyOUd5M/vAe+PEcelrDsnhJHkrc514FkAe+zJs9DxN7SHxx3wtOG5M0j2FvEkmSVP+qG009m5MU/Y/od8VzWokC19MSvcjmX24LJTvGopC68yofXI3j938f39d54HFd8PPMT+mGpfnRXkX8oC5/Xd2RAfPsz4Gp/EwN/gbguyd8eLMtZ4Mped+ClHbsIUsTJ9tr+1RTbk3EDA7WEOD9mLS2gmMTnejN79CmPi4AM+jLsV83kybWrnguaAuKT7m3KM3SFhJiQTOr82N7LZmfFzLbkcsaZo0edcSc6NY233gEtOacvdEnctHYunvCDZtoSyR6wrAtmW3Csk20x41rTLa47A/5cBzv75hGdCLP+UbQ1ao8iVYe/P5T5vML1ot+Yc13ydjcODyOY9Unm8G33r60TtcI5tmmcmHyZlzQpg9kEOwRnO0VJ+sXV+ORMH/fbQ4fWSCnjYSv6iRy1BjhPE20fZIVVFrA8+AI9Rl2o5JqUf7Lrh/qkfMuVkPqbUV9JpgTer5ivmakFrevE6s5lM+w5obmZJifUIdcQaxwqmHJf89sS0dr0IeJnble6P9apG3JcImD+x8VNGgQw4lzIKeNJSX2poxW8ZNTnN488y6stvvsmo6TQqfsqo6u30xmG6VYjPha1FPC9+ySjnRFh7jaCcf5T1SkcKuNzgfENHyO1DjjDFlp/4rWftxHkGQKeiuN9kqf2UN/Wn3Gp9DdLCenGnfivmaV5y1fSHGHNxv8muya9Dwpzk8+Zc37Djxm0rpnzdbW8EsmAFuaOUS55cMuL5ihr5l8ZrhivpmvPaMNmVQoEhnsfXouSjYH1URNy3ykANf/BM4EYlP5tDchLWBOhMN/CDX7fv/Onbdqcgnz3IqRDOqjc5BTnk3zO+DqfgpxLcDZ/PdznV2Puf5dToNHiXUwvke3+TU7axeObmsDH1+PzUK+mK2nXZTfnakwdxZNJnos0/axKnLuHz13v4WR3zdPDMd5QA69zdTomXq/cXz1qe8hz6hz26WaT5Etcn1KrqeU1blbxCd2qfdEYbtBJXTIzXp2/53HHK1wLb4zHgAdmAf3k30qFiYN1AJ/O5L/ISn8ySv6ZjL/n5yfl1dibiKs+B964NXIO9w4LLDogJNGo21/MUGC/ivbeqk/Ywp3ULayi+m099lXKZqhl8xyfOrkPwhx7TuJFP9k0WsD5cSjuY6TVgZwj87NjJNtY9Jc/zrFcEf6yToNP/vE5mUGz6WiedQ/BznQz64TvP/TApORziSof43aLpC/ugapZcvx2Si1SD3GI2oBTSWF125RqSWbvPZaygPov5/1udN1058blewvTl3TBEW4HrQNsx5KvRGCdmebZ2gvB1Lky8OZ0LU4pHHypVrB0FfeLzmttrpB/PV5SjpkBSFtRzoO1YzUWN+8vXA5/rbKV9xdaPTPKAz41icvm3XlfQrhtsjx1e03kfJHaHY4dcYxvnfTvMfnBZzKPkI8YJxJXwfZYfgjxpxxwbDnMTYr9G8VkLv2MIOH+Xtlgspk8OF8xrsm0PyMHAlyU0IRah2QHhvdWiPvn9O4rTnD3t0sHWgbWMbQCsxQL8Tlu94tuQ/+VsN8oLZ99pBhzb99isEtfuP37fOj2/P6rWqtUC48Y414qpTn73AWvb/EMB8cF33P2f9QsQ850OkWcT5IdujShW/mf9C+zFzRw5AFEe9CMnKqSP8WeQ5y7A0ShqATbvTeA5ML0/8fN9jOuHZ9cweMwf/M43k9lX2V9i/iPw3Q0gfsD6nyoDIyB/zY2w4QGn/1P7w3MLa02Gab6Rv5ls5Xk5v/ATtAx9gHo/6ulvbXywPaswBWBaxoAMLm+hthVzDMbWCHgoNMRu8iF/Ja6enrkJlMd0m9th07GLTQ75rMW12uRnZni7o08/xX0KuUPgi3s+G3OOGn/yDwT73ob1RxmGhKUwSvN+Ev6Sl7jXI2USAMTur/rBDrsffHpByMZnYkPN+SiJlPHCJR/gC/+Q7clOV236wy3wAa2gzsqarfdjaO+v/F8bMF9m650M/5sf6X7k4EuM1/lu1o71G+fe+rl+WHsEXzGyKfkbhVAx1PLvXLGzyW+7Bp7N2nIy/ZJr7J/mP3G2YhDDmutCG3K2l6Qf+LuRMgrf6w8+3s/6t0jZtv2w/qn9vWzC2xwrqj35rdtSm7MdtPnX+FGf3VPwvN9WJ8/+W6u/9P9wggKs/2n/h3nj1X/kue7My7yAMrcGccuJR6jnzswt8glopFdpoQTfJ/znF/401Bmx9zGZtubYSrrlKHoIfdJuWeCrmD+kAVb9z/1H+0crxGcuIPhi2f65YO4Ns5WmPF+mo9g+8Rb4LnJU8Hto/Eu5AOPnqOXfheJmYxi/wZ/j1zSKj+MHOUFnz2RtYWfOEvUS8N9C7tA7F6kEewlq22AvmTbhJkF9XM4523vLcbvnLYMljN8QkvCBFxzwisdgfwgVno9rt0vc2uxlb44RUwLzxo9veKW/+PYO31/sXP0v7Qd9T2HrQWefTTZQgwk4iBnUm0vs/zn4jvuDdGKQ77j4hIcdqsn+r+u/b4z/sk4vRvw8fxzAJB9fme0x0WuQpqvGmgC4zfdQHBreZmhHpq0WaJfgGvuFv421g1thKbcybaQeAgv9NWatCrqTJ9aOJvihOn/JvwTZDvtiEFcxR4CtWXtAudPwuT9Id0ZMseJgEF/Kv6eD+Pl5CPXgkyPwOVQFgclgplcLjfpv+VueTce+xvZRZ1HyN+Je+YCXXmJv28hhgXtX6s3Z3k2DICa9e98bBjzfk623EeX9aWyCzAD5rOjvEP5esHW36c8xH0Gzf687DATiuis5r4IAMUK7cL3Aa8wD+LwuKWeY8DHZ+jC4TvYTn/04dQ6gs7znPwO2UO5lTN9RTcGCmOghOL2fuUq/4DwGdT5+4isPj3KroIagpixk0GF0wBDRZp3pJ/k1Msl/605MxC6fauST1gJp+lF+MR09JJ6KHur7sEc2mt3dANdqC3FbdGE8o1jr1qc+WQrKKLViJTyuUQm2ZlUAHI8I8sqI7N5OJq390hpCUmg/Mpt8nw5W9RJbqBIhdqNdQL1uF3xLwIGAnLy9vE5x794Qqp2ymlSsAV86Elsq1u7sbfs8aRox5Bz29JXIeV929kCoydEwsi+b6jt2fJdyzjjvQyUJwY/zI/++iH6MJ68FGVDtB8riqaJX6yV+AXCEBhr1XxVfOdAf6w8Ry30PfnvXi+5cv565oGMqrn6sXsHXnsql3wqwtKqi4XNeljVxgvyQP+MA5fEWuRbFy3albBrgM7ErPLfmdm0N2yWnAuaH/uBPovN3kHm/eXJJfu3WZU7DR/5V4YlFAjofYKBhfX+HrcHFEGu6XGciz2ANFkXz917sEdc6nAFJqgcq4On11bXJMYPnlGe3Pr5hffzi0K6Y/+Pzq/Pj/BLC7YPJTR7vqSXIYa9jn9/5GcanFz9Dp+8WGuighSYHP2WEkr1hi/zmbJj+1r//F/wNbjAo+Rs+cjd0Pq2/u9No/ODHjpTNyv3EP66o9H+QE2/135MA7HThD35aF2P3xE/b73plfLFwua2CHLJ/2E9/9t//eb5naQVi3WX936R2bF0/6K/+wvytv7NzV0pYO37Yf+z+2/f4z/uXC+HP+/f7VvXP+zXIdX3qj//W/v24+qv95+vyz/cvED/k9/unreuf708+3T/7eH/n0/3Rp/unn+7ffXz/8I/7Z/kE8J6wTvN1v2JA/U3r5/r53P8f+bs+1AWAb2Cp5+YQ/TD6ZhVDrk1MuT5CqysTv7Y7LxDjpl6ZVSBu4G4SiAE4cTO0iYMGnqNpFzUkvQTqa1ZWfitOiEOgy8MvxCO2z2cJcOqHiOtMuFVvvF8y7JtKcoE487UW82c18nQyYw1ctiHfCGFCCOOL2bGBPGbvPxklr3l8tsgveFXaQo9zUF2mvMZfMjqyVvpsIHf+krjwrqSvCVOv722yWTiPq9PhArAPBMA+WOGzoCJZbVfXdPa+cehaecfkbZv5D8S8CjJ9iBwX6O+ylF4z4nyA+bXIgeP9G5/ZC7qlX/3bh8/3XnkWKF21i7KiUlXncas6XLG/ay3zhJzR2y7FS93WXdWEkOmquo98bciLBfzip7d+Ni/bLXwf+jjaQB9r4TyLvc0pfei1uvnVmdt6raG9565vIHc92FbK60aNqa8bwzs0TawVhLqvQ1O171bQU6Qz+CuZnDQQOzMdTxTUeX/wO2cgt11vEiJ3fHu1yZeXcQXjiaPWofRVCFAb3Q+cZ17uszJJB1yI9tje3eE8LLQbOx9sn10rnf68baPse9D4lvUZBtQ1POtu9//I/wH8ZesH6lCAbTRbpIBtNDkhthHhHfF4gplS/oRYB5/DYDuXqw3kgy9zX2+VdNUuc2/7kWqoPuf9U8M2x8KetvE6XuP1vvpaT2Z/O4tzwCQaEr6SSZhEU2pDhDhFJrVrFuL3qK2mDD6UVcy+WwvfedwUz7AgB8H32f2pxvZJKNM6lpxNRs8r6Hk2Pm9JzxPovQW9N8XvfdH3Yvj7zt43juI3DudxfiyYWPAcOKs6zG6QI2mXRR1eixzM/fc1UQ+YfrJL/0/fP/Zf72f2k7zoTI5zKRH4+/Mf78/Y+w//t/1/FOHz/WviCB0uPfIJo4/cAocz+nlnKce6HmjIxZ3KTJe8xr76zhO99alWn+km2m1QYm9zztDj6/wBl8nv82Ol/sE/z86fwvztf2LnT/fP+9FOwvrrrc3rrzeGA2fAfGDBvu2NIN8e27msBn5S4iZxP+lH/y3oz+AHdTS276ca+TuP6urFQ/ZWU/WX+0H/7m2KNL/FlBO0vj3fezzD+Hf+oX5p53Ie0bm99SG3RYYclUab+J2YTOlD/oLUgfyFG9hAYbw1+uAn65R8eWuV4nmS+Y/2B/K/BUwWEabTs9+9TZz0t7UTvXcQt7Qyrt4GRuOSY2Wng09tk+B3oSa80RnEq+d31bjDcWo7tp3o9tv4PdfHB//5dgN9klmfmmwNqx22jgewdsc3kBUR0xuf+E3v9tOz7UPgrqg1bdDX24NtphHPDLTVwfET+uCjqnTwOs23EA9TK5J/17StEUJOVvG0rXj9P9bDzuI9e47H5oF8ehyn3V4dbWGd3QojrUnJQW2v0m+zRzFmpZDUzd1QI3eEfpVN0beqTY1034/zPzVbh7ibRI7cs2dSNGbfla093duaAV/4EPxBY7CnV8RZ3p9btto2hcNhfctWiTqp6fgb7nf16iOLNZjfqEie+hfE8gwI8+nWqKg2dzk4Tz32e0e/j/z6yK+/+PUXv/7m19/8+sSvT/z6zK/P/PrCry/8+sqvr/y64NcFv67x6xq/lvm1ATSj7Ldp8t/8ugMGG/ze0W+LX+v8/wb//t/ut/m1za89fu3xa59f+/x6yK+H/HrF27fi7Y34dcSv1/x6za9npkG/d/Q75Nchv57z6zm/XvDrBb9e8uslv17x6xW/PvDrA7++8Gubv995zp/B54//5tcu75/L+zf4l/6P+HXO728ADAb2P+T957/59YZfb/h1xq8zfr3j1zt+vefXe3594Ndj/v5y/PZZ8+P4qub/Y+/N2hPXlYbRH5QLbIY0XHrGTmyw8XwHNjHBZugmwcCv/6pkWzJD0ln73ec573fOYj2riShLVaoq1SDJkk6+pUKv5V9/12WtLmt12ajLRl1+qcsvdfm1Lr/WZbMum3XZqstWXZ7U5UldntblaV226/KsLsd1Oa7L87o8r8sdfCsEvtd1Oa/heV0u6vKpLp/r8rkuj2j/zYovGAzjd159y3VZrstKXVbqslqX1bqs1WWtLo/r8rgu63V5VpfduuzW5aguR3U5rstxXZ7X5XldXtTlRV1O6rKZV3yxav5Ydfm/1X5Sl9O6nNblZV1e1uU35VB959V3Vpffa/grvtaH33n1bddluy67ddmty15d9uqyX5f9uhzU5aAuh3U5rMtRXY7qclyX45yr+19/1+VFXV7U5awuN/Q5dX2nLr/X4+29Hm/ruryuy3ldzutyUZeLuryh9smux1/9XZdf6nJWP7+qn1/V5f8W/s0X9nNXlxv7tq/L+7r8uy7/rst/6vJX9vWjLn9Q+s2afrOmv/6uy3ldzuvy3+gfK+x8EjzPsv0px0b9l6QfuDakTjknskznOpTm7AupJPcECJKwkga0weFrMy8ik3PG7/HJLF+nf406CnuAJTsS+3PyiHaFwe3u6CMZ+1wcGrM0GHDzgC8EBbxR94Nb9AQh5EeyoFhjTxvtF1tbsLnUWvT8S+wZfDp2jotMuP/A804YF4ut48Kz5wjP6cxvf/NncRAJXs8mz3sbf50KorrQ/I8Y6PA19Rx3fU5Q0/1i4xxT3lklm7SAZ+RFzyicnrFKtNU+6pkY770Cf0ytwY+sLsU+7vup1owRLpY85FyMERKXAZ+7eLfUixBRmeLhJEpJDm7HctfD/e/5Ap4/4Z1JY3x3/pkcv5Bftyf3s5IyXe8cn2xsYIP7/QgRgt059qplHb2P71hY+GdB4DgnLHm43468x2LsEE6WDLYIl7BDUh/hZB+4qVP4idTHVmVSn8wDWTbCyUUQQ9z3TVRD5mj7U9I+YdcTgRPdk3BxguypMEj7BoVXPcSJBUEiXcF99FV9ciBYxT4N4dW9732Ek20KCoGTc9jEQI1Xi7EP+jWgf4PcN4JqcTf6o3k95zwPBlt4VnYKi0s2xWfMG0WciW7aehT00VgE6ja2xQn922fPwW9qSt6RjQ9RkF6IrnWL5+Z9b9tf+TPPP8Sg96jfLgRQvldQPWzRt8JjYnwxo2fYoKL9wf07lSj2eEfVwkF+krsnzBv9yDKyXp3j0L/Wt3EWNs9ZCFfxgNshsyPyDPfPOjOoPyL4GH6y30rEvEsWET5B/KaKvB+gvEt8DWLKzRv4HxGSrT7CpVw5djoe6rdxcTvH4R7hJ/G107kQ+IHr/OrYBG67+JICwnvW9KnDkfYVfvqrEyFcKWdAL4H7WL8kx1oMEd7H/iiuB+2fEL5A+FDFOT8O4SWBk/oGwgvLferwBH+CcIWMP1K/ZVffcWrNQn6/3PAjw/Wj6pwhC19TcXCr8MTHBM3mjr86PPLDWs+u2pPOUFna4/j+JUZX7Tm0PWmFcA/be8HxL7o41fWO9kMrnSt5jSWUV2WnNiMe7Ncq1QpiK3kP5z9wH1JL/oJN5f+BcFG+pu8V5S8bqH/qDX1dUibnDTkIfzrV/spuPBPeC+7jnOBOtdv2UTpgaidW+TLCQ7SXU8T/IoOtGn44QNzZkp86J56sW3JX+iwqq7oDwhVGoTZCNSv+4p/Mh/6p+ESfVNlH7A+OKSlC+nA9V3jJ4gbfYZU3+i8gnBhtM4rJqaLwOSNc6JNBhHCc/xcsAieoe9g+QS1vCNwmZ2zGjescEvzEvnYJPCP2k8IF3Kcr9IWHH5UdiRY2YYQidhpG9cc+hVuNI7fEUwPXxyfmxz36J9fAbW10X18RfzfwUjMofJrf19c1akmzN+UeDip1374kDilcY/ChTNd1Pm0l3i/HDp9sPMGpz9mIPWu12MarpBS1ebji0hAi0q3Ppdqofo1fHFL+60Q+hPh3wn+PxEt4pEmlL+scxhtRorcVlY+OcVGGYn2Viwa+J/Cc6AfeiEostbbeNfD+ZN3pkFNppSeiP8S/2nHj37wt+A6t+Ig9/5xsRudKaQtUa12128FgNVgvOH5MGSzr04iMnwlujyDjy/6FF7Ii3MIdf63xrZyla70ZealinizPOi5CkU81/0zpcMGThdYf4FspaGmx2EAsFTr7Bb67qNXjRlPX8GyX8BycQNoF36mNesD7ovFr8Pcx2lpFso0hhzGOEPvlSTOWVWcXz8Rj2h1A7JVks8LMoq56WEjiLgrNLAZfPA+tXRzYn7oyOOoVvuPiXewReLgqoh7ElABvxc6GW8SiqxRKyKkzh/ctxxt4D8eNxh9jzcsWoX9JJfEdaHmPAutP3Kvo1LXRWdfiY7Lxtwmxr208xJ59zrsDoL+fLTYqN4e4U9f4ItVWx/ia04KTj2aOl85c3p84Kvztq/7MN1TnnqosDYFfZ/Eyx9g0sDOIPwdJt1hHQZnVZ4YAP6zdoju6AM0fi65TTN7FDfoBRrvfT7TTPuoW3GKcfz62G9Ya+oX8zuPgxEUzsVhqVhEHzkWXldKUhdKUxBLGUbEYm/dtaDj2oN/B6DPs8hfoO5/07CzaeBnU4xZngcc2cHkk6iItB5Av8HFrt3gunHSI73W5aR/8WXd0jkHHQN+KV0n8SIG2+YxfL7RiPT+LK5AD8Hv0+RqcihjbCkZ80vUa3mQgr1MaFGfgzQ1PiLxZPxRDtLmPsZePfDd33nwF9IXzH+qKG8C4mInrRZf/iLCtcZ0nSOIeZPW5gH6D3EH+aplI4p84zLNmPLy+iy7wF3SVPLOCOj2gNV/0kmzR04Enq+OiZxU3uob9yuNZZfPtUCyx//UYzEA3gN8wJhQ1Qp1bbD3gu3oGXmdzGBuLoLgkiP8sHpN34Flg7OOef0zDlhyVql6igQyRz6HFYZv1WCjAJnDLBr+/CqLgxMPvrL89Y59q6vsCxxD0I92ohzTwKvybEbSlZEkdX4McP9OAf49DverzZnQEG7FavN/6NNFA+w19BR7XOdlZfIdc7jO+1UHVKtq8TLTRZd7YqJuPEwxW0eZU6ETn/QJsCOSFFvDbIbYnBpsLvNyizdIVGNea+gn5ZMbyVh30q595veICdvJDR9xjrJteXq9yU7Frrh1hehEFvbBkr7vCs3MIbmgLbCvokaT3bcmYeFxl6/W10m3Vr3XFKeJW3xhP1W4UFJBjGAeQBYwx0Y1Qx4OBHIG80N/NYMy/3uTL6VrnbHlYhtsP2eEK0OG0mIbcAzpEGfSbyBfaXKNt0cc1z7Zgc3otG6iKE+cMerKxjjheQdc2SNu1PW7GD9jygN8vNz6Ta4/Y+8+qXwbov7VKiD/381eUD+gjjt8vbZkCY438XtkgXSsutf7ugVYO9BVpedZb/Sf95Q0YX+hzUjEZi4d5YFVx8/vXcrFh7GN7FQ71gDKNx3kG/oLYfcZvsSB5oGoNFlvwb6EFfQbelI/mL3h+AToEfQAei+dFF+x+j9j+Dxjn63nLhwA/qFyYvVA/ib1p8YCOf+TpuOln8qmrPvoKtF9gI50ieR8cotAHHV8BDwT0pcS+wPg5NGP+4fhR1HXU9dG2vM+D0z4FHvyPxg74iTmMCfC170nXP6fgO0A3V/D8lQ7ZjZ6Mof1Q5WGMDMDugdysHdhijCNWUcW/fbQpDtCPQct+4DhZMf3ymG2+n1cC39qiBfLySgchRtoCzVsf+fmL4uzV9pjxvAB5rJYB6HDW5t+pWKAPAV+7AP7VenpJ0a73DE6/wo+xzrUviMG2LjRjhT407aLtVznkJfQH7ERbXmLY9i0xw/sJPDgsuoMtyoPIu9I1kNvoIw6dM8g9c7vGJQ6NLvYt7qr7xj7PggHYndMebNI9nzE+7ELcMzYGrxmbW8MxvYC4O4ZxnmpDkCvESd1TzmRd66yEPn2EenBmMisJ/YvNMCNtwPNoByAe5JLz13QKQhs/f0yJvXEwdoSxg+NR/0725PwgwHFBn1XFf8Un+rU5xGH34xfl8cFkpPkHtAXJNmd2DcfgO7FHe4w1o7uYpIql0cYueiLYEVG6jkE/imVgHKPQgL8d4CfE26ExIHoW+nvQkQv6WRiDa4wbQT4F638MNoWr+V7xq44fGnsAvzmNX98QH97y6RH6q7FxhNjvUPHiyg5/Fbc8jDVb+r9u7BjUWcdB0b2Pux/amPVV7FLN34HekHEEdm2wmYfGRz0uLy0fSvnx2qP2YFPFIOp63k3PJLYgMVvxvuhCzF3Fw3vQnXNjCx2wcXFAn92AreZh7KzR1oFuor+awPjagP+t9JjKNV3BcznoVElsutayC6rl2d5JDbmRBD5nhvcNzbzR5BH//Fpn22MNbNIOeLnFHCGG3LfS2Qov0DNt8i7g5xb88ufkTGzAP6OxwV/Pk7dsao5jovHdoCsfRIeQL4wfoPeQV0p1vga+E2NN0JvKZikWyBvtAZEhsaVoEzCuAX0HOwW+7jruvZE/s9Moz6RrgYz8zwT0MiV+BXx1K4aMA9RTotd13EdwVTTKB7DhkPdc8bfKZxK08RrYowBpz9rxz3FOxhnYRbT/kIuCzuZI/xzGD9AG8YeF+eljm6NS2ki+CznSEXlX2x2wc2IJY2oNMQTQtUIZQX5WcFU+fNojbTTnPt/awetPyDucfVH4R+swllfn82OQR2iscc4abO56zsWKALFJhHZFECEPP+Wzrj+AnJ783cyrQBnGpnEBGZD3ENv2rdHbh0Qp4Ivr2AV4huPvgjqJeg1tXOmgDTJNNnZlkzTo59Ykdg1sV32GXEUTsZf/LH45VutFNsYnn5jDAey5Gksx5k4i6D3aLXWxWYG9AXunsPkSQi/EeqAjxWIGsXvocFg3Af+FbYHtP96OQ9qva/3HGBviGZbHxhVdRN/myPfz9zla7b888O0c2mroZwE5U2ZedMzls2gLunOV/yGvSD63WoA/iQL05UCzVsXM7Q/KvRVfE16TM+Lu/acPvo6HuPqYbIn9JbnwQ/lL/cwP0X+cjmkX1+pU9EmfEehkbY8v1VhQIAZQBzi+iM0LDbQVRbI+kLkSsPmDRPPrfhOZcfh3W3/ceo4gqnX2ti+t+L1adwSfBHEy18R2t3pGnldYTBG1Yt2k0i+cp8K5rcttLMfmcB7Mad3ayLv41+rNSW7Q5IYp2rgd6HJB7TnpG5EjlfXf/JdO5nJIDlfZTY3M6aFu4/psFlXzYY29/XXjO6p88QvayUoe5TubIwK/vEmlEuKAYjsf21W8F4D9BJtz63++tV8cmweu8jzheaIIJysTBdONBVPe9YVxdLJyoZysMzpP+XgyXXzzx45sur5Mc6UCYjiM/QPvZFJcPuZjEE+ZQnRRugRnvb5gySuCc8nV680y/8vmUnsBeOHvPB6TsjsP98U0cPK3kKtoXTukni1D3jmG/DUEPKWYJxvIrUBG8BvIOUb7/4P5W+XC5sSbNXSIk3oI98+ChrZnwD3o//f2rjXnLmjOOQqSZ9BvsB84Div6cC4Sxsslbs1bwzgH/+Q9t9uitM6Ej9fQOkIsjfM5tu07ui6x85GJLzqz3xMyLwrxHJ6nDM/PPPulRf8juR3dAH3j4AKy36SC2AX96JiCqAGPVwuIEZOtcayOzhcNnM+AMpmvw/ye5FH1XDOJG8EfpwHgwHELNsiBXKrx80lXxTgI/DTIPXTI3FtyJvMHJZG/JJ5jyF8hVsXcawN93KPNX0rVvOaS5Ohs/hNynVsB6QNyVqAgZFPcqzE0sfz0unjqjEq9tU6AS2d0aaxaKtux9TO7tX/k6iNHg2Ono9iCJJD2OzaWh9h+j6yVSDerbDNcl+Zwb+2vNe57LT+OvzrtBttLb2ImkTORPiYL+FfqVuuPP/xgfzKJnCP2G+vzUq9z7FTvPxB6WPdJtiaSM4PIFDvevd3pvwF9Q/3z7VfnnVTQhaY/5Pmp+3T1fA/38Q69z84v0JWsWcq7mdkX3wm/yDrOhRxghPL4NV0/dcqfd43Uty54zqGN9V//k/ovpL7wH+FHeY+x/miH9XtYn6sOybqRt4N8C/FsJD7cAn8OT8BP8YafTN4COS7Gnrx1Ot3LP5N368Pj+hmPKKQ+bkz6mGzxsH18ueggllervDNGBFmzf6n71+g7WwBWq/VAbO88gaYuLm4a8LBuJzOb9l5vxgtpjywSqPII+J0/Q/9eTPinxEOo5K7QbEUROKb/ZTP+RNKSMe2BPi5+A77kjPf1Iv+m5FmZVWL8JOvBKll/73dAN3tIb09OUZ8l2j55XnzuXPDMb9fD3/beH0Ivb7k4B+lxzsDjTZFH/FxCy/ubclKXhUU4wjVErzs8m8rARZu9wDiBu553tEsYbXiXFnzPyXk/gjh9q75PhB4IDGt4typLc9euNqpdCN15wlv4vtkgUa0t2TjlQn/HhevxI9frOWPIl5Wlb549pOvPAc9IBFqttyXEwA7018Fne0WJ66Fe11ovfetouivX5knMWJA5c4/M4+H+MFk4CNjGW6Ik1fO29oq6IPzus98JP4B38DfgX0GbQIPlAs5xhUcdCOkr8GiE9Lkh4MfVbop/LX4935ybUoj3GqqjktLPW+/YrrAyaf+8rkH6h3yItuSAzhFq5g0tkuFWbQG8IHBb66CuhNBmqpCtVBdaFkQ3CgEfR/rlwm/VfqffuOFVJDqgvl0qHRBe9qS9sIgWpJ2XtGrfeMNzpQi9SWdI1pq31dHtxti6mGtfXY7R3+F8GvLeGNihcQa85hx920Y9eILcEbk/lV2YDsfRcUHsFqnvknxKXEBOHm2NFY65TpnuRsS/QL2+XNWTnEtyKaYJzil3B1jHruBr2u5uWrUr7HGDrIhjQcKTVfBvPGKRyPGAOyLFMZGzbZxx4xzytXseVnpY6ZbUa8r8UNribc3qUJrhgv7YqeU0lNZy9bu1rn4XyMaful5p8Mi/sNTfEAeRzX6IZ4EOhHVe0YBDvnm+0gkpJeVc+oX3aKq1nmy8Y60nlY5+kPvgBsL7gbYTtOjVkN4xjCWholMmZaDxfVi3Y0odfJ7IWT/i3XlLG+Rf1nJeKdVzF8Ml5cyj9bZ4vyqp98pj/I66CfRdKjpEd3FZTTxu9D7HmJjsUx2TS/6gL8cJ2JZmrgDG67Z6PoaxE+/jMJWJXXs7Eru2uCgnt7BIvgcxLuQ5jux1iR6Tdpp5CbK/ddn7VdmvvBq/9mu/0lkRj6Z5C/AQ10reXfo7j/oB35z6Vtmi18Er0Xddfq35sAzJ/B3YF1wviveQy+iYI8G3TH5fq1MYr2xOTR1d4oDHvaSYC8pE78JcOuF8DfBsGToG5Gd6UhBZcUJ++KxsULFNtvtjCPJ3ZkQmfeRt2BONuGc8L3j0p6+nV7viN4zjHPWpshtE70QfHfCjWOBmX0cdbwvNmpaNezEElmcKWrN/0YG/m1zQz+1q7xn8Bj5BEFdLAXLI0DnENl2/FBY9Yx+DfCGH2S8hd1iijqrGKuXrvZrjdB+PnZ0Aees8SHdgn4CutJqbxuswb+wGnU9uzffXQcel2Qv8n89h3X/idv7czNuVrH9Jz1lBrnWpcqIU52SFpLvaxzgHIjzIuzRcMwUaA5wrIPtKsc0Cn4EcmMT+grR+rvbvkPjDFNh2TkE7gv//hefzVnAFy88dLFenv0+xvKVlkcDXN2X3pjzG8gue2dAK3ln8Pr1AaPjkdSj8D9D3ZNLyyx+Ey1juTLctnStb8aP8jvfNxdNfNVySsBxhbDDC+sNWMMfinwu2x10ovacjltF8PPWxfotelp+8LrA9ct8CKRP6hhssF8dH9CE+aYLtqSRW0Sl9Mp6RMHKfr+lj+dMJ+df5g0dO/MZ7V5qoXG5vTZRe0RbplF/iLyzLlD5xjVu3nkgMQsoylge0LODznS4tTy/9q7Lh9pG+iv+4NewPtj8m/bOb/smfaHNHJDZ7BZ/dOWMZYmiznd+MSH2Mbyt+71GfRkda3pDyG/a3i/UH+DyM/iv+m4R+mdJnXfDQZ/JiQT69XPOf/i13CROr2BHLv0fkUOBeLQ9hiPq5xfJl0W/21+EhAe3MzMIzg8smaFfauz49lI/SEGm39pMKpD2btteqFBB9bpREaaGSc6RveIROlQoNwkPs3+jSq/KjTsci9Rk8RvhpjfroIdy9gUeEPzKmYkOk9/dN+yrCn36h/HOET4/X9U2CH3KFzmh1FXOu97i2VcQ45+7h/A7Y6dB6jcP8WVD2rssNptFmj2tnIdjanYPzee7+WMdWl8mm2hsxyXCNDNekR2tBdQQ9H7jNXnr9vey8qjpEU/Wchyrul+A7ICZeLcDm+apy8DLxnAb9xtcAbb4RdwdHMgfJVWvBuOcpuezAjvpc07Zf7TF6Bl+Tx6rFR1uMD5Jnge0pEV43Vn+pjnLcP5Jsyfse1zwo4FntpOHcC9hos94Hgev6z4Jqr/FdQfDbNvSzv7RFr9ozUr8bcNYP3vtJFsa4tu2vEvAzvm+YOL96vUdrQPgH/uUT5zNnAck59jHEK8m67hOuU/UsufY7z81+SrT9EAtxc2VUzTFtzWec+8McBnwP8OgD51nX4DNuZYvroLj+wMe+j+u9YrWmVnBLd3+u99PUuUcje4L3KpebbIBOxcE1vRzfcQDfBjhxTdh3U9CH2N0JN+tyz7FW5M5G3S9U51jtcwK5B76PMYJdyXifjgvCE39clLG7r+bc1t+35W38La75Q180oH0G8ccRdGWy6BFeNry+VPyiunmn8/PAwf1eBcY10OYH1C9c3HMQxKzfX9ZL97i+k+TxMSlA7sEIxs4A6Cg29NmtVY8Xvwu/Fb42+hMH/ce8Vf0yRj7eyeieF2R+HvSH4M6Lav+YfP8c7h1Y5BiHeg9wjkqIjzRcIyB80kZ8qvrGg/4eE2gfYmrQC/OrdjyQQUmecb+go/Bn7vhB/a2IY5j7qm4yNvYwRgidyWWP6xw7r4vxWYF7SJ7Jui5fteEhX4LT5UEfcP357IAOgd6t41Dk7O4JYi7nFdpzyZ5aP8V7xy3IE1cxsW/3tKTd4rBQ6J6fAtepkrwan7jnhfBRxXWnB/zeEvuiVvvi/GYfG1l/9DBO/LqOjfs5MJZ1IN6tbcLVc6RfkD/hGnU9roo7HuQ4fuu9Ad5oHXVPPFmPKsiawvfP+/VevwLv/FNxXxCMU/MhHU69P9vVVIj/ce5/sH3c9gr3vjxsA8biBeL9z2/7gvus4dl7nRkoMD79RHvMU4fE/2SP6x3MrfQU7RQHdi1/rJMD9AFcNbfvKLhWcMV/8Fugq0Sud3QX4hltDNmDoiB9agjPHpq6fjBYpWjjqr02d/QR34D5Sehz8Dy2SfYfLr3TEffI49oR5jEOWUvA/bLQlwdjrmlnVtsR4DcZ45PNapVAbo3r4FA3bHK8+37gWjzkfQoZ+z6OhxTaiZXHtqbB57fymC/bVDGX46t9GJ66wdwHdOmSNvkVZx1wf1F8Z+8GbrNvLuEtXJc5/8xPDa5k8KXOVfGBDrr1FQzHNOSzg9p23/PBR/vR7t8XtIAe7L7B09ZtHvLUM9nXBLZI0HBOEfy3B+OCrINiHKQLgL+s1vyqPb6VXwRZjXG9fF/tkwpSum9/siHrcWDvCU3NHAb60DXo5gXzYojxLiAfyHuNAtte5NTPkvZADh8JD756bIBPHMFv5bOg0XlW9LtcqxzMA78naPWYABs/K6ypm9fzQvJXsabBxxy+L2yd52DTkXZo46acFqn6cK5XXWoWxI1kzyl9r6WZbwJfgzpZ270mjrSmi81p8A1/AI+1w3dhcP91PRcBdQsOf4N+VfEfxlAkxrr6rfLjKlljfAa9HUCbFrT3Z7IhewpJLAq+Y3NbF+KLyxz1XEHafRyTRP5NX4AuQgOVu+Zjf6FvRYn6A/0hY8oF29nE7zd1zrj/gvy2rfcG2uI+4W73zbB3V4G+SzOW8G+0SVGAOlBcZmi3oa/kb6RRGW3AH6+SnkngbuB/RCBntxvLRN8g3gef4kFchOu/mBfkgoY21j9UPreOw+E5pB33pOKechd9lS2Czn8Qu2gDX9yekWPcCDpEYiZ8n6IaJxBLauoWdPujesfcwXd4nvF9INxP4oyNVdxNid2p3i2BOBb/JjHWzbpH6PheXj7jviSIR7cQy7dicR7Gu0+ea+wvif1Bf3A+aeFbmEOsiVwysQS6yFjy6n1j6P/TKg+ox8YXdbcknqnzNvu+DoxLIjvu2lZgrJHg3tqx5S34K1rOGBvNIT+DZzjcs2RX7+0IyRfrP8BL3HO5gTylSO/2WBUG6kAVL5Oxg/tOxdt9xN5mRHww5kZEn6qYvHq22RsYklyI4KhzJeKnF/h+US+vYbhP1t/WvgfraySWqdue1ee31bA67/QxNiQ+0EM97ZJYuRlT+JxX70mscKiVH6xhYMsdbo68rt73yG/e1xGSno/ybWwqT/YDdwfgRzE/ZnOgld8rFGEMNmnj3R8GIQjJL5xfsm+mcj9xvsC8eb9r8YGnB+L65OjzTzM/0Fr0dT9w/ulmU9bnL3j+guuLw1+/m/me9qYtbO+TtHczV/riwvNPG4QLN/PNBT7f/fMJcP0RfPH5q9PpYf1Rl8Bv+hcivExu6F9Ae6MI6Z0hvRw5Tv4Z67sTXJ9GfMMb/onlrwftR/j8LX/Uh/XnWH9pwvPP8gTgQ9z7sLDkTmfg2kBPwr11OoU1xvkffF9b4eD5V+sV51s96D+H+wWecP/CycX18xIneUJcH+/L22b/wAnLHSwPk2c86w/Xv7vuDtf3sfyJ5Y6M75dGz2+4vg6Pdtd73D9wmfY6rvU26gxX+D59Hk/xGiNcNL7YnbenyDz+6sSy+9QZCs+d4/DgTH91NsriqTNw7M7xSQigvFZ7Tx1utQK4Mn/71TlonafOr5OPuygS+GeF7RF+iROPu4270X6lGLcILvj22i4Jnnu1N6trXgy638mWdfAj5sUke7RW1b6ttS1El6s6jiU7V3Vs2TxHF7uEumd4pqm7xroVvLUX7B4fZyptfPjelnkWxtHd7+ZFv91b5tD9WuSdoZt3kfDdoXFE+4PzYzc24R3brn7HtY38veqvea5xvAPvbt9Pwj1s+LubYq68Sd5vePS4DsRpV32/ns86W0KLr1/0pf4d4jF1oCMfSNnZV++/DFbJFui/GGsLrAnQ0/+Wno2JOEnfq/cqgQblOz5FwvV7WT/ikUrml95J/5iufds/jEkVwtP0/zkc1zwjevp3XDNvYFSxrP1P6JPx/b2aPpCN+Hf6+Js5qUo2nek4FqZcjWtrrOD3p2pM2OU/09dqrrie33iv2vhRX27mEvMf88HmPqp5Hw/fzVZzzONRh2F8Xund7XwgGcOSSfeNVnYD93myvZoTfEYR6nGePTd2y5Zrvsg7rI94LiaOw2Y/KtirCne2Rv2mYxifz8QgXVNcDq2jDn6F3MANIJ6NXX503xb0o5p3gHhvdNAr2q7539Rh50cldNFHZk55KlztpxM5P1MFvOPcVleCbYqafVAEvKc4UxyptKEMTaTk/H+ySEJWKs3dqln3ix6uqprVPyC8XLBqP4sL8oKWI206kjXLgCw9Aag0F1xB2OO2rVcBz2PREJ+TaZlgcuJBkBORR/xpJkzyMe4HEPu4YwSvrTiM+4KiSWPcQ/gOjXI6YOhJL4Lo2nkp+KVhC+pBWghimm2BXO4Fmg+llSD+tvcQnpgvnjBWpQNwovxjC0vh1RTGz9JFkGR8IWTVf80F/Y/0LEhT+7MU8vK1FIyFNEKij5mwTV6HwssYV8eKsrSF37mpCy8DPLfLtU8lEG3uBHElv0L/yy45OwQvlJDxEJcShYUnpb9O5EyQOKFvC5868Eww5JUgPZV4HGmJ5SOUBa/sZ4KcT3Q8n+Idd5ngjQHJxBRMHXd7vJT9UlD7UBbXco6HygxA8goe/PEiF4IMZVsY96FsbuUNrqgOoD1hgudJQIAL4noGWduTHNvfow49g/dVJngZkXxB+CjDk/W5aieeDTK2FQW4IwpjaMe2SlFQFFtSYBAJoEuvpW4rF0XSRdEH0diSoGeKVEJZmGBZt/VS4UzJFMVAWAv2C5aFHZStBMt4gIfS1SVbtDhQI1uyodw/QFn4xLIoGKUyiKREnOyFLQxMLCuKtBMFRzgK9tQ2gT5PBXwnwGB7oAyKkKmgcUsxwvYDgEdqLgqpGGP7AdAXqQdRfAcltMdlCJqlqxAnhqD7dlxGtiLaGrTHiUDfOJsDj3QN6s/EPwLUnpfQ93EkCn2xi0fypHi3+zgRRdRXe5otBUWMxrko6uJIsKPyDeDRuC+Khghxq1pmmQINQv25pAE95SpTxL4RiZORFApuaW9sZXQwcnH6ISWC+1TuAF/2koi2KO0ETxN+C8r48AIB0UwqBdvIDkBfDiNKXGJ5bB+gff3VFIXfoN+2JXwAPHq1gT6JF7wX4cNWpOGrB/RLQL9cfmSq7L0CvxQJ6Fdszla0gwXPu3Io2BOBB34OLYD7coz97QJ/dqAGoi+ngq1lvRLas4aiuAf9tmdZH/pjTuF5Q+6BfmQjjDOnQO9Ohval7ClTVG4K8hPlX4I3y54AnkxBrT7koeAFdgfo46YcbsR/EmzfhjhVyqYgnxe5I3i428vA28Yl+E8U0FrYutAXdEmUwbRk4Ckhr8mERALtgz/8EjQSEGcSOSsm80EDdGEo5NKMmDqyXRgvXxVEcpIMeRkHT7PExsFqQWxqC0qAa9A65nKzHZY5LE8JPANkygxQiWNi7yIsl1ieIE7bxjNfJgLuVsfl9ZmO5QOWrQzPdMJGlRf8VtFoOn0sIxLRRMVySyxrgoemD0ynsxMBf47lV7Dpghth+QnLIp7/bOMZ/0BvBGXQ2VIl5Q2WXxEOz2f4PMKzMXm+xOcT7P8Y+4/lPpYFPJfcBv4hPMP+Y1kmhwdh2cKy20e4DkNVVDID+yfZ9cYKsZWkhXuwJmpfERRoINGJf6gOiSP+q2viHkzymbZyNU1ewRjJD5aYL2VxN1TrQ3oqqemy3Bxy+JKx3NnJ+vYqM15lOzaycmliPSJaPOhMkPQT7j0gh0W3c9FoouiRNCs5zYlMtUqVbXLeXuXq3mr6np7YXpg2fRtZ7JfamhxUBqacOOG12dAXtXLTFn3jrJxPRbs+xGhCznkXLg19T0X8iD5XN8drAerN7Mr/wtdvaV3fyzAsWW78NX0W8n8s/CZ7TeCzKb1H9JlX/FNRFaWdiXt/CP90/e/0SeSqA1Pe1vQ9ZY/lG8i1uhD6/iB9L5BK1/SdH/PvWr4W3nIv2pPOr38gX7A58HWWjzV9ozfpIf/OV/wzSGwlqg19g/ZZAV/JV8GhJOvOW01fR9H+zj+RQ33bKZd/xL8t0ieurIa+eWn/nX+mjdtmMu/tH/HvgPR11XGjfz6bG/pa/1SMHS3Ra+jbCQ/5p2a1XhpVfEvuB/cb+k7Z+BF9s+iKfznZPqU2/Ou4P+HfGumbrpKGvovg/Z1/r2gbpSw6/iP+JUifpk0b/l3EH4xfEZUWLGJDX8cW/k6fRAaRPm/4NxwKP+AfuVrtoDXjdxj+xL684UMvq99/GR/X9L1ggiKW82b8PkU/oE82yVUZGpWv/Fi+1/SNkL6JePhH9Il4ar60W9Dxu/sJ/xSUZ6b9auh7/gl9C9Q3dXVs6FPtH9g/w8Z7POxk+kP6yAZwaYj0BXpD39B9lOmRgWaRe0KidaPfJ/PRo8Sfdwj975OGfuXR/uXqxR9yf8X5J/jlUkP/nTf9K3df4g8xYzXeZw1+KfsKvzgk+M0f4DcQv6xfOn/v/xHxy2v77/2XSf+XeH7m3/BPEb/Y56Z/xz/GL/Mn+IUhfgUWtT/zL/GrJb4HEHFN/88P+d86f0199iBMXIoYupZjySBrITlt70WUmhOqf+Y/yXja2U2liyk+tK99E8dRbV/JwcdCpridf+I/yaHI05XSoFJ+El++EnniIa91KJH8wL/LBN9SfW3oE38S/8oYH03EWYNqnv3Ef2J8JEVRczA4zwk/4F+CpjJ/CRv61J/YrxWJ79+3DX3tgz8gQ4ScN67592lKu6FR2X+ML2X7d0Nfz/6J/feIq3lp7ikbcX+h72/6mVD9fH2/NPRLmfDv59/P/66P7sjVewaQhSuKdPNGuJ01JVGi729Aoi4zuE3hTcyp6ILG4AmFN4vIADcYfMfgJYWbDM5RuMzwTym8sXQAVxj+GYObFK4y/D6DRwzO8EcMnlO4xvAvGLyk8DHDv2TwIYXrDP+KwiWdwRn+nME9CjcY/i2DZxT+wvD/ZvADhb8y/B8M3mdwhr+kcJnJ32T4LwzO5G8x/F0GZ/KfMPwDBmfynzD8QwZn8p8y/B0KV5j8bYpflBicyd+h+EWVwZn8HYpf1BmcyX9G8YuvDM7k7zL8EwZn8vcYfofCVSZ/j+H3GJzJ32f4QwZn8g8Y/jmDM/mHDH/K4Ez+IcOfUbjG5B8x/GsGZ/KPGf4NgzP5zxn+PYMz+c8Z/gODM/kvGP4jhY+Z/BOG/8zgTP4pw88zOJN/yvD3GZzJf8nw/2JwJv83hv+JwZn86ZFPuiRSuM7kn1H8ksLgTP4ril8aMziT/zvFL70wOJP/muG3GJzJf83w02PfM4PJP2f4XQZn8i8Y/oDBmfw3DH/M4Ez+G4Y/YXAm/y3D/0bhL0z+O4b/ncGZ/PcMf8HgTP57hn/H4Ez+vxn+PwzO5P+H4f9kcCb/A8N/ovBXJv8Dw88xOJP/B8PfY3Am/0+G/5nBmfyPDP+IwZn8jxS/zPy/yeRfUvwy8/8mk/+J4peZ/zeZ/M8Uv8z8v8nkf2b4mf83mfwvDD/z/xaTP8fwM/9vMfnzDD/z/xaTP8/wM/9vMfl3GX7m/y0m/x7Dz/y/xeTfZ/iZ/58w+fcZfub/J0z+A4af+f8Jk/8zw8/8/4TJ/xfDz/z/hMn/F8PP/P+UyX/I8DP/P2XyHzH8zP9PmfyfGH7m/6dM/k8MP/P/Uyb/DsPfaR3xI9L4tJ7fUnDPgN3ATQoXBQpXGTxi8JLCdQbPKVzKKPyVwUsKlxn+CYMPKVxh+B0KF3UGZ/g9BvcoXGX4QwbPKFxj+OcMfqDwMcOfMnifwRn+jMJxjb6JTxn+NYPbFG4w/BsGTyj8heHfM/iOwRn+A4NzFP7K8B8pXGbyNxn+M4Mz+VsMP8/gTP4Ww99ncCb/CcP/i8GZ/KcM/xODM/nbFL8oUrjC5G9T/KLC4Ez+DsUvjhmcyX9G8YsvDM7k7zL8FoMz+bsMv03hKpO/x/C7DM7k7zP8AYMz+QcMf8zgTP4Bw58wOJN/yPC/UbjG5B8x/O8MzuTvKXqd30o7O9PrE51WNP/9oPmv7Nl2A3eqwE2+24P9f90nqRMofHP9qTlRYiz3m3O6GFwsH8FNudIVgGdTIgvRvrpK6XqqV7rFPxwfJLqjrAmGDUes+Vt/bibJtFq/JLTvTVomcbV8rh6Oa/nrOD/RQKzb9m/nP+qxKuJZek3/Zdb/Kev/8BFcrH0Z8qe++Mi7un/qaqpcuu0euKch+U262mun1PpJ8zD8p0/5L9lPzQl+FqNfqH0pyqeeobYFXX5u6CspXKh9LcqPEaRdyU+RqvurW5NBY+5eftJJYvQ3AMmu9IPg/9XgP0wPFH/nAX+z6rJK5G9G4ZI8as5pa71pkF0tVZSv5H5K9psMuRilklLWjH+vLZqHo7r1I4RVDX9tedfwXzCr9x6uVkRal5KVtS+wBaNaJiT6I5uN/bErX3KL3L5vSj7FjX0q5coW3ry2oNyPP9EM7O/oo77KBqdM6TvI9rUWEqXw2Pij73qI/Uo/f2ASH9Zv7O9/Wl+Ofl4/YvVZz3S7vLcf/1P7aNfjk8j/P7CP5/Hwwfiq/dOX9vGhfJr+fXH6owjS13+mf2qtf9f2k7WLkUajn/XpK8C/X7agN/apgitfjLAWCamaN/63/DF9uvM9fROBjh9T3N3Tp0Is/kP6tjV9VyumLbxDsaFfFLQmvnj9EBr8uxr+9/ErlY/GbxsvbV+FWL9u/5Oj/C8V+4f8M//CP5G1H93z7yv6Mkrf+CF9ELb+kD6rZf9E84f8k7mgid8UMPc/lK+oNv0TbbX8IX3SifbP+7F8hWHQ8McUop/S51L6pFKzfzx+KX25OGzGF+R6Nf6p8NbAbYnpj87Gb9bAdamJj8VSr/DbgqS0TEHbvpl38UOim/f2TXGUK/27PWlWkbYN/vkLG1+7hr6X91UD777Q+L78Tcef9JvK56Wk8v1z5eVE7JH272Lgv59/P/9+/v38+/n38+/n38+/n38//37+/fz7+ffz//4nI68CskuM7uBSNb+R/IftVzMCZOtH9tLMLxj9I50fken8rFzNIxB6dg389/uQzk9M6fyySZs2pYzOT7yWdH6qQ1cpSqGZ/+hT/K+HL/HXjVH85fl7/DOKXzbv8Ks1/taSCemf+ohTuFf02/llPa/mb7/Y8V7tf3sRqDxv65eTav6t/E9VRaC1s4+GP2v58C1/FIlr5ONNHsknq35CJXlt5heNw68H8qk+RF8Fin+3/h7/C8P/Z/KVflRElBT/a/LrW/2UWf/Lu/7jjm2TdqpimiBcv3TNPkld3/yC6TtDeTT/yT4U0MzP4aSiQsfzy+NanetVPNIpO8/0L+m8/rD5ycPLruFPRunR2fzgxB1+xR/9J/bHk/8b9qeSx+9G/q9e59vxL77/aeBH+dH4F6hU9ZdG/rIyfTT+Kb/+Nj5le/pfGJ8VXonSP3K/t18Bo390R798NT5a93tJhwfrG8TIv5JrlCyXzg/zh/v1z1eDrm+FxQO4cqLwhfoArqvf1zdW39c3RErf8lH9V3X2LVwzvm/f/At+a0ThK/9R/dH39KkMvnlU3zhR+veP+G/wTgM/PGrf5Kff8lfzv4e/WN/DBdH7tn/SwP6WvnHsfN9+/D1+ZeV8Lx91Qu37I7h0ou1zD/F/fK+fovM9/drJ+pY+qfheP6QRpb//SP4S0++HcCX1voeL39c3rO/rj/9SX9p/X//1w/kWrp6+r6863+N/+Qt+Pf6+/rj4vv70L/Rb6ffw6f57/Obge/hksGjgktqs3wmfoUD37yUN/LWg63s+has+hS/4B/X1lMJ9v4HLIoVbAwoX1CY+E45hE3+pTsr0m7vH/+JT+IXWl01aX2LtD2l94Rw265eav6Trt0X/nv5W/0q1T9d3aX1TXP4vhmd1ikDeJznyUcO/5+DB/hy18Jr6izC7h08Kmt+sH8E3ftLA/zyC/y4ovPsIfqJwQQkf0OcrVD7+IzjnN/0T0kfwvvo93PS9b/nT4Sl9u0f1Ff57/iw8Sv/lUf3St7+tr1H+C8NH9S2frt8/5N8vKt/H9RW2P+ih/HPVu6XvKj7VaHwrdvxm/E2s5YP40KZB5GTg0/0FHh2fNttfwvwXwy8mLt3/MqL1P3LuVn5gXz6WzP71b/XTFqYxhYvq8Fa/bEHk6f6NsU/j54DCpdXbfftUvqz/AJ/S9ql8bEE+0fpdWl/8Q+HaB4X/ouNL6vgN/caJ9l9j+vVE4VOewh2q37LhNvydOhHlH9UvifHXVCm8V1D9FBn/fSqfN7WpL659yp+Y1r9Q/RamFP4aBw38TMenfKL0S2x/ksY3+ikFFP5yoviFoqkvjVv9p/HTH6ofQAqVr0rxP7Px1Qka+z8dUPgf2j/5jcEtyt/Ep/1fULiqUrjM5JNS/NMB5U+f0ie9BMw/Uvq31L6IGe2fzuLDMRsfKR1/j/fnbNn+ffZ+w5zt7//N4Oz9hgV7v+CDwdn7DQv2fkFJ4WP2fkPC3i+4MDh7vyFl+LsMzt5vWDL8Awbf0f2ZGsvvV17DH7FP8/vETMQmv6X8kXIKH1K4sKL6LSsUbppZvT+4Oi/t6/3NQpNfQ/wr0fH7YjT7k0HU5Q/31+psf2VM+SPpdP9VS37Lku7Pbzntl7cH+99sOn83Zvl6qTza/3e7fx1nX6Q3qn9jNn/i1fwB/RLZ+GL8jxjcfAQ/MPj8EXxn0v3hbHzrQkt+DVyQmH3YteR/+Fa+ilk+kO+ju0pFm86PGO/Z/fyZtPuxfI1H8hV2dH5qXH4vX+X36oF8Z1S+rUn3X7V8oy/k22rCYV3NKGjI0/jhRPsvyVazv31F40tJoHCVwVv2+TeFmwyuM/vI2jfk6l0/pT6vRsjuu9DEf3R+TrB3D+KXwLC/nz9tyffSvF+hsffDIjo/Jo6Y/Tm09r/T+s+7B/tv2fip3n8nZXFV7c+0WneYtlO0/+ZbUeUNKSQ/re7YuHpu4ouBevu7vI01/xL1jH11d1C1Lf+ZUyPn9vcJv2/fRVLX/237K+P2919/FQWbCrbYj3h3Cp9s+u05043B4FwU3I5bec3m1cX6bscreGGyM/PI/Z14t0K7fZOdmYh3Iq2SG7jF6h/iIOZu8OdLVv9c3b98jf+N0Yd3pHze1n9j7fP3c+Dy+xs783SHd2/d1k9a9C829h1/UgYv8V6rNLyCb1LhGo73tizYncO7JaMP79jpRaGB9xLhvU5Ai/yRtuCmfU//MmvBswdwoQUv7+ERo39jPeBP2mrfeoA/arVvPcAftei3HuFvtT95gD9utT95gD9u8+fuhDl5vbiCK3fwuGzD7/V/8fPVBOnBotJPDOcDq6X/J5bqYX22VCKy93/H/e/9Ix6QduefBfb+kc7iU+GF5lfC9/ZdmOX0/QCGzGPxUUaNrHKq3o/UH6/Utelqrc/1HznlGWNPfbeObGf/nnn2/8HPP9Bv9d15tH67oO+HMv1+oe93/E2/pZc8+1a/d1S/m/PNjC/0u7VFYfwo6Gytf5qPhv+4fr9flv4vfT+c9S+j+a8kfc9/OcsfxK+WeqDvdxXCd/tDpH4hfJd/tIQyfa/mH7S/0/8wP9DZ+QoZy/+b8xuuzFNU57/mF/Ftiz/KX+yvXfVPKv+BT/r/k/14eTR/HRm7+/UfWUru7Ydob5u3yFp6sTFK6V/e/vv59/Pv53/Dh1gociioRE5UXJH5s9u8yHvk+vq38wsKTimNb7KE26MA6l1t2ER+s0uBuVSyR08ksY6L7lnFs+zENYLnhGCyQPaM5TfErWj0WhkP5y9VPNtHjLEcom/VMFaA+lCOMRbU8Owk8UxWEfD5MZ4FJY4QbuP8mo7rFfIM44cevq87KbH8jPSeIxmiiHeIGuQ1npU97Mu4axaXJqa4+a7XxwOrcRJcJo71CTcP2gneXTPBu2v0Hd5lg7v2VBHvppnhXTXeM3Rd9bEcRlCeB1DWLlmELAE2xDgPqWVZIoh7PJt8Qcp9LK/QScXQQUGbQ6Qg7rC8QAZqIt5V876DqDI2IYMDOJR3eHfNfIPlE8I/bShHEYSQmi/ssD6kUPNPieCH8hFTqiSAKEG3sgNeG/YKQu1Cp/XfGR4WY1u4v0GGKPlD4ACOp92tdnIm6FzWFyQtmwrCe4B3oz0LQ0EydLwlwFPg+TcRorDJDuKg97kCz1uiCVqoQ9a+TvBiIWllC5IagfK9T/BolSOWZduH8lmF+uNVJEivUYCnnqvwvL1KAL8e4vPARP1plQE+O8ZZT9A7/QR6Ks12C0Eo3rVSMPYr6M+ov8BbH4Cpr/oK+sPtIDj/OGM5x8NwnvEy1yPCLXnFCXLQTwWhu4EhY51FKNvlUhB4c5wJ1lLsC3KUQbmbYPmM5RTLnDIuBSteDQV5Ub6hkmAZhSa7eGJhF0/YtfrvZH1rBfAJcMkS4Vc5iOBXntOhvfd3KM/xWrhuF8uCZAI+PDKze9ahved3KM/6OeB7AqFaf0DIsg9hrNA7G9DeEsJUOY428HxuQP0Dlt8yKHOaAfVdCGPkeX+L9GH5/R2UfqHDAOtFoATW63uO+PZQfnmB9tT3HdC3+w1l7QXae3k/QDmDsdobvkB97x0GySI6QLkLSgPtA7/i7APK81eor0vAH6/8BHoOr1B/LA2x/0coP71C/VfomRzvwAD0NniLirdWBHkZnYBe24Tn+zLww9ldkH8mPD+UTazPYX9BCa1s7cHzeKRiV7PgeVNOUB49qI9zSxZe4yV7uwHAhxOgZyRD//zsGcrzCTzfW++Qf7+gXIIFsOagxPJbNMS3+Kc21ueQfyNobzeF50O5j/Q+Af5PLI/X0B9f78Dz9hTq/8ZyEkG5h8cIWWaO8sajmXg8FtTiFcw6T2A6eMmG9iMF+htiuZth+ZhDOcUyN7QRXw79XxgS8hPLqgL99wcwNPmDDe0vcyjPT1DukbICg052Y8DCL2HQWTmWF1juHbBs5MAvfw9DrTtzUL+x/OZAmZs70L6Xg76Ejob6jeUSy8uThv13kD8K6g+a7d4LltUc+Bvh4k/3cwbt92CQQ/9ANfn5DPujAL8dA1SL+z2D9mYK6pPzgvix/IHl9APh7zNoL8hBv+IYVKlnQnn6C8vnFajGKHPxZCkwGnIpguhHnIur1nh72Wk/EUTryc0E90PpC8oTls0S3IqX5ENBnYhTMMYZGBkvgpGivkDPRVvxbCirCpRFRxDdA5Y1VRdU3OsmziQvE7wzll9PaMwjH51k4QmqIfrwfN8n9SNoPw6gPPEB3+8CjLy+AmPubgKAO8UO2j/NBfG3FpTC/FdxELQcjJh49sCIJVxRCuPpHsqlGdpCYhScMFb3qSCeDljmSFlcCuJlFmZCIhZDYSyv3gD+FJZCwmN5uodyCZ5ESGYgqTF6efE8hPJbH29NjPYr1K8I5HHQwB6bMZSPHJRf9I0uSBsH7M3vWZQJLxcsr2IYlf48AtOY46g8YFlPwMiq0QZYFw3wwkUlxgtXcH78PUauLmMA7TQP7L0I5SyIM+E12ER44AxQ8fIbylZXA32aOWB/+CgGeW81sOfPpy1eUABlScXgQR292ZvTMep+vEXdUbm0xbeQMw6LrvUn7Bl4n/oq6XpCyI8mHmcdFxsL1zkKr+esoI600EbreQl1+BHUX/1Jes6fsOuskm26X2Tk9/flxj8vqmcuqaau5zzU0T7e4o26B897/3sPcEJfwy65T74EAb1FeGcxfndPR0JP19knPXGVatYu7FnFIlDLuTY6x/5onWx8cgd12PX78xDbiUl/oK+bZOxzCdASd+FbK3L47c88OB3g+zAPLS4O+vA8v1powBOgax7uC4B9xAG/TsY5wgAXf0w30D7wJwLFA/x4p/sK+5J0oQ/QNtThF5vTfrE5CHh3qx1Y6zi0LvPA2C+0glt66XnR80tvMzrEwHNch0p48Qx0FknP8pKtDzzxkT4xUIqLNzZARv4l4Z1zSuh0wnno7NyeSO6sxT5BG/7Mwzu4gcatIy964oDcmwtwd6N+xKEJtKiR7xUqyBX6NOBslLmncnhPbLT1udiv76RHvKpvOMEJ+ut/pgrIPVC52Lu+P/j+ubRIVWeQaPCbcEeTkXBtXFaRjkGPNqd7fKpYJJv4mGx4sbo3uX9Huwd8tkMH77N+T0En/Y16SAPv4XNuALzrqtt5MNj6WgG/j/i0oi+IghMfe3X/7PZvd31p/U759Ad+p/Kyu6sCxsW0Wncc2Mlm9JFAcBNyJ8sBOmZdI/fHRYl4fKVwK/5bfLI1kD+vcVi8L7rqOVZOqyXSqBSfqLNed8QnGwvxeTPfGsMYNBZbkU9V65iGxjr28f5f4NnWGSBN2DbqDNB+TseFv9gUa7wTetb1B66mDkD3OEdTwS5Bv7hYwbuRkT57W4BcRC7JyO9qEvpEr+FvxOktQ7GYeTimPmQnN46L7gnGwEADvlywT3PO0uzN6Ih2Y1GArhJ5WGMnjIlOVmPTb/XT76KMgGbZ4aq/bRxXIE8X+p90fTXdgD4QGtLq70YXfQvG+uiwUNNdHPiHCod9breF/Y02I7Anjgv0Uz6A/TqjLrSf9TSwQ208qngEe+YteHEfX/0OeqvEhyhIL1f1Ub7wHQdpkRSVfjibAmyo3eaBC7w/w1iWqZ0C2CzgV2CTkMd6HBTb+di+/T2cBw43r+gAvfI3YEfgOcde9CyubluMiP0wSV2QfxGDDYq7K6ANeeZ/2l21TMf+GcbxmtiTkrQ3iwNsQ+VBjtBf4H+vwu9t/DUZ08qqqNaHW8+TcVXkwaPf7LvfPh8893n7nN8t8hT8Uo37lMK4reVQy/6GbqAZ7Orf+ge8G+D6tYk2now5H/zTxjmmHPiVzbDSZ775zTim8DzWBX0eA02fuK6M4yYO9ZtnB/wiMAocL1fP9tLPODRsMlZ4X0Y99MfGarG1DqjbgjrMk4tSOhv0E051b/laOd/eRe6vzW7Y8z/BN0O7BfkNZHRYegbor7ONvRh8Bj+NNvuiurvdl8Gey153eLKU+7vNbd7aYpwUnp2L6Yoa6CK0W8FM15gsoI0YxgjQiPYrcAPli2ctiBOQbtVNwe/i2rt98d+X0LfkEoO9H2xTbSUCvsDrpm9et+CiLsQ2j/t9gRiA2CAYl2DzVegX9LtrDMBWXLxe7Ma9ePsP6vZCsEuLTcrNVQt4kvyDPqRvi268AbsDOlV0Y9ABY2yeTCUmOlHxpX8yId4h9tO3uEXPwDEqf8mrtYGx1SfI5pyCTJzQAFtteAvOP4P9Oi9Ds3RciB3AlpuKWRIZZQ/xXnzfMP21MgDeVPL3naPbNX7j+JmDDYC6R8sbuPic3Su0xzyzfC8/BeYlfoO2wR4O8nklb4x7BvbW2MdaWjhbsO/e6H2ONkADXnjWwPYsd3HxJx7vz1zFcmMunn+H4yueWArhe2C6zgz8B/QDbRWMW6AH8Fjolx70v/JZfnSy/BGMfdxzY6Hdq3DmoPMhjEXtBLGp76aBca7aHnIp6N9c9tdIA/hDd7Et3LkHesmDbvGgI0r0Fzr9N7BHJdjdC9r6enxMrQ3GQ/C8rJRExriXaGxNY2jf50fcF3L8Sz9GFZ8rGtfzIPkLbcVbVMvM10ZXtgDsQNctLDI+vtYHh8BRr6KNeondiHOIXjhFrFoYX33Gl/RYxzQXj0cd0Hu03es6YBfTJv65+MVfeXCxCqQFcwvc3wX0QBy3GBcS4M1hXGkYQ13peK8QiZ7nMJawDe87Paz7lquiqeh9jIlgrAOdJ9H2+PVf67i+DP0Afqc88P5C4qPQEm0/tb+v238sM9WHeNgBmUHsBn6yiUOAp1/ZGs6HweyosQj9Xse5+W27zXjzOPumnYH6Fz05mYSfxbqWwRni0kElO8v1bvuZeyfwdly8VrrgT/PY9z/BhlyswEKcHOqINy5Atj7EqfbJKuJxiONMszZ2+XWbE3/0Xssd7OOV7QGdW4HdqfWR+5a2/0SnXGj7OAH73Mik7Ss93rzj50QhfjknOcUaIgIt6sO47cb8D+vk/IroEG+tbuXpuCYXdv8B/fywi7YpDU7gtwzgVQr5ugr+RR3Y/MiNwqLvQH+WW0cLar5F7n+Hb3XbRwvzXPBtUAZ9ShkehN/7bd4m9rLYphjnc5Wvtz3jYvlEZ/p+YVyWm5MV1fqyuEB8VFga5OvFTFOBVyfw13d94NOeAbR7J1ODfoAE4f+L240HS3XEzThVhjiniheYLZgBHq2WxeBeFn4P+s+Bp+AWXAz5O7atchB3YVwF/Mn7MbN9gyRwcE7DjQrLtT31WuaQ43m9Yharo7dF7XPQhtR8cyGmh1wOaFWSu5jD8kh/9nHPh5zPkkisxalKAlEB5h0TNZ4lvf3BDcy6XV+FvPKYFMK9LViLOCcC/r54jgNHAZsGuVRREh4C3SRmYvkHwoEXg5rHah4rxQfGS1X+U/2Ne24B/lnjaHI9Mk/Bcs3UWAQYowHtmNdvah7DmIa4dr/EeZUujnvrDeNcoJHUDzYQ/0L9BehexENO3U1d4DnOjxzBjq3DLn8BPw4xn+OmkKMma522switLeRmn8DzSwo5EeYwdTvo094g1jvEGf3tjPtso5Dk2lXbkI+CnyXzWfQZ0B/gh5iGGHPi/Ab4wMCZVXuAB9U8QR3DTLxqHLoa+g7IARQ6H3IxZeXihCsSVyRdyIk1X1oGqmSqood5N9Tv0TkR9A0k91QPIBOwk6rtayWR9UQ1Vilf5ZweX9R1LXcG7QP9q5RbrZJuPX/hOkCrD6Pd2Ic9kNq48RkZN9fUy1wGuWydI8Sl3RmWNf/sb/dvkPN6id20W+yAR7tqzsV3wRZsWTsrK2nwq5bja3ptDxXM0Y5z0PNou3pbjsEWFc6pHneOGwrMbmqnY9rFPJnwFWxy0YxP13TVytY2vqBn3o4NEfR+tYRxlFycypbkae1fib/oVzkVmaspYoXkUL6vRP2lD3DeGLTG1LjlA/7Cn6h5jofxzmOuj3xp6Kax4rgYgK+h/ZmovuesV8E88Hs+5jNdnPfycU5RJvEq5DBLj7bd931HA7r2cZgGmMPEG9TZYrvIMff0+1agbmDcneHZ0pHFwPbiNm1/rR9eVsd4E19AlyXkh6nYJcRCWtiKk+/bSVk7hcVH29qeyKty0bMqX7I1ed8rPuG3AHkE/M3jcBWgDlJe+MgLpetviiLlo4d8vH1mXrXzNtFGm3iL48MYtNvH/mP+SeMFrl/3AfRzbIVeratQ9hK+juswfukVl8aWAuxirn0T+nKBMXpJWBwC/Ypx3m2P85jt+si7pfazet527/qq8exxOzbeVcvzts4zjGkWM4G/hTY+sW3Lq+QFuk1zBI/P+2AXevVcaGnyOPb10gv3EJfQsRZPxsxeLFVra8rWLApTsDvqM8gD4kyLjnUQVknjFBnjEn417/o4l4bzMyLY3BnmLwn0B+dfogDkPS6MOB8cU0Uvl2GhLf3VIeQhPrRp7AH5fTOnPChSzuBB58BuK1y09TeYC85Cq8YBsWbAg68oPtKAl6NQhPyu4Jaucol74MM5GC85HVvgd0fu3LfewV4NAu305o9NntK/XjV+BX2TlAaANTQQD8av+8oH+TnE/R+gV/tF6H+0+gT2On6rfTXwCv10Crggx2lsRFe5WPxolYzxfQaHzbOHFsRmfOFDm0noFzboZqvdN+D/Z4z8B/qhvT7o/D3PqjjLS7g6b+Gtd7fW6VipdbqbPeaVb+2W4WoM4+CtHYPPvaYe9G1tybi2ALbQxTl6iGUw9+kCf8BHGweQMR0ryWVF7GU9BvuxVuAaDthUj4tx3sA1uAXYi6txzqnjlMY8wmmi0lhfhFy3yUcg7ic6U2L/MY4kfe2ZpSUbbxAz5BCzvIdAr8tbAdB2IfNaoWOiD06V0Rl0H+J3FcYPji8LY5HcccWBvclPIWf08H97m0pp9d3YBcypar9hHeYBZC45/1njvvW7jX/DOjivLC4gp4LcauXJSjkPLQX+/73ooq1zehi/QEzeb/tajPnI+kVw2sY4T+FDjAY89Hp+iX2KQxt8Ukz8ZMvvPsJ3Snr+O8hrRdZJIP5cjlff4wFdR/8AcU+V622L/vJ7HF207Qvvrt7gL/UGSa/4AFuGNm8NueWGzvGALi+1wXd0nk3iB3l3GfAf0C7IFPhajVcYW1YBOtJf5N/h9yEvqPv3Pa4ujPUL6jnI/n0CMSz08YzrOeElZetI4e5kkfU/owB7Q3zsrK4HuqF9T0sM/cZ1Q39gcTT+c5aFtbU9/1vaIJ7FuL2wxin40azlH9RnGB+isxn8RUfSfcL5HxDrDkAPmR+412t7UuVMGNtekBdXtH7bv9Ue7BH6/SKVjWNcWO+YbznFN7jG+LxzBhvIoSy/fTYguuDX8hx8L0/R9Xzn/au2kovO38XctzG6+k19zocxpuaQ431GYI+9DeR7V3pSIEy0edCnDcTbufkVnf1lALb4G3mAzT6RXHFjYXwA7Q7b8h8gzPasWTreg7+PZV/bfYXrH9JstWX9RuJctVqrhRj1nGAeBbIAf6HjGqC1wfnbEa67SFZu8BhXg/0VHTr/h+2o4E94yBUHOfD5M/aGgyg0tmmdC3ldFePicbpJ55Qf/gj1rDU/76xxXRtiPXxfEfPHg+0Z6IfBN/uQd0Nc04X8SbFwTHzTToxzrphv9hc9A2JtzD/LfkR9cs4tglEX+4N+E/wVD/zBGGllr0UZY2EYS9TvA79P8Bv0ub0e0G/D6rgv5dOxFZjrFN9HxDW1z3o9AGJ944zzKpjv4LxCFOonc2xxEfG/g62N82u8/wl28Ahx39RUotLHWMcFeZBcXj27GAP1nB3QweLDaxm8NfNbTg/sMh9xJIbqQU7SLbQ2v+oYYAw57sVfrwjfScxf5z/wPM6d4/oFjesdvo3LoLFSHWeRuWrce9GKcQ+LXmqDfYP4pIgWkOs4W/weecnFa/h3Yfyr5wTVCHkDOSjoXZU/ud62YHNHLN+7kBxH86t135pPIYwPiCVWGH9DH0XIrXsYm+E8DehlCTIOUMbQh0slC8Os17S42/ywnRcBrTfzWpVd8dfCxVJHoPsfVzGgh+sJoYHzmyt8/xdihcEsiHEdToFYcPCAF1+0r5xDnONQeMiNqzmVB3H35W4+u5IPWQtKHtBSx63Ioyber2Wp92HcQwxL8rMBiStv4+0v8/LofxIjK9/EyBfMQyNop4pZcV5J3S9wPdgfvVkambvjFmh7XFw/V7dAI+9ufIxxp8DbM+5rAt6umzGC48vjVB3ismYu+2IWcUvHV2/AA9Atte5bCvwUMYYLJjgWlWoMsrXEqs7VPHtrDdEC/5uM85ZNOok2xC+JP7q3QT06l/t9m1uIV7rFc+yuwIcWuAdmtZBXa5ZHOR+LHuRuaEfH6puDsTbwy4M8MvL0EueP63yK2lOI3SEWq/YWwdgYtNZe+yy/8lr2tKD9qHXlB21Z1qLp399yE4xrAwffgT/Pw2pPFFlT4Z3fNZ6zyY8e6T7zCRyN98+W5/fRxyU9i+TnQHslX++0x7gP+shygLWvLsdkDe9CaAE+1m2bc5yjBR/lyQIfVb+B/mZlxNlXcRz4cVwfl1lMo/foGq+nwlh2dtXepet1G2Izx6sD1cd1ijlStX7RHX3AOAbdx7hx5YI/O9T7k8D3FwXQXNQ5A+QZD2x+MRKdsVnC72PTjdF3l9CHfQL2x6vXGtxm7gbGkan4puPxqls4b75a2I4/moL/dx0fynkxdRXVc3zrbaaoLvwvuYr/5uW+A75jVtdz0Zc043EZilFC7ap3mXF+DGM99qCey8VvjlLIvgLt5uos8EfBzBuZtu+oHj/Sbd/SQZ9NoGHm+Ko/8w0VgsKJr1pouydxCLlhPhok6qpseAcyJ+vxzTxke/584o+2ED+oGPvHmlPEbB0fbZ4b94pWPErr8biGA+P/an60BQcZO8dFADaKzLmnNOZqaPFkGCs4t4Jzc5tRjetRW+LFcXFfAO7V8T+ijY/nHORuYVVw4kesbTOPeF3PfyN+z2d7Ja7hKfhP9F3FJ1unbNE4tlTgD+7VwnwI4poK131bqdvoCvpO82IELEaitnVy+wyMhYvdw7WF0YfHdLvaT6GR+P3i81RmjV+mtoPFBA2uWMe5a7TRYOfIPLY1too4sCEfwfifzd9CrvwGz5M2rbUTkHlEGvNdtUPm1EHnyHwQjuW6H2yOeA2xD13nQJ2g8Va3ip+UbmvOofUbpZvQAWMx8LhVq8/171f8ZDSz31K6/83FFfsqrgmu51NxzryFp1vQucXkUjTr+hhLU/s38UbNuhHEv0Jr/tHv1/OKyoN5xZt6ohuwnG3Q7GvFHMYDG2SvU5prNusJQM9binspPfBngf82qfav4f4l3LfgEvuhjsC2NTaqKOv5skGK82W477hbbHC8YG586w9wb3TSS/fxFsY9+JSl5+yrvagDiBshBgE9BN3jyN7UntWbBzEX4nqgNlpXtkG/+71ZOxXUGrcKcRDxK2Q9DOrk7ToktgNZ7FOV2HCyp7dV9z3GHChne91qeuk6f4PPa9ao7B8845N9vRRHPUfX+J1ZtfbV7nPjp5rYvF4vK67ayaFtwgO7e1qBX4UxCbkNzgW1aIpx3yjuvW7ifKEFG+PY4fcRB/Fpz27hdwYQ83xADCHDeOSwPzaH++ysSws/xppsfyStW9uwB/yJK/v+oL/ExpJ6dM/xFYyu35D9sqDY0E+MK5Wb56CPuSVDHHpJOLIGZSGuuF4rpXTgXslWn75tj/Af9yzf0FTtY5aWHr8C/w59dSbAywJ0i8REcbjizOwaJ9mnDLGMG6ifMeT44PNwnBmLvFpXX44d+JtHWef1/juM+c4tnm/JvtXQ+cTYyNdUsNVtusicu0v2/j+Q95zovUX2Wj3Sh3kIvo2ceUTWUyCPtHjguwj8hzjfN6sYFOxLdlWnyWMOy/aes8B5W2xGn+7WPyzudL6ta8WlyU8W42IWBxBHbHAt0c/D7uC4yAc86O8bWdeGGKPFC3x3ol1urzOz3251rYfzQU7BYmroa2ucJ93TMeWqcdVq5wJlnG2uxlL7+db8ef0Oh0ieqfeHel110x4DaTD4A3zpLXI2tuk7IZRG/3MOfU+7A2Yj6r6Fbdv46Lm7/oI9007eHPdmNPuhQN+Ax2OwheUcchzwY7LD4TsdKkf9JeRuEBOcY4/kXxArg9/HPdf4bksIPrDeg2YppK2r/R0Qu8hO0z+lXuu6KFzV3tUejEHIWRq1l4oqOi7oUDDa41zpUh31aV7z4/pOFX9oOLc+GrRjimVr79xf6VZF0fa8AVmfrt9NaO9f/UF9d9bMeV7wfQAD5NHn8J2CBc6rkFjEPPuFZUOMztG5D7L/hMUL/4e2M+tOXGcW9g/KRRgTuJRHbLDBBDPdMSQGzJSQxMCv/yTZKsmmutv7Xd85a+3ztrt5LJVUqioNLol1ED/OvgHajffUv/0slXhOxIXKb374Wdjj334zp/HfkL1rtGLnN+/rD6oz9lt4teRaj1cb0vkOHQM/ftV3h9W2O6w0m2xOId47MeGcXYPOl1nONRqrRUkwMm/8u5Bsj2NN7frobl7pOKZ19/f8/HUnPf9KdUsLalXq+dN13b4pv0XyTPPq7WlfMzt5ZPWlfWG2xXnWYpn3MdWRRYXGnJOqzdcjqvP/9Ns0xi3124c1+yC0srNVRd4fLqv+xDOdWih8zn1N/fd8w+Z876F5G07+KP89nLRH452m+3vh2/4kf1bOyKKxtp/QMZHGbqZlwBrwfcP20ui8c7hbGJrmVa3f8I9tNAwXbP1o59M+W7Pzktn6yB9+J87f5cqwkmVtT/vZVH5nmdOqH8PZB3a2vtIe5b9BY98hjPeB+i6TnxO7v1P/ElDbxtbMWHwzt9l3YeF9NWnf/Un6HYlfGzeo/FWqe7Rsdm4jK5vOwYO7ZmZyp38e+VMal3y9TYf7ZZjy4+O+OTFdOOOwvJv1UZWtewq5Nx/MZ1G/Z6j9Re0Pn9fReYs8t1hevirVDRp7eVW+hjwlf5SJvjOZjayP2c76GO40dj7wI5Uz1YH0z6jeNt/HG/1/aPsajVl+Z3Qce3Xrd1WxtrIdZ8mQzn+yOHSgrKOxdms8tFv27dVD31p8nN+oj9nM6748e0vr2DeLdcy+0wpVXdxYdEzyfl7FWT8Kf1b1f73RZhBW2zGUyfx69u1Qvg/NhNuuqfuXse6r5yhLy+hP+FmPtI77TAaxdnrn3+dU52NaV9u8TmvOdVph36uk7TKta9os9i3PnFVFG02r6m9j/q0D+Mz/JnNtObG+2JoF//ZSfAc3mt/ZnspsklQzfafyahtv3N7S/3b0P8ez2omy3vCh6ubbiOumcp7jL305JoW+ZOvn4julDY2zhxc65gtjQvy921T1f8rOpZrB1auuqZ/+dumY+RZtxtb4gj1rp9l/rhNf+62PqW7sm9I2ONfH/h9/s7iJ7UkVdKCyrlls/fZ/5Wur2v7I9uloPKK+o/InHRT6Exq59zRorH+icTqNr0PVjjZpXJOwc0RsPu4f6Dxlut7QNmO20vLTMcr0LmbtPQ9PDf6N3tSt0Zh6AN997PgZILYn953Oe2j8P2nyb6fYeQx/Pw75349n7JyG+m+jEL5Ncm5sbsDPSozT70bV3LIsThqn87CJV9fonEX1c+VZaWd89n1Clcfnh3E8nG5oTD1m6/4jOl7k2nfV343YuGBrwWxvsVJVbL3vK+/z2TuV80U72gc0nl6n50aVfT4Rn9HfBwofqvsp4dF/oX7lbVWlMjFbwvvP/wpq7JwQnWfJfaqeHG9/fUd1xeahU7bWT8f8ga258bPqd3YWM63brML2OycT6//onedwra6hpHtxP+tJKsu0ZtWpP1XXd3bpnkOzmp2LTue15C/vqA9PK9qn/LsQvs5e3f/tfWt7c1uyedOBfQ/pV6m+p2eui2tQbL+TfefP55Le499n390qZdG5t8++59//ieFrE2z9Oha+vn175Pds/fa24nbxL79j72ZjnQgbMTeG/FtU9r0M3x/fD+sune9vzrM69Su7YZzbN3r8PktjdpPHDKFv5/fH2NzfUs/C6YuRd5tW1xOu+xV3MK6mtiE4xDXfak/H1HaNKm43qLaNkWmNwmorZt/2j458vZ3JMwjis0HneF4w9keU/RjtfbmGUGnrb7H/EVSuWkhtn2u1R9T/8T3sGd83Et8r/Om32TenCVKPqm8E4vsztv7RGfJvUrHfsTV0ai+/2e9pvH2kfgPWSdDfZ9/WrmqbXzo/pmPEOvLvYB/r2A8rfP+Zrcnzbyz+0CY8fmW+a8bWEbD3pH4wzYkdtql95+tUB7Z3tzpA7gHs3W90vv2TnpfQEvY9RTb3/kN90zXWP7wrty/5J1nSb4tXf5CDr5PZ1IZf2DfkmP6UqOcfYqKwzG/TGC3Ayx4e9lTvspjkD795ozpM5dyvDnv+vQjUsyq+vUjXz6c1f8PO1P+hnfj59j/8m76eDiuq7KNwHNKYFX4zrQ4rATuXsm+P0jV7ZH04y+s9N9ma5OZ3nq3RYmX+7X3MFiy5HRBc1RrTOWluzMt1/D/+hu+nyLHqD8dDLa97bnXdGf5CvvJxi9hBlvqtp69Zuqw0HameHAOW49bne7As18Vq77L9KRbbfPD9w4i401r1NJVzro8Fj5FYTvt0745onkha/9sg7MMR+voP0mmRHdGp4BeyiMiKWDOX6C0ySMivficL9vc9lieul1DGpM8V0o/IO3mjtSXGJ9FaZBvRf7dPxI6MH/bvP+w93Yjdtrlg7+okZM1+Z7NbVPUTS4F2JsaJ9APyyxKmdgP6vo3ZJVpM1oGjkcDRSUT/S+ifk8AmUWBqxDRIEjpEm5laYBoaCenv6F8HQfa/Hv13M2XZOyKTsQZ9j0/0mPQiKqtB5WKJ7PQG6SbkmTj0fyOW8Scmg4jM2O9+Et0hJhU+0LusjqOI/BDDoe9mWekcjf5H30nLEnWMPFbP7M9mVpe//Bd57H99Ykbki9CyexftLTIuxI3JkWVb0ldMRt2IyFaLVjb7zyCs/WLWpN8sOzFt11nabvT3PHWv5rALHHqsXVl7M1m1iHXZB+cIa6wKa+cZyy64TciQ1sFhfduJNJaNrsFkNYMLy+xGf9PQ7gntQ531qfZDfF4WNWArw0gM+u8BbeOwo7PUWkw3NIc2q9fRA/pe2mdaFJq0P3QjIU/EiJkuvRCb6legfRM7Zm3/xfuA15Pr4olYYYfKfDQibcl0aBicmL40af31mLatFjiGRt9J25j3A21Hk/dDErhEC2kfeKydQpLQQUlYv/NEsWP6e1PpF/2xTyrkLdD4nzXi0TJWtKwwuxu3dp+xqzFY+sHASkQW6Uud/r93lp7xoomLTrQry7/fYekHbTIXWYRrxorzLFMXH9v83hCvIfiQ53rk9+9+s/z8nDfJu+DNUZzxeuJEGe+YTcGv9FXGG78sf7/Bci6a/K5izs9G7I+s/lrSFfX3vRd2owb7s6knov5WP8l4n/wI/vt+yconSU/weqUlyg/g1mk9HvD6s6Rr5Cb4upFk5euRJ3iN5XhLy4+diig/HIj6G3pf8LFREfWPdoL3EuAdF7JAO3QEp7ynjwU/NBqifLKH9uOp9jnvuS1R/xbwvv4h+CfJRyfRf0bwLPig60D/D0T7dfUvwX/tWoIPvkQW8v4F+Ljnifrz12fyVwQ/56lC0/J/BN/lQqfl92LR/x/A23pL8B3TzHhCLVrGW3sN2s8LhPyTQLQ/MSzBVyqCN4KbaD+NXUyQ8ivvIuT3A9F+PUPcrkO2sSPqn1RE+d4a+MgX7UeND7SfMRI8nbND+1WF/B2Wk0/woaj/K/CWMYH+MwWvkarQH2NsQvv5MH5vQ9F+pgHj94tXOtW/mpC/fzWF/s98IT85D4Ns/A6MleAXcSjGb1CP4JYrW/AnX+ifxnICprxmbATPzuukvBY0BO+ugW/0RfsZlSHor3EXfK8i7I/GB02q/9UO59mfBxHYn2GSjV+LKz3n76Hkn0B/rY4oPwLeeB0K++dK3qBeTtgv4PWhI/gK8OT5jUD7AR9WBE+CJ6E/tuS9gdB/rQq8bTQFvwmhfMn7riP6PwGebN5E/7HUtBm/jIX91aInsB+uK+UX9tsYAO9JvmOeRP3Jk9A/e98F+zkQ+qNX30T/O8YrZKEPL7L9BG9We4JnrjXj528J8DD+m8Ab0bNof8PyBO8MwP62R6L9OkZb8DcaCWXlk2fRfgMX+Avw5DCS+g/81KyA/j6D/g59GD+Dhmg/G/iO8ST4VlyB/gNeu/al/gheG41E+/UlvzEbQv4E+N4eeHMgxp/RBt4yngU/iFtSftH+znwgywe+P0qgfOBTT8T7P0pvAWM/Pwfg/9Nb3ni65hD0l5eTjr89gfKBJ+Mh2A/gtWUo2s+X/I6Zumz8kCDje5IPiJnxJA4jKF8T/N5yZPmC19wRyM8isbT+wxDkpxGAqP/YE+1P/0Lw3yHoD5kJPh4L+bvUQ2f8YBzC+NOTjO9sxhD/kEQT428s5fcF749nUH9D8N3xRPAtzRPt9zYW9bdo1Jjx1yrEb4kleGM4A/m1SNR/O5H9txC8Ngb7wWZPWf3dObS/BvWvT2T9N4KPLGk/3CjjB/sFjH8dytcnov4e+Rb8UxXit8ATfH+/gvY3hPykO42g/Krge+MWxH8+yD+OYPwYseCfZkJ+gzQFvzgQ6L++0B93DnwMvP4BvCf5H5uA/QLe4047jV+Mk2i/yQz8N51tZPwr8FrQF/Jr643gL8CTeBaA/gLfP8j4qZ/A+AXeMy5Cf95nIn6yyavgDxMT/Cfw3SbwMfDkMIP4SfLHmgPzB+B7LIdspr/AG72ZHL8twddqEH/Rma/o/+ZW9r/QPzKZJdD/wE8mMH4T4Dvtnez/iui/X+AN0hZ8o+ZB+w9E/w04n8aPwJPxXPSfI/luLYD4D3hzGAv+BLy2ngv96Un+yAZV1n7A+/MY4idZ/mQO/kvy41oI428Qgf7upfwN0f5vwOvkSfDGYQbjB3id5egV8yfBk+sc/I/kpzbEfxHwdhP4FfDaM/CO5GPgafsJ3r8Cf5Llj+cJtB/wIxvsn5S/830E+yfld+bS/gNvTSKpPxH03wnsl9EC+78Q/aeRZ8F/A0/bT+i/bwE/A544C4gfJD+owfyZAN+Zn0X8G8vy2ynPrhvQwP+9ZjzTzCHYj/an4E+msF/aYRFlvKMNBH86nDJeTyagf3vgK7bw38RYiPjb1fZS/y8ZT6IF9H/7C+ynLcavPltA+2tg/5OJ4LX0/i0+/jOelw/97y9h/q79yvITGL9LaD8+6Un7v0PA/izB/mtXwXsTiN+ilZDfaX5D/3dE/ECOS7Bf2k3wvzWI34IVtP/wF+L/Dvjvl6WQf8Dvck7779AC/V0L+2XzmxKz+oei/psVzD/4Xc/p+J+C/U7veub+Z3+F8dsB//e2gvmbBv5jfnTA/76L9nOqN4j/OuD/uyspP4yf5zrEX0kkyjeqd6i/A/GjuQL5dYj/GnVpvyMYf+MK2A9HtJ9hrIX8Pr/rKp1/H8H+BRvBO+zLg2z+4KwET9Zi/LGLFjJen86g/C3Ev8Ma2F8H/P98DfG73hV8tQN8sBXtp81h/S1xRPtpwzX4Lx3iv1Yd5q/BTtQ/ves2HT8O6H/lXcrfF/z6CPYnikX9dQvW3y4uxN/8rtFU//UhjP9jLNYPgj3Ez9cX0H9XxL/a9R30R59A/HmE+C/ag/5/v4L+A09u72C/JT+vX8B/7CH+aAMfuBA/fQHf1SF+nRzl+D8K+XsWrP9VXOE/jfcP0X6O/i74cFoB+30E/ffbkgf7m3yI9rP0SPD1OtiP5EvGb7B+d+oKXht9iPipz+9gS+c/dbn+d4H48VvyvUC0X+cD5s86xF9vU2k/foX8bvUZxm9PlG8sPhIoH/yP3SDQ/wnoD79mmNvfyIPx24nk/Lsj+KYD8W9yFe1HPjXBp/e/8/pfImg/A8bfsgH2K7pB/71poL/AG+1I+D/dcMF/nsD+RDcY/+ymlSz+9IT+6M9RBPXvCZ44nvBfwR3kPxiy/jB+l5Fo//T+7rT/GjJ+vEP/1QwY/x7Eb/0NgfUrGL/+TK7f3UX9rXcT/L/XgPn3BuYfkk+AJ9Ed2n9hgf30IP64bkT79wzw/2+NEPQH+O6PJdsP9OcFeM0IBO80IH4kFYg/dbn+54P91jay/WH+2puB/YuqMP76cv3Oh/nPegvxM3UFGf/egPiNNGD+/gbrX2ZfjB9tvoX414D4pXGC+W/QhPj3Cda/or7wH3p9K9dvThA/O7D+RV5E/9tdWP9a9UH/vrcwfze+wH82JP8K/v8N1q9IH+xHc0eAh/inekpA/lfRfv2bsn4m1k80fxfA+ifEP5+NirL+KvitL3kRf2juTvZfHeb/J4h/SBvi37e+XD8T41er7eT6E8yf+UqDWL8F/bcDWP8l7H761P/EYvywqWKUzV9dIuJHaoGczH7wlVRuP2fAGy8xgfkr8H1X7h8Ab73D+hPb3BbrR3EA879A8AnwOv2XjPf7Q1i/Bd44A2+QoeA7cwfGvxlkvHl7g/0DzRTyR7HwHwPJx3MZv5lRxrs14APNEeUvgO+QN8E7c7H/QP9F8LY+gvmv5gn5d7GcP40Ef28KngSWkH9QA/7EdmLT8Vvfy/WnseBn5wDstyXkdz5DuX4VivJf9qL/umQi+GcX5s+RJepPtmNYf9FWovzpPgD5p4KfnEMhf2KJ/u/qYyl/JNrvE/g+mQm+e54Bbwv57fcJrL9osaj/fh8p+68Z/32G+XNiC/m9yQT8L/BGxrP5l+QNdyXKJ8Bb/akovwG8dtonoD/Af5xXsH5kg/68AW9qJ1H/T+B1spD6D3wCvL+dSv0TvHEF3pK8fo5A/4HX+zPZ/oInrYNcfwF+3Yxg/QX4Xncm9Q/Kjw/CfvQkb87F/JldiyjGXx/WP00N7E/zINdPPgT/NY8hfuwI/elvlfVTwZOfg1w/Ab4/P8H6B/DWJ6yfJrL8V+AHkj+6J5j/OUL/ejXgLzrYn+FBrp9Ggm+dZfzuCPm1/lLu3wv7QyoHMf/3aCiS8WOX+y8W70RdUb4zSfmEDSUxfvR6yveZqp5Af5vcfxm0/Abwnc90/Ze6lgB443gkGW9GwI+alYw3YuDtn7XgTR3GX+fI+89j7X8G/Z0LXpt1YfxJfgY8eT1GWfl2BPzcbQg+Ab5jvwv+XZa/AN6R5X8CrzvA+33gY+CNGvCuLF9zW4KPgNcWH4L/lPXfHkX792T5oybwDeCtGvCJrL8NvCfLj8+CNwLge5Kvyfp7wPdl+S9z4E/A63ok+Jas/8tJ9P9Alj/8JEJ/SFeMf6sLvK6D/WoAr5FPwdclPwOefG4EfwGePJ8CUf8A+MmnKfigK8avowNf1y+i/CXwWnQR/O+L4LW4B/HDYSP7PxHl906i/3sJ8O7CAfl7YL/srZS/Av4HeI18C/7pE/iZ5A87wTsqL/pPj4A3PgPBJ8Dbi1jwfeAN/SzHL/DNruC1AHj9fS/4CfCafxbtZ8v6bxeh4E/A996AX8nyJ8B3ZPna50zov2w/fXsQ/FaW75xh/Mny37vAy/ZzfoA/yfarAN+V5b8sgJftRz6Pgv8BnlTOMP5k+YfFCsZvD/yvfZTjtwH2Q/LRj+DZkUoxfoE39RP3nwkbv4LXtU8C4xf44wvwJ1n+AfgW8GT8GcD4Bd59iaX+ivFjf54Fr+vC/+m/nzz+YvNt8iv4tuRnwOv6p9Rf8L+Xzyiz/0YEfPjJ/Z/FHgPQ30/Oa/TPI1P4P72b8iHhhyzF+O0KXncCGb+lPO3aPfDGJOUnbH8M+Fco3wiBJ4cvwWumiN/J/DPJeH2og//5vGQ8uQQy/gH+DXjjCXhLA/5tkQj5JW+9XAT/Drx2/yIZ393ocvwJ3pgB70peN2H+UAVe3xiCv8rynUD0n6+WL3gj41n7D4E3X7j/tph9B97sf4v+S4DXdl9BxvevwG8/BU9mQ4ifbOCHZgDxU8ov2Pq3CfOPLudt+ngAnhx+OH9i56tg/nP7ijK+I/lg0RB8DXi3BnwEvPECvNME3n5pZby+AL5j/wr+BPXXx19JxvfOwP8sBM8mpSJ+4IcuOX+V9f+6kIz3rsAP+Ukgzr8Bb3eBr8nyLeB9Wf+vJfAx8N478C9S/gnwA9l+TcnL9tMOV8FrZijrL/qPXC3BT1/NjCeLIcRvXeBd4PUz8OYG+PqX4DXJD2zg57J85wL97wLv9RzBt4bSf98EvwFeewG+ewZ+txS8XgHek3wSC954A96TvN7zRPvJ+uv9u+AbwGtfF6E/gyHwseSfgO/awGvxTLTfDXjStGH+vAxE+78Pwf58VgTflfz0W/S/sQH+R/JPwPt94Iem4I028PYQ+H4vFO1/Ad6pVQW/Bl4/fYv+d+bAN5aC1/tDOX+tCX4P9Setb+g/yUevM8H/DKX9Bv4beGMBfE+2Xwt4wwSezrUEf4P6k/dv0f6+C/xwuRL8CvhOF/gX2X4e8ETrQPzwGon2fxvC/HXRgP4zxfqL/vYD/TcH/hd4TQee6E3BhzGs33z/iPa3msBPv2LZf4J3n4D/AF5vA+9sgG+/Cl6fAW/UXgR/Bl47/0D7u8CfeyfRfrL+2uer4Cuy/tcf0X592X7T3kXwB+A7E+Dbsv5d4InrQPsBT5w3OX8AvmPC/DkBXj8D73wlgk+A159agveB126/0H9NR+qv4DUb+F4f+FCWbwBvzYGvLoF/B568tQW/BJ4MfwPwn8D3lsL/6jrwVhf4Ywz1/wW+u5H1/wL+Bnx30pb2E+p/AN6X9be/GuC/ZPv9PAn+Vbbf5Jfrz5bZry6sX6W8w9Z/3iKw35zX6ePVhPmn/5tkfP8KfGfZyngSvkH8+/Is+IEp5p/kCXh72IP1G+B1AnynD3wTeH0EPPtQS9jfLyi/MhLy923gpybMX7WE9/+BnR8B3uQn0RsuLT8GXj9ye6VT0/Yj+RfgvSvwbxfBGxHwdifl2fgBXmunPAvNr77gLynPFgziEay/7IAfmDB/vANvDYG3Wnz9f8AmFRPRf8aSf7/APi15sUT/aeOEzV/YzH4whPXH1YXzjIonsH7wzPc/Lbb+1BHtb9iM72zeqXybV7C/K+7/p2z96R3s104X/Dvw2j2JMt7RgP/0BK87wPuSj4En3STJeFeWP1p5go+A77wagv8EXv8GvifLb3rAN4DXlqbgE1l/50oy3pPlf1yCjDcC4HsfwNdk+30D35flO61Q8CfgrZ0l+JYs/3wV7W9uWjD/v4TQ/h8Qv/cs2X4JyA+8pwH/uxI8mX1A/FYHPujA/H9+jaD92zD/W81E/QnwPcMWvN2B+f8r4/kpInPzBOs3K75+P2XD8wPil16Hf0XB9Bd4Ur+K/tO0Z+h/byXkJx8wf+c8L3/VgfVryXclv7sI3nCAd1+BdxzYf/sB3twSmD+2RP31KAL/d4T62w7MvznP5be3MP8mrUjwjQjWT3eO4HUH5t/fN3EKy9Bh/htcIuj/SMrviPrfHJj/8lMVHcb7W5h/nlacZ0cjTxuY/zxznh2N7Dsw/0nS8pnB0mH/sdPi53eWbHzEgjenLrfCtP6mC/uHn7cg460t7B/ugdfpVFPozy/wWxfWD96B93XYP9S9U8YbUQz276Mr+K4r59+3KOONLewfbleC16IYxu8z8J/AGxfgNT2E8csNOOdne5D/uSf4kyvaT2vdkozvbYH/WQneaBzAf70CP3PB/y7uov0NfSX9TyLKD47gf5ae4A8ujP9+yrfY+QjYv/ltcf6Dtd8R9o9GfP++Q/Wn2xX6T8w7tx8ttj4H+zeex+OXD7YodpLys/37foeVD7zeuQdZ+eYW9m8urZRn8ccJ/N8X3/9n/GcX9n/8e5SV35W812pk9SfBCfaPf/ui/PeuA/O3lH9i3z9uQf5LI6u/MQN+0OmL8mvAkylzwJ0te9R3MP48Hn9EbP3oBOPvyL9/obaDhF3QHxd4fwt8ewV8cgb7x78k4vypK+Y/2oZNKlNeP8D6p8/jB/6F/Bn09w58tyvid2OV8nx99Qjr722SlW84wJP7UPAV4EnMPvXL6g/8oG0KPgLefAb+BXhtDvxAlh+tgW8A3/0CnnTl/h3wZAv7b1fgSfAJ9vcDeBt44wy8rgNv+Y7gT8DryzfBe8BrLvvUjvOGLH+2Fjzb1BH9/wz8m6y/Brwly99JfgZ87wv4maz/HHhblt9sA58Ar/HvQzn/DjxZVYT+ObL8YdvLeN2R9R8BH8v6L4F3Zfnfa+Aj2f4d4D9l/dfA92T5L5JvAE+MUPCJrP+hKvTfk+WH34HQH9n/9gfwNdl/beD7svxY8rL/u0fgW1L+JvADWX4FeCqrsF/9Z+D1bizrL/RP02H/MGiHgp8Bb/+OBe905f5xyvP9IeDPa8FrAfDeIOWZ0wDeiKD8geSd9kzWH/ZfjhNZf9i/tKoR1B/2Hy/+TNYf1r96E1l/8F96VfS/vgXe/14JPgHe2k0F3wdea1Sl/QX+01+B/QW+9zuV9leevwDekuXb60jwEfDG10zwC1l+XBP935Hl3zKeHcoAnnTmov23Uv5rLQD9l/u361jY7+AT4s/7XNovmD9Ua9J+fUH8+30S/Al4Z7oQ5YeSd2tRpj/W9kvaf8FT+WH+xj9V4OVvgdcGNRj/svxF+yLG7wz4nrGU/gvKPwHfleV3/UTwCfDW10rwP7L85zqMf1n+F/CGI8vfraT/gvKNuhz/wFfWiRz/EP88r+T4h/lnrQ7+R4f972m7Av7nC+zP61r2H8Rfk7rsv4vUX+BPwPcHa+l/YP3Bqkeg/xfZ/g0Y/8A7y3fBX2T5v8D3tsD/tHn8tGGHYr7k/IXxNPRnhwpg/aHOeGPL80fA/m/vu5XxGvkC+/H7Ifik24D5fz3JeFOH/c/Yb8nyof+WwAc9OD/0BrynJ7B/zpM+pOVfYP+gF0H5PZh/dBu8/x1W/g3mHzyTSGPL5i8XGL/peE//LP7P8Bk/J/n/Gz6x7xmD/F9aU1afA0lMcojfWos0f1HaXmn+kKl4fmG8HhTyp6TxFpdMvjUd7wU+lTf9fsomufwrvP4y/0q2380rodSV91eRT8+L8fOrWpzL3+ISM5e/JS0/EMtr2f/x3/fzfE7+fP6XTH7I/6LIH+Hyzx/l1wI7yuWP4fLL/DGK/ANiPMqv8Ir8gdbI5Z/h8iv5Z1T5NUR+ySvy98g2l7+Gy6/kr1HkT6QSSvkVXpE/cZNc/hsuv8x/o8jvY/2v8Kr8epTLn5PJf3qUn1Y1QeTXo0f5O+Qrl3+Hy6/k31HkP2H9r/BSfmYqcvl74nz+HkV+L80blpdf4RX5K3ojl/+Hy6/k/1H6P8L0X/KK/OxTGTV/EJdfyR+kyG+mf87Lr/BK/xOP5PIPcfll/qGc/mtI/0tekd8znFz+Ii6/kr8oN/6DR/klr8jfJfdc/qNU/2X+I0X+lhU/yq/wiv0LdkEuf1Kcz5+kyN9F7Z/kVfmdRi7/Uiq/zL+U039Mfgfpf1sf5PI3pfov8zflxj+i/wqv6H8Uk1z+p7iQ/0mV30L0X/KK/Ikb5vJHcfmV/FFSfoNg+q/wUn5Hn+TyT6X9L/NPKfJfpAeQ8iu8In9yTHL5q+J8/qp/9b/Cq+O/kP8qHf8y/5Uif4D1f6VQfqr/+iaXPyvT/1NQ0v4pvDr+T1Eu/1acz7+lyG+n/1Mc/yfE/9H4PZe/i8uv5O9S5Ef9v+QV+V39ksv/lcov838p8rMMJg/yK7w6/i9JLn9YXMgf9s/xf0H63+sFufxj2fivlPX/Cq/2fyOXvyzr/x9Suv8bWP//BLn8Z3E+/5kiv47GP5JX479eksuflsZ/Mn+alF9H/Z/kFfmJ3s7lX0v9n8y/psjvYP2v8Kr9u5Jc/rY4n79Nkb+Pjn/JK/ITL8zlf3NJPv+bOv41ZPxLXo1/jW4uf1wW/96ikv2v8Gr8d0ty+efifP45RX4Ts/8Kr8h/8Ukufx2XX8lfp/g/gtk/yavxrzHM5b/L4t8K0v8VTH6FV8Y/qUS5/HlxIX+eqv9I/KPwqv3zvVz+vdT+yfx7/7R/vofYP76+KfP3Zfavioz/Fia/wqvyV4Nc/r84n//vX/G/wivyh2x9T8kfyOVX8gf+S37JK/KbxjSXfzCNf2T+wZz9R+JfhVftX43k8hfG+fyFivwEj39ryPgP/DiX/zCd/xjI/JdEmP5LXo3/jEUuf2IW/9WikvIrvCJ/VEty+Re5/Er+RSm/i8oveUX+lp/k8jdy+ZX8jTn7j8iv8Kr+v+fyP2b6X49Kzn8UXtH/qJ7k8kfG6fhD4r8OOv4VXspv9s1c/kkuv5J/UvH/qP2TvCK/ZWxz+SvT/pf5KxX5Y2z8K7yU34gK+S+5/DL/Zc7/BY/yK7wa/w68XP7MNP417mX9v+TV+b9RyeXfzOb/bYLJ7yHzf6OC+H/ylM/fGefzdyryW6j/l7xq/wr5PzP710DHP2b/Btj6RyF/aCb/E8H0H1v/MBqY/S/kH03tPya/htt/TP64kL+Uy++Wlz/G5O8V8p9m/h+T38H9PyK/ERTyp8ap/kWY/0fkV3jV/hXyr2b2r7T8LUx+TeZf5flb0/hX5l/9l/wKr85/C/lf0/nvAIn/DXz++4TF/4X8sWn8Xyz/z/LPBjFm//P5ZzP7j8nv4fEPIr9BCvlr40L+WjX+xfqfYPITyF+b5r/N4v+Xsut/Cq/6/3z+3Mz/P0Ul+98ulp+N33z+3Wz8n0rKr/Dq+k8hf2+6/oPKj6//YPITmb+X5//N5n9PSPwXYPIrvBr/FfIHp/Hf4FLS/mnF8n/S9svnH+byO8Xyg8JSnZQ/Glww+5fPXyzsHyJ/iNu/V8z/Qf7iNP9x5v+Q9W8H93/PBJM/nz85k79VVv+jARL/9Qv5l9P5b/RMSvZ/v1h+On+H/Mtp/uZ0/j+olPX/klfkXxXyP3P5lfzPSv8HmPyrQvnp+mchf3S2/vlc1v45Rhvb/yvkn073/zD58fGfYPK3CvmrM/+HyK8FuP+rYPHvUy7/dRb/Pkcl4x+FV+c/hfzZ6fxn0Cg7/qPnCOv/fP7trP+fyvd/A/N/+fzdmf/D5A9w//eExT+F/N9Z/FNWfiPA5G8U8odz+fvl5W9g8g8K+cfT8Z+U7v8BJj8JIP94mr883f8btErKr/C5+D+f/zyL/5/L2v9w0MLGfz5/uhj/Senx/4z2fz7/etb/rfL9n2D9n8/fnvX/c9n4r4HJr8v863wnKfX/Mv/7v/pf4dX9/0L++HT/H/K//3P8B4Xy0/i3kH8+O/9QKP8v8W+h/LT/C/nrs/4vLb+Dya9Hhfz36foHJj8a/+sRJn+lkD8/2/9G5Mfjvwomvybz5/P8+9n8B/Ln/0v/FV6N/wr5+9P4T+bv/8f8T+Fz/Z/P/5/1v1a+/02s//P3B4j+R+QPsfUvB5PfCEiUu38gHf9w/0BO/zVs/AOvjn/i5e4vSMe/vL9AWf/Fxz/wivweMXP3H6T2X95/kFv/RuRXeDX+0aLc/Qlp/AP3J/zr/IPCq+v/JMrdv5Cu/8v7F3L73xGy/g+8Ov8jvdz9Ddn8D+5v+Nf6p8Kr+z8Gyd3/kO7/wP0Puf1fbP1X8rnxX8ndH5GNf/9Rfh09/yD5nP4PcvdPZPpvIPKvsPNPCq/of2Lm76/g8sv7K/4lv8Kr/l8Lc/dfpP5f3n+RW/9E+l/yavxDprn7M7L4x0LkR8//Kbw6/m2Su38jHf9apJVb/1f43Pm/U+7+jsz+LcqOf8mr+z9kmbv/I9v/sRH58f0fyav2v0Ny94ek9l9LMPmx/U/J585/mbn7RzL93yD2H93/l7y6/kEOuftLsvUPN8Lkd5D1D8mr8/8uyd1/ks7/daT/PfT8j+TV9R+9krs/JV3/kfenqPM/TH7J5/z/LXf/Sub/PUT+E9b/Cq/afy/J3d+S2n/Dw/y/jtl/Dxn/FSPM3f+S9X8VkR/d/1J49fxfPXd/THb+z0fHP3r+r470fwD3v6T3z6TzH3n/zD/iH4XPnf/L31+Tnf9rYvqPjX+vUH7m//L332T+r182/rOL5afndwr356TnfzD58fgXlT8p3L+T6X+zbPyXYPL3C/f3ZOtfmPz4+hcmP4ng/p70/p84f//PP/tf8ur+d+H+oOz87wsiPzr/DwzE/luF+4ey9Z9+VFJ+q1h+On4L9xfFhfuL/tX/CSZ/o3D/URb/vpTt/wYmP5H3F/H7kzL7309K6r/Cq/s/hfuX4vz9S//e/+kj9m9WuL8p8/+vZft/Vig/O/+dv/8p2//E5Hfw89+v6PjP3x8VF+6P+of+K7x6/qlw/1R6/gmVH+3/Cya/X7i/Kjv/VVp+H5PfSAr3X6Xxb2n5jT/0f5K7Pyvr/1bp+a+RYPF//v6tLP4fkJL67xTLT8dv4f6ubPwnZfs/GWDxX+H+r8z/l5a/gsk/KNwflsX/mPwOHv+3MP8P93el949l/r9S2v8PUP+fv78s8//tsvJ7RgWz//n7zzL7PwhKym8Vy0/nr4X70+LC/Wn/Wv9LMPmjwv1r6f4XKj9q/yJMfrdwf1u2/o/Jj67/uZj8elS4/y3O3//2z/MfESb/pXB/XGb/Sst/weT3C/fPZfavtPw+Jr8RFe6vS88/lZbfQOVvFe6/S/e/ysvfwuQn8v43fn9e5v8HUUn5FT43/vP372Xjv6GV3f8YIPGPU7i/j8uvF8v/s/xOofxs/pO//y+b/5SW38Dk10jh/sDs+6ey8msEkz8s3D+Yrf+Ulj/E5LcL9xdm85/S8tuo/Enh/sPM/jXK278Is3/5+xMz+/dU3v41MPuXv39R2L+otP17Qu1f/v7GzP41ytu/CLN/+fsfM/v3VN7+NbD17/z9kdn6d2n5PUx+IyjcP5mu/5WW30DHf6Nwf2U2/yktfwOTf1C4/1LEP2XlH6D2T95fmd6fma5/yfsv/2X/JK+e/y3cv5me/5X3Z/4r/jEL5Wf2L39/p7B/SPzfjVD7Bzy//0KN53jQxO+/iPJ/md5/4RR+yu+/KPLp/RcFPr3/osjz+y+KfHr/RbF8fv9Fkef3XxR5D+PT+y+KPL//4qH+/P6LYvkLjP/E+PT+i6L8NYzn918U+fT+i2L9+f0Xj+2H8On9F8X62xjP778o8j2MT++/KPL8/osin95/Uaw/v/+iyPP7Lx7q30X49P6LIl/H+PT+i2L5/P6LIs/vv3jQfx3h0/svijy//+Kh/w9Y+fz+iyLP7794lP/zkdc+PxF+y/LvP/TfDeENC+OrGN9/QXjifiL9by8Q+2EvvpD2u2H88yfCm4cLIv/7F9L/qxfE/jgYr6P89wLhvQnCGyhfWSD2Z3D7xtrvC2l/7xOxH6b9g9R/jfFPGK/9/CLtd/1C2n+/wMb/AeFJcEHk774i48/k+e+L5W8xfrNEeH4p8kP7dzCeX6rwoL8ThCfzS4DVHxm/1tMVqf8N4z+X2Ph/QXjjivF6Dxn/Bk+1WSxfuyD9//6F8E4N4Q2Ur2A82d6R9ttdEP1ZvHqPvKsjvL7B+MsXwuuHCiL/4hvp//1rgOkvwhsjjH9eIryxrSL197+x/mf59x/0z65i7feNtP+gN0P6j+ffL8rP828XeZ5/+8F+8fzbxfJ5/u0iz/NvP7Q/z79d5J8wnn9e/WB/OgTh2fU9D3z/gtmPL4TXNhj/gZXf6yG8McP4Vgur/weLjQ/si9RGIf+1W8h/vWsh499baoj8WoL0X99Dxl+HXTD+oH8njK9hPPkykPbzE6T/Pi7I+OvWEd6IMd66IOPH3JlI+dyoPvjfFsL36yY2fq5Y/OYh488+Wkj5LxgfX0JMfoTX2xh/XyG8drSR8vdXpP8uHjL+B7+MP7B8Xm8yf7XP8j+7LP9yR3uS+YPZ/H82ZfnxPmT+4g5SvndF+m/G+aL+Ybzex/gjxndfET7N/+xi+Z/1GZb/+ZDP/5zmzy2Wz/PnPvb/ACnfxXieP/fB/vEvGR7sTwXRX54/98H+3BE+zZ/7EL+1sfkLz59b1H+eP/fBf7QR+5Pmzy3Wf47xPH/uQ/99DbH5P8ZfMT7Nn1uU/4zxPH/uQ/vz/LnF+vP8uQ/6u0b4NH9usf4axu8wPs2fW6z/HON5/tyH8c/zOxT7j+fPfZj/thH7m+bPfZh/YjzPn/vQ/h2ET/PnPszfMT7Nn1usP8+fW+R5/tyH+n8gfJo/98H+YnyaP7cofxPjKxif5s99rD+ifzx/7kP9ef7cYvmvLL+Am+aPhPyXtTWLv2Zp/kq4P+uDrf8c0vyVcP/BD8sP4Kb5K+H+wLd2K+MNmf+yM/gQfNCF+wMD4D2Z//L7uwXlXyD/Zg/4BPJfEpudBc3Kv8L9AXy9P9DyXfW75fkr8/KP2ff9xfyVJ5Yl1p4ZJNDnw971U65fiv1/sX5pDGH900bXP/9w/qOFnf8AXrfh/Ce6/ol//14sP/1+FXijfRbrv1Hp9V8dXf+NgddqC7H/5WLyawF2/jfG5O9rcH7/dxLD+a8gwM5/ho/yK7y6/zkU6+d9KX/DnGnl8h8qvHr+3YTzax8Lsf/T1Vzs/C+W/0jhlfMfGpzfnh9OcP5jhJ5/OiHnP7QBdv5jItqv637C+Q8LPf/Ywc5/TJD934otvl8x5iC/z896Ppz/R8//2sj3L662B74G3/8Gc6T/Y+z8u8or5/8WsP/5/SVQx0bOv3XQ/JeSV/XfFudXtN8F5H/QLqj+I/0v+Zz+w/nhgy2//10G2Pl/gun/N/b91xLOP1ogf2gj+1/o988Kn+t/2P+S8vvaD3r+F+1/bP9b+4X970kC+z/Lsue/FD4nfwL9f5Hyt8p+/xEssfPPHfj+674kIH9SWv4OweS/Cv5Wk/Kvyva/wqv7v8Ab1jfs/3ZMTH50/3eFjH/SEd9P6f0l5H/QbmXll7y6/y95t9aA/f9VVFJ+W7th+7/A99o/sP/bcUrKr/Dq+a8OnJ8Pl3D+S7uj3z8h8iu8sv8r+fdDC/Z/V4j+o/nfBsXy0/wda3n+71fIn3SCst+/ST6n//D9D08qn+l/Fd3/xc7/d7Dvf7QanH+bEpB/HZX8/k/h1fMv76L+1vgK5186yPcff8h/9o7IH3SE/zTcFeR/1pDz7wZ+/ruD+H9Ng/PT5tGB7z/eo5Lf/yi8ev7pXeiPPb/B+acOcv7VxORXePX8T0f4L91fwfkfrYXGv9j3X50EG/9wfuEG8mvRB9r/Djb+sfMvSQTf/7RB/otDSp9/jTD9l3x7Bf5PL/39c8VB7P9A8puOPP8akZLfPw10gp1/jiD+9e9C/pbjlPT/Cq/mf3CE/dKstRj/Hd0o+/2P5NXzjzp8v5rU5fnHDcG+f0D0X+FV/d+I+ptuFfTfmZW0fwqvnv9zVkL/rTWc/9M7yPhHv/+RvDr+dfh+NunA+cdgS0p+/6jwav9Lfl+T/R9h3/+i/b9F9L/hCPulmWvIf6Ej8x+C5v+TvBr/6l2If6cziH+3kVku/6fCq/5/K+yXPwT5K86lrPySV79/cuT59zV8/6d7qP1D5Fd4Vf/h++FwKu9/2CHxH37/g+5j8e9OtN/Ah/svQqehlct/o/Dq/Efy/NKHdP6j98vmP4idBiY/8H4nkvKX9f9+sXyRv12c/5vD/ReOS7DvXwk2/4sR/b9IfvMuxn9PD5Dvn1H5Ly4W/+tD+P6vE0P8H6Pn/5H5r8Kr/b+X83+4/yJ0Q63c/ScKr8b/LtjP1bsY/0SflF3/UnjV/gG/msL3v8G+7PlHrVh+2n/Ae/MX2f+I/VezSiv9D7xpb5H10/0JPb/iYOd/diiPnT/8xNafFzGy/q2fkfXjZhfh9fc9tn96RtaPtwtk/bj3hvDGBOO1T2T/T98ekPKdM3b+o4udH/hBeL2C8S+LGXZ+7oisn1fO2P4Zdn5K639j57+w8w+1L2z/Ezv/QMg3dn7hC9l/NCd17PwOxt97CE/6Dez8xQ+2f/EVIf3/1MDq/4P0f28ZI+ePXppI+31g/C/GD94RnrR/kPZfLJHzf923F0T+MXb+Y3GB/dsZ3L/rfsD+7Qn2b/XXW5Dt/zpbuH93g+2/dKfI/othYPs3DR/h9cEE2z+sIvJv1oj+9QyEN94wnnwj+mMsp0j5syrSfu8+tn++m2L7TxjfxHjtOEP6/6WG6O/cj7DzN9j523ED4dH9I2O6Q/aPfhvJ4/7Rz4/31/0jT/qf5TusH2H+E48fPMx/9iTvHWX+TMx/XjD/2cP8pxbtYf1g/Sr858xdaUj+bGT9XOHV9RMX8qf8gvymvii7fij53P0hwL/UQf7ogMqPxI/dYvlp/HOE9aNzS8ZPCTZ/RtePj9j6gQvfj14/YP1MX6P5c7D1AxfLH6S/C75+lPkzj2X7X+Hz9wcJ+S24P8lzkfXzP94fhMkP34/wC1Tg/qCS+l9xkf1DS4f9p0tH5s88IfPnmZxBK9/P6hG2fvQF30+1Qf5Lt1Fy/qjwufuDoP7TD9g/1H/R+RO2f9jF9k912H8I65A/MroQs9z9KQqv7h9fRPzvtOH+qKiH5o8zsP3jCzJ/OPUC+H5ekb+C7p9i+cN6Aab/8P2/Vpf5I3+SkutHCq+un/9C/sQ93J+U9ND8Sdj+seTV9dMe6P/6A/Jn6cj+uY5/P9lD+x/42hH2D6LfpOz+of6M2b9E1D+9VDS1f17Z/IkKr34/KXl2fFvkTybY+hnW/5GHzJ87Bqy/bRoEzk9ck5LrJwqvrp8B338D+VvequT6iVEsP/X/Hqy/dSO4P89wSucP8JD8eZbkew7kDwluZfNnWoaD+X/g7Se4P2rmIeuHaP5ohVfXT4DXKyB/D5Mfvz/1gsmvG7D++DyD/DHRDV0/Q8a/wqv7pzdhv40XuD/p5J1Kyq/w6vfzwOtaFEH+6G5Z/9fyTpj+Q/7D3wbsnyS3pKT9V3h1/fwO/afD/Umml5TOn3EnmP4Df44g/jW8suvnnpdg/Q/rn5OGB/1/L5s/S+FV+we882RI+1fBzo+g9u+O5c8C3vBBfs/wy9r/xMPyhxiw/mmc4P6k4B6VHv99bPwDb0zk/Uleo6z9j+7Y+jHwGrsUWtyf0i9r/2IPWT/uKXxEYP5TWv4eJr9BgHd0kD/B5MfPDxBMfseD84MayK8bA/T8ELZ/5GHnByWvnSB/anJPSuYP6xjo+THgDduC+NcrfX6wWH6m/3B+sLeR92cMyubPSzD5B5L/bISwf3ove35ogMlPggrsH3+C/KZPSubPVXh1/dyH/dfdBtbPjTc0fyh2f6KPnJ/pGyPIH+HI/bNKgp2fQ/yfwqv5M6rCfnk23J+18sOS8iu8en7Wh/jpewP3pxtTdPwj92crvJo/HubvUWMF8X8twuw/cn+Wwqv6Xxf112pwf87FR/PnYPMfyav634fzY69bAvofoeMfkV/yufuTYsgf4cD+UdAkJfMnK7y6f9IU9bcOcH+O0w8x+4/pv+TV+U9frF8Z220A9wcc0PGP6L/kc/1/hPi3Ic/PNhNs/o/N/ySvnh9+Ee3Xe4f7cxr9qOT6h8Kr858+7H97W3l/zLls/KPwqv3/FPzsdAH7/xKVPD+g8Gr88wL5A2twf07Yv5Tsf4XPyQ/5854V+S9o/IvN//pI/EcMWD+ZO3B+krwmZrn7gxRelR/4zsGT8rdKx3+vmP8D3pjs5Pj/LXt+Jum3sPgXzn++SvmjVtnzowqv5o8E3qzB/THxwCy5/qvwuftjxPqN/rWT98dU0PzpiP5LPic/nD98cSogfzsoeX5M4VX/14b8OQe4P2U1WJWd/0o+d38YnB/Sd3B/vFEvu/6bDBD/ZxsNwVcdeX72iZSc/yq8av+eIH/iAu5PaQzikucnFD7X/zB/3cdwfsx4weY/Ftr/aP7Ygdh/C+cExr+ROOXiP4VX/R/wHRvuT3GI+H7p3/mDC+Wn+x/A6zOQ3yyW/+f5T1AoP8ufBvxvE9a/Ikx+1P7ZmPx6AvzgE+S/lJZf4XP3JwDfiGX+eEx+dPxXMPnTs6Zp/qemzB9skpLyK7y6/g28a8P9KdT7l5W/WH66/g28QUD+brH8P/f/qVB+lj8N+ArIb6Dy/yF/GiI/SUyx/90/gPyeZpbVf8nn7k8Afh3L/LnDsvLPCuVn+XOBH7kyf26h/L/lzx0+ym/I+tv6G6z/lpbfQOU3NUeM/yHIr5G3svov+dz9EcAf57D+R8yopPxmsfzUfwHvf4L8q0L5f1n/SQrlp+dHJb+JZf48RH58/auByd8hI8HPXMifm5hl7Z/Cq/4P+G4f7g9qaF5J+RU+1/+BGP8DkF+j1Srd/8Gj/F3JP8892P+2kPGfYPJ3i+Wn63eW0F/jHe4PmmmhXvL8qORz9k/w2nZPwP6Ny8p/KpSf5c8FfnuW58ctZPyj38/4xfLT9XtL6G/vE+Q/abOS8it8Tv8Fb7RA/j6ZPMqPn59tFMrP7o+bCl534fx4ZCUlx7/Cq+MfeO1d3p+krfSS3w8mFqL/LeC1xV7mD54i4x/f/yiUn43/meBPrlz/tEnp8T/Dxj/w/c+xHP+RXjZ/sk0w+YH/3MP+T7H8P/d/q1B+lj9zLvh5U+YPtoOS8a/Cq+Mf+O5kIsd/rJe9P9RGxv8KeL0G8neK5f/l/tBC+Zn/B/46l/dnYfL/4f5ARH49AL4v5Y9Ly6/w6vxP8t5e3h80Lxv/JJj8fcmHTfh+ICotfx+T35D6Y2+nMv4pK7+RYPITDfJPPYH8hCzK9r/kc/cnAb93V7D+aUcl5deK5afzN+C7nyC/Uyj/L/lzIxux/x7wBtnL+wNKy+9h8puSr4H8Giktv4nJr8n2G9ggf1hafi3A5J9Jvnsgyv1pJeWfYfJ3JO80I2n/y8rfweTXZfsZt5mc/5WVXyeY/LHU/zrI75aXP8bk70r+co4g/istv8IfFsj5W99Gzs8bNez8PFlg5291duzgwCK6mi7yf+naJ3L+9vgSYflngW8BT8afyPlp9wU5P25/ngWv67D+8st4N/JYS0D+meAFy9+Mnv/vfiHl219I/lfDfkXOT69+kPZbL7H81Z8Ir7cwvobxAx3hyfYXaf/eK5b/uttCyjcw/oLxXh/hjTHGaz2k/TW7jdT/+xdp//AL678nhNd1jD8vEb7TR/JH6iPs+4GfrxZ2fh7yL77I/Is3yL+oD5cQv7RE/js9iiD/0ZHtMPD8ebYj1h+MH8ifZ281sB+tSPCNSPhfbecIXndg/vyd5q9bsfPnuuDr8P2DEcRgP3Zd8f1DwwW+fouy7x/0rZx/t04ZTxqxiP+dI/B0fi7G3zPwXcm/esAHeyG/zhNgcn7iivmvNrglgtdh/vrhXTJebwDfOwL/5EbQfsDbOtg/myV1TctPjpC/jyV1TfnQTUT5hzvJeHe7gvyZKf/BjPBRyN975nyHt5+wP0Z8x/TfQ/TPMHzEfgzuXH9arPwIvj9pVbLyNeck+r83QHhjcUf031gh+VeNQV/U3+yK/te+7lFWfme7hfirhfC91z5S/vWOfH9yWyP2n3TmyPi/1rD8mWvE/rt3hDeqGD/6Rr4fcqYLhHdr2Pd/bYQ3ekus/2rY90ftC/b9DsIbJ4zv+oj9tb6Q+wu05zqif18Y39th9x8YGF9ZJ1j+OoQntTrS/tM2Zr9fsfsTJhj/6SN8f4Ddn2DVse/H2oj+pvoeqxEZ+36SbbUUv/+5PgXs+6FC/MI+atNo/GGSQ/jWWkSkcH5Nxl9NF+I3NH5F9y976PyFdMD+23D/L9EqWPyK5b+SfG79UtgvzTgEsH75UTZ+lXxu/Qr49zmcX4k6Scn4VS+Wn+4/AN+tzeX+Ravs/C3pYPt3wBsnkN8sL3+AyW9Jvnc+wflNTP4/3P/5ga1fAG8cFnL9oqWXvf8Vkz+R/b84wP41Kj9+fg+Tf6D0f/ME5/c6ZdfvB5j8Gh0pYv/uBvIHOrJ/h5/fkLx6fh14vX2Q919GZddvLjrB1q+Br8xB/sApu37pF8tP1x8cyN/ZBfkdHdm/svD1Cwdbv5P86JDA+t0GWb/E1+90E9u/BN53If8dcZD1Kz1C9y+Bb2PzP13H7v+4YPeHXLD7L/oLbP6xwPLXd18bWP58ZP6g8UsRHvNXI/GPwy5VeLz/BvNfX5j/0nuMzfKn5tt/ntu8EKW08uen0w9xBmSo9mf6KaGR5M9Pe5H4d6W6LpSnVJeLz9+vVveVILzGzpwUec3idSvwPGfdQ/kewvNvHh749CcF3rzoSPlb/pMCv00QPj0fVeCpziaP/DjwHnknMZD6xxjvBcEjb/FDDsX2tzSk/Y8E4T0H4Y13jG9Hglcz9XhWxqtfSv5qWfurJx1HSfjId1oIrzcx/iVAeJLYGe8rf9nSsv6zFVFXZJbymvKljFsR/EKNfwVvKuW3A8Hndto6GT9Sh6qWPPKjaPXI263OY/31nuBV850Ar5jfviP4UA3gdfLIu7zfCzzfSC3yuo7xpwjhvQjhjXeMf8bK1zwXqX9NF/2v/HSYxFn/Kzu9Zst9bD9tgfHzAOHtiouMnxPG3yKE75+Q8jNfVuB1/oVWgdecLsKfMN4DPlL1p4vUf68j9qsVILwW9RD7VdeTx/JH/FalQv07jR6iv2eMvyYI768Q3kB5gxvFAm8kHtL/N4M88pcI4b0KwhtPGK8FFaT/OFfsv6WB6I8bIbx58bHxj/FngvAeVr6xxfgXrHzd7CP+r2kg+nNNGgjP7Xax/T8NpP++ohbiPwOEN24Y/xRkvPr5qBaJDfWVGuplJ/9y4b8/JI+86SC8tsL4Oca7WPnGFONtzUT0pzVE2k83kf57GyK8nQyR8d8UvGp/vavzaH9t8w2x3xMzeuQ7Qw/xH+YI8R+Wifivm4bwBg8Kijz/KKvI28PwkTej8SOvNSxE/s8rwmvRJOM/lL+8WIj9PQ5nj/o78CbI+J9ZiP7OhivEfoZTpP/qGH/bIPwAeLX8dxuxX8E1QvQnniH2Z4TxyRDhBx7Ckzcb0d+phvhPZzVHym9ifG2I8CRYIOV/2kj/vV0R/2s3EF43Mf5bQ/h+gpVv2Uj/DYaY/wyXSPlfGF/BeLJaIfZj2EH6b77B/F8D4Y0vjO9cEf9hzdZI/a0O0n9VjNda70j9+x2k/U9DxP8MZhjf7SDttxq2HvkeH/fF/jMcRH5+09mD/DwoLsrfxfjPG8HiD4QnvoO0n79F7L/rbJD+m2O8c3OQ+IlsEf+/c5D2370hfDfcIvI/Y3x9i/Ak2iHyRw7Sf/2th7R/jPDaAePXOsI7JsLrnxj/g/FeiPDGK8ZbtwBpf/ZR50P9NRfRnxHG2ybGJxj/gfHdFsIbBONftgg/aMRY/Osi+hfoIRL/rvbY+Be8utI82wreU/tP8MpKt77G+F8d4f0TwhsJxpv67JHXT4dHXnPc6JFfYHxnhfC6i/GHreCVUKebCF4JdfSq4NVQJwF+psjfELyS6cCoA68uNd1Wj7wRHR95zXKTR36M8TbG6yh/2ApeSdfXmwle+VLNmAle/dKgrSPlk9npsXwy7ZLH8r1b9MhbHsJrB4xfY7yDla+PMf6sI3wPK98wML7+hvCDCy5/pv/q9pn7JuIvdamwdc54ZaqoLYFX/S/GO9EZ0d9dF1m//d3G2PorwhstjDdvIn67qOP3E6m/3xXjTylqDrxS/06C8PoI47/eEN6PBK80tdEAXp2qvYn476Qe6vjKWOVLdW3eFfqvlP++RXi3gfB6tYv4r+rt8lj/gSN4NdO03yOP8rtbJP40+aKQVtj+rQpe1b9YF7wy1e6Sy2P76d9QvlL/3zfBK0X5QcqbufY/YPzrDeGJ+f1YPgl7Qv/UpYIbtv5DvhH/F6W8ltu+3WR8oH7p3718Z/VX1s+NUPBqTZ/0jNfUpr78ZPybulTLd5Uor86fZ9tGVr66f7ES/Fhp/yPwyk+vt4zXlP7rA68aZa+XpLx63MJ7a2W8or+285vxS3VRSvDq+vsn8Gr8NhP8u9J++16C9P9b67H/B94vMn5fMN4akUdeY4fKHvSHR7pFvovxhpkg8Udf8Kr9nd7JY/xgtxLE/xAP8R+xQR79R9fE+IqHjN/qDqk/v+n5of1iTP4WJj//0u6h/XQPGX/WzkTsf3BF7FcD40cGwlsXhNfOGL/GyndPV8R+RYJX5f+E8k11/npF4neQP2e/R8j8sR8jPG0/ZP5mjdD54w2xXz7Gz+8I73i3x/VTfS14df30e+c8rr/6McLTqAzxX84Imb8ZsztS/wDjZ3eE77QQXkf5s4HwvRXCGx7Gv+wQnpwqSP8dfGT+1r+j80eE1ycY/zVCeC9AeGOF8eSOzP+MoIq0/4eP6O8C4zsnhNcdjD9ifI8gvGH4wv8qfFPwqv4N4iqif56P6K9jzB55I6kh+w8LjF+OZsj4iWuI/EcfGX/JDuF9r4bYzxWzWx0WGml8f+9D5+dR2fkdkz1v+XPCz/Ow5z17diP2zPfzTuy5y3j9xJ6/2HOP8xX2fGXPHvu94fXEfmOf/bsRs+cWex4w3uDlP7PngP27ycrXdP7Myjdn7LnDnt/4c8KeffY8Yu83W+w5YM9j9myx92lcnhl7n83fx+WZMd5m8mhcnjn7vc3k0bg8C1Yfm8mjcXmWnGfyaD/sec2eOyF7brLnd8Z3LuyZy/PBeL5fqvP6R6w8h5Wn2+x5w5/Zfqzusucde5/D6q/z+seMdx32PGLPe/bvLqufPmPPB/7vrH76kj0f+b+z+unv/Jm9v8v8lL5hzydWvx4v74U9/7Lf9/jvn/gz+73H2sfg9U34M6uvYbHnK+M9Vr7hsOcbK99j5Rs99nxn7/PY+4w+f2a8z983Zs9VxvP9X4PXv8afmbxGxJ4b7H19Jm+6H/zC/r3P2tPg+tNmzwOmLwav/xN7/4D1v9Fmz8/831s9IoKjIOEOhw9wrvDsOWTPNn/moQj7aIi4BvfC7PnCnj2Dm6qEhwZs1Bt8JCXsqiz2/MafGa/xQz5jgy8Ns+cVe56xZ5vx2snj+8PMdHGeh0rv/DlJROi1MfjUmD17nkhCFzDeZPXXeP2HjDfZ+zWWZZlMGW8zXuP8jPE253noNme8PWPPvwY3OGyQs/qn++WrhA969lxlz2vGd/j7G+z5nf8722/X2uz5g/97yxNJwiP2fofVT+f144egHNa+Om/fDeMd1r46b98t4x3Wvjpv3x3n+fsCnpSVPbv8fSP2vGfvc/n7Jvw5SbKPvPQ5ez7wpKv8fSv2fOQ8Txr7YfBZLzNKTF59y58TbqTY854986S1XSavfmLPn4zvsv7Sv9jzF+dZf+k//DnhRo09Xw04XyCmxzpVN9Y/vD0t3l9Rvr/e2PstJq8W8f7i/cP7d8f7i5VnM3m1A3te8vbn/cvLW/H25/3b4v3B+A6Xl/eny/j/L+NDO3J95PLw8jVeHy4v0yfS4eOF15d/dHfmz/x9XN97Bpzf4Pre5898vHB9H/LxwscHf9+Ujxc+PvhUYMGf+e/5eY81Hy98fLH2I7z9nIB/BOXx8wcM4uOB6+s3Hz/890x+sub+jcmvcfm5vXG4v2L2huy4P+P+KuTfF/Fn7u/4eRluj7rc3zF7RC7cv3Ge+6tf7t+4P+P+8safGW9xf8Xt8ZT7G2aPNW6PZ9xfcP/yyv1FAvaf1+/M3udzf1qwN1qFj1fe/3x81/l45eObtZ/2AuPX4P7IZO8LWX0t7t+4/Z3wZ14+9x9TVp7F/Rtvjzn3d9y/8faY8/qz9tB4eyy4v+Tv5+2x5P6S+1veHivuH7m/5e2xYnyH+9sq959cfl6fBvef3F9yf8719YP9u8P9l8aet7x92L/r3N/v2L+7rbx/67L4Quf+/Myfub/k/vyTvb/L/SX351+sfl3u/7g//2Lv7/HyuL+5cH/J31dhz9+M77H+1Hn88sP9Zwz+9IfzvH68/r+c5/6NzwsT7i+5fzO4P+X+krWvweMBfl7KY+1r8Hjgxv0t938e96ecZ+1rDNhzhYB/fePP3N8Gf/a3jPf5+3i8V+fP/H08Pmqw9/X5+3h81GDv6/P38fZscn/M38fb84X7a+7/eXu+cp77f96er9z+EPDfLW5/WHsavD3bjB+w9jR4ez7xeI/Zc437hw/uP7i95fYn4v6D2T/d5P6F+w+m/zq3Rzvuf7i9HqRJvtkg5vafj5+Y+w9u/7m/3nP/we0/99cH7j+4/ef++sh5/j7ur4/cf/D6cH974v6D14f72zP3H7w+3H5+8X/n/o0f+r2wfzd4/Mz13+fxMI+fuf73efx7+kf8y8cj15chf+bjkevLG49/+Xjk+sLP75l8PHJ9CXl8yPV7yONLPn64foc8vuTxJNfvKY8v+e+5fi/4MyvP5frN7emA2zse3/P4MeLjlb+P25sNe5/D38fj9S2Pb/n7uukz6y9mr/Qujw94+3L/zv3JJ28/7t8vvD1T/94Ta1ZELDc72DO/yucjqLW/V51xZT5139aTZmUxqe6ntepmMWmQabX9vbDa+3d7vFtPh/TvN/vZZLhfRdrHcmKdl/R/3Y539cz5L2Xj2XR4XtYaVy9u/q7t/WEx8Tf0f3+X+9nd37ery4P/uzwMz/zvDtZl2dnrq8M+ntfG9urQ/h7V3M/5xK8spvN9UN9rQdX/9UbDflgpvC/2R/PKfEFjhXh1N5Phgb17mP7bzryNDm0qx/w8q1n0f9s/47i6+cNv71RGk9Z7E9aHv6uDdZyHXnV23NP28GpLe/wzrw9PQeiPxnv/OK36tO7+YZb8Qe5q+2NoW5XZ2K8s6+6GymVQubfvtO1WVb8W1ta1+X9hq+3LfNI8ru3NiLbJ8T/IUJ/W2of50d+vLVrnw4pMb8O7N9LsZZ3KZKft4o38j2mFvccare32bTZZ74PKn9rKuU1rtP+O8/3qyPpkfKN9dhvbbWt1dH9Xx/3dM8NkWtdGy7tmeCbroxlebnX8NrJm1/64vc36P1xW2tvFgeqZva/NaXsv7+N+yH5n+s0hrmf38dj1xjuvNqXvntXa9P17/v7Z5Hp5D93bYjKkbTG/LWvVwexw3s/qVPcOY+M9tIyw1qqO9v44jK/0z2t78rcy/qg/Q97u451ZCQ/WD5XjbT6h7XNg9Rkbo4mJyu+bvM0n3mj8ER7GCf39nfZzJS2zOaB/f5tPtcts4u/D+pi2EX/3h99ZU/2LqlTW6vI4bIa1Jv1v36F6OaEyUB0Z2v+oZ3VadferDv2vNv5ZZ/UZ3eebVUfbLw/B1bNZHw/39L/7qDZvhtX1x9qc/U9ypO2c1nFW2x//UbfmtJb12Xj4m7MF1A74cXPEx0f4R32opOOH6tXE3azoaPNNrhfxfDIcrTvueXlY1Zd1jdedjscR1YGbXxHvzTMLOu5G8Nv5v9vgTn8zae6o3PEilX+ztK/N4Oie5/Z6P6RjZBnmdLwZcD2f07HE3/E3Pcxkm2vBSNP7lnZb0rFO63kJQsv/gz1SGLNK7Tzt7/1xPWlXVxW3ubbHd8pOQ/JXtv+HPhuPw71J+yxZT8fnueVX6Dj+mdM2/ZOt8a3x+C0cTqjMzVmNTk//9l453m603rd5uL7NptqJ2v+7X/E7w8P1l9ZzMmI+ipflGtRm7ofUbq7szXlW9+pBZW0v7fZmbYEMlfRdOTmb04pvC10bTUn2vmH6vlzd9h9BZS7sSEDbzvIO4/2ytqf67Tam9U1luD/9J963N1TnIto+TWrz93c/Zs+b/Wo/f5nWYSz/s96haWnD0f40m/qnMfWr68lY9Rf/5i3fGdtOVve9Ru355j28Ulszpj7halE/+M3G9epOrl5l3OD2o+6fZ4frPjjuN8FOC8Z2kvI7d7w87A9U/u9xZ5/MQ2rfeVwxP9MYg8YB45D/PR2nnp37t1FYF3V2buNJ8zyn/mU5HjZX9tid28xesRiA+p37fDy2+N9PvLr2M69YxvqwXvxXVthnPx5uVsf1merfL/37n/epV32j9fLu7iSsas3Vfeguj0FjHK8/gnDIZGDPV38/r2S2qEbHy21d2//4rIxD83d157+5e/u58PnKb5q/w6l7++tvjn6F1vu22vvJ+5jaPxofrCpzd2SOJ0Nopzm1nW6dxmr1sEL9AP1vdNw3lffOAvjtWulHMwlr40owuR7nE/c2G2vhMrUDjaG9v6/Y2K9FCbUb1L/vv2kf/jBdWFPdGt3NK43dfpZ1f899bie1Y3RsakGtao/pdIC1ad8cnld1jeq+f/JM8+rtqd5NWL1oLHScb5Zm258FaJn3MdXXRYXGYJMqHcPWkdrf//TbLC4t81tmp0bz6VBbUhs9o3qv2NMC7w+X1M96plMLK/6FjrX76L6m+jvfrCfXynto3oaTP8p/Dyft0Xin6f7eN2jZ91XlT/Jn5Yws6uP9hI5Pqsv7/dxUdXxjLqZ+QsfybmFomle1fsM/ttEwZDH9eOfTPltrNK4WPgb/HdhetQwrYXYuCE3ld5ZJ445Y+MW+5W7WVdqvnfE+rO4zffL1UXU94e+ruGc6nj7G1fT3wSGu+VZ7Oo7S3y3F76q+WfQdw9HfYwNq/5kPPbP4jvldGovSGC8tJ6xELLam/mPtSPsYVmj8s59b3m0xblO7PbxmZTv/ssnjjine21zQflxYmcw16tOr8j3Cl4SVzSgcD7fZ3w8ffcY5XPF+o/FIWE2y342QNqjQOdjBG82NZW24ZzZu3fFELDgKq35A7RaNpOlYNcwas1W0ThXwtfg7/9qufbNJbfLwxmIhpjd/fs//EIOPefzVoDF4FputlfiH/lsxNojDxpDHV0P224nP5qy7jcbsW1lG2PuwSuMd+/q7rlH/VrPuLD4Mc/JZ1bU9a9A2SOOaunf1Qx4Xn+f18e966qc+cjxXfUNmw3k9Gml70Ply7ZuOXS7/eGzOGlzuqsts9Jj5mL4174i4gdarwnXKoPU9Dn9Zf76xZ2p7x8czxKD0d9Dv4Odpvf2DlTD/Ne9Q/ar6IE/fGofD3WZC/V99zOaLtTmdJ9K4rdY0WD+yOSKMl6rXGI+HNq0X9cnrCZsjMl86n+yPy5i2hT1u+BPrwPwB/W0yNDQa083Vuv2Tn943v/PD/E7trs7awzODhNoTm8+v//ietXzP3qdzdH9H+yZZG5uE+qJ0TeFIZ5Zc/zcT1ka0feP5dDOBWIq1xZi1BR0f1KauqzO0HYu/WaTv+ejb2ZzadJvq+5n8bKwNhR5WGpkM/uit42cxNut3P1xV14Eoh+rcfTTxxG9p7DT2qCx36qfvK6F7FZhz83hL5VnbvdvluPB4Ho0t9yWsnOrDyXVPfTHr9zA8Dl+o/ToEQnfr+xF9xw97tx+m/UV1e7eYrLJ6xg06H61ndjTxqtTuV5wknJ5V+zfvd6Q/eLf8o2f4b9QG655lMTu6m8c+2L2JtHsbz/AqfP2pNmZx5JXGshodz2/zqc/ihn1QsxI6L6a2b+/O2TqT6STv0739Pt5cplUam2XvnI0ebMGd+pv/Mj/78I8szh1faDttqa2qU1uVxcY+7W+r+W6uR/P6GeL+sGYW5lFN63+ZF4p3L+9r6tcsGk9aTWqLjmo5/r5N9X9MZRv36fjQ1xM6oqbO1bfdKv3TfhXv78xHrKbjPZ2ff1MdPi+n42/ZfvHVq63pPJLOk+quls7/2ZqCy3R5NDsOkTZ1GtOadaHzqh2Vj8b+48P8MObxNu0ravety2J63s8Ns7qc7H9onFBdhj6dk1k7Kju1eaQ2FfLstMn7dNOhZVHbka3lsf6/rz/oXI/GPc0Y9NSk8VKdxq7j8c9ialXnofUzN+V7p3dyXx7GdfpOttbw8W43K8Pjfra02uHqHmZtxtp09bDuVrDrOl+rq1i6Yp/fVvXzBcZp1jfjjp/FibRd4my813yNtjXVuXad1iceTqn9r4/Zet5oVhuz8fGZybkbjebUrls35ntmlSr9N9G3vg9+iv6ZvXNVqe4EFxobFstMqH+tzqfS3ol5N/19oPDhqu5VRwda9tQdhEf/JQjdtxWNh5ZmePVr/on6+y+qE2y9ivZr6s/peOpJXfvrO6qr2nU/n9J54YTq9aFNfSlf473LWGRWGe/blcnE+j965zlcZ/o5N0U/RFd/UmU6+b2eVA2qT5sZtc/Upp1A52wfbN4iFNye2lLfoHpQof4a4hI6Zlk9adu4F2qHwJ4v7+aN2gR7QfWU+mlqK+l8+DEGqa7rLvVP4cPa2rvVrrzRuSuNX9P12477u7aZjbq+vR+uwmfR+HY9CKvtGOJxq83sIh0Hagy/sWhctlnV9z+zSuqf+/aQrddf6Njfe3WLzUkPfN5zX8OaPlujo/63wud54zmd3zKfns5B0j+j86YmtQ06+Opa6+pX2qNpTc55pnU6TqntCdR5hBlW+L5BbOkwl/kP8tG44/5Obak/YXZrnPxRJjpf9mzzOq0512llljDbOa1wOdN5WMz/TOcFaxoHfbu0rb6Hh+tmXvepTdrPguPwP7e9f1hfljV3szT8K/XF2iyW7eiZKzlnrLYVf9G69s1iu/nUDrk7pG/5vGsVzy+zyfoO8zRex02xjnfaPje2Bq3OQ2m8n/B+nrqFuTLX5caoSmM1WebHisZGq4Nf7MOrZ/G5/E202cN6AtUpaS//i4zj79nke5/VcZTKQGe2vByvynwZW9ta3rWNN25v6X9sf4XvWa327SSYuMaQzk38MGujfVv9rcv3JGgsOPkfZPYPPCYZLSZrNrcRdautajQepbGQP031ncqbzEbWx2xH/7tbH2+G9rHqyPWkaVXVzZjrpuL//taXQaEvqZ0cV4b/j70n205VW/aD8hAaTcKjKKBGUJD+TcEWNCb2fP2tmrQqNsnK2mffMXbOWGcnCrOpWbP6BnQ1oCctB3gayH/HszvxkX6e3PMY/0OOVyMe9GzFBt701Yc7M0xhtgyrltAmcPr+mtwj0Efg/WY10yeYt6NsXJw/8HVxP5DQLnl2j5r+FHn6j99fKqjXTIdFnQbt/Ndw0Ezxp3YyTrepzEHvCnyg7UU62rVBJpRQ7gLZOHLXLuhUjo22EbjvqW0E8A7tNbJkvneFgu2sAFMlUJoGynyic5ADBfWxJshFsKdw7lHGUZFO7Bkg//IIWzzrhK+IdfT5AA7TKuUKA9TbUe+2QTdZmAsH9lXQ/aNTHXCKZ0kBbsxdXVug71UGfRPlPgNthwugoSLyAj/TaUb6Vb4GWjtHeCDyH/h9g35alHG7Uu5LGdliYNMcyJZt0I/QXj0V0R/sIhxpl+rTIPcutLHNJHyPlfeAd2MnkZNVq1pN7ROmxNVl0HG9Jsp4IBfHa4zkhnqEc6WAD6+ckFt5wJNMkE/hjiK8KB3OzWO1nhe6U9CRpgBLC23SCDdXMPYjo70COlH3afhHtVl16ZP/pnwO6ZxqA32zQ30I5wT8MqWfaEdMbAIK4IkSwj2qaJe+2it+GJCxTTO2I4TtCHh/Klte2CdTu9KlDbeG9vQIcXiw4FYwFuWDzDMA3QXljMzGxcpAv1GHFdcuQ3yLKsyxAhyhPbQ3w5jyglvE9qnc3lU6n416uHZ0CO7hGU8rt+dpr2L7rxImuF0dNac351AWaKug2xfv2bff69pKdQh3EWU4hwL5fpH5ZXHO7c11zhXivwBdeAO0DPXpOcCV6Dou3hm476Bj3Jqf9lEnivd3cy4FdHWA+RH0Wd2ZTwE+qOdqoSu+FfR08QXkkA3IXzPAV95FWATpexqvLW6uhYF9b4asG4703AcA+rruUqJ4c21Lc482PqARLNDkD7h5QO9opEHaKFSWquFu7+AIvKeIQ5tH2XsGMl+q81/gNeg1qCMDTYJ9sQiLk7XemqMCc+i+1Y5cWz0OGRd01ynqlLfmiuB5OFdxDnAHfe7Ws4kvKz1P+/Z5GrRoOJMrYzXlo2Jc+M/O/W033ldEmP/gitwYaCfac4CmnuBJFb9TDaXvN1dr30rof8k6R82waIMpmSuseBbS4+rcoLU+jnty/vgdyNSZ/SjVbcvm+uaai2dtU8T+bjioe6HPcIl80F2B/BH1JW7t6u7MtYg9k1fnbt0HfRb2cWKThHEOGOcEMgPQ+QPodGava4HuzSb+MFpBuq1ruS0Z4CGOEc8KMTXAT7n9SJ/C3+FygLqpINZRn/SiGg28De1b6Att2LmMWTYO3scI7SRdkF9Anlyh/NiVcnuGItE7H/eDPAT4oGIC31yIrGO0QF7k9AHepVRmRHibHJ5dMYZnW/wu0WOboBtF5rzF5vbYOIYH/cMesT+ZAejmwLvFI+BD5KMvEvkzJVIgS6I9Dm3poR7xkiyizTOA81DmgLNTL4DzXPjUoKmdyBDFM7Az26RP+03FUiRifwJdUllpRXglPgeNBdpLOxUCd2KTTfwytLJC2QdjjjK+GfjFuY6ZnSm1UZH4Eh/wMsNh4OEca6DNA2iAJR30geHif8cmyOsZ/OgMfqn/wkLYJLYbYtM/t+enthhYRwQyZ0hiUMwETuHbQW6C7EXsCdWlCmei0OYWZAaQhcyeLLT2KD8OdAF4cXwWehKH5otKf1Sw+WiIC2nMz1UfhbOXIw3j9b5O7GciiQE6oi8ms48Y4QJj57QGD/L3JSyujH+QQw5thwrgVyzngA5xbn/zonPZJz6fOH6rbC2xzQ9hlNox07Ps4r0XFLTjIV9Z4X07s1UCHplotwEY+zTSikRus/7EvohwuWZfhP2xNgPj4D6IfOxOQSYGXdIc25G2QPlYkZD2pPqsEilGNYQ9H3XEs1AhcVNOekdouF+0wvdFkMsi10z1xwKOV2xKwRigabI324v9P4DrUzyP5A7m8X/xOyd6RU4zIm0+ZPlqkSapRhvkF3FcQoMyG8btMYk+uBotjArwUNDLQtCd93CfMxs0NbQ4BuCNdBT0YR9keIAX+hQYsQ76emaLzunpdAyy2DyJIT2OCvGSXSm3TRfpabYPOsaVR8ZKY4u8qBWpgD+o12S+UMTjBTnnGcgoINeKAewz9keReFeMg/KNQTrPXBmX4X7OE5Rcj5ib4qhJdL2I2Bth7cn5ygO0TaMemekALVqzpyTuDnQcXEsd7g0ZW5cwhrUNenBtr1jxZ4C/FVlShBM+DjoXsYXSmUxzVOgsLpOHu0wNiI525h9mCc2sDDN8bLGoe2W+J7jHsC4b5UaDoXdDIbY1A++vurBmN9EZQM8oofkuibORG3BmkcCQGGWggyDnAWwTn4zApbpppOi8qAumohlVA2iAawjmWKfg/lAm/O22derAm4KpgyzBG/BPDQ4i4JhoAO8wgvg99MXl9zHcW00+pau0TG1Ey+QMy+RFm+IkwPc2wAvGrfJGGI7NIOzpgmhopjLuC6IO/+qwnjGMrQGt7msgFOqhpiPtTm3eI5t3vAx2ZhxDGyR+MJgT44MAF9VLX3trT3DcOsC9MgOQviMH7pbXJPcvj6E6GSMcu2grQv3B0jAeMovfRboJvLRakGmz9+DOE35/EttQ/J7mgiGJFY/nzeW2ZD9hrWrD3YH9Ai1yd8lcpWN5lIHxwEuQY8Sh1Q5dCXQgoaon3xP+7KY++tP3aIxLBt6Z+3BPvwe6rO2I3TnM4xPzNfKRBvDx0b+I/ukFl8x1MZZtJDq5QvivfDSDTM7K7Hv65OyZpXyUKaDhcNeH5h2fLpvz9pz+ZHJFN3kmjwmYm+MkXiByLTNQrNieAJIV4Y1G1AZ6V/SZoH89kxtPxiHxMALalE58I4X4FwfkJ5fwBZRd4blqdv/yeLiMjhU+y9adxaaESquw5+TzE3jma84/Y1EOILKU8cakcqo5D1EGw3lInMBJDAzsN4s7ZuVqGs+L8nhOQ8NeencA99QTv3WjFiHPA7oJ+m5sT8tx/PQ9jHlK9bauwaV8IPRFPgKZjs311SQWCNYDvAjjELsO5lxE6OsG2GIsZByPgjQI7WUpnat6iX9rZGsAU463hDBCn5HDoN9fO6LfyrXUGsi+Tt9WVLjfc+QjZrON+Be6IsaPT9N1R2QM0WzncpCy85ohn/Bysi4P8EA1p2bfyHhGA+UEkFsRl2fob0liAci8APtMb1dBriN+YpC30F6W+FwvntPgPJJYUeFyTWFUnAvPDvQS4HWX8xmAyyTu0xBjnj65WDvRcf0m8po2DXcl9qOqpc8pCDuHyEI+sesCHabi9cX4ke6v+NnlXgqfZ3BSpDjm3CexJLAO1W+24s9B/gQZKf79dKyGRgHvKMC1z5hVZ8EBn9VE4FtbH/N5KD/+XVBAPxEp16BRVg9jPwHihtJMfAaNJH5AB/6xG0oHG2hBOBTiOeRJcaxNOLIAz+x2gPDP7mFKz/aFZ0V+57En86hDlths1YF18jnCOPZDnbyPtgNiMwde0I7Px8A7cQiKMDBSP01+BvBduEG5E3ki6q1JDAYPvKQN9H9Jzpny498NkKUQzxcxX03HMdFmSmL6BbLWvkWjPCgALqC8kti+czp4Mi/Api9hXNWUOv8cxg18aULGhDsbgg5AnjMkLvITmKuWQu4reZcGGdBygR74qPdhrEc4DECmbWqoU/AOA/yKlePxUHcXTEI/AM59lK3iMdqorzYBzi3U9wdNtfA84h69csVJyWfBxWfDcFLy2dlzQF/cpvaRzo06G8CYnH9y5ufrRl9qdG9/ADuQfzgWZNoooVE2xmQNWZ/IFTCfrJO7tJm5JLYb71hVT+EJd30F9Ad0ythvbCxAfwRc0Kn2O+gyDZDddIN+C8g7F7SKq/cDkN9BhgR9bNwWuSwmB+btqcGqAWuUVVPRgTaP9VCpA52irr9b1JWCK88Afklm4tMzrjyz0kH+hDvUXsWyYIzHV9ZEdHOUNQjdubJ3fWluHJB/r4yR2D/U8vXQbXq4wDggH2OJ1lmu3qR8LlMyKyCLpPe6bD7iq7ryXXL+3pW1EL8++vLm186ZxDSwCuqhIcgFiHugA7po2zjeOPvyWIDSOa74G8uepZVGrB8irYWzb8Y5lmXPgdwDdMHcgky2gzs4HaL+aLfK1qqrtPIBNDsktlMjjT1Rrz1LIT8YGg/BAZ5Hvqjt/H3ZOjkD7inm5YBeBzRhqV3gjm6Yhmrcvjclzzwyzhne0KIpiI+tDXQ6gyL0pQFnhb4eqsBjZdDB4Qwx3pengWZl52kKoU5ov1Xdw/d66hsH+WuPcUMjfMZQOq4dGpjL5zEHwAkD82vrqMsNaI7YXmpoB8fcJmYzhrMAWUSMcHxClwA/gE+HyK99tGtQ7fWQUb7wHRhnPpA2wPM2YzfJHyGfM+0XmH9HfmfR3wv6N6N8wHwLxwrXJZ8vfbSLgxxhMxiTqIxBHtr7zXDsMDBnvOYIxl8Av9kArU5tE5nNB8f0YrjGfh/j1DaEOj7Qtvic07FETtLpdkMzgY5TooDnmIzBm8FJvN4j75DcK9U2g4H19vDzJ35auHsAFxZkccqm3J4RKKD3H3qqoSHuJ/snPvtMrnjweaVvaO0CjMZawPVVyhzrAsdroBek48Q5WzToweH0kecLuRyP7PnEpvDI+H2D6wxs9ZGxQW7Wppj/cR8mnK5L3PKR+U9sT/sHxhZBjsa7R2IrjEfWfTNv7ZE1WiLfeOQ5m2rTA+uA8uTYJbmMD8F15z2y76ayGqKcDfcVaNAedQIHZXT8L3PYeQzA4losjZnGFOMzZoWcN+OmdGaBdQJwDWhL8qQQ+fYX6E2Gt0R52wzUON8h1S+R/gGNwDE2DS0AHYM5AC+qSiCvELo2AB1HXXCgewDfCUF/Rd0In015C9Umdx/nHJzIgWKV8LyTZ6s02o2Qb548y/pbOD+1b5B1GH1TyemymfldkDan9J3EYuLe4IyQRq4HRK8G2sPQGNeyc+CsEtkfffJzrxngdwBH9NvhHmLaiTkwADtiA7UW3Bb3PAQ8hvc3HuPr6IOAMXbAf+bwfuTSCtrtdd/mQ2/eysYZ2soS9K6ti2cMugOeaTIO8CoNbTdrd5J9BnwL4Aw6XzY24RtxvYbsGdgj4B8P+91lvMbCOHuUv6uZXoz4gLiTxrnVMPaLQR8rwDPFxSQmPLaTtS4+T+9uLbubwE+Jz5voYPBOUHyHyNZ9zG+K7RWNhDem785c1MkDgt8R4kZ639JYoSyvtcBD7z5jEjqYzZHYv1OfXz+GV6WwzjS3KYndFxMYhyfjzGMfVJVOdNEx+ogHJ7CLfWrDpZnUyuBILP2tMQAm6DdFWbsfx9sZt8ajBhhXjPeBJrbzjWsSuMb2z0kOGxfvIeJ3EqsKZ4A+4K3DFMfHWDiC17ncVPgOeTvgEfKAjyGjXc7RRB8QvYI5pt7pu1XAL4wda8DchN6ryToKsMD7keuG2buxLbvsvN3YdltyfsQXHNewSO0yJ99lOVLGCO6jbpkgJyV2gZPn4PyDNKeT5HkR/ucmela2DrQ5FvZ0czyCT4keW/wuzluujwyU+/012vHRRgfnRHydrj0ldpvinDEva1d1jH3AuHqhOiV5uEGsD4yaIM8GNOJukNQQQfp/LMAcbfJIw7bElpja3rJ1hdsBiT1AmTRZey1fw4Dc48S3Wfa9rYjo5/ZInIGyHrIK0f+JHiSZMuBZJpMV3klzg9YjE20pSVyWpY2HQGdBj10PL+5wEdfy3JhhMyzW7AhsprobBsBLpMOY2IZA3ijAAnQjpfh3kdbmn53jGos2rezexLGjBboF+gDwr5hWFsaJMD5BS+9k8XlWC4ZSOMN94HkBz+XJM0m9G4MRF8U74KOdn+Yuxkk+z3l+tl5t6jGbnB5cvoM4oWCsVp7j0rp4H84p06NuPYdjoyxS2DvI4hvMV97eouUgG3yRXJsgp8EoSwA/HBfxpey5lB9mzzAh4Iz2AfQAdUeYH33166QmAsYS0KjbhV7Ypgl9tQw8m2iAPlxBrsR6HMpUU6xbpJMct4X86Pu0H9OgSKbf9kojoLpGm1cNgekK8l6dTw5aw4i6jbChUm69qwsHORLh94M8ssN9EgdMndmwEa+nNtbkyGqX3F0H4yV+WDlSxnJDrSqNsK4aIq/Mpw1ZaFVkQ6XlaFJVUXabBwdZlw/wu6w3Q8xvXJJcEOHMLh/HI2MucVrTgi6rO6VQsC5mAzjCN7qADyB/BXgvf7IWEqN7BSYaJTa/Cxcn1g+jn6xlGLmpLda6Ch9j8zBslGUi88Jq7KhGdXW1qgYir+pORY34erchCoouV7qGAnJ3qyrrQiTD74A2mMN/kMPkfRru3wJ5jijCdxacXyetrUNifWyeJnm+S1I/Y+MCxIAHfIGuv1cjP0zX/22YiG8VP5HPQR++ek5oa4J/VJ96+JwOskT49tIj56X+5D4BHnM8qX2RrNHEWC+MOTVMWLsb5509DCdhH8fbEdvz1m18/8wwNtGmRF7W26nd2wDdFmkwrxkH2VxqLuKPKQZ7e/9vXJdw+HeuKzj+S9cV/RvXZTDtqiWYC9N8+/fdx2VY7dNT0Q2Nb9wBN82PqoKMj/PoGvIxNtxrbLznh2nyYgoyubbG3ABPBHjSikDy822+6YvhtE+5hqXz498cz9DF8e+ur/3L61N+eX3aL6/P/OX1ub+8Pv+X1zf95fWFv7w+4VfvLvId+XFaxQySHG4iU6PsQWlYR6XqCX6Sa6658q/fESH63T0HB0X81T1r8q/fE4H57XNW6N8+59++K0L1l8/5KP/2Oc9/m5+0jr++598+57n223umf3vPSvjbe/5tvtKq/Paeu79NtyP+l/csH355z5H82+cc3Za/uk0So7UC+Rxz8o6OrVQK46DuXRnaWmcouLhmw2+0l3F+zbU9T4+uLdIDux1iTp+8EKORmMMObS4jiab6zEHCOjowPnymUfLCo5M8dQPjud1FePRYlfYx7nhhnOTBoq3LCUQBZX2b1WCfJHdv1xWVRqofqJQ/NiWPlhtG9bfOB/PWh9FUUCjF0SzXlEMujXHGOpuGOxfnse8nrmE4sjHvz684aKOF87lyppe2mO/rbxbu9dq8BvPGADxITKAZasu8llNa81lLclqL56TdOefvwQ5rOgyljWyzWPfwun1wQGoC5jUHhlFrr4cK4us2zpUrxuZVG7Hd089yGbCWRt8yq+piCjot6Iyh9gJ72fzevXcoF33pwmEMnxO8k3XtNF5ZRH+E2FSNaaEm3ANwZFzh0XWS+k50HmcA824clgeccMddjLvIYwm2Q4bb26y7G1ga+nIp325vsxoUGIMpYa0ALa+NCOcjw+c65ikxZhKTVT35HmtXpDG8SawTsdddXVfUJuuKzzS3hfoMxlOf18NwWeIXjOfKcTevCV0KH1lXMnxK7QPft0u67Kg5uUWDsf5xaqNMbCTft2mYS79hiLfx8rf24zBXzgTknm7tFm4KUY7TP6dNPqv9I+dG4hH+/rlF/j8As7xvwN/jGT47rdw+l3Nb4I/gNfduw+vCpvdjHP/r8LqHx78Cr9D/B+CV0te/Ca8TfmIoUprfGfN6pWVQit5vXNasN0Xvgfc08p4iYZ4IV/Uil9R2xnwRzNMC2dfOa1eJDZBtkpxqwpv1PsiKD9aFLowDe6TiXBp1iTlI3NYMFRfXY+nFmoxT3Y1K8saK+yrhrwYdYgz2Sd3UpGaqgDVTMZ/Y3Gd1yyLgiwrmtbtGm/ab2m4Ygoxuwr5oAePDdwM7JHVQRk1Nsu7A47H32lnuTVr3rWzNhVqvQrHWa2HtxzyvKK3TVgJHvQDD5Rle5PLH1TruMF6kGoqq2BjjhzUtp5Vh4N5ex/Kidomusgqv0g/VE7oJq8u6NUrDw/opDRfgTup9VC/r68Dt/+m+79bumca1e344/sM1kn46vi7mNXowXoYNK1in56fnd6c21g/Pzl95VBwHD/oh5jX/bJzHau2IhVo7P1zvZd2jO/B8pF5RCuO8zsAc6wyY0pU6A3aSd5DFj3nAW5H3kFzRPM+BxN3F9ZFP493MeesW/wIem+Z2u7zKAs+NeF41/fW9Oib/RE3lon0l09v/x2vK6ovorpXr/liLol1atyKvqdPax/GmpOYj1ulu5Gv1/nSNcf0jWpnZpN5Pmyq3UfwL17ks5qBzhpvWoKbUik3ntQeBxqW0P+F5LtJUjEXHWknLmDYRO0RRP87GIzVnKJKTyrineTYW1mbA2ESM5XRI7e2LWloMwGc+wBjR8B+e52/K0GEBL3R/rCcxnKd1Xpy9wpgV4OVT2Etdbpggi2E9T3NO+iEIhXo0ujIGnIgcyw3VRYjyIUXqM9lwl2/Z9X5D3wy/Y4cTDlj7Z2iFEal3uVRiOxzgpcaGQI0dCvjK9uH4OzuzDfPWT2JK0Kb9zTnTeuSu9bM4kWHk81Ya0x2SeEO0gy8Uqbr91jrYNJfV+/460CY456/nwwbYHyKGDdCOcV4/VBsnuXSYnwI6AZy3iLVJXKwdhWslfQFOeGpAbOEi2sL7IOnFMY+3baYaTejRXpnXfssXojsh2XMIkn4jjg/iMns4wQH6Ozgg7j0Bc5srP4F9tjZSNxj718BdGZKaK1gb65D1BIV3YY3a9/CCSepKLOWfrC2uMUhftRmf4cRDMZiYx0Tk8B/EpVbvxOpe3p2S2o7FvmKG/bEHGn4uHzZksU2Nlu21ptcwJw9xXJSbU17LZMJyORZ5vKebeE7Lb9EuoIHagpujrv6TeDjg4bfizcg5gW7zjXMSKg7I3AMmidEr1NP4ybndiuEt3s84dpbgeQVo0dZmKo/H7TX51Ugy17F/QP0RHSz6F078ilFbv7UHX0jpY3X7TThXMY5+QPJqzCRP+8c2rDwusuGmcokkn69xOf0eXJdn+Yrz76+rWA/wFhwT2pzhQ06bte/C9ZjGa6c1In6At0V/6a37FdOdZg5XgzkAH1Q2js0THkh0Zco/XOjJSzGwI35sGRtHs7PfI9Bhk/wwbSyL3BH+rVO/8R1e3SzeJy9CfQH1hF/nobwWryXQ9BajYn8YE3g26OwO49KAg6GWfgZ/y+Lbvt/wc7lZ+NiDXr2QLQVgVj3laz/zqZP1/U37cCaH1Mm9AanI/BP5Q5cZoKlmHCfszoUyX9LHwFp96Y3WPraDO0nOjYl5SLFPX+Qe8Dlf45ln8Gf8gmx3VQ9h4FzWftyfIdU5QCefRKAvVW1WHCt2bFf1sVdMLOfxWpPUpTVBxp+CflsHXQR7qVlx/LM5/kf0Er1GEdphTWjF/GmMijIzgFqQvZL4c+UTZKPLdVmHzXDBqXA/4vnnJhPb2kF+EEnMN+rLOtDjA9zjeXoGcJ//1hlgLZG/6gOM41dUQl/cuUH/SdyKEWG+djgmvAJ7I5Wsa7DYrIdGBWTmeP7ingnfwBqdQEuKcn0BvnA3/R7WvyvEHuyB5pLcPZtp70CWCGyG2ztYX9fkwhHWcor78k6HQM9ObYJpXng4dhZcheR1svwU7TJxXQLMx6+SfmOw/qQmHm/rTN5zpjzHKokhYEnOXPw8E9dRQfuQ1wzHA5B5UI+G9cyS2ixY25WCvVRtoJ3DJk9qDNzqP66YXEm/Dg7mM9K16i7t9wZpDEC5Xybp5woYskj6gNH+2pSodI/YO7Prxz0BGrolGsPkeRP7+BVr/S/5F29xELtx/ynM+4+wHr9qtCUi64YJ3chjspqKqfH52visjt0JHB/gffAu6iehy8a1HH6kpwDtuCkvpnxgGRI6Duvn/4XrQ5tIymcMVc3s7vusJp15eu6lNvlC3ydiq2PCF+xDkr/jY+24HdZJx2cL+PKo/0U3TH/2bf/CQ7WIeduZ3PQ3nNToJD7Bu2s5qcOpo71fa/j5fsTi++d3TAA6QerynNTD6Zoc0OM0Vxh9xdPiuuHc3bQmfJynSE3RD6qZTOsqPenMhX2BppB6Txk9mVUOygTrtMS1n1ysX9gEmmlyH651AB2/tQXeUBg7p4+F8dnvwYn4bAq9PM1K4reVHvbbXve3VeP+66nvNfwj3+vNHjA/9C+e08JTu9qf+RkN1kS7zEU/kh+OebW/yY/XuIh7UnmMmdizzn2rBRqSxaSksXtYz908id0rjw0QyZ0o63d9ZZ6odB5WKY0RhH38/ZgfSlGzPd6x6boknjKrV42xqW2QuerYWwJk27rZXI0L/dSu1ObTHotp3V/lHY+v42/HHbK1fyaOsvaTO8BXRpbyB350N+3TBHjdqiANwXpSKKee0BGgySTecmEeVZBrSR30+D0K4y/iuAOs06d8DADPUdYEWLCkdgjNjR1m+gV0Hun91EO7Ucith013Y7M80IF2WKjXvyD9aCSUBZDmVldErsa/LS22x9qkJkJFAxwYLg5SHBvepk79qNhjG+vzkNryWGMFa7us0lrziX8i7U/Mq4vqmvjzQJ4Geb/gL2yxxVrhF/2BhVguIDZxe9oEOXSb5Big3Tn3i1+T34xwi5+h/Rt49x7vkR35C+CNGFMVdCVip2ecuBco2gxmI3MqYl9b0GXu1ROgkzqOKBtm9V0AB9YF/bV6O647sT0KctzfgsDsDfMSVKCFoBe6nQffp4dxnNhYkYCWMRWAv5r2LK8mZ3hKR0mN9zt5yxn8zFheo98irOeW+yi4vH59iP0pHx1PozBmw46U/cCK1+dFmc0Pe0o+um8WdW9N4ljsJXO/LkUOL3zPtHliu330nBXSSx7uVkOsyHaQ+LGzdYNsH57xqof3UYXzC9Iagjad9Ly9C0dSIyskfgJbGZtJb+h7++iSGkAbFdb/ATIO3ieMPZw/NOe9/IP0OeqO7vcD3FJm2JMC7aqHMfZyT+maHMY9Z671aFEkpDF3Yg7m7izpCQZ3pUW7cR0XaiQqLWO5iunXWSwJ6T9zvU8O0tpgZCNv4eLYUVITy7SUoA13cxP6osM4yfxIexQrthP4zaneF9svSOvK9IiTdVy3V7EkZgr7DDVgnQ3cW5DaMu/FX1SGS3GM8vGN3KB/ZO5/Jm7if7yX38ztwhgxmuuirQlknJN+ryARj1MZRIa9Elu4ntpIQ9SBxqTXhxjXADcLffJAJt96JocyE9KLqid+/y7Y0Ukc9835lEV6RzjdmZsLonc3tQrGTvl/eCf/wjrK7HIncXtAoxJ/dxJDFjroX8KajZEPeKzCutLeAvrCZGVdm8UxfO22Ryf9xnQB+DzIWhZND428bxXI4lg3hdVQD0h6lpFeVoKvO2HWB7DYa+XftrZrser/unVmdnO6KMeW9RH8x2MJs55AhTuhDxrTMeD5EWTqLfKb9P6jLaMrJXQNbe7s5KCQ2rRtWJO4QDmlnzzrY9z6lVjFmP4lMX8m9rFxqukceAZ2hDRzusrgjzaekLt5527FRpbMF/fbtLGX4MPvAEzjHjYAy37aey7vNxeS/n0374yY0Vid0Ikl9iYEPUqfzrPehKBLkfyQ6+v6Jt74Sa/P8Hosrt5O48OSGOC2Jc+xpjO3JTVd456FSc+XauhTcW/SkfHAHYx9xEfZjO2SoPNibU3MbYjrimKPVNhTUa9E32hXiO26SIcNe0XyXQ22fR6jNia8JTrt0xTH9mT64tGmSuKfc3qAvcHoC32U6EFwhhaN+uUGaEWxfyTZP543rgtzcM5gS8mWf0jvk9YQWLcoHxTi2zWMzze55kjkDjarBYlt9JYP8DfytAy/wS8VE2OwMj/bb6/zd3yVTXXvRnGcVhazQcG5MCf8OutfiHp03FdyOob1YowoOZ8SmZSSAUdPYghpRQCZLijKP7l/AfPfif+2gn5bX8riy4gN4NfWWZqbBnLEb64XeNFvwvUU98vtXYADvwnv4G+t/1fxDWhfyT2LkLae0duzuFwB6xTvh9hjxlRo9C2AHhfaUZxvBXwwq4/pUdwC+PKW9DkmPXtF7EOCva7WGJNkn8RQhvgdr9HAyxcH4Ae1g429UEW3WoQB6tEgVyQ9NhTs35X6RSygfYqGvMNM4jezWC8llvGb2omv/AKXgXaCjHXZF2MejkHXSmuiYw+Y9WO2AHeW5DlWr+c/Kh30DZzELqENQDyXDXmQmTTse7vGfugAg6Nr82vs42OwxMa7ddFe1sSawpODLGW8KNIZF+bHNYQY17VKcq4ogzlcy7lqkpwrkBewFyn2vjWX4TV+2rRJHk/SFwXWB2ca0+nQraoG3TSTuzVcVINCrZAPwIsP0kc8yQG7WAfdjkYATYIrDOh0wUl/ReK3Vw2zWXYv7tq+UFc0SA+EE/wqPQ9amd6G9zSHL5vgeOMCt/seu9KHpA88l+hYZbm1N/G7WcDvII5HSf3cAsZGTYH37rHueGIrGmc9MWPb9dgAOQf+S+H9UkKurFc09h/GZ7ZEJxTcAdKLEawnlh0y2WmKOSKOpWEvhkwntdNcEjG2ccMYe/yv35T3WKejNF9pzjfwmWGSX2LFOTkztK37DbFQuwX7iosByGp5X3nzLbULx3Z+oDMgB4NMiX10BaZcvmrtVRaeYapxrZJwldvgm+ohz1vSqh72mGenc4DRuZ0A401OYksU28dc7NCI2md+1Y2jAf1NcxUMyi/KoGv4pxWe73vN1XEoGFhDdOUtFeyvFLj25DhkHMzpS/JY29j3/UosjnvXlyALAqVjb9jgjSI9YrF3ebgCuacQZ8WGukPRrpPE1yXrneu6QGEtf9RR+9ibGPNt0QeEdknJoIaYt2pPKyNjk71vl/f61uEudrxoSnqCxPYmYicc3I8pVoow/EfWNLK1n8K1in43M62DGvtCz3uqRWn/rK6Q96kh/BZ7GMf+/aQ3nnmUWXHnReaC+PsjP42Hw1g+kK/VyLA4HWgJD/gCcoxiAz346gMsh0bqIwyrltBG34TkBvfqT/K8IpB+xz1FIv+tgn41IL41hCWjkDi5n8Ol/bN3zXAG8ox5pzbeXtXjmv16pG3wv2hrt3D/Vnvuwm3F+kyWJeLvxx/CwXUWuA+kk/B7sqf7dam/O969etLfXt9v7zer6XmFLgG/Vipw1wxjuYoUk/DyCkY25DF7aa438A9DFDVSf43PeQBNekOn8eh9j+aQVlLYQ8XVMQ4rBL4AerAO/5XSXn5VfA94mljXaFJrC+i+omK9MMChqWWIc8AV1BmrMc+5V+/tQbiYWez6b+Fo4b4pBfxS2q7lj0m8RMgZRniv9pe7GsX9RhvyPJyexnQAr8QeJIswGgiHKbwzH8R1CKrnPdlBl+qCTLpyF1mcuHWn7pc0sKdYiytUo1bVOY0xFwaWJqGtxWOmsmOjHWaKPqLqSBf2p/K4cNRBJ0H/YprXZgauMdw/ODclNpDuAE7sHoWTG5h3xhcibRFW/CbIiYYyHS7dqUeBHA9wvOzHmvdbdpaYo/p2J2YkXwfQeQb4XKNrJf2N0Vc8j3WvOPcIY2DiPsekzsUPxoZz3cQyvoYy3dK1kroRpKcDidGJ+/bSpIbE7k5cTQ53Rtz6CzFSIz8e3zT3ufz8xuqhkvZwHt/pUVG6boWJYWLatV9er7nwkL4Abz2108R+5p/AWIn7rx3RX53GLqnYW9puN+IeKsoP8E1ZaOY39pfoHGoUwj1DGyrBSaBlD8M+1WMx95DUryA2tSby55+s49fgnK3rd+Gc6LwBwLn2IK1hXCHV0b6z7pzeKBWg67xLTY82O81yumyWR5rf8parHcixFdInL/bH90dLmdYXgPN2u2cslbE358dDUeufyK/stA1wXvab7fGoKdNJ3NzYE8IQ5xotuPG5DHzOdzGfzBTb1TgGyjSMXL6ddk3SK6mR6IKrxB5/pVdPsT5nSPp3qYlONwA+iPpnQdZHXRxjxLDnIokPBbxbYT9Aec6zcLdSPwapo5L0ZgxdPKuQA92G+JtC7GdlStwX7M+KbeWkzsa1HOV/an79wViI3EeUxKE95i/XiJ9jlMD0XxCLcLqPn9ThkIjfC+Wvv+6XeGQ9iW9qPzK4o44xcOifEkt8abAmEiOX3wWMx14Ru0dZTMJ1GMY+YzhXnW0rQ9YlfmOAIenV2ZWKPmHk6/B+ittNpXqCe383Nvafht9JzdXH7kfsqwR86nkBqU9zxZ8K+1qQ7zO4eCzxjca1jv4VsTFTkhtJYmHMNwbzErCnd1fK/fNYM3kYcpXs/B+mIz8Y+1+AW90m+srjfC47SmsOBZVCX0W0922Bz2bn+INYsQqplRPH4oxJDkeAcUknMQMHm6mOR2KKq/8M3TIYAWkFyc/zlm6Yx2SEbZh7LTf8PF5jXrtSP+t7vFJZYP0R7M8k7B1i+yV0p+cuQ5LHjn1a79j9pVv1Ohw75LXAL+6RcZJ4F9BX55kfH31Rif/JZtViHngV1wFy0ktagw79HpltIrycA3AM9HF+ijk56DcAOSz05th/UVkNdPRJayv0u6F9IYmrqqK9Q26gHhtiXqcNui41EFp7I8zy8uH+yXRa3+AkNoPG/NE26GMkfwX4cYsGOWM+sAKQGcVggL7IuG4W2s/1EZHVamiDwVoWAeBQADpWXRbbsSwouLwmKiAP5jE2WiGHuhADnMOVlisJbSQ6Oday0MKPvE6BDTiH/sBQCUl/UZBvDHtFztihFSf295l1Yj9IYI5+MpDNK4nNZ+US/y/KSQhbEu/QB31pCavA/rIWxtGqhmlphRiKi3XBGB7lDgqxtKU+jiyWBORN/yJOP/aZlMcvhWms0oqcLfp92ZNYpZP4CvQRYH8RwtPMHDZqdhdkkpeUx3dgPa5p249tVzsvFF8SHDqOirmt9qqJ+r0Bsr9palJXLIsvERAvYrs25YPuoliY6xD3XTUxfgZ0GprYmdEHqllVuC9aAkeCi6AnTS2AuXTi8yH8OcvdwRidIvzwffjMbaOcOyL9bfN4GfQjxvkYfhY3g36pJGburn7wKzm+KQ2P2vlecj+bMSzzGWE8qaSJ6I8+i/OpoB91RHJLrp/Fue1MEdCWJVqoSwAtIzHjuJ/EFtaDz4lNJ6vBtkQYKlhzVTepjaMZm7UGnxHY6LWD0i+bo0XDjbxBD6djwKvbtljBBbj5cX4xJTbiWgNKofbLuU1QGdsU2VshTlWg47qjgHPYo9cAnVEyI8R7xSL1qarAC9M4gQrMF+erAO1PdVagnXSZXVmdG6w5T3s6qAdZyvES/d5YSxDp+qgQT1j0tfnNFcJRNxP6B7oN6DW8ldZUyPzV3/NNoP84uFsfJ7ffJHnM37L1fOOdzG6R5Uv/aq78L/oYTSGvn90VON1mcl+YzQJdtttzAi8Tbdx/Vk9VBd09qYVoyZMf2fvnpO8iybu/kuN8O7/5Rz4Bg1EUC23KpP7Hj84g87sReDNJzreU5lcHaNtP6ir83AeSnSXICgYLugGz/2MfSOneb/tTG2f+VNBxYP12O82V5jX7Il+SVws1J37VZyMIf2FMMbG9Fe4DyZUk8UoP1BI57ZVRwNPZkJ1iT6OdJ4moH41BHgBYEvqK8spYNu/087jru+Xw9yn5PUzrQ/ygxggb3OSzqqXwqCcZsC+gO8AHD3lt5Ojcv6QJMO/UnNcYkIHWgNsh8gT0RwJvIvUBzuOD4p44P8bBZhKfg3TZHub1UeaGqCxNipsnfyc5p4UaKn/BjpvU6Ph1uzPg/lbRY5o3gvWpOE7IVWA9Sd1qbg9z4l5ehjQXdeFO4plgPD2RUTC+e2EeddAPbRZtNQeQXRIZCHhRZ24cTfF3Yhmyv8/40nfvbYLXmJdJfMFpLTr1t++NqWlpX0SEIeBenP8OZ2pMSnzEk8f9F9/2l6Xv/A3cTPd5td7I5FYtEupGLZKjrOa8OtbXCnVI5t6NceX9zbpJs0r1zvdEX7xZB2XeulMHpVW5M0ckqz+WcY4F3vtQraF7cVC/fL8MtQ/nd9MnZ+5JDnrzPKeZ1MS6k9c8PaL9rx8qPR10haS+dKCd+iuk2/BopfhveRHfkAWR9yhRMBo+nDdH9gRj5r0Uvj0O+qTg3EGHynumXD3rekrPzWXSJwD0XE2sVW30y2O9hoUL+DddA2z+YE0C4B/WgyK1IALA6wB9/ITWL0NnCLwNcCyti4J1DpHXfTw6V1an5JFn7/V9Kj7LKPtvPDs91UMw50zZj3S0608e7dfA+pLw8LN3en6dPHun51Hx2Tv65Eld1L2LfJ/YdDDOW9H9JW/7C/XRerD0II7DBl0wrRmgMJ4IuFZ7fA0O+iRsYsdeD7/vR8E7vPzmutm0HqwXfX8+QjdIvcfzev8arxkH2Qz8b8Jgmuda/NF6Ln0wSU3a5jfhc1AkbkZyMDFPLZapo+/7LOJap6d9EIuwud0LSrfk+z2nKHr+m31xfTWnYbrZerwusoQ1vkzM1QVY/az+P+gct+oKp31x6cwmTpfaxHN7HRum8fDNdC+kBgza/Cm6/81xMO/mdJy4loySyKU6yNwkPwZ72RrMdIr5oaTnTmojF5Si/pGPxSjzWO/iGxoVbnBO4heyi7JmPk/Gt9M9xHpbdpaFz2M9S8j+njvs/R4DRT2mMFaCy+1s3V7UikrzEgo1PtL6PX5h/XgmzlJL/47kuVKaT5HlRhgA1xzehfnzdeawFK/XxTf87815LU9wWcCD68/keBHnSpzsH57P16JPx9dqpNys4/wb8S3B92CCstQ3704x1+kUbmX1/oCPj5rELoJxpmu0sSdjFvIBFcW53Y9Ou/tMWW2xlJbe6pd355mLOo0nz5f37juh8+e4pAsYQ3Z0jRM7UhXunaQzbVKf92yv5fUtyTqKdjWcP/MVjdEeQfrOPFYXifEYwI+FEiJPVCKkLN5R1r29LBgR/KPlRnBUGm0B5LK6orcOSiRUlAaPPBHg4GZwM5Jxkv6Qj8gxee5brGdKGpGZPBZuGivPBVZu8KIc8cDhalV5rh41kHPVuYHrO3Qb6h7QP69htHT3JusGD+ZBwn0To6S/Dasg5Y5wb7W9psvwz9h39RYlBxroJS2arEWfUDJcN+wvd18myuBbQX04rh8l/2Au8TTXlP3OHoVDPHciiyx/Nv81meV7a3Hnvt2OhmzrB2s4qdf2Hdgn9UpTWUZLZFzv+2sA/usW98vKIBtwJzFIJ/zmVJ54jEc9mhtelF0ef+dhHvXQeN/cG/B3MmZXdAs8X6jY1+oIsUm/rJw/3YZ3eY/ax9/H8y3uCWusY93jkz0U7uH3Zc4i76RO5bpC7ZLlz87pu+u5ljf96NnIofKdcyzapB5/72/2pgv8E5kO4FHR4S65Uhh56NdhpuOUL4JOK2T+E8yBFZF3mcf0LpzI7nrh2QbPl+Y5Fuemed1N3/9Du3vBDxnZtEb/hTF5s5nX+0nxCvUN13RL7/iv5D/+0l4KfoksFvAk3iy7Q7/vI/D/mv9K/Itjo2+snY7/MA8zGO2UvoF+m+mt37DXprJ0OQ6ZiiVQD9o0FOXx/kpT4s8w0FcriKQuSdIr95DK/ro5VbI62IW+WrpVuWnjKX6v5PqSnvhjiXxfeKZgZ6K3/0CdaMUSJ3+/TvTdvfwGbacd66Z8+CsxzBlOge6LMmYT7sB+ALTQo2hHL/aUMKdJXHrcU2J4o3/BCQ4JSrNv0cjvL7+71LcL4+Y1209wrrwPS3oeJbpp9d4dy/S3dJ4f1sVtmE3h4bi023e5PC7t8XfyuLTb7xT8VQSnuWhk0bMhc1g5R9J7Z2wfa/fpDej6HhtunAW3HljyBLTtGuj11aHV3iFfbaGeD2O1Gnf0q4txQJ49/yy2u8Vro7zJ38wHOYNHYueM96Jdhcvv1EC7PTd/koPzvXP7DbrhnJ3vvX4GV/BBvJbrIHwLf36HdzhX15jL/TeeKfDQ8vPgT2ja9WfKdBrnGjyOMb3zQYblPwDeEa5DQzuUfXUdhb6JZ+PWURcPTj9roh/fK50/saUDJfAmj9jey3AadbDSdRZ8HK3mA/pgOZ2oesL52lOfg1DBfkADxBeLyJJZbUo1uWfoE2nlsrN6vn70r9jps/G/fXw3z/toCJPcN1A7X0/ix9CaF+PbYV5HlrrYB8C2SA/KY/zPx4xhql6ByW0/TLpPj5z3vf20b50r8Vn86FyTPhPXxi7A6yc4mZ3jjXNP50qffXwv8TldyEtX1gDjqpNSm5B6BpMkdrzkrAEW6o27S37Htd+wK8mTvypLT073kqwp9usArbqvr8lX9pfdjUfGmBTtUDdo86XfpnT9b9l4yvycDtfiHiuGWfGa7dBjlRXxyS7D8z7XiHdT+B5kzRDr+gYtzCGIe1dNMdcp5p+P9ZkxaIxHFyOP4eYDrOlrqRPMGyR9tSxx6zDG5Ds9rx7xi5Xs+6Lf98/3eObXohX318Y66/lWso/TvnKgp2GNNNC5SY6EWyf5QKSPumNV526//N4/VhNTaT22r0tfXl9Mzr3kfgBPn9zS4a/KDqmfanJOg1q3+FPBbuzc42MPyz9pfMEd+nWP/mX//ObDdLy4nyv35mKfJfOpJ3TnGn7e4KOn4xG+fMMe/aN1/5SepnbU62eHMsLPzi7F4bvvP8Q/U54T+0/uwHBf/m6Rl8pY29LWrsH9Lj4+Kk/DXLnPZXIpJyXjUbeeK+w906m/gUO/givXbI3X8B51hj+884/gTW67/GOY/bO6eFeo6mksRjm+vk3u26jk0nHT9WIfwXN5E/TbrkGTHN3GN20SZTXeLm0Mugjja+GoifXsMCagxD4U9zHO6j39fB2pDe1iHasSPS3Dg9v5lXJFy31zIshVBtovvKBclgT69mLTGF99fb5i/pMsYK1iH3B4g3numyv8I/bXXcBN4UHfvfi8lL4l/fYMHI8xLdSVUv/T2VxVr3ZxPsBzqjrAGWTGJP6zBNfkuXiR8wW6xtSTpminbtyCyVXe0wypJA9qfL5OX8x0/rbLYp7U2w0d95TvekK4JL6pR2ylRIaKba5G7TpdIf6nH+k/ia+q9q17X4hXdx72R93O7fgd/4R2z+b9C7ZWPanLd+avkkr9Y6fP6qQfZeHZMvlNNx7rG3jnuRP/gfYD/4H2A/+B9rj/QCrpq6uok5tx5YXvT/qM18t6kquTm33M6/kZlNV/V1yMS1TVmzGYj+jlGLvIf7fPq24It/xeunX/mahrcPskLyTEPuLk+UJ+MeigVdAHxyRvYRmOXTgnkEfWIItGp7k0ItC+6txmsE5Ku2ozLuifIFdKJuXtCY+MfCZc+ETvDLcOjbWNtPvjYV0AkVtgbVtfOoR+U64VxpJ0GmBlcrJOiQLsM133SV4xfl5m48f50n1qAddXKXOsCxyvwTlk66Da9MA6wPPVsRvbwMdtkSu7S4+sK9XBsU5X40/WVeKT/JN15bE5OAdVci8Bx3OYuD0jUESbOvRUg8AjGX+qqvQfvC+EvT4TUn8CF6xpFvd116qeZLZdicy/ANnu6P3J2poKwPKPzn73R/OLIu1g77TYp/4n61Dgrk2Hf3LOIIvqErf8c/yN80D+aBzT/bW7Hq+JDl0pnP75OCIN4+x+YT1tTQivn3dM24txwLZZzv8WN3nZyfdXYteN/JkCPy7Ml/uPdcv5+zEzoW/9E/E/7t+XSRMY/l251z2rb5PUwt151z6fVQ7yje+6teuxPO7NWB7nRiyPczOWxy2J5THpUvm5gM+ltQ9/Bo/a9e+U6+8d5f3177rq1e8i+VFZ+d5dKMQR3rmbxTzjLtIpnWq/qzQnq0Zb1EVONQLO0CmlpxMeUtXPfLoC9qN3GZEivITi6v1AAdom1jXjMDbEds8UuIZOHZCmdQ0qqWdUw2dp0RRE0J9EtEMLqqnxNvaUEO7HJ+I6+6bLGyHazzTM8biTK1pDXvntOXTDNFRDkVW0+1EaD+u9PV8Sh/Tw+grPa4JoqCY3Npta47aep+JeCudyDwZpDXMiLygawADoKY82ggfmzHVGPF+a7+u01lMpTkbfwUPv9SuHx8/rj9ZaUs+f6A9tMxD7d9Z77d0/WUNiQ6z8ZA3Fd3tqsCL6Q/E+GYEpwXhwp0idvqzfhkb6y/lTXzKuvts3qjrgcpfIIYDjfYETYKyeIWpjPVTOYq80zGVfol8ypw9ACwq4EN/laU8TOcMyefGX13VGN2Ia0z6hTVwb1g13tYoyMJ5ZS6c0uLOcaoo331dB3m0bNNl3oq+pV9eXrglw2DUEU0d6mNrJCY6Xr//x+/UIjSnekQdtPcj7Erqe0Fs8v5t0MKsd9GgfFn2C6w/Rvs7rRI9IceL2nS+rU/QgPSy/s9/s90H4Y4IT6T0H3Pj78/4GvBJ5/gfwyunLN/tf/CG8fj7vY3m81aHFBdh/CGAW2bT/8lheZrjFupNxfqoyNtmPR+tEMANJBFn9AO+Fe2J3z/P64/oOc40FWfkLaFQ1rolQXpvbYMK47ongGn749lgcuVWdwhgB1nj3aM62Qo25XWMtgxPlN8O9a75FnhQGxK9ZqHFtMD5FameEf9gbi763nm/2MWu640drg+jW43kx7qN5MVSlTAdX9Nu1T4rfM5nNWEx8eokOlT9T0KuNuC7nyCb5ccGjMj/IrJGM+rQh2sm4j+ct0QrmLQV5jQz5iLUe0voueXxk9kzsL16SWlJHlaLlk89TP3L++f34Wfa0TkheW2aKPX7juHxKyWCW1ik51y/P6n4EBZsIyAQ0nDOZl9SULKwvi6fVLTWvwVGs15F+nvRfzZ9L6p7cjGU/q5mSvft2lAFeiHdDUhf8VH66XF87e/e7dUtSeKZ1S9zaD+uWFOFzo0bJt8a/VaMkh9XVGiWFOkQXtgjQaUlMm0nt83XTysl5Iv6fzIO+5pP+9hnefae+SPDj+iLFtSB84/4Vsf3E2N/omZ3fw4s6PCfflfkb92U2FvmejaVA50r8a2LdoEW8vzfnhjN6tGaKfX++8LH5LuNTi2OX4hHWOUnx6H5e2KP5Yw/6ef9WPYXCPXi0nkJ2t3+pnsJ3aMVJrnVGCx+qpxD8YT2F4EYNHF6dP1TjJufNd2BX5EVJ74iw0Eu8MbIL8XnBN+nt2Vmf8YeTeg0Pw5j9g/Vcq7Py6JnFtdAerU9yIm89/t5ftd1nZ/1AjB2T1j1M4tbSvOEG1gdNa8Qkuv+JLeuOznZml4j1vUt77g0bz3f7bi5Jv286uVOXcXoP1Nm50tM0IOcGmEjOImgL8lymlUiTlHmNgTXyAAW222gdlKAN8FD38rxGyZSGtZ1mD9RvKt8Pi71bXCqprXRUA/UoRwarCA4jNxzAH1GQI68iz0EnCACfGrUj4EmkndVW+sHZ/Yl9Iu/PycS9dgC+hAeifc0F2AJehENJO8Gv78UEybST9ZBMzzSxt534BO7ZqErGzv1Q1+uYUEU5xj+PEcRa+rSby3h/VBNFNcwL2QJ0s0y2+IWaK8HfqHMfr68YazoBXV+ITOBpA+wZZNFZjwaVLenRYGYy18O1YNwMJsEj85asV8G4bn1kF+BLF/RmWj46FK07lBilctvd+i05v7v5HMiDsBbvvDdCjLe5TlYf4b2jxKUmtqPR4vBt3Rx1zQKPKujImW2gvF9CIM5Vna93RR6e13Zw/9YF2wDiYd5n6OQsTj6P+0NdzEFocWHtcQ8h1TLr2LttKCa48GCtsEflyb9dQ9Kt3eJ7uT/hBzVhgrOaMMGduMO49iNFdx6JTzx9riy2EO1EU9LXymNCtH/UR0a8Xl2K+4ENMTbQUpT+IzUp785XEst4f+wH93JZm1I31jdsBGVrPpffhYMikLirk1ijrsk1tCA590v4XK1Rma7nAf97arPL13ffbr3BvnAu8GRvmdrmCrJ3yF2JU9WwfvTgB7bxyzlI/eePWocm9emjDjtduaRvn//pW5Wd12zvXLi3wz63xL5pvtXaoZ4ANAVtRB9xfiOHNcO/8HPvyMW9ZBfhGnvvubZM8Bx7O6QyQIdJ+oj2uWO63g6d2FPh+bL9dPZ8ZsftLOOYq1qdA9motXMX3Bp7kXvHt6M/4z5kkdsPovDgNnjKjaZjmBt4qLsYMOpesSZ7uVHbu0xlZ9a5cEhqUCthx0rXRM98K1y7ddrRGVM2JGo3akwYO3KoDjupKOEbo9Rp7Iu2hmc3sO+dx04Q3+JanP3S2K+tszRXQ0ndZXbrejWOz6tXd4/axK/UnZkDHEysDQ6wr4C8TXL3ByBndUivIh/0OmrnYp+4pjnrMEDPYOwOPieRvN8d6WOMnwPs4168cA8k7DtoAj4AXpjY1yfZ0wxpP8bEwnupLNfn0tzRqFMWp9h/qyWxD9s4jk6tdVh3CmMthswhIHgXtZkOyAs2y391bTGQm9qyiz0uWcCJhfvlNmr0AM5NbvDL4YwzOky2/s0w6RfbsUj8b9Axpz3XOKiAs5Vuwx0rczU/w7gvHjxLT4GPRqM66PnWIQSZPyxfezXBBy72vRTP7f8B3ElNuVmy5lptBzoV3D93N8SeZEt5Jy+dHch1Y09aVz1L3fuSVwG5fQ7y68JdbAK5YX7gfZElf9uh1V1+5+l0PZsEtzeWwIW6yG/ye5LBf+OQuCM4K0ucD1ml0mHbGJcw9QAOpfd9kZwlhX6lSoo32+G+tjNJn115N5JAl0G6z6xowAngidwS+OCmw/grX5rSzoxDeWPr1+n8nrPY53qDn0cdhvTwnsE88HyItAttFtjvI1lPa5fhFpvd5V0aZwnPl911uM+5nPb/mVblPb32RfjDT+OFnUT4y/uA/C3X0p82+f8W/FvZtZpA/qovevD8vo7Py/tanY8fxb9rFL4vTsig+H/9fU1YvdQm8L980Id/2vvCHzyeY2dxce+2hfOtuR/DkfD+/t55EobKelsZetv1sT7uHbof2oBivt4cbWRtq7PlauuM+nVV/9yEjaVZmdfM948O39cXn7Xdmzf4OLIVaj4CbOlVp5OX3udS4J+NrruvOsZgdtDmu49WrTfXnmrvry9Pvll53281U28+vw6rIh/VGavT632+S4Onw/ztyxnzfvDOUIdhrbeuLJ8oO9C0ijgZb2xnKu5aKs1s397YSZ22qvaLu+rWguGX9tTXPt87nx8vozDkh0d33Vz2tpbcWS3lBi3Cve1vV/SL2a8Igzrbe+1MXxn7xa/PnA+uO6U8iZkqu7b91fXU/vB9TW+5tWBVxHU4U6vS57wpUlNqyj0fJvbHhuoPdmPf+lRq1mSk26NXv8ua3Go8WGvbQJ07LtOkh349tERlsNpt2UV1+rF1m1XpFQT5efdr98lxBvu63rpf+pz9HFSFXt3cvA/FEdsSXo/1T1+kNcd9fnqtK/7m481reYGh9dVNoG9ZftFSl6w3FzvPc0HmvJFhjhbvFcMadSaVaNjehNK2+mSPe5XJMnreVLq1Wnd8aHzoFUmd+c+LkatMO4pEMZ+vH17vS34ye27ffutt5wte3q6N9cRZtJ+0Nrc4tp/MJ/m5Zg7rbzXL9ED8eN/P397G4WItdr+EV0qtzw1xLgy0hsOtDod36jBo9Sje5J3+lxMtX/SpU5cn7sLxnneO2m9XKZvve9Jg/uyOX0fPpv1s1ReTUdCKtN2We/rYGpOoPft4a3dBddu21NdVyG7aC7l7rI5YVxkPAByBu+8Eyvum8TSJlFqtUnt+6pj7zqtLUeuxs+uOxI/h4dVma0/dTvD5NOA/3set3YFq0eETK31GzxSg/IJ7F3xhNdW4d8oXts68yk4WrZ3t6OuP2aJGsdX2UmPl976KjYYWs6n69NzraavGYjnzzO54sN/Sw0Z9zXIV1YTL/OzN3jvU9G1hapvVRzSfLD+OQ+ft/Xk69T9X7fnrUNAb7S671/t09bA7zmrWl2U6a31wmMvHSh1UsOlq/LZ60d9mymw43Y4bUd2s62uBa60d4bWvNyKzovaG2+roYH76vKbPhK0BNPOlu+kfnf7TRllMIyvsd4ez535tLm+eFXq6HDzPQiMcPr9Im0ND1DgKiONLi6Wmh8rhw133KwHNT0W1HfhdPZDUp7192Pb2xlugzNzPhcg+zVbbnfD61fgYVqfjrfri7OrqSDN7m1c2cOSvVfXtaVF/bwdarTUzax5L7buv3alan+wP+0k1ovzPtuk8r2Vd0haGTenHT6Fel4+yN3955T9W82jat4/L9laRlVfT3bwzvEYvqO4X/axtfJ2JPt79p+n76tMK1i2+W9sx4+B95rXoY/PYeqo5QDleX+Rxb8cx872tT2ahQg874uBp0uvL6kYZ9wLzYDb37cPB+3Qq743FQZ68Td/6tDDamDD9i9z1jI8VK7Vntv40fz70QVV4o7x6JbCmM705Pc73DYqjDLEy+Pga2OsnZ78Wui+v75MqtXcqwqTprna98IuV67uxbR6amtnmaUnebFQh6tLNr5cWV619upWDZD6pTEXoq9am19Zt6cnq06D/Sb3ZZCMolvX81lDtt+FwuZk36Wbt463TrD7rL2F92NsunV4U0q3RR33xXh/rTYGtT56k6tNL5X1mOC9vLidUTe/JENdTN1y21Xfu3Ru8bNtAUZb1oBZMQqcmjp7o9+CNqVdNilY3z7PgGGj+ccx5n/rLbLOghFrfWwXi15dpMKPJ/mlzCClTFF+olrYfud0Dtaw567e9x3I106j5zGp1HFUW0rF1rNcXQrinpZ3ku+1F5NaCJjXa66bTG45Yv1Ln27y4Edbq21PzvW1On3V6Uh9KQmO4ldWnbftzZ9YW87XX1V73XNi2RxOG3kTMqj/7ctSwJb9/vCp16utQdcXJQgzol1kgsi1+vHr7WI6kfWR6U9Bao7kSSU/PViscisOnaD0Uekz0/NytPEnqy/6t3WpUj4u2s592l2J/IDWW1K77UQVRwJmyelMGgex9dhhW7LqzmJjOePX1srWl4GNDH7arGbB6R3/3ex+G/bw6bP2eLBzfWyE9OrxPVlu91qkOxk7DH7kTTeDo1n73yjj+/rn9OQqoZWuy/pjOope61FY/OXlnV7avx83yK2L6M06iF/RxNeBe+t0n+bB66oxHbqXz0hHdUUip2tp5akYjWQ6Przuq2Zu1W/LcDw6a/h7S68arQ9Xs1dPnYNgbtvpTyrJmRn86e52q/HbdY4ZfjmGvJ/3t2H8edCvNXr37PGeP73X7Q39/epqb7++M99V64gSTkfb6V+vVHTe1aP48722f6u8dW1q/z2TvWGk4k5djU5hTjj1obrWnhkZVhkz42uqPj5PgddWu7fuzty/P47z1xGxao+mu3+A4vrvhFm/rV6HbEJph1fXnwroib4RIor6eZz172FmJtWi1dx1pX5nOmr0Xc86awaZdZdSn/mS84K0tO9an2/lKeRHaSutjtZypvNFlh81Pc2u/H5RPczyuPA2Flqj2zLV9aL2E3Ul1ONwZ6vvbzrZeh12aXQ1ehca2ow3VQe8t6jcM5/jJvn9KkTZ32y8vBjXot8SNXlXlr1bAfTXXjYbxLCw2tSr9sulKrelLX+5sFOkreH2fj5aN9nvU7b7JMvX09QJyVUMMmvy7KFaiyYySjHGnP7CkxSpcf7mj4ccyOH7VR8/Sa+djo78oy31zWx3O4TJHXmsFctKXO+9sraVY87bPT73Oq9rTNu7rl2dolf5K0MNXUKCWq4HU/Gr5r2ptJ33UeNecVl98Tx1P3xfuQK2tpOr6k3viPaPTHn3Kw+7y83UyHHTVJrWTNf11Li0mH9VR03p5nljzavBJbT8bq+evft0BuLZetC49rmkdT3yxpt327ktTHWA8ny1+0X5+CWcDij0M5eHRbvY+jgNj4u6P9E5vc89rT9k9c6YTSFN+MHlhGhVLnU/2H7XKjqdN3txhZuxyIIvM2zLaPQHb6BkLYf3sGy1z90nb8822ErQ+9Pl0/MkunIk54vZD3ncsl1X8LaW7++3sk/afe9LHdrwZj0cs/fY55hwmtIRo9vL+CSzc1qjevl8ZveshrX/6Kvu663rOnNdsr/U0VH2tY3GHtjt9ccbUehXpFbrWrkzZZq1J1yur1br2Ksiy8NxqeNq+3uQCfzeTnpYOVX8S9N1e72yV7lH3lKnYeD0ee43WTH6bz9la5ZWb1WeGvFxqn/1Zi3oL3CdjvneNhtvQ2LZtmxwc2GijWl6jN7TGrUlUb4vm8Ljk1GZvw0fVJwYo2dtzxaA/u08da+vwq43Xbb/Md+8LZanVvqynnTuqWq0OU/985xevm2NnJXWW3XBxiLpvwMVrrffFasRUDk8vH+96ne2/PoPKs1rsdXs2n0ktxz32nZfDGmTb2oxvtM2h7FLNTWdZnamAwKOXZ4XiA5PrzYXaerederWQ/hjsPHvKr1av48asOWrz1quxWnrHl2lNUKOgX1l+NVRuNp5X5l1nBdLOhxyKA956Zl/4qf8C+kJdBs0PFKd286lh8dLRfm82m1qwWL4a3NHVLLdds0AuG/W12o577Vu81tiFodKR9PFKVTaV0DSFXX38PtQ67nLn1IJQ6x3qg/f6whh4VXG/HczEj14QjsNqYPjKWua2lZr8Iep7RVu6H93J3o7cz460qIq7jr/pPb+70tv2TWQbNbfT3Ewb4aghUL3pF/20qcg1FdWlWHWCvzvx35Pafz///fz389/Pfz///fz389/Pfz///fz389/Pfz///fz389/Pfz///fxvfhq9py37RAIGiK0qjiWQ0YQl1Wz4U4w/gR8+wP/DgARSd0U1fNEKzL6+vza28L2lkPFrH/yejG9o5tQoeyoZul76VWJq48leyOtW9rXIjX3JrPin72CNAdES1dOV85Nk/fX9Id0HX3NS+JzOerkUUo+uac68ImwwV0EwHfMU/jUWx8fplVon/XSv7Pk49qP4MxHSjxrF9TMYi6mMh5ZJDaTDyovrdlzCr934gHkI/LgsJKSuvuD8+wfOB2PIGG6L49+DX9DF9QsEX/h9Nv8a5n8IKUjcVBKvegd+k7d9Ar8OpaWfVnoynyJ0/tMqQ6cxiadcKpSb1hBsXoHfe00E/OLjkTL4TXi19ZiJN6t9p9I2S+o0Hl3LLYXfvjapJ/jX59MPZZg2mf8B+MV7aZhjb2Euhk2F8sIy+PGTBq5fJaDMxnZqVP0SfrVy+CV1+xSTW5AcJYkOyvFv0k3Xb2VnUXcakx/Aj8nrk5bB741cSiEjKuSnBxualNGN2/BL+pFQWIu/BH6GkMKvmW/C5IV6Ob6V4V/x/mIdC6Mc/+S9lsIvmqxT/JfJ/Oc/k3vwU6ZenOdUCr8lTyXwA1RMv2rv/Z/AzyOxb2/X7q/cnCTwq+dEKOIrj8Mvxz9qZPOhd41/9CajFH79fP5K89v4R+oDZ7WBy+Cn8m8p/IwCOxx/G35YN5jUDFavwI83mvvs/hbw7+0n8MNckeNIvQK/1n6cwi/fRF0m8z8IvyHT/nSAtg8l7J9EaraUwi/M4TfO6Yc6LpmnfgV+O2exmtsMHfrSlOBFOfzqUQa/+kfGm9aHt5Jxr/AP1tyS3FORW2EvoWT+S/h1a/Mcfk7Gv1rfgJ9rTcfusk1oxC3++1IPUvrXEtKvupMVzNM4GxVkDv7jfCqJyCPID/JaXCrFdQ1areXyVwwutUT+KnD5RsLQ0qugJvBZDln1Yn9J7aaGTlX19JzUWnI+3Um7cJfqtYuwVoRp4+0afz/Dj7gGItZMC5UYmN1pOz0foZaCpPHRR/q6/wl+oyymlcLvSZRT+OWw7031kvM5BfE5frNxfPRQCiO/HH4TM4VfAaNboloCv9v8aRDXkyE4Xgo/gTcu6QNfI/M/gt+EVTdQxsnO5+KqTzL5v8DqWieqQY5v8umlLZ4PU438dH/kfITzq56eTy6/xvM3HqTfyfko4bDZDt2lnOP36Wm2pin9UfKx6y2v5HyM2qX0l59PzGcxB8ONSuGnzN5z/M6upzObXOI3smLhHn6zuC+lFH4vrY9Ufs1Pvkvm/x5+M5hbKZzSh5On661ZCr+CTjhrrb+B34U5zujDKfzqSgq/SS0VKxvqHOjDQ0I56k9LJbqYvwR+RttL4ZfosleVav6a/jRk6A3Wl7ugryfjNdRlSh8uRpIf0efdTJ7CmphC2O1TptA31cJVbOUnPMmGrqf87ykbVyjbD4UwEFJWMqm3upPYPhFrK/XWE+CvkfNnwljlHsiv7y3cQIWCyd67+MQ6swwkWirq220idhL838PfdesRtceQvUatEVyV5YgoVs+BiDlI3gz7x7R2bjNcu/mjQ8JvyfanNWsv2+sGLa9eh69P1fD5+bg/5kQshROeaWuQ/J3cp2aXr3+U3aUPXAgZX+n3S/Ymx6IJUQULpJuXCaTUGuYcHjvY24esv4155ZRrUVt1Vg1GFnw+KRJd3sn2Q1bNfzWX1Dv8sqnVufTdnS6FmB9/HPU5CfOMXJv0Woo6WEdD2Kz8enWRf77emQvz6DEh8HF5px45rCPWGdhqtn7vcv31hLLsDBZ4o2RuOhSsFWQnbxnsNCJDmSzm33vxeHldshBzotwVyQVbuEfM+fQx7/7IWZhfhzmw+E7nrOaHwZhHfxFi3mV8KHEujlPE+89JDJcO5nizWjjsc/IAc4HtdrVDFeZiMXdTPDoLbnt7DaDHLdq74SSD/8cp/PGPQCV4/RD8L/N978x/8XyGlNL5/uX6l+oRtH1s/6f9uB9YRxP2sh9I4bxgdyP4MbjAj8Y7/zh+kN6ihfPduoXvO7SLOceYew3wE+J1mzkOnQol8SIuzweIU/+R8zmpq3BjHfLupDbB5Nr9LNDdh/Ajrp3WN95uwiCpPdjW99fuZ0LnH4O/7qCsYVUbgAukpg32S7mJD7QyB3wIh0Fm50jpRa6UNC7vZzWBR5Feg2w9I3LPscp3FloV/z5VOuox/yvsj1fdYf2Sfib5roSOJj1FROvknC5oagw/9RJ+6c+d8fFeGFvkObCXXL+Lrcln+989L9CWerb/xGZE4JDYP8h9UG0zGFhvhbH3mX+giF9ubBdD/KI9NoZnJ7E5kHUvr/X2qZyuG/ff4msX+DtpfWP8GH8L50jOrwS+Uoqf9+FrKn1Daxdxoxy+hsRM9g/DV7cQvsI5fM/3X38X1/wj+9ck8Yh2ijMcvoZflcf2n9fSub//dKK7+2/rFJEBTu9C+fnX1Wbrof0DPCnH2p/fhWvn//7Y/uOeQOd04cr++c1efmT/J/2ysrGv4X8s/d7dv2GbQFu1F3IP+hls5XyEAv2qtTcE3e7tX8RcfdI/20AbW9/SQlLnh9ThkB+5v13gfw+t3xL5Rgn9lTP9o4w+3l0/qUE6B54CenN1Pupf0F+CHxfy8WxC8Y+ML3HR3fPjvYf2D/Lvxq2X84f+Df76AP3K5abjxfgeDtnKjSqX42Wa6L5GPFQpfxX49ZARsSbFGGtYDQrH0sQrEfOFWD86k6WBhzsOwwWAp8C/a7u4phD22JOx7gfjWocd+s86tLYbMof5QBJXqBtYkrJzJVPAujO+daA6y+kczgBgqnxgXe6Se7dRZhXYT1LDInNVpRBsOKhfEn9VPcgoGNEv4x8/k6CkOk3cTo/YCv/lP0+L0evneDquDZaMuX9fccJb43NMv/LvS662l7S3vWx87oxGbfDF1Pb1T8QRKqweam2dxb+lD378JEzmam+5qu1nnwJA6I2vWWoPYDh/tl5UuRaoE67WFlqv9rGv1ITWsfpWr7WbH7VD/1O3hVoohDheBcd7UmX+M5g0YbwJfl9RZRt0Kb7HuRV3Iq3Gz5X6p6bytV7d6Ae9aqWG66PlWlsDNGvEfwemgn+30r8/NuTvNvxN1j+nW7W2Cmo0369M6jUjDCOYn8L54Xnrcys0xMEH3LW64YCY8zSqNYSXz+favqk92xvhc6z11BeAF/W+ehI5/nO8Wh4G81qNfrae9zJPjV0b4EnpAM9n0PI/x2wD9kvGB3i2PicTWH+t1TQa1XpNhPEnzVpvCeOT9fI4f+1z5Xtq3eAAfp/bFr6fwsP8XChHWC+TrNf8nPHx+qlGdQP4rLiAuh2dPO+DjhoiaeO15+dJfUXg8aXA86pRazX6BB5LtV7rhZMGwOcF0PxJDXB9K1zfuwrr09/4eneHPgID9t8g+//E/Usr3G/g1Ro2N+x6k7oR759+rb0suf2+rr0IcP5e9PxcHX+IFI4v1Db/x9p7tSnKRGvDP8gDM+phEQVMiPnMCIgKmGj99d+6q4C2Z3qeb+99vSdzDQ1ChRXuFYuJ+TvTUZMRDm0b/dB50n7T840p6MX0ab4ayVB3cKHxD72LY4cH+v4Xk43DOdDGl2aEGMHUcTQWKl1PWXUDeDOdhDXCvUzrpckj2j8+P1LQ3qDX2VeGn+PN9rPYn8ih719H5fKp5C2IfiPmKRWkMYSInVtdH+83t0wKp86T1vuI9YfHqs182SlfPPOX8WsYv0ISRt14Ms0ftoKuaaR2md9g53GD9uum2d6Q9hffr79vtF8M68NcbdQU691WCVwL+mr31cr+dlXm9dhM43tJv7HSYbdRbdBbDfQ2TA41lTW7b/Y1Tzoe0c+f9LYOVOPp+Yr5dNk+ubfP2uN9sOXeo/6SFFqffW9w3JmKM6q/9ge+Hm/iR1NJlUqD3zeObKUfhynRZ2VA9KvQNa3P1z5ZYvxD4h8p+eL0m+L7q1fO30R/i+R4B73WcL9L96WS1mO6w8ezdGk8ofF8j3pRhPUEP3o9Vh5YNJLSQlLoe3PPAn3z+y6NZxq2QP99Wl8xPvq+HVsYH/HLlFjpK+fvFm3LabRUmX3l/GGCPwZfuH9gnnpdOh6bEQ0Q/5bLKfGLnc3X0nt4H6enW9rK32dweeer2H9Ov2u+//R894j3N+n56VUX/Irxnek+yRM9iXzQx4uPZ5uNZ52sLyY7WdseUydET4Z438TB9/79/rjzyvm/EWTvt2MZ779ffs533qX360uL3h/FFf0uJR222TPaP23F1wvzHW/pe076b/7C8/oBz8O01ofYf22A69+fV7B+c9yHr1Ef8u9pxfccE/OL4KMmfrqHTiCzgTYlM+p1Vxqcnpgdecwh7umzIT1P/Ewykebn1Gk+oz7dj6Mgurq2GcTt5Bi9yrZpP44vd5+YleRsJk/T8kYoYndYsidRNzBNNrq+lO6Uha7vsHVYpqk0uby9gV7dyKteGwrNp62EO5IHMSP+GaWaKUmaTvTKnDnbm1Pd64aWvJSbR1zT7yekj1qThPixUos71Xuf9OsG+tGsxHfpdbc2hzL4k/OzxB3fntyLNdNz1DG9WL5Fywethw/6Mrn8UZkaawqX1ynttz/Dfr9xf20mdiUIzORgR1L/+QqUa9QOL0kwsOPApvkt1U478EJmXyLWUF2FqVI7+GO+8Qnv4/T2UCNab+ynURuSPCfJXdZbM/BH2UlH47IKeXO/KvaluUzPNL+bDX2gkLzfp6+47PTV8NAn/XmVQG8kf+TkCfqOluB3jyyQgaaCfn2Hvsc8l01JRpF8buL+TO6w0tKzIX+JGiqZfv/i9E/yhfh5ngTjLtGnT9izFshN0lcIfd7YcqrExqwqJzv560M/LpNb9euH/Hlw/OLh+wr4bQh+uYb4vs3leXfH+Zn4kfOPTWaBulwptP6GQ+v3oOel6wbP8/df/Wx82fNaBH3LOL2arE/yCNF3v6EmY8MFPRvQT1Poyzbk48Pj0Xlr2+8A4Y8cIa+jKfAKyeuDA/zBVK/XsMHv5yBg6vmUfX+SnK3+x3wniX+n/RzL+L65xvcJ0/Zk2vrHmK9nkkq0fgz09DhGOf+QflNTc8/icAqzEPD2xfVTRTNTOTbqoIcGl+dk3IxkZab1mjleovHVNmk+H8i35Ht8169UrM8w8SDv6EWeblpYTwXreQxlxb7m/B8J/u/WXsuLq4dEv75L9GzRuC+vgXGx2xcnkQ4mcgCnfD6xTuvvfOwP6f+VwfWPxB2unjzK+GsHfjm64JcK+OUEfjltwC818Ise4Xtb2dn0dj2H6w/48rk+Tpk0RrpeBfSqWze8n8/3OF4yO2wumBGPGmicNIW85fRMv18CP2vSlfDHi/B1p5eQvnYT4p/KOS7V7jSWtEXygfhrOE7Z4FANaP8HTPanI7G+R9CvS9BDmZb4+jPHlKUprk0n6FUeWnI99OTj9v1q7OuP9sNXuTPu65EsPYnGa3rlQ6/CvpKEPVvQ53VndOL4xuT0XuAbh+ObVXT/xDcVjm/OJB+6wDfyJ75ZYz8N4Jt1xas+GzReWkzICwcxNxof5GehD5wCn620N6cnPO9D/xIedVTnpMVq6XA5MPtsli+tScdrs9LqEBxWvUh2lGrJi1lpTDs6sOdKaLuLtL+RXiQg9fGc5lOVGN1ftFVl+CAikqcBa2yClI1JnvSxH4d0y277pcz0SZvzC/bnPAN9NjP+2SYe6Gnckknf1g718gCuTnnC15PjiYdO+G9cpvtfq3KrPEMG1uCT/liPvjcr5MPT4vSvkn5uk9gX8iYacXn4JPla4td8fI10ICd7k+yf86xcbi+QUVG1yF4adb0odteNc5v4NQJ9jXC/XOkrFZLHMpfHc8hjA/JY5vI4gDxWwkMI+Ub22jApsb6SPPuFPdfANewN6XouP0uL2dhjd5I3dL8F/FjyBD/T/QfojfPb7Z7xc5K8Fgz4FvTme7ReH/I8wPMIpWfy3NRyef5Ypbm8bEBfelUD9phWyPNQJflACvq8YcaJJeOlRevRwPu+5ct1xcdjEt45zLL3ucm7TuPR26oxfNJ/DhIs9hmtt0FCmn/Po/14kH6SIk6/9zmtp8nlO8efDvBwZNyBPz2BPycCf4J/zsnqWQf/HGg8BECUyjd/hCrod/kaK7AXod/4egSkv7cOyYues+X2CHH4g2F/n//mXy+z94YJYdJO5emoxjoelQ+Ef1kH+HfE7TuMbwl8GDaB/7rAf1gPjn+j5tDJ8G+0e+Z4tW4U9MPXS4P93YtBzweyP6+R02AzRehn9mM/7R7GOxzT912vB/mR6edVEnWy9Q+Evc7Hm1THDvAgzTfAeoVIReoxQ6f93A7o9z7eh/x07Kdhx3su37JrXYrLGb2xcJXT25nsWdrWUXiAf4Dvj0Pf9ypNjpfo/ryG+YWYn4/xXH/M95wAdp3kyAa+xu+Vdyj4MYnD7HsL0qfFfEb1gl87uA9UrPPreFPQ36Ka/re8U2g/dWMo5ME8OcmFPuxhPkOu/03PlcaKSfQ0dkj/2Kce+y/9Y1YKfjgHdnA3o8C+vJLhsdeOvEQaWZYUHd1kGSRt78zKB5MMZiVGBKvieaz0NE3JUca2zuRkUiLVe6mCPu6Y74jrKz4+sj9NyJOxdKnPK+u4NB/oCcmbsQ19ZWf6SsP4Cns2zOxZ0I+h0vrCtSiL/TMXYj1pPdRi/bZmI5cHRvZ9Q7pGkG+5/u5bQn8bHuHjC/0pw8eM668/8PGz88zl+f8cH4embBb4OPqBj6NBIa/KkBdD+IOua+AdTi/P0zOnl+q5nePJKb+P+a08zK+K+acj4OmKOu71ymmqjjvbNoO/jSWXmpqqzfKS+8ug/z/9QyobXfSpF8Tpl9lNtpotJxfWy/1Z4eCR2wM60V+lN5+PRxfO78Ma4c2RA/pnLj1vZutlrGi9SF45sa+VIC/W190wp7cH5hfdN6SfU3OJbmQq8a+N512/ykpTUsWj04E5F7KXIV89vD9gqZHwbBt6fxf+gDQA/SjJYTFy7HOnVBm65TbklZ8SPj5hfZ7OQLs9yR7addut1IhLjy09fzww6VJ9py78GaTPlk+af8cDXufy1oM9ZsIek4gUSrv47NqX7Sbcx1XDMpLd9AH7QeP+pj7pE+It3ZwU/OKfPNrf7YZAr+F7+f0Bl0e/3UdcYyArbeU1Rj5PxXTSHsdX8wwP9EEPJ9gnHdq40nhK8tK6DLn/zmT3vmzD/vuml84z539OT31m0P1I4f4hmt+f9mZJGxFeqeB7tJ4G1pP4r1GvDGm9drRe76ezLtZXRpZBt7Ph9pJUK+iVf79eXbLSltW4f4v2k+1maml6h/wnUM4qqbqCfC/w5xj0bOmPXH+QJPK6cRXXB5vTE+mvmxpdD5Z37bdeS7t1a0fdG8kj/72uv7z9e9B+dB/lg1Xb5Hj5ZikCn7pC/1++Hpw/cvvlCH5yZ8xhVYLMrDTry8KfOUyOZ75eZ6KHiSH8u5Pkbj1z/d/DfZ4/Ka5tzJ+REDLKzPOMe6rQ+7YDPG9aoaCP+8CRaP1Z6injdGqycBfV6f6EbI8mLT/Xp+D3gfAnTZLAL/iN7//l9PjwH5O9A3w4YQ69r0ZUd0IOrjphLr0vMP4H+13RNKYL/2wE+/v1q3zl49WPHs1PyIvrlGQem7HHEvoeycyKo6gaKTZ5zUYhUbESS+wu/LuDP/27D7IX5anwF6pOSKBIk+TX/4jeFrs7k90H5EXBz4PuW4E8W9zo+eVI8K/yC/9uiX/7CuGht/dVbix12p/dEtc1XO/0BvHfCvTpB+E5nsF/PER8ILRAv/aY5JEbkjwKy8w5Xk2aNs+HhndYXY+5v/U/nmeQX9nzFeUxFvKqT/jmQ17NaD1lV/ueXxvyiuSTkfn3lwvML/11fiSftj7iISbZL+NuO2TtLfZX0IPF9YnQ/2ySZPq/T/rfPNnpf+l/u4LxcPx0O0bBzooS0mdrdmWk773yQOj7F9vn+j6a/LBPoxbkQcpW0C+9f60Px4OjasuBPK4Y8fNwV0PMf0VoXS7PX/ov8mQBfnbZb/JkB33Ut+4/5Mmtef/fyxP7smH/kCdJ9f5Dnpxj8OfEpvV+pibbzh2Sx1cez+D2yHn8gD+kyWS6bcpXJ8zkxzB5zBt/y5snl3/CnyruJ8TPb+zHS1kJfd2bTIeQH32SH1tdYZZmQ35Uvuj+VlY4vqb3K8ct929qUrws5CPiT3YS4zrHxyR/fK6PIY+ckOQTlAytr0b8suHyiMlcnv2Lv5+kj+UpinwryaVc/tr6tF/w91jcP2TJSqQGYz7e6bLO5Qftp2JXNdKPutM71/F9het378teddmc1kMnlJv8B/0AD8+4/zliFYuIQh562+dv9GQkG/hz5hWyRwQ+8ggfEX/JxF+Ij3WcX/mrj/Wk/Tx3Mb6q3gQ9cvnK/iVfJaJdfdLZF98vwR8n6BnfH3E8UpsR/uhobZ3HQxOBP2h/lCweyunX5uPpzoS/cJ608HuTGUx1BD8siR/gj19fI+xnv1bh+BbrQQhsP8K1oplBpydLdv21XL+H7bPxaI1spWVeXfNWI3u0d3sfekHrWX9hvty/v05uJbLXefzvIYPeI/gXXiRG7sNv+/OkLoH/Pu2laRI7NWEvEb+c0xwfcnoU4+sX9uEa/NptK6zbfcvN9lrgWa2W4xfQg678G//X8H3kAOiIv63h/6L1XC1gP6S0ntx+eHaw3g3oi04V+mI8Ytx/4cJ/IWf+ZFpvO+HxUe8vfEz0kcmffVUt8fiAfdxwe8tjA7IMgo7F7OT9Mo36sJ2wfmNkyo3R262dbz/iI9y//Kje8vg2t9diyKexbEdv15zXHu1E63+Nej7iZWlU61cevfv1aSqILwh8B/sp6vYEP8+SK4GK3rQG/8I9ON/ax82A9rPcTZnw79Hwy4MeW6cZ/nyYh4947yK5dW4//NfRgMbjNmSPVSW5w4Zzz4A9C/uEbdV25WpdC/7tz0gemMDripwqlU7mz9Ft4Q/5Mor957/fnmn/DSM5Dmz5un6/lkuiR68btp5m8F7WXe/xurcf5jAdmUok5jvN/JvrHsvmS5iZ5GfE8QfTWp/xnLob5vEcxvfrj3jOxijoz5TMi7u2yX49ezZ9z4pov3j8ZutpefzmT/u1Dfot9L2S/qrvR7k/FvzdUeGPdZJLA3isXMnjw8su6If733r/A3ut95e9NnW9STOtLLXS1lLk0UUe4VqNIE8x3zf2O9UadB2wRfloTum+ouiIZyBfgiFf4gZ50pfnMvIpCA/qtRuu13RNNku58dLxe8+HPBwRvmDDajtMdpAHbOlNhH346CS4XuH9pnwo9f0EvzcxXrVC41fvB8veYb6p0cjGZ0/WuT/fn9L8lOopnDS5Poru11x/p11TK5FUJ34k9XIeIxnuptlLsj99yMPeZJntt/AnHOZ8/DWsx57GIzlkLzkRvV+2sX6uR/Ofkb7a333gUYll+Q/riKcAgu+BxxUb+2fHnW2HJZt6y2lif5SxT/uv98bEL26HVdwX4Tetsn9clVo9jtKve3nYHiSH60Wl/a6nJfp928F+arSfR7Gf2l/7iXj5yFOuy7frRTXQ/yAd9bZOiP1saqVxm7HHg+MJxSb+i+F/fvKaXeLfbeINgce4v7Fh3BBPGjB1w7b0++o01kq7rTQenVRBb9AnMiG1rszjMS5rhm47hn+0a2b5Kncf8+PxXb1yy/n3Dftb0aRh5REMrs9etNm+X5JZv7e9kJV3uf+H9of5vvMkfUi/tx3Chvvz7TjoWeB3123121H4aB3MKCb719YUeXo7D44D00I+AOk7Mwm8LRudIxYaMfTrTQlP9D7aIDdWFGkwjbx+1DXjiM1jxaD1CLwK8YMJvOZB3zCxvgrhwWXXZA/n/DgOLOua0PvnJJ/P+L4VxV4QS/3aoHL2htHINJf0/bUGe6B/zfGdWC/VU5rFeknhYRnBnl0QPtnNRP6ObsfSIMfLEeKHmf3G42EzWk9aCMgjg9nhVkMPAd9Rz2OJQCzZz0Ma/5vR+1KD9ns3Doi+JzPaPwX8KfyD3U0e7/Jm9xyPJeZgWWIh5vsHHrv57xyPER4iI7L6ripxadAZgT7JKG63KrVYWg/6G6Jft1bL7RFN2Pfrugp58FI77dDG/gU9wg/puW62A7vfOvTkgj73fUJ52oGMjOuSfjtD6WzpwelT5vHE8RXrJaeslnYtzM8eZ/sVyDH898CzuTw/fcrzr8D7T3k+m6dFfN42j25gnuP2w++9Rna0flxf0sQkNuX+t4gtZVdxbLJXQm6vMCdI/pTvNbwPpU7yhI1pfkv31a9ExuB6MP2A6J3diN587n9Zkr07vdO23kccP7AN+M3A/GbzMdmXmzyecYW8mHD8dgN9cvv8HHnVYyOj75/4sd3VhD9mmFwPZJ9Lvf5xZysb+/gyI7JPInPQGPVWv8qHIY3vmMkHj8uHVeKNCvlgAI8otCnqLlCjuhtF0iPHf2/CG7WQxk8m83gU8v30sJ+Ecco768DS4xVJGzPaDyOJSAfVXb6/Xgw8wP7Y38mQxrfBeppsTfM9lD071mp0bTku4YV3wS+BkO9LloxT+l6bdNRwpU9s5Mcx4scFzx+7wl9bnZA8W3p4H/PpfbS+ZuINvvmLsf43fyXjMeiHaV3ChwHm34J+UxEvMXl+TI/I4mQEw+Od7Fe79QpsyCcP+M1q5HhgMib6OJcHub100o0f/P2Avsq+P2S9/Psmfb+H7yO+Pzpz/h4jHte2DJLHXs8keW+SvA8U6z3qEVEnY46v/LEN/9Ek7DZt2RH5bD2Rz4Z8oJvsXZznhaV+jdbLtLN46RH+4S/sx6MJ+eVptB8vDfL/UUL8yCD6Sr/67N5XJLpWdLomjKhINdgr4zKZpwiSi/3N4le3eYT9c5FfdsV4DSlpR+zxHtns+ni/0iPR34zob5jRH1M7ldO3fkorRA9E46Qf+PsiEutE/5NCP/HxpaSfQj3jl02SfH2vpwZPab6e53HrtcV+zvP9PEPfGRrw/8LN7Vvkg6yjSDWbrmJIjy3iE5m/wub6SZmND6cq8Ie4NppO+XTDNdkDu+RyKuS/uN+16P75+/7g+hHPnZH9j/HC3kV8uxe6JvCG0lBeY46P4kYljyfweNbdIn07kYrrk9gvxDvhyquE2u3j/etsPByvV4BvEG9cx82+l+dv8uvXOs3jp7vrh74p6DGl9bth/UY0bcJnV7I3XFsi+vPv76cVwd5o2KaS7I+D486K1ER9kX7ttB/enp4f2fn3Mn5tsEfGr5o3jI3Agn3hQh8G0Bcm1/cK5yfStz0v8ua/6/uHVyP+MKek70vakn7vu7J04XjOOE5/2IuTbP5k//hj79N/ESuYf4ZvPCXHN1PCN8vpBf4i4OkT7PlVvVT+OnD6O0IewL4cCPsyJdOinfk/wY/W0QGe4PoAz/uQn8L/y6+9WrYfUpTg+5LwX8ja6jPfSrt8xpMqf+Vbydd/5VutlWPUjs5WsMvWC/LI8XRPt6Xys71o2NBP7JGMTKbeWq+qBvltkvw+kfxWM/l9JPq3D8zL5Dfj9iDP7+Py+7kCPaK2JJffkE/rjJ42iacX9Gc6r+HU04aEv5QlyUdOr97ywMePfNDdopzF96tcf72I3/WpRvqd3xf2nEX2gnvB+Dsa7ceS3cke9N6Ez5aM9BtxduvZU7l+g3zZaw9m6Xw+HF90Sd7sP/CF4Cf0GqhVaeGBxwzpelh7GT8EWv94MmU1kV/snOvvXtjl9KwV+hv72YM8Ma+gD26fV96xJvDd1cnet0ge4fXDH79IkhjzaWE+PL6cyR/Yh8ya6aW1nuT8PkxJnhhGyymfF3gflyfJOPnwJy65f066jtaIV3N+4/Jffop8nRnsFWOd9Irfx37yoY8QL09yvHGE/Nb7Nq3/DPiklq2PLiUxfi/x93H+WaxZhi+jAf3eycZ/0kuL8ff16qSKa/G9tEv23Fa9kbxg1+T9amhkzz+UO+2f6fnET8tav0I2V5nwBfTTq0L6sO+RPjpHyPdlfD0GU+gzywvoeXOV20c8f7vIb7DPGK9J0njQN8+uekI91PRP/O4puFaGZJ949o3wqlm/tW8DhfCIMqL5k30ehlxfkf1H9HNImSyhQg2BTdInKyMEPhrn+umF9eP8Haf4Pqf3sxPn9D7bTsr3rUz8EvrQN8yRvK1nEd7qcfrfjhtcfunreJaWS1VefyD8N2vI0wbyHTdT94M/VsmZoE4mn7j+hf/eYmbqDoX/ntbH2ZgWi7L8tiC0Dq1ebCJfUusr8N8Z3P+yJ3vYE/aDFPcxfn5/y0h+mLJJ/Lur0f3ReOGuz4HlfcQDBn/lA3yt83zCwDODu2lKCY93m+3wmEgj2wqWF1eZIt59OXWbGte3A92Rk12rk/mDHe4P3poM+X3cH2zSfrt91AsoWP9qzfTD3fgx5v42oretror6iGtpTfp9ubnzayO5tnDN6d/zC/6h9xE9Ni+F/8Bcwv7dc/8d7AtNO4S7ZcDWFx4/M+mz02CV5P44oT+Ub3vPIXtvFp6Fv4soVob/xUH+IRkg9QaMmtLWg35l2+mmQ0qXleci3mJOEB8Cvr/Ig5VhEjZqBrtUTlzBz18f/Ezy5Qh6qdSI/uxAnY+8X/1L5iJlsz7373f2Ve6fcBDPnkgXqVmR4vKwM0j25+PEqF+Tyv0u/M9lVba6jbXDpg1XGlSI4a6jnt/atl4p5IGD/CNzBn3UlisZvV5pavs4NcHfhiuPzlVavwrXD5NZJl8eifRslfUOx/ueXNnHPD/5dq2Xm4fgmLqEz7dGslXm8Mec4Z9q0vtW01NO7/x9Ll9/b1RRm+95mPHbdQV5yvEh9nt9NbHfmX+B8NglGpM+z/CbDv/4kH5/wvoNrSiXTzz+82hGwGfwjzaQ/0/zf2P++9arcYy4v1uTEDUvLb7xROLiex11m9n319YM8lEmfl2TQu1N7AXkA/wre+Q7hiahSVcK+oSfaK9GoddwlHG6Nzff9qrqRpAvow7ZTiFqD6dEr3bo/oY/jFGfx0NgX4XIl41n015zTbKrNA9Udrx4Fs13pfYz/0z8GH/mr9nJiI9fEfKA5E27C32uor7hFOf5Tiu+XuxK9pSB5yUN/jIS2LxeRW1Kyk5NuD/h7g0Rv5V3hJ94vqCvw1+P5/cmzf/iYH3uaNAxlFW69gc0viHkC68PmkS4lqb8/QNleWMa2R/Tc5j7lyIH8RTCVre9dyB777wh+1XsH5/PiusnZdBNxmfZKftdjLdU+Jtjbe18z5/w8AnXL8004M8jeRGAv7j8vm6Rb1PtpVm87cjxj9QX1+vkOCjWh49v8B6SvdomfqxUB4j/yPN5cjFfiIcpRA9uHOf61jayfC875uNDmFgfzODPWc3hz2GEP57to7K+VJDf1NCk7hT6cWDdV8CPaofxeFh2fz0HXh+rLNaZ3JBd5tLvz7MLr2eg77Halq8f8Wtp5WXr8bwBf/H8FIXQXhYf4vlrhD/L1Sfe1+X2Bsn7TXJaXXJ+tjj/+W93fYlsWg/OfwfnyEYCj/N8wgj5hLZ8JP0aOW+v7fWg796dQ2kxIoDZPkxVz8LZum/X8Az5/LyVaf28RsrzH7ZkH2mkTzg/qILfUf+TrtmPeOS9wD/Yz0TUm2jF+l4vnB6I/jP5EH4+37UjHeu/G/J4FvKfefyp4UHe9kEPb5vWp4n9f0zp+Wup6/D45zYc+7Gwn0j/5PbnQNifg9cU9uc2tz8bBtG3CfvTPIzBX8OblhxuHP8dl18uir9LZBrC/nyTPhyRVi0tvcdxZ5tHwrsJe7P2MfBYEpo8/jBwiN+ikOjfbJl1N+mTfRb5t/fTbHB/Z7/wd3L67CD/9TB90vzuWP/OuM3u3P9yaqxyfoC91kPBqbDXKorhDVfamFTudPuGPPPux13P7K1pPEp90A6DZ2tkeVEaxBI6uM595FeYHtlDHJ8EiCfavk3Ppy49n2j31sFSro2363kvogfCPwfLw3j48/EY8thchN3metgr3/vKUCb9ivcpvP6E57cqJuILhAdDgQc5HnthfYeqX35PzGO4baqF/4TG4wfjaFgbTCPldu2asod423QJfLkne53nn4v38fo/5vkS8OWS40vrL3xZEfhXY4P7xCV9YlbDUVPj9UeM5NvZwX0d47XGNt3f5PmYN5GPqaC+gOdjbhXFsPRWH/UmCtlnl/HteuhVJv3Wq2PXH+1bAPvXhD0nKSTPt8GZ9OM0Iv3owt94PuH5GM9La3o+bivK/mkdl2+BrwifuYdrBPmL+sfHkv7RJ96E7i9t6dYO1eH7aXvqUP3bP/PpHyz8M93CPzgztvBX3Qn/Trl/Zg57MN7n8qvO/TUDrL/XI/5ZGBm+tJOvde6/OflRLp+s+TKTT5EH+dTAfPe6CvpGvaLAPySfEX+ZADkhPqYHRqxx/oJ9XAlX9D53atLzpWNH8HsS99a5fzU84Xs+9D/x9zoR/tlN/4f8iNrF88cY72N439kl+THZRbxeRdR/VUJHU3P+ts7Axyn8z1PcF/UDN+jbikrGD8vqNwcr0uGNLH7if0W5/waNnktL5Ub7zY5J68VYnbVvnkJmugx+p/FOktMO/kRTDXvNF2uw+8ANTEtT8b1lTVZKWw3PA38SftURf/bz+C339x11jN9TPVYJiLBLC2ztZAL5MZWIHp6D/vvZe1+Bd0Q89elk8TMnAL1ZoLcA9NZIQJ9D0KcK+hT+AZnwr3tg/uj6MmHPkTw72B4Lj5Ik7w9GoH7J763ZdrZ14Q/V8H6ub9MGnh8gP1jEp86I16up/Bb2zbjm5XjvseL4BPv7xfUR6Es6b8HPwNcmI7H2nb/cM4HP6drN4gUzxAtGrvMRL1DSP+MFb9A39yeRfoo+6tXs0JwjXxn7NZn2QZ8kMEW8+bl9i3rxfXLFeLg8uAz4eDXCQ9s7jdep4Hsn0+yFuyl6/FUbx/N42c/z5YE/5sn9zfL5ivwI6KNrn+f/As91CQCWNl+XHH+c59vM35csVnl+55FoTZ54wFN3Pp8x6tm5v93keFjO7Rf4I5vhYXpE/AX11w31TvR4ovePK/BHK+WnyP/rfePPSu7/8pXx6UjjNT2Z+GHq0vu76ZS1naN+aUYHMoO+Xs6Q8On8K1hdI4vwv6Rs5WTvA/9F01SJ2+9dVt8eydzflduTg17Ivl5J0yP98NgSvZxO3Ty+lRwq5eZ2BvnN15/jueshm/82uVf5+gAv+sY2ww8nX9APfW/W4feh3w9ivwh/nO3yqL1QNNnrBoRI5abtGGy/rtD1XcSjsH40fp7f0zXqiupX7/WG2R0uWcBWXTn1k7FZ1CtYCb7XmXQyfBWnK57vZnbDlYPnJS6PHJJHsO/WV61L8iftm+twCbz1O76IXdTTa0EufyYYvw18YQ9Q79BQSF4dUF8TR++oTvji9WifveH70IuOxN86/O+cni8x5x/gczf0yN6NevQ88e+t/TjeBZ6wMzxBRpAUVi2yT939a1BJLkPCdyRAW6+h7ehkrxLeCH+tR23O+3m+UT6fXj6fiOZzCOh+dyohnnsEnrFf93Zy7L8Ptrl5IP/ONJPFGPFP2fN5/eAm8b7tJQv41poi/0u83/h+P/zZGwXvn7nwH0+ilsBLZ+/2Htkm4hP0/l6y9ww20KMV0XuC+q1x566Xu9GJ9KfC64lPM+d5ind0f62Z6nDP0G/i2P/Ao6S/5qvcv/4gLPoZ//Hu3/uZx3cHIr47Cbh9dkG8ShX5favkdMr4+5XM+Pz6CvAc6svrxjKXL2uhL4lfDyeSv+NNiexhyawNhfy1vE30dh3o+0Sl9bQ8FflClZ/+39xfWuQLLPF7vZDH1doU+r6P+A7wf3POvw/5fcT3Z3OeX9Vl6oTzP8f/iRajnqi3Jfzv1u/t0H4eB7ai2ir8qx3CNwpJMi6fDuVR+dQ+lpzDJVLTHI8Jf1/g7YHHRr/jsV6M7y9Zmw1ugT1+h/T7zD89FvwPf8GXsSz0Q+p+6gdzY37mt/b+ym9NVt/1sUlA+DdYH1/S8GK3H/5VGpmxYl7dYJ0k7fCcvEamleb+dxf+90//mycrdrTn9jzGd+ic8/HF0HfqANdCX2na/jO+XVbM/9RXQW1Z6KskOrquncSkr+LX04rsx+W1npJ+jhLEB2zoa9fRrCSrNyn0m3dcMUsjAPMjP1foL+4PWPHxYr9Wgv7gDxiXUB9oiPgC7Tfr3d4vD/mytz/jC3/Eh/vwt6LHRxYfPo9PeD/885y/L1a+Hg5TZ8PHzsc1qxL+tUX8ZGxYGs8n5/bnuvCH/ZX/mTphlv955f6nhtcxkr2L/L//pX9MP3eIv/6F59WmrvVovTJ/VHechNxfNnYRz1fPbHOZJTT+O63HZzzhAv7p9xBPmCwD4AuOFzvjQ7hb5fGre7+EeBynD0U7wz8pc/+kIfyTIV+fd+6fvDGVZfEtx5yTfl/cAqxfTPKl0ozgX+H8BP/Ky4yEf3Ig/JOp2RD+Sbrfz/yTJP/kfrNrWr4di/EZA7JvNMdzRT035LEu6LEzn376J//aDy5v4J9caQH07dOg5w3lQfKBTZLjq2HXh+2bMmiNfsR3pP+M7zz9EPJVdhDf4esPfxtf/y7kSxP5Yx/+xNnunPszyudppv8v7RXXn6SvDzHR4/irqH9lPuGBRgw8QFPxuuc7XbcU5H+8GOQTG+X+cqtC+LJ/fJA8MxXCJ9W+6YVOn9ZbPs61XjN1fpFnwn/I5S0DPSjMZqprslDt4Mwj3f7N/u5NEK84pKYptQmf6SQUiJ8WBCCkGr/24M+MlPO9fWN30qdeb19/OesS8avWj0amjHgI+oEI/1rE+23M1hLZo3PER6qTbet1h/+Gx0fOXm9Zd1OlRvoZ77PYtfR+MYfwBOEXLcsHuJ4dnq+r728m8iNMNjBLD29x+YL+Z3XY84P2d7yF23fet30Z4fcmTIDNDPtffTeR3wd/gsf9CZg/fb91sGTuT3DgT9A9sjfay/RDH3P8PE+ioDao3Mw74ZUA+shJyrc2yfc83+A4hz1AIkpdCvuJ56syGXhed5Qq33/lu19O+t0vh+6Uxn7A6wmEv8F7jU1WIvynwd+lOzSel9WUib9Af1MWGOMG/F/GYEn6TcbziAe3P/wbIj7P/Q2HVZaPNzBDxRlVurk/ISzkT9bfBPLH0m895OeHPH4H/xE72t/2pJrZkwmZLqd+MAR9cn+lYvrhvo94S06f/XAv9OVv9OkBD/B+QgQtiT7Rik3/5/q8xlMlX5+QIX/RHBK+9JTBG/E/7yzyWaKqCnk/CrvET5qwb1fdI+TdsuqTfWsoNN9I6Mdf7Nvz7iTwFdm3qUXMjHpP5Fso3/GkXhFPssKJw+stfsOraY3H872lLN1lR54yje4HOu4ruL+s0HVShbwxTZIHb8ch4pHpfsPHfSek++cBXUvPFYN/Xj5fvGPTscwpeypuN9WmUiNV/9W/JTFEPsEqbpilafZ8LVX+9Tznlz+fr6Tyv54Pfnu+VtkyfcL9Ody+duJTbl8rxjT3V+9WTh7v5/razPpluJ945cX7yfhyN89vcHT5dtr6n/kNf/WTeazCXH9B9OX1QlOeLzor3/xrh/Sj2P++nvEnvcUzKpU6z6eDPFmMeDyW5jfyinzfYW2a29PBimX2X2FvB4mK9S7yR4LkcXZyf1Vjlce7Rbyd2+c8PhAsQ14fyAr7E/Zpv3zI4lGZPWiSvfJtD/a6eN/LLuw/jkdexF+nPkmGZjfC/apE/LsLEA+YXmg+lSb8abyedh0iPt9A/meIfCjRj0jJ7Ane3yUYl2kDyD50cvuQ05PIf4odxPNtwveR/7iOetF1y/3LJD8vRb2WDTx3Dm7XkWkeb61XYr5v3/m7hrAHHyHJl551XL9f0p70dRDCP91asyFhYrqfXO7HmW1d7a+X7TItmfhbeX26Qj7x+oILWQyf9QTxLMzsI+RzFfNhZB/VFN7fYUT4p5H1p5sl53uY13+s58V+mVg/6Xko619z5PPO3sn71ZnS+K7TuzTqmdAnktxGvV9pzP01j+SQ7/c6LjN/IfLzjaCPfL8W6ZsX5KcXoH9JjP4Goj6SoX/HNz6ZG3jex/Opg+cNL7ef5jXef037zmej/d10QD8+7N1oDXu3C3tXVh+q8L/xeImIt66/vCzeGlXfo1KV1k9OhD8iUPN46unwLjcPHN8MnDbqbxBPmXH6BZ6ZDfh6wX7sG05mP4YPcZ/sx2k1zPsbzQ+Xsl4TeOydXF+m+SZ9qzwIb3B9vSB5LzWQD/iBN3ASTrYeHA94PH/ytuT2MOwz+QV6Bl4KxfeJX8I6vh8t4U8wbqSf/Xe//vKclsf7G9mR0sjzh47Rssgfcm7Z/MIvxH9fPVMtb881Vq7bbW/UeZWXapnjBZNJyBdSWgPkI7YOPZP7xzX4xzXdtrT3sqhfNBSSVx73p2C/hmqD40XQ5w95MUycWu7PEPKlDf+GiDc9MV8h/46F/PvIJ/blqfJi6B8g/AV8f+fcP7Fg5daU47Wlgv5zyvNN+CzF/A0zj3/Knl8aO9yfKx/BLx2Hyx8aP9b3NFrl/vXn6pjba6I+nOMzj+Ojor7+OlwW+YBf8P/5SQQ8JYXtB/rx9eTj/v1qPOAPsMLr0wwm2/Irerw77Y/xDxS+Ht/5Kc96WS9z+cv3m/P3/Y7x+hvkh7rSvf3oov6I62+eLy3qdw56mtXv3KddUW8dJFes96AH+d9AfYHA9yb6QfD8mdeoVz7Vp1bxfeivrZg/6D3i+8njMz6fL+h9Kx/zfgnv0bGsS8H9qCMfsfmq/PCPHDP7NUD8tYz8ON7PxVbwPMPzbAl52C/w7+UM8Ip+LhsF/nUnkW7thwX/egD/+iU1FcLr4JcI+vXF859O8LfwfgZ5vxjUR+H+n/7xo8HfT3h1Y/LTc2AfOxb4l9VRX8PxpCebKy2BPmrweC/Pt8v7oyhZPglfv5UyLfI5cH995v447Cf3TwRGP+PXs7Es/AGDgr6Wgv7hD2C4f8R6lnm/tSboueYmt3Z8vr+fdhPxJp6/dvHx+4PvbYW/i+N/21wW9fm2ITe7eb+1SRLvgh/1tCHoaTzTU1bh+z0/HT/wyPYTj6Ry+9N/8ld9AOd3rv+T6BWh3itJ2p5nv569yN1fX8E6MSsRYq+mtfzOr1SK/n0D7e/+fXfrmMtTG+/vj9pEv9w/Rkwuh1sjIDM0kIv4FX/edLxgfMJ9+A+kk476gdQ2t+HiWSp/7TzoC9Mg/HxmqP/5Sx4D31/+lMdrok8hj33IO5Mg7eDhq07vjPjFRzzmpCDffHlGfd03vf5Jf7qgv8MPfbbAfjqsFdH4+qgXZcMU+eq+Mebf5/QWuw7yLZSmUlp7K9AX6Fs/9zP7O5yCfn63b5hCn1FQ35fLV635kT974/4L0xnvM//eVHY2lt/99O9Zf/r3euky9+95H/vpzNgtOPF4T5PsMRPxD94f61rD833kM7WFPsN+uqB/mffLk/3KqMn5YzsmenVG3+9Hv7TGhq8//KO3LurLfV5fvkZ9eQ/15QGvL3+gvrz3ILxB6+eK/k/R8Un6neubJ9Yf9tszNMlaraTMnBI9KVpTT1GvX+3S+pI9qDW7PH60VbJ+qHZSWhb13Br0//f4RH5MF+tP9tEknLeRHz4xGOq7kf+lPY464ZOk+mJRnh9rxjqPb/WRn3jM5W/VBn6dIx68OAOvWnS9Vdzx6Cwt83zbqx/k8vc0z/ofSskkuz9Lbmqd+IUM023zNTyWB8K+Zj3oJxv1r6wP+vL8fUZfOvCkWQ57TVveon5B0RHfovsjzL/PsutgPAmwHsLetWDvMnNHeFMxrL/sS9GfC/JcY3P0z4jDUZOPt+/w+nzIx/Bs5vLREfv7O/3qll7C/vhgTeYPj3c72pB9vjZaVjvxbq1ybyP8OcS/f+KrGvrLubNeVHb1NemTeE56y5wdSy3hz3dkvM/D+5b8fYzeZ3L/Ksl/stfA/5a/5P3n+jMp5f5Y2t08Pgt7fsvlwXd8QNSTf+M5a4bfm9qS8FwP+bwKz+cNkc9r31tP5I/3rsgfmQ09xAe+8xF81FPecFjp9CP+q+I+qwCP8fereH+kRvR+0Y9yMJWaD77eqiTn+Zk0gHDfbUGejnm84Z/yoon1Xg6BL1XEq5h6U18EaMehY8A/E/D+1CET+cbPi2nCH8JML/eHLEEfS3r+P/whU/CjAluF++tE/HNLBrbunhAf5v6YtYL6LO9q119RH/VZbNjg9Ty1MdsT/Z6qnH6vyH9RUD//QZ+aeQB9qqvf6XNocPrz8/hLOozV0u74cMoX3n+s4XW6Ce8HZDrtQ2kh6sFnU+JXLr9Xgv8gf/uc/2AvTCfwR3P6VoycvkMD94X8DWTD+lv+svH5U/6uut5/yt+o0Pc/5K+eyd+zpaAej2lW4l+lfDytuSbqMX7xN0Ee1FBP0G1xf7oZKGPi7wXn75XB61MEvRhk6fL+U6CXa8jrjXtVO+8vesPzv/mbhsLf9LR86DvbY5Ul8ik2sp/H4/l+PqxD7s+o7iGPufzh/siVGwl5vE7eS/aNx4W/Mss/e8reh308S45xkNu7F0Mr6uPVZPJKeb2sgXx6Lk8j75X12xT2owz/gjxdfOSPL5Ko4+fxp+tZy+Lj5x72g9s7y5Ofx8cTQ8vkp97D+szLC9KHPH+zPuH+FLKnXRaDnk55vZZjdJ3y6Y33Pc8sj0/xfhMvXCsiPyxZv1/pmuzzUItaHC/Mx43jkoWHfivPJxzuW+VTO3g4z3NEsAv6bgZ9p1vaEeOpWkLf6ZbQd+YrW187/lrm8dnbyvvAj9Pkeaf5uSHuox+LVNF1+L8aZF+R/puCXvRYO+P9ol9/P8n7kaaOOefyYPCXPAiFP5mvN+iJ56tqUnZ/LfptN0Lgg11f9E9Qvsaxw2bdd3KQLivwb63czPLX48sy97eFup/nnzPYw7y+A/ngr6SJfNSbs6b7re/+5jN6fhyV663JGv2l5sfjYQU0CfnksPZSnyIfDPmdE+x/d9tznj2eryvq9en9UnLA/lZpfe5zNkF/HYynyJeSYi6vPdD/KlTYKDzg+u7Q/i0G/HyFEc9XIf2VdqVydTInqThdDwed8NJW2Uhj0eqx1mr8DGaNjUgmjzpTnFGqM86PPvwznRnwO+odtnLRL2b70S8G8nxcQX3N5Lr8ciuN12N74/WT7Gq2XM+UHu2HCnuT6MsW/uaTVxb1k72my25C3g4KecvxgBZ3RT/gP+Rtv8b5wQb+TQgPVMmsKc2Qv+z8Pj5mDsID6ucz+czxVPdx3GX9hJwWa3s29NFRq+zj5mSX9W/rmRat/2wW/YgXzsCPozLJw20D9vTeft3afoB8vsZx+H5x/tsGGH9uP62EP8netEj+03q5HC9aRmoDj8vgH+/Metn41wz1ojL6zaXKQ9Qneuyb/k3Sj/z3v69Pec6QL4D4zVSD/7L0Kf+GyS7rv0H2vrpIC/nP+zMF0+w8De6vSC6f8lGTYivjh2mS3InsXLLH5S9Jq8Ff+biOLPOd+yt9b3y2kI/Hpuy7H6ZS9MMEPoiNN+avw18ZCXv+aDdf3ZRNpJLAXx63p8wMj4n6tjvmh/M9ZdG/xktq/enN7l8vporneTwyrh5+1vdjvOOJzFiN7//aAB7wOR7YAg9ohAfMb39XUpnm/q7dbFK+H1AvduX0w/X5Af6SZNUqZ/r8MjfLrcV3vVkMeSfqGRitZjvRb2/SWT/9i73M/jc/7H+X7H+anzqr0/sMxPe5fb3ceXk8wMf8u4dOro89PM/1g3bi61mu/7CPKhXYAxb/vVxZxzyf8dGfjCURny2/TOTnVOh7cgz+sAl/Tr3bcWARPq6/JF4vFpB+M7k/JuLx4+/82BExmPDHjv9H9utUJ3liyyvw74nn26OeB/Uh4Qv0ZiA/8xmqTLnihKFphfvj3W97ZpXbM6fJMo8PnHQvzzeb1JjIN+l95iNOs3xEBfmIm8w/sYR/IvLT7/4khDf+9E/05+y3fMQp7xe6kF628bM/waOW5Q+uoz7of7em+R/no2TUq6Kep+rUvfbdE/X7X4u8/hP+5jLyMwh0kD5K7rS+0lW6vgyP5JOojxP2wF7Y84Yt/F0a5LPcVo3HjfsfvI94r5Ii3nv7M967TuAfz+K9Mn7P4917r7Wsu5FB8jpR+q9Rz0P9DbdHdjfYI77lKeMDzuvI69FZ95rSJs161zvxk7RJWq9H8rbbfgR8HUB/iPwAa49+2ezreuX5zQGh9ZHIj3bYlg1eXpeph498A54PzPsz8d8/Vvg9jr2qI5+8clNI3tiehPwmo/XI1meF+Y0+xycfrjjxbGbtUF9ab9lfr8gBPtM8Ue94FuO7j+n9Do3vcOXxkzNT8vHh2LRBzVOZumsin2u+l+7t+Ax9xsdbw3iXMt7v4f3CH2li/Hx902pD9KPe30z4k3l9jcvk7/lrmL/8Y/7jA+p/BZ7d5v4ju7ogPOQZjf+0/5xx/x/238PXPHlam9J+rm7/1pfE1uEa/VMmM+Rbiv66LKvX5vHcRnhwNuhHo+b9aLi8HfP6j/oR/VCCO9nD5obGJ9nIF/ijX4MD+9dsmP8Zz8J5GfvYdpmazL04rxfcHW8/6s3DU7s4L8fJ+lOEisaGq+7MIP0WoT8Fr6eNY+i7W8r7wSAf9bzI81Hn40OOt70q3vfdzyz96LfpEX7Zul4ubz30v6gfemW9457hH0F8cFfN+//GVf5+5HcuBges1z/wySyca8gP5/VmPD4n4kvCH6xn75OEv9gbvsunzjT8kU+z8Q+5PbEQ34c/cbfI/cWT+JD7i4fifVe6v1gU+cqYv2O30b/DLuTreJHHJ8LOoZCvkBd9jvdT9BMg/E/yYb+m8S5PPB8H/ZrJPo0/4s9xe/PdX4H93a85aBb6OuknFuGJJHmapnK7kv65JO3ojH7NlmKrL2X+3a/5O3/OGzg9M5r9yJ9LvsT80Q9RzB/rqRTrGRm43y9Pcv/ir/5+Ffw7OHH5a6es1uX+Gw35Azy/ZgR8LdFc9KwfDcn7aaCNftTf+41Jjidov/XSVjPkQ1hNn6VqhxX1xhucVzWY9n/gzUVBT2K8g9G1rNdd6IcK9IPOSD9wfXLJ4wsrkc8cqd/yM97R/pK+mVx5f6roW/6mo1t3IB1b8vvw0S8I/uJIjfLf35s7xDdK3rYeaK/hNDjert0eG/F8c1b4y4C/eD5UyuOz/H1eiOd7qP/5xme3zg71HSMvyxfj9dkXeWI23ca6dt8SZ/2Nx+2d6WXxqRtz5UNd1r1F505muqinuvD19/bSYOpZP38v8NoYv0/lSC9vtb18qFRHjlIV+Tp/9NPwdFkeGNx+cRTpxvupHHree494tNkj+deG/bIJu01JRT3IJDAtni/jiHwZTVGaf+Hz73yZW5PrM5p/BfZb+dBHvcAU+KvaBD8F4KcV+Cm1iL/Xu33Of/Gskcfbj4v8/IxE3/P6Z1rf8qtvJQfUDxoe4hvzKu+Hd0G9oJWe48g+90l/ol8hsxDvRb4orzc0fHU5IbyK/GB9C3nL6x+Rz4/6nyTpLATeWifR117EewhPsQJPxbx/k4d4a8RKT4sEMukv8L94/xd+39F3VrJL1/8pD873fSEP7LNZuQVx8uxFQfv6srVj0n6cIy4Pkh/yoPKT/69ffH3A/9N4n/uHXF2sn2HHxiLvFxFo3J+M9V2C38lUJ/mo4j7vF8Hr6ZDM0XpFc/Tn/MNeCNqwh6p2muWj3Lk+mF34fiJ/5Fzkj/DxuJ19Lo962X4aSdxf5P758Hu8VrWRy6vTIvfPh8ArE9JH7rj5Qv6qiv5BB9zvHLplPf01X5Lbowbm/3u+VLog++H3fCvO/zzf8hd/7kD4cy0P8uvVa8qluacj384JFJ5vVzEGnsi3q42lLD/p73w7U8L4U9LiA4Ku6N8ok/4YpSFrz0PeLxnycCP2D/7SySL3l471T3r8Kx/qxo6y/qmPzs5/099zsPtXPtSaFnXqvdv/4Q8ZhPvozPtxoD5yyPs//u4P8SThDwmmXJ688/y7T38Iy/zP//CHMKyHzc8XnDTgDxmu6H6F6PnDH+P9jmfw/VeA+oH+z+d9F/Jz2vLgP4i0rL8Dt7dFPkhbAr0X+Vc8/0HQ3+hJ+qnN85d5/IDTd199yXn+tKXJ4WxRz/tnVJBfOub0zPHLg8srHs9pgh7z/Svijdg/2g8aX7nopzFF/37rCfkiKSRf9t6lqN/O8seM9XU1T/P3+bKe+89T2l9/S/vb89BP/VtedR083zEGJE9vq/+klygu6EViK3YT9mFlCXx7QD5UCHtS4vbAtOjfJuphDNQH+Y/XwY56w/LrU58ifsTt6xf0qaPg+eiM5y08H+B5lhbxIT5/BJEGN7/Qhzr6YcyN+1E3/Y3U/Igf9nZa3p/2PpuT/c/9m6Wwrwyn3oHJpu+lQcLzmzwP8UicefuXfKtZhXzj+HdVzfshxqeF8BetktDa5fLO0bP768gtHdqLV6H/wyny4b211CcjZ3RF+nYuX8/mOMdP1Vkv98dITkqAQW4zLbDRD5Tj4/6L3q8u2jSfDfRpHf6MbQD/Ae+X8Gc+X9XM8/lE/aCD8TPRX8WRk3GU989aGYYB+Th+EZ7i+fZPzM9D/v+5wc8vvC5bbmAg3yRAvneEfAtlz+vBQ5xn1TPr7poR/wdBH/281CHhie/8k9gieiT7SE7WR+TvmcjfG5KRkTgBr09vs2E8fDnoLwt7yeT20pDspWPgyeuQ25f2gBnJhB4dnaO3+XZf8E+exffoWbzPTLZH+G+iybr1Sux6vx0dbzgfZsLQT5vzxwz9PBd0TfpUGe7a59z/LeE8gyK/c58op+/1Qn/A6Ls/4MDg+dNtsj94P1xxXoae5udR7DmegH10qG5x/lB71F7w/JT7CfiD9wupVtPM3jA2Vu7v3g22OJ+yRM8nnB9ZdXI9rbAfKYv0kiPiA20iU++wyfufcH5ghA8rQXeA/gjQXyzh+UOTsXQ5wT4S/r8Q/iTmEr5Mpw29vJmyH/bWBPrBsfF9jh+nyo3sXV4/3OiTvXsLEL/g+WOqivj3cc/zBXB+KunDW1bvzkS9u4hn/NVPqXcReCtig/tIccqX6RfJ9xnP9+bnjclFv571R78e4NONeeJ4cHB0XdaKUI++arZISC46H/nQVpYPbUlSRS3yj6FPN9Y27ycmC35GfeZjkeV/8P5p8R/xR9RTjNcf/jZTNpziPBn2d78i21mwv+OPts7gH0C/JK2DelAF+OXZLlcxn667ljc0H43m02Cmoe1fo2d51v9dv3reQ+jXW1+Cfj0Ar9MouH7tFfGGPfzpAq8rf8V3LyfeDxT1d5MX9Gu/qZbmPN7gMUWdhhLZe/RCkle/74dJ+zvfYj9wVPrn81PIt6q+1ImeyZ4R8TaeLyjk8xbn8VTXz/J9m/dTmI9ZUd9gb3B+HuEtBedxEX1OnKy+4ZbjLXo+4+dPvDUReMuqYv090Fd3Crw74fUNvN4C9CXwFs/H201JX51PnB7hj55+bXN/tHvi/Xx/6mOX4fw2DfrzQx+bWX+nSYbPPurzmH5o0foRXuO/n5/WH/bHTJwvGZ/mv/THWs6ivD9W32D/RW/mpqC3JIjJfjCV5PKSzIvZDggAkL5G/6cJ/AHNIeIRE8QjGD8/APELIwB+yes9lKY2gjzCGfC69f08j2fcnYT2c2J5i2aRv26LfE1f9dhpMPfKrTmPb/P8wcUK68l69LwizoMdD5rGvkP68V/f11fdOuJTXF7dZ2v6Xl4PNQnd73qoAc5z7fsP5Feg3qTSyOpNell+hUPP/yl/BN4T/g/sL683Gb+RX8H7/bPvfkjRZz9GfziukX46ybz+OuD1rw/0R7HBj4TXF5/9cHl/N+H/O6lFvSCvT9RRn6imhb9gtUZ9PEGbmjJwnWlAVNu1E+YFPXsdyOgBFHUtcR6Vh/xxT1HMm8jnxLUt+n8Bj/Y5P8uBfMjw6Ejzw9m1inyFrfCPkz1ibXI8mupFP8vZIs/n3nxtMnvj1/qLkAWy/ll/4bWXn/jxr/6ScXPzz/oLrcLCXe9d/tqLfuaNPuPnq68vNRn9ynHeeLZ/f/Sf5/kwidk/lAbf5+ko4xMrOWeL8Liyx3lBixnpL/SnnvDzMiTS33/1O041Xv/C6dVg1VCcj/Lv50X8TvRr7zM/pPEW5wU1cF6jvyH5eZoX53+VcP5DC+c/lB5bmZ//hX7Y6RDn6+jJYXkR538YmTz78/wgF/Jx4gHPLZrAk4h/LXg/xTPwng+8uoE/m+/nIHyMs/yG8eyW41V1nmZ49VLZFufTFP1KDb/oV7om1YV+DWlWL370N3l/qcGJ3td1PvunLLj9YYv+KX/2D38W309a2fcnyfW0+T7PBfnvIfu7f/idn9eU9w8fr3GeyhD9wxX0D3fWlxbOMyjON8nO66lXo/88X+Xv9e3T+jqgnwrop+oh32atdsuBifNtAhv951Bf53L8b1XRn9MiPH2Wd6j3wHlo/xo/+ocJe4rkh8bPT/QuqN/Ra+Ps/Jb/X/oasugv+lquiL7c99z7cb5cRPTVKQ/bMtaH8f7/Q/T/17LzXWo90f9f/oWfsD6zBPQ1XMmPnTeEv/vmifjljRljcf5LkLy5Pqqo3fV1PS/yT3N5mWTnI5ish/NmkB/0cn6cjzCshh/nwQ+Tr2qU+/+5/Z2kxXmW7O5l+f0PneSjIxGVVmqrOOvvHfJ+iMxEf9PmOu+PyFY4jwbxqeRejO+mSHLx/Imen308f1LFtcD/aa+R9/s7N8slpEdq5W3XkEd15eVNOmm7oZVnU+ARfl5ddQV6f8CfuT3x+K2V8Wc4n+fxh/hrnedXnU9ZP88kWc697PzceLXO+zGc9LzfZ+LOc3/Ylc8fpsC0xr83xPcWPB/KKr4nz/N4RuKvC/mtad5nf5ry1/IzHvxXvvoR48v64dnRxX2Z56j9OMbIV1+Xji/bCexKdE6Sp2Ult+NL2eb+yXMkf8aPP/PVfX2T28frU77fcZTNb5Kc8/mfEx/01ZchvyZLzG9G9sdBLtavlf9+fb3NveJ8L/SfiYFv/zoPZWzy873GkLcVF/JD5fKDnz9g8PPiysX5GgbO3D5UfQfngciXcJT15+vg++kc/R/Rv0WcF+JHxX3gOYfIh9AxO3ld77v+UXF6aSjyU/sqyQOb57v47dKI8OB8v2eK7HejygD+kMPw6DJHvxCnectxg0AD+pnLjYvf1tlIU75WpXXGjyfBj/vExHqYxl5cD5Mu+Kmvr0Df8I9GayvrXxpxfqX9Drpk/S1lhCfXe4XsitALlbYl6kOOhJdnigd6MA+j4+tjPAOFxq9031Hlwz6J0f9gsFC6TWL6brAX/Xl66M8j+Gt9EudDSZEy9/L+mcY9Hz/j+RDVVcGPGz1/ntcXlvQwP0+DHaeLZqla9Guc4fwLcV6XPx42u3PTO8ckPgmf835453neLzzrJ0ugLLPfDdjvKx3001+S/J9LDPKYZf1Vt0HCz/8AHujqRnmrPNioKvyvmlYLM3nfmAzHL2U5T0S/YPlO+PJLM/UsX4/XczVS1CcN4F+L5H/J+5eIrzmePf73eYT8PMVO3i+CrbrNufNpzwh77c/rI9bv/5E+nEMfDswf+rCK9//v9aEzbP4f9aHMSn/pw8lgzeSxB/4s8Fane+uTPpSkm7HZn49yrd5upQHOX7WAvxSOvx7AX4PksMrw1/Dv9eD98US+EfBMbQZ7cQD92Mb36qOY7Gmh/0yir+x8oEL/3ZF/NJBp/8fPedE/1lg55RO/Fv38v1Z5Pq4E+X2ZAX99zfJ6uqyfd4a3psJeFHgrtx91KdnPfvQnSLrz/Hx2YZ9997N7rJYf538tk1NzlftDFpxetltRH8fz+7aiH1JvNc/Pj75X6fcu/ZVVXv0m6ccL6eO6/RVOOq+2RddnxGvNB+hh3ZeT7Rn7a97EtULX8FeaZ9HvSku2AfyVUZf7L7G+c6xvleX9P7ce/JfAN83XV0Mub2kuh7pled3OS4nk8q4TKJMzMz0D51GsP/t7ovRU2DfxGuuRDk0zq4/m+dI8XyxpD3n/eT8Zb2eh8Pf1vv2jFeEfdXTYwwghCv9oE+9jiJdcvDrPPwO+R/1sENyPOzNq2W/RX/PjvEq+3j7f70qx/p68yPe/g/7coj7V5e/n+bLA16I+vDNb5ud/S6hXLPZ3HemmV/T/PznPU3OdGnHi1gaV5Hy/jmzLvpVfCuqBzgHhw9CC/91O6H5wvdH9pNVfvJRb694+n69MusQ4f0dxSb+fQ/BHzPt3LdG/68LPa4jTeaxveX4L2benapyu4+2b+GV6uR13dox++gGPJwYXxT5VJ7Q+S8TfQsTfGgHibwzxt6s8K/oli/5xTGlye4R2k+yRaUj3x+8p7wcsDSpR0L8+TVPdqq+l3e8lToD4XLQS9so2Oc9EPS/Ji23NUkpz+crPm1i+XZv3hwgGNP53lErxbtHm+TNdO16Cvpcmyb+5/4D/+Gjz+vVe+zI8autT9ZS//zSg9xNjGvb+1/mc/e/vl1dqaclWS7npnUkerQ2pXwlo/IiH9J+vrUT8vJg/hf/4lYyq6FecsmXc9Hj8Ev0VAvRXaKi4dnX0e+Xvez+xnr0+K+8Z4Z/z2szxbuK8f9Qz3rAeDiv6g62/+4MpMq/PxHn3XtYfjPDqfZnLg/NM9Efs2jRKzv8dVlrx9fXQ3zfEeLtT3j9Mx7XOn9/QeIb8eRn5nV/8efS7DE78PvqRxbj/p72o63l/XUH/fPw+5GdmL8I/Af1i/XXelKyxzF68IN43WT0hr6/8/BnIH+uW5x9sef5BZKVuXGkW9WN8vMLffkR967d/4zGdfvo3bn/6Ny7jZc7PkpJYlVtgJaNeJG2vL8l4Ru0gNIO7bSXJ9eWur2bbuxTn1Qff/hBT5+fVOz/yLTtYL4XnA1t/zEfIU/QL3H3I03VfTXbD73gVfm9n9UXuZ76o3dE//Yl/9Sez+vOi/9z/sj/Z8tPf/XM+72p+HsC1DrxfGtN+uqtlbh9Yek5vUZDpm1USyMv8fJruKe/XGW35fQX5M/Eytw8M8fujA/sr11dHTq/8fKxKrTgfy5vn+bVxc5n7Ny66V5xf3cvwSPgnHmmg/xHOV62hv1cPeMJN0N/rjP5eJvp7jWvo77W6t9RBYV94hC+4fXGDvC/O72OVQ78H/LFP7bjjkTw61HC+qahHk6u8nxbGA/1SSYHHhoTHfK8Kei7wmV+pkb28x/gN4LGTDzz2fZ40t4/+fZ40/Mlq6eM86d+f/zxPOiX9+Ot50nOSf7I7m/0f/V/hn/4vYd/W5/+7/iVC3inf8g79S4wv50f/ki99m/UvMfXB/4P+JVw/3QKcbxAhH1rZZvHRrH9JwvtFB8gXszyRL5r1Lzl3TSfrXxJP3z/6l1z1RSG/te/5oH9JR+7/3b8k2i1yfvBn29z/FmI//pS3as6PdjQo+MHj8v+nf876f+Of62M8H+eNttMb4qM/zxvdi3jbH/6pCfy9t0b/UDJUyLs5ru8RXXcngUz0ivktYU/MYU+c0C+58u/x3/wPeyRlsWbx81z+/TyfL+P0qaRms8vP52ynd+K/7/M5azQ/na2++bvSVypkvzH0/0vhf8B5y4sRzlvekz3SOYLfK8jH+IvfDVoPHo9d+9jPWaOo7/mjXvpKtpTl8H61Hez/ffhHflZQ6AOnus3xsDxLM/vAby7yfgJdfZv7V7ZFvm5EFiXvn6g2PfSH7ivzvP5C9E/n9Q0m3jetLjP/najHW+D6v+rxkG8XmkPSF4pJ+uP9GGX1eKGpOZ/1eEajm/5dj/fI+i8gf3SW91s53ecf/DNNYshbp4n7XeTPS5pD8luCPK0OkX/E3yczfz1++G1xnvOg1+X1/aI/J8v76fH6vI98xybiNwHnzyU/v0QymTj/JqvH84h/T18K9kdOlS85aLNZ93k+SJc11q8+yurx1tf2zMv7C68w/vaPerwE9XgP1OOtklPofJzftk1uBKWssVnU403/qMfbahNRX3ROGtgPPfy7Hi+JKujfVCN9cJ+iHu/cwXi++5dfl7j+rsc7V3BtkHzO6/E4v/P8WF6PB103dVGPd8rr8ZJ1ok9/1OOhPuS7Hi9JgtM0q8c78HzRym/5opvmPMenT32Z1/dLGE+S9SfRPvPhEoF/vPEjwz9bxO8HWvpf+MfeFvT0I34vzj87XM1o8bOf6XlWxFc68xzPHGbLPL7WwXp855+fV7M8HzLezXP+O+F59t0PO/rRD3s+9r7a+fmgfH34eizvxXoEs2I9ung/rzd1I+SHL37mMwn/Fq3HOvMPT+Afro3ND//w3/1g1/oy87/9H/uZsCryx/o//MOPfPxJMs7201jHyiz3j4dysT5cnvzpH97G81zfvXJ6WF+5PMj8w5t/4Zl0HHL/sGtDf62hv3Tor7EN//AwFvqrQ/JZ6C+xfyLfCvJQrOfrW74W6x+Vi/09Vov5DTH+LJ8gIvu8Y5C+WzON8EgV59dI9k5O9mSfr89eQvZqin4UHgvfB3HepXheG/gDnHlef82r6C83Pgp59BD58afdtMivPS0L/M9y+kfSrG7aPD/BU6V2yGRlHYn8BLx/euf1gdWKEe/8/6YHefZND8ny6L7sc9J+BL3X04zcIdk/6wD0YP+gh8ngZ3wgEvsP/1ZTn2b4/xrMCv8V9w94kC+mOA8D9kNnVuRLVWfF+Vnof+KhW5bto3/4Ev2+fF5/9p3PfPPgX5uxNNeXc+jLJecPHl9KsJ8bns8MPLD1Zzn9fZ2Kfn+nbHyz5DGY5fubZuM31kmpGP+dj4/nM3tyI8tnPjdwf4/zREqcX6viefreZlA8v/sqnn/ivsC/yW/4l4+3bv43/lW+zB/4947xiv591X76D/wb+B7OL0Y98Br5dh6vB45QD6ygfwfw7d/93a1U4Fvl/yPuzbpUVbat0R/kg2iqqY9BoSJWYIlvpqmIqIAVqb/+jj4C0MyZc629zzm3fY80FIiIURd9xOOvs6gdwne3NPLp/895qKNosE+a8dzbZOe33Rnf6u9C7HcWjxN5PA79T3vjl/q7dbr/ZN+Up1k/bzSdZv6fnI/cn2F/cv68VaeZ/Cji/6n/1wJ+FucL/vD/EI+eMD4Z5iPfOd4eTu2XfGy/Tf6NBv+G7GEX82saHtmHd6mffsTbUZ90KCHeHg7xfc96hsvQNQpr0P9oAvsuHND5fqA+9fAIuF48X2+cr/cAeh35a7ofztH/4QFPoQN5/yde8tP/M8XS0RgPmOP52zyevwogP/7BHtY9tdP+dV49+KU5JH5/tYfXCfm7bycr6Vxqo57+sTljvtO/2ceynuWHP/ycF3pwsP7QRP2+Brw/j/H+BPE/8OAjg/styR6j/QnhX5lvQbvqE1Vdek/8lYTxc2X9YiLrFwfBS72cM2V6NIQ+njagfxGvXlmDzB5O+sBH2awlPgrZ04Nxcf/F+eLJO/hV+q88z4b7faPMHghm0zze5eTypD61U3lyuk1FKk880KsdwZ4QOT4N6qde8Hqj9jvmWZQ2eP4M9pMBeknYP/6XetFzz2X5aGul57yKd3OU1Vvbz/4Klqehwf0hmtCU0oDz05Cn89/qp2slO6uPjaZZfOe8mGT20lfTzuJDu2k2L+fanPzJv/teTu9BlPPv6IV/1b/xb8GYy/nms7g4v5icb0O9hDJDvg3zszB/ITKV/qV2v2gfRK/2MJ1PT/Qr59N/SPyVdD4gfa82zfzny21brH6WVDvbj/Vv+oX345qvNy5Ps/6jqJ/r7yA7fytO8ucDqki1H1xvv0Y8U48dzPNDfifvb3nf5fPmLujfGaugv6lN9C5/r/32+xLwXZvk1nfnZjXD/y6IFvqNgSeySlyyDzaNYknmF2W8APRRibkfB/NMDl+Yb3LF95p5fLzK8XEP8XEP5y3z07/fx/rtDu770I8NpqfJb/4szzM9XibZ+a9zfonecn7ZO5NMf+uQb/0h7Mc596N1fvEvZl/575f7jF6jMKfXYJrTqw16Nts8LxX76+L9fXneYf58rteYcn1IBPq9Ql4ssv7jgPuPke/QEu4/XpDT1rFVI+s/5vc57E9ud+a/9x+PtoxvcLJIP5vvg3rs997pPud7UH//s74e8WjWx1Y0KHv6a32+5sr4lWoFlTnmv8F+4fqdcMbzrfJ8Y3jH/qTzqES+HhvzASY2z4cieT0QvXReTWjm9Oxl/D+KO9g/ad9PYN8rJZJfCzW/v8vPI+7h/y/1H3/Rb0JMVRv1mgbw9q/T3r/Hn+Q81X+KP9V+xJ8K6nD/he/5Nf70u/7M408K+p46L/Gnf9W3Imn9Jf4E+mua1XGub5M0/oT4dIL4HOrBSL8uoV/XpF9XtP431BP8oV8N+DeYt7XleS8T4F98tu6X+s0B/oXC+Bc8PzXC+UyL4J8l6zOf8R/U8ckUqlu4Ml4k46H97D++lExp36V4GRKvHvGkw2JC9mgL/SfIf2sh15c3kb/eBYjX/tov9NJ/tCGn/qTxPCIhRkMEAWj/8n4iy5uwf9j7934ir25ifSTvS5xfu+3HQg/CdiJGFdc0410CvKcp6z/GJ1xDv7vf8TwOq0lWnxVF40y+f5Z6Wb9maZLXizljjufRev+tf2ifoF+F55u/xEue/eoyPjAdZ/zjPd/n5e/bV8eZ/NyAP37y33qb/7+672X6O5gkOf+N/8Z/tl0h/5rngxK9rmEfNhH/J/+6ViX/ujhoaJm9KOjfnB+5Yb7UqUoPr1rof7pammZFBubplDab4uXzzvoA8vUO+ZrWLx5YP7B/NII/tMP+j6O0vy+a4Hsz+dTK5NOI5NNiNYS8befyVgX/MN7D5mH8u7xN5QVxSNUfkf15CAanmxntyP9c2g/SvuER/cMWvTVeI/5/QPw/jDD/iuXrEVOe65h/VeP5yAfkDyLkDyzMv7JZPkfvYhkNdokoLI+9Xb/bgXxfusivH8P3DZ7nR/ce8Ze/7ZP/S/7b406eWqOOeAvqpcHfzalWGG1XYgj/26zW1STDm6h17ac8R7/+y3499RPqg6eV4R/yvHb6mmT1itfGKPPn9f0v9DTf5/SU0T+dT+k/oaenPLccyPMQwzz+1/JcWM7mVZ7bA3WzX06S/6k8py//r+S55nU7v8vzEe1fs/05yuV5pacqm3NX+kstyHMN8lzUIM9nUcOHPC/9Ks/hL31awOsZAa9HYbwe8Ub+Edc3jXkeyhj9C/0x419txxLPhvFiQsbXfMrXI8tzUcjxW7YToh9AYvUvkwHtp6oG82oiOs3CCvJVyi8D9cBknzub/ZTtY5aXg+94rp8HyMvdJPPP4+Yoj6fuMzzXqD7J6kejyyifVzg1/6Q328npTeTyKxQv9PZX+0HYSSq/ohnHb+0q41vQ+ujg5lWWz47tAO+2w/15i2bBmb8X36dFfN9/ma+083hNOm/h6lW+xWtc6EuO11hBT/y/zFcGB8wT5PzQDvNOXvKVe/IrsnmmxnM9yFcGSeXPfKW/GGX6p9M0834F1s8/8pWn7Pyt+JyffxyNvuUrf+W3/1m+Umka/xfy5fpDvtzVzcHE9//P5As6uf4b+aIjXvarfFnTfjetqfNSj6Aqaw/xmXdD5us1ztfXkK8fIZ7VijfuTcazWr/Es1CPMrnTenXwc8LxjRb0sdhl+J3TOvJV3F+v3KNmQfbbqM1g3kjUTrP4Ii9KutsszOrorx5bxG8XeyIu/V/96QnHN9gebeT0VNobWTxhMrFT//rUdDJ5cSoZqT10GkzsfF6B80u88C2XR7tp/vwe+PHf4g1lw3uJN/xS33uGvvtR3yvpL9EWkDczZ/MmDNofxqv3uf5wB3lQ3SqY71Apvs+FSfe14ccxq8/WWsb6135YhYzGJvAb9JHWflRe+00fzllMxbZe67/Upx8mH9yvn9d3Y/7qyRx482oP9U+XXkHdpHh7Rh31YGSPzv9+/pv6lOfbkD1d0rE+sab1qS2c/3ZB598bORvFGLTMtalvd+2zUXM2pb04WGvzc7vdxIbrOmSptcTa1bZe2zfMhVpVLfp+9Qv7gfr8dD/QXxskwF81h5DXY6I3B/X4F4F6doPWc3Y371k8o2AjH2CXiX6Z3koj+r40fpPT10fJyfTRopnRV+RPOB+x0D/yefcDWd/uc38m78/eyfABTnN+/o/4AKqcL+2Lk8UfJhn9LsPbJIsP+vz+Euh3U8Q8cuyPsi23mgWhbrdtz7cV4Huus/p9z6T9MsUM9f4lRfkqVtvFlol6OaGqhbYntq5a7eNaa7+HCvdTEz1gvqpdF9Oe7Dc/oZ+OqOO6aDhcr8/1CsYgWKkanT/PS8zlUf9P+Yv+B5KP1eNNzksUif9f8ENrME5I/4JePnsxnc+0A/sC5zHvQH6R/O9fnv20Ice3TNCnnMc94HioRuc/53532c+W8n/TCpn//3N9fZR4ipm+7kh9PbKVb/q6Ts5tWl/06Cb/T+uLSq1sPtK5d/6mry8Nm+kN6zGe64G+Nj3lT319mtqZ/DuXRDafZjT5pZ5zOM339z2n393e+UNf93/Rd5m+9j6Az/trf8Pz2vHw/pf8ywP52d/yL8of+qqHfMsD+RbXIHv1Jf/yaZD+cbYOz9f2NOUT9uqM/fn9JItPx33aD4fzLa7Mt2T2pP3XfAu6H9SBzLe81Ov9w358i/8Yf9Hngva7qZEY+V/o8z/3Zwp794f8vG21RH3lx3nOj6tP+4Uf53/wY2yj/3QC+feJeaUs3+J+vp8HB/TF8dky8E0kPuqY/fvFr/499z+baX4Q+ZBBp7XREY90tLReHwPyyN5CPCkMrv+OZ/K/yXdewr/mO5sJ+fPnvN+whfmtL/nO/pT5SWR4j2GO99is6OLPfKeW8h/tbyffP8zf/sN+OYzz+1Ez599dSfxhvyg/7Zca6odkvtNFKE/tNUW3dQDepvKokDyton8C+DmlNsfXWX+KNvS5E5E+N2G/6LBfVH3rt31Rcb/e1QFdL+yOf/TbrjuvbVukv01B+vwgQuSXtJa9tkekz0LgK45KxH+lRCP70Mb8xPezRvxw1+GPkTzeBNy/VhEVMeXvax/07PsYX6+zGXvAEzDEZcX6VuP4GPdrann+zqWt23fgv5GuQ3/nD32T6ge2Z9BPP0j3H/0Z4yyedlWH/66PzHFbpPGSCz+f7dkS27NrnBf6nVCfsIhvW8RbNK7Hw7Wcr9XP3xdHw6x+OTbq2fe0x3m9Zx/yeAp53Nvn9JJMsvf7Vfvf5fFVVYnf/2v7leRFcYTzrQicr9bRbeXs7Wtp/6MmYK94Kvoli/PxuF0MNvWlZ6Dfy2hXyP5EP4VicH/kdTci6kI/ItkrlaZK9ko6L+IC/5msiyqCyaiv4fnDds0h8qXzdz1h/QN9l7n/3xTzw7rhyfiXZiFeuUS80oC8tHl+sxUVvtDf5j3zgSRfg02zL1Sb7Tv9WQ/wU18xffyv9VPrh35qAV8F5/+if6Y24x38db33DO+AtE9fzDK8g7/+PuF5v7L/zhIB99/Fx8fTXy6iXt2CfdZQKrm/bCdd57/M73+rf22iPnMG/juAX8fc78z9Yf4g4z/2JxadYWaPk380l/juqJc8xPEX5ifxfGYxBf9y/VZzkOzexOhswp8Sp1FjyPihHN8pC2U7wbxfxotO5Hz7CPONP67vL/PtD9uOpzs8H6tMsnoTP+dFe40Bxz89UU6a8G+2A5J/nRHJO/5eB+c1mhjEb5z/9Lh/iOkn/EL/9aSXxfOTybs2XKkWfS/6Ty4SX73K61XrooERtuNrxO8TuIa/d/18XuO+N33+nv1B3q+f+fTLOMtPHC7DfP7lpJ7rh+bf6KNuTP/TfPrPerpzodxXTv3r6WY9dr3dvV54u9YvTj5vtZiYKV7+aIP5mRKf/RkfMLn+1gS+XwnndZnVrvXT7Hy/mdMUj34cn40+yVsV9cVcj3vtwR7l/NNNIft2+Jwn7YnOfzVP+oz/txg/iesjXvJP/H3cX3ju4f063s/0Ee/7yMeDHu8Y3ET0CP8e9AHRZbD8Cdm/5/z9le0Fpt/9uli8LFnf/i/to3akea/2kTWCfmT76ML+wf87+2g6yftTXcxbebGPNkrlL/ZRW8N6ftpH00klyy+Mx1n85tgZ/En/x8/8/uUyyOi/jP//O/3rmX20GqJeob+E/cPyhuNdpQH7y10h8YMVzFseq3O6XzP72zPJQG1wO3F8vcn2NV1fu4L7/7XE4PuXHq73ake80oukjzrmt5Sqt0LpOPxF/wwu/e/5g9ORzqfyhn6jVV1nfJDlsdyReDsqxzP73+KZyDdMfcYT5Hg98+cmi4d8bhFvXy5BbzO670L+jB7jDH/W+xqgPj3tX3YlXmXev4z8/yDHYzOARz3ifOyPfq3hOIv3hqVBZu/4yvN8tH/UX+jXmkGf66zPuV+rFf2M9zI/p/pLJG2nwfHe+VBwvnwQNbZpvrzzp77ifoJl9Ts/cn8hz09l+kvpF/FId5z5w5dFP1t/Y6Jg/dc/17/f5OvfP9c/e1n/X/U3y0+sH3gwDTXerJ79WgmdN9czLY2x/d/3a/1ur8whfyboV1Te2Z4tM54Mx2uxPzH0+cc+ox8H8syxcnqJ+/l+hBMlq/fYjLN62qiU3r/GB0XJ8FQW4wyP87TF/YmC5/+wf80gkwehN87ylVuWp/9RPIL0G9svZA+SfrOg32h/zs/9rGT7uWg+97OO/SR+08BvKviN/O8y7JviKs0f/Ilv9ZLPn+V4L+Uc74W8hSxeHV76eb2SkcUXo0NOX+G0n9lHHvarP17+SV/HS/77a/a8WVzD/qf0JVL6Ov8rfRF/WT/pyx39/7sfh698P/bbfD/6kxyP9ZGvb9/J92Ni8H74v8ibWv770zbfj0vwf7UfHzz/6j+pF/4Tn+OHvpfrV8dZPbr32c/0l5qt3wqZXkpD/v33/gm3mv9+l9NPbI3tPD+a1g//ia/D8xiH7A+UHooWPf0BKU8vRvJNnpL9L+K/ylPtW76a8R+e+eGX+o6n/z1RsvWdauMcnwLzz+R5lSY5HqsyzuoBbx3cnxR/kQ9zQ8nxIvL9lPSUyoe0HvoPfJMb4/2RfNBZPkC/5vtRz/WLN0le/CPaDxv6heQr8pGkj+n8yV52Nzh/kcrXP/HgbMTjxly/uPhe7/OCP7XO+eE87WXnmyhJVk/q5fsVVfP9uqX71VrG7zyfTSC+8oNeRtOcXkwl56/tC720/0Yv3D8MPCbut7GQfyX+CJ7yU8nlZ+fJHw3Iiyrroz7kBdEP+48jop/Uf1z8ST+sjxHv//y1H3KR53PWi15eX5jTS9zN6eWw7WXyZBEkGX80x1k9aNhneuoh/vmDnt6f9HcaZ/GW6773h77p/h7vJXriej2b/alWVLCf8V47x6tq9l7q/ci+W8FeI3pqgZ6IHt056Cn5VZ4wPX3Pd0l5ch+Lf89n7bZels+a/shnzZ/5LCenr1FKf81aGI6z+k//uf8O9qvvcH3FD3l8y38fl/LnxUryh/1z/h/ZPx+TUfJ/QG/w9/+N3ubNfL0tI6OPcPaUT/1uRm/1yTnjLzunN4/5dbL4hd7W+fOick5vR+f/lt6iL3xfMYH8mvWIvj4/VOuojJNZmk8oY3/ecD71pKfFyPctQ1MzoM9NcZH4XbeRjDfM0vjozGQ8HQPzEdZ0foCE71aA/+lW8vrfN4X2Q0x4ngVfG7jWA9Eqeh7HR7ieFv0QKuNZLkUlcBTUb/qM7/fEp/bo2uHnSzzqM74H8e3+VbRtK2C8vfgHHnRLvOLzt4AHLDDvj/xndeSl+CgrlfZnJPu5e0aS9lea6K9r2cDjD4D3EamKdq+NeirPM+H+vaWcR3/tdyQ+MObLzlI85O5mBDz7Ul+N7dDM8EiSX/FW993Mfx7MBPrtvs+Pl/xWAn3JeK4zdJbHtxnw8WZ9Ok/GFxOiVJxx/miz35F99jYD/RuI3zGeJOeLGsDLR71mfCoDjwijiokfNMZHpPfvjZR+Yyk/rugvQH+rvjTbRI9IQfuFJuyFRzPLT4QO+tnRFpxeN3Et6Me3itkTp7XsV0J/rCfx3BDP0NQn/lV6/57eN7xBtVVX835ugX7JLfaX+4EYL9rqfTv/4X97/uY2P//Z//L8w9/Ov1PMz38Ztv/x/Hf/cv7nRfc/Pn9RXxaGlxPZJ1UX8YIS9IkzJH7nekOOF2xs1OuWGd93+FVQCh7qP8zKsTxqJntRWKwwL6UE+dhCPvcSWnbU/cD9IvRRNyR6mbL/zvNcFRN47aa+9buC+41YHlbxfCNZifPMJbdgpFaUocSnvTUtjt+qzskTZF/IfqnyKO9Pr2vNwnVb3DQmqi37R1sW6HFJ9iHwhorILy+wfw2b5KOd5PjnHD/p7fzNorsRnv4lrNbscOP5VT7Og+dH3BjPdF64FUotjsfw+2W8wUD+4POD/MWqC3unfKHzJsF528n95XhMxPGYOfZ3v/plfxGvPJVEMosbXs8g+gV/0fkO4oKAfA14XgTHy9APO+bzP+B6iWtZj6aYiSbxFuS8EJ/j5cAnvNrgzz3k9XaX6ZvTx4jxxDA/zsP8XcAiTD75eWxvf0h6l/Kb9JMGxAHOnzBenZxf9whCsddXhtAXHs8vNxg/WCN9qaiMJ8HzcJawRwxn2UV9SWHl0HmOWD5o6mTmf31uSR4v9AnHj+T7rCjQMv12ulhZPdd1Emb27Wzk5fX0dN9R6Pyq0n93kL8qT5G/aqL+L0L9XxHyLBH9Tekq0nr17PwWc/j7c5zfAf4+4kWt/cgTk4YG/MEe8N8U2B9l9CsVGY/3ZCVN9DdqH5st8u3l6S/yk/TjBPPRcvlpqmLgYh7jQsF+pfgA6fpYPtB6K+iXZX5rJBleXGxhvftkIvoHzHc6urjm89rYdP6o4hZlX40gn51meCbRS/tvhC/yeUSkkOF/RO/y/6YoODb4oWMazYt234qPGT+/xfuL8z5gnpG0f3g/ZugPrKro5zIxf+maPX8WMz6anFfA9tuS3w9/YR+m55PJIzqfEc5Hj9fBzj68nSyleeF820ro88aH96yn+5ffT6cW2QtM/9sH96vDPxmgfrzQLNRxvsR/ZL9Yqb3M/ij39+3tlN6X8WLE/SJkn5xWvg18ck9ziskC8gryqKzR98eiMve/eo4YHqbpepifyZ6i7yN7qlk04h6+nxgG+s+eCJ4P3zS5XqjC82fMfJ74O+K5X8B/bXv7an1J5z+T9X/dHdZ/9zG/leeBhVgP+U8tZfN1M2rH2uIL+1GfYn3NmNb3tcb63JjsVzVq0/PXkCct6G91eSJ5MoqLguy5mwd6fAc9yvnmP+IxS09v3dA5qznhmuRXjgegj3Tw+7C/Ifrm9Wmk7QtO49IsNsNgf6vFZRd49UPQywD9u6QWgyXp/8tTf6F/H/WeImhXlsNqQSl+zIFnDXzI9brTCELip+6kBH0Rq8Dr8W7AawUeXU0jf3oO/WKxPmF8NIn3X4O8bgLf40T64EqLSki4eGSPjpDPPZJ8J/90rwBffwD+QP7mYZB+6NdbqCeAfcz1UxJPcz+yX/vfTiquS54rgs9do/ggnkvEi30bb0eYp5m4pL82hbze8KuXfd+M9ckW9rkKPJVtQt6z6Y1I/2PeQLc/yvz5k9rJ8BJL2D9najLeM+2XNmg2Ak9s7WWwUY3dydwDn9fh5zE+sAF/TUe+lb8/Nu7tCfq7+t3QTa5Ro9fTgjXw+47bDvZvgv6iMf2+KdSKOhIj4D1OYX8omCfj8fm1dt/OLy51IL/5e3D+6y38UZlvbqmYH8j14AujW+V5FwvVlPRO9Ib3f/bbmXwIA+D97m+j2rGEeTkYOhas28gf+mqGZxptO3n/pxJk+OEcHz7i/IY9zIuV+NvQ95bw6Zr1dxX2UOzhOhwloFc9Uega+jKdzwF9ebK534HxfBfQl61a3BnY6XxCaa+FI9Cjhvmr2N/WTp6XYDzLVsT+iM39Riuz+a3f6HDpZPLcl/0jUfJQBO1KwzLLvYm0L0Ld61buEo9ub98CtypIH42IfjYB8Hs+2kKvjgY11P9dUP8XilHE83497yzzYdd4ifUzHlNHrcVvd2/51qtfd6AH7jcXZ/r9Df0OoVG6Fea1FtHjZ4j5b0ub7C3238icFB1t0gm61QrOj8+jqbF9kWT2dOeC9YeQl1cAxRxNz2s5Jb1C8gPzGMgQtvWqwfZY2u8Ae/6Jd+OB/vvAH+n5GtmjHcZvGU2JfoIC8Xv0CN9Gy1X5IvFIux19rd818h8LNtdTPjCfXLnH53o0oPvWA/nL+9gVBe6Ptcwurb+GeUYHb5D1c90114wlHlNX8178ie7Tn2A82GrzooLfSX8VVt4Vzzth3tTgYdUD7/q+6YrQiyNfq/WUQOJ96j36PgvzJ7drOg/yn02JHy7zybGT+y/d9DwOcl7Obm9+w7O6lnAdJopZbX8pYuURv7ZPsh4X/V3rYH78OpkfHuIhpj5Ys/710D9XT1J5FUfrJ31qwFuV9LkG3ir5Xqm/zPZTyPggt5FI7T3PMLL6Vp35K4E9Kt+v4f1b5IfCNuRHu9eNmR/gb1mO92Vk+C7Z88bxjvl3h/fVgR8LfLN+R8X858R9G9SvKv6vVBB/AH1GqwrkH+aX1L8Qj5mAHkvezndW8H+8FeID8/x7L5CPo5JH+hr96/WVcEhf18vHWnRpdIrxptGV/LGMFSXDwzs5oyw+yvL+tHKy+lm2t05Nvh+wvAS9MN5Dxfg+P+w48YDPQ/ol2JC++doKsr88WX+T+rPNE9vT4RfOg/ltDXztOX/POcjlddYf3glcE/MTef5SqNJ+AoTka8P2doV/r2L/lRnwYYfvxcuA94/1ie3DX+2Bn3k+FM9rPYGebNr3Vbkm+p3YPp7X/Z51m6BfQNXrQaD6izAqDOHakby7nbHeJz+u93zegvRHhfVHE/L5CHyWBvBfpb/wOcr6xW92McO7ZXvmtPrM/FUf+7MOdHMURoLeL4TRiWvujfzBKvSDT7uG+lMxuMWsjweYZwF85Cjp4316I8Xzlf5dhP4IDa2/ZkT6eIR44LJmlOh5/L4D8XP/C/UjJBhsUW5hDJfkjxO+t8bP8zbAD4b901Qnc5/nKYcW1iflH9NHzRDwN0meDYmWF+0W8HRmm0q7X7SL0C/F4IOYqmL6d+5fjszP9VLzyZ6aBMBf6pgkD3P7vHJezWwt8tUq+GHarNw88A8dmNibngV/ieTPV8cHfhX5vsODCfuzYKfnE5+A7WbPgr5emLclfUD/0nIDN8P/vTqw4vYDM8N3Qv9ZJZhxvfqd129k9B1uIU/JRDzXwxbk6RbyVFxZX7zT+j5KQ9IXTaLfCcd/+HsrK8yzmnC9KeivMoF+X+Fax/vcu0P0o2O/WD5I+mT9oeL9LvQH0S+t18N1y/u7vsD/dYf4QeN6tuf7VqbN8RLwjyusYJ3OM9WuDuPf+Z6TyZ8K01Mz12fMH/6nyfaFJxSeD7Zm++f5/A+B5z/asr5hHO+b5jd5toI8s1Toh9B+iG/yDHgrJ/GWPe+wRX2mx/QCe5fnbzH/t6agL8a3itvmaWNux70H9Pf5qb8PsefdyX42veKmq8Be2jXGxX1he2R6QX864lkdZ4b4Z34+ExPxsF0+v/kWtYHvTu8u14y+Ntg4zN+sr3L+bl7wPfWvRmq/hjuWh9wf3yP+Pmwf5tvInNwlvQwtFfTC/LIBfxiMx+Vh3uLLetXkn+2BM+if7ZeuWrPe7u4S/c+t6/uwGybSXlvEodnL8CQbmEc8fZ8Uq5twocC+s3P7ZfqP9ku3A30cAh/gutXt3VEBvniN1j940WdDFf5Xb5PZl/UA6+F+6scQ/s0a/eCt8+nW2Z7OdF72w/t2/uCfPZ9/CH1WU6H/WH/9Ku95/13TzuIdvD45P3wP/ts/6+mv+P4Wz1OsGk+8eZHhq6s5vvqK7Et6HtbXaJ5T+1Wuz9h+X9/d+L4+G+uL25iXrAJv7fV8Ue/VeXw/3/oD8aTf/JvODt9LikAtyP5ORV6baoGOQOjLsRm0ok/bRTyvNRoQkWKetVcR087EgvzTt4OuRvxP8vqN6H0i7HaF92u+J3q2WX65tn+p+63+g753PHi/13qZfIt90KsIyD6T8kxRiqn9K+PZUn62RC+Tn4keOzvRy/bjJz9xfeCc7QHMm9mjYK1cV+i87PCfz3fkMb4n6o0VOr+g3bfs4j4sHt/HNRGIywzxSHMCfM+pCIHvPKb1TlkfeAntB/mrQ4OMSFX6u0fSFxGdtHj1R08HJ8MbvritDD/QVPi8jg7PU29FVeuzFa/NnWPhmucXSHtomeKRjlEP7ULfHEGPteGD5A37w1cnm9/ulSBPNmL7QUYq+f/DXb34Pg317VLGd9f7FuKViF/87O/ZJKaoj7RdUD19OnY2z6XbKH6tNqqtf9U6602L7FH6/gkdk9Ows/ptOe9iNJnk/XPFTX3O9oVtNLk+AfX48L+4HjTuoT8sxTsH/QjQD+MPfY+/TJ/xl1Hswb4YBOAP5q8tfl/G+XSKabx4fDhFzXze2vCjeFkzfuDCyeq5Lp8tzheUTpl/97M+XdavlXzEI+eI50zjY2VemiEeOYk3X7dJ7Vi0k6WMX/rP/fswgJcp8bph712NCfq55HxV9BPs1w3Ep2Q9hhVxPzPi+fGJ/XFBGrCA1oNOc6ITPxqJKgof9pMfTLHM+CEkfijY8NfS/jFjWH3BU/10snk8O1oky5NR7AcZPqqMD0o8cQf1E+VpfRBeFFc0uZ/TCU2OB08h79SsvnPz/L/EnzOQ313Mk5ofOV46H2fYwDyY+keypv1amfFmu9Hw/CRGPLaLeKxuod5i4FTVHvy57/jTS19v3XYL2CuDyUUvrA30wxV1oX99qBOi54kuaic6X0viTx4M1s+7FfnXk8e1fvUQL37KF384hj4CvnzK35h/G6L/O5XPnt5J5fNK1IKPQMvtkx7wsQ16XtMn2pX2SQj+sXl+ZEGFfAn+Ll8E4qEu6rtdrKdl0Ho2wRz2LfCDR6IuLjbjBy8gX652Hfla8o+CJeI7Te+iBdsN3be4/lFob/qQ6NnTlVkqX2CP/6K/m0CjmFR85C/BfxI/meOdVxt4w19FkrfFLJ5G/Mv0YvUYT7ltRec+7GlP5nNa6xv37/Y9kn9r2MN78q92p5Cup8IbttL4XcvI8EmjMfCXvzzYy/UPWo8HfeBp8aUeagPU97M9i/rmQDUy/OXKWb6/yf7EPXYCzMs4p/7dPRYKnp98EL/CCiwhn3UZyHkizN+YH7RJdkLiO5TukA+JzFcTvVwYvznqQP4xPfjDHflrus7xurT+J3iZb4v8dSDz16xfLNC/0Cvq48NbKYOoTeI/rXfgeOgR+TTGqxw/v1ek+gf+l4f970F/8PPeDfvb+gpYb/9WwvOZ342n/+CR/wBY2T1A5NJ4QBXylgwD/j/3G4zE0LFt0s8x5Huef7LIPiF78Yz+5WIwp/d3v8/ntc3KW3kEvO66rW0PnbiB3zMe9emYFN/nL/zI+bwl9ENs9peF3t/x6mW+sPQ+Rr2Cco0a+08L8mC0PNYWih8VW412vCF5UZX5zxXk5bD0fqtBPmgkUsgfWy2a6O9C/0YL+0kykOS/hvd78NdWKt+HvLph/0xxIPquO1n81iOGSPerOL+pca/RpPNorN8LUdFmehMS73Tt7PB/2nSv322s660wk++JrqCgv8HXZ86HSH6fEb+vpH/jkX+j0SFk9rRH/JjQKQaG6XU7hq4jPs31Mi1PW7Q17Kcdi3OwqQyQ/1QN7YKvOMl8C/SFkuanWDQJQ6sCgtLg+y7rU5k/M3A/VIXqtN8S4vdtXVhHHv1rcX8M5rM4HOrU+Bqjf4+83xXZnyDyecBncQ3WPXwP00fDKBRiOR+W55fJ+ZP0lcP9AvvrQr/zfDA637oVfgbAH3WGN67faUU8T3YDey30TEOLXM0U8dg26f8K/OexMsnwR76crP7z9nwer++2mN84X9RK6zXLab4ozZf4+J7DFPk7D/mzcaOZxbMHOM+W16L7Jkn5Kn/vokfy6yDw/pmS47mOc3q5cX0l0WuL6HWjy/wRHUJPNCxZb2GyfMno4fbLepcntj8sDFCz+ftM5KfaeF/LP9gWvZ/nnbq0H1/NrN6G9DHqE4ZJLPPVXJ9jGGpBJyJDPQ8mBMv5hmbPPSxf6MGk7xm9XpPYqN6H78U+OdJ2N+igH4L+3SGpQvQv+c2z9UpfIZtf/9xCnkp6J1Wimpsi5gUTERTcbrH4cJEKGGktIQby+RuiwGplQ8/X0D9oQD9V+f+x7BdJdM1hPH3JL8r4vRbJeXglrj/BegySryle2J7pCfmNzc/z/5WeBP5fgfxscT3a2uH4RfUbPRYUm+jxb/SjxWZTFfFMHaG/Zmq0omXTVePPvpGdhzKxs/z8wxEv9PkHfXyUp+9l2DeyvjqW9cR15ItvNtM/vpfzm67A/CbhPPPpBub/ol5sby9wn/yJQ+15f4r7nN/zSZcUZmJA9DTWAzkfovC5MLJ8zCOws3jqD/tM0tMv/Jx9H+9niPWa2M+9R4ZRwxPk6i1K/P4O+YMsj13vIJb5903+4FfMp9UdVWy8N43pHxU9ct6lprc6B+9Jf5BHxus15N1qVyg+pLwjek8Mz1M1EkyqLaS9HZLPqX9qeL4L/pD0GJIYHz3l30Ej/Ve2fsi7NuYHrNt4PstLpm/+/1LiMfTEPbBZ/v9tv0Qc8bxGwfaYKZqwD8ke7jjP+U6g5w3mO/zk59/tf5YXnH/eC6YPrqfyxMy5Tl7ihZifh/qX4AL79NfzlfVjToo3uYx4/rB8foh4yyog/7nz2/fHe/5+71mvBXoi2QB7jq6bMa1/8pL/5/mt8rwDkm8kX+yU/3ENeWNr1faXkcqLZYcUTRX5omsmr+h8LXKLrsA3mN08zMfg/5N84/zlP+1XHE5Br31P/bZftD8asZ6R2+/ZvMZYzgf96e9oAW2AeH5/+/76vTp/r6QPt4P3+Zj/lMaPv613eLDw+5FtdADfmn2/ZuP7QtrvPf3+aL08L3o+j+jbDeW8ecyrN0J6PqkO6AvgBxW89vErBL4F4p1mzPLUtfj/mE81o++5Roy3ufSM2A9D1A8VBfz1Lfx1fE9gARv2j++l58fhmX7P3xf//nsPv+f9oJeacehp+frA325A6wvIn/ItH/o3P1/6Psi7Ea2vF7P++2W/om/79XxeUYx2cUWl7zn/eB7bl6cnvbx8H+1XVLsK5OP4eT74CfmLYfv5+2sAf9vneY52T0d/qmqdApEc4o0Bevi23tD/ud4R04vEP8i/76/yH/kX9LdX1SyewvIhLoCf9iTmCptf9ckPfdlO5zVCntL3YX4w+cNC3YuCL9AvzvRkDWl37yQu3NsWeD95PKDf3dtcb2l+049yP9j/FvakLevH5fuf9nHKX66oOUlqL+pRe4XnpfPDVC0yRHFRNKV9/fP/6KeHv4H6dvn+ZJnKq/m1iPoY0Wnp2G8AruxN1o9P+/u23dxQP8b1n8Bf5P4lrq+n/dWl/ooRai4vbdJPo13D/uzR+bRPlof5aaGo9aF/4lMkVmKq7aqbqsn3tV5LPXicjwpBD5+0jaCX5vo8Sxaz5SfqVQYynmOn+egz5hlHrTv85/uw01CSlkrnw/7FDPJ1CLyl8Ir9IXOX/Kl9QEZceHb9pTYs6UFC728Mp6bXijjf0KUNHuqzUTCslipk/8x9ku9NBeshf2LqN+qaUbj5ItjVaEPE1OreN5/DbF6sG/sq7Z9ThD3L+Dbp95JlmX5vUwwWLQffW0ny+pkt1yPCH91V9Xxe+qSX1afJ+n0D9XqLOfpr5vVR+Ix3jf9G7//VeaiIT/7TeXjpeVzP02SxXPbt53m4opydB+oDjlhfPIyKr+ehK72sXmsHfYzzUOxdY2SezcK8MLr4JtkLPe5nh/6/TCK9sNSw/1vkr/twwH3PaIbXotgOTzBkCoce/HutcCyOy+RB79t1MpICxktObvT+RkfL9pPpYZDVN/6pr2W8jOsXK3P0Z+1XRvyH/p7AnlPY3+F6zx7JE1JtQdrfe1toL/WKE+x/ywpXrQwvkvsBTtx/VzPMtH6/riIfDvrux6gvDFD/PLnI+sU5+zeJUF7yo1y/+Ib/m9wvYDadNdePntaiLay3jB4n8RbxSODRapcL+H2GKaiK9B+EUdYORN/6UeJ9GMAnXsyBbzIHPvGz3lAJiZ4Kd+Cf23Oy7zleTfc11NupiB/Q/hSa9Tb+r3E/xAHy0mL7Pkr9Q+zXjqTKwgiJ9KqoFw58b3fvhB1VaM7AI/keHIt2oxdV5uVRPIuighbsy1FIhyjKtH9h/FJPKeeLXVT0l+P/rcSY+96Z65fVCfz3iThtEJ+PTJW+v+XR/WCH55v8/FYUFoRHzz+ZZM+WXaujxbS/rfA8cSdaVEM957KvZv2Sxwnjb6b22Ajvd+PTF/aX6yuPgZHNZ+ff7wI+H61ZOW3E9nbyPeD31tVW4aozXgbqf/j6omMe2BvPD7vViyUnakHfqcbMvwf0PTf6/+kE/ppqEX2PQfx5OrmQP6QEOR7iisbSAX9702Z4jppO3KXnLWv1drVYsmPP1hzSx1atPqTrsYXzuw+rupLs9puFGZmN5TI+0H5oQVP0m2R/HKx4FoaFVpZv178iyAu6JvuE/A+yH+Hfzsj/6IJ+EE9udHD+I6YfxJs/W4jPS/vUeonPo3+m6xRbqAeOjiri+cBj3yM+7Qw15rcY/Kal9jLXh/VtoQYjn0ypYCFMbWRpQ/Pg0aZ3jJoY+dZo09CV+3G7WVjR8nCsWKP5ku6bQv94E3c/ftZrw/5cx3WD8XLw/w/hrC2W16hOsRQiIe1C9LqMA69N95e4Pxo2sF94frg87CqaRs8/e03Ud4eBFWmqsfS/nK1tHdm+HxgZvmZ4tzkeKuPXTUvWn08mIrXnjYdtP+eX0+9ZPpLQnPuXukb0YoFe6Pw+ahXIO9kfwtfKkOhlzPWbWvFRnLYC1JOHqCe3HPoe0let61XF/y3aqgD2/fWyw7VJomJoI+BeitpMbxPQ2zSjt2RzLE61OKe3pEjXPZ5PZxaD4VgbTBsBMVQpimPsh2VPhAJ73I2jpb+rLDnfRPszbHH96JL9Ze9A/gj4zVlqrriSvhqxvXVAPJLzEw7qd0keFVuQR0XIjxf5/J/nM0w62gvqIWvw56x4iXgR7M+r7FfleOxurzHeOe0nTK96MxrayOIh3ubBH18960MM8cHx367YuvrVaQ/fi/uinfuDF0Vk9U8b2tSvJfhzAH8jYPwqDfbfFvafuUJ8W0sGYnIL0d8dA+9qROdR9jwn6Ucd4jeH9LPlX0PUrw8k3i3m4wDfyzjotJ+bxJzVamGX9F+0Pg4r4MdgQqr33Q7FSl9q5MeX/TDn55q9wnksyB/uWCTfiT5MP/EirXqufpC8a2pTEa8D5HeWyH8Iri/2iT5bd1uk+cz4S83iMduA6ZvxuA2Jj7iM4wXfh77geWyYr1g7NYdJms9YfgrIa08RZOiQ/A/DLeS/0GKL7OWWUrm8L4d+z1wdln5inGpnFBU5L+s5bteRadJ64ibqYWDxNrsn1OeSv2XdlVPDufTMlD+sWuEM/yMUFX+5JH/QCvH8bRH5Yu7fpn9n9I342bR3LKiIr2G/7d4p9gM16YeRQe+31ID269iAfqqS/rAYLx/fH3eX5WNl5BndOIxO1sbrYH4W7+9jfxFW0EG+ns/b8/Za9RZ3yL/Q/An2G/mHjmYj33aR/NIxTPRfXmxX1Ncu8p81S9Gi/mZYvGxCxPu5XpX85x7k5Qj9FSR/C03I3+hI8rf+QfK3qPR0qb/dH3hc46JH8pfkbZvlLffbHBDP04KVjBeK1L4OYK9GLbu4IXt1BP8B+lbWX/sSj/Err9fN8Ts74cf5/W4Zb+e6tD9N1O9aZrmv+H7/dDNDvZ7Wg3rehPRJD/QF/LzVGv51FCaeqPK8+MC/noZWiHlWI+t0rh+O591np7OLH3dr9davX4/n4qYTRt4gOhpcH8b1+t5o5riaqQ5e+s8s9J956D/rRKY3iwL8vkX25VjWd3jqObNP+fpTMWT+mPGD8v2gNzU/eT+8LF8X8XwazTBe7MsD9KHJ9lQN/TWp/pP4ImXMtyV5ZaT4M4wnUkc+cBuxvaZx/Bf40mSecT5UQ31qLZh8NIrVDfrfHHtipPMLYlPWr811kueGp5dDxmex0D8mVM7PY32iohU0D/VlYUj7qwQZHl48bCVp/5KMl5nQR0naX0jvl/kRT7yn+cCFhn5Vnp+6yuvxBdcHtz0L/XMyftfj/GtXJc0H6yRI60VAOrpt71H/9uyPrDwq2TwGWY+af98pGiZ5/7Pg+nr0HwsjTPsLJzjfzuaNJDfmNcZZ/PDbvMaLIdLnh2Yc7kYjK47q/ja63zqhdT3ea6tDR/H2+Xz6moiz+fTh5Pu806qd978xnjrpL/RHE/9yf1T7pb9tvyN/7G0Gf+LHedN+a2m/GO/f3cB8E2JVcd5otvrlJWRvadvBTkU9xfaEpEI6T+RBp620MN+FjEy/0a3Gtd19NjlZ9du+U7uZCB1MyIIzlcjDPFIX8yevKxI7x0Mc38yFdj7dC5Mj5pciH+WihO1q+nF962PeTdUPT6OB60f10zG8F62Fdd3diRLryq2+Q78Q948Kn+SfWUT+FvKspq1e+jnXsr41TgrkDwu1MqZD8091Twsew44YX9/vlUl5oHiGQd+n4vu4n3TZK4Ce9ESrhrIfwLSLqAzUbdP+0skfepA/OBtKeiX9jPe1FsOsHw8/zeijZ8Qpfcj5nni+LdpEDwLzWHdMb4uNvdyH4zBhfKplsUf6In4rDom/uT8izZ98m4/baUFesb2222M+ZBnzcHs5fZzGfN+W8ficPkroh9rv7Pil3w799pd2HfKgUAb+xX6noh81gT8Gf6r0rrE9Y4FepvEtedKLxMOfOptghvfJ61bVLgZ9XBft3mcqT5Tn79sdut9+3ndE1l8q87MXXMv+8ZXocj61r2oV7S7rRXf1TtZ/K+f98nm95dfkvsj+X5I/xl7HPBPUT8r6rbO4rF/rtxKyzz7GQF1GfUVNRFpwRb3xMUR/bA14ZqQDZb/7NX7f1cW+if5f0tdf45NL8mQ68Db28BBqQivV0H9se52sHsL0+P4gq4eojutpfj9yUQ+BAo0U31t9TLif9iO+MD03xFc5fnvQ7zW9UXwfl0HPBeb3HuqruT5Ce2TzwGQ8gOsZ6HxIXj1QD/bg96Fe40qC51HL+nNlvIf9xzHine0Ujw/9IenzZH0I1tshhYx8Y9YPfqkUud8J+YLPksz/1+IE/OAhNMjzWeMyrnXYR8MR+MMHf9TUPtm/qw70gSf7YedxzOf3vEZ9Qi3m3zdM4pdFKM+X5HED9snHLq23jyXeZOjhvoA/2cDzN277z3qGMZ9nEfVstrbdV+PZMOsv2Y6V4vtMwXr2RqTLeTrxA9/fF93K5cvW6t21q3E8eUX2EPoHRhst6N49WxFTrgc/mkRtigd8ODcsZvpI5sOSYhb/aUAe7cMcP2EzrmTzuNXUH5jEx0CuZ1MoyWu38L3/RCkynt3wMVpj3viwDvnO+2eLNcnDekHKQwvyUItdaY+I0VLOH964qBd+iIo+Ipu5hvkD9keX/2+KAckXQfrGug/tdP9z/XiPTzvlxb5JnzcTrc27rG8s3kmfbHDehkemz6iP9Q28I8mbsJNYEclfkrfa4LQxvY/V426aj2vdb192n11VX47vwkX9J9PL8vX9sj7tHu9f3i9G62yesk7ytAN5arYCkq/P9ezGwJd0Puz4UCkU/1GetodZf47vmf7FNGvx7e5rJ7Me7OLa0Ip88zQiim7UJf4ilv2ij08D1gepPh5xfcsa8rYFeUry931J8reI+jDUt6T+pLRfuJ9RBz3ubxl+oMT3KArgE11OdL5VF/q7dP4lHujy/OcXeTfkerI25J0rLiuWd3PIO8wruwwn8OdcyLtyQvLu8sD9Vsrfi9jrgb4gnxzSR/NaTQD/9wP40j74z6nr2uDqS/zfiusnwiH6rw+zefXbXlt02y30d6byvm8Xj1wvXQM9DBW9vTyV8XvSucXLoML879L7yg/Uc6I/Vfp/PA8b8iU+rZgentdbPI9/L+dvj3H/LZ3nnOELJPy8McsLnfwfiS+g/Cf4AvbwJ77AsFCS9oBK9sBrvPLzw7GALzAAvgDRP+aVvuRDyd5WP9u1xRf6j+sj2ONGDf3AjP8+RT5HXbSVDE+invcrarJfcdR+z+zttl5P/YPU3tYze1sJd+7XiOn34A3EzTNtkg+aast6yqd+mRD9FzL9csJ5dBlvr9pRulXoh4uMHyyHv8SLjzv6vbXTiD+rHY/8Q3r0RV0hP8jxoJjc3uAjOAjOh+nVpof+Chf9dmaXvi+2yineqBV2yP9J6cOR9DGKvUdGH7EN+nh+T1z87Xv49xb6E1vV4W/fY5oqfU/hx/eUwR/dsDTyxd1beXtPfo+ffg/mH8rvWUIfWhKPU6P9CzumuI726F/soH/xvnzv1WP/oMXBDPX2l30l3+9Stt/7M+336A382SgttMKSmP5B73ffRr55P9fjXe+xsd5Crxxdjm7+/3L2f5bno7ctrS/spf2Ey8hpvcTriF6HQ+6Pl/6a7C/QZD/hx7xG9JP1E5L/gv6ijjf0nvUaU9iHpRHiX2PEs0jp1BalVkT+QzONvzNeGvnrnC+X885GyOepwfIPvFLg5xURP2B8n7nRAB4p1r9SSL+OAJgyV9Af3kA/q7R/RDiZVy3WF0ZufyxxvoLxNrgeopis0n628Jjr71jah6iv5viAxAvoDbN6lG3C+lBlfBND1Oc9ze+ceJ5981FJ5c0h+m1eBOrhpnl9M/AjgF+6mMN+tjP+vmB9/y0ek6wHS4bF4r7I/FYG/kGN9R3wXgNZj6GLM9cbI39F9N6AvXOorzJ7mfF/ZLx2hP0Y5P1z0p81d6/zDUYyP7ibNJ79KMCDdRtZPI39JYnfzfg0U5LP+wfyYdLeeOr3poB+vz6Sb/rd5/rpnWpVJV5PPyF7AhiDN1P6P1gfnX/m/7Txf7YPX/B3tud67j8Zxln6T21v4KF+rKme2T4wJiwPmiRvx8VaKh+hBIn+f+DxnCuNzB6Le+R/Hnz4nyb8z5pB/md4iH3iZ83S79rsb/o9mgy9F3+b48Uz6Hf2l+zat/oX1DNGcp6YrI+k9ZrIf2jhVJAOUM3BKRaVeImAbuyTrBo2t8ViYyL/L/J6I1m/s5j/Qk8yn2Wn+BCpvNlC35mC3PLUPneneoqfoUGfPcZJqj9CQTu0LuP6134uS3sne8c8ly/1sHt+bLr+++3tjvVI/opa91thLvHNQuxvCP16F5yP5fpp2F9dj+u/uX/Jk/HYSexXWuy/wf7VkyxfxfQqv6+X06sKedCua6Ldfqjo/2D6ObcyexpB7WZP1kOj3h2mbj3tV4O+XOH9Avge3Z/5xRf9XOd4fk/6v22cJ/m75P8ifla32P/l+gLLKeD74z/wUYF/8YF65CX8D/b/uJ+gxPE04nfVAj7QAPWpWbyF7XnXyvoJXvAb9kED9XVNJcXvcL2m6I5kf7dhfKXxhDH46Uxy9iXeZP+MNw3ZPuL6g/DuHkeaFRO97+J7sRMur7t7zT5YShwgPtNB/COdp9pEf6wI9ZFmk3/ge6pmAS/wm72rgp5qWgN4Ar/g2V3VNtl/7O/AHoa9g/xc6dLB/pJ9TPbwOirq8Nfqeb23n+VrulIe9XT6fkvr7T4t70T0GfYe/XoogBegon9xqpp0n9b/Dc+sBfrrqVn97lZppHhgJE+aemHZQzyQ+68rTM/4vcH1/dzPsTOlPLRFudJqiBj9zTXky2L0S8w4n476PNDf+UHy2wV/YZ6aIvutPPy/m9bbT2IP8jY9P9NwX8/PT/sLeim+WRP4Zvtd9VWe/YEvdl3VM7wKS1h5fHDM9bnN6hnzZ5aHBO9ne3AXgr+X4O91TPx9jNGvWfQSIfMlodHL8PkL4zDjRz/1x8cp3ooJefvsD4nruB4CP4r9fWkvyvXs1H7nZT279j+v5yzy9fwX8jlk+hTwX/0pnd+P+GikD7P68SiBPuH4QM3si8F69158jDl+4Nno1zXQr2uRfmG8OdJfTdL/K/R/tUU9w0vk+M/pkbz0S3H8ZBVfgnf6/vfcPw/5fNSa+TZyl5iPbQy+htZ2NyD6jdGv2QUehaaf9buIaT1X3r8S9N978ZbRU4n81ZKcN+On+nEA/bh87a8drsD/Mv6kkkUTMr5if5LjK6I+cinllU36QfhG2t9tHYc8z8il8/N0Wz+GqD+Q+KSZ/evHM8hnq/eexR/INfHacZ2uR/+oH6T/Fcf8/dv3Dp2/xHveJZl/Z+J7X/ivpeZ4BZqe1Teo3oTtwSbp30GOz2EgPrPn6ycexCfbe9AP9gT4Lm+NYb3E/cx/0Q+gb2JCGU/oCNNzfBlPcGzV/rDMFD+wlPLrHPwaF3f/KG8HbG9JeZvTJ/jRCsx3ki9WM1Fjl/EAMryPDib3iWHeH0b7wf7qFuvL64Eu7dsg6Vzexz39Y30+qa23yEymF9JXHF9QGR8S/Yn1Dusrrr9ifWXEN84/vyH/XBCIV2fz/2axXSf6qU4s4P/ZLbEeTVSv7UfCVStdXMt80Fmj9X3AXkNQR9qjhpbj/2w98Nekw/XoEfLrufxu6ymeceqv28AfaRlGJq81yOskKdktZTCcNC+8/jHLA/6/hv00gWdW2wLPLGE8sz7wzQJcOxO69heY39LG9efjDHwhDfNANK7XXMl+7DjUhhm+K9MP2d/EbxbwO4TRwu+f+gPra3lqhl9yM4je7Use/7xW3vn7iH4MrC+ln2R8dT61lRrMz4gPjyH//LQectAx0FvhlLyOej6uNPvDbBRe4/v9n/Gobm+QxaN2F6AmKPPv8m0xFKk96mF/3l/qXz4/RhyPWCMe0QIemzMDHptD9NMn+qm/24e3Zz2M9BdaeJ8Y2OKjQAIa9VsJ9/OS/F+90fr7oIeuQfQh4yN/p99lYkh8y0G8Kj6KF1fujz0uO0aF+Cu9Fo7lNEO6njsb2u8Q8y5HqO8wPcyX6hY2jQn7N4cfeHYezr9ywfd+Nuv0Psyjet83yH52Mc8n4Hk+Pn7PeHdb9537weha3WyK09bP51Xxex3XTaYfL6L7Hq5tpq8O9lfe1+m+adD9d/aPrpg3VayDP08W8aect0T8yPYj8AvrLc63sf2Y5leJ/0heZfiRKuNHMj9asv743G0Uqyv0N5QTyW+7b/x2ZHn85DfXa2f8xvQ/yPBw/PgI/AAT9P3Kb96e+M3qgt9QD+Se3zN+W4zP2XwM5g8+/+PDJPn9gP/6aXviYjuQD3vQgxMQPRw+cS14P7FfAfarusP1Qw9hfxO/22itnWT80K++2Afx7e0f7YNd+J75b/eBD/sgjG+dsHa+3ZdiF9X9o+l/dqPY2t19eyfq3sHL8qcv9pEZsfwVauyc8/j7QD+n9XTNJejphV+f3xem+mGc6QcX+qHTKP4T/5ru4BlPhvw0IT/p/SJ2A5Puc/2I1fTUeFxAPwrHN8KxzP/LeMMa/Nzi+CLwX5VRVBv1Wf6Df0Wez+d6JNIPU+iHFuuHMvTD9lIwED/+/NDgryZX+I89rq+uth8S/xHzefc4vxjnqSngb8aLnqB+XNpD3pe9IRsf+Du7QOaHljHL15j05yWvVxjFxUeY1R8wHlNH0p/xp33eWot8Xl+9ltHf+5jxKDcZXkrC+fwWnST3RyZ2LE6M19jvFkSGJxw/7ZuQ/Cnlpz1/O9dS/Jjy1ex/Fnr8e7Um42tuHCu1l/yhG5+Aj0n0inphWT8NfrVhH+bycSnrW5m+/8G+uHqYf7ZiesDzvttXy3i/4/XKfiu636L96Q/rmta6qUSqqT3qRdn+P3aetC/S/R8xnvdz/y/f9n8Zv3nIH/7Ee8b+NGciw/+OV/n+q1623nj353qXJAry8yHJrSkX2JvDT80uHnY4H7esaoWlthN96f9XfDOzN+94XkiqvR/7+nyzDfVEK6Xr22fri/R/Xt9u/H19F/G39RHhZ+s7Kr+sL6r+tr7PnP6OoeZl9Gd4+iKlP19cJP1ZrSf9/breJj9fhLReDettDXI8O7bn6wPgO4m+Olh6ltA3177Sv7zrDe1j9pu+e18C7/Dd7qmkvx+iVWZ5W4G8PTdwX8N1CH13MauIr+iK3jD7Y2/jGTbkM+aLA6bgT/3Hz+/i+TrkwZV0YeuN71fY3up17eFbE/e9/vzb8xzb/cvzasXn87Tht+edwir0cWmtFnSV7hNnfqg1nif5q/6OsR7bhHyqkGv+scL9d75/HJM8EpBf73y+gvWNPq3N8X3JutJE/5LH8+1/tVfYXzjrwF8D/2Xxvbw/vXRBf3pXzs/bXmr3S/tjrTycw9ttoEwvz/q2D35/TYd87MJ+5/ri2v1M8jrYkb1et2R86R/tdWkfrPJ6Y8azuBrxadNVd6vHvbJ+u9bPVrS7WP54+biHAfnzXleQ/xraWf48OraAb4H4kYX8cCqfPBFz//mZ5JNVBf4K6Vc7w8+JX+IjpA8/JT7701/sFgZcb2WK/mmpz4o7js+KdRpfjONk8JqPiOMyrh/23/0vm/G9zMzeYHux1vsg/xf2ZTQlqV/SQD8+zrdq4fyXCtML5KmK85ri/Lsrkuf6G/plTM6Hs78uv89qNguLoPpSLzKJL+cq+mvJu1MkHl49xUclf65FlvbMQH54a+sHp3Cbk7/H/ZbbdH/d+HZ+y+SJ/0A9mSfxBW39q5FY5uEWop+8piaa0oK9drsjX6bge7i+YOMi/5rlW904quN73pFvnSe9j1qFvqI55v7eDeNHmGPRHLnrt1vlavY+ChJf+wP7G2qYL41+xvCH/fXO++mCf46nQma/uUOl3Zf+8lKe15nr84S+NnM8ZK6fesXneSvR/zlfsydbOP4MgFe0UYPdCfQ07QQp/tOy2yJ/StZfHBeIt7STiaivNdS/ynot1ONK/J7PxqYw53qOzTjHTxwz/8j9Q771IvHSLKkv1/EC+y3x9xh/KCT6nXbckZ3iR/J9qb+Y/tL5AZdMv6x2q9R+OfF679/0yzKeZf9P7ZcG9EdoDLg+G/ERxgMUU2HemB4KdlpvWYusFI92FntBbl+yfNKM9HoZ23j+t3kZxK87nL+8PxwzPc25fzLVP+en/WM/7Z/OQHgv9k8ntX+YHprf7Z8A9D4WNXv1lsdDuk9+VF74EfiLe4D8DVHfcXiJh3TqOK/c3u3+Ye+y/pD4pl5M9rjpL3f32uBo1a/bU21oRpp5GvnLOK4Hh/g+xDzKNN4888wX+/ibPbzbZecp5UNxDnnsDEc8L8HHvIR2vLmcnPhYt4DfNuobbB+X337p9/hv6ilCrp+4k9H4Wj/xQo9zxK+kvLaR79wWT2uL6xMknjjPm55AfjxWZqG74nqLBurDPs+Yv8DzGep32i8H9RJGS/XUyTWR+DVZ/cIR+G3Cy+cDSzxv1F+cNdV+rb84KLAnClw/e0O8Naunox1PgNeq6KR/jhrx7wL1a62NquxOaD2ZdsKUf+/dFvDbHPSbNItiuzm5m0dxigpr1WZ+qwDv6+ak/UdxzPLB37B8QP6nzvj7E91O8aV+n29xOdl0XpAnz/4u91/qMeJmP3mtx4jLOV7ZsMD1i6bUr03Wr1zvCv+pbrJ+5XpXy2nYZxXxfFFL8fI9zp8NnKHXQT+YrKcPtvcF7YmpjUb3duewq6ti07RC97acJobp+7sG8ZdbnHyMA9jj5KgT/XZlf4RL/LJSmxWJ37MYM57tkc7HGMh4EuK3lQw/cP7wMJ9BFd0Z4qFfC9QDoh9rcI1xvqW3KCx0SPN1mvNisYB55Cbxl5b0Q9PgfoRgEl/DDfrJrUnaT6F4U808k2umRc1ZScT2PrKXx8hKrKgCPPa5qOTzoNifSPL4toPvGabxCDrfJezx/hl4NtutnPexind2JfPHXfcT+h/4SwnWB7y4ZQH9XuMUP5nofTF5g74tbOpKReV8Ef5/4vo0/zPDy/LQn8D2PyR237TAL23UR20Dub903YK8ue7mthV0LJukYmuixvYl4vlQeb07+cs872OJ+BfRQ4L5x8/691QeCLLPKkPMfyF5gN9jPkTpzPMp5HzsdVRcAU+rPRfWsQJ8fuIv2c8an4AjVeXvu5H9GEehrowrS7u/Hmgh6is66B9Bv00QnEFPRWG3MXGqW94HqmaGYZHks1EstZQvVyd9CDwlhRgx7b8JI6JPZ2AbC99TZP8r0VOb/O3zyG3xPOav4cnySBm19u+boQc8Wme0KRYvmqdm9GF5E6FM0Q8VzlvOPWY827XnN6Oz2BJ9tBOxrJFTOhuGAvNZKug3u/ZQT8D1oPWxS/pAr6uPTfjSb5Xj59YSzNuJouVwi/6eeDkLwoLUX4yPW1NRr7GpZXj7PJ9nbcA+8GGfMt6n1y6T/OB5AiQvuB/EAf9ifvWsb7C8qB3rwNMqJtwfksuLQvn6Dn4XXK+Mftp0nq4l5/eRfS6UjaxXR3zt2U8Vy/lA+fywQ+h93SqMN2IHU7tjxoxfqLXNg/fk99am31Ae9ZJoG6aaqDK/FDA+9xjyqZAgfh8AzzLB8w11AXtBGzY+QsRTrXFdBKPjftMxl8I+dufJ93q2D32V5ZfUfpLKC8brkv2CnH+82ml9xiheF4ucL+L6X/Sj8rxM4JmSqkP8Fv37Q/QLh8kgw6vh77UYzw1NZ02Jd8T2dIz3Wz7Z937E+NJ/zJt0Zf1wLN9/43l3PE+Q/CXoU9S/7Xc26h3rM9kfHgqV+IH7U9heuPbo2mL6UoEHtHPLwNvM65Pk903wfeiH6/M8n1AlJ2D0DrxaS38jemT5Ajyh4MrzX+T/2b6sv2X1Adt0P+X++nE+fzw+BWk97iTevReJ/uQ8FyHraWg/Hvn+k2LwOtDn2kjZZecj9+sD+rk9rhTf5y3oI531tTBsS0H+APadmuJzhF6zWNGaTXFdecLXJX4I6C/w0E/bNNE/agqS33X+vaoDv8FUNwUgtIz3dB7em/CmojDhea6MzxPT+37F14L9inyd90X8aQ7EkKxmvJ/rFRgv+Dn/+Sdez1nahybZdyHjlVliUAUe2K/4Xyle0EnOlxjAv87wKH1ncxum/lOYvn+fzdvg/B4toli6ZvVVwHMoaileRMj+Lyn4wOb+/Sn2V+B6dcO8qBD2GfyL1YzxLrhfxeX5lr/tR3qe9vf1mkNHBIfKG8nXn/gTjMdlpOdN/KOKSjov4ga8Ci/sJ3/BQ7uKdP+teMzrN17WP/2P9z8U5XT/O16/2lz+M/6axDfk+pKr2JB89oQOPLccz/GK9bvD2uY+/PE+xkvbo79U+Ts+l6w3gqtY+AiJX+3xb897+f8L3oeB+vitxfEwOvHbE+8j8290xptj/6YcjCrAXxAq8KW8KhkZ9pLk8+E+rM9fz+f7/eP+PizMX/BGVMbjW4l+sJR4fCbRY9t+9X+y/e2S/2O4jNdgM+mSK38wJT6eKq72E48KpYiT8xOPzyKncPKv+HrbHG9KrtcQepSu9ypqwJeS+BZE79hfIHl2bRX2zj/gyXnAc2F8o3OPzsPBeku/nu/tiZ+YpPjTemTI+lBbXDke1ldJ/dac3Q365Dc8lnY6Pwb57hRfVqul/iO5blFLZ/zQ3/BeVtJf9OAvcv+iIbpRU+ILnojN5jvI3xd8l5/fq3m/fa+nF5yPzb98L/r/0u+taFn8yUxUev+/fW+Sfy/6CdPvvQgjmG6+f6+vQx5t2B/h+n3O79/qm/q8h/ygsrkXvz679Vt97ha7xWa5i+s5rltDuq6gn33dwf9XG1xjHt6a52NZmzY9b/dFv397p+vPKz3vbX6j+6U68cNlqBebhRPdX03wvBc8ypf6wX/zdzmfW0U9QEGgXuCMeoHaD3vJXAWC8Rb6oXEgflOJthVPYzwl0SycPdH8qOG8pgMT8bwd/FeV6d8uAc9eTUS5gfqoQOhkD5ETI96y+iftNR942N1f84Hnn/nA26r0P80HjsQszweeyV62kQ8Afmj3IMTQe0tIfk1isu8QDwbeSfZ9i5fvC07//H2XIP8+q4d+TtQzWSa+b2Tt4vohiP2G2bGz+MfEa2bxD62tkH2IfjOb8VH8tikGLvb7oDaKhZKP/iKuLwy4vtAjiyHLD+f1g2cF+202s/lfM8yDzOvPrG/9qkR/z3oW7Y9+1fNjkvWr/uf1gy/r+RnP6fP8tyy/+bf+ief8y4KX4tek9XZC9IoljgdEpeKtULI18h+nqLc++P0s/ha72P8L48NUegbwYXQL+DBl9F8MUP+pc/8Fz3t3uP8C+g3xXCLxgpD1mzwfUcN8rbYuPg3GD+L9Dc/Y3ynwGa8J8E7PXbKv3pGvZHwiWW/bx/fMyCCaRPCXOkv5f6K39rkt+u0PxPdi5O/niOdcesJDvi/88BPz0+7uN6pQv8jyclv7Ohl8TbI/vKWbzYOO40Kf7Hkb82W4X0/mD7kf7mwq2fzi8Rj1U2wvpf4X6ilC/n4v0CuF5IL6AY73jSbD6lJ10++Pdvj+T4fo7cO17BTve4Hndd0J0VMIPCTZH8n5dK4PO4/tDG+k3E/7sycSb/jQz+pvdgb4a2Yk6fo/65o2uJ1btH7Mb1PWXB/mrueLyoHx3dBPQ5tgawr7//uVQfZNqH7FXc1oirVTV1utG+PdMT71ZmUhviW+TieT5O90GKK/EYgCkxnml65dV+IxH2If6+kEjOeme6I8RDyazqM9uG6Bb12EvIrqeut6OTXJ3+P9mobzQvfTFF+P7j7pmXHNnWXPW++y5wFPEfZAA/WtrdHg3Af+yDHpzWuVtr6vhtm8wUW8q+fzVRkPLfcH7xKvbVdxSL9XjQyvlufthBxfnO1ovw2d/A/ud02ahX2rsOHzLyKelCDfJ0LwM9sTKZ515NyOEewHKykZBXFXbT244HmnUbt38CrEAd2euSovb4mh1lf37a5PWtK+WnGR5NPs1nAuw4tI4viD8bZDXV+G3B8aexNxdt22aDobYd9OPtm/U+2rurz5mNfljIfF4sVU1KQfXxCf2CE+sUpU3YwvLTuO9S35m8viZdMfDpezRiXg8xeI93+B3iboF9PMg932bNXTHVJ4w2WF9G1p3Dfscvdkk329JFthefJZf3K9eKA3K2fOt0j8cq7PikgaOpukt6rVdaVYIn/563GyyXabaqFqt/cb4WxPgr532sb5X73irTGZ4/cVzJu0u+t5VNGOQW2tnVXRDjie+c7xz9Wz/98Qb2x/kFEZqGWn+UjxjWuxktYHL+JT2M/O3x9m/X8v/WlynkgF/ONqC6LPRoHkXQnXy3ZHDJx6U7RbjCfjqhHZqwb87Rj3N28m8CslXp0aO660P73Bov1VR/0Z6kPXiZLpq6Xsb6smesk8hQ/ySMvnur89P25WuBs87pzfC7m/jPE2lstDT/H3t9PN7Hgk/322r6KtfQuAOF+tcb9d4AI/EvPwRpY/UEJ/cLp1w8fq7b4cvDfqXlhHP9a7mEVLu/4N/6L6sPP5CZ64pt/fxvf3+fuf+Bfsj691+4l/UYI/2bAh78c8P7YGPKg+8KDGFuKBoz/mNfycf8H20zrYicNbhfEy/mo/hVw/qaF+MiQruVwWIdEr9yO9zOd08X2mN2O8Fa6XN0jieB3NpVVNtCrwgvrNukHyPoS/WYM94huqr4bczwZ5MOH+LVOT/grmDzB/cL2aQP4vCh5ZPbWN/IXF8t2tTT7k/F6fz5vrXdo8z9kYAnFK5oNhP8h80pJ+X7NJvnlXyIcz2yP3dvfgJfTFVt9cXZcbyAeX5MNneNEn48pOGH3/cGuITvOEeNm73SPJT0qvO45FUpb9GhatpdtqYT7KPDG6tSTU6f3n9exUOSH/OHkUSZ71gbdzctri/2Puy9pT1Zqtf5AXmkSNXk5aETvE/g47RFTAjphf/9WoCWqystZe+z3v+Z5zSYwCc9asvsZ4jcoG2UvSPzf72A/pZJWX5A9d3yefg8/X3XXV1F3knxGvt6dkr0eYl3demqFS1pGPn9dU7fWiYL7ms0/PVy0Z9H0K8syknM2LGtX40s77ka5tWj9XwzVQHjtcb25xPXA6yPD7qtEb1n+ttcHnAb5g1r+q0PVn/2p61Z79q1/6hWv4vV/8K99OyZ+Kep8u+1Oer/3On2J5VxAv9+t4Xo/nnzaKeJ4nCA/ps78a/uKv+p/5+VeB1xGSv0r+src43jz1GNcuh2awfPJXn56HjogSupuv/Oa7tJTXM8+D9u/8vbIp63Xq/Mnf4/Nny/lsR1v1JZ6L6TRm+gL6zOd+S8ariK20c/4nvIoC+HSDDfrbUEVZ1TF/F5Qc+D+Wz/M5Av3RpF/leR1/Pa8v9HknKUMemn7YKtvwp9095+vg79nhSFyA39QxyF50jni+UVY/TZ3nfnJL1J77fZvf66d2r33vF9xiva0kOd5IU7Zq+01S7bVidXp0Eyfwa5hXXdtryF+I9bX2qnP1I9YnU52en/Rzy0n6Q5XxuEqjmqJn8h+4ljZfY56qKfEXlbFlBqGGfL4xDT3gIywCrl/YxjTyUM9ZuGE/2MTkTygfdGaa5nd9I+cFtXY+/+2T09uS/ogJf4T5neJxO8f3OdQadP6VBvlDjEfmM762jE9M/H8I/qAWuQaVFvOrnDa3StRG/nXrkv45oB5ntqPpm9dyyH+hcF6bxkfUUzzUUwolTU3iE/JZVb/dSbj/x01Qj9hsIjEyaopaONmYT281dknBLhm0n23U17YO6RtQX3WSLvDPPoXeDpLSjE5OF/NNx8JLrVSrx/O3oI95rzb8sYEJfFDgU5U67kysFNL/HbMo/LqUh3apr00vZ+BlRmSbk0sr63fwkr2W9b8k0bKd96sFXE/gec/dAPNN4U32q4jX3J8m/7+B9c7iP9T7H3y8u0VbaNMTfm9XbqoF2Z9Ql9eWWrDIJdTmFfB5dQX5Q4Nag/zTwCB/twB8vJVvm9PTwHLUCv9/A3xofanfdN161m/IUvxJvymf7X8fPz7rF4X7bXH/Mt4XN+js5fkSjvvcn7B6L/7pfLXO+P4v50scZX6gI/MDCeNf/IS3FJfaef05DO/P87O+HVz/rG/bt/+uvl185vXkE+SJ9W2EVRjePum6uSL9sPVhH8HneFZ89I+8K3SeqiKaBqm/cVoh6y80aY8Urv+/66nWb6TkN9zYv+b34X5YJUS/wh7xEdtLP4V+nPh+q5zS23Yuoc31ovRwtLg/Z6WK63aj5vi025owu5eWimZN2X8iehV9y3yUJbEPZ25A8RvzG/I8waJ0y+3JZivfz2Q8YubjarA9QX4L9cLXs878869vRec+3wD85EYiNtcW93/y++kV9Fu5Gx3yr6mrkw/8017ablZrpNqNfkuQP0b+zcBLNXp/h+KD7TGieHuk4P+vKuI5dbIrX8S50m1tGN++CrxoksQ83v69PWuMID/63d8f/I6PfpKcF1bur/kWnUf9rZjzr3E/BsfX0eP/T+X7/6Me/BxP8H7to1b++Qn3L/59/4TpbxD/muTPcT+ZxGvTme8W+IuMr76i9QW/CesLxiOZ4HPgMd7zAYmMX9MC8CtPwPN99VIzfvVInw0mg3VV9o8Mc/3oyXoRn7/dsMfnB3iXtF7ndXrvD3agL3snuh9prpIZG4j3+qzfeL+WPvjpV9x/u9puyl3k00fAtzQU1L8tlu8H31w9m88l/czrG13uz3tD/CbjJV/Rn89/pp/8u37ieQHxfv2TfrJ6d/3kf5sXQL6v1XSzfsF5ss/Pg5sYWB9Dv+NTeTjvot17mu+n/3fo/91xdv4oRo9uzB9C/hfj/b7q9NiDEurre+QX19HB6e08ssZvjAe55v7Gp3yj+TXfePU/vuQbF2S5W/J5BoOsn6yD+R/zWV93/rwerUXb+Tf+UI6XNxZDP1RzPCDmJ9hH9/Vpbx/Pg/mjp+fJ/Xcls29j2LcW9vsP9u060O94ft/n/cTk9fZ9vqP/aT35w3/Zr8L4DkkB60GxTzZfKPFPzhrdvxFifyrIx3N+7Mx4VIsy+bNc32e8MvJPPw7HsqqLUWtL8dWgtDrE5RT9CYwHHPN5PGqC+d4p3msyvrGL/gdf2NPILg57A/di1MMoPnrXjd1cBF71in7SULO9ow28aPdtF60aNcUwKYiEfgQerMN8Fi183yvg++ejV9wc+fvFcqNTePhD20GGV1w9Bnhfeb5oP57z75fWObev/k94Dwf943f5d888RrVL2AzO9MJf54kf++dvOvk88XGd4QlVjw08j8Hy/rF1vP2M8cj9qTh504ji15f3t0Isz1v5I++vKjMfNO93W8jzLfE60L+Beh32r7cwYY8c2f87raaNAtkbju/H2ztfO/cDlpEPv7SBb3ZTcrzBLepFizHzA/I85h54udYTHhTy04/zXiMpNgZqk+xvr9spJmO/YUQnyxkqFeDjXSSeyyjLF0yTcIHzzfnECPlEmU8YIj/A82dexs9K+qj3+fy8QTLzJT8k6f9ahk9H9t/C79XQTyv7kULwS1u6s2+ZWX3csKMj1ruRtt+qF1/bN6OJ6K8SxiuX+WX1Po8ZtLHezLfXyPoLcH+1hHwKycO+nebzy77y3F+5ShaQd2uRot6jg1/63m8TU8CB9T2jf+KD+0vIv5rC/7yCL/HA62m6Bp3vFP5EEf2UEfKHHeZz5c8b5A8Bz8CcXmM8D1l8sZLz0T5+fzxkvJce94/358cC98M1Xmn/J3i/DG9KdCq6rGfPxDIcRli/N84fIh89BtZTqCC/yvaV+6utnsLxBNm7ZfEXf6Fx9xeA97tgPm3g9bzd5T2qYv3rPn2+hD7ZT2sU3+zkfrP+hHyg/+Lk6hOSpxnys1DlNSWO+9fdHP1X6I8Lmb/BmVL8WzIp3igtZP828BG9zRD4x9Cnm9XbpuxOO6LrPvrn3KAjCtPTNu+fC6rd1us+UtQoihHv2WuK926RIlrDluTfpd9rgA/tkqCe4h3OxwLjKxs24ruqaLeS8KSknfiI/DPmv0tT/F7cRv+hthy9lqqnvlpNWsK5tObCEKsZxZvjywb+gZeSfI5TxSjHbcR79dQ6BpftvX+d83OX8pX7Ha/0uZ/Pqx9rLewH6lXsTxxfW3m8d52ivlGHPNwe+uaGa8YzdI93f1L5FBIPSZuzPavimv15O0J/lHrHF7ZehRMkuX+iZPOMpqfVSExhTz3Y071P8c9G3O3jG86DqKXwD6T+0NXMHjbveCDbWSxmjQriORN4eJskCTpN+r3Drbs/2LVDlFTX1hz2s3T5zO2n+AkPdzq44+FWZ2S/O/v0i71834qsnhQ3eD3u8hiWy7S+xY+2KMxIF8wac8gf8zmwvPXLZdqfm4jzfuk2+vVU7icl/7RjsLwF0+YXeQsC8BM95M3+B3mL0X/5JG/uX8tb0sa82v9M3mR9aHgIf5C3pPFV3hLlq7yF1l3ebr/Pf/+ofyYW5EPL+De00voD8zPvXprEhTG9L/kzGuMVvaK+2mW8okrjleMFxr8K0b/C/Xoprd+57CN/a3H+CvHpVA3QXw58rQdfkWXgeQPup2R8VfTLlDyuv2+UduYf6CnwUz5Pf/QPLqfrHT/lr/2DQ6R8PV/gt0psneS1j/7cfsVeqW8FpxedS2rRaVpWZNVdip+taqmkM368xIt2n/Ff7ufz2b/Zbv/8/KfF/fnVb/gvGJIagh/Pi77nLxysH+oLRq9WFK0wen/bDtx5XYSXPfpn31EPHKe0/v2TQvq6KEq9WxV8Vhf/h/8P38U08FY3S5zVw5reN3ovqS786XAVHGi9OB9xVWukn1Ls3wD+ZMFdUDxxPYpkNxO0XlWtDn9DgT7DfAP3iy8jpdy647vOkoN+IfuMKHrot+ppqYD4Ef2wZI9V4MMtuH8K9raQtM1kpW5JH2zgDzA+y96/SPtvJo1iqizW0y3FpzX0+yYKkmG0KIre1BeKF3D/v95xh6d43XgbeG6rub8c58p7024M166r61GQ+oo9PUYd4NvZbSWc6+ecr7jgoN9zeka/C+r7PI8h85s3Vcj+YPb/vOx84vtjM8N3Y3yhBfp76XOg+OV4O+8k72X8/yFtexSvzfN68xLrSzpF6u99snCB13tCf9S7W+pVZP8Z+ucpgHm5llW/bQfVRDOLwUJlPrtsHjbjf7oE5Vzfqrgf97Nxv7ddVX3xRu9j8bxRnn8TejNI7Y2jHaQ+Qj0qLl/yemZK0n02ddi3HE9oliTYT4nPbFzy/HCU4n48j3eumaJlKKyv0zw/bMv47JEfTlBv0iyD9HcJz3e2FjdvrrY6+yPPa5yi6NPbCt0OkmOd9bGsR7WyetTxUY86GcAr1X3wWej2ox51/Zt6VOt/ox5F6//Z8rN+iSvk17VaPD8dkv+5flHep3m/xzTZD/H5Bfr4R3091qEv1KzeTPEJX79XS3Z8tTrzQrOmmYXr66zkxkHhWByZEeP9GcpmQPrLXwD62XCaazEbIJ5Wb2E5ZPyCsDVjPm0ycLs2rhOVAphhulmaRtteK8pALTl0fVLUW3yc9DcDjzxIO0gL9P1Tu6XcvFRvqzfSV+IU95qKSxG5v2B+z/Oa4scPTzEtc9cje7ecyvdvy37wasT+1Hf/hvX/9vP4Z/15uvyk/9UT6Xv4R6zv99/9qYe+f/JPhjh/6sN/snBttC8/+E+s7xuF6x/9oWOQx/d/xw/wpP8tzzH735+vHdQyPJCkxfIEf8CLLhKfxcN8Vhf17AHPZ90wb9HCvIWbHGqunM/6wt9xj4+8Y69F+um8fs/zl6x/3otZPnHZeEc+j/wBFf6AQL9Vyni3BvcTz574uOJyi/T7iGKFF8bXixdd57qtsn4SLtnrEPxZMebtqvs4Wgm/if4N1GcmN933XpGfvuNTimTtyPnVsuL2XOD/igb6h1r+I5+Q21uV8Uce+aKqm3//CY8yIRdD5tP6KeeXdODFLloSf1Iki3XyR3nbTS//QT7iO770opXjTyb+vd+K8fiZvy/Z4vNdapH/SkpGm1fBzztMF6R/ag13dQlMivdrKeo7oWlGp7LjKJUO/GdXwB9UeqmQ875RdM6f18/7BzpiluUDBkkgLnn+uIf+gSniv6f+gcw+/G/3D0Bf/5f6B9T/Qv9A0HJyPJMFrV//DdcR5uWf+gdGUh5hb/2WxJceJzvkb/sXXAPvmOtbnaf6lveQz45v1E+bFepVMv7CPG0col+A+ZnWaumRb3XsX7+/Gyrheo34b4L6En3fKu32qD9VUH9auce4tolQry5W8/xs9BNeequL5+2OUpEMZtG9HsX1dPY35yyP4LNdCOZX5/49nvc56X6zFcHfuDnTWXDbKU4jLFruRtaftJDrT6qsP81+qT9pEerHe9VRZDyzcWD/xuCTdWAfT6g/gX/hcCyTWhg1p+jvU7L894zrT6vTvf4EPIRuhXQy6eNpUczD+bQl9eMq6WT+EPhpsv2a/IZP490rMV5yzldoIR69+db8lrI9ba4mu7L6FlZWeqiIxqGJ5+k6C1l/IP8E/WgT1J8K2nvxpc/P72A+Vz+hH61oDbJ+NIPs9Ur2o3G9qtCr5/N1j/itryjpcz6otcX7JGk743cg+0Pr1UX89/mod7C+e/p/5LPk/0cvuX9xevgXDvsXixrkXdzncdXcHnjJwplm9kz2u0k+mvNRAM8I83ovJ437qZj/aYz5Bjl/7R1Zv6ycSOy04YLibQv6RdqHNtmHTVnyMbStaoFe0uiTfQhanG92c3lSjg7q7w2KL1oO83t0U1eEex/6j/OdDdiPVKBf0cN6rdKTKPXR73diPN4cb9zwZD+aPL+cH2S+tjsfDcW7sA/gRx/6i5Pku9Qq/SA7j+ArcDK+BMwbzp/wVS/h/fs5/4WRxImd4R2SPAGPVbHIvs2Ck+QzsPf96vrpfP6KP8X65d/WTzrf6hUxnp/rFQnPx4wp1jotpsj3vT3bH70a8f28oJThGSUDyBfbi5M/Ftq0qeq8X83qTXeF4bL8CWeD+hLqgUWhHI+3DwZX4HmdSLv00S9dMnupWWlwvQO87+RvAY9l0/MFzxMOw/CU2yPS3tJete72akLxxCnP/2b2yv3FXnX+t+2VYWrp/x17ZdrRppX3YydTWh/nFddO7l/bya4lHnguevUocH3vP7GjXivHV4+jU16PbDF/pX8Cvg/z/Up8p7t//uA/s8rKpHr7MR/po59NPk+e38n7K56/PyN/twB/eMP+sAd/eZyQv7yN4S9X4S+biAeuh+jZP/sFXy7C88p4oLt3yJ5tTl/6KzagwaX3ofUO4V9Ny6fcf9bV3J7HcUuod7zjf7YPU4sUNkU7Yn4rnNBP+OhPlvgLbA/4vKTamfQ724OU7UFK+m2/ttyztAfKl/5k+n/0L8DexGWtEValvQn5/L1ff5fvc+X8R96v3JT9yucgJf21fZ4fGCS70CB9z/NKBVFbFHrk3+N9SZ+Tf0/v+wb/+Q3+vZyH7AHf70Un/571hewf435dh/PlbfhDPI+rcP6AhOC7/9m696+SffJPX/pXp9/6V/+/nGdz/3+sf5XtRYand8T8t8387l/7VyfuHd8xstNMXrfwT/qvuL73V7V+6a9aVHt/sjeto53+j/qrbq0cz3RTuz/P9/NPhlA5ha0/n+ezfsz7H/7D/qrp1/6q4SmfJz8GEp/RsJ/50Jdz8KErpUH50U/+83kybsCL1RgfzEl74NNgPBuV+TRumD/UQk+ur6XY3O8eqqavznSRr3+4Pt3Ph8vxpohz/kuvC3zp4Hyk9wVfZSA+/Wf+S7VL+pb5Lg+xEimuOhZiNQ7xfP56IerCUrWe4P1qNgXygyvyZ0ggGjvGA7As8PWqYjNIm+A7UQeOKAzDBvkbzbJQKh4/r2qAD9q3FjVVd1CfxOe0wEYlEKo/9Ddt0dunioxnc/vC8pPnr/TY2PD9FqIZLhuHJ/6SYRIxf0kN/48sSkkZxcoV+B837EeL+Z+Zn6Pb/3F+NltfR+k+1jc2C5ViYRLJ+QLRnZnvd3neOI1cnrLn8/XK/fnscN67P9+U3jIc6ho93+rxfP2zfL4v8+2vo/dX9FcpPM/N+G/5PP0wm+cS7kWNwOdgy34qVfZTzeo3oe0ty7djxi8sq6rELxzLfMWhHbN9uuMplI7IRyMecdCR4Vsp7Udq3/GaeL5kiecNPyJxkfyaP/LTP81fr4EH1VOBh4v5yR3PT1Zv8nlJn43xe8yHNhji/gL9Qe0b//8e8zyZvhomPgVg6Hcl/czzuLpzFMrgMY+b7VdZFPoC3xecT3+aFy4i31SbI9+0Bz/NZi3ARws8Fx383i/vCq+v2Tfhby7Rv4j9tBNe780Q+TcP9rhLrm/Yh30gxSf7Cyi+hD5xZ8g/IV4rDf2BOT1NxkM1fnw+ePBNbtCv54wQ7/K8XZAe+RrxS6+wHu65no560AumlA3mZ4kjiVfdFmdTjDkfU1KlffRFgnwiuT2VwO392o+zf/TjoNYg+3Hi5KkfZ9M1z6JA9uPHfpz9936cvB7gJfPiW3FXnFSK77KfRYH+Q9jcaTG/wRO+0+sI+E4G+HFi8MHU5vB3HvhOUaFRHJDHrgBoluezIU9pW2V+E/YfPPgPDfYfZnIes+7keOUJy08VeMVLAfn2LYknx3w1FJ8dbdgPlftF8XmuL3K+9Sc83dkEfPCYD1jy+jN+M8nLj3jNQ3ken+4/92OJF6m5p14v49+O2txvIeeRtjl+PeOJHEoR9Aee96SGT/xG4+QJ74bWj+Jf4NtMh5x/L+rzgSdSK7hleDsL1VMDA/oW9b2m5YBvZIN6aF9YJ4X8xdhTPnBNskZRuqOchV9S5rI/hPF4ZsDrM32L8Q7zeQuxrfXPPUsTQcvmeaNwkzYj2xqS/Dh6M/HDDfi7TMYr0UWQ6k2KV60Grh3mkyb7dNJ0ur/ihOj/+3q/9o/3i/7hftG3+0V8P8avbvdJ6xqmY8ZVscn4Qow95t+q5C8WnvLVP+Bl6ImP+3f/4X333953z+8r+sCXFZiP39WuhcmdX578Qdyf+eXXv+JrWJ1BefJO9mnH/LQ9xqtKu8CXEuFsAf4yUIXSeqoiDPzNrRkPhBrY3rqilW6HzXrWir39oWy7k8H+FKL/4+WeP7/6mk323WR8b31ALjt5w+FaKPOjJZRR4QJ8FDoPyGej/8x3GI8Y+h/8Q51XH/1nA9Gn+/XofukW94u8/ZYsC93vsq0rnwtF4vcgvuP5BD/D4+P8jcPyC367op7Zt9r8PYE+Vlgf4/Mf+If3vqWE06d+Q+AtbdvCtuIYeFP2ivRTuDt6az9uLrte4qD/iv0vjtcKaTvK+JXMWhF4kuC/s8w8PkgU7I9SWRS3K7wvz6dwfgX1YzeR/dLp4Ylfc5acYT/7cJ3fPPK/w35bMctxhn+F59kcvZ5v4XluwNNMZX8Trw/9vn7Hs4E+qevMF8bzhzbmDxXMH34k0p7Wd6s6ywPPE9qYJ5T4HlXJD+ZDn+/DLvpvi8PGoEHxShX9J4h3ulsX/PJJSgrVcKLCpODy5+lW8WeyP64K/KHD1M77y4yFOd5vyQy0XD/DO+2Qv8J4p8i3aKt5cVfdVtf1tgK+Ksa7OQ7v/kTgAr+SBLqjW8Vh0FJ7u2J4nAbkL2u43w7+U2tkO8U9+xtTxDMDRxHaNFIUr3VNrQHFp8LtxVucl/QaF0tvNax3UUU+iPEpW3T/TtnO+VuSMM77KUnemH/Ogb2pdZ/P1+/8KYnXZlPohnyEUxEFd1t3lu21cBpHG/E0ndlqx6Lr5Nin/R6p28q6YvHnattU9txPBHwWM+H5/n5NMS6nUTrzvKVjUXwq8UIi8icd5iunSLfS6FXIP0p6s0IpZfwi9m+WtzCbb42he4Yq/XTN2ZVoPaPTNPDU3osapnT/evfV8s2Y16NJ9qCpvgDfNoJ/Oca8kV7C+9jCHwfvdMfCSRX6tjpNoW9br+tzu4jfX6Pe4wCPZqDWD++Drhrm+FVxtr4jxh9iPjPyT3drTZ7fDF/NKNQgvz/E958ZnxXFgxbt7yzW4L/0XpTSR00Rq1PC/b++FpU2NUVNLiHq+TbkZcOfW+nU9FifIF/oxS8yn6uPqh9zZTeLX9E/keebtaYh8ZunohpO33fkb1u1w9tAYN5txf2Or7aTzZf5EewzAJA+1LEjSm7wETQjktfuAPJaqg8f8gr8n86M8Twhryus74Tl1dI+xq03yGuBFFMvYXmNrs16qfDolyChBT8Z+eeSbzh7Xoonsucdiko4fsPzbjP9MnnguY0TM8j3I1rZOX4F9oP5smzwMbL+/LC3D/vZm02uvB8m9kPl/qp/vR9XHfiSf78fpG+dfD9UxGeSnxud7sMe3k/B+rG+uKRRnk9LsT5iWyZ9YtF56r+4lpKwPLrAUnJewlgrLFTMz23w/Q7sUeALY3pdi03vKHzFKuzp/9l+jZPz7b7evH9l5JOOIsrj87LrZ/N0P8cvcv3qiBfKkxTy/gOfpcRXYn23SzHPAn98t+mFmT9+HsJeROivr6J/0IkoXpD9g4Yv4uB0LDj1jl2evLrqfpcU9Gj3EicJzmvVacfJJfLo91rAt1jf9E8PhJ3GoEVS01/6ejM4XfH9I3//dXcsmCf6/vFY9BcU5AH/ZXH3bx/zNoc39jfVZ75kLyENj3x8g/noSL9a3A/E9or7R06ki1fP+H27JcdPpF8f/JbXn+RNH/SEcAPgM7j+zvEkPqALvkxhGUJbwf68Co43yHdo0j/SRS/VrWo1xH6y/9JJheR38qIVz7fj/6fI/7sj5FujbD6B9BXPJ2wD4P9tMR8Ws7/E+JqM16oIdW/b1w+tVDqS/2LZ3vhYdoOJsk8i9JfF4rZPwEVfGJ4r08mmiHk39HOP1JMO+RMOfb9I33+94vstb3wtezf6/uVaUD5JyeA8rT/MUhp21OlJ4kMGDWUfnJa0n7S/SWJvSsA7mJG9/Vy5Rll1MC8ccn8R9IcK/3j9e33r87ygiJzirtO88z/95rzTfsvzKJCPkOcRTEGzbQg8XsjH0mlmeC6R2sz5sxKeD2G+ML9LryX9rxjvw/7XcU7rS/YdfJW9F7NUC7uqdaHzOMF5bBYinEdHrU3eBhx/+aeI+cgpHkow/zZlPHDenweebpIw/0xK+7VP73ioXtVs/9JfW6C3avVbyJ96Hw3xGqaG6Jg2ra/tfYRWwvUB5GODxAUeqjNF/pXs9eFYhT1vn6teb2MzHmqxWDybEfpv2+i/9YA3MqT7lZOW6QTJEf7h9KPivQUd+M/HRnhcqcd68X1yyfqlRsnep/frl3B+/uB//JW/y/FkTGJA8b8m9auofgwUv5nhL6likPtjwOt3LoPirtC+x4vMn+lzfbYEfX90pxlfX8L5gyqpQjnf2WK+2apV0QrdvTrZ+lJe3UZzv2F9ZVu1vddD/nuYbINzPBNOYNu9Evm7wHfp8vyQjv5A8wlPdmVUQ9lf2kT+wF4BD1bOi1uLwAtezzHpO0Wt0l7dDuWgj/noWcVuBJbs58H59kk+Dn+BdxskpsS7bfD+flyPwJcZdXfV1T/j3VpmP0iS7P4euV+I31leQ14/0fTVYWCR/h5G21sT6emE3p/kr3x+J/lpY30o9iOZagC/ton1q6YrMYS8ns7cT8j1AIXs6eV6NCo1ryq61n5P93eT1uqV7B7mIxY6zgs/L/z1agHzPYMm6fNXXt9uqNlV8lnw/KgXBP6MzlvhLn9XcXiSP8YnJn1N8VYX+RaV8y3eoTavedF3PBOJ//ZxJf+tOiP/rWDUmL/4Rz5Z0ic76AvP72Z8BkejbYp9hvdu3f1bxqM3ypi3vucP5Xwm9w/B365GadN/1jc7irfVksl4yVxPt7Zhr3ybNnO85DnsJ8+LROH2tRIXRdr4qA5rIpnut8Ey+oR8er0ayecB8un9J/Lp3uUzfpLP5U/yOYB8evTiUj7Rf6b12ynF19/lE0EOy+dBymf7n+Sz/U0+l8/yOZHy2VTv8jn9Jp8lyGfwP5TP+K/kk/OTf5DPddpWatMI9jwSGf9vAUKiOJvaG9kH+LMnZ496Bfohrtx/xvhiEezREv+/fuJT3i119j+qJK/kvxVN+G/f8EFkfwn709w/8IS3b63figbrS1oD5Gsyfwf4a8U195+oOA8K48GNcR44H6hwf2KA89Dk/sS4UQLedx18bFfmR7HeG9vB6v1DhHFNOMVWBPzvNdbT1y2yVwHmL1P/WD4XMd8Q8Twe5H24WaB/uflG/mPQrYjQDxAPRjHZ8zLmkUeRjviP65Pwf681tdG9JOhPehE9/1xxlGpr7WvcHw88smHWH5/Zg/i0Y/tLzhP3a0s+cM5HqNKfb5C/8WKRPSq34R8CnzEZNineIP9rEqSbmm70IvJPX2S/t/LeOZAN+5gf0b82ajPfxxj+aY/nvdY1krc9+9+tCvfj03nmfMrSBV4g17cyvpWauLhcf9Rxv8KdD7u10UpqBRA74DegzxPWd5jvASij4kzu6+dn/bF0PznfiP+3eL2WI0skk+VNeLuy4ysVj/7cJfkSyfN87WzS5/yLh/yLgfxL3/6OBy/xFimeoPhLu9e7v+cPe+SvVj8HZD8TYDGVuH6S6cepeGX9WFJNv0vxf/lamAS9uPg1/s/tddzC+a7e+XQj2Y/ae7ECxP8Ve3CP/y05H+3qPeh/zh+mWf6oaBaq0P/0fBTPIF5c/NpP1W9b5O99wt+rP/F3UAyW6XPDVyvmBc/76PeIm82cz4f8BTEzq3jey81Swsl8vab1rrxV43VnWUxWXH/2m3m/+jbaf8mnbRf7fB6A7dnO3+d4DqzvDsX3YmW5IQf2Te19IP+4I/9b+qNuQ+zD+Jjjy7vjU1SwfE/Oi6otY1ci++CvcE0uacs0h+Q1fYyEt7/r89N4iv6w95T2L0B+dkJGrWdsUA+R9cQyPY8j8wGS36Mr+WaYv+Lf2du/3o/9L/vhKJdMfgySH2P7dT+OhWbej7OhCGFmXHk/kD/tp6g3jie0H2OzXkxGOf/GKjHUaTbPcbzczx/b66jXzOeHeV4sei2QPZ/SA3TSbc2heL1C8edTfjzxyF5wfjzYHe1ekOebRfAxW3J+HNeqWOw/NmeKQkYUVFQefN7GHvNxvP6jBHyL9P7aR7q+FkeSj83A88h8l4N813AQ9iRewXM/zW6psX1IYB8oHjKL5nP8dOfLXTb+wd/RB7APtTTnL8z87+7D/3bEpW9eWll9R/b/nSnAlec3mghh9psBrW9ri3xcBfJqjM7FxBENx36D/jtL+wf9fJ8HJ/3SqpK8K9/l3aqpHvrbCzrqO8fYC7blgPPXXN8ZjR015nlpru9cNyQoZ8TLxynPQ2b1FtLXFvyXcAp5X6RTUZs2apKPw00Enldw/gW9XM5Or0j+LvsZn4v0pQ192YW+VH9jf6uz9wvWl/Mrgvklu1hfnevD2fqGX9fXEbZweX07wJdP+q/dxpf1Xdy+rm8F9uH7+vYjTc4beUkQDL/wAZ7WRzlfoS2son7nq9imzWOCegbL72WXfJXf0SyXX3MfUkj8WM/+03pO8/VcPdYzvQ2z9cQQoJZ+XU/Un+ssfySvtJ6oT6+NX+U1Plxgn36Xj2J9EX7S8zz0BfAyFDvXF+SPm155/awvopeHvphCf+9x/s9V5OPZ3vr+rlguOJh/DXd5fn97pfWrfVs/n9fPvq/f6bF+xiT0SR9D/848V5Sfzrt5P+/rpZqfd4f8M3neEwvPI/Fw6SV63877r/mo6iznk3jWt1w/Jn3L6wf9sPiVvyW3f9/WT9z1LXkZM2P1df2OFSvPl1x95LtmkMcz6hljH/5WNZu/4nwb+bNTAXu5qwu2h4nEF+hgPUvgP31azxDr+Xf6lOuNqYJ+C+ednu9HfTqf3Nc3Al+T1KfmH9eX88se1tfA+vbhD9N6f+dXkfL5cb1A36K/wqipfN5/meeR512n8/HlvJuP8w6+MbPw9byfg/ZXfXrj8x7cz/vyXEj6iTZ58+eIL6Q+TcOv+pT8oh/8h9/r08Np3UE+et8yRuHdf8C16eti1T8ZqP9+9R+cqf/NfwBelOxfsXa5/4B+gtr/wH+out3q/O/8h8Gv8ty9+w8Un0/KvS/+3O0uzxSPkD7fQj9c2tAH3F8wGr8VYpU2qijxpZtNkdWHJN5cWiD5E9/9A7cn9pc4yf2z6jj66p89re/K1Wo/ym9/c/cHynf5Paq4/2/l9zf+QNXtmfP/SL/+up7+fT0b6A+bfl3P6PPreprhT+tp+h3G+zCS2P66nvFHIevf/w/X01u5yi/61gT/HOcvdt/WM9H+uJ5/q2//2r8NB1/8W7ZX+XrqFG8Ys6/reSxZeb6I4jvyb3e8nki7DyKu772Rf9ut5/FG1Lqvpx+GX+KJrVb51b9qNqEP1P050wdR07v9oA+e4gnWBy9DXP/kX1X83B8YP/wBh1Te7/2Bf+4HePKvfqxno9RcLSDf3R8IsT1+MN5MG/X8oQjv/rYiVmcT+JYB7JUbGcI6U0httzD0EtxCXbVOayEaMp9/4ny+VZgUB3XwiVwsTbWTgSX7mUZJJN9f9LvHGfLr/P47+r720RLg2/l9PeM7noQ8jz/ymZQeeImqULmeoabWSlTCdWOd91eqzIfE+Pyy3sf5cKH0mH+X+1G+xMeS/1NZOldEdmrpO79IWSmIYXy94y043N+pCmXWGFlpzh+63eixLoqzovXgC/Gs4/TDvVm3y2JTE2r3ZPm9T9cSilUIuZ73qn28lX/u72T7x3gYvv3aHp7U9vFgKfh+hu8E/cL8WJ4L/E+MCst5bx35HMH5FH4/R612ShfRPq5toZ202yG1RLUs83nAD14D76mAJJ6jRD/8/ujG+Hr4fT/jPx5/6Qfwl1pBvq/fmr65vnU71SL1/Nmzwc949LnetxXFTrMo/K2c3xMNum7l/TUD2W/U1HC+MUTUCfn5T8j3uD/h54U5fu7tGT8vfCs+9Z//ip/H+vhn/LzNCHheX+dpk7qV43meMV++/m+etybOm8rnLcR5s346b/XJ+9N5O16wPv87562GePh1BPunw3+j9+P+RvDDQd9CX+82XD90N1oh48du6T05b3GwNjzPlmqVNvBBmmPwGW8wn1BWTnR+HeABAn9mkulDzGvy/Nv3/jDyL/P5yKKftvpFtc18rArPA3qYB+R+SJXtyR76Qc34aV653w37m+ErAo9X8pn56zveZHdnFoCH3zI2JvNp0PlVwHdAe8D5aT3H/1pbfj4vwf1gJeTzlfW2uKvqOA8W8KDU1Uet9NGPvYk/vPM1n8jsNt3sfi/Z/UwF89XZ/c75/aqP+9k/3a/WWyPeut/PaOz8leR3frd4fjbHO0vK375P8TPw0RxRc/U2yWdTfn7K+K9jiZfRovVxdIX215TnL8LnPVqvVv7/hZXD+0tRpMQr2XB/YEPmw6ZCZzw18nJRj9DKQke/yIF8Inrf4m0hLuvaRIB/bKq4U9n/FJH/e7Zy/BLfV9D/rwqt0ngjJTvzaf2cHX6P81Ex8AslfsjWtXL8uIV8PtIXZeCHhCLnD8S8ED3PrgC+L/7+BfXwCHh8VRP1Ir0glNY+lPOUXrLn/iDGV6hg/2grSf8cgFdg4H6y/3or17MtvBLqKYONIeONeRJZvsxfmsn2BryqE/R3OcOzmyX7U8B8ix/rIz3tuBAJW+KzXBLG57h840Pa6ZunfOg02dUgT7N6unhlvLkBfm/A+f4unk8/3fmkM75G4MWV5Prg/y3cX+L9PfCFpsCbkPOphS3yM1gfR1yAB4P7RzH4V23yh4c5Xmk2n9rnefEZ9KdwMD/nbhlPIdJIXWvV2r6E9eDfe5pXjbF+ch7FV5SMz8nqAk+d5G/e4v+fBli/wdxJ9p236x/1Oe8/6/MtnYJf8BCSGJ9XwSeL+ZWeiBvMp0DyPqgpave6EZKfc5jhL/4bvE3I483ifizwt4iN9C+DRLvl8hm7sF8S7wHz0I1NsViU89CjFPIdP33u3z9fik04muLzMj6PA53xQ/4inyaUdfDG/fDxQqXnqyA+7ZE+rZZPOvwN7ncVZP9LU53rcen22AQ+mRaRfTmZCuM/oJ7loz7C+WGWr+bizldTFRVRGDFeLvPV9IA3dGtoFEY/8IV95u96e+arkfmOseSr2YPv1Jtk9Wrmy3AwjwF/10A9Lz58eN/93e/ziIO3+rU2qV/nRaM4ef2dfa6BfydEv/me+dKZ/xD9+p7sDy4L5sfbPMUHFH8dXxEf3PEnMz53+I/TC/KHP82/BOh1k/KUlDfo/68I5Tql9z/+2M8D+9boF1DfAz8t4yn/2g/iyv51Tc6jZPOSmxB8Al4k1L7bqVO8s1lLPK1VcnAlvibFy77YFsd5/7ecT18lIT4HPrYdlYHXS/snait/cvg4khL0E55fGcWsL4vO4pX7/ZSp9Cd94T7lK97GyFeMO+QvRC15PvJ+MPIn6pi3QT1t0UC8qCK/keJ81WzGi2b/wsb+ZPsRSzycO9/uIWqRPzFefxRKt03NabaLSqp8YL6igCZWwynS+f2o+6iv8jwE11N76UkskE8y3FfI/7VX8cOP00IozerbQRsk64pVqm4Lw04vatJ60/UU11O+tnEd4XrB12ackItTKk63pF/4/kfmr8M8+nEmz0N7Af8VeGgqfe47IfBPu/T8a/i79Y/V2jwJ1P/5cwv1Uq3WEA19g/NWVTs5v9UReOlvqbWoViOyD/1SPVTdtw/Gl7Bp/7letuzNRHghi9scWPCvFfLnRzrzYXJ/D+O3pqcmvT/3D/F1IbLy3yspZeiT5pffO1v332uCX1xsjp5GPlP/fIT+HamMJ0Na7ni8+VPyL4dHMdhFxXA78NYVp1SIrnR+j61Ur1S3baU7PpJY9E4t2I/PBV1fsb6nLn0+79H6FkqYf7j06Pp9SP+/KqH/8Nyn61rpRNebnhgc4iF+b0ffX53ndH2a4Fo9KaGziZdb+XzAq5d4qjrvz3w9L45a8zvercSD9TXGp07VF4P5shaQ56hF9tPjfEO4pM9jMYS+1C2Kj1Rpn7N8AcU7LudDE+Q/mpBnl/OhK/QfmMm6BvzCf9BXP19vVdi75fzn/r0x+nWz+SbgXQQJ+hVKwXxerCwUNcr4Zk9sb1/u84/n1H/SZ8yPR9qidkQ+ifspcnuX66/l/D6/x/nydCDxGnG+2zo+/2H+qornY7wN0i8K82e7mDfRmA8yOTKeL+PZbaI16cM+7KV9gz0rbYBHqfjidZrjITV1RbGy90mmft4fbL4JhfQb1qME/4/sG/lrbF94fV7Aj6TL/DH4Qzn/6z/8Ockvyf4c+5v1vB8pOb7Ka/QTsz0pwR/P8/1aLPGd2J+U/sadj3p4rvn5/Iisj9KhafbfMA/y1Z/I58nIn0D8gvm3V8Q7KfCBeb7sKX+W41MhPwH9LVS6X+8D+Fw+8sGsj2Q8vFWMDC9B+l99xqNSypn/lQxXOd8D4+1F03Xun9Z1zBPV7p/P2d/i7wvgVwqX/ME4xOdbneOxE/nvZH96yI9ojrCcYThm/jDup6ngfFymWM8D7GO3X8v9FXo/it8UGb8J+FOov7ycfq2/rCPJL0r+K/n7RnJxrqJ1eOV+dbYPKez1O9ab7XlyoudzA+zfFeenVcZ+kJeVyxNpsmd52i6+yZPP+cRv8sT86H+1/wfe/8/7/ke8/yXkjxZkmqQ89QeQB+YPf66nvJyZP4Hs57uHegrwe6E/4if9QYa22GkVLY7Hab+G5HsbrWUD/qy6xPMfhLeT/nxbH2b+vAJ/nv9/JRrknwv4585HhtcIfnR6/qZSk3i63rHE/Sr9HL8oavN50L/iyXT4++0B+r3VVK0gHgO/OOZtN4rbnwJPVPZL7uBfVNAfc1lcndZhguf9p/yC9Den0Bfs37C8HiGvLvubr5uS2Cm1tmgg3KR48rf5ginPW7r8PoyPJ/n1bDEPh5IPGP0srA/DNvoheD83mE8k/agkEc/frsFvXMj91W5S+Cjl+MMC878TVeTrlVg53kkU0vP2q0oqhsUS+inJH0P/L/LfOvoLyJ9jvilT+qOyv0k08v6ZfVbv1gcViT+3aVJ8LPlFpTwLU/ILO06w0QuDoZfre8T/tc40oM8nyIfWy1Y7fKovFjvX4q7oP/AEdTELx22sx3aotyr3+dhqNDG/zqdGWf50inwg+bshzsdwA/zBf5oHqGf7/eP7f9lvzv8DdL3Z2GD+9YHna3cbyK/qTdFdYCvn3+vlj/vJ9UywnhU8fyDxyGpKwPy94J82snlbJ6X9DjnfaEA/0Pqb2Xz3GnzPeb+LXk0WjXz+nZ6Jnq/eSLN5s9NpLed7Fdfe4Dz9Ub5Vft8sf832+xQtaf/2Eo+I4z/HrBgq769Pjyf5FjTgE/a5X2+oy35uLzGAX3ItFoqV9QN/8JAuc30EaKRwWVrn8y4J7Afngy0bz/9X9Zl1QVOWZhRRfCJS3SnY261Ykk/U18oF5ns+5fmjJ399H/kfh7KUVxXyKvPznmiH0x78Fclv7xqYB6ljfuB9cnMXjH/A8+wC8UoV9XLXV9T2JU7p/rag+ys1hfMLdD6bm/t5HOP3buCXZrzXOMXz6Iz/jPhyHiN/r2olETrb87ppvQhni/lCyZ/TsTbYX5l/CsSkGMR+fj/hb8g+M//pj8/nPJ6/Q/7irViT83boL+X+SP3eb1rAebGVeUFbcz7n0j3ppX5tq1x9jg8jq9vv2Sq56rfISsmeC9Pp2Zst6XMhZqKW2G1RcoSCz8v3z7cH5tfqizLnr665Ped8kpds/METvwt93l5JfUrn38rq7S0KLEXS75xJP5RlP1NZuP025KXlasY1KE3Jfg8+BF+ProGK+GJSFUptsRlTPAO0ib6PfPYc8Ujf0sh/SFYnUaL907VgU00HEs83tDq+YZtsD4yh6Eg83w3W59Dn9RkKbUzv3+o3sP426auzPoa8JW3yR/uOovcCksdW32R5DPC5h8/59xn/12J8l4XyzH+yT5asr2ZuQVvl8y9Tnh8ie5Cqr4x/V0qiab5enT7kK2Q+Ms6P0lqFHss/BT70PKt2ORlL/CCd4oXEao8LOvNhUtw5r0eiPcHMH/JlUT/pe5zvDDdq04ziz1UcmfQ+Q3/FfBF0v7PozAoy/1to+BnexZX9r4jj+Y/0jtcI/mW+nyX1m1D2jE+Cemm/t3vYB6c2y/srd9xv4MA+zHEeV+W2tA/Mb3FJXs5Hsg/pn+zDEPbBrB4/TCezD4myFWfYB+6vWCC+0Dl/2U04fxqcljn+AcdPEn9hC/zqOvbrOlxIeU0Ss5/7J/EA758IWh/SJ0P0xw85vzqS+pi2Y1Ac0/sr3z6fJElIz6NvsD9C6MWXiNdLXIeTCvsvFl8r7nBQ4f7dgP25F76fjvsJkq8N46eQ3yl63vao0PmLpn4tW9+hUww/hc3n2x8m0SLH89Yp1Cr0XSHxYN2EYhx/eC0tv8Rf5KlGhnXD/TgfPz2VKL585/60LB9qxqaUzxWtP/yVFvkr4rU/lfh2urM+5P4m+b+LGfCxoa8EzovEn5xg/0P8v70ZyPOjlg2ZDwafx036Y/R8mb9h6L3KhpyWXS+V8k7vp4of3uc8XT7pl/x9WvJ96Pm90lUYLtczeF4p9T/8ZsT9uR1/aOX4oGWSV0fyCwttZqxf0b/K9f8A/OlIjJQjFedL/n8k9hTfeGT/OJ5Dl8UwgvwrH+C3W49hhHCeVtxfPjHJH1PVvpK4B8xvlzBv+LEFf0iok/4m/R+0ypyvmbI+5N9zrGHwPgC+B/cLXZQT9BHku2/K/oFFckB+xC2N3sbIBxVKH+BTbiDpPkS9qGMhf0Tuc79/nG3byJ/UnWab8doaaSgWK85HNcGnCDz06uv0Bvw1n9ab1qtZBQCo0ef6SH7ewK9e7BUm0XrY6BRZH3F9Sc7vLuZP9YFhcvSXEm9un4wzf1/6f0FyLMzZnzUpvoK9OxvLl2QoFIn35SZcTwyLNfIn+PfEut3ovB8pZOus7/kua1Nwmp018m1lcc+38fmePPJtIss3i2r1dCL53uB58noyvU/VzPk9rzw//B/9vuUAz22acP5PaEfvFolRC/v3xDe2F1gfPw0nFV8pZf1jx/w8TpN9e577z9e0PSiYBhnhfQi8LV5PXv+I+V3n7G+UtIYXv9/9de6Pjm8Nxu/tDAqN9hLxX/1aKCUsj9yv/9HI8Q8zecvwFGzkYLl/WNv3P88H0r8R98Ph/tGYvj+W+GoO6XsRYH69jXwjxyt7xCM6RTWa9yJeeuUE9eWh35L8SmNy5ehzVe1sKX5zKH5jfJmkdytWVgr4QZN7Pvuywf3MTD7ofU78PnpbK3kG9KlSofPJv7/wrfz3PdzfVs/bDj1C8nYrW2/tms/1fI6ft8VWcfeqN+j5Iu5PBB5L1dBEXW/g97L+/iXwpqbppB8N6X7f3xf2p6Vsm2R/PuBP7Uv8/wqe38z1fxCXc3/N3kB/zNk+43lX6HeSz+ti/4S4bDtN0Uo+b5H51n1+3vm1Bf9H//V5G/vKOnve7eLPz/u0P4M+4z2q+L0pPZ/pG+S/+ll9LpM/v7cvVpbj+/xeMIS9NLL6MV1b2f1a/YKy+HKeC91Jtl/RHPvlZnxAdD3F9VTiC1gUP37UKZ6R/BIcHzUgjxn/Lvg93zjeS3P/1+d6ebKg9XVB/OWzf2ZJfCmlV/f4efj9540d+fN8PmfQl9l8KccLdDALhn+3F2Ij8S9NMgJ4vtzeDnvbGZ5H2nvY3y37ay/9NPPvY8fM++dyPMHM3zmp5lD6O2rqxOTvjK1Jno+bZvhwaqwrWp4fPS8Wub40jFRJPAXyuEF9aHmh9awG8O+akJ962p4nCft7LE/2uKYng+VR8fbsn5r+3T/18Hk3rJmJjCcUnm9uQz7JNemRTEq+0k64Yr6OkcC8dqaP9Go8w/tN/WqnlNjd49VW39t0nk7v59qB4snLReF5cKHVS1fUB86+JvGs59k8hiZ6bzK/mfhzyAvd8I3t4bQ8efI/pknEeBhc/zlhfW0f5xtA2uXjJs3645NTpq8GSRQu4F8M2d82nEuT9rqlYt4xfem9s7w17GTL+9fO9zPwG1k+pORPoV+3T/1YwLPkeK5Dvyf5hqNv8iXzN/V+lM8/feJ+i8pML3js74/wvHw+YoufD/Jm+NnvJccA969s8u8nUt+24c9Kf2qvDyocL1/DcR4vS3mhO810RSln8rIvQ15ClhfwJXgB1ov9EyMQatKnY9bbyf0tUHz7tP9k7ybJlux1c6Dz+tzlfdPEdSRgf4GHsYr8l0PZY3n+Vn/ghIVbdOj9/m1/8I/1hlZN04uB9G9HBq1nE/qN/e8m/L9WWxsWA863SfzUlN7f6WT6iK4hD/d4cpBcOL74vPsfgVhI/6ObpB9pjh8T8vvbd/mI0M8jHOiHk/clXzFPF3m+IoA8yv612JT5lhnJ+xz44Zxv7sM/C+7yS/EA/b6O9W2Z/nO+xnzI8wH+uvz+K77fhnySaSy5FLpTfL2e9IQt8ZXqfk0UuP5iRs2SGXuM/x4Bv8HG/lRJnxYW+0CsD9bBb1Q+KpFSWHhjujZCXFtluu7aYh0K6T9EuT4Dn2N6npE8r1m+92bez3pS92K9/528jpKDD3nd3Nd/52P96D0bldSj+zE/4g65pdTdvJA/ECmMb+8cjlNH53qlAJ4M8qsSP8I3K40N8hsSr2DSc+x9vVDqupxPHdP5Utwe1v/qdPQT8BM7jZfPVM3qU9Oe6Mn6eobfvOR+NKwP8sNL13by99HJU8/8HYv8HWu5Le5q6o3WS0n9cd/8SO/83xx/qhOtB6pFrRRtpx+ujA/8rriihv/pquQEFJzGPT5ZFgZsDyn+Ccn/mqStqVJgfJOI9YGfz29UdMTHqXMRlWweo2cwfxHnV3eDY7jD/6ct2k+H8U7jab/QNwJHJIuuR/GXugtpvWdNhd6vS9cx5g2+y8eE/Xldkf0VakLH2QJevZr3CyzqIpm/vTuVVhH5wX6V9Gnp9E0e2+BL+yaPhuQHe6qPIz9cAv7MvKs1ihv/Qs/3Aj6FuYfr0pXkQ3D+wL44690moc9H3G8GvBfGa03t/gvwRxTm46Z4yQIfgpD9NpZ660v+p9//v4B8Zf+vq3ZfylO7RfpeylON+3fn5M/7D3liPMXaO+bvLsg/bteKfSD5Gmf1xekb3h/4ir/Il8Ly9UrrL2LsB59nRVWbDZKnpF8s9LL+jOT17t9cHfCbKsfo05161UstMjuf15bA/3O9gz4udqyRyv4G+APHBZJfqS/bhlEYcLzA+irHG3aK6IdUU8vtq4XMX7XJX5X+IM/XzJEvudcb7djG87yVST6n7D8qo+Gg8qHKfL1exXz0KhFyfhn3q4uP16SJ9+N8lOzfaMDfaqumsw6X+D2T1Py5EwRqpWEdaD34/HF+7Vgw83rnles97F/pCuOrsj/lZ/NhIfDIYqP0Qv5idl58ZWZ84PfjVM/vX+V8fammJBMH/sAwoPvJ9QgM2o9htHmNUzFdJAuhKhWZb69+DMVO+Tg5WX8K29/tdJzXHzlfuW3jOnBkv9iC8a/IP9Ie+h/+dQw8iVRYDfKnRtxvWhN1IbqiN1iMn/A8p+wf2ccSzudKCcWuMVTzeMBW7vjWXN95XZG81BTIk7Ki99EZ75P9hxDrd8e/tY8jM+fXOfD+sL0ysT+SX04sIY+TmPT/YZv7W/y+pzmuhxF9vt7Q87SRxD0wH+2P9l/qD1k/XmDecsvzVxXUC7tk/zP9gfoxPe765VDz7vqD6/efV5HQ/6N+30E/0aSneLLeWt+CXw/1+1/1CfjZe+3XTml7a5M/WtPa2q1ha/XacdTenpujd4r3Rs67qJ3bgdZsDK94X3umFPq8HsM16RsZP8M+ZfGu9dD/kZb0xXJN59Pifkp8Pq2JbrhQA5IXpexf+vBnS2fB31d98Zq2Kkp23icn6DeF7GnnkEySw7y2K8QvbtPqLij2Z/6HVfKOzyUfibQnWiOzJ2+cDwX+9TAKTseGZWlpq6xaWq20D3Ee4+awVVG7Dvl35C/09tFx+ul6JumLYHv67NmR1gX/l9ATZwv8a+tdjOMGvWLB3Xa2S9s62p+3wH5v18Lg8r62mpFYxTbWMwiwnhHWU8V6+hsdfMu8/sZILTiboeiFI1qsyqRI8Ujxcd7f+tHjvIpL3+J8csPvzhraC+JpP+MLtGP2p9nfyP5/KpLs/w3gVVfx/6lO+mcZVsn+kv7b99OhZYfOJJNXN7li/bqMJ1QC3y+Jox1yP4K5GVjvrrOqnmuh3k17lop5ATNlfxv9X+TyNCob3N9g/JMJ5OO1RfKx3N+gr/G5j99v6yrJj+rQfnP+NrLgzww9yJNJ+70w6P93TTPPt1wj6C+yIBk/YKx7eTyX2e+PHN+c+03229N2hP34uHn09gURYP5A2i+X1nsRxUHHtu3kcLslR6t2SY7VnmUlJJSuntily6aZXC3L773dVPKPKf44bzvNaJ683+zuZ7uW+O1yD/vrxhIvfesoXuh1hFbh/YZ89ej+p8+ba1M85+99pRou+vR5Zj9GzjW0Rvh/7k8hU7INRf1pvtT04gL0jZ/Nm5D/ssnyw5VwPBg/4Z2Dr4/5nB//D3zB7P+BLzi64v9F0+fzQ+ursb10aP9jzK9LPsElvi/tJfjADwKfy34Cxl/j/b76YaY/o0T6r2QvpT0T6XBSef2441dK+dYNrTCW9Sbkc5DPPpntiN5ftRxV5tv89vSpn2ZIaz/jfmkf8xNYL2PU5/7vccLxFdeHW8wHkUK/c37u2DGdB1486Xfd5HwI+KWGiFdelFQtvdpWK1y6K5JH/r34Y5Hpi+Nn1q89So7h7El/yXpZU9bLGsu5rJd1SJ8J8l9Z3uH/SHmU9dFlT3i7d1lvOSuFLF+0GdJ5qFpLso9mwz7QgV71JV6LMwT+N6mxOO+XJn9gbYgv9m/B12E+Twz7dZP1YF/vfrGncSPAfuP3t+Qvg98OePuiLOpvH7i2Mv0SSP75QKdlIsfOz/DIz/rsCa98kEQt/r27fesznyHHg4P+IvPfj6w/2L4xH1C0Mf28Xo79dHheIG3McL6rdL5vZZkPzN43vuL6xSb/2l1MuZ8HeGXoj5H8A9/6t08b9B9LfOwJ8MXLb+ivumDe8/PqJPd4RkV83qhPI8iD5Jf6aT658ZnXy07NgWrG+gvOz3lsdR71sjFtLfSzrC/qWX/GSWi+GRtbzge8bxTmU87wO194vcVEYL4cfLBqdp6S6BX7qQpFFPrtJvA+sP5oMwontaromTHmNWU+ZTGh9VNIbVbEfiNWIzF78neGmbxIvPqPaXb+IotkTs53VcH30i+t99rglDbV04bxHYeIT+kdyiUffBquIjbdlsQ78Yd5vN+uf4iQznyejy8qwIfQ9RyPv8P7zfPZ64EwY/p95cT9I/rIyPPf8vm+zzc+9Qv/zfx4g/ulGZ8b/YVV9G/bGf57mOV7VNS3Z3d/Q9z68w7tV8r5zSbwu+17P0AzxX597xfoCN26VVDPbzzqd3F7mNcz1yzviKejOfoPPOUs+9ttmc8i/TTN5g2r93h9D/3T53qHhXjJkvrQVygeRv+ObvtaFs+GkBclEP6LxXiYM75fxPpUkfMmQ4kPK+uhpqVqw52/dlqddy80Y7YHh8Us909d1scnTfq/l8TO9stk/zdJ3M0ir49UM/03l8/rIF9ZyvUP6f8m4mXOH29ugvvL5Xq3QuchD6UPP5t/iSaQhxHwDOU8NLj9hkuyL+dWvdip7iMnbfXP5qmc9P27PJro/9lN6sX3sewfmWI/5bwZ9pP7c3bpEP2jGR6L/Xz/C+7fde73dzk/5eui5RbXn/s4Qn573j92k3Al+dnofhfmL46jz3F8RX3R5Hq+1R/2Khbqm2ZPaDPS9MhfZfGdyf1Ql6Rxl38ZXym4/u3+ekm37+T51oOZ56eu6TTnx+J4m/krmrCfjqqPtILbxvtvI/H6dP+ogfW8cr/Z3+DfeP+Q72roO9JiKeNBc73gaOT5tIPEl96Fg4r0TzheK+X8OqT/sv401eF8vKzHvurQ/w/+lrHh5/1liEeR1FeR73KhDwXw1tPur/ko5A9WZA+Uf8rXNUafJP8vqP9MhUf6dF307XimkDw0HZf8Ux32Zdr3n/Bguonfz/G2ZH9feZN9biepmff3+TXuDxm8V6GPFNZHTX0w1O1YznucpiyP2+I4n5fP8f0jkkejG24v47e/4h8J5Hxz3F+HQ9xfXusG+T+WWtiSU2IcDr4vbp1WpBW2NxJcvn7rUHxxoesU14aYKu8B6skO+I4knr+V/95JuTSd637kHa5l34zeC4Lf7/OOv+WHeJ9By1FLrpxvVvScD9fp5vxqvjIpyPmv7XCc11Mxehnqequfz1+jvnzVJ7k+utezSD6gT/byfa/99eGAa/m+jReneKggP4lCWinwu+SfK2K8WtG1Xor8Hvx1XIumsm/47XT2UVadsVi9sb5kfzAx8nnfkzhtl5bYVt9vkf7erSUC/rtSJn9W3+T2Eq14JI/rnVa452PGyedmkeWzjyMjzfAEzm28z6RlvblGuXCpHZfdz6v9duxObr5XbZd8s3e8Yl777cb+zbU2ytfngPez9N6X9TmeJjleSYr7mRo9r+1/Urzt6++Nmi/0Cv0e6j21/jDnfxbH0qRy3uT2KHv+vkHnzwIexxHPW3Tay+ToT57mA8ZJUpvI+VT8/0gHnh7L02qL/ST5UZ3Zpqy1zcVKykNTmSrVBX5vugJ/VKN7XNsK5smFR/Gs9LeHRo6vHuXvx/46Odn6vR61x/5bVp/ub+P3rPVSk/dvWo/7U+CP624u3/J5SvQ8/ke+v4lj5P0EgdbcLpv+wKb9tT87tURrv+P5MI/oIn+xGOX+ueOc9WweLeD+sHt9NX438nzTIczXJ1V7hlpY7hKvtx0BH4bX4zB9Xk/6f3F/vwXL3/RpP3a8H2S//Yd8W8u+5GtyhGtkzxN72f3HFM/R7/WVI8Xb/rR6qV0anc+1paS5PMXi/j6+U//yPuyPy34qYCEO5fnd3Ofn+bz6Qsv7w/3NMPMvnuVHZPjzSdLb5Osdt+72H/FpEquP99EpPgstMmVuVXxGNZ+8KvJUQnNK0SqdT45nIz6fLeyf2ujQeVSOFE/7yCf5pl9ctzjemCFfKOVZ0UoDyceL/jM7CrP1QX8Z/OGOTvLWwPtabK+VOtnrgO5fohjsfv8Z9APktzzl5+d6sozHSsNWxdxvooKyi+ys/sy/d8+3JomB5838AY/8R5JHGe/S/ZpDfj7y9+Cf9zct69NNF6+XWmCcPq9P+7Xl8//2vF9yfVcJ+9MyntbwfGSC3wu0kuSveGxPXZLXNetXzgeLTR6vojVVdXy3zvJF+uli5PPfV/y/K6Dfy5jn1vUjnccIn7M+4M+z58m+D3zO+/cv4f37PvhS5fcX9+/z59++n2T2nflUS/fvW+BnlN937t/nz79+3/SO9uP7+v37qZjm39cf39d//b6dFO7fPz3efyqG4pzJR5v2i/vLj8g/Z/qvZRiFefi4HpA+nIv7el/v/kF2PgZ0nl2L/UUjj2+PYpzr7+Mm209yCrLPZ0kSjfP54CTf7z/i6X1cyX+IrdrydKB4zvirebI/8AcBPyV56j8Pw2Guv4yysi50/eC53zn8U7+zT/FRneOjiOMjvP92Mcz914c/FbtFGd8PkwO/f6SEGT6XjCc4frmyP/d7Pgvp7/3Af2MfWR5kfiggf2ZXhH5me5+dz/2Q8SlEOEp5Px/zbkUt5xd7fD8UnrktjzdyvXP8lB/4odRcf7yQ/mi8+lHXePjDmT5UcvvuQB4s+f+vyC8Pnf6wvEtsbZvjf2V4NBuNIqrhz3w/DvbvM//9k9gif8j9leqY7i9/f4TfN/abl67G9eK14isfDsebcj0EyX/dv+PJ7oxnfNkksvqjxoDnfRlvtxl522H5O549aVJh9AoZfuYf4/XXp+ftk78pgA/oML7EAvI/g77cj0lfHsN22rNHg6jinr3qaeHn80/IYk7z/BLzXwMgcng5DXP+bJvXd9Penq3o3f68uWKt1/wDfd+2uR5+HqmFVZx42y3wpONJqouFJ9z9LGL8G3UKfmG/HzTl73O/jDwffF5NzncoIf2+aHlvt9T67NbIQa30Wvz/wtHqpZCUTO4vdHZ0v02C+VnFUT5S4N88rT/L/7k84vyi5b8ZCfAXhmwfGb84wrWjyfxDhl8XlIe5f1GE/9dVBo594PqatnEy/1Xm3+qwn9n9CsMMn0X2XwP/NsvHsT3K+ZJ+11/C+ZkP+j1D/SN/EssPyadqOM98nUnR+NIvmYyz+RrydxejXF98l68T+SOG5F852qlxrrptdf4dj228odCm0nRMsbJDxW/4Z8Q7sp9EeZw32Pf1K+Oj3c8rrrtP55GvWb4yf2w9Yv8f+Q34K87Q8BsB+w8arrfsLz3mn6puR52vTkdn/PY0//RP80AyX4D1eTofa8YfvJ9vXPv59Sy/5vWU+m1Yy/f3cBo9+aMyv5jlH+ccL7D/9mZ84fOML7jGvOJZ9usc7/LxC79Q7Y7vKvUbnlfqy2n/vl8/znvJ/z+80PNb4KdjvMTF1EC/uBccygHXnw8fUj8cSD+QvTYPiH9ixD/BEPFPqFO8ZiNeq7onzD82RG/Xub9PKPvFp3qrkuFVh871wHyKg352PrJ5x1BpZ/FnvOb3NTr0ezxvlerpU/3Ajmf43OP6UqMi8RqzeC2IRnk82+7n+LLRFf//Hc8C84C/4mV+wzdz+Tyw/Ujz+UP2DzI+WIX0hTLgfrDq7aTMV+FW7N++4X8YEc6DO6TzEMR0HsotXPP67NNR7t9wPDOpMz6rvB5l11ucnzh73xd+X+CxkJVthAbkP4D8ixJdX0tDaU+zeTx6Hmf/drRLxvnxvnPwM/T/yR8ZPPSVVaPzeMjPK13X82v2J3ZczzV6Rh6fnw3x2K+cT5P351wb5v5blff/iR8F9ZAG+jXk/r1l+TiZn875mmcTh/k/8/lCHfUO0oda/5H/kflam+OVx/MJ+kzqj4aJ55P2vfDF36Dz85Gfnw+6v9F74M0dRJj3vz34a48lrd9Cv5BG+uPEfAjgj9FSrfLdP7DJzNgOzx8owjFbZWchCgPsf9aPBDzNrL/JcV5lf5Ncz1f4f2X0JzFeyVP+zUX9JMsflqW/hvlW1DNYfhe+Kuf/imVBT19YTnH9imteH+53CDm/y+uR9S/AfnD/gr+trc9dyOOL2lXqoS+A38frxdfg++5hHkf1gk0b+HZW/jnsa+ckRKG1tMqNV1fF/fs1RXTPMfMHfuuPBH9zJ5H/Dzxanld5Zb6p7/iKReSni2aN+WoV+Ofgf90tmM9WYXsUwB5J/DFZfwA84JzrD4xHsO+/dLQMzzZ+EWE2z7R/zOclEh8OeByfct73znf5xLc0VcXsX/AtgSC2Cb5JzeXfZ7zPPfMDS7x28IcmsQX8WubHOtF1BD5Dkmiz9bqLmH8E9zPBt1RnviVL1DRPVcC3FDZER6+KPrmxGb4G+CSAfxmD30SpaebqYgNf6TaJywUEzU2jSfa/ZItGzueTKI7WH4PPzPdn9P05+O4TN9YSN1TM8qk2GZL/V9i9l0pC0cvXDfR34fxZ3JUl3qnoX1oNI8fjPPgO+2P6IKi/L/L+Gxf+Uev4XnyfbO799jHHK8w3wninMh8/wHnN+UZctu8r2D+T8Y+Bd0r6rmhi/rj+dV7/r/CPJX+O5O9ShMn1fDW1xuI9HL85P/BxKfo3Pi7wh/xX5OMiSP6c2X8uH6eHfFwhHyfIR3SXjz3Lxzvtz0M+vGgG+dhAPjSSj8vJBv4NyUflj/KRZvLhRU2Wj6CiJeDnmp7bguSDnhZ8GB/rJZ1qJ2iNbi8iGQH/c28zv7VD37+lpBT3zQbzZ+tW8LEA/8AU/AOV3B+oJgU9zy/J9XkvFAsvb4/5ivOzfPwt30Bhv3pP/owHMMzxzcpKl/t1GK+9ojdLOf7tAXxgMp966Ftf+Lwwrwdgk5wf+Gn/XoVvkjxwvbPeP/eamh+0Dqk1Yn7VdaJBP4qrUWd+liSu4f2ZP4XlbW+BbzWxGP+d+VTAj5S44BdkfrAWrhuSH2wT1MEPtrf5fn2+31/wd60SI2V+JOCRFcVme7SBn9neVZfFv+HvWiXq6qVWqkYXp7qzgcc7IOuQONt4VZfyEHzE6B+AvGCa4gx8zGQarhgPiD6X/AhtPg/FXuGl0sv3++joz/xD/4h//C/43aIcj9vN9xv8KqfP4q/77Sjf9zv8L+13tMb7cb31P9vvxWO/wQfXQz6yFNz3G6MFGjl++uKx30li0v6dPPj/feZrs4E/Bz6s65/2O832O/nH/R690vXwvHO8P53/5YbOf2vmmHHzfv6PBT3np7mmbt5P0yB/Y6d8wn4sHnx/p8G/51uD/9iDP2Hhc5XxF4AntWjh+xrXM18RD2jSn5B4pj/yrUUPfgLrwU8gPn/gW6tvFuIi87PMB/ii6Hl9guUpUCj+67UpngrnsAcFrvf4FKGQT/JSLj/4GaMW+Le9oNHcb8m/WpMETY/eKKX1DLbIDw7AJ/YG+9SfAt86Ah8Y24PgsFnFFvCyE5VsYel2AP5+zo9p7aPz0VtvaD8vSbA/xYV2CPse67Sf3XEokgWf142B+V0L8f9gDn7fOx/bgvnYgH9Sqt752I7Mx9ZJ9clD/i6JyfxUU+Ch/j/q3qtZdWQJF/xBPOBZ8FiyCC9AuDesAOGEE/Drb35ZEkaLvbv7npmYmB1xTq9EUpmstFVZmUlxwwHIVPTE5mf+V3kzDenv4of2SVu1Tvkx6R9bIf2TcAd2DfsHIpMb0vgczs8l7/MB7q0n0h7x/ePNgj3chz5HvZAT1qOprKX/wvdlx/7pZMM+xPNjm57XWd/Xgf8V8EWMX93v98D3Knsmfwn1Mv2a6Fx9e7FI9gT4t3bEfaaxq1fvqSPxZ92S95FRv+2EfH97kVuNx8Qf1T3XM0xCP/N+FetjnejteMwtfpK9+i6hPFDETTgFu370Vx7wc2D8KJ61KqyRH3lvpNT8GPeh/Zh9gnywizLbW7KeNo2vIuWLinh1ki/yfmTfvy8h7+plWm+Of4nkmV2qK8h/z/y5PBF/drgeOPPjSRDczoT82AA/dZkfkS+zVAW/dcCPKbLXc8Rfv/zxUpivcA75bXG+QtbXPuR3DfJbY33dlPKb8xX6Y9jzHeT/ZH/j5ATkn3y170at5lt953EYn54mXZuX5+NcD3GnR+ennov7E8jnnypmTsJvc7xjDvSjipKeoI4/6nW6J8hnH/URuV5nn+TzR73OBeRzj/UD8t+gXtd/4U//7Ef86W/3H/xZWDZEonO4iequIuu3Uvuuu1Hz1wPy05or1Ns6VQTiFz75tQB6yBC9Eb9pT35D/sku2f/DfSOsT9/1l3XkTzY10l+LwBoU7shnaFfm2RbvJ3nOLpn8sd/ms0d+TGmPKF7X97yjXZDjJYeB9IV7UPMnp0L8W5jUFYwP/Aj6LSB0mu83HpO6Hcavnb12dJ81cdP5vJTWj+sxFqrwv5lfXc532yZ8kLwtV/d9HfsT/NzFc9bXGtev3C8/6jUWUI92Vcf6cb3GbTnzf1FP9Djf/nO9xuqf6zWyf1RQZuLSd1Ef3CKx+WZfSPu/GGC99wrwD3nE/O0iP5xXDe8Ljv2l0+F4EuTH5ngm1g8W6m0K1NuU8epb4Bf3+/k81N/XoH9nrrS3umxvXWBvVTnfIvtfK/hfZfa/fuVb/H9Qv26jfBXSHj+xPV6ePxZf9Ktb/NCv06X40K9VqV+1/x/o173UrzNBli/ZS9n/e/06HdYi/Tr+H/VrB/qVZJpdzbrLQD0XSN5eEE+tSX3qQH+G+jRH/Oe0kZ9N+9Sn26AFfYrnXazPf9Cn+/9P9OmV9an2D/pU/At9OmZ5Vdf+qk+PNMp3fbrV2/+bPk2E+nQFfcr5UlX2hy7Qp3XWp+wPNdsyPyLyo/kT6NPxS592oU/DfI7CqDz1ac3rdhvRfkl0Hx77l2WpT/v+yWtF+R7HuJ8wd9ui1k3/BOqB/durq5mFvaWlujnVbkT1hSuQv7L++P5Vf9w3qxmP5K9F9EH0a/B+mIf9FuT/dcav/YpDbuB3kN/Fd3fA74Hr9TB/s7w/jjO7XMfVa/7qcKwu1hX4J9U28XdiP6H18bu2eri388iP1iP6n0wJLqzI37Q3BzH+pT9/uH4AscJZf/FTxyZ+6qBe+tFHfLom67tyfj/Qo0K82msVVWMu68eqg3P2b/sv7D9dvC7JL/a3x51zxJ/HbsSft/bZrnqVsWMeCuOi6s8Rjwz/mvOhdn1ft6PzvvlN5k80C4e8LuNfx/6B9WeR9Svsq9OLn7du8cnPJuKfXcRbOM2InzdB8a/8XI3xc24x+O/8vPof+TmfZX4uR/y8XWlf+Dn9z/bxxT8r0C/O3+1j17Fxfwb3t5g//D34+3/g53+oj7Xg8/w852u1n/kOw/sUcj9TQF8GVX88H2D/tsrxJnfdx30OWY/7vFVcBfFZir/3mtH94k5A+K4Rv2lThguAUSBGI/6/zX2ORztoP9K/2vq836jqZCrWXJxnlBAPtNyVWF58xJ8cWsjvAqNFdz1636L2l8ch8l03bZxf5GT+9xvJIxv535l+YWaG50XL8Pz6D/nrV5tMqzh45tccy/xofiLK3/KX+o+C7EVFnlfIekMC55kP7ZlP9V/tN8t8ukHdwHooXI+i6b/yrR+zH+uD+QQd30z8cX1MJaD1cb+tzym2PqdwfbYy/7N/DNfnItfH/Fifkb9b0/pMU2H9Pnl/198rz/XxXutj27boqUPos4JwReaO9bE9DfHNlthODNR7sXF+5A16JD/1wBOJab31Fm/w1/0ayBujqYfxeWOf6xlckD/7uMH61S6DKD/sP9TrWj20QMj10uV9TNx/27m5KD/ysfpzQHyDMvnLfmHJlfm15flemC91+y3+ocD1hm7Ih/B1/a4m+KsUfFs/N7Z+brh+Y5/jJY/XcP1Wcv3Ex/r1/TPzl/M835L5U8/5Vrh+F+LfcP0C8Fe9Dv4agL/GvH6oV3uqVW3lrHZ0wsfX/fWDlTLOhfs1rN83WYbxxV1/qyiED1QAmFueQfhoEPxTRf9RPMNf2zOJPn7xG2md/8ZvBaYv5JMFvyGfNfGTzHfrYP2ynA+d69HYcn+XnpN8MPzdwEvm56zfSX8sq6Q/7Arb88cl7Gfcpxn7Fc2L8sOckA+tSPSfZTgBuIvQvWyJ830in9/RSMh4m6nP9nlHEYHocP7Aqw1/64b4vJ5oRPkCuD5uH/Rzx32cCmqLd9D+GPmxDHIUiT/7gSUaF3ca1dM2jA3506JB8HBA/GY4KfKnc60oXikR5N7iHf9a347km8B9EY73Jf5ag97yHI/qgP+24L9tmO/jn/nPrX3jv5KbivjvT/FMCq9X1e8/9YXn0Hw6fejPPfQ3n89XMmKxyvbccnAurlfkb1mao+WvwcgqgImMbqw+SFTPBPn618ivZ6H+xr1ZKRF/Vtj/bA+OYmr2tluL+KUW+969Ee85/P65qIqWbu1H43EUz6dW/bRmv8fzHW/w5xNGosj0yvn7q6BXjfP3V+R9R7V1S6QKuB/V2+d2mY5hb3AeqMK+SA5+uneSt2d7vaT5kbWm5ZGuzw+wf2/zfbcgmUxu8jjv3w3wfUEdRfkXl8i3WxA58t9UWd+e1m8SWDIew/ez4K8FzidSJ9RPS6IepR9wfY1nfbMb6ik2+XyyH9ovH/m/E0ZSl+dtIx4/tSeKtrr08r6qRfFo5x3qQVRyZB/hvL/YUZeryqGI5zyfFBlx6f8QT9t2uB4o6GMWHERi4arG+LJVbMWJ1oPsgznmJ2g9GqbcX1BS6+MR9T/qmN8G8Rip8QtfB+CL+K1XuKNeD/n37qomcB90aqoSf32/4+ae9xXQPsoGnM0IX/1jHvgyuf5kHfZhMrCGhURZ3Vae9Xm6/uaIfGC8/nfOl7cuJn8GzK9j8KviKKLW7/4d39/rycn859/qE4HequSvET7ZHjzMMP6w3ifkrcx/vW6rCUfmn60h/yzXK6jXZbwE8sOTtrvZaqE2E0pTzayaedJvK+SHVq66KuWbi3ooXbbPYK+H8ZGZ8H6j43uiGcU/sv7adBM/P2PlZ7furhrUHu6vjmU8AesXmR8c+c+InnRxXrzuO9exHuZKHTZaB3Gr+5alW7/rpZae8XOyHofAfK7P8yQvoPE88SdS9Cf5B4ujjUSnQ9FTEmnUi8H+Zwv5Y+enDvGfrwjttlfIX9BJtihGJStEu5MOFL1X3JN8OGmoD1k06+YqsMg+OgXDgPzDuXBWWWWlHF2N6E/j+2E5negLoXf5ctES0zHHCyzEKn1EqCH5O2P6vin9o6Hyen6Tz1V3BPsruk/prPj8cLF0jZtF9NRTimo1c10hf11V6QvnsilZh1My6OyOlp1C+6oqTlfRWRK/B8QfOfijVfI/by7q06pFrq+D+VYDel/d66JVFirZo7gaqTu7Kc2/NhB6e0C6q9gJ6iSfj5hvTaxoPA9lrRwq8PdqU9MyXdTTsVvgB41MbY9ICfgOXOW2h/yh8db65xXn31N84Af9LxSaz/O5KZ9XlS32u/HcYn8O+6XLhCkGhgb/uhxYx3FgYb96bwyVTmGQWm0fSaU6Pyuwp1VhWeq9qFTVK/s/Dxf72XtDtEwF9aNVtHdxNa2wfwC/wsZ9iLf13jzX+4j17pzMmrk6Yb1p/qdwvR8K6tgqgtbb5vUm+totAjucb6OoRPN5zbe7UGzj+bya+ct8zwlDDMy14PpFuj/OWGo0X/853wvf178LneabovmeTcCCjECvQ/ZFfL7jvfmkJ9eT9Vw+6Kt2qAciX22nyL50NRV7OPbWB//89l9Hgy/1dTgfWng/FfUHG0Lm+9H8ZU5E8Vl8v1zWx85o9us+u/Tffuv3HPwrb32aN+oHyKNBoGjFlausKvsK6nm2HhtRyNSR34f7Hy9uxdSjKNqLmo/9fJL/1THfR674uL/ZaZuV7cpQSL9v1MieaSURb0v+OOTLlP1Pmd9njPsCiteva7natJs0tG6jdbNTubpSqC1U5aJmxk3c51dlPn2lWXNtq3tPkrzi+mSIb5vpbB8Xdknk35q4J/LX1lO7UlvtA/WA+lveUFf1Itmc7WZtLE4yHvoP38t6eRyfKOutsX504G+mGf9hvVvpn/b9lE3tmQL31dk/RT2QFIKEo/up6L8f6cM5vu+//LMO6o8M/fVURPHQpWVo31b3+3D9+v6KTLhKJymWi6OF+lFS37usn2xa/4tVQ77AxCKRvpOUNtKc3+vR8Vr5oY14EhX5/vNqFJ8l/WmOJx25qcjeZf/kTvaRkYzF+3ZJnjVPqcBSx+T4yPOB6sF95hvpvPKNdOo78ufC+RK/Fe0gum9uaOLN3qvuuT6zKnQlNaqvxNhjfrFf+WBf8cRh/blAxjcaHN+I/Qfkh9rg/LPdUpmefNATxzcqfL7R96V9U+8K31NobUhVkT4UVitRm/eS+k933Lo1UwnUW5X2bA77ZYqL88sf7D8MOb/WCeufA76RSszA/cPxnuMVF0FFL+7Xl3mpbhmj4nhlc/2e5b1yOGQ9tTN+6vvy/oB45WY+l8ptE3alkhRe614VprW9uMhPSPyF81lbpObuBPul6H9uzxJ8/lTYcz3OocD5xLrYPbcOZZm/vFIo1ius32j8LsmenlZXiJ+m4KdpUNufE6JM9l8K/FQ2l8WmVtSMxEmBPNM5njCKv2/6ec6PxPnVuT/4Dz2jruZqs/01q3Z4fiTP9mVrwvXFZbwc8imlLPIvaX0Vr307LDRXfo/9Rt4/PUbxzl1/DXrpcn0kPfmzO9P8YW/avesR+8G/3j851ej9gXnKNZvuRPof6yPXpxNuGfubMp6zjvUj2Ew2N9eju1gne+L03I+M8pXrBVo/5E+8hvFTVXm/vg35UIf9vcjBf8R9CX/qrUR153Rd85C5WSF/Qp7ivL1UgTzt8H04nMcj/vJ2Jf89GXzWy4rb67H7+eU18zPn4+H8kgrWz9CIPjNYz5EqZqtsTpjCOQAftmWTeTAUI3EKVqVphetX30jfWFtXKIuJzMfxr98/1uL89g/1O6V9LM//1+5iVOklyz9dw56Kc9uuML2RvdYgejzXYJ/3svB3SpBHE/IH56cT7A2+33etOc94A9TneN4P7vvVgOQHJIPSDv2lilKk8Xp5uT+hYr2UojAS5xPskR3qNTsnk/QVy9NFcFCLW4Hz3wHnu33lK9qoZM8H5X020XRNwj/Xq9sh/8wd9Z5tXC1whgryMQnUEx3A30M+5568z874nVdpvDOij4reX6a0XGM/FYmWXov2E0pv9aMB/2C8yGiqtIn/y3chzO4W8RTj40qV+Scced/GTyVaiTTnS7q89m9l/MW/ie/7RW974KsQ5tNGfJLC94PTJLVJvl9OrtBbBZfrcddb5ev6Jf9t5GOohfXr9hzvT/5++lWfvl62r+/7BUw/f9mv4Pjypbio2bg8bNgkD3ev/IesT08D1A/KPPPvynwdr3rs+wD0rWB/qUzmeOHO683zf8vnk1Yj//qKfC29PueH9g5aeB/9D/sfz3pg8f0Izl/UieVDLNhFkejsiotzPYn7dDWS5z3L0wUtRVJfd2EPNO1d0WnUq0lj3S2oU9Gce0eheVbS1Lrq4rZHfUqh7fawF9XWLUgFx+Kc/LUGwQXtJJqddbFD9hrkQ2FdpO9JtWqej/aqyZubSizL9P2hA3uzRe3dd8Vpo+V38T3ZBs35nutl9Qi2bf2wSnD+oy7ouYX6D2Od4yWqunngepRig3qm1aSpdjlfbID9D3tVkv5rBfhVef+r40MfbATnj0/mAi2XDKaQl+uoXhatf89fDytR/mWcjyccmc8wVu9YidVPe91vkfTdgT2T6DeLqFf4db/o1g/rO9qf+5muqET5CHAIdqY5QD6S/j0usR+hIJ7nmkV8rwK4tbfo+QJSUq2pg63r0vMTjUe75ewm6W/ej+T9Z82O8om938+ZTWzUUyx2fvFnodPMT0hfCPAv8ssaRT5fUcDfMr+syfb/qJy0g4Gs/7P2KtF5cfw+tMP5Uv58H7pp69b9UdSi+lRV3N+pkny5ulPkh1qhvqusT2WDP/5Sn+qB/Z/Fqz7VGvyVeNWn2oubllNV49+2h/oniP+N2rNUmX9fyHz7Ltfj8smX53pNBFvMb3WLk6ARoyG+iSaVTF+Qz1y3Wrhf0EwXvVVUn0v7VZ9LCbwwn8Retj//1+1X0X6X2/cUrX7xcd+qY1P7Gtovf18PweuB9w/DL+MZYTzI1z8juE34Qz76qof8/nuG/z0+98Cn76A+As9nQbJU0s8lZyEfvazfhfphsp7Y8Es9sX+iJ8Qn3wtbLRof9iu9gVWJ7DW/2jdSJ/d0XFjWuvhz9/WfS9H36rS+FauVvfvqNONzvnyT6KWbE2F+psbB5HofpO8m4X6WVVgkyPy2RYPtYf8EfSnzU6q39mJrvGA93W5timqUf2HvVT/zIeuldsvj+isz6DODnIJKO3h9b47s5IZhWe9Q5j9uy/vQ8n5y9eC/3jee9+dHbnTeejhz//S9gfpoqAeA+mDIr98OUB+sIG7lnK8C9rheGOqPGq/6dVE9MeVVT6zc1vG8jPrVXsFF/j2s526LfKePw3DQmSYK5+KucXosqo918+c+G2P/dyiSs6q73CUOpB+7pB9F70r+G+ozwL4mGy45k/VC+wHn+yXXbu4orto+kwXh9chfaF6U5LXk4HzUqExNUTO2C+QzDKxxIVFJkD7gepReItNIUf+03l3kEzpj/dfdBsHO8fRz31R/NsXdGPpAhONxMB4n+RwP198h+5zHY4vneNIYT9oLxzOX48H9YaMW0Hj07Zztv/q4kKv8ROM5Bf1mat1sHFtv41nal2Or4iDfadrKXv7LeCr238dzs7HeZE/WytuZi/00fVy4V3LYX9KDVc3Qyd7q7y7zRlO5kn9I9iz2W8RqdLBmZC+nsgP3nKxrhdosNef9j3y0/wHXP18upJAPwIS/d+b7+ifcT8L+4nGO/Uqy1YpwIo22q9mSPhyXxl4xarw/Q9q8aa9Jv+sLMpluVVEk++SWqOYvi6DzOAZ2TvToQdW8mJqryP0rb4/4kYPc3yR/rqyzPQ7/9qzWM7jPRi477/8S+sL937KC+uCrwVCcVQ/7gy72g3k8PtfHqApHvXcC1GN1sZ9pBbbSLt8dmp9bE0anvlhdJruifiqkdMAO9lsV9wR/D/tNVcTnVclfLA4RL9ruSfsF+83nB+HngP3XHNFPTxVlUUO+PqWjYv/UOaEesIX9Y7WuC6dd3NB49/BH1uXccZtPKjWid8Aboe+rqSH2Q3n/sIP9zo4n9ztpvVvwn83Njdpn/NjwzxXYy1WuH6G6hjh53/ozLPgrr/6uS5zHcH8FPq/62l+V46N0nfpzRcj/jucpvJ+tv7evW7ivttrlDtt0UqleLkvcb+yh/cxQi9r/2M+k9k2O15X51/Cc/XudZGWIP3+PeoBf57MHv7zmI/cXeD7FofjTfPg+o+xvz+1bdacp3Bn5F/uREFn4c9Px2aP1z7kkL+eIj1sUVbN5qo5s5vdhIXHAc8a3wfqU9cVev81rao/4bbwl+2btIP/Zppo5FZcdkVzU9oj3uIxJHmy2JA+s/Lr+uDfHyU3xivoHe0tv32uqg+99kt9GBfJ4gfjoyVxjfXobHC0D/KOWFwWP7MPd0SKcJ9jf7HJ+qxziwzifXWWsYr8BR7s/hOaKOcV5zYDs4UIK9Iv6YMI520Nx6o9WNJ+ekoS/T/7qlu1lqV8gD2s0/8u5iv34cmi/GeQeyvu8Sy0R5v+lQebPqDfSTVlcj+oxPnB84QT1eS6rIcaK/eKT2zGGJ2fqcD7fqb/RK1H8eAfyrtZ9NKpbrt9ncD0cxOcd5uTfOzsb95E4f7KsL3Nvq4mxRvgyU1gPi/fHUa/36GE/K+/WDd8P9WFPy2WIXzYK+WKhv8f6B/oyrK+nErezf1bwD7BXLNRjEZyvlOOnqoHM71yu7g+wF2V+YS/c75k/n5P85uccX7bC/Dp71Icy0J6sz9JHf1qAfGQ61zeDvFT4fvup/KpnYqL+D/yFMubP+/Ee338vYn3HMj8g2SM7/wXDHtktAct8VLC/2nuZnymtJ8ZLWR+G6IvrC509K8rfOgye+U5zbN/ZHeFs+D7Vmz3qwh5VkC8N8shrjxqtgifpQRE5zkdakfWkX/WEaxuxJ33WXKOe1NPelPbNSfo7yKcg48ldsxLmy/TFWdrnNdQ+lvUafF4v/j6sdyWe75+e71t4n+yd0J5f83mFY0f5mA8yv4O+0RJjoq/rUuZLrYphlM+6r3fzNudrrKB+qCGi/G47Wd8hWK7aJvKfls/rKD8t54t2H0YyvyhE9ZM4/3HFkPSaVtRX/uOLXwmifNO+C/ole43sryHqf+3D/Lpj3/eArzTX3+L4IdQLRH7VrT+w3+ufNWU839oqf9Qj2ruh/V1u4+AJ8azy/iS33wvz8fL4M64b5nejr4j+y0LyX7nqLxWc1yvKpexz/V2u71Xg+zri+dxv8vks6qN1w/qjU//oas5izfXZhqCfK/xVn+v16tL+JANcH6A9su9Qr4/zW5jIR0b++QX1pRqSX+7a6MmfNn1fZ/lgPeuf8vg4/56s70321Mhf6sCHFebXGrzXS43uG5ngP/I35HmAKgTqXUX10ba6JeuJ1iL82aIm5RMMI9Tbda7ucC/Mw3nYgD5AvQJJX2X9xyP6alY3ElYMIenNlfXpy4aZJH/EuAYVzr8/1seeI/Pv5Gyz7XfqWX+soh4M9jff89MMVBHex/Q9Hl/wKS+rvB7VGD1xPOFi/1Z/oy/3p7GfsvUf9jCK31wpQVSf61VPlvy70F9dM/1cgkYngXjAqP6saIT0tWV/XNafNWn9XX6+txrDhEVGfnh/lOs3S38jj/HaoT8mkJ8/wv8S85P7J+WUEM2xu+b6zkQPW3cI+f2UJwXQ20o3Ic9SpjN/0ed+rbhhvVJfp/GsmP7keoL+RzI/tik0z9bNKF+yAD8oG1eMab3TtRySOPm2pE+rm2kjVaof0ivXOxb1PujBuN5kvqu6Tu3J/SbUO36tpzl7ruexo/UZn30/GYT5KavHNPiFLAvU8wJ/jJ71nL3AiuI12wHy8WK9j2fFfuazrNhJ4H+Sk/JHRPXGbauj6AlHyucqybeBbYX8fkhhvBvVGnltEmotdeoG93a0n0n4826txID3W7a8P0Hm1rYdnW+UI30M+dbFfo/Mv76HPTB3ke/vgHw3Ta7Hy/x2gDyyUC9Q5tteQx760zrfbyP6Yvk2DYZhfcQnP/elf+Tvke8HhmtCG5qRvYLzqjA/8ViJ8oVyvRy8/77eE6b/s9VoJ/g8ilgjjfrIddJv6M9fijT5yy95xvSbgH/myfUO6007ieqLHsvB8JVPR9ar7Yb6ip+TennLn9n059F6j4/dJz14Er970WkLux/W961azI8W8ZvigB5TLo0Xq5oI6XH4b+hR6MZ3etSZ35PP81LfUJ75fKflqN723HUkvfly/P58IeMNCzI+ktZnKtfnyPHNSdeJ7KXut/VA/cQE8Vy0HqzvXMBj102vc1f7mV/4odhRvYd6GfWGc9CXaJ/m1yP5hPg1oRqK3y7qneYlDfyIJdnLoLexf3t+f4Y+kPtRXH8U9Ocf63ieeNlXfD+K66mSfCL52VPe8oOZ4/0+nE8XpTuf+XNDfa9AfwxD+bV2ylE96nd9YZG+QFljXj+S98X25Z/XT9fN7+tXbiru2/qN9zclytexrz/Xr/Kxflu/94f1k/vLtL7P9fOTofzss/yEvfRg/RnK99Ve8o+eTPsqybOlr0T5gn1hRPzpgT9rXfg3uG8DenYSQsZPWo55KAdtq5AMMJ487q/5NvyJPfD/A3mIUkBYT71wGCv2s34h8Ptw092clH/uud3yFPL38x1tRvqW65/nwvqYpC934Mcsw1wvJZIHUbw9j5fXsyNm0fkryx+eX8iflpi/1d+ujVnfgj8FDRL6AvSF9VaWJ+GH9oCiJ7/bA6u9e8NBJefbbBNlSHtgqJfp/V2jsGX7kOWhrMci6xW4kb6Q9Mj673TC/uKbfUv0s1i5yM9f4PVje5LrwRP9KKkO6rGu0oL028u+9Hn/Ggf9CRP7Mc969dNX/PFc4mttG1E9lL4I5fXY7zzpheOBvsnfu78fkvytkn3YerMPWsWnPD+ivSrbf6/6pivQc+jPOEbkzzjhc8ffWWaUn7L4tGcOCteHdsPxFY6ncHw93+P6QHZIr46/Rf8drqeRHJw5n1Ub991RP8Uocb4r28d9IPNQ6LTKMt5e1jP+tK/nPuGX7CX9qT+k/ZULx3f3F5ifkS0lb9Ov8aJh/kIz0vesTzwL+y+dROtVD4nmd8F8VlbFTWVWE+Uxmigi9BdXMh9GoFTbSHu10SHfrJkSxe/L/hbYTypU5gvT1fUo/pnjRVesf65KVI/BLSNeOP5+Nvb+Nnx/4HvJZDS/1/nonuVpbfFIGvc/5+9NDi5JPv+X9TSQ3vTqtYE/W5H50q5KGD9Qmv8kcN9KeH05X1ertg2X67HAH3zli7u+8skNpf/sNkY6y08+/6XnwViexxaD4jzReuW35XiivVfl8wmd/GG7JxIdGm3VW5BQwH6MlrhgU8vm/Vs+f1wKyT9CdLg+nsv1ZZCqqhM/z37N1xSKZx7quA+WfI3HQj0czK8m5y/nE4ufQvzt+MDjy0N+a6Dntps8JK1XPl339T3ZuLast5YSrU3Sk+fp8XiRZ/68hF0rDSv1ZaCuajklIRyuN4X9fK3TAD2TzWrXKvswPjrqT5D12Inj3xV58vfArx2ZL8AO80VW9y//S65HUiFud5WKuAzNqj3eang/T/gx7p5r+17FElxvwvLXZA/SywbNv070bjTD+jPP9nRDKN0XvQwF1vOgcH0w3C+dPsfzcP84Ho/HI0aKP7Sa1P8+fy0OFCw9KXYan6rT9858kjSS7/M9iETb4fbx/Cre2h9+tN9B++/0gPstpwD5IEUH8ew8Xj6PGz7lw5s+Ynq/ET6j8Whe9dC70Hgysh5ZjexXUOU5zj+O5J96mC/U4/jz3Vyxo/On5dIc6SI5Aj09+U/ms4zlc60jfnqvqNF5vKxnDXqpYj/d8VKWaL7lt+b6utM/059g+qP/qw04HoLpj+RbC/edonpPR8RHx+n9N3/hPtHPE5+7CsbjKrQ+g8heAT7nH/hEfjajxvkm89rtkUs0igL1WGQ+6uYB+YQSb/dHNr284o+WW9vfOibfT+b7U2n7Z2cq0X2Uk8B9BOh7u2qTfd4eeqIqz/dKLtHzJYo/4XjOIeI5zTCeU8YrDJAfOJdNqYeEPdMTNeSPrOZ/WsWBrCebQH1ilg8lF+NjfFq4n0H+y4L0MfJ78H2e857gatGI6ot9zUd5jdHzxDL+RH9d0J/K9aUsh+yxu1AtxGiBfsuO2lFJ93qE9aq1d5GfKswnWke+BZyPq85GQQ4GVZuq2H+wOR8m4ok2uTh/YD234CcL8aflB/Ipu2olXM+OqNJzQ673hdpn/eNq9HxBsoueN+h5UdhPftQ++N3dob9nvecZ6vOqqM+roP6o8FGftxnedxvuUJ83zGdG+mI5p/XZI95yS4zjjw6X9ng77Xnjg6QHpWH/bNZf6WGgjyU9bIvIl+zmZLzaMx+pLfOp8H437oPx/bAh/Jkd7EN5n3OA+7dEH6gnjPtfj+uzflAO/Nbdk37eI56uTPiZ9jmeaaHayo3rY7e+6Ze99MfsMB9yWM/HarWFt8pBvjK/yf1opWcnsYmspuLy3+L8BaqwF56sxzhcKgkb9qa079Qqzd/WSrvi+k1/J0N6DvO/dzzkI3nF85BuKCdd1LOulbE/O99r7mFfVVqr7CCZ0opzV4vqT8t4wCLyJVdaPa1b2JxIHhWPorw76IGaX6EetEYjbJ4Fn8+G9enU6iEj7Rv4B8uJre0O1ZSSr+q6Vb14XbvmHVx75ZM/sEioe9SnqmJ8HdTH6HG80RLxRtYsLTzgz99xvet4vE4L9PgN/6hvRvoNh3Bn5LctkD8g4/VVf79D/NpLHkp/4Ks8/JK/P4qXk/YW6sXZUT3HezsoamF9Whm/wvlk5694QfaPLlG+4I/4zq/yPIf77BfUt/LvAe6j2lE8j9xvlPZm5C80/b/Jc+jH8xv/KtY7/y4fpJtD/p22yov113rtzK+HXsceewPsz5ZyXN/QtGvbtCK+8Oci4s/dQezVvIV8L4l3/oQ/ZYX3O8P65otp2U6umP+GkGcyf3FWu2VzpWlR+L/yF2O9/Z5D9qBB9JxqzVVtVHYVT81vbZv9efIHBfKTqKyvtzcjr/crQj0U7Kq4kI9n5K5f9EnnrZ7YLqukWrnr4qx52//7fMZL4F/Wb+b15/agf/g+RVj/y33Vo8P5x3t+Z5zP4r5EZO9+oc+ev3/VL8N5sqxftnEf18QA9ssrHu6d/oajJNlnZusnadwWCZJ3fcDGguAC8ctt3sF9M2veJXtS8xCP/UPPSwl6fl/T88UMzx/Ifxkk8X0T32v4PngArgF+0WN5CP3z1T+ZUSP5xUueLTGeBfubBeUkkovhgujxS37cvp8D/ketOn2/NxAvjnoRprTXUM9YhPmYmiO9y/wEel4TlbW0vu21wvqaBsanki3WvuE8H/xH8oFoJ1OCPBvKfLq4DyXlB9Ef+S9aTkG9qGLqchxK+YL8D3nYY8j/wPmHh6dHVF8e/O3I+oCNIdmPLuw/Hv/UWqGeHtb/TrbghlS30Cao31hawZ4Yu2E8bof8/zruI7fIX1Ws1qOTKuH8UFeENraQTw0h3asE5mPUHq2wnsohwHijfFsEI35OtrcJ6hy/Lc9rCUb7JDmEmXSJ/8/yfeQn7zJ+EQB8VmV9wT7uW37Dn+/I9gl/OXsmkh3yCg65iuiP59XFRnjuOm9XLPJc1Y7Mn7Ie7G7In3M8HgXXv9CENuT7KHyfc7AXHB+K8yGhdzx7pfD+smPeVdaXa8UI680ZrqGcTpdkJO9t1rfU3EHneDMB+3uz16J4NJVEV4r8vcTV2jskH1RaBq+zHIqxlySBn5f54m1eb+QLKNmx/ADLEvIFTexW9q0+KecHPFaDJfI1VCaL0UDl+P0L6LfO/JD/nn9f+t8kb0a0pjRfa05m2EiN5tNeYb1k/UHe/xTqLqxXnrJAjzJ/v9sUV7cH+jDaNvnH3/IdFAqC/aU91qeF/fS02zx8zd9/dFTYgxVXKxXUAupV149Xy9KmqG9O9L93t8p487X+xRHnKZa4i1bKQn30ajNzKrqrxuNqVQIa36o6NP3v4+vy+LScSHK91EMhS/Lsrd7CDfwU4st94ssWTa83T77Vu+76e97PUkW0f3+N5Yube+tOH/UIlqhHEOWz0chtd5KBTsYykZ3SLRA9O1/krzz/QT5msQ3ljek2K3rimvzv+jvefj3ger/Eb2F9IPCnyf7jv7InhGiTPiKiJ3mmee/7DyQE3T/MZ0Wsi/oErnqoGori95cd4oe9q4v82CL/dFZXI/mRwvo2v9o3/3D/YL+HvQb+TZDrT/qrB//KJamdmOpqdN/6gvbNV77hIfYjRk6TYKERfAn7N8b+DfQyRj7i4Yrk5+5rvZjQntTtaornoxIXNYl/RDX7D/bffl/R1QPjc+huyf+Ycn+4jz8UGI9Vcc3DVlh8v9vWthaJlXy8vmfoz5G8biti4WZVtGd7wlWshbB3R1UzK1uXSE6R978R/6e/w1ZbNKekfx80cV0l+0YNdORrsU/Y4pHyh+g9oc1WaN8lW7Uh6Xk/F6JTzgaK3yYPV/OoQ/UwvCaTjZXL8WZkgOel/k3ohD+F9HeqCqLHpb2wfsKbPH3tl605/6Hd9MqIh3nCrRhsx+B2DO7E4G4MdmJwLwb3Y/AgBg9j8CgGj2PwJAZPY/AsBs9j8CIGr2OwF4M3MThB9sk7nIzBwut+wG4MXsbgVQxWYrAag7UYrMdgIwaXY7AVg+sxuBGDmzG4FYPtGNyOwdsY/nYxeB+DDzHYj8HHGFz6tT7l2PqUY+tTi+G7FsN3LYbvWgzftRi+P2EzBpdjsBWDmzG4FYPtGHyKzef8i39rMf6txfi3FqP/boz+uzH678bW7w1uYP0+4UMM9mPw4L1/gq/v429gvJ/vd2OwE4N7Mbgfg0cxeByDJzF4GoNnMXgegxcxOPOrv8/5BrH5TmLPpzF4HoMXMdiNwcsYvIrB6xi8icHbGLyLwfsYfIjBfgw+xuBTDD7H4Msv+ojj7xO+xeB7DH7E4HQMzsbgXAzOx+DCr/4+17MYe16KwYkYnIzB5rs+aUB+fMJWDG7G4FYMnsh42Df60mL0rcXoTYvRmxajNy1Gb1qM3rQYvX3CXgzexOBtDN7F4HMMvsTgawy+x+BHDE7F4HQMzsTgbAzOxeB8DC786r8c678c6/8T/ol9X4zBpRiciMHJGCxi7SsxWI3BWgzWY7ARg80YXI7BVgw+xMbnx+BjDG78Gq8WG68WG48W6/8TrsTgagyuxeD6r/FoMX7UYvz4CdsxuB2DOzG4G4OdGNz7Ra/lGL2WY/RajtFrOUavcfqLy7dyTN9qMf3+CQ9/jb8VG38r1l4r1l4r1l4rpt9bMX0bl3+tmPxrxfRRNyZfujH50o3Jl7h90IrJz1ZMfrZi8rMVk5+tmPxsxeRnKyY/WzH52YrJz1ZMfrZi+rsV479WjP9aMf6L46sVw1crhq9WDF+tmP5uxfR3KyavWzF52YrJy1ZMXrZi9N+K0X+8/26s/26s/26s/26s/26s/26Mv1ox/mrF+KsV4684PYf84gYI3kPWS7GvoHYiwhrUvd9KJtuANXdC/6cDrgM2hhNsu/qLZDIJGHcf6J9/TSaxaesKpBbVgh0uW7VPQlRXa3rzBHiHWiLVDuA9YA9w8w7YA7wE3Ohs+LkrRFZBLuvVlmAHcALPK3eCEy7en+FYVOvskklkfRdC9o8LoqrA8w7eN9QVfZ/CNZUO3m92CC7x+Np8rKquP75X+PsA789wViCfOMhVcH94EYws2+L2guuAgxdsMbx+wjq/rz1hwe11I1gt8vMXnAN8ecEpwOpzPGoA+PhsTz0B7j/7V/eAdy/YA2y/YBew9/p+Cnj9gjlB+fwF8/zV1/c8f+UJixf+1BQ/x3oNHk70fp3h9RO2AA+1J6wDbr+eC8Cd53OlyPDzuZID3HrBKcCV1/sBYPMFn/h59wkzfWmv7z3A1uu5y/Bz/MqU4df7Q8DB2o5gps/zC+b5+y+Y5395wTz//Avm+S9fMM9//oQFz3+hPWGe/+0F8/zvr/cDia8nfJL4esI8f/v1Pc/ffj3n+e8eT1gHP3gvmOe3fME8v/kL5vlN3r/Her9gnl/vCWtF5s8XnAPcesHMv/UXzPxZecEnwOYL3gPWXrAHWLxgF3DpUY/gKeDCCx4Czj7hN/pmUSnX//YYij/8U15/Wn//UYrecNU+ugr/vfpQXuirfvSmW/H+X2+q4ttHuW/dd149aZNMOpgN2pvpppKe7NqHSd8RbbP3GGfb16lQFoNUnZTUzJ5kNpcZvd9Opa+zQWNj73qpmVm6fEMKvW/Mtr3LzGjQu5X1yFaav37rVTYjV+nO5PudUb+REnrvNOqnNzQOZzio7EYDW/So35FZyvZM4z7K9OidxnW67ZWnWyMYm5s1apV3+6htFAzf0Et4dUfRUrTw3NR2yWvxhYhy5wBRjLuUdcV9W4466SOX/0v/lkPWJ6TfVAOXf+188idpoT1l/dlebXWI+n/otUSyxMuwx11JHkTZzSWvSdn18iQj4ojV+HnAonQiM1LT+vFzHtMJz3GeLHToZ4FYNOE8nyuOGYREZPL3OBUXIwXjhQxTVTxn0rBe7a/4e6BLrfL3aL9i4XmZX+Xn3vM5z7DC3yMfl9i8vu/z+DGUCtsLTeZ5fs6aZPUcn24Me1vjNCP66nrR3z1a96FwsnaMfkbdWblymGyn9G7DdLLt+7if3znb3lYYjdQb+xE9bs7D/mwj9Pzz79d7eN7LjPr5VHt7W46yTMvd8eCwCb9X+kav0u7fNpN+D/TdtHvLXsd50uFrfDVjAfliRLxbZ0IrMoz5V/l5yaS/9z2ii2qMPqoIiFIagwC5XqYf9KYyzO+V8PygZJPJ4MXdJSQkMDcL6M/P/rUpIsSRP0AYeK5V0H8f/dc9steUEdpbw/7h56pVJnuOn+tiRvYRP/eag0Qyjeei+HxeXW+SV/l8hPHwc22aX/zI50LbRs/F63mx3Aq/17rP53ZzEravBc/nxvr5PKs8wu+VIH8N2y+/nq/w/Rs+fMZHbw77yXA/1sNmGO8aeK4NTOSS6+GK29qj9noDep5qdj/a+0F7CtZPKX62pzmMW8Y5r+8a7QmMr1ln+YLxNTH+t/bqVcTJs5wyJ9keyS8jNe5DVmoN5LZMKc7H+m+UYbj+agnPk83Wx/hmaK+2wXw9w34fn7Ln8eK3Kj+vmfa7CtIsBEfsMP+y2/uQj1rQj4hujefmFLV5G8DPoknyK5dGe0GO1oOft7TVBz0LxL2966+3f+43rfMCppnlYbSzP1WkWQpm5uY6cd9/VNaTTD413ZZO70rVfP05/Qf9F3zVf/086Tyb7QFT3oCF5MIiDNgIg0Dj/rQC5+rgobI+YaWgLb3whqnoAN8ai2Kk0kCEOeS7F3Xt4bkuTf1RJD/rihep5hx/L02hUTR0exk9V6rP9r/9qyvmeLBMkT4l+Tc6zMvtNNGcNuznM8NBXbS3m9ys3LuPnEp6Vm5HuBUL7p/lu4n2uUK9xfMzeP4VLZl8SPsdta55Mcq55/wPVi2ZzGHY2il7DZ9Xh8/5rSvkid2lP5KLvhcP8seKPIIrzy/F/hL6Z/1hRPZHz5juKtepHGuetcyTXyTh89Koac5dkKf+a6Dk6oP8xeIZ7/vNCfXPzz08f/GDUvQ/zbdFr9zW6t3eNzso+2YH7UiHbMjmCPlYOUx2Spr0xXKYbR9mjPPbSZRnpLPa1xnpmVGkU8p1MclUHqNBhfRQW2V5UK4//Ymx6biT7OwC/Wbph65lNpYTM3DHpvGwzBG1t3mMzZ5XWynNyV32N8nk3FkGz3s5spvSMzx/o5GOk+/bzq3SNkqK4816XafX7H03X8+TTHtjmen0NGu7w61D/zPW48zszuNUlet0pWwnWbLVspXrrJ//6Ie+70225wvGb5n5JfFvZtRRzqNBez/J2J9Uq49ajtcrO16p1/XaC/q73XM2nbZj/xqVVe4RvuouyYkl0bNnlZX9fNA4DDPGyTI3l2m5lyJ8aGOzdJ1mCH/9kjfq7t3RtnQf9Z9j38zLymncbxxm5i1f+8pDSndI8wK+R2bvNDN1dzRYrkf9nje9i1tdEwH9z52aG8Lz7fG7DcUj3luy3NqUztO7cibbOGWZlY1F383MotvoUhsq5GsDYznS+gKPqXec1ztKanIXz/btDM1rS+tM9DbqBO5kgLF552HmRjg4ucTfHuH7OlmlyU4ZoS22ySPcWOXKZjroHabUdgwnvN6veSiq7TRq7XSl1XPy+iDdBr0YX2lFhz1E9JEpnSd9A22lQhvdHdNaTbYl6re9p/VfTsvCHWd6eSvih3vOdTKwqRr8zpC+mYV2vWWW7oQTopfSg779oDXMa2Q60scgy2dqYv6SBy2TaOOuXIgnlD7Ni/gzTXhfTlc5QXgg3kgfptkGbEjiL4twll6N+7M04eFtHZUGf1dWaA1d4PkxU6nNcF3IBgxmZS/qP7Jf3+Y7u48H7eVwe9vwPMqj5aTc28j+81dqa2mVG6S/aK53Wsdd7zzc9u5yzkR3mdtm2M/98qE6kN/924FwnCW54E2yUxpPKU24jNGg0h2947JM/JrZhDIqvn69y7BfORGOQfObUZ/WZNtbE749lj3mCLyukI91oXEbk+1yOdkSTZEdMxkokDF30JdlNPLTbHsz6aDvdgrfTu+5j65maytla8XAVitdO92g9a5suG+H2trRtzt71dTFqrtpSFm/sm6Nt3lFtDLqv9PJC6ezrXGYmMZqQrITPOZkGkTjvYudMQKp786Hmfo5JlEe3hu6SNaN/A/5ABWi4d2omy59Gwe1c+H1NQlnGZItHeUhcZYnWVxKvdGP3fWmRCd5slPaTGsjHlvP+yUr9DRk+Rm+x2tdZw+W91ue14r6WQ8HCuvzkcrr8yAf+06//0GWKcpU/i5l0Eo5ME8Q/VL79K1xwliaq7f5y/l2iL9Y59gDJZiQHz0csF7587rougv5O1G5D6JzrGk7b5nGWsr9F75HgxF8p+6c5NwYOnRwYF/ui/xtzPq31HiggC4DsvPWo0GDZT+tT2qIxDxP+y7nvtblKS+WNOflJw4i/mec3qN5kr7oQVdAfkFGjgbWhWiIeKqxBw6gS6V82aQmEc9/5x9lmGlsIFuG282J+D//v/FOQDS83NA8rsMdtbsbkfwwdsP+5vJBQ/qTTmjMmxv5zqc56Vpat/WYZDHsiGG/wfgb98l3Njcpev6UH+CT4Rt9vcnmX1MlXLVeYyFa3DINsi1O7aUx7ub92Wcoj184H9F6Dgcb0PA7/kKf2iZdW9pEdDrN9kiul+4z9aN/2DoxXUCy1bythtCh5Rlk/5Js2g3hF3LiY716H7rl1e9kW3QnZulC63SX611iWiP4SrZaarrzLpZeWk3p+Qy2UH+2HEfyWd9cSO4Qndnf8Ez2YQl2z31OfPDcTwBP92/XyZb4nOxvWlfCU+kEuyrEb0izAXT6FXRAdBSt2UmOP0/fcRt4tpkTnsmm/PM4sUn06v88yY4gb1KwHcE7Y9DiX9Ye/7r9zWMKHN7Z/iNbF7jfeNZv/lWxHq81ovWALBhU8m9yjXgwx/Jo3IetqcdtEmlLqyRjM6UAcsT+tEGPo8FmNckYd/rbI3zC3iY8g86M9JhoGbQAHhySbofOGL3mvyWZcg7xHuJL2g+RPKDfUpFex7g+dTrrqzvp6UdN2sIfcvhPdstXW/ON/oeRHIMMzfQOs9929/KbjBl+2C5y/4voRtorGaLr7eZOsoX5cvqmQ1/4KD3lAc+V7KVh5rybsm1hs81GdgbZ3Dbbw2OS4+CJ0H7HfsbzXfp+PSPeGWYg62asr7rEX6Md4VjScbSu2SF4jOh2akKmL9/kgtLt6Ua93Su1bNI5zmak9PRNq/sNf0ZEs++8pqzJTwI/g/bS0s6K+qXxRH4X6YlRhvTy+sQy4L+NMeq/TXiZbWZvNtkIPGGGurtPtCJpaA1bPMLHWO41hP5am2xS2JqNvZRZikbrDXkg1xCydACZALtG7ncT7X7YvbH1f5PToN3GmtaIaIzoktqjOUJXv9mQPaZTpmtp93Ff4Rh/SIanpp/4lf5MGTL+RvIozWN/t3/4XEAFT/RofqX0rNw4jHj8S9IxDZIHvTX80+8yRxlEY5P+buM0yQJ3Uu6QnHOn5cqVeORB49rzGg2Wh5n0h+tjHtvT5/4lBz/Xr+TM9Pqt4bx0srMjnjA351G3Vwn9+Qetx32Ycchfu1G/Z7MtyDbpG5ArYgxdop8380E9/DvcV9nVBfHmfZop8a7Hh3yL6Db46n/qs0FkuzjMf1PQ7wp0TW186E+sacULZdIS8lTKNeNEa74clT2Xx8Ty8r/ZL7Vwjxz2CbW9J912mEte2sJ3svszllvtfn5P8mZNbbz2S1Y83i755yRrUvDzUoTTyyhbP7E/SLJ/EufDVe51/vRO/0SbZM+8/FhTjovpzWS8/91Hi/Q/6fYZ/H+TaKnfflha/Q5fnuRdntb93f+rEa7YnyN/i9bM8Ijmacw3aTN/4I/677zZ18C1tv+6q9CD7Q27Olth+cu+8PcdPLIJe9AfRPek37eNJe9nbI1z9N1U6mDSb7flvF+CrILMu0NWkA37w3slJPPnA2UTzpvXbMZ/v9NPtEcQ0uwqNpe3d7vUD9vK4RmftO3idMb7k8rTpjDfbN2ypC/sU2FvaPrLlnvu4XzZ04rLyF/274N8QvYNIt+QZZy5AW1H8hxz43V8rvU/6i/ey2EfLpSba+zp0Ri7hIMAvPZmt22a90/dIf2SP4ydN62feH/tEZm3zWhnE59UDqPMMiXtvTTJz/bp3Z/6Z/k1e+0DSz8vaK6Xot4dClvTM7gp3xRKpt4dibq2zz33KYPvRDlIt1P2Q0/bT1+pAn+RdEB6U+82nn3BHyN76iF08hOReXgtkW1rdo77LJ+1dpp4OmuX5qlG2TFLhDO7RPOTcGZTIB/cG5XTJTlW7BvQd7ogv1OB/0r91MWoXCG5QWtE8pnWeQv5/y/2b2/11HNPXKVnKaIxQXYSnm+mLvkzWZz5fTm//ru8e+FaKN50a+yaK2VLtAI+lOPTsBdJ/JJ527cmPsfZJL37baxurZN+TDJkS5Ot4OiG01HFudYP+aQPXXR6/T5QsC9KejcdwB9x9I2uvkmib+tWS6VZN06zMz57mRF9tB7kK5A9POwHpFcrpK+saP8J+0J33q9j/579qHCvGX8bD/LbqA/m2x9Lhy8V6XniU9hBgyWtey/Fe2/EH9g/mMr1d2ns5L9u7ux7kZ4ZQ+aXXbmvSfJl+L7/Oaj/0mXz5iKZTGOjWEOp4eQCcGldSV6TU/XtnCA6L+fzdRlfUX0dBemxUI23/Te0d0PCMNm+DbioUfulgM9K3M/QDt0Vqmho9GZxn6f/P9d38vzu9ymUjXGcWjgf6e6SycT+vvhJin//r41+XXx/W+8QT4fvMzwg6/MUTMaKDDF+3mJvdfFnFuchi/o1kcwhIVf4vhu9r6UIh+/vL/H+sJ5NJB/cgRY735NBSZcJjYfPcer4SG+uk8mUrUfxdv/qHyoRudoU/Qt8T1Lrv3+vnvB9Eet1d/9j/1hvpYjvM/g+COj7Ul19Rtm8rbdNeDMeCZRxxHp3BOEqsD/x+bberdZPMvmjYb09sUj+l/V+09/dA40Hp3Xi0srSIB8+dV2vU3s/r2NQLaTHaBBlGQUYzi+id/sz0miB9opraq/o3ag9A9+2clrUHp+PvvELt2fI75P0/qF5BD0a9L0OBKBeXch/jRf915/8x1JR7ZYIH2YB8aT1AfBtcSRKEL0fiE98ciQi83Oi9SBUYP5FkSZeUMUzXke+P78W8cxBjU5hpRscD9DoOpkp/qvPe42umKH/UvkJj2PwQJOwMNOYI/1+ra+VppMmmb3Nk2yafe69orT2kPgENNe/lvi/3az873TB4xG9gXw+k+MTvp7g8S5PJQ6xKTe6uHxLtlx3hDFvPCRtyDvpxoL+h5I23XZ5061vGmVEQbYwVRrrILsJZvpUOKk23s1PdZ7nepjddCcPPeekGl3YjGTfrsgf07CPB7vaDqwc2hhklbJ831NWScSeWNu33xkfTqZd5vOywYbH4FCf7RT3s5zb5Q5whPE56VJ+Wrbf+reCP+835zVxHv5Aj09f4+8OPdBzddIMwvmlGyueH/CQqXDg6bJ7IuqOjeWQkm3R8wk/95RrErElpe5wh/GTM/eEbeFkDPTH86Jxd2UcknWL+hXtQVHSgFDrsr9837wxXJHtq+cH/Rf4FuVWsgXerlWaHM/VfkwfVro9WAak77CfBtyrc8e4k82Q75KvTTp3OSE+Sgazi5QLWlLJWwrTBn+vB/Cn7P6NfPLKfYiDuVaxfBBljjdJBgsrlCfeNFvPd7MK7xHgG/AYPZ8+2w2EKuVhTUFaTuaFi1eQ5y1WuI7WFGPHOg4Hnrpd5+TctvVCSIeStrbTCF6I6xB/L8ROIMVpKloncbHl75uc/J0Dz1Lhd3X10UVMUpFmidgUrI21ayK21K628d82x1V5UT+SJq6pPGCxnCaYFplOauemLddL0mhlybBd1Z7tXOr553h3FtpM4XeGtzx+oqlqNmpHbHh+vM5nxD7TOqe6qXCdqyP5Xv3upBhuPL87OaXouwViukGbQbXRsuU4nEwxR7zQGm4PZBu1NRk5RQKQ8D15LEm2hHY58etIvp+h9/vjfi9rYx7z3Q/LtUzxVnfyXfb39NEBfo6dbuyAE24nFfoakEmifIaiovU9SP71VAsBf1inTKUwSC9z0e+79Sn8vWGDPui/CskAjEWtYlOO8MCx58BDeRPI/vQ7jdEc92+bDnwk8mlsno916xJ+3/bUFtNM7zwcKNjH2Ng8P4PWMpdnnJU3qU6/t+uUK4jDys9ETWtKGVQhv7EwSaN+pnPnIHgExBiloNOf3efbEuLW1DmPb8N8PAI9GSw3PKa73uLnuy0Qi+sI/VIRnWk5HIshnn5moGA/C2fNKfr76QuOdOnX0m84+xbDgSvo+9TEdJ7fCrKbx31aX1SIQfxh2SUaVTrDwaxPvkN6ZGOfrp0aI5Cov9mNSYbSuLJRzKTQY3LjtZ/82u9/xleR/75tbP6XPaxf/8x3/7kd7du95ldupEimpwkH7BNhT5Z+24/7I+yBfPG7cJ7UpjGmsVdA/p0j0OYIftE2LW1/W+wT18he0mGMvEK/lGOB7IcgGT1XaoCvDLO98AB8eMETwPsY7MXgJWD1eky+7PfgzX7XigmSpxvYc/K3Ksa3fsKqj+dukuDkI/9Gc/V3+zF3JVMw001Ez12Gy2DTceLNPtTe7Z862ivVn+OtTwCXAV9au8/xPv0TNYP26jw+6zm+ypXg/OTb+Li/NcZzY1tFfY4P+b/INXitB4/v5T/Vgb9kAXZA4bqOxqNgPMrL/1mhEfWFvznLpmQ0PjEEnLxmI9gGnFg84Sbg0vM5rUfrHVYdwKLF+Mf/+Xif+q9HUXgc73mlSSQHsM1U6Owi4GDKAW1PfLe6+N5l24/je7uY3+QJV9aAB4BL+D6B94vlT/xrAv0Hyed4p4CvgPNa8RP/rzsIpSuQuCtFzwsM10rRerRaRJ/5H8AZzNeKBm2/eR5aNwd7PHKN3q8KGK01+2tykPp7aKSJ9vRXe28frUEvEZEo705OvoVLYjU4EcoTycaD5peclvAE9Pno5j+em13Mfwh6NPA89Yg9l/jB8yTGWzh+tq/g++QF483j+ePn83sN3ydtPB9+xjgURnwmPCO7vWdhz4Fk+qOT6eWbrlJ1UqVmN1PxsffRQyyN3qb39MIktK2mj8OGYyPWe0Ht4Ez6OgwUx1YrTdjo8gzKOrXut05Nrwu559G2x4PlZgKbmGS1MNrtmmGJ6a53iXQN9r1Jn11IN8K3aPH5lGcE0zLZXuXGZmaEbadljBGNdTky291Zv5KBfUDwM6ZEqPn1vLwk3dt7zMqV9JDs2k8c5Ac4z2nz3ktj3w3jIPhc31Uci8ZOuvDhlCvXedkTPRkTEsXkr2jsJ9Lxd5wrDgekZ4xep4v9Ve/zrEriD/5S+zRyNt6I96LIXhlY0Zz2GK8d6h3MScZTkuzvzQ6Eg5bcY8o/mtCb7MO0B4SjI/ZZcU4TX1ucg+L8Ydbv9XDea8sztcOs7BWmYTxNiINo7bnfD19uffBIF+s40yMcdkaDRor65DNhJwt6cAoidi7X3LYPI320JLw6kxSf0dC69zY9wg/hhdcYZy2ME6Odn1Ib4Z7b39tKVzajzOaB/d72tnR3tr3zJNvedLHvTriMvpmmGV9GRJu/aX7jId6LbIsM7t5M+qXUyEHMwWb7mvcfv9vhrI3GaxIeOmR30He9Jo3jMNo+aeoR8stmRr+Neu3rONO7/AG3vakJPP5eo9+4wP480Y/suxLGj315rxQQfbEd+qXP69TsXYjeTyFdXWeDNhHt7/kSn28m3ggxXI8/tUN293mq4x3nT+PoOd7t2/cBeHj2p293Cu65pHicg3phxrRCfAIe2M4eTT7XndnchoF4jt5p+vg9hxnTHGjIWA8zvWCm41y153WoPUfG1A6IFvfdfi817Ev59nssZKuaNy2K+Rn1EJNbUSR/blJziUcH505f5pll+SLj4jZRHBufP/bYTvzjNw5iVxFHpZNM2JZ+8ybPC3ETpfPICe30X+uY14nGtDA2oDXMNE6EE/zexZnCP7wfxkfm7SHs7D7voz++jyOMz9ZvS7L/12Ocez6+tm0h9uVrGwbmu9lNvL/OpTfZLnGu/mud2sSfvYHifcWp14b9zzGuv59JOoWcmuEc6g80CR0wC/f22/DjnA/8Z4b9zYnX9fe4iU5JxnAMSlun35YkH06T6Nte7zIcsIxjufprfBvQOvwTA2cOiHPj+O9JeVOfZOCXbQojh/wYh88SEC+LmMPHn9sJ5QhkH3h8fdiT7uqPEVdO/UcxY7/5Kd8dm+S7mO0W8z502IDa6be/y5qoP+PNj+n+sU2HaOss4zB6ygj+kXdbTrORfzXTJohR6/+Wd04UN1dudHEuQzz9r/TUxxr8mX/YPugQbf3pGXia/NlLKLu/4IHlx9v8/jAWo3cZ/6Wfd9ommQ0fVPqytrKaSf1dIR19kXqsdxdmg8bBZ34yxlfKKawVzssLYZzU7hm3vz6scR5H7fCYoj0M1qEZrEUd/72STFKIfgjHaDv/0rPcXuk+GTRIVyukz8FzpVPTlfGSsHmgd2fiBfe2m80s4Hktpc48dLupfLgvZP/J1qT5kuYYIMZnE96VUrwYvKPxfd3rbQ+Wa7IbOdb7ea/FeMbOFECTodyLaO/RzeRP8+6f8YOYnTHuwmwRfy33Iujbw4x/24T2M9tQkOMfv0k93uZ7v6TXUnPipS6t6/hx4BhPtkW37c1oG/+WeCRzJjpXKjT2DXiS1z+aC/Evj8F4rvsG86W5HYguCJc0H/CUA9kZ2u+xb6aIv+jyb1FsoCA58Stu5u3e6GGaCnnJxt+QSQZogP6G3Ka58t9njLE18honkj0P+Zzw1icd4JW2tqS3AmxvsjHuk/7mAtofCQUylvwHHl9khxfk/o5x4phyPY9zV0E0f5RykdZJL92B+zbRkLSZcJ9C8kl0H3bCsR49HXEaNJ4z7keMnDbp6tlOyh0ZN9IbiALu6BF9xM49jFSvV6k3t7SmW7LtET/1ssXPxO8b+V5kx8H2V0g2Yj8p3WUfArRI9ERreWde6kVxY6T/d9IPiHjj+7dkO8CeCf22L9/cJ3LtPmUFbI2scsW9ip5Z+hzLFrbR5oJ3yGY4TDx5b4fg7+c/O/L1EHNJfgrx4C9a6fSZ3mEvM+9MeV8/Fkfcw10kR/pGOtMT2+Thu2FsINulso/QV2J9YJYwlnz4TMdcRhmpe/A90QDoI2x7uSHZvZ9p8lnod25gG7IOTOPezIxt5YinOE42jEkM+3BYD4btE296M9NF+3zfYxS7r0O/p7G+kUydcTzw7EJ6FDb92x4oy55KWyiQSZtYlgN5laOJ+7Z6bCv3eMIhfezH/g/2Z3A+mZz40f7A+6EvnotYHMzxgq0cPl9tFp77g29BW2jv5+hH+zGvf6qH9w8X7B9+5pQQFfRf8n/o+ar55bn5c6HnKXw/4+9j8zPwvFiOjd9Ee/0mjTeF89tSFd8n8H3qgfbGeB7H3xTvx9s3tcsX/Hz9vg/8JNZNet+mlUgeEftQetjYb0oRPh8NnE91O9ivTGE+jVoymX90sN+K89oz7mcm17iv6eD8vM7xHA+cjwvAe463QHxEMgBc5niC9Z7a8wr0vQv4B3AyAGw2sX+k4Xx8X6BPx2KRSBbcdvKa8HrUf9rsUv83DDWnXn+Sc2OdSN5v4+S1lBokf5J7c5JIlpbYG85NWz/JUxn3zZc/9Ly+oPdVC3u1d4tgp0/93XGJPbV8RPjqbhoxmYg4+N4Oslvo+W4kl4Shf8Rmzdb1+zPeyRP3hlDU+qPCMVoybstKCd36+Mbp2qmPb3TxqHtWqo5v8U707Rrfilgs2O/+Gpry0Z+tFR91V8n8/r1+j8eWOd1nvNbqFw747pCSec4H+2Op2B2+NbUtf+ezDYvHbNF8ZB+Wl+/G7ychhg2/Rzkhwm+e4/r+Dc39E9cf+1n1tf2O1+9z8cLfSY7OO9wfYPLN5P2XIe48oI+1HWA8zb+OZ6SiTzl3vldJY2j/FU/i817Wv8JRW+4v8fzeaO1v82M/jXFaHv6/1scnzphO/0Vfm2anL23Z/zI+G/f3BnJ8WJt/Mb74nhSvTetxIz4ohX1VyMbxVq0180Sqrv83epVrLPc3LNnGv5pLfC/x3+OhUQv3fRqkt5fIRzEEDSMm9IPuYvuB8v7f+hk3KnmH4zyfsZraHnwuIj5vriO5JUK8uAX+Hv08LFqDZzyqGvVtPUDfEQ/j/aEg6fnsy+k+v5nP06Wmkz6QzeaUFt3fbdE8eN+B7L3rRGUZFMN/9M0rT4ZUqvtnkFQU5PURT8cxTbbyDIRCPRVh41Mdx+kEK/ycuF8h3a4oCDhEYjshOHFeXZtGenT8PZlD+H97pSHa4SsTdKJc0WXRprHsXcUVNYfGqlVcmkLapb6bLcUSWsLuUKeBYQuN84vM7b5Qyshv0anQMPSishCi4dKgnLlJ7d2XK6EM9JErtJk5Fca1fSb0uhNXDOuIeprdAnJrnDkNolr2yIRWEkQuxYUr5hPLEuXbShOqmlraYjm0hsLadWpCrRfXQniTCpk77VVbqCNrY4tdtTIUVeJeoe7cTSD8Y8UV1exqJNTA27riXKzsRe2sToSaCHZCBIdKStSHnbnQasjf95hWddEor1Y0lOE+EBWz6ghl0iHbsO2cCPf9GqHN7qSQOegcCG1fQ1wSLprUBC7ZVGqeENoqT6MqXhCaVKNl2akFWrrcJRDqsnait+5FJDG6YtFq1Oh1BdwXr7ZQVjVqWrsn6cvcld6/1+hRCqZmLwjo+bhuCcVZ0w+2cye4Xt+LxlirCW1YfNgiOyHCbta7HYw/jRikhiOa3fUAkalpwvKCmKy5686EdjrRoIta0xKt7mMrtPy+4Irko3kiSuuehV62flxFvbT4fPuGpE1Fms+gRevpA9Z0glWlZSFJ3J2e75FxYwH4+iC4PiyizH2L8JV+PJBZhGC1ggCV+yONyL6SrWi51pSQphWF3hbJQDGuRNfti9sQziKnB4a1VlylM3enwjk45UBXRirx0dkmoWBMLVvXHqpO5O+uid6HFj3/UeuKaApP2BWrYutGUnUUpeFuaVJ2VeiGUPeKWAhf2AOnSu/X1Zyi6Paduj3VXV3XNeKrvZsSdnfYcHUzre0VpWn/COfqtYRuZonilWaQELZptwJdzWnEi/c2UTo1YevKRreUbl8xhT08tcnubepTRUxuZeHk3Y7Q9Zu+V7r3W030NK8rjPZEzymivUR2/2k30I0cMY9ot9vU/3RgG52LkVOc4nIheu3UUBi9hGkpvU17T/3rY5vGawZKD0Wteq6Y2LpaM2l82eWDyGM4E7o6LNN8ykuaT61OsNIpEz5OSkbYuj0LdGtfpvE57Rxq783pebPsKWKr5JG9dU7zWZT3qOtcEHYzNXdJKAMu3QqitxHzQNeW5ZMiWu0fmvx+EejmlshT0e7IBrpfEz6vVlFRF0SpdnvqubqiVuqKMrs7tB71jW2MuxUSmqM7DMb9ltanVqH2D/cx8VhuR+OvV2g++/tc9K7ujr6fVwg//t0ldijubb1s1xxFFNS06GVTZ6IHrTak5yrNr1U/03iVGs3vscpifmca7xlwXSW4Tvyqq4sa9f+j5kQvF1zo+02N5t8g/rXrp4trLFI1Gs9SpfnVdZKNaqYWKCJJ/NtXTlfbWGZrKUXc7kQP4nR1iXpqtJ67VQKXIQD/AG6pCRIcRP7G2qlbCvk/KtGnCIj+znWi1zrxs205N6HLUNc0hx/wIT67iwkOwkD9K60D+ZyFLmkyfAccuCSv6znyHUnw02c/0CUt1OOhjoj/Hog1aOxJX2ge4BLgVg5wHYoiTYii/lDw6AQ4AbhuK9yfg/5oWM094AzgALEx9YD0gzaE6skDbuYAFwDfXJLqDUsJMB6SjwWovZYNmM/yH4gHb2DQNB6Ci4DryA1E4yH5mXEraA9wAnAKsbxNxAJrF+jOJOD6XqX2ZsiNVHBr1L4L2ISDncYkm5YWBfkmoVDr4DG9ytVhESvcnGrQX4AD5JKr5zTGH0nFPPRdC7mQaD4E3wkQjSE1Rj8V0V8L49W5oHMR7QPe60jqqnA6JRvjB5wDfAvaUMrQ1/GkjWJw6EDWl13d1kjPN2WqUM4HW0SsNP6lA+0tIVW93FbnYpRSvaDpKJWhsQnGQ1X0LNXuVVS393/Ye9PuVJnmX/gD5UXAIdGXzSgoKCoovHPEAYfEJKif/lQDVU0Sk7339T9nreecR+513TvY/rrGrqpumratpkEHAdmm6OxQKS1tPBb9XUvbMH7oT6lvrV28m6pHWjzIzsLbZK65qfK9KI/ZfnQxYR+zdK7bNWXvtYes7ulJPBorx7i189YTNTqJo7KyFxs0Pd9fzfcvZ1fptTUl1BTJ28fmnB0dPfF8ov+crW9sGki/WtrrFJXoK7b/VY7OZ/o8R/D89FjQfzj8RB/PM83m31x1HZiOF/Q3JfqjL/QZHdLFaznVz/YeZVcsPMCIf7BnsZST7fzieGWmLAu89BN+ECgeRo18aC/Z9KGQb9YXe/FPn/X72U57djIGLDUGnmQM4poxSLO9Qad8H5bFDx3L9obxyyy50q/6j3P79TgeMiji9yX/mfzBfoofO8VRrdn5vDx02EYP5WOKeNcy/Uf5jKGS2/eN82f2I+TvtbwWVeYPz4/IBlnKQ9lhhPapl0a46X22TzQzd2wRqfbB3qWH3L6Mj2/FGqF/PJUWCT/Z18OjovPxAF+7Gh+F/M2a2PumbP8gv1gqzHjM4osTIv2mx/7sX+DP8M+7ifp/PAihf9c/2BFsuXUU/+Aq/qmr+KmH4ysL3aZy+Fv9Z/Gtx/nXtpNewf9z6azAX/X/MlOFqres+JkJZpxP/2R/gy9wavEU6ddT9Z/sb3G84kz/yf6qxHmQzMdC/w1fnOWrHP6gf+eT/bucvnqaI/+N+G/8L6M3bI2Rflqy/7/Rh0Kfz4cXy3+RX5E4/Utr/1/oZ/5H9mtz+hpbIv2H8lo1+9F+xL+b8Z/y9dvc/8r8p9/w+JJTdvRjC+1X3jT++/gt8BLHSwJfWuRXZrfwIv9l8XPL8VNL+w/4zP98jletFsbf0x/yd9b+wetD66Lg+LqWS6Fb8V+o8pTn/5Af9asivvzmcvhD/ijjW7wedf8Tvsj/gLfWGuKbv/IfYv7n7/34q94/+Fc5vrTztZ8V+mcl/WP9gHzn+Smjz1bonzX21/j8pTr+vqHqrTA+peX6I/3b+nGb53/u9OsU9Tcr1Q/Bt/qx0J/J6SvxifJr+m/857/165xQ/v9B/Xvl/DuDCvI/KnUV/qH+3ePDv2L882EkdV5x/FildyXL40dL2GD0yS+K/M/x004Vx2+tFP/iH/FF3sMEOczzPw9jp5TiV1zKX3+wbwzzjjSwNRa0NQ/mHXHgaGng6izo6l7Q00UqaeTjf8t/NEEX4+9v9BdDvbaFeu0A9RrUbmlafkmZ53/Ov3S+ad/4L+dLwLcXuMB/F/jvYQe9fH2Wz11mF+z/kv6x/7L/QL6BOmcLdc6hB/WOV+Tv7D161XnG+m1bsv9f2y/z707K+ZOuVD+Uxuc/+neTz6/bQw/tE/wX/87988TdPHUxPzymJflmv8t3uHWUsrJIYBiP4wUY3Wnlb+/mL+no1xD59Urzsb+Zj7p5/ZFVYdVHqh/VP8U34T/i1fTs9dqsJ22F/CyZ/9f6o7ok949svJy7OH9rnNT/6h+9rL/aM8p3Lr3b9I/+0eEWsTUZ5Uv+y/w/r98yf3/uYf3WnCns3/0jyw92lg/AZyk/luzn/Xl+7WT4mVXM6R/lUn75Pr7NnH9N4vxHau+R6qf03+3zd/7NDkjk+EO98U3fcUk/uX/7beykUq7vb9lf/D5I5j+trF50CP/83+PLW67vE3a1/k/5M9N/Vs9ttCp2NftD/bnNxdW5PjEmPZbfSLq1fmPn6w1c3gNZ+u/mJ5l/v2oIetDF3p6/n5+75N9azRP+afzX+a3M5XVXZMrtT/Pbsvy9NHuta0D+w35fH8D1Nf57PMb+kfLbX62v8aXhcwNJlc+Hnv40/27x55Wavyxi0mO9zJ/3a31YrK+p/PeptkhULq1/6Ol3+6rF+hrIF9vTx+9F/e350w6PKc/jRyNbCrfRqA/bL/O/eB9354rtmIm3GKt2bO+8l4laPzl7Jn1ev9E8vn603aH81V/sk80/M/+c8eH0ar+ifdKfxw/wH5d3ZhlPfgzxSqkpOkuX+SEd+aE3TRuZaDglf/9ez3qBpcTsft2v+3W/7tf9+j98aVuleM8/W++NPz+H1S26gyyNPwmk0nkMukWFIrT71I45DNpboj2mdpyzQXtbtJ+oXRP0XdFeE+2CvkftuHUM2nVBfyjaPWo3BP2RaJ9RuynoR6L9INoF/Zlol6i9JegvqR0nV9BuCfpr0e5Quy3oJ6I9FO2C/kG0b6m9Lei/ivaU2juC/rtob1C7I+ifqV0T9ncEfUm0C/u7gn5VtAv7dwX9J9Eu7N8T9JuiXdi/R/TJWb1YF/b3iL6iiXZh/z7RV0zRLuw/IPqKLdqF/QeCviPahf2Hgn6P2g1hf1/QH4h2Yf9A0A9Eu7B/IOiHol3YfyToT0W7sP9Y0F+IdmH/UNBfUbsp7B8K+lvRLuwfCfp70S7sPxH0X0S7sP9U0H8T7cL+U0E/pfaWsP9M0L+KdmH/uaBfEe3C/gtBvy7ahf0Xgn5DtAv7LwX9R2q3hP1joq+qol3Yf0X0VUO0C/uviL5qiXZh/zXRVzuiXdh/I+h3Rbuw/1bQ71O7Ley/FfR90S7snwj6Y9Eu7L8T9CeiXdh/L+jPRbuw/17Qj6m9Lex/EPQ3ol3Y/yjo70S7sP+LoH8U7cL+L4L+SbQL+78K+h/U3hH2Pwn6F9Eu7P8m6MuiXdj/TdCviXZh/3dB/1m0C/t/CPoPol3YPyX6msj/jrB/SvQ1kf8dYf8z0ddE/neE/S9EXxP53xH2vwr6Iv87wv5XQV/kf1fYXxL0Rf53hf1lQV/kf1fYvyLoi/zvCvtXBH2R/11h/6qgL/J/V9i/JuiL/N8V9q8L+iL/d4X964K+yP9dYf8nQV/k/66w/7OgL/J/V9i/IeiL/N8T9m8I+iL/94T9m4K+yP89Yf8HQV/k/56w/6OgL/J/T9j/UdQf+G4ipHxdofo01rFdE+0etSsetZuifUbtKqN2W7QfRHtK7Y5ol6hdE/R71K4watcF/YFod6jdEPQD0R6KdkE/FO1bajcF/aloT6m9JegvRHuD2i1Bf0XtqiXaBf2taPep3Rb096I9pva2oP8i2k/U3hH030R7TbQL+im1a8L+jqB/Fe3C/ieWP+qAb1k0/zHjFs5/DNEuKTG2e2bWrt0+s/r/puvkNIrnLGqjiKUe62h5rap8ak9vtU8LX9eZUtMyW8LkqjxvFH9mZ3F+pb/QD/lPYvP/wwze84xCv8X1ZSFUK/yLl0wePc/0C/t8+rJb2N/i459+Wpzsd/uy8m1uXI4Pkl8T+uldSf7HW+1YVSn8RNKCuTJfJS3ws2DZt9+nW3Wyz4RmWL4f6ZN8GY2d0P9Jws9tj/iXXLKDJBX+z/RNH/nbuHgCu+bn7dx+cenxVdl+upo9sy2thF/003f7Wakp+McGVc/9A+gb2gDpx66F9J0iV3/S78B10P98CfXrXofFs7nS0+yyFiEVpx2+Zl8631uxhoJL4gzHv182zc1RXfqwk9qo3yvbFvrX4mYeiz69wV56KNAg+XVhH78XF3jmq5mvfiXufe/KTucYn/zC/l9eC9e/jz/11MrHyg/8KUzwFxN/ei+X79NvpmihGH+pJT7M/PMvQuJNPMbf/4yv/T1+JvBifB2K+B//74yPMzE+G/8lPvp67cb4KvLTj/Hxln5UlO+HXxrJ38rI86OoH7oifz6LdlE/9ET+fhDton7wKH8rCrXron7wKH8rumgX9UOf6Cst0S7qhwHRV9qiXdQPQ0HfFe2ifhgK+h61G6J+8AX9oWgX9UMg6I9Eu6gfR4J+JNpF/TgS9GeiXdSPY0F/Se2mqB9Dog/+97fxo1PEj8/5T/hF99rF8f/o1DA+TRWvqH/YMK9l9R8iZIkFWZGwfvKv6V/y1/V+58/ajJC/1A2/82f8PX+PBX+fTgAp0d1Q/5oux0V8VE60Pv5WtP85/jKvFX8ff4Ku6lH/jpDPTP1Cf6r31/pTvcWv+rOH1P/1u/5+4i8k/lztFn+OxP6SPy1doP5grv6X+lP8FtbfXahf/tK+kVIr+NMO8t/yZwn+Dn9tX3VG/KnX0d/y90r8qTX578cv8ffuHtA/txW0D7tOqb5wT+S/lRTtt6F2202pfqyyIj+pgvH2p/zkfKv/BobzPT+1wZHK/qd8SVKl9alQxLeNiG8ivkYU3zRvi+O7tx6i/E/WCfUXF++awfxs7WK7Z6N/KixBfFcdYXvNDtXP2p6p930X9+t+3a/7db/u1/26X/frft2v+3W/7tf9ul/3637dr/t1v+7X/bpf9+t+3a/7db/u1/26X/frft2v+3W/7tf9ul/3637dr/t1v+7X/bpf9+t+3a/7db/u1/26X//vXtn5fvnRdIdb7bVeftbT7D/2n5/uwM8D09JnVrzf23u+4vu9B0bv52Zv42bf6G1O2K5+eMX7v8AknX/hiK67eH4F85rYf7s4S4f3nDJ8v9d6xvNDlA/pJ/r5+SraG7Zbj7/TNwX90zf6RkG/dKRL9g3jlqb47yt/P59FXIqVn2v709u/asZH9j60eusrmveYv5+f/ldXYYhWtQvq57nX+FU/7Z6F73dLj+kN+8T5R1zuBr4f3vt4vGGf/MqO3t8QfcCrv9H3iD7/qQHrtn/kL1tbRJ+frxv/4p+GkN9iX+nzw3sdEipXGis+/35Jhf6cH5R+sHSVOrt1id+UKd4f50zpNJ7btzBmSf6Sf8Sx9SOfny/x/j2+v27h+/OZXtQA9bfznJ/0Y/1N/DkV+v+fxR8nI0Lv1yu+/pN9s5v2mvhvMe+GfzGy6one3+cHLVnfxz/p60/jk6U5/n82PrP/7wr9B5736/h4EucPzL/xr5XHR+ngBzyf4JP/KF2LzjeIY6S/WeP4UA7UbtWo/W1A40emdqdxA6/tqb3jU7s10FH/Dxba12Qrwl+wXZWo3T2svtNnhkXnY6RrbO+oFuKFfIZF7ds1tmsC3xPtgv+SfCrbEP8qjg8WW+n/d9utItLkwbQ2wfZuH+VX0hbqt90YYHtD2aL8DR314zYiOr9wRfqbtJC+diL63gX5UzrEnxFSe0T8KzK1tyRqXw4o/lSo3Ypv9K8OqV13qH1P/atbardTau8SXhP8OYL/YT9F/S5NbO+lJP+C9KcuTNSPIZF+j33UHzuS/gxvLvSH5xdpQr+qTu29FeFXOtJ3fbJPVUH+NI34s8IZ+T/RVz6oXQmn2N5W8HwTpS/w4vy3xZn4q5B8LKXzUcLVgcZ3SX7iTyP/UIfUf0sn/QxIfnXZovFZI/40cb7TI/mn4RBeIvuoz4Tv6GSfqfDvJtE3aiSfJ/z3hfBajfh/PJN+GcnXTfvkn2J8NE3kz9Lp/JeY6GuPhG/rJN8r6V99EvZxQmzXV3T+0clA/rq6j+0PCuYHLTUIr4+xPV1hOzsYyJ/WoPzSOcfY/6Mh/Jv4f+xTfnwj+o5P9mdn7F+JTZEfiD+Z+Fd25L/tmOg7fRqfDrWbJ8LPFcRrjk763ZJ8mzP5194U+Y/4b5B8mmeg/q0D6dc8hxTfCN/xCK/S+NN2hHe3hB8RnlWp3TgQf53VDOWvkH/YBxqfD320P2uT/6li/L4pKB87k3/ojPxnK8a3GD8th/BX8j+2IvotQT/p4/hSuuSfLTb/Hv+1JeF1UZ/g+UbcvuJ8JXE+3UScT3cU7eJ8uok4n+4k2sX5dFNxftMHtbfE+XQzcT7eRbSL843ngr4s2sX5xnNBX5xP2CrOJ9T5+fj6p0nO1ytklH8PTzg/Vdca5RfL+b3+F/O/E51/pgn+TFHfifONW4fS+ZKEb69vnE+ZSzejutTMi+T8/CzzRqmd/ZXNmbN7/Vap22Ek36Ubfz+/s13Ir/+56D2J8+EqJF9H1O8LYZ+noj0us+Qd0u/6VTJuWqLyzTpz1IzLz0dgqjdmYkwRjJfsH97i3xHzC+8pF/iTxkaW97f2d7Y37N8Q9m/8bn/W3njf7W8K+9fonh8kx7l0Weum/f93njqdfmElo98/zs1z8ul73UAZGV8/1/aRGVzDqn2cAWZayc9lf5KMsP/18658hO++z81kNxkFxW8daC9esLK/fv78J54VMZV1xYeXaNyXZ7vyL5ZrO1u0S+HI+rpmsxHrAsp1Zhqb6JMjaIkj5v/baHRO5qb/qX9H/KZpMqu4q9mXdlfgT9Eokr7Q3y4E/jIZzQ/zz+3JUvC3nVbn71/xS9G//H0Or62X4jcGD9OKnHzFz0r8T3feN/3MRXsajubJfPypfSf4zdsjs1mdEk3tsBD87aZVuxqO7S3Y+wS2Al60t3mp3fG+87+IS+3xjXZWak+/t4eC/517Qz/zUv/uDfphqX/3Bv2wxL97i36p/+4N+lGp/+4N+lFZP8Nv7Zvpp3b9W3uUltu/+//071dDbobivwicN6KW9V8i1U28WOpRmiL+ivpkIc5//yzK9/UVnc5vtkT9srVxfUN5/EN8H8QU3wUxn+J7zmkWZPH31azbK41lvkrri7Uby4P0+1RAtzh/ma8z3p+7/L93/YN/G2vlhn+fulj/lvz73Xb+0r/Vdhz/6t8H8u+ul59Pbv/g36VHLK2v66tf1m+dW8O/VZzfran/l/7+Rlx6Pkjndyu/61+L4xu/b5EoDVp/XjHr1+dbTzfPF75hlM5avzH/uMl/KRT1RXgW56fH8e/zg7CYfzk/1Lcl/Wh/iL9eLr+a/kNO+v/Rpb60bvy+wah74/cdWlo+1/88FYtX6H8lv5hYoXrX7f26X/frft2v+3W/7tf9ul/3637dr/t1v+7X/bpf9+t+3a/7db/u1/26X/frft2v+3W/7tf9ul/3637dr/t1v+7X/bpf9+t+3a/7db/u1/26X/frft2v0pW9xzbh/9eKTcZUPXtn7cu7f19PW8xeXdO+3DMle/vR+/wWnPK1Pf7anoH4Z3p2gEePfzrir8Ga/LVV5cTv5/wEgdaO3zfijD9+alSX/9vnb08G2SljC34/5ffjlJ96ZPH7Hb+f8vM1Wyq/l/n9Ijs1Mc37sfgBKCpjLn9fU5vy+yd+3lePn4+nWfytSjnV+Ck3LGXahd8/8nuHv0CrcaKsHkKn3Sd+X+WdKqHBT20Dvekr5jOlc4D78YPCT+WLQ6YMPVBJ0AXRjRmD+yNXETAZM/OBt28OLcaihpIyM4lnTHnl99MZvzfimClbzmTEDy0yV/z+tQb30wd+b7MttId21p6dcgj3L/wt4skDv6/y+5XVhvauGnP8AdrjNqfP75/4/ZmfQxqnasqs5/jEVI0Lvd5q/KjZOGWqEbpw/66BsRuxxFTT6jK2cTQwbhg3mGqzHj9VUAP8hp8vxWp9UHJFh+/XFR3avQH0/65D+1JxmOqGQ7jXQUmWD0pSrdiH/mv8vrPymdpOA2gPDej/pIRM7dVGcN8wOH/KjH8fHGQjgRKtzWoL/B7ApdcPZsxsGzxIDdIpY7vYTFmnwu9T/rL1adbiR8eBUtWKBfdvD/x+B/dgVLiXnJbH3OlKYtrMm8M9DBHm8iOUNN9bMFZp8/unFdwH4ZKx6gg8ytXACNqoBl4qN8Ao7nYN9xP+um7lgd+rMMS0MF7B/ZMF/bdVi2nzA3xLfrcA31w7TOtbW6AXg9Hcztpj2tiD+4rK7y9gRG1wSOD7kg14ZR3CfQ3GRmVhAz/aegbfP+yBH9OG/pw1OPEshAFVTcHIbqpumbY8HAG/bsP3JfXA8a/QPmjD98M1yD9jMOzkXQf611WQbxq/Az9mB9pXaoPTT4HeDJzClcEptGF8hu8/OfD9q8bl8y7w/YED3z9uHN7fFe59cBq3r3F5wGlYpcLvJX6/SCXevwv4keZzeWVo7/L7hw3cD60K9H9wgd/VBuSd8Puqye/rGtx7VpXL4wK9VyCmTQ9wX7X4/cMG7oeHGrQvwEndFTipNknhvprdK9qWt9e5PrtA74XfLxjcS2EX+vc2oJ9R/AT8xPw+5feLA9xLXhf6725OwG/4zOXh98/8vg+DgMlbGATudQP6XKZwL730uHwbiftDE+7bPegv1GpcHw+AH/H706bG6cO9pPagv/YQ9D1mj9B+4Pd1De77YD7WaEDk6c3BM7SnOr/veh7rxVud6Q82xFXX9GI2XOoW059tFSJrDe797tZhRnulQRA6eCnz21sISuZZh3sHBqnf1n24XxlMGUh9j/k1fq+cTYi07T7gt3oIQazfgu/HfcBfthDEjJUN92zgcfwB+q+3AT8aQPtsm0K74sL9+xDatW2NGa1+F4Jed5iyydu2AUEIBr1ynsGgn+3As1sOeLZy9fn9M79X7T5TUsn3eLvOWspqwI/68WM2uyYW48wA3vRhXO8Th+Ph/nrg97rBj2KEIKJcdAgiy5cE/C2wA+5PAdhjYYB/hfWAjx9+f0ngfn6E+2qD33sG+Nd4BfGm0gjAPi2I2Fp0HkM7hBWwdwL3fh3iT8WEL7nvEKQ0rx5B/84I8DuDj7c+3FesEeCrCfiPb0+ze8BXDfAXnx/mXGmP+XhKwF8GZ4g38sMY8B8J+MugvuBJaAz4bcLH4xHuqxLc9wYG+ENtxeNPd8z7S+B+acO9tACm3PGOxx+IDBCf+L2yg/Hp9yH+rMPQY50z3Ksf/P5QCWPWjiBtqi8KxKPXA9wbHZ6Gd/0NY+0whFD5vHNA233wuiAGodSEn3d04vedWsQPIONnN41tsNr6EkG8f4J79XIGLuxBFDN1afLxe4T7agXu3fYO9Deq73n8jaD/NxNU8R7BvbIcS/ZpWnFfxxX3Y9basrHcVKdmczORmxd+jlQ4dhNmNJfDxNWmlfpmtgukKHClcOS+ervzR1g5ccwyrKxeZ9U+9NNfzfbz4zSGvuXmdW4avK/NxHxbRjvjOGU3Pq8GqxnIOK4Ym7ASpHP4TrhL3iP+7/6YzHYNaHNP02rGy3YydtNw3N9MjOY1Gsmrmbn6AL6WYdUGfvv8O8nCBKMazV0mS6oso70iz1sO9DNP5i3lyPueVJIT52dqJsBP8A7ffwtHZ66P5aySPEUetI2Ct7Cq1Hkb0HqbViPeP+gGnA7oT0bz9xCcbFx1QRdvCed9PqqfJqP6K7R3fSmT6Qr9rSej83HeSlqzXVOeGfbHFOw2loxwMHY9+GwTjd1r0LJl0GPC+eNnjs1k5QL8JLOq68/2AedzG1QSaaI307mZfEz3TtZH4CfG1AyAx7rkVZrpwjc2Wfu2vgIZrsCLMjICuw82hfv3uc7tnSjzVv8yGdky9DsC2WUuM9ANBn5wAnmT6b6vgW5X0K7MWgrI5a6yfuNv32tF476/GCvJAILIV55AxjKtIXwXfMg+3aDnRWObn8H15o1caTJqvn/j3XCTuW5I85Z9DPfcH6PVtBUkt78nc92togr4k9w/wucf83HB3844zUdBIZ9f/uy7LOJz0tOEf4720t1DBGNiWFUynv0W2HescB90hj74nP62jox+nZ+7Npb7ti9l+tfmY/uS6acS1MNdE8ZB3wnHCfDYt6fcZw0X/rY3nF6gJ8N+JZAGo3oK7cNpNbiAb3HfSUFn0oLzxPvmPlNVktm+Xw9G9WNYaW4j/y1Z+OfVYtSU53of5NVBLtfsm4YUZvzZdbCLN29Z+edjQ878mv8NNINWkkY+JAaj+epJkTqtNMFexnsf9DKrgEyVN62/BZkrEDNGde6r3B5aXwoqmU8WY7MkpzHfgY24n0vz/G/d5eNKinwZZHaT/jgCf+D6d1v53+SLQxjrMH7O44kZJFM9p+HE5b5A3pH9wc9x8zn/qAeIXTMeW9LSdw3lY1b9RMeDWCMFZtObjD59zv3WnJrGfvYJz/0seQe+9mCH3D/86Ajxc1vWgV+Bcb9zE0/EKWhL3vh5dJldzeAYVVbS189hvG/nUGhzPsCvkmh3zr7nmxBHC9lhrGTxI8OC/aNRdMrO6TNcHrOT6dZdzVr83MFACbN44uT97YIN9HGej4wTyDsAH87py8BjNRvTVjRK9pOWV/o+9xf5GBnxjc+23z6bJvGNz758z5gfo1b/gLRn4wB4zO1Q6P4r38AzxMM/yBfwcW82q0Me4/OYN4bYzM8otKe76CP35zl+psKYeo+yPAH+LEMe2/U/5hIfN8Hly3e785G8jsbWl+82q9NdcPH1bKwEngR+GPQvMCau4DcSH8d2yzk7evQBeWILfsDPnTw72/pHfrZkEV+T8OomTXm6cz+g32P2GYy1aStRwX+3USUwYdy/DSv2C7fZBHTkVRPFk90PZ9iHvPOlv607jKRowozGdnbV0/6O993P2zb6ZbhrQtyKYIwYWfwKtvLqh+9eIX/rwPfKr/Yh7xr7yHfkcJ9I0dipQLx/j6r9g+e7wyBx92PZBd7dXZj+IDfUDlkMgnEJMR/idKCB3OsFjI+Z7Fb8yrwS/QtW5nGpvp+bqyHoZP8PMlTHleYu2sNYNoBnqJnGl/7VGSpm5hNmrhdn6ELNxPsxhnOzeeFj1JN+0pV14XXVdB/xWAw2CS5gswuMM2O2tz+gkL46up+Oq8pwelU0R+c2Cm/TlYPB0AjP3aC5LuzvT6XmesLHj5lUItD39Bp0ff493a3345s6uwaB7QQbpzKGviEeQv9J1j+vexa+Dfm5D7qIoOaQe+HuyGMA6CLQoJ7Q/EpDhjow8Ldn+Htujn6j8aP/9DO9Bxtd8nfGO8gBMQf0s+P8BNpwpN+U381yljFyhsESxn4K37/yuJfTrPfg80s0Vk5QlyZ+NQAdZX0v3dYc/C+WQVYZYkjdr9Thv6QFfjkCGcBH+uYf+JTHPB5B3J1V+PmvOT/DawTxJjuL9OyY3MZ9HqOuw0pU9+X5cq6H/0mOXM85j2El2f+Bt/q4Utgs6H98igUQB9xtfZjn9x/9QcrHD/jVyF5BHq+4euYX22jUH/L6arqbVadFTQPjcQg+cHEl7PczBuLifkjfjf6sg2vEa+UNyA01fSb/CnJ63dvbx8iE3AdjZOp/8vG6l/l5BGMp6+M3PyxkixRvqKhdg9dEfajRmyfPN9wf4lEJo8tQR/PzfvdzqJlmUlYfXQE7honub9juDzYLoB7WwWZQu0GeN4o6BHT6U6xxjQDq4v4IZK6HlUj7tV8cb7Krf+2nP/zdT5yhzfV55GOd2wDiEoz33Ha+/FXOugH5BWr48Oxu3Y/IDILpLpFm12DDaULsHEL9WZ9do2DAa7IheJLc5ONsE22dX/pMYK6X2x3i46fYAz5Xg7hT+OP8d97+g0/5MvepFcTOwiZSKVdC23d9rgyelyF2gv1CqAj6u65uaPPd/C8xkRtmdYA7DIdf7Ln1r67R/Bf+l+4eYlM1OIHu16CrKuhKgfyyWkCbXzHqC30+jKpHqZ8ccr1V9P89eiv6nl7nfJ4Luc2ogz/tBR3ePvuWt10/i5dHmPfzOl/Ncr1kqOBDmc90jWgwqx5Pw1HhL5UGr4+G/V1yivzVCnQF/363vTueX4D3BHTP5ZB4XJ1Jzd1ivIJY9KZ4V/2Sj1ERC/z98ZTHRne4+G4LeV61IX/wKNM0Yf7O+4a25huvq7h+uqaIfYuxseVrIX7FHoI+lC82lwYy6GzXX44r5zznVLkMud78yhlqr2AEvLa+1xwBX3uBv+cyfH71slrLVfotqAp8mHdoq5G/d5+murwp+pX7MK+Emsj77odWytdEIN8fF7tg+/n88/rQr/KaqTT/MPmaQ/Je6FiJTJiXjqBe8rL5T/633+e1OozNnAbOb/J1CpprtgYjmddoOvAO36sXOo447jQZH/l86APG/WZcgToXeMzwxhHqXj6/5L7nLqdjdw/zuWxtaApxLJSbbzPI42DrLeR9mAdbF9FPM51na0TnHX0GvEGNusrnrHmffE0rHCXv5e9AbjlOt4bMazxcB4sM+LwVXKYJrjfQWD/BfABqGJiDVALwGsy3EAuv+jmPDxS/rt/sCbaCOT/Y3pEK/29hTuAxrmtk84BsfQGiaVb3B0Hf7LYSiLXuAHDkB/1S3HLNFfATc11DfZxc3S2/XyWzJHoaV4u6h39v5PJxBPPTpKi1Od9Y3/Tri8AdCnlWQaCHtWCXJHM55DU4X6tJ+DqYl9dYEOsT6rtrBH5/sxpNRkE14HV3JeJrdTB/rcP8q58stGAVQcSYQXx3dC8NtoZZ5u2PeKNRm1aiHehdgnEB/Cm6Y0RKP2mK2u57P9VSP8P5yC7GgFebwZy6iH9XFwrZ6d6rwTxm6Pp8HhnA301J6CLhujiDZxyj8Xx0W49fv5P3M76uPqJddIX5tcr1S/1z+fmcSccc53ZRBl9aXQOZ4efDoOUWtQjPuW59JhXjH9pmV0segiyzypmvf1HuBLkqfK1owtfexiV8FXRXXW3+ChfYT77cHywSt+1KtG43DAxbWuzOssjzEO+gj2lml6CwVyTqWtldOZojjSvyalLJ6gg+p1fgewPgDeZMUJ9UjBRqer5uakd8jqxb6QL8axGsTmO5f3VFHq3AXKtYP6onc8mWQb/JDOYZ4T7YRTAnH4zdgoZ/dkcyyJW8wRxeC8fKCniSIP5fo6oNc3jwja2RzvhcFsZYyH0pcNdzPaqPzPMygLhL/G9Wy2LNmK9LqfMRUB3bnM479yOMszDmIWfUj9Nx8FaS6epo0bIY/yr4bZZPJ0GznKuvMKfFsSjWeMfuFXhP+LoWXyvxIP6V+l06mvsO/qY6wD/0VwP7fNfZOKn1Zdcv+c16WPh2pNcK+vFtXQXugecq8PUln997hb9PfMSBbBtXg/wuwVzyj/43+xxXalG2Jm9AbvWliNceQ1uawriAeChDjNxG49VoLBktHCezK+NxEufGCvgc1pAwT858JuXy80xe5MjU1ewl5K3t1EzWY+B3CHNC4O2a5bBx3wFfus51mK/vDKidDaht+Tze5bFh2x8qdW+3PY8lu8r/8/ZzdZ7/i/GB1/N5HRa4fN08gRr9nfJ+voZ9Al75XNWbSUF90crqh/cQbJLVCdc52dsfJ7xN8eTPY4zPB/j6pjc676MR+FGg/GM/rj8R/C4HpnGdGP1VuDsnECcvfN473/H1aNfia7vujq8/Qk70DdXd2nL2zCOPtyW5DbCzDPVDfTvktY/fqIdjez/P40RWF0JsaFG9zPURNPnaqlhTufZhPqFAfdXkvzeS1Qieb/PxAWMmWMKcfDWvGKqju1DbRb/0E13Az2AM+jXIU0f+HCAcpbWQxspWmo6aFS4P92fwI5jvNwfheL7yNorGYzHUczQeQd9n+IyvEdGa03BUK7cVc4i5PG+5I2czp/xY1GQa/Hfh8y8+xwY+TuHYOjstVwqzcVHfg+/BmA/ewWf4/Krn6GEa8Bg0BHtUeN1pXIbFOhufb93ITdwGS7/Kn7fU9/1qIM1gnpLFtmrC1xbMsr6KsdmCOgVmcatM71l9oUEe3Pc/4PtDmKdePtUZcpmWTTGsiH8jPp8D3UilZzG8RvKgLoS4kYRTwz329/zfpj+7+qi/q9BfMdcwQq6bA+gG6q8shw/9fSJy8xbXBzkf7hL0ALV/P/ELPY1hfMAYhzktr0/nyrzlVMUzkUYKNh5xG4MM19wWtlOsH0q+bNdLc5JWOS8Dr1/WB/I6PtgwPn8D33/7FJt9vs4ztvm8acV/vwdyQ30wirowD9EhRtdv6OKH/vXLmNe/uizjWtSNfPhjjcnnebMbvBT5hOsI83BhSwvqq/PWo/WzZPktD4IffZnTFXEv/J/kLv2X3AXyzZdQk1/zXNLkz6GOUJNfoqC5dE2YU5i+NOWxZxjssuc1MCca7gKee3qg2wuMDT7/2OAY4eML5mwWzCGuEKm5b12dJCr5+GoJOgDfMgrZ5qBPhT93G/E5YKTnY7BU+2WYPtAo1u4vi/I6tZk9by/FpLMC9WttFjS/xyCoh0fxX/TJ1wH4c+shfx6e7Pkca6qtNqK+6WfPr7M42jKWfZ4DQV/+zqiGvpV6MtU5FE8hp+qT4jksjI16ab28JuoevxRPE5Kj8JW/6Mt1pyjfn2qGgJ2dUZ//hhXM9YtnrbJbieT+S0HnAnOSW75fXq/HPHwB/yzXDNIkm6t/WSODmAn+XpvS2Leq4yqtFfHnvCsYU2MYRwe/In9Mi2fBY7lRhzolzfoBH4M8ciMuQ/3n9yGngT2uegV87A3GJMgG/SbFuo4uYq07VIyhHrh9v+7DeIh8PVgOpWjpSwHcR/ZQOiuBHgzH0kqB+YLibc8G5ErDh3jpb3Ocz+eCvEaGmnhYTdJRS8F8IDvSmzEKmj6U4cZYappjqW97ch/6rSt+kiyDbdIb6obfD9zlQDeG8J8K/Cyh7z7khkHfl41h0h/yXIHjbTFWwhnpLsiffWzl9OtaxUzy+fONPeRvYzqCeG/y5+r1YdHObTCMqpS7yjiZP2eB8See+Xxuh/le/2M6ghiRiPVW4iVRrn3IV/yZ82wLNt01C1rf+hr7xdh2szzoXEo1nZytd17t0TD+8p09+KTk8n0CH9Og5Df5c6Ejr7Vm8tzDfjDHirqCclC3+E4lq9PM4BJsguWE/631r9Eo2LqjfJ2a5qJX+ziG7+d9hhLMZY+lMfmpH5hDg74N9UtNX1o3COswb6b1Gvhenfwyj5l8nktjufQZ8Z3zoQMl1yrJXHz+SZ+CZ/FZOXdXMMcHm89zbPC9Mp0jzTerTh1iaR3mdd0Q8s/4mmTPvflzT16L+flYWGb1Xi5DfVbMgxbjfpfvg5pV58doD/4JsWfhF2t3GMcgN0FcqEJ/UPfIKcTCz/GOP4uu8N/my/a0XOeVZDc3mnwd8SMsng1+/7yog2CeVNCGvJfFs2wdDTD1MiZf983mnlk8yvYCeSXsLuB5QTwjL/il5wO4xmuU1sn++J1gyW1ONIo1Y4yhvlhfQz4x5uIcDeb7/RXw9akfGM+FDtwTz/UwBnBOWOKpnxR5qOjLK7fVwVf5Wi3MW7N9DUh/u+C5cZRsoO7gc7z1ZOtq4EtXvq+D6PO6ROyrQGySx4xb+slteEPeLKblONqrVG4zcY6Q77OR+fojX9deffkel1HzKufVrOrmz/9HnFaxxkp88D0WJZmkX/vL5sh8r9OXtuwzyOUuzOP2IOt2CLqMwLfyujSozTXrM81sf1OgLnx5BXn7BGMqG2dgtywfQy7k65sut3VUPLfn68RO2eb5fhdpCjXqTM7noSW++DqExGs3mHfesHfm98O8Lr7lD8m1P3Z5PZTXFXz/DMwrYL6Vre0P+bp4/oziEwbr1GkrKT+r3o4rdb6/TgYf/ebzZZ5nfC43NuRodK6Db/D5EdTDfD25+Q566c7Bf6GvVfZcpTRW+X7L8j3Q5Xuurl8+++prfE1Rh+9la+iZPDzfoTzVbB6mZOOq5OuzyvljLuFYcsrflyLzfAwTLkex75PqPr5PxV1Fu9IYqIKsoJd5pS7GtthHijzK093bO/+d0FKMyGULPsXGW9/7Ki/QPZ8CcwX5GZ+jZnPspA918cxcHUPIG540N0Efq7mB+QnmvluXrwG3IHanUPdtZte51pcikM2AnFMr+urnfX165posPSlC+TzPNwyH70Gq8Lm1XRtXV7Re8Lf4v1qrv+p8b+cl8j89T6vzPXqkH50/d0pgvuweij2LpX0wkQ65A/RVk/j+wCmfR2PeTVyv/PxhLBl6+RkuznvdbbG/dxPwOAi2EXUP1lWl77xPeV7b//adCGJ6n/c1nMF8b3qd8xxqDvyzIeb2TqUPeR7s/e7Krt2Xm3Zfqtd5jYn9jnQXv1uD+RH/jVwprMSpN9QvgZlkcQti1mUOOhle9TPkhXe+nzjbA9PK9xVAzFC8imwGUr621tX7x1mVP+9zD46un50k2z9q870esz3Ecb1ZPMf9RvMagJ0mUiJFIznfL0jPfP/uu4WP/s13+bodX/OCMT1PIA6tSvsbvuDd/lR2R45uVfwipw6v8y3EtBXEIKhn9AvULT/Jf/VHzWGwUVQ3wbzyk/wFnaEhT/cun/8co13Ca0vxjPy60mkft6Yojmx8+D/qqO9P+HrBxuWxQIH5GO75uP092ntUpmGkfHx6vl76nqGPZXdLz1oqjbMrNYdQN5Dc4yrEbb5GUe5L988OyA81xMaDmMfXSHitwuPkdOdfZ6Mm1N/RCeaaV7cS1EB+vucZaDtpXytoJ03F48+qcrnzv4fuGGLF6wBy4tTP8cEe5p461aMwPvTqUObrXCj3aslzE9/HXLZXH+b6PE7CXB/mxod/lU8G34DayZGzNcMx+1Em6DMNYU4bbmD+ulH4fpxlLmfuA/nfN/22vghW6n/QfQVq6I8QxrFTNT5mkrEWegxTmAUNi/qoV1o34XqrfdMb7sf9alsjG+eX/u68iqruCPekcR67+lcei/3ZftkXVwaMyczOs21hR5zDZPttVj1f/vweQ7GX+4sN9TSLXWP7l7HuFmP932R0R9kzt5zHpJAB18qu2d5aOQqAV1M/jyvWeSzxPYO5XsZVRQm3ruHooYw6Gsvl725Tvg+E5pn/JnMF5umvQJs/m11Ncf/7MMJ3LeTC3/meyZUTNNfw3wb+sxyjmc6utHa3LPvmYJj5Zum52i+2DNgXW/L10mK/ul7sPxlbX8YEfm7Xy/4PeVRzdO/syHOoNd5sGDNvqDO+Du4lXE/hP/NU7PkB36A5OOjDOn+3f/AG9e6B1yBffECaVwy+Xvdf8ZUZzKv5WkBpHYD3If3kg+g/vvapn9qswtfL+lBH++U4WofaLOXPc/lamQvzAJjbr0BnPFYabj5Gud9tub4j/1DjtQBf14Yatkd7DzfZs9jsfZLiHYYtX4PO5vxjm69R+NnnQQgx/VNbsReG5xHrwucA/LnXNMjmODbw+Z7vr4b6BuqkIJ/7jJyq8h5J5Tz391gRZ1wFfA7qxWwv+bY/XkGdGPB13iGMF7HWKbubIR8XUBtlz5IkuRTrXbfUn8v7LD3n3YANLuF4nr+rUHquQ/tOKq5Xwvvl9XO+1wjyymAmg0w8llTy9U6YS/N50Wkqnkt0xHj7tQ+Z7zeIxnxtF8b8ju/Zyfa9X8VaDl+7akqjkfF/qM+jPy+vk+TPXt7no1yWccWoQj4tz+s2+RpzXS72Ri358/1P6zRf+6j2DzBnr2ZrwTC/5c9Afutvns1p+LPPOd8PIYO/Z2s6+Vpkae7Nn29V3pbf527F5+J9E6QF827+zt+t+V6O4fPwIV8v3WKu/7Q2VeCTq1flax48Lv7yPd43H+sMY0SE75eMvs/VIK9s+ttP62bf90krPG5mNYPP32EqPw/hz6eN8vqlOhk6l7E8H2W+L9m9QM5jg7fbVlyjOQ5wP49frEnLbv/7fO7oz4p9EyP83nU1oDEUuFFgpsW+l20N5pTVYv5Vg0iZOvx5tWSl/viY8yb3zwWtqNuCNjlfF3I0l/epOobxBDEEaUIcC4xFS+HPsq/ZcxAf8ky+DujwPY8zPq8Zs2LOmRT7P89HPucB/ujZG98n4UhBLdvPXnWztWdvn/DnTB7yz/cAQczJdM7fW5xmazr5WufQ5HsPbcjLLHVH+Wd9Tak5pquX9gL1F7v+Zzm/73lwZ4z2HXyqaWD60g9M66f9DX+lC8SXeLpBp3/6aT/GopVs+N4I0v9XrLbKxiuvsWfVZBhuynssjmbQ0n/gn4En1rkP1xet1Xs/+VE/HoyNYz7XdJNibzbH/Nb3ucvrdpA3ezdS6h+zPVD5etUf6bk7kKUCc2S+52mzAtp8D1Y/iYxGVTzHN56c4Zy/C7sGP1CyvXtbxPWV/q7+G38V4CV7BrkYftLXEHKm8Stve6gF+PtTwz6PJYdPvgaxwPMjHl9/o13PczDfV5Hlptp0G/1iX72Sfb9YNwD58hgD87GF/hvOuuZ0frHD+E92NyA32BL8zWm+R9Wk9jvNFV+bk0P+7pJmf0SJu14YfA/ZbzSU4wz4mlWOH3zNKX9PZjUM93yv9K96SaF2G87HSuaXf0vP5Wuv+TMRoBHtf7bTv+9f+kUvQo+tz3br+sX700n2jjA+i6zT+7vAE8ShSMShpId7pIGGN7sqqiuRfH4Y3+jXYJ/yQBHbdR7bwVdL8cU5u3q2Fvlpr3Y3aGr9bfGsBXn8mzVAw7WQb19aYZwdDkpx1Zfievbc0MjzTrZvQeQk60/rkWg/6IfvAea1pCXWHH0pe5ZoOJd8LyP5BT2TdWEuOOX7Pkf5nnPhD/hMln16pnujvT6uZvtYsvc4i719QoZPe+BxLxLErFGfv9tE7+IVuHrOY7PnbY8a6NLxAncI9Pi5B+I9T6mpDrbu0pPOig9zHDt7v188nxtKdtuTm9pQN4a+3AA/dWHOueJ7A7LnGMVzk/efvovvqt7iw5dcDd9p4O9B8Jj0w/f4vgmo62T+/R3fAzEr9uX/9H1eH0K/MI9o8prvne+RmMU3eJTqw+E4yN/b93Ff/w2d5HNdPv/Lnl/c6idbD6q6fM9IMuRr0Vtem0d8/9CFnsHc7NuGeVE928v19TyCW3TyumD7g+3K7zxtf5Ilf683/UEO/hxMp3e9b/nPX/D5w5zf+5vv5mtkP9DOnmsNTAP86vzTd9rgw12Id3yPK3+uT3zi+xFRHrdhPmNsJtk5Cbf0xOfMsx/0bMtQG5Rlh0DUV0rfWQatvsb3ZcE4yOYhN56jbflzJH7+BX/mCb66pXnQd5q/9JfNAT6yOUCBG/qB7/mfdCKeHf78nexdAqFT2Qh047Pv7QMpe9afXcaSHyqWH8im+UcvLE6G85jc9vnxbVq296cV8Pp6MM/WIeQk2xs/qjE1aL5NsnNNINZAjTuGWBzyfVAx62X7WmI2zOmontNL+TFmjEFSqrJJqjqxdWGtmTKJlQ0L4oR1aqwRq3vrpByYGbJXpuzZLmUhc1+Z6bGnVHlgzz5bxDbcpwrc79noxCKvfYF7tZ0qJ7aJ2TRVHlnLYbNUeeX/LphSYy2J//vM2ozVYrXGjzk7pspBOelZX9s01pjnG4rnWGrqK2rciJS+PtCZ19EUZ6mfLU9hjYEROzpLfVVPPU2B72vsZCsZjv/nmfBvz1AYTANS9hEDXfMEfGtNNpixD6buWTdV3VhN2DAEPWhdK1Uf2K6mLJh2YuuT2vXUF9bz4buarnpxT+l7OlsxW2c+/DGDrmOgE7eBt46anvh/CvP0P/83ZEqH2Sc2bqgv6WDLLr46T61nfnLTXrVYwOIPZnlRC+ZbhnJ4A7uwZazErA1yMKXOzJi9pmqDdbcKyHhkbu2VtbfswPlvnVjITxcD3YLMW/55oOhV/u9Yc5RGqnAeVszcsoWnTzqxtmbdE/OGOpt6QKNlmRDIAAf9eEaVvaTQLz/IJu44qXNghgU68Je9WPVtfmSe7tWZflhxH/E8SVdW277qWbaqxqzuaQ3WDtmzZ8hsdFDmqfHKOj47MbA59L8At+Hn/4XM8PWrDrLPlNZmxpJBCLyADKbeVllsGR5w4p1AcZaueY7C0pPLzqynMylmBrPBNkHbUzxdlZjf9zy1n87AVwwt/tEGYDd9w4Y+i/l93+qoK32u9J2Bzg9Z1HQ35kcx6nwghnh+YlODP5UaPynRMfF8RoOfcQbeDE3XbOzqHK+4aXGUI5TCiO9ocYHXfDMu8HZYQ7yj1BD/1MWjIE22Rvxksy3w6sFGvBvzQ8f4GYxsps4KvNLuQrvG+dfTF8R/aPw8x+y4RKmNeLX2jPgY1Jfj1biL/HfZG+KNTYr8Sx3EW1Ij4x/+fs7Oosz4N/j5kRl9jZ9Bl+PZUEL63jwt8JrUJP5bMfJf73kF3lrVEf9GeFZbIP2eTni5hfpjbz2U3+o/kv6GNcTrK8S3/QfEn6wQ+V8RXlctxLeGDeT/tGZk/0fERzbKr457Kcq/7iNe1hDP4gTpKwZD/NVG+krXQ/21LuQ/ay5+jj/sUH/OivBnG+3HDA/111IXiPe2eoFX9QPiW00F8cO2h/w3BP5yQPyDrxP9F/R/LVIRP2ojfeXqxST/O+JPukX+94ryd2XCN9oN5P/FQ/11LiniI8lB/q0T0m/3NcS7HYvsR3imXsl+Ww/pxyeU33jTEZ92SP6wj/rvDGSyn+/h+PPfyH62geOXdch/h32vGD+WSv77xE/Sy/HWO+J110T8U+eE+HU/xqNg103ExzrGH03/QPld2UT+Jw7iWdjH8asMHcTPt7MMD/+nX1F+O2rh+N06qH+1QviO1kP8pcAD/w3Cd/st5D8lvCYT3h0SXvMp/h0Ir64sxD8SHnI7xj+28RA/JDw7SDT+6oQPXBx/yjvhzSvh36UY/ccnPDvaiJcEfjxA+2lDGr8TCeOvYkmo/86K8BtXp/E3iEl+wvvbA/LvSxT/623E+y757wvhLW2AeHd7Qv05hLfsDuIHroP47gD1bw+HdP7vluL3TEL9m5GD+JZL/n8e0lHEVx/xFQnxykEm/TVdxJ8IrxhDj/wvQPySaz2XfyvT+BV4x/WR/ynh9SvhFb+G/hcSXjt3Ef9CeOVtiPrrCPqHbY3kJ3w3IrzlYvxl+yHl7+sI8VOe6pA+6r8z7yH+lfDaZSj8n/BOFkky+g3Cm4mHeM3F/K1WfdI/X7HP8fwMzkL/joz20/t9xK8Jr1R81J+7Ifw+0VH/YYXsJw8Q77oUv5o+6s/QqP55kC2Un1VQf63jEPEL90Dxw0f5jc2U7Gdg/GR6FfGW7Av/ofy9CzySf4X4MMD4qbAa6X8VEL6L/s8WQUz2SxC/STB+Ko0n8p+3MeLlLvGfBlT/bE6UPwKKX1DSIv9vIY2/LsW/9xGj8fuB+JFM9VsW6XL/UyLEr3rkv8cR8q9da4ivJRQ/Zg/kP29TxA97VD9uR8h/K1bz87UhviVi/LNUL+ond070ma8U+huNyX/h/wp8fvJ3hrdUVuDVeYz4CosVzH8hyt9LLcQvK4z4V70Cb60IP2LbAq+uCG+mNuJfTax/1AbhO82Y6ifCawHhXY/wMJ2g+lGNdfT/FfkvO6D8m5Dqz7SNeKeCeM0hvD5fIX2YfiL/akj+G3cQnxCeNVTUP2uuqf4SeCuMSX7C70di/BG+018j/1XCa3qI9VePEV6uIJ5JGtqv1yR8yFK0nxqi/a3UQfyEn0Gb068R3l5tEF8nvOYQXmEu4p9Mh+TX0H69+gbl95iE+vcjrL90j/CdEdZvikV4PdqS/xNeNSO0vyHwHxWMP0oo6DcJPya8wiKP5l+u8F+KP1vCd94SxE8Ir1UFPiW8OqL4kxJe4Wfw5vi5oG9EMY1fwgcVEb8Ib64IHwt8nfCWkP9M9FWrpH/Cb4T+5YjqByF/ZFL95wv5jT3id0L+B4FPS/bD+KnGhLfkA+KPAq9P0H5tIf9DhfAnwmv2EevXU0n+iVfM33vwvwL/UtkW9a8aG+i/7hvhfWWG8q8nOP930hnix7tDgddqNtK3gxfEqyr6v/pIeDtNEV+vCLxL8fPtFeWPNKSv+BOK316N/G90Qvy2i/h2gYe/pxrFPzvH8/lLWhf0qX6cdZF/tXlC+m2N4k9rSvkrfUb884jyR6OL8Uc/vtH402j8b6bo/23WQPyiQvVX2iP9K+8U/zXyv8oU5WfpA9lv16D5Qw/jr9JMEV/TGsj/fIb8dxWGeH1M9Y/nId4KzjR/0x3kvztD/rswvyzw1p7ip96n+JNcEO/pIcWfGeVvhfLfexXxij9A+j2Bn+gHij8zsv+Z8s++ivGXxUPUHzMkGn86xe/HOcrv9Gn8PO490t+Q8pchI76po/6UxpzkP3sUP8YY/7TQR/mh1qT4b1iID+Yof68/RPy2RfNXKSD724R/Nqj+cOcof+88ovxfpfgTB5T/zrT+1jBw/Ggp4bV+SPl7T/HDGyH/rkzrb65B+X+7IP/tT2j877eYf9Ix6s/N1qcyfM9A/bG3BdWfyhLx8R7rN0UfI//u/InqR8Jr74R3zoS3qifKHyHqz3x7pvrVRP2r+wXJf94g3tiL9buI8HID8UuT/HeypPnHeY94bSzR+I2Qf63ZpPhtUv13WlL90z8iflcl/GlO+ndp/e7SQvqst8T6xV1VET+o1mj9aoH8W3Nav1NbVP9oS6qfBjT+lTHN3/wY6RvJI83/+FOFXP7Rktafst/iyeunKq3feSvEd1ePGH97Fvqvwld6i/i5pvrrYFH9e9gg/072qz8ZfmZR/DwIvEr1V7umU/4mfEtVqP4jvFqPMf8Za5E/D4jXvA36r1ZRhfw0/p9jmj+rlD8/LAvXj/wt0u+OVOQ/shnabxzT/HndJ/vVHPLfLeX/nUbxx9ZR/naM+cu6DBDfCGn9z9tS/O/qSP9so/+zxoriv8AvQ6ofvS36r9PWkX5iU/x/I3xnTfFLqVH8Y4Q3F7T+Vye8Wlmh/7OBj/gq4dVtQvnjQut/XZvyf3OF+m+vKX49hVT/sR3Z76El9Ef+E61Q/86a4odbi0n/B4pfKq2fDdsUf4M18t9a7yj/HLa0/nRE+bvvtP6ltbH+UK5rGn+XF8RfLJq/hi+IV55o/UppU/46rmn+fTlR/qyJ+uWV6heV1q/GHfI/eUP144Xqr+2B4h/0hPXTmvC9DvmPvaH4f7lQ/Vuj+GW9EX5A61deh/RnbFB++1JBfO8g6p831L+t0vrTukP152VD668Xqv9qYYPWf94p/1Y8ql8dqp/etqwYPy1NzB9shvWvd0V8692j5x+EV3mlXKyfD7uIb9r0/GF2FeOP1p/G2U9xZfZztzh/dq+EX9o0fz4R3nroI/1HwqsJ4fUNxZ9KhHglvNL8eT2g5y8O5d/ZFvOHMyT8MLIo/hHe2BFedxnFf8LrV6p/qhE9v2AS2l+5DGn+6mL8UpZbtF97SPFvXcf4pVkSzZ92hO+56H/alfBdjeJX60jrZ7FE9feE1s9CF+OPUknQfsqQ4s+7Lea/MuWfgY/0X1zMf9qQ8OwaUP1w9FH/DZny5yVA/LOL/q/uErSfdqX6rS7wnoz2V7sjxK9dyv+1hJ7fCfzwGFL8J7w5IHxCeOWJ8PaG8Fub8DPCO08jql8Iry0Tir8C/3wMcfycCM+exjT/FPzznw8q6gfB/9Kekf8Q3h6M6fkd4dU3wjuC/vlIeIfw7gPhJcF/jfB8/Rnr3zo+/9AOQn9PIY0/QT/eYfzgv3pV4K9RXMjPnAqtHzyEwv+ofpZ3tP4xpPp5EtHzk0MlpvhJ659TwmsvhG9phG8SXq0RXplMKP8K+tUd2o9dp4gf2VR/exUcP60d4c8uzX9dwrsbwr8eKX9tqzR+HiaCf8q/6Q7n/x2N1g90m0+1axr33yfE6+tppn+w16WL9bPKd9qA/SBeqBuqn08R4pXwiernCuEHXZJ/smcFvqVR/hwcs/zHByVM6in+c6da8C88dKl+fNtn9h9ktRDVP1GW/3QQzXqm/KFm68cwy2V6l9Zv5nuvwCsbwvejWoFXJcKb5gLxNcIrzX2mP17Ua++If6sjnh2eafwKvNPF/MHO+7Sgr20IPzo2CrzCCG8ulogfEF71CG8I+nuBDwX9HeFDwmsnwpuC/oPAp4RnlxjxC8E//6HAHG8J+v1sJ0CmP4vwRpfwW8IrDcLbgv66TfiY8B2BfxH8q4TvCPrVJ8LXnsX4WyE+FfynB7S/I+j32nqB1zzC62vCV4T+3wnfFfRlgRf2Z+oa8XGX8r98iJH/4Qfi/baF+PiZxv+E8K89yv99wnc3VD++TRDPpIZH45/wYQ/zPwQ4tL91PSPefHJIfsJriw3irR7N36eEVzdUfzbaiGdpQ9T/W8R3S/gj2k/XCK+0ffQ/i/DGJUG8L/C1I+rfFPjKC+EPhFcqO8TPCK9oR9RfS/C/fArRfxjh2y+EXxMe5heItwX9xzbhQ0H/aY/4A+FhqKH+2oL+9GWGeKE/yyT8u5D/hfCOoF99Qrwm9MeyoZLhJUH/5QX17wr6m6cY7Rc2aP65OAj70/zzRHh1c6X8J/Ap4bXJkeWrnGB/qv+qLx7Zn/DJZCvsT/QfCO8TnnVeUP+GoN+aHBAfE95UXxA/IbyavGT1F2dC0H8W+BrhlckrjV9Bf/2SFvHfFvQH7Wz+Z/L4pfDfKs7p53ig98p8FfNnjueTamawuMifL4jXDoTvvOd4YK1JeM3J8RNeqpqIrxN9JimxhfUP4SMWqrh+9coKvCXw43aK/DuEb69PiH8hvCYRvsMI33uSkH+BNwZviK8QXjm+egWexS3ELwkPRWBqYf1J+Ambof5eCW8J/Dvh1QPh3TJ9xGsFnuvfI7w6yfI3L8qA0QKv7d7RfhaLkf/oNS7wOhAq8HEb8UqN8O0F4Y+E11o5HkoDhxG+8ZLhW6A/k/C9hxxf45kY8ezwmhZ4V+DdpwbiR4S3ux+IrxFeSwnfrRFez3ZCZPgnwpuLFPGQwVH/2U6wDK8cbMS/PiMeBEX/ZZMz4u0Y8Wx18gq8mhK+N9URfyG8sSZ8l+grz4TXaoQ/PCNe0QnfqRB+QPQ1h/AGI3xF4EeC/4cL4iNW4h/tZwr+g6mF+CfCm2vCr4T+loRvx4SXO4hXBb67IPyZ8NoD4V2L8Parg/abEV5bXBFfF/pLT2h/dmiT/z4jHgINjt+OwFvxAelbhFcF/pHosyfCKzsJ8R7hldUb+o/hEX716qH+FoS3F4SPCK8eCG/WCN969hH/QHhDlRG/Fnj3De1vx23hv4hXBX1nR/gjI/mvhHcE/53XEPXvEN7qVhAvE15dvKH9uiHh5WfCv5f0V0V8k/hnlzeyX9hB/GI6Q/131ZTiN+GN+IT8e4RXaoR/Evgt4XsTwrcZ4pn/jvrXLMJ3n2PENwhvrms0/givqYQ3GeEfpohXLoTXL3WyH+FV653sJ+R/m27RfusS/4Q/kfxs84767wj5g85B2I/yz+gJ8VXCq1fCd2PCP08JXyO81n1GvBKn6P/Ld9K/5SB+93pC/a01jL+K2kC8Q3i2/0D96Yzw/muK+jMJb74TPiC8yghvCvongT8Q3nkg/JIhXtsR3joQ3uxIqH+P8OqoifiE8Mrhg+xXc4T/En5H+PaO8CfCq3XCd0LCX54J/0D43gvhr4RnrQ+Kn0J/1jPlX6F/ff2A+Edhv4TwLHaJ/w7i2UDD+Gu/P4j4KaH+ZoTXQsLrnQblL8Kr5iPihwzxivOR+Q//uey4i/hpjrf5+r0m4neGV0O+VaaB8mspK/B62iP6DVbgFUlD/1WzV7Iy/F7gJcI7HuEHhNdiwmfTlxzfVxjazyY8372H/ucgXvV11L+7JPwH4bVqjn9h2e6ZAq80svzNXx3RddSf8pg9f+SzIBPKApz/p16BV9M+4j0H8QojvLHM8Xz8EF655vh3nv8J/5LjO8C/oO88E35PeO1I+I5HeG2Wrd/zJMhapP9r9v4BRw0U1L/SSfn8ZcWfn3pLxE+cDN/nz58Jb42z558m3D7pVH80OL61WoP+FKofmo2s/gh5/BqQ/2VvzWR4plP+PqZpgWcryl/7k1PgmTeg/CnwJuF5LVPgVYXwXsND/IHwraGOeIfw6obwmqBfOSFeYYRnVwPxA0H/4ewVeEPQnzs+4kPCt6uEDwmvbQhvCvrmLER8Snj92UT8QuhveUb9u4L+zAmF/ql+2JhCfychP+L1FeWfUwPxajxA+zs9wl8Iz3rnlPRP8W/UmCH/1pDi77SF+INO8f/M8Rp/COwKPGtk6/f8SWuN8MqGe06XMzHTMX6xtwvaz15R/PNOMcpvDWn8ZfiM/gPhFYFXVxT/Vg7iFW9I9eOQ8C96DfW3JbyrEP5jhvzzJ+mov0fiv2FQ/Mnwmfy6QuP3gfCq59P84dlGfM2g+LO5eAWerQZUPzlb0r+fkvw26d9wUP7aJfM/wHeUIeKTRobnW/sOAfE/zvEQ/7qGR/k7p59mtQDijVn2/h13Aium+e8HX5XtcifQLYp/8SUu8MZaQfyG8Goc0/yrRfi1ZSF9n/CuqtL84YR4LY7Rfmq1g/i2RfJHl7TA81SN6weNE/Ifx6i/zpjwL4TX1oRXVJ3Gr5MiPlxR/h87iD9YqD/lcmUFvrMm/LGBeBavKP71CD+xaP3kNcPz8Mn332D+dbL6Jebrr2uqH7Xs+T13wicLx68y428NtbKd2QK/aGTvH/JBwDY0fpc5nq9fWjR+u4Rvq2L8zrL6Jeb2I7y65M//u1ZWddP4G155/FmrfH4l6p8T4pXDxqP42UX+J4TXCjx/fiXwj06GX/H9e4RXx9n7K/zVxxrhVYO/n5XhzTWN39OsUeBhAkPz5w/COzaNvznXVI5XafyO3GxorbL9O4hvZe93Zfh3wqthjufPLwX+rckK+kq4JfsLfGiT/8eC/prG/4PAp4RnH33ELwjPAskr8JZK+N5cL/CqRXhzSvgt4ZUr4W1BPxb4mPB2j/AvhFcTwncEfcklfI3w3Q7hU8G/IaH9HUG/NbfQ/h7h1Y8B4isC3yR8V9AfCPyB8K0p4RuC/4DwPUH/0LSE/1D+vBJetSl+hIRXVIq/rOkgPiS8qg0RbxFeGUvov+qa8LM54VPCW1XCdwmvRoTXBf0j4RWL8J0r4X3B/5rwhqCvvXmIjwX/2Us/GX5CeFaX0X9bgv5Q4GuEN8eEj4X8MuEtQX9DeBh/tH7xQfhdiX/CtwX9xybhD4L/ZYD4k6CvyV4xfjuCfjj30X+E/K3HHA9/Pwj9z2Qaf2sf8dWmT/wnGD/ZeCT4p/yhyDHxT/ipGxL/hLeeR4J/xKsPhO8I+o03xGuM8Er2fl6GvxCeSXJK8ZfwkTuj+Ev41pLwNUE/JnxX0JfnhE8J35sS/kHQjytoPxiLVL/N4yL+Mi+h+qEaov5Nm55/vBFeF3hjvsX4HSeifoxE/KLnL+eKiF+EV98OiK8RXm9NkH5N4I1KXPhPdx2I+I94kJ/yz/ME6Zs2PX/pVGj8qyNav22ecPwfEorf16nIXyHVr4TX1oSvu4hXGOGV6QzxA0H/uYr6MwT9iZtS/krE/Gsm8hc9v3msivFP+M2c8DXCtz9mYvxT/XMhvC3wZlOi/EN49XUu7Ef0B1Vhv5HwX8IL+vbjXOQfoq8Q3i3rn+oPQV/vLBDv2fj8SHmt4vjT12OaPzaz/d9r/lAuofXD8SKrn/hDOcKrV47X1hbXf0jrr2+I17wdxY/lEvG+Tc8fPqppgXfViOKv2yD6O7JfZyno0/y5S3hDnSI+fWsI+vT87LlEn9bPzFpmP4fTn9H6Y3aSQ23D8+Oe+M/0tc3/xku1OT5iX64H+K7pff5Maa34IjjvZ6sPGpO4OH4oO87g8/knx4XOS7ds/7tJ7w/n70tk+aHUa6avL/jivJFs/xidn9LzKhmez5fo/JTCX7JNayVeM3/5gs+//569/0l4JRtqNsve34o+0/fyORld+Xkbn/El+Uvnt6R8qGbyKw6d31KSf31L/hJeyF86/0VNayi/rBy+y2+k2nf5S/iS/OL8GHXUZYX8Glt8lz97UfOb/AJfkr90/swD39Scyx9bN+QfCCcU8pfwQv7S+TXmoY7yv6jhDfvHN+xfwpfkF+ffaCE/QCWTv8X23+XXZiz+Lr/Af7I/nZ8z2BzI/u0b8r/ctv/LDfuL83c66RPK31Rv2D+bU36zv9S+Ib84v4e9d9H/LXF+j5BfiW/5fwkv5C+d/3PQToX8WtzxvstvFGuPn+TvfqWf80/nByl8UzvKX/sufy9WbsnfuSG/OH9IdXvo/900vSG/JVxVyC/wJflL5xed+aEOefyTnBv23+v+d/nL5x8J+cX5Ryw7vyiTX2rNvsvfvhX/PuGF/9P5SazZI/9XajfGf3hL/hJeyF86f2nBz1/K5FetxQ37n275fwlfiv/i/KaOT/J3Wzf83071G/Ff4Evyi/OftDPJ7/YfbsT/9Jb/l86PKskvzo/q8POjcvn1Zfpd/jhLdV/lF/iS/OL8KXP7gPIr1o34105v5T+BL8kvzq9SE35+VSZ/RzVvyO/dsv/pC/3Ol/OvaiS/wtY38v/rzfgn8CX/F+dnKdIjyv9sxd/lb8WtG/5/+kL//fP5W8qkh/HPHHg34r9/y/4CXx7/4vyu5NrA8V/b3vD/p1v5r4Qv2V+c/+V6JL9l/7X9Bb5c/wh838P451xGN/0/vVH/2DfsXzp/bLhlaP/GLv5L+5fwJfnF+WXWG0P52/bp1vi/kf9K+JL84vwzzRLyD+Y35D/dsn/p/LSS/OL8NMXH+ldJ9/Gt/Hcj/pfwpfpHnL+m2wrKv2o7f1v/CHxJfnF+m/LoYfzTL9u/rf8E/pP96fy3D53kb7ywv7b/4Zb96fy4XkLyt9v/i7lv606UWf7+QHMxgDoTL+XkIQEFAZU7FQ8RNGaMUfn0b1UDTauVhJmd/X/3XutZe4j86K4+1Kmrqwj9X29R/L/EC/SX+edailPwP/OZ0H90Uv8R8OL+5/nr5lKX7/8/xPy/U/QLeFH/4fgnVeP6zyOl/1D7X8AL9Jf58/Q3Tv9Aeyfotyj6hfx7Jf1C/r3H2CrkHzsJuqU/pegX8ML6L/P3tSO9oP/5yajI/wS8QH+Z/0+LnYL/68NLVfpLvEC/kD+w7hf0g6wk5H+dol/AC/Nf5h9UG0ZBf/2J2P99Uv9bHYj9X+YvVNmhRMb/mFJ/S79E0V/ixfkv8x9uMTdqNv/Sm1ORfgEvzH+ZP9EOOP3JEyH/2idC/xfwAv1l/sXW0C34X0urk/Y/of8IeEH/K/M3+pJf0N86EvRrlP0j4MX1z/M/9hOzXP+E/ttuUfSXeIF+IX+k7hb7v//8m7B/SPpLvEC/kH9yEk+K9f/yTtC/o+ZfwAvrv8xf2VXbBf3nJ4myf2xi/RvvxP4v81/qEae/vXmqKv+F/JmC/6vMn9k2Cv9Py08J/meVzirB/1XiS/qF/Jsdln+T0e9aD/f0GxT/E/AC/UL+zpFb8L9emb9TkP+k/Istiv+X+Le4oF87pQT/08n9f9t+lr+N4609p/+dol90bJbr/4GiX8g/GnP6LZJ+Uv8/UfQL+UubfkG/7lP0mxT9Al5Y/2X+0xYmVczo/0XRr1L0i/iSfiF/6suw4P+DlKKflH8/KfqF/KsDo/D/tboSsf67pPzbOJT+x/FGSf+j3bqnXyPtnxeJsP+E/K8LTj/LRFpt/gObsP+E/LGzmPs/DxT9jxT9Al6Ufxz/9MbpTyj6dVL/8Sn6y/y1rcch93/oBP15kYEb+iWKfiH/bYD5b3P/l+RUXP8CXuB/Zf7c9luvoH9oE/qfQa1/AS/QX+bf1eqc/m7qkv4/gv7NTfv5/ndL+++F73+Kfofe/5T9X+b/NXuPBf2m3SX2P3n+UeIF+sv8wdpiyO2fMn+waP9R9Ps2of8K+Yd/xS9c/5EI+8cj/X+37Wf5CzheD58K+lOK/g5p/1gU/WX+Y00bFvzf2HjE/JP8r8QL9Av5k9O48H/D/jtR5x8E/QJeoL/Mv6zurYL+mk3o/wap/88lgv+X+ZtVllSE0a+W+ZuF+Xco+ku8qP+V+IPP/d8HmeB/A1L/u22f7d8yf7T9xumf3rSf0U/5P8T804L/s8QPvGL/P+kE/eqEov9A0S/kr3Z9iet/MrH/DfL8s8QL+7/Mf92R7YL+Hs9fLeo/pPyLZYL/lfmztXdOv64HVeWfddN+5v8t828rksTPvyj6yf0v4AX5V+bvbgX9gv4tRT/J/0R8SX+Z/7v14BX873ETVNV/Xin6hfzhM5/7/yW5qvx7ouZfyD/+2OuX+9+vqv/NKfrL/OX6ltOv6YT/t0XaP0L+c3H+Ob4nPZTzT/D/Hj3/I3L++flHc1DO/6Qi/QJeoL/Mv67VvIL/P6ajquv/D0W/kL/9IX7g8l9eVdb/CfqF/O86Yzpxnn+n4voX8AL9Zf54lWVayvwf6Zg8/yPoL/Ei/y/zz7/Jhf8f+E9V+0fAC/y/zF/fb3D6PXteUf8V8AL9Qv57w+f634agXyXl3zNFv5A/P0oK/7c+oein9b8NQb+Qf7/XcAv62zZx/qWS/F/I3y/4P0u87Rf7X/cmxPzPSf+nTfi/hPz/y6Dwf6uOQvo/CP+XgBf2f1k/YPA2LOhf2TF1/k/t/xIv0F/WH1B/+cX+72ymVf3/JV6kv6xf8JYU/l91opyo8w+K/hIvnv/y+gegVfDzX5vyf1H+TxEv6j88/scOWlz/IeJ/VImKfxHqL4j7n9df6CU+3/91Qv51KPoFvLD/y/oNbTMo6Hf6lP5P+T8FvEg/r/+g1YNS/9sQ/r85ef7dtyj5x+tHdJIJl38Nh1r/DiX/EoL+sv5EtzEq6F/2ifVvUvEvAl6Mf+D1K1q/g2L9294rKf+I+RfwQvxPWf/iYHL/18tvYv8rFP8T8IL8K+tnqPKkoP/UJ9Z/l4z/KfGi/cfrb2hPoxa3/4jzL/GoQrD/+g+U/cvxv5MVt39/k/5Pyv+vvxP8r6z/Yb6FBf2bQYvif8T5p4AX6C/rh+irEZd/nkys/zo1/yVe9P+U9UemQWH/tx5+tKjzH4J+AS/wv7J+Sb83LejvDF6qnv+WePH8m9c/Uf+MuP2f/qD0X/L8e0DwP6F+SsMs7H8Vxs+4oz+k6Bfwov7P66/YLClkpv+3eP4jgf+T67/Ei/PP67fo6ZjPv2Net882nU/xP6H+i6D/lPVfzITrvxOVoP+Bol/AC/SX9WNUlpSS0X/h9WO+1H9LvEB/WX+mtZsU+99ede/pb5H+T+WmfUa/UL/GVwr9V3+4af9j/7eAF9c/r1/TaXL6O7x+zVf6r4AX4x/K+jldTr+56hH0k/bP6Kb9zP9d1t95GfH4n8NN+/HNRwX/96l3T79Qv+fxzOl/p+in7f8Hiv6y/o/2k9NvnSj6Sf9vStEv1A+SOf26T9FP6/8OQb9Yf0hd8/jHsv7QF/4/ES/ovyXenvD4z9Vj1flf3LT/dFP/qKsU9o9maauK9At40f/L8brN6U8r069bFP1l/SW1w+lvlfWTvrJ/Sryo/5b1m1Zbfv/hRTsZFe3f1RMx/2X9p17E6R/ctP+J//9BI/h/WT+qNZgU9p9B0k/aPx5Fv1B/6rndLfd/VfrbJ4J+oX5VT37m9h9JP+n/aVH0l/WvNInTb5P0k+u/RtEv1M86c/r1E0W/S/L/FjX/Zf0tO+L027x+1pfnnyVeoL+s36X/5PS3WxZBP+n/m9y0n+9/jne2PP7L0gn590Tvf4uY/7J+WJvVD2P0HyvTL+AF+sv6Y9pkUuh/facy/Q2KfqF+Wdrm8V+O7lSkX8CL+18v64dsyv0vqdXiHwS8QL8j1N/i9Bu37Ts3XLWk37lp/+mm/prZLuK/MH/SPf0q6f91CPqF+m0aFkXMz38r0y/gr/gfzx/N6r/l/K8y/R5Fv1A/br3l9PuV6TdJ+sv6c09NTv+oOv0Tiv6yfp3+k9NvVqd/TNEv1L9z2j6//1WZ/ja1/oX6eZ1mUtAfVqc/pugv6+9pv8NC/rdXlemfkvSX49dUOP2H6vSfKPrL+n+tZFvQP69O/4miv6wf2JqGBf/vOJXpjyj6hfqD7oj7v+qV6e+sKPpL/mVGnP5ldfpJ/ifUP3zh9Her878VRb9QP3HB6deq878utf+F+otWwOl/rky/RvK/jVh/kdNfff9vKPqF+o/2iMf/OZXp71H7X6gf2XZ3PP6pOv0+RX9Zf1I7hzz+sfr+35L0l+P3c8vpn1enn9r/Qv1LjdW/ZPS/VKe/xBuv82t9nsF/766NXPa/Pzgo2s0fW6OIwJ+wfsMtvob1H27xxmhB4Ne71T1+ifUfbvFPCwKvqxTeCh/u8ebrkmh/h/UXbvFxj8D3fhF4vUfhf1P4AdV+y3ohxr/92KLGb0X036PwSwrffSbwWkrh2U3kW7z9g8C3Ri/E/LNSabd4/bIm+t+l8H9eCbw9JPCwF4j5t7H+wt38s/oPt+0rFD6m8E8jAq8PKHxrat3j1eOGov+VWD8TzB9/N38sf/3t/F0o/PEXgbcuBF6PKfxPCt/6cSD6P/9DrJ/XR4J/DIYEvvXzDzH/wSPBP9rbN6J9Ep9Q+Mcjgdd+U3iZwlssf/zt+F3+rKjxI/iX9vxO0F/7Q/GfXxT/0Ci8eyDGP/xN7X/MdHxH/zuFV/8Q+09rn4n2mwdi/EZPBL5zJPDahsK/zwxq/RJ4fUbh9d9dqv8XYv0EB2L+pk8EvveDwOs+hW9Q7Q9+EfjW9kDMv/2b4B8ddj/sdvx0Cv9G4a1nAq//oPBtLMp8t//aEtF++41YP8lvAv/4TOBbyzdi/vwnn1i/ikytXwp/mRH4QZ/At45vxPytMP/7vfxXiPEbU/g2pnq6k3+PNWL9Nd6I8feeiP3fvvwk6K+9E/jWA7H/1UGLoB/LB96vP4vAD5YUvnMixr/zQMl/XSXob1H4gMJ3BgRee6Hw6YHA93cEvmVj/uXemqnnyzJ/Nu7fiYv+m5v8zbfts/zNt+2z/M13/IdlDbmln+VvvsWz/M13+5fCZ/mbb/Esf/Pd+LH8zXf8l8Kz/M138p/lb75tn+VvvsWz/M13+79G4LP8zXf7Z07svyx/8+34sfzNt3iWv/mOf2zaJP0EnuVvvhv/AYHP8jffyb8HYv9n+Ztv6Wf5m3tU/mZtQuVv3lL5m+/mH4XSnf7L8LfjR+JZ/uY7/ucR+Cx/8538O+D9n8k8YxhF/8dolWxxEIbdFs9/d2H7j+X/5fmLpQdCfxqkfWL8k5QY//Wc4J9PnQEx/n8ofCdqUePnEOOHlX7v8FubwD8tCbzepfB1Cj94J/CtJ4nYP2ZE8d+aS/R/S+HnTQLf7RB4zaPwe6p9Wyfw+jOFVyOCf6q1IUH/H4nYvwMKb+yGlP1H4RMK/zgg8Nn9ojv+aRP41sAj+r+SiPUXNCn9r0PgNZvCbyMC/zim8A8Uvv5G4FtYlOeu/xuZWL/9yKH4N4FXEwofUfguhdf+UPj6G4Ef/KT6v5Mp+YX5I7UJlT9yS+WP7FH5Ixn+Ln/klsof2aPyR+bt3+SP3FL5I3tU/sii/dNn+R/1oO7c53/0fnTv8z+a78+f5n98LP3XmxGPf4wr+z8fSf/3S+n/drn/87W6//OF8v/+Kf3fLClsdv+juv/7D+X/fSr919Y25vffdTL+p3tP/xPl/9ZPOq8/muwL+h9aD/f0P1HxjwJeoP9FLep3a3+mxfnXY8u/p187UfGfJV48/2zx+s+KEvP4f5OIf1hS+Y8EvBj/0ynO77XeK4//Ucnz/x4V/9Mhzv9/aEX8orqY8vw3q4SYf0cl6C/x4v33Fa+fnIx4/Gv3iYh/SKj4bwEvrP+51eLnv5z+nd5SifyfVPxviRfp13n99p1Av0TEfx6o+S/x4vmnUyvwjwqPf41tYv4NKv5TwAvnf1K/6L/p/inoj3Qi/rNDxT8JeDH+g+PV5rSM/6gT65+M/2voK+r8t1HgX0v6D/3q8Y8NKv6R462E0/+uE/GPGkW/gBfjnzge5p/H/9+272SeBCL+t6bHVPzb7wLPkmrn8W/9ExX/TNAv4MX4d47vRoeC/o1+qDj/Al7Mf8Hx+tus4P+D029i/ZP3v37qRPyXcXrg9We35f3XAbH/AzL+pcSL538c37ff+PmfTvA/k6R/NSDW/wPHq79nfP+3Hgj6Xyj6H3Qi/slcNQu81Ob5HycDYv2/kfEvJV7M/zzg8Z/he0G/rtfv6bfJ+LcSL+Y/4njtdcb3/+rHPf06ef/j1037ef7bn7z+ca3F898OiPXfovPf/iTk38pp8fjHU0F/3SD4v07dfxLwAv2GwetPu/NC/quqRtBP5n8Q8IL8U3Ue/zTm8a8th6C/Qc2/gBfojzneapwL+huGRfE/iv7YIfa/anD5/Twv1n/LNavyPwEv7H+V318Yjnn8a8utev9BwAvr/zQs5q8bXgr6LYOQf5pD5b8s8WL+G+OFxz9x+k23cvx3iRfl35rjf5T0vwxXVeN/149U/A/HG2rK438MIv770SHvvw2J/d81ePzncl7sf6y/ds//yP1f4sX4j3WJH/P8dxOPjH8l5l/EC/nPvDL+TSroPxsSNf/U+i/xIv8z6jz+JyrkX3/dJ+bfIvO/GQT/G7gDHv83LuLfdMkj9v8Pav4FvJj/1y/Gr3OWC/p/mwT/65P5X0q8eP/HNAr6zYjnP1q7Vekv8SL/d4cc3yniv/TYX1XUf0W8kP/TL8bPDHj9g6ZJ8L8Wyf9KvEB/0+T2nxNx+e/6VeVfiRfpPwdc/u84/YfAqUp/iRfzHwR8/ORaQf9Pc0Ltf2r+Bbxg/5rzgv73iOd/UMdV9b8SL67/Ev/e4fdfT0Hl+H91TMX/j4r1O1A5/ba5ouw/6v53iRfz/5lcf78siv3fU0PC/iHvvwl44f6nOy3wtTHP/yaNiPU/p+gX8IL+G3O85vL6D3uT4P8WVf9CwIv57806t/8XZf77BbH+yfwvJV6k/7zk/o8Oz3/2MD5V9H8JePH+O8drMq//4JgPVeNfW2Ni/7scr2kLfv/HXVb1f5X4Vu2F8j//sqj4lQ0V/7Onzk9+UeePw4SKP9oT/tvjI3H+aL8S+Fa0J/z3zi/i/K/zY0v4n18pfPpI4AcXAt9a7InxG7wS54ftXzuifZXCv1J4+8eOOj9+Jcb/8ZU4/+tT8VOtHhX/9PpEta8R8Q/6nop/aP4h8OqwTrT/+9ii4neI/luPBF5vUHjvKabiJxvE+MtHh+o/gdf6v4j16x+p8yesX393fkjh9TcKb/0m4vfMH7+J/k+PxPgPqfiRts7Pb0e8/qxm8/Pbx/L89oD1Z9n5r9bl9WONQUDQv6bOX5ZNYv/2UgKvL2Xy/JCKH+iMiPYPMjF+mzcC//SbwOsXCm/aVPwPy2902z7Lj3R//kTFD+gEXg8ofPONwGssv87t/mH1w+7irxbE/NPnR2+YX+X2/Cj8Yd2fH3WeNp+eHxlrLn/kGq+f1KXk55r0n62X1PkBx/cbXH6mlPyk9UeLkp/zNrc/NgueP0hdEfpjTNaPareI++Puc4Gf1nj9JH9C6E9Tin4BL94fnBT9f4x+F/QP2oT98ETljxDwov3Q5vr/aMn9p25M+s8J+0nAC/eHztsCPxufeP2IkKCfrh9R4gX6DyG/P7zn9aOe2nNCfyTvT5Z40X9a4u1loT8O1B1BP5k//6FN2A+P7kuBH9R4/aR4SvgPVuT5aYkX80dO+f2ZM6+f1GsT5wfWyiLoL/Fi/axO4f/SZpz+PtjnDlE/jaC/xAv0W2uF24+cfr0bVbWfBbyw/ycRn78mr5+kdIj5J+tHiHghf0qHnx89Lfn9KZc6PzLI/Dkd4vyotebnD+tanZ8fLgj+N6bOTwW8eH9yVawfy+b0h92q/mMBL9CfdLn/w1zy+1NDlaDfougX8ML5EYxVjh+Nef2k1ZpY/zF5flTiBfvxxPG9kNdPOnQdlaifQJ2fnNaU/7zL8+eMOf2qZla9P17iRfvxwvG/Opz+hzXhP/Go+mECXrw/+FysH6PfKuh/7hLnZ2T9OAEv0P/Y5f7T1arg/9oz5T8lz09L/FX9JI4/v7R4/aRNy6iWP1fAi/kjOL7/zOlfdYnzsxadP3BDzP9zif+z4vmTSPpJ//kzRb994fh5l+ePnFP0L0n5f7Go++Mbfn98y+snjbqE/7hD5o8r8WL++C73H//i9Ntav6r/rMRf7X/u/x1MeP2k1eZUef8PqP3P8Z2jVu7/qvqfgBfPT3oF/9QeVvz8ZOhQ8SPk+UmP0P/aJb7B6VfjuFXx/Kx9236W/yAu5k9d8PpJw55BnB+Q+bNLvKj/crz6tOL6r+aS8o/yn/UI/j8YcvzzxOLnBzHB/7ak/3ToUvEDcaE/WK+c/k2vWzV+rMSL/lOO18+c/p42JOaf1P/iHnF+ag053qgX50e6Ea8q8j8BL9YPLvFdzv9kin6Vmn8RL+h/Jf5hzc+PLkPS/qH0P4p+U/MK/HLC82c4cVX/uYAX749zPLuUmt8f71Hnx/T98ZjY/0eO1984/U/PXtX8Yceb9rP5L/uv1vn5WYuin8yfbVH06zHHtxe8flSDpJ+S/wJePD/v8fMjZc3zZw2p+MEVeX7eI+y/xyE//6lx+rU4caj4OUL/F/Bi/rSE6z8XXj+q35ur1fLHCngxf3yvjB9b8/zxzxOCfrJ+bom/qp/Kzz9+TXj+jNZ2RcXPEPGjAl48P9wV8kP/wesnNXuE/mM7ZP3oHaH/XHqF/NTDNa+f9EycH2gvlP5f4q/0P+6/sOu8fs7phaC/RtEv4MX84fti/dgar5/jPfpU/Cil/5R4MX/eIz9/DJ75+dHztmr+TAEv7P8L9x/sXorzI93an6j4Ycr+veyo+KlXnj/qyOvn6I+xWq1+nIAX6J89FudvavrM84ddXon5J+2fEi/mz3r+U+AvXR4/O3kl6P9N8T8BL+bP/sPzh/7i9WPUR2L99yn5J+BF+cfx6v6Zx49dDlXjp34/kvr/W4E/1rn/b/7Hofw/XUr/fyPW//zA46c1Xj9l/NSqGD8o4MX4+RIvb3j8/OVErH/y/PTPE6H/Dp45Pn4p/H96/dCi5D+x/gW86P88FPzj8ZnTP3jqVowfFfBX9HN8b8Pj5y8XMn/kiqKf0v+eefx1WC/9X28E/QtS/j9L1PnxG8+fOuT1Y5wnv2L8gIAX6N89cf5lbor937soVe1fAS/Mv8bxg5c6j594W1XV/zWF8n+8cf+vxuunPD8R8l93yPqZb4T8f3/i8vuyKfb/04Xy/5H2n4AX5P+Fx1/XJ2X9lCN1f0al8sdfiPhx1Uk5XuH1M3xLqqj/iXjB/ivxb3Gx/zu6XTV/6Nyi8ieV+KDX4vmjUqdi/uSeTt0fOnF858jpP1D0m7T9T9GvWjx+WOH0tzwqfo6sn1LiRfmXcnyT09+ap1Xz5wp4kf9zvNrn9UPGVr0i/ept+9n9AY5X7Zj7f9J+Vf9HjaK/X+KXPe7/OqRV7d8+Rb/+wPHdH5z+nxT9pP9PwIv1AyweP5Nw+o3NgIwfJOgv8Vf1QzheCXn99ElK6D9k/VRzM6D8/yX+mddPCa2HivlTRXxJ/7nEz+OC/1teZfrPFP22zvFeyPPnOumpav5snaC/5Uj8/tCW02/Yrar500u8mD+U47URp99ICf+f2qLo92xC/7F0jq+V9Lekqud/Al6U/xL3/108Lv9to2L+bAEv0L/neHUZ8/hJz62aP39vE/4/a1P6/xrc/9eVqvJ/AS/qf9KK+785/QO7W9H/K+AF+uscr6ec/r4+rDr/dZvQ/zSd+286e4f7v6Wq61/AC/Nf4o0prx80sanzf5L/37Z/zOqPFv4bVUkK+ad6hP9HJf2/Jf6K/3H8scf9fxO5VfH+nIAX7w9zvDXk9L/aTsX1L+Cv6qfx8z+P099KA4J+0v4r8aL/o8Sbe54/9kF2KsbPdlIqfvrA8eaF10/6bftV8+cfZGL/D+xCf9e2Ca8fmY6q3h8p8Vf1wzi+UdLvyIT875Pzr48o/Z/jtT6vn/RsTyrnT5WJ/b8p8fWEn/+T9NP5Uyn6e2X/vT3PH0vST+cPJen3Ob495PQn1en3Kfq3HK/+4vT3NpXp35L0l+MX9zj98+r0pxT9Mcdbvzj9++r0xxT9rxyvL5Oyfmhl+l8p+h/L/v8u5/9Qmf5Hkv5Tif815vZPdfpPFP3vJV5OuP1bff2/U/Rb5fpd9vj9iVZl+i1q/esGx/eGnP5zZfoFvOj/LvnfG6ffqj7/F5L+cvzOe06/VZ1+av71kn/YPzj9UnX6HYp+uVz/9aSsH1eZ/8sU/f1y/KzGitePk6veH+xvKPofSv73i9eP+1md/hLf/fFCxN92qPj5349E/PlgQeBbyivKTwyi0Ddp0f/oFxE/3hvtifYHHG/qHK/9IuLHVeWViD9eYag/w7fL9vdTFr+NSt3podD/9C2R/1QNqfj/1SORv0vVHgj6d+9U/PEfIn9s+0jgtRaFP1B46weB17cUvv1E5H/VRk2C/pd3Iv58MaPyz24JvNag8JffEpU/msC3Ou/E+Hd/E+NvPP8g+p9Q+MUTge8dKfyeyh/5PCfix5/0FtH/Q5l/ccXzL06tIv+iZvD8i081nv9uYRb54/QBXopm+fMGqlPgG1aRP09t+U6OH+w4PjaL+wut/sXJ8X3VLfDdhzjHt7p+cX/B9vj9B6nbLdr/we8/9DWtwD/ND0X+u5dV0X9z91Tg+10rx6s/L6cc39b0Av/G8VqJ7z9xvNF1iv5P0laON5+NAu/ipeYMv1q3eP4oq8AfOV7bcbymtXn+qIcCr76sC/r77wyPg/jcPRTtOymV/9si1q+Z2sT6+Y34HobmGRrPf7h/oPIv/ybwLTUl1m+P5Q/Eykat7qaYf3NA5A9Uf1H4P3Ni/XfHxP0JralQ/D8i+L86Don2JwoxfoeI4P+tP1MCrypE/9cRdX9oSeD1I4XXmsT9IW05o+7PKMT9k71N4PsegW+NasT49ZsU/99Q9QskCr+k8N0agdf+UPiHNwKvvhP1D1qvNSp/8RuVv9wj8NqSwp8iSv4sF9T6Z+eFV8Y7/O+HQ9y/qcXX8VjsoxbGEoa473qq8d5+ad34z1oyvz+icf2pZRPnZ60TlX+ixF/5T3j+IXtb+k/CqvETJV6Mn9R5/MtPrj+qK6Wq/izgRf85x+sjXn83tF8q1x9SCP15yvHqfsvrD22mlesP2VT+jZTj9z2ef+1Qnf6Uov/E8f1XTv+cot8g40dPFP1HjtdlTv8TST8ZP3Kk6O9709J/9sLzL1D0P5L2gzel4mcUrv8upjx+xibi5w3Sf1ziBfp9jlcnWx4/rM+I9U/Gj/o2kX/K8jh+EXL6DaVq/UUBL96f4fiuwulXSPrp+zMU/T2b3x84cvo1b171/kCJv1r/HJ82+P3BQ61VMX5UwIv+E44faNPSf3KqWn+2xPcp+6s1oupvdF8J+flI1p+YU/q7QeWP19pE/nh9TOnvfSum8h/3CPlbvxDyy3kj9Kf2O1W/ZyHkL53z/NfMXnfUm1FhVtBN/PIkO7rjmy9bD5kUv45f1rvF70J3NbdoT+zuYVWsF6G7WX6ZG3wrbDn3eBd95rf4Dp553bXvUfjLicBnr9zg1afW6h4/QZ39Fs909lu8vqLwXce6x5u+TvTfap3u8Y0WgdcNg+j/RCXGf+049/jeicDrGoWvrQj8YFLgB8KrnpqPv3j8+3Qq6ts/CJvqwbzHqz8p/NEh8P2YwLcsNR9/XRAfA7asjev0ex12Qw3xU2H8owLfFkg9nQq8cPw+8Au8J25VNZ8/kX0/nub3eKPeucer7wVe7P8zxwt/tLoFXvAJ6s8F3rxSgFf3eA0NuVu86mute/xqReAfuwQe68Pf42sUHuuz3+Fbnubc4+1VnM+/KL7nvRxvC/0fFHhx/EYUvu1T+DeN4B+vLQJvvRB4/ZVqHyvM3eFbq8d7fGuoEev3kcLrrUdi/79rBP/ZOy/E/jUIfGuiEfzHPh2I8ZeeiPH7oRHr99Uh8NacwOtjCv+LwrdOFjF+D3rrHj/HS0W3+KcugddtCv+TwoPWSLTv6MT8t0/SPV6bEHj1icI/U3jM733f/xaFr68IfP+F6v9aJ9bPwqnfrx9r3ifwK52Yv+nqgeh/fUDIn5jCP1D4QVzg5+L6NfL5E8OPn9Rc/xDDB3TfucerGoUfU/g2hdfI9uUzgVdXLjF+S4OYP2dtEPsvJvDqwSD419E17vmvbg0J/r82Vvf8V1537/Gq5BF41yDkz9q1CPm1IvAtphTc4l/XDtF+HBDtd01CfixUn5BfBwLfmpg5/R1hqmbq5H78e9KIWL+pSfDvtjon5I8xJuZPNgn++3aeU/KHwOscL7bfWa+I9YNFfe7a37cJ/hefCbxlEHg9pfDGmpCf5im8x2udNrH+jy6Bt2MC3zLalPxcE/LTOEwJ+o8Ufq0S+CeHwOsHCq+6hPzSpRk1/21Kfp4JvG0Q+FanQ4y/7xLyq83OU27736fwv84EXn2IiP6POsT8rV1C/tjziOJ/HWL8vHWdkB/Ggui/QuGHa0J+dIwlsf5OHWL8W5cWMX9Mqb6lf9Ilxu/5mcA/HlaU/kHh9SHB//XJmuj/sEuMv0LhNeuZGP9Tl7J/L917fFci8FrSJcb/ncLbdar9bpcY/65mEfS/bIjxDyl8+EzgOw6B11QK/0rhn1YEXjcp/I8LgVfnMUH/pUfMvzN0CP71QODVNYWfawS+Q+G1dwp/ovD9FwKv/6Dw7YtP9L+VEP3v9Ij16z0XeMF+bncLvC7OX4FvCfJ7NyTwTycCr08p/ING4FV2beoGj1eR7/FDbUL0f0Xg1RqFfx4S+N5LgRdUHe1Q4EVV543jfdF/UODbov+Q4wVVv3kp8BNx/e7u8a1673SPd4fze7xJ4dUXCr+m8L2XAi9c39eUAi/eFFO0Ai8c1w0cqv+sVPht++Zldd++zkqN3/bfo/DhM4HvzAm8RrafDAn8o0PhUwp/ovpvSwRe/03TX+hfov/I3+d4UVT8fCz2j4Afcbwvyl8Cr3ULvLh+Xzhe+OhTfU/5Xyn8T43Aq9Zrjn8S9+/j6r7/3rDQ/4Sm2vPX+/6rDxQ+vhD4R4nA6xOOF+WHVuDFm1rxnxwvZpqqPRbrXxz/YaE/iv7PFwKvLSj825DSP+d/iP5fOF40tYene/q1yYHg/9ZTsf4EoiKOFwal1yrwgqmtrQq8+OofjhfG70kq8KroFKDwDQo/mBP41uOTc09/ZyhR+tsbpT9nePVKqCxzvNOqi/pvhjdE/7f+WODFCIbfzzlevD6iGsccPxRN/adVhhft55FWz9sXz1+kAh+I/nOOF159H+Z4dS7ynwI/Ec9knk4ZXgy36F0ecrywfs3Ve46fCUQpBV70v+84XtTfTgVeuP6tz55O9/Nfvzzcz38/fifWz4nCNyl8pmnerp+JRay/Ttq6x2sTCn/keFH/4HhftL9P9/qDerAI/r/0WvfyoyudCPmzoPAHjheIsi2i/3pI0V/3CPr7dQqvUPifnP6DyGrOBP9fW8T+tT3jHm84BF4dUvhxSuC7vH2h/1qvwIv9j3n7Av29+Ezo738sQn9+3xD2n90l8DqJ/0nhVVaq+NZ+USzC/vN1wv5rny6E/7Rd4EX/6S7t3vtPrS6B149U+9qGsr8eUqL/DYuw3zydwLdXBF4l8RuPwD+2CLwmU3gpJfADi+r/wCbsr55O2Y8vEtH/nxQ+2RD4R0mi7F8K/5tqX5Vkov2uTay/QCfsx7ZF4c8U/pnC92ICrx3sQv6K41/gxfXX78rE+pOL9sX1q3mTe7zmK8T5g24T6z/YEP7nTlch+u/YxPp/TQn800kh5IeFfEtn52115GsDfDaQb6nGEzNl8RnPA1UHnwN8Nlf4zM7z2PlhG/HqCz7P8LnD8Oy8cI3PXXxfY6reDp8f8XctxucDPj8hXmPtv+Ozhb/rrP0Le8b29Qk+1/C5z55P+NzE5wF+X394QtLw2cVnA7+nMnp8/J6J31MZPT7iTaRHZfQE+L6J9KiMnhH2x0R6VEbPmOGRHnWBzyE+t1F1VPf4PEV8+4DPjJ4Z4tusfdb/ObbXYe0p+ByxZ1Rd1QY+L/F7Hey/xvq/Qny3i886Pq/x9y72T+vi8zP7HfunPeHzhv2O/dP67Bm/30M5pbn4HGP/HrE97RWf/+D7j+z9I3vG959wfDTW3wN7xv5qMj6/If6JtV/H5yO2/8Ta/43P7/i9J/Y9dh78jngLv6eb+HxGPDv/1Vn/L+wZ6dUdfJbwezbSq4f4rODvNo6nztZPA5/7uF501v9f+P0+zr/+hs+/2e/seyd8fsDvDdj3UnxuYv8GOF86G/8m4gc4Hjob/x+IH7D2HvD5J8Pj/Ok/M7nO7AFkypqeBYjgpsNnkwX1sPPiOT53dbYr8fkFn9mtDZ3hJXzus2fEq8y54+KzgXjVwmdWhMdCvM7Oq1OdbXh8xu+rDO8h3kS8yvA+4k3EqyzIKEC8iaqlutSZFoebFPuvPrPnE9u0+Jzgc4j4Nvv+Cz5PEd/G/qt/8HnG8Nh/9cieT2yT4/NZL87bO6x9CZ8jxHdY+zV8XiC+E+PzL/bM8Hier/7A5+WJBfFh0gJVZ/En+Izf0wydxTPhM0tq2sHnZ/xeF7+nPbJnhsfvaew8f8PwDywJAktaivgejqfm4XOC+J6PzyP2jPge5m/XQnzesqSkqBprc3zeMXwdn9l4viD+0bDKsDI8CGfzx+i32fwx1Z7R38f3DcSrAzZf+Gyy+RiyZzafbD4CNn9sPrH/6orNF5sP7L+6YfPD5o+N3xvrD/6uIl5n/OgX2w9sPTN+9BvXc5+tZ8ZfH9h+YPuT7fcHth9wv+tsvwcnYj2a2P/b/aNO8PcR/j5g+/MX20/sd7Y/GX/+yfbXw1OrcH6y/YHj32qz/cP2E8uf32P7h+0nZppYbL+w97H9Fhs/A8dPZePPxm/ExgvfV9l8jcv989+Wb0wedE4s3pSQd2obnz0mj5h8YvzOZ/IF+ZPK+NkU8W32O+M3MX6/x+bjkfEfNh5sPth+CNl+xPFTt+yZrQccP3XP1kfGD55YfBfOJ2sP5afK4m1GTJ7hfKlT9szkIc6XGjF5x+Qh688KnydMnrH+bij5N2PPTD4yeTJn8ozJ29+lfGO//yjlE5M3bPzjUxX5xOTZmcknJo+QPk1i8onJI6RPY/rBkckjpE9j6/HI8EifxtbjO8MzecHk7QnxVvdjeeV8KK88fJaxPZvJlxF7xvbsFSXP5vhcY3i2H5f4XEd8n+3HLZN3TL4x1xbjl302v4x/vDN+y/gp4x8X9sz4KeMfMuO/jB+z/cDio5bsmfFDtv9WjJ8yfqgz/sr4KeOHbD+uGT9l/JDtx2fGTxk/ZPtxw/CMHw6ypNDIH7E/GtuPMeOn2B+N8bOE8VOUHxpLor07MSWQ5RPU2Ku4X9h+e2H6IXtm/ILJcwufdRzvFpPntnOjDzJ9kemTv6rohyumL7H1p7FnfL/L9B02/+tVVX3rVn+90/cYP43wex2mXzL9aYHvd5h+ScrHr+TRZpX7FbqC/KGe8f/Mpj5T5FM0dpN50pNnO3c/GwXL2cjcz1bqcqzIL2MlqIcjW47awXLaDtZhO7gA7m0ySo7AB+J5apzcbVOebd111E7eZxvj4m2b0nQU7ieKCf/fPAYbSxnXguNEaR7DdsL+NhmdDwu/d5mO3F3ohxfox2Cy3SeTmruPtoG+8E3dVx7OttHwbr/nyPbOTV5a44ubWp7ansG3w3b2m+X1+jP4RrhNNpMx0KM0Rt7I+OBdezmWsN+mF7Wbl8koSpw0eF7geKThIRw1dlF7rUJ7I1+Jlr6SSBMl3HxAdzqWmwa0ufZr7vt8awJdQLfSa8DYpX4t9MJauPsLbG2snJPZNpKmpg1jMv8LGqLlTAm3cyWQoM9KeFKXvY51tozwPRo14mxc6mdLbi5d+M4ksKVZrbcOlUD/cKw2vSXOH8zNJYI5cce9C2D8mRRc5tvmZTG2Tq6nLuem/W4Z1onN0YpsNw2CnhVsjAaMTTb/gfvuKb1XWGfSdBwmgH23/YaH7zm1pE2PmR348XlkpeESvr2BeY6n2XyvZ+1zw9n19mE7Stxd733mN5+n22ADOCX07Ybj294sDfq+HAw9w/ZCKZx+1sZHY2IbbNxHlucOJ7BWwqCXhDA+sG420I49cUj6pWzMJ2c7aA7DsXoJx3YCey9rM4Y1P+4l8/Z5PVECLxr1Ltm3H6QI1t9UDzbYh6iTeLNd4k19WJcyrC0Z1ogx+aKfwdLfBqf5Nkihj1K+Pwb21jzN2/C+bpzYHLfx+/YghO8HclP6YB6/oKOZjXPWx810NP+ib8lyks9Z0G5e8QLgA4qX2Gx/fLweXPY7rqvJ1kxDbyK5bF24SWja0nybHMM0ep93GM2pL+Ma6Nb4d68xe9h3g+LdIPlyDFI7wb7Y79CfPevP1jzMOokG7cawr9qwR96u1ngtUdk6j2Ev4Tf8z9ZhTltsqpbRrfud3jvsdejnWXV8efMlxguAzzdgvCMZxj51dokEc6U6QeR8jq3Tc2YGwdB3Yc5UORolMfAs2MeNHYzpR7xGCmAzu2aoAt2bEMTZZ98t91tPBx6TuMCb5u31flKzao4UtWft5joyQ3tWzElsA88MOsA3T9N2spmnke5K4WEG8qKkwc2+dUVnsnSksFhr9ryVfc822Peu+tYPmrob53zEVGHcfdjnwft0nHiT3Xq56Ljt0eqv8NK0baZTHcZn574D/1SG+AzyNdjtl+Ve/rLfjuObZn+0Xs+V9QjkqhwGorz4Gu9La3+S973vm8DPzYbXxjXSW8+MAOSgjPs6tXQjdcdrxj/mSvI8awfaYmRqlqn6s2zsLlYSHEFWA/2yvxiryXDkIhblcTLfWUoQuOzvsE9PU/G3xPZ4nze9YLZNttDvt6CTnEIf9tCowXQA6BPstcBnf4d9N283dsBnlFB++UtsWPBnBfbfBXjr0W43T/BuY54GvdnOSa0k9PxOktpGcoz09ciVm6oL7wc+PhtKsHNzXhTCfunVpqO6HKJc3DZTm71jwVwWMr98B34357veZ+8o85ob47f8mtoA/lcD/SB148Ryg7BTjJMdu+v5LtrPNpE3BDkA//UX46T8brLW+buSMI+e6oVjV50BrwWeu/ZN95C1vzamY/sEe3Yz1VXgGz1/CpghjB/0RYG1NbA8E3S3xjvoFkzmzjM+tp9Ipj7zQzCv2ZjW3XYCcwN8TVmdHM+4BO3kLcR+wfqOgDd6krym27THMHd/hqCDwfcOoM+kQfxX7x4rv7sD3mHaSWSYB+DRz7DuBX56g5fNd1+enJxN6DnKeT2v2QMbZcvWlGcdt+F4PfNj+m13Bjok8G7Fl+zDZGynH9KftXO2xsFxXlOTiZJsp6MgFtd433D38BvsZfvFMozUHzW9j8bINplOP7KUxnsEc7TwCxlDv1fw3qs2xiryOdXxyvcc3wV92C3kYt3fmrUA5jUaBd4oyNeT1BsEcsbHnG0M+6k5Dtj7tjYFWTsG6ZG/916850vOjexomF/oBsD/UYYmm1zuXhag42X9sr0h8KwxyI9IEvij54L+E8R+2tuPa2476Bh526sveHLoz53iu8kLzONLQTPI9F35nXUuS+A903aDdjf7u2zcy4zEPbMxkG0Xq9hm71nEGLhgg4GuBbIObDDkcRLwqUwXNG3Pl1XgW2GAe9XyQuRV0CeXy1r6m5+Oa91DntzpoS4E62by8Xf+QQfP9K816OC5biYJ+g/8dqsbuN7aRP0K7MdjKE8ksFm3fcME/hZVxBT8HsYK9B3QIWrA08BGtFE/9K7oGwdSuFnrhV4D+pHsML042UWjpjyXMhkZ7ATZUNh2rB9rNh6wbjZTJYgZ/UHgu5s1o9tHXMBkTD2Io1xvwH65bE3ZbeSTTZzPLj5DP0cLroPie3zeuZyHfiuTsYryKwYZ4PkSp6cOMrfdN1H+RSO0F0Ow18JRspvBWoJ+oo3YKL+9DgJjUg9AJkfIh+QmytIEdMcjrC2QSSt5MgpRHsC7qmGBTude9e0r/HrZbze34Q75bg/GA+xGXQV+EjL7+qPv2MJ3/BrwasW+TMeq1O+oIIsynwLsB7b+gVYcox7oO8nCDLkuBW01cCxwfwBPrQUbchxv39ln33moFzY16M/i95F+3GvtYv69ggbZ7s7lXMfGeZfdNJCLPQ5rbgw24il/t2ZdbP/8DnLlALp5Wqw9p7C520zfEvG4luqTarjhIrF9f7f3hqB9wvMb6kTQn2HU2QP/CvWij4sAvqE0cF7kfL5GrmLvw7yfI299mcA6yvhoK0W+72xUd7ET+J8c1+elPKj7yvxkyciDuyd/DHy0bW8dmfO9kPM9xThZqYv+pz9hAHrk2JRD3zyGJtjDCuoNgQ5rHOziRFr4yRb9QtB2A2RaY9Q+L4OOJeffXN/zAksaK39hn8kPCuq50egM+6MHvCrq+/m+d4C3TsZJ3ZXt3WLn8v078W7sKJAw/2AXFt9+t6WG54AOCM/AjyOxHQVogT1sSqHfSCKpJ4fbMJlvDGmyC7bogxiObZQR52jkn+2RDGs4eYtGcjl+npGGNbAjJdDV49z+70DbuJYD+xlk3f2YbtZL9NvNFBvoCzRYN1vgA9jOEfk+/LZfbIMY7M03WIP72Th4cxTzNBnB/gI92tLDZU4P2AxhY2FE0BbwjtyXB/Ofwj5fzztqAuPF16kD6xr6ngTwzfk4SBxYl8J3l5ZuH4G3aRb0H75XB9ndXgTrwxj2m53zfDam9363G76e+eocv1fy56SXLrZnvk/zufHnUq4nyvZzsd8nknG2QW+b1aIjSGBzAfwf5NQ72DabEPWDdkGnbds7G3h9D2XPxoPf+NxKMpdT8G/4z0y9kVXgnH4H9pEcrmedIBH4nVLsz4mslnigH97pQ9vJPG4O57W96gA9oA8dXM+oTZQ16Jdv+gT9VTCvuTyH/fRWrrVPvxGkMEfJXDfOsK6BbjthPt6OzXURe+OOQMcKJ/+tbyZusT7jYh6muiHPRrAmR7I88+016OEbWJ9gR635mpsonOftOW4M9qtky2B7gbzmesn7bAf9BDt1sj0nAj9/R1+zL4V76G8XxjCG/9fv+U5Qg+9IoXfnW6sDDU+Oj/4L5gNzgBdIM+RRZu/XrJBZ6AOXmt5YKfXxcQ34Iu4DUYc3/LMFuuoC5tJh8rlbD5m//gx730/nI7BJR5ndY5c+/Qa0D/LXZXZekDRVB2U6s0HC7N+k3ZQ0RkaPy+pZatQ8GfQKbvOsl7hPgffroh3hei47N4D9xW2Zv6BPBl2oMdtaMuNb49aHNME3TxPPXE425tLdqMg7lxmdmR2W/dtIA6V5mUowNyO5PWubu7kMPClYa9Hfj70SKuf3CfB2q2a+g374XI7j5ATWBrcZ0d4YleNWvxs3BfjQ1r6f28zuurjb8zqs2dxOwz72jds+gl4Hum3oi3boGvR9lc3zPL6xldlaXg98uRnzNs1mCuv4MlFu59A4MVt+3CvG7M6f4PilXvM3NIKcWoO+nPUxyWnwgi1rJw1AlgXo23q32sZ5rHTPYwnPlbJxGddUdRLbpmUAd8nHaCyL78bsTALk2vQfaFYynQT0ILRtzKJvYYr66GR0kvP1DvSqaytoPsN/G/iva5nNk+BPWoprc+ixtSnIv0/mMmjdzGWQwpiboBMdI2O9BpkG+l/3Zk8Uf+81xPU/lkzdMsDOlqP3+fatB3vmrRgzsB0mToLjNPnrPtk70NNqILPHpT0xS7vn+/kP3kAPeUF9/mYNSJFiokz/V7wCtsAOdSzRpoFvSB+twWL9+PrVd+pgX7ygFT1r+yIfbYBOeEK9C3VsG+QB6B3rBfpGUtUsfCOw7mIc79B/qYu+M2FMFUeKhqjzBRvjAjrIJfSjC9I0Hdmp63WlUPRnBDCuHaYDg/zIz0D9Hp75vKNv341BNtUyu3u+S+C74RroKm3/2rUN2G/jXLqwNuzEbuPZqwR2AtP7PPQdAr11lAVujds0jY/lWijNmAxk8gfkl4zntKDjxvWwPEtpzEfucox6c2J7zF9tsPPgGMcx2LlPfg36bTaXhdybp61z32w+53qyOtslhX/Cn4EdAWN+Qh0P9WLWx5p1svXeEv2mM7B5xkqSwpyP0OfLxmvsWjBvaWQ0L2CXgI1kgt2Hct3GcYtdT2042xj4RK+G/zm7SIuy/y/kHPI5dQ78DWykA8xTwvlnDX0imW3gK2egP4B9tO7cn9XS5zAu6NiZT3k98nc2yP5ct6zd+ScLv9K9D1c3TrB+cQ2/zhT8llsDnecFbJe66OPCsx4fbdjReRfi2WLQgnlLYI3AuoaxCscOrIeQ+acEfxfV3hn2+nME+ihbezDHi87683a2mf8XfcdsbYMOtPi8DQV9FTP/Dtf4AteY15I32Iuow22AR235uSzo74t247N+XiyFnV94i5EMvAztaRjXzNZJcM/A2qvP4s/aD8DGyOn7vC0F1j+MeU+CNfXcbydHZue2g3icCnb6+OVsK3IyGwEPiM0tjsUwx8HaaH/elxDolt9BTjSEMwB3ATze8YNP+xaNVfTxJXYnAtt1VXNHZ+gD+kvMX7DvVHfb+GKNRPu5FLzNO6h7o86X2/z369rpt1HPdtc4HjgWV339lL71HviTPEF/kt57DxP7eWGiTflJWx18372A/SjhXH76bnaWFeTz2fh8PlXPD9znj741T7vy3fnZ7Xmb+QleCmCPmTHw0eMEbFB/Czz1ap0k+JvqyLCetme54P9EP+uLkeCDIdoC/nVm/Hhre4HZg+8+iPPfwN9Az+P+o8K2Jdr6yz7b4lwvmf/ddNdoe6GsRDkYwVxEY7s7U86JvcWYC5SfpmbHPRns2SS69knCd0yMc3pDG81DX7D/0ADbexfl52G+YqIvrcN9yTgeQRPXmRBT425mNbXRh2fg33vUMUAGoz2ZWnoAsg3scsXULMNech2T/E6IcRL7xdavg/4C+mSC+mN9wv0ZsTQbNRWkB2UIyEEZxmc4AT3DAVsGdIs97CWuM8J4n+FvQLMYw1MXf8vt2EgGu3NkbSLuR81jePB8+IK6COg7Hsruybh7tjq2BGPE9ByQnakt47kuO3sYgI59CtBP5MF8KPYa9POLh/6jmvuCZxGCDiHOwbLwTbo14MvyRGJ2XC0B3pC0xfHKzxw6EbQbbNZs3Jn+kp/LwPuo+2DMEZebriy21eN+ptxHxeJLYGykcg3bh1ktcoC/vaDOCzr93t3h/zf9eeoX45eW41ec3U9wbHLfDfPp3/rzC19Mynzt7YDFoPj5OI1hf6Duhf4EoFGNOlYN/VqoC8G6PMEco/64BxrSbC56Vh6HJvlyryH4fDpjIebnwzOKTSu1Wbze25X/zMcYINBLQ8E/MhyFGDtnWKh/34/FB983LmPQS0NDlgvdFMbz1v+W3uk+2fyw+K050Zfc54djlPsxC39jtw77Poa+YLwirp3lna8S1pHtM3myD2sB8opcb5v8J/5F4xP/ItAXLfFcN2R7BvTjrbmfdUDnCJpL0LFRP5ZmyHsKe7Zmyd42UOD9AYztBfYG+iQ3xR7B/eVLZhf0MoxZKOxHYY2vlzAGsLbMnDZmP6AOB/o9zke2B8v4vwxzdU4qxP3ZIH/noLOXPOmsgn5anwfNex5U+jA+/ybag0ryK/TWIEOTHdC1nunrTemDdt9mtTBhfLRjLl3U4WG88Exh4ndP6GfPfdGcn4JNALqYncWQgl0rxEvWS9+0L/DThNORr5UK37Lz2CKgb2PrsH7QruFnobCOlWyee4cQ9dqRmxTnUfgtFgclu695OxdLblJrv5QJErcjLrYf1JmtV7OZvxH6ns2vf96j3gc0ljbAJjAXHRZ3l7K+wDjm37amGMOKdrDekifZ32D9rk4TybnS40COM19oqdN0azwu0zdhL7svbD3enA8zntlZH/h63ERoexVnT2+wj2Hto9649kCeHZzM1wyyP0mgz0luM4CdQfD8hMXZnODvYEOFLEYZaNiDzX708zMZr7BNYR9ZRmC5vmx6ibsMzMRxg+YAz+TcAJ7jZOAZpu8G9nJomB78p3lGsPTjwAXZMcxxHsqSYj8uxupkzvmqnw6lIIS9HvqA86Rw6RqJHhjw3dgcjoLmaOg3LSdwTV9udp3A7sJ6tqAPQzcwg2HQM0Ep7Acm+q+5z7sxN9enYuxgzlkMbXEOBu9hfND7PGndn7VvVLbGgZf8AnltwNxvYG+d2P4TYqjEb/SD5g59RWg/hG03Ccv4XeSbXlhLBJ2W42Q8LwMechXbIPwO68R9Z7HirN2I620FPb4O+21sA73Ai7bNvC3qW2rqehgPHIEOGrxNtkEM7cZeYme/M1lk74oz+mtcsGSyU4h5u/49AhmcxauX8YlCHzu2CeMjo90FchV0o6yt+29FXrHeWIxF2huVehbnz/3bd2A/pQ7sedjrb1+d6QqynfOfUq8o2ipjAoBXZvECHTsJRw7YNGhDWKADM9nogb29FM9M2Pk61xuvvsPiYdCndHU2UhPiXzagP22ZXMAzPlgTXGcr4+FKf4jwN95vHpviS2uB5vzvV+NZ9rn8G9MDmC7lYaRuphuN+iyuAtphcQLhVQwM0MvjjudpUsTzoj7OeWjfbxZ7B3To1tW5Nch9lHmGBXwy86eVtsk1TsWYp8Jua3i1XA5g/D3wMWcTcXu1iAWC/iwjFp8IMnEULPtjU8axxVhIFo+CPMhsAn8s+Fxyys+pGpEBYyKZk+HYxjOjDfL/oNPDc6skBLqcYN2by+oF+ATKEX++w/UXxAHGSRh5v3cW+wbMU6kHKc0T2KOZLI9Zv9KW2VRHZtDjMgNjW0GmRh1cyz08b8liARzWbjD0ud2ug16H58Qq6FvoL8vOXFd373VgPrJYUd+56xPQKLaFcydNUNbdt+fAWmZxn04u0+/6ntm4EsqayS6QwiA7R6Xfk3Hs1qgLgSxHvy7okXn/svWR0+eLf7unpfx7OU5SyOKr3SyWBPqhSvMV+7sJ+ucaY2nh3zffsjsuyA5hXJ/CMfAPBeSsAXILxgrv87hS9m8HbDz03XgjxtuycwL23Sg/M8jjBwKUH83DzIxegAccsjaci/itoRI0JlvQm7cujj/fhwU/E9/12830qh1TfZ+jz1ZW9+HV33GMs3OKKzyMCfOZg140T7L5cWFPzNpXY+AV5zTlHNid4UhGvRNlItqteQyGGYMu/IZ6VtZO9m+3jXsC+FkmV4sxHaPPlMXjs3mKeiDfQA8CXYrpK7nvm/PBq3ZxvroYVzXtOLd/H4M+JU0z+mHPog2A77nOrGZLOU3qhO1Xi2H9Dvo1gB8oYPexWI/giDZJhDYF7FGgPZ2f2PfYOYKb8Q8YZ5j3Wta+j/aqgTJ1jfb+Sz4v2fswzt4oiUfU35y7vx2J94637wF/iaP2qmgbbbY0n/98zd30G+N7YK6+oA/GrhGDrQ46rZ3xqAD9L+57JKFe8QDtnW1sf6j0YhbbDf0C3SEfT9SjkwPalC47N1aH6DeCtTBw4r0OfQXdzfaAJzPMLa/ypN4j2CE66JCeLz/EYx6TE0O7TW0Y29DHswq6xbJnNvu+BHyq436IvbKVnA/egf6Gfn5298E7w8QeQH9Bx0+YLpjfs/igT8w2R12D8Z0PaO+DDfwM9vUH38j9Hy26P/4uOM6YnwRjic78rt4HbfnheC2V+5poT8azqvkHv+Xzf6L7ws71azbafx/NM4tpwPNMWGcDjH1CnQxk7y4a9z6ZezoWgGzjg/NG6l1fspl9iPwP5z7K7lhS73kT4OvwHuhkTdiDGIsPfJLqq2zrvrJeI19jdmQRe9L64F3g5SAP3iqNA7wfoFxsN2tUP8FWAvkDdh3YYJGSbCPjbu3YYJupX+wb4p0K37lZN2B7+Y5frW9g03mZDmTLoPMjTxZk7Hm9AFkaGclx3sF7lXw+/WFgI48HPV2VoyI2IAD9q6Zi3FAD3gkc6S1ZBHjm0EhnsCZwX4+lHtpyf9DOmneAn8hNbdZubqYyxueeE4xNBiyuV1wfIKdRZ7FB/7H/ONvz+0Q5IAbsnzWsZRe+k98Hwbu7Mshh9KXJ8L32G+juYKe1iL/XAlgjDn7nHez7zVjJzmugT2uMD8P257VoH+7AfhyrUnFewX0lSEfNrk1HoeSOZODfybVPBdcJ8Fuwf47Ct5Zu3Bw6EtjTBtj6oN8W33CC8OrMtBKGnZ/DXoT1Wv39q/tpLTYuuB7MZtuTezrY75YnmQaumfx77B5VJtP9yu97fmIMhTEaS+HAj20TZNYA71DAms2+k90Zs8Gm308qvV/yoSo0X8U9rqp8PxkMwV6o8m0wfmBNnqqMycCXzu9og3/dvnhfwKrybTcamZeos2fjXqXf6O9l58uB2wAZ0AuRP7bZfZvLvEofzbXjVHqvqUUj5OvJcaxk9xKr9G9Wq0R3Oh3JMXxvzfQd1D0V9KWx//8FNhHuiQ3wlRT36kdxNDyeGN8Zr/fID8OCxygh5ghAPR39SKfpCL/9BjaTe0HfKKxZnd11kAqbGG1P4AXwjalkt51t8x10j/UsRn2e8bQ/YN9oM6UJtpt5RNsV24V3O4VccbL1mmbvljrgZJwweSe+6+2Yz+hy8+4gUhpgQ6g9F/shuz1fLnlyeeYCfNkveDvuDwNp28/asJ6VM8bJJLhfwA44IG+Gucn0fnYeb59QhwPb8I2d2eG/ld7rRG7i/Zf3icz8n1Pg3Uhzzl/lNJTtJJsfXOP2cja2dz6eoZggd0D2Wyv+HbyvjPN0CMu/ibIh+ybMH/B0xvf5O2N2lq6y+OMt2shmCvMEOrcLcqvBbVHUD9AuK+KmWhgDBzIpRFu3WNdKRnvmM+ze/b2IX2+V632d+ayZ3QSYWMQw+QE23h4sQRwfHc/3BOxziOercWkDFPukuKtUtOcXdDkV3gmYLOFt5HFFhU97mI1XXehn4QMvzv3yMU6uvrPJ/PoNObcjl3hGMr0au+wcarYLMt6bNDEWX/rsGzAmMGao46KNZMuzkf/Z96Qp3gdnfoo8/i7zu2d+y1U5NhjHxtZlfgcRY0iApuNEEb/vJvk5Sj42ztVvsI9xv9swXi8zxb1vo4O2sbyHNtbza2wD1tcb6AY6tC3h/Dh5P4SxwHO50g7m2NxXS8x3mPmxifljvmSGy3ww/s1vGNcRYDwn87FkMizf/1fvwfzHoH+1zXQusTwlSPs6zH0EvB9oEws0ffo9tp5Q5tz0if0NY0JksP0ioNXtT7L7t5l9ADaTtbpuM7vj3GugLYB6Vmgwv10P73bBOkkWHdBLYxnXbpznF0F/yUUY8x3zT4zdI/MjMjtR7Be72+ExnVHQv4s+TNk+tlkuiQn1+9g2MUZg3max9IdZDXjcNlBh/DFu3srO6zKdRMAUZ76HhZhTY+QuZ9vmEfj9YXa3h8W1lqTFWe6sw+IhwU7GeMMgHisN9G3KsA+WzJ8zDhNhLN5nmU5fPIu8tvzb7VqroS+L7xuk5xgKfGuunPHuLeOVwndSvIPoFntSfF+IYcT5moCsZe/kNrWvmFtxD0Tooy9kzunu7xvuI+P9BTtBeSv5wT0G14SNZybueA1jG0hXfD/HwzzpYOtcmN36yXv47VxPLWgH2f7G7sl8xstBP/8D812bxSUPRj0C5OFSXC/Ue4U85O8oCawZ9wX4Adqs0D7G8x7yHAkBkQfJx7lJp2jnGFY9s8tQ32b5gDx2HrC1quLlKONBqSU/nGw9lvp+T3V8Q+ljrpzN6uzqftrXEx31or5nnK3UhH+fLYxz9ZUI4+ilG393FucLfSlzRXzZD6U4o7VSe2npTsPWE83xTdXerHXMLWL5jmylq4aDetsmPluedYZ/W14nwfuMuywn07WPHuZuOwmanl+cyWaxIm9oJwN/HkYs/4Kc2BKek7/BGlH1PqyH6egc4778l77g+flHY+JKZudvx2WS65v/0pdZGuou87viGdsH4+O/VR4be5f7t6A347Ql9T2n4cSm6niTupOqWl83Dduz6n3f1t2427A8I7Xg37BsGrCmzlaS42XYf1uUOaYJv41g/p6KPDYsPmas4pnKBX13Ed7pgBEDGfAHbPWTk0ZJ0f+/HhPzoR7luvnQdz+cJ/TZ4P3voVR5ns5Wm8nt3ZzNl/Mv+wnWcVNlOSnyPgYYq4BnMX4AfQ+l0cj8i3EyTtl96ujC/Bb638/ZAn1TEubp6RW2i4/xiRjn6vpnK9hld90CMz6NT/+L/TLO/5v9ii//o/1K/xf75Su9xsgItkHw8L+3H3dJYyivzTDx/2IPhC/5vcwG6PjYjueiHKslJze/P1qZJ2+Lu1RJY27CeMq2geMK3+1EZrIeSqE/8tTld37P98zl9/av9839s7+5f+439y/45v6F39y/6Jv7t/7m/iXf3D/jW/cuyh2rOq9Spm2wkdvnhOnUqHtILsb9N+ZGlPGYxA2tb98jRvq9NMdn2/xWml3r2/eJoXz3PNvyd8/zd+8Vo/HN83yxvnueN98tT7qXb6f5u+d54343zfJ302wn303zd8uVbv27ae5/N99O1W+m2Tp/M82p9d3znH6uf/XxHsE42IN+jvf3LpOxXRe+g7Z3fTZ2n2ZGiH32I723s53PaF5fMGZryu4+NZfW1kwXZjl26HNZtGVpqJzbxZ06jLewtvMiR4s/l3w53CaXec2RI2WdzLf+7b1SbxKbBur6mB/FTWy8b/3eN8uYE0eKlkF7Llu63/iu+clyPK0NW7In7igMrKQp3rvxw425yc5+GB3GYmwuoa/1CfpoYX4+mNN7X8zf228jpPWjdq9yCSTujuc78sLinhPQvD7COArz5H4xz383dnYnWs/ab9aY3eX72D+I+QVYvosyL8PJS2xcr8fsnqF6mrV53nY983ti3q3sHAfzdwxHQcPZrsGmBZsxcX8BLW/ft+8nEsa4h8Z5CX9n687y3JvYYDyPMDuOvxby1VUYRyU0qvaT5XaRy/gAPF+e1FRYE+GyX8TwZH7040xpnsa18H06cvEsV4rGPZ7TxcY4zHYT70xe5Yux4O95XLAG61USc+Sz+Yvv4myZv+7DfqU91q9sTktfaAQ2PO9LnMejmmGNnQve5sHg+Uvp8bE8m6+nwj/w937JsLborD7jwTA23EeZ+0j+3qcR7CLdNz9fl99Fz0T5YE5A7+m3PlubRlqu6X/nTVHN/T+ZNxaP8N+fNxa7/t8eszK/+X9PZkS1df3zebn1Bf7TeG3mn4/XnU/vn9f4f328vlrH3zJeSfR/MF4Ff/1vjteVPPHtNq8BwGS93cVYZTJHsjmvgPsiD27ijsscXqYOuk12R19mshlzLuu+tMLcs5irtFv2wZdA5oHual2yvJPid4BGSca74omzAznabh6DxA6xP1c5T8drL0yzvKeurrrYH3Z/VqSLkK++nHigv4Ri/kbxfhnenwzKnGkpyEUb7wqHfh4XjbnoA6CLziH96XhUw/X4HZwiFxjVZ9D3d9S9OKHvl/KOUZ5njhpHTxjD3c26KPWPD3PMwfdSx7cdzLeZ5RxYs5w8n/bjPt+759Rs1ZFb5z7mFoR9zu6GSViTgMeMYF6jo/vFWN3nPbH1uWTqn+ffgd3/r3TvghPGIIVelufp/tvrI8v79I/ftzY2u0vnf5xHKcuF86/f98w0GvXgu+y+4TGsZbmg/nX+MIcV5qKbblHfdbJaOSbPBfSPc3eXv+jfvtNJ6iz/mdLYYM5ltJ2v5gt/k0zT37m/YI9hXp5/7O+6HNNOliPri/Gskm+gGOOTPcpiN92NWrfaQfuKhq1b5HUeY2yzGD/Gcs1h/lSQQ3i/ZMLiVQMWd5flhr+Odws23c/kF8jY4k421pMBmZuqWMvm8EXuj7OdFLFQeA8/KvKJnO12nj85LuPG6BzGIGcVPIeN2rA31MK+hrWBtiC7qyv6V7jd/v+5T+Kd6NL2x5wNvSWV08XJc0jDPJyyeFOMQQ1U+K5e9nX+n/aR5eVwZfu5zGlE+Sj+B/u5E+63J00/zHPk+JJTH4OcZHfydlgfySx4fy7zQuSpeKcI8zLtMt7E/BCifcy/B/u8NpbYPVYl9K9yPI5suRljbCLGcsK+aiBPGGc1Lnx2PzqYKDA+WH9AYnmY/i/b+W/q0ImwLrxo6eUxnNc5aCYnzAec5ybULD0AXQzrf+X5/g2WW+s8liKWownWRDoZhYmDNTUyOlg+/0/9et9hbyZ/44czzng3YDZKMHccrvXMDwfr0sX8He2JBHLlWDn+bsx9w+roX2JK0Kf9l23aLKeq/Scc/VucyCyN1FER052weEP0g2/tduP4V/2owTxuYe9v53/fD/QJbtS+LxffiK7vDMe250vZ2ADvWPI8Qp5b5CQT8nxjfpJwOx2dsa8N9Jlf5z1kvnATfeFD0PSymMfPfaauzPjRyd60vussBHO2Is0JaPp6Fh/U5P5wtgbkv1kD5mlu7D1Pqv/L2PO+gb55sYyP7x0DFvro/t26UPLcFzvrX/qG/mLPlT/0Gd+siUoxmKcip8U/xKU2vojVvd87ZM7KqzykJ+Dht/qhbpk9abHD3P0815Rpddaqy3VCWo9FGT/3Apyn3V/xLuCB7ra5QVv9X+LhQIZ/Fm/G5glsm7+YJ6M+AZ17quQxesZbshj13mEs4n+Zt89ieMX9mcXOsnVeB150HCv16nF7HXW/aAeH7HzA+Sc+KJ4vXJ0rpj3vMxoio+CPjeNfjnMD4+in7F5NkN+3/mcfVhkXqYeFXtK2bvu4W//duBax21JDZvl6N3/fLzEn0mfjmPNmvh5K3uz+7bheopu7lP+wbsXz0s/2V8Z3OuW4+soZ5KCNd1GZDGS2shSd7+zknRmPU3U58t8m7pj/u8zlBfzGMpsX+O9QnBt/Ias74n4S8rN9twxV3awvset1FeCHGy8AmQ02+0QJZViDiVv8DZ4t8+E01KNSbzZeTmBXb62RDWPWuJZr/3amzvr33/QPcz1EY/sGtKLgP9E/PEvB/AlZnHC4MaizpJfpaP/H07unzA8+ye/cBHgPKTvTN5sVzpw/kpk3469Egm73oR2ihHk+j4XPbQ6wyVcp2EuNcc1c2uPMrxqBLZjreZj7EH3XAej4a7BvNbBFsNbDKIt/Dpb/J3aJ15IY7xitZDv41xgV+9kHbsFoZfHn9ivoRvf9Gp3fZtumA/sja38TKJmvHfQHk8V8o73sAT8+wz7eFHMA+/m/NQeY5+S/egaYxa84jL+EG1/+T+JW/BTvaydLJiuU1dkm+jXdvh1mfh105qx9kWYmNzA/M/ASUa8Xxhf2ZjSYrK5iD07Ac9ndvbHSe19gznqleZpgTqegmSzaSRpl+RTWM+Bn1z7B4l54spxsm3V2r7OmrtEvMwa7fcpyCiCvMA/QfyYjgP6xp1hljAJ5xyqPIaixO3PZ+4qYYyVZTkHnmWf5dZ7zXCsx5qACWhpj4J2zjsryC/xDvXNozy/66oVyNJgWMQD0uQyv02VtbdtXbHUuR4egLRU01sucTD3dG5n+LH8/wHqBnqCX79Rf8+3ZvM2h7/i9NtN1k5xvlDFZHTtw1bJvKtgr2Xq4GscKsg+wLJ84y+UNY/VPdgrwjk/1xUIO7BLGx6H/6v9g/9AnUsgZ33G43/3E88gF1/NO+uSLOJjCV4f5k4NQwERg46vvU4yngHeF9VL1/MXzg+j5r88XKtUuUMeT1afnDde5MfFM8Mu+XOXt9NDf7+qRULtaxN/uMaNCLXY8K16L/YZ5D4t8xNk9RWmN56BuoHQ/5CdPG+Mk8BSWs57zk+f62YbvT1g+FXbvOoXvv4M+8xKOzmDjd48gG4Rvl/xR+H7t78aJndlQ+Uzblc9tPz5va2R5c4qz1+Q/Onu1t6zGRg/zFcx3dpL7nzFu8Z/PF7+qJ/KfnDN+VCvnH7+J8s6LRt/2vQ/r7JTfE3gIj0kpYvcwv01wFbtHxwaYbE9Y2yCZKehrwjpDa+C8+4/aScl2ajYZI+jk+YH/qzE/kl3WcvzCpxvm9ViLmhmgX/RA59KmIB9At9WCzn4p1JXDsWE1ItgZSXb2x3K3VoppPX0oO6r3478dd1hr/d/EUbb+ZQ/w+jb/GrOxB9uL5YnylW69qNGEeuoVHwGezOItt8Elq7nZ6+U4CeMveNwB5vWXm1tW/wDztjO+2dgz3TjL4575VMd57V+Yx9n23M7iu3vS9VloJObhvqu9m58xMD/KwohUZ9s4sDM50IlBZxfO/DDPf8jq2EzHe1b7AvMSoc6Nz2Fez4z5tcfrDuiSx/yeAPqOy7Ptj3QwP8uTiD5srJmHe2GcRluQbxgXFffbzNeuYEwA88PJ9vMiWJswBk9gj3yVEwDzq+PfUL/jOVpgHg+CDdr4PDY79x8aVlZvh43ZA94tcFj9NPRTVcPLsyzWa2m3gR8pdRh/p8jB3sjn8JoXJli35Yu7x3z8gkznkh/SeTuJy3OGZmqzM2jrErB6jVW/50oYdzFO7dN0lPVPyF/vhegfqkZ3De1nt92sYV2sr3NLlOOFuGCsMv9r1Xm2d3meat2sW+M4P4su62o6fnIjbyrT0YD5i8Eu3aNMH8t5Dagvx5HluUqYr39sL4O8nu1XdPRZHp83VncI9BTcTxg/uKnU5ld3CIr3pC/st39YW/azG7M8SvF5uShz/1+sJKvX8nFdGeQxX8QNbMLnCM+Fxy7sla4cZrlYpIVpd/3dPuNfN/EgrN6WdBWrINbqQl4bL8YoH5pZ/GeW/3hU1gibKJO8feQ99iiz9aPO2huy+sshaQtc9eNjn1ONxT1hLT8d+qkjbXHhj/wqhqI+25lL1HE/ud/zf9L2/03sw/9nWr7zfhbGecnNPvqLQE+5yoMLWu2y0CMsoJX5s73Cz5kQte5CLd8TI9Crj/OgiXoP8ovG3Pz7vTBOr2KxP23P3hZ7pOlNNsGW2c4dt87qjf2He/K/0A/Kt3YVewc8Kj+zzuPAkgmeEWHeRVb3i9X7KuolbIOa5bnPed243hzr3qFP06NryoM+jblPai7q8lh/C7+V1QX0JgmvX1WcjZ1tkFX/Y337KN78f66f3Pcti3qscRn//48H5HUIhT3hTfX1sqw1PPm41mtt9XF9V4w9/yDeMON/edxegHVoJo2iDZyDcYo8E+uj5uOPfpqk+eme+yy+kWgPdJcm1mJu/AUGxjSrIQNjOSxqYQr12oqafh/vGZPzWI/xibLOXFlbbsxq9X1Gy1+umyib91rycTwtVXdyo2J9qiPLy+qbx7Cou+I3kkjKanwu/Ap7MDvnvWBdefQtgt2K+THxfgKvHYA0iXYlnm/2jcw3i3zYH+/ZnVW/1ruNM1sy2ZImQWBgTHJWJzyLz+H2IowXEcNc8gOsMybf2aPMDoI5ZLUckzfgFTqfo7zGKc439gvv0dyMrWSNonOxn1zdqF3VRRdi1N1OVuNvYTbP45ob5/7Nz87xvuOulR/p6s4OMI6Kn5V9dz+/57yx45zCNIu14nEXEsyLciWvy7qBYEdnNRnXS+ivVNQJJHRSyYI1ehUHKNsG6HSxqP+UZwR4h52dwdbx7DVq8xgx5gP4tn6S98uw/vw39hdk0XeO6/Xap31WsAa+c7zj/1b/v3W9Ae8j9lmKvPWG397E1hqYa/g0Az0DZI+M5wNgxyXjNLszBXKQ57icS80tyOUj/Ld3se7oOKtZjXWCP6pZ7WY1q0EetM5jrP1sXtefQzsa9Iq8bgb0qX0uzjZGwPtsF2VHkMdg8ngtO9PxO+7VeffdWgbeCToWq3VwVdthk2DtsCKvuefI+b2YL30BYINndxUbH99htJ/Qv38Vf4Q+APNWN8Q8++47yL0D1leEMbiEY/WA9Xj8GvPTHkP0l2V15c9Wm8ui1FNCaB/7kLD6xvm9KclXzh/dm+qwe1OgL1i6ucS6scEu+UiedsbsLk52pwvG4wBzmvHpJGw4vtwJ8r012zZiId/HC6yLF1aPO7/HddcPuZcukry+ucLqmF/pL+iPdfygQ+2LL31faCv6rBbndX1Daj5ke/35eK/L8a3la1y/W9vDeW3vzVjd92ZuY1H3Yz9d3x1hfcdZTElxVm1gfNMaZO9JqFu+tEc2+mCk3He99EHPgf+XcH/ZCVlDF+ut4zvHrBZ2OEV+sYD+ZLoD153WeM9jMnKxngK3ScfFfRAz83HDN074/xHWnvVC+s7RRtXxnVl+R2SU3at5Rt96pJtC/hUjBZ4Qg64m8Vo5wQOvzcn8/MBnQA8GnRLWAOintH7VPTk1eEdpZPlGkn3pg+845/LukduYY6352noDY3TrJ8CYkav4EHsc4X3qxE97N2ejbxMX+G9x38CXIlEHPcB/rvD+cN7ZX2aGj3lA9/OdjbX74nC8usyUCd7Ly++i9kC/nHwQTxN+eZZgGQbWutrP4geJ1Zvdgb2R7EHvEWKl/l91V9acLrP0v8t7m4sAahIuQcElAQOySdV7oeISwSWbW9X57qd72EYFQZM8dZ5T9T9PVJilp2em119XAqPPsG4/ipGLxjs3DInpR/W9ew7yqBz6ceia3M6sOja/kvcdou9GmPZx/XfQXmEvvowOMwP109DeROyEg+K4YJWm4T8yprGj30rXGvrOrBjLNPRnvgI/+QNH3UL/8wFi14e4MFqXqkNE7luQoyMffTuKXdsrFXkzOkR1zw9eHNOG8XggX2sH0+YNrPkM/AJyTFibrQe0HJqxny+o2VIHfRNN1y/CkBRFVWKRx1/VJvlvDfSrAfGtIS05lcS63U6Xzm3vWsEbyDNWAb7dVjNC3H3joJOaxWhrt3H+dmfuwm5FjCXblvHv/Y10cPsLnAeek/B3NKdibOlr2yvChL56fL893wSXM+dcgvtarcJeM83lOq3DPKfj7uJ8bbg/TFnWCYaamN4BLKnpHMeU90Ysj2clg3VQXANjqQK4F0APNuC/qB+GMcj4Htxpcl1nCV4WnPuqhphfwEMz25TnwCuoM9bCO6cIs60kXawk/vy3eJTabyrFX2rHtb0JiXkIeNMMivC73PW4hTWLrIYyD2bHcRlwV2IdkUVwGEi7GbwzH4RYAqD7ikcxX6BLdUEmxfrKcay3XYDd1Rw4M8TTCrRDu9Y/jhOXBrbeRFvLiJspfQftMDP0EdXGhrQ9lselvQE6CfoX49w0y3fN4bZk34zcwHMHeGJTlk6ubxW0Lx30RVANa62qs+HSnY0YkOOBjpqtknrSA7sDdxHaaJK7HuMvm1bzqSDuIx0HnPMc3HONrh3KjcRXPA91rzB/CONYwprGBKvihrZhXb9CGR9rK3pL146wH0hdBhJnE9ZDZgkOxKYgNialOyd/ewv5oB28sH3L2qby81MFa9NHdZQnBXUmMsetciFNLEf45fFaixGeL3C3HttpQj/zLTRGuRx0jz36q+P4Iw1rpzmdRlgHRb2B39SFbl0xv0jn0A4B7DO0oRKehLOsNO1jPRbzBwkGBbGptfB+vmUcv0bnZFy/S+dI5/WBzkLJs4ZzpVhHu2bc6XmjVuFcF11mtncqsyQvy6mIeOa3R8v1BuTYKql1F/rje+OlwhoL4Hmn82ou1cloLk6Gst47kl8rsw7QedlrdSbjlsJGsW+TkRQE2Nd4wU9OZeDTexdzwiy5UwtjoCzTTOXbWdci9Y4akS64juzxOfV2aIzNgNTg0iKdbgD3IOqflKyPujjWZw363BeJ8QS+W2NNP2UuVmBvxX4MgoWihc8FLq5VwINuQ/xNAdakspr8B8zPDm3lBCsjL8/4n+rfKBkLkfqIoji0cv5ynfg5xhFN/wdiEY7ncQuWRpP4vVD++nO/RJnxRL6p7djk9wbGwKF/Ss7wpcGYSIxcuhcwpnpN7B5ZMQn5NAx9xrCuRqWjDisu8RsDDQ8Yc9ht0j5hvNfh/Zi3W2rtiPf+Nr71n6bfEW5quf0R+iqBn15HPsGYyfGnwrwW5PeELqMK8Y2GeEX/E7ExM5LfSGJhrCcOcwt6nFXrNlP/POIeDwO+mqx/6XPkhrb/B3ir20JfeZiT5Rxi3CC/StVGRHvfN9yzyTreECtWJXg3YSzOhORh+BiXdBQzsHO42mQsx7z6z5xbJifhWUFy7EZLN0hjMoIO9P2pNLw0XmMu5GBgXXdXqgvEEMEaS9K2T2y/5Nx5dZcByUXHWqsFdv/mJcyNvhOIuu/Rc+T6UbwL6KvzxI+PvqjI/+RUNDqXu4bjADnpIcaRQ79HYpsIzvsAHgN9XJxhXg36DUAOC0ZzrKGorgcG+qT1Nfrd0L4QxVXV0N6hNFCPDTA30wFdlxlI7a0ZJLn1sP8UNsYoOIrNYDEHtAP6GMlBgfu4zYKcMR/YPsiMsj9AX2SIfYX2c2NMZDUBbTCIR+EDD/mgY9UVuRPKgpIr6rIK8mAaY6NTedBUDHBKV1apRmcj0ckRj0IPVinWgAM8h/7AQA1IjVCQb0xnTda4z6r90N9n1Yn9IKI5+slANq9GNp+1S/y/KCchbUm8Qw/0pSWMAmvE2hhHq5mWrVMxFGfjgjZGjDugYmkzfRxJLAnIm95ZnH7oM8mOXwriWKU1WVv0+1aOYpWO4ivQR4A1QsidZqW00ZK9oJDcojS+AzG1Zh0vtF1tRoH8EPHQfkznpzrrFur3Jsj+lqU3u3JWfImEfBHatRkPdBfVxlyHsHaqhfEzoNOwxM6MPlDdrsF+0SM6El4EPWlmA82bRz4fcj8n+TcYo0PTD9+H79wOyrljUqM2jZdBP2KYj+ElcTPol4pi5gr1g1/J043P8EMnnUvqZzOHWT4jjCdt6jL6o0/ifKroRx2T3JL8tTi1namkLrpsoy4BZxmJGcf5RLawV/ie2HQSHLUl0lBF3FTDYr76uvn1qcN3hDaGsFN7WX20WdiRF87D2QT46rItVnKBbl6YI8zIjRAvQKXwW05tgurEYcjcqDhViQ2xQ4HnsM6uCTpj0zog36s2wZiqwV0YxwlUob8wXwXO/lhnhbOTzbIra3OzYs3jugzaTmmmfIl+b8QDxHN9TMUT0r42r7VGOhpWdP6BbgN6jWjHuAiJv/o63wT6j/1CjJvUfhPlIl9l67nincRukeQ8/2q++y/6GC0pxcDuSrzhcKkvzKnAuex05oReFtq4f4aJqoHuHuEZ2sr0Jnv/nNROJLnzOXnKl3OUb/IJmJyq2mhTJhgeN61B4ncj9OaivO1mnCPto20/wka43QeSrCXICmYFdANu+2MfSObcL/tTGyf+VNBxYPxOJ853FnXnLOdR1CjciF/12UjSH7QpR7Y3aj9URJCZSLxSCTyQ43oXFJ++DSszrEu0GTVl1I8mIA8ALcn5ivLKRLEKanIU+m55/HtG/g5ijIcbcEIq/sV7VrNVEfUkE+YF5w7cg7sU3/hw6l/SJeh3Zs0FDmSgT+DtAO8E9EfC3URy/E/jg8K6NjfzYCuKz8Fz2RmmGCdzU1aXFsPPo89RzimFg/IHdtwIZ+PX7c7A+9+qEZ55Yxifhu0EfBXGE2FP81voE+fyMGT5Qxf2JK4JxtMTGQXjuxfW3gD90KmgrWYHskskA8Fd9DI395b8O7EMyeeTe+nafRvxNeZlEl9wjCenhfdXHrZF9SLuhZDeKaFeQWFezKULeBrtyoV2D4rwi7EAyZkEPMoAL3KzSZSTP7HkkAdwrR34bWx2ku9KyEoFvpccv5jwVzydnL352Edv1VrB70RfvIhlMm8XYJm0qwV9HBTtZhlnT929pfCCiuKgfnl/mVqvur/Mv9aW5KC3TnOaCa5VQV7zbI/2v16gvhqgK0QY0b5+7K9oXqZHOz6b7dFBbCiSLI4YWTIbHqw3T+YEbab1EK5uB31SsO6gQ6V1T3LXuh7zvrWMsP5Bz9VloeagXx4xFxYu8N/sE2jzgzFJwH+I6UTwHHzgax99/OSsXwb9IdxtwGMxtgliFeJdtyrbV4I1UubZotpN9LOcur3i2dmxHoI5Z+p2bKBdf1q25kLFa0qlny2o23X0bEHdIvpZohvCedwFfVk0fFV2GFa2pNmrLoNOz+qMdoUvH2nSM2sGnI9djbEmhmmZPYmXQD6aWC3EmCgbK6GgbNoBvjE1s9bQLV7VLb1tMLrhYGyYVOyDx7EYTOdZY598hxV7Bqu/agyv5M0V+opi/TXs+1Xz1w2g4cSUO6+WxDcMZpc3t1dT1vH9E6wbHXMilqiXXj0WVjQdpmYYXIfgAl6B0bYEmQ/zQEJsMDhbRjLsZaEsfq21DrEcZDHJZ6i4W6vi+leMAXVr9B/BWu4+r/ddkFi9K8ftVSLc4cMN/UmhjTkfl06/kgZdKg/jR+M588nrog7bxfKvpY/EDDnExepwoBOG9vjW9djsESbMkY/1iDb59b90E21XBXW5bEttGLbym7V9WQrHUjXL4zhv0b8J8mGIQ/4TTOyzWh3RGi6jesatJC/0kJm3QGGARPg+MNJ4LmHtCiVQW4bVvq4d1ClP2iE54Qzbi/XQfoXk/1QRX3CAvkibyMdJniz6QFLdM20L9Kkw90lSWz2bxT6JTZ/W+ah+CL+bnJ7Mgdgb07VMv49yUtLn1HkJbGpa5k/bini57yfjPihzNTNXJck7MdUYh4ihxh/mrUjRZ/Q/sZn+p9Q2Xgkoeqf9U+NMaUlqVWT7SJIxlOwzG4cFx56uXf4zyXxDbJvj+RvU/HddmT+KHTim39/WBL2SJjW7ubtu7zhUHrx/RLfb64Ix7LwQI7DgmSwMtvgszcF8PDpv83Ahuya/DfP6MI7i5PnzupOn5/wZL5XKtTyaa3ZdSjIOyn4JsuMizUFEHLLOAfmvZM5mZLMz8U6sqHiyHNo79SBsdUOBf+a2a7QZxddBh2qzylyqKMaUUeBqvFTnuZwck+BncUSPZ1wJZQb1gCfwaK8Yo60iwbhA0lQa/l5tdCSQ3+uqgeOTqmoDrphWGkPgLUXHW2jl8iEXId5beL8Bhxr9CplbQ5SVgwiSmFBT5tpeB91Hm5s4ll23oW1hnxn9ZQmZKKHvDG0aPsYLjQ439OUEdA5o65o5Av+QvmNZ5Mb+c/Ngr6O3yo6W6iasZXHdGI7tF9fQXuKOZBk5knFvoAPcfUt6vtB31cnDKaqcyBMl7ygTMdOO8n0zzyWGvrPKv1P2jlJLtXfl3FJ/Oy1zGLNJHuZbKBd1qPvpMr0zMZeveJ/Yt9I5gZDKEwzkozlQ+/B6mZO6O5f6kVxH52PfuE7XjidbVym9NsreZK5ZRyqm8Ir1/9PaIsyRTPcjXxYtu9PPKhLmqHuwZl8Y3/QVyyu0noH+rvj9X/WRtsw/8bt6STyoGPMV6huBtcza47/kW/mduYR2fVYX4/ZInaCDRfZeV07X8Q98dX+Wg6L9Zdu9KqskdoTSd5jhto7PN9BvmUIeT+2yIO8pWw02Rv+STd9k+0bZupcMW74uXDa2asNqxXE6vGpLSb0EGutXHU4v2njo37lEX5KjGJ+orkP6TGpnMuzq3+Nk+2zfLvIz/oKOWjiXXzjbDWvWv5yL9ws1ZP2Ep/bQx941PdgL4grOwgP0r16oi/J9qZ4LxSNnNT+G04s1P76zan5Q72TaUdL1yNBN/aI9Futvqjosh5NcDf21eD/OxBD/KqwhMdLK5jJf3suZ+azXvBPnZha9Q/nECA0ram1odzaY391G/xjo5+1G8XkjgJwxttm3Ibdb9/ciaNsi6PXBV3/Bw72qTLEdh32aFulXZ+2AvnL6XejHDcem74U/zMHon9AjtHOGc+FbeXT5ndyYgr5l2ofdv2rdfuXcmB6vb2EN2hx+yM0R0a7in9+5O6a5Y0zl/vxnqDs0Zz1k+kzLfyZTp5nm0aMTnnegb4yaM9ALFRwHyPT8LHccrViHU/an7eIZa5/QntTwylw/vhZh0jH6Xixhe1cyeBp1sFHmOFMfx2haRh/MPCfQfrE95dXI53ChNkk0P5A7se9YphNOx4/+lUn8LPlXEVvhGoqwhtAnyJOEn3tiWptTOBlP5MdwpVM6EJ0uqQF5Pg+5Rp8H2Xld0mmbIU2FHJpc9sPE89ziehfNp+9fWFfij7htXVE27y+1vLZTet3Ek/E6ChfWPe4rXvfycwnX6aw2V/YYsN26mGkTOqVJiE82Ol9r9OsI+XuX/M3g2C/YlfLv2F+RpU/mEtE/9OvAWVWsr+WcTcneKNMG8nNih7p0Np/7bTLHn7bHqafncJ3Yt0rUkAO+42T4HWRNxEm2tSnmYpJ6Y7b83efM6VW17jBW0VEPQ04luRZuneQVkZrqfbs2d3viFbWFyvjFthnzPvVx3T7HU7+Wyfq/1tboIEoqE89XypjHUY05DXhgBnQAnTtAjGy/jfk4YS23GeYN5uz7kjX5puXmde7La8frnrE/DHcvXtDhpTzZIfFTnZ1B0wv3U4uyG0+L7rGy8g8fxRcUnF/bgvMv/ceUPsfp+bzl7JvTeWb1Vz86d3L4s3/hHj1uj9x5F+zRt4z75vM0tqPmrx3KCDetXczDhe/vS92f8Z0T+k8KaJjzLn2XYv5uQOG5Ni7xfwY/lpWnp7TPJUNOisamXXqOmnusU1/BQ7/DKzm2xjy+JzrDz/Y8U4ZvUtvlj2n2z+ri1TQWVs/m11yZjrJRbTPbjcfbMLkzeRP025phLYLAY5QrbRIZ9q7z/uGOg/abVhXOqjWJCciwDw0Ps67JxLmzPxhHbEM7G4efoaclfEDi7QzgM7cZHEaY/8bNJnB3syPEDzjMpMQ3h1jBMtovrH2OLAl6znpit6YX+hOqetLPdKuBXG1x/H6Aufs2m3N/hP66s74YeTI6/z7rfNvGexjbc63+NPU/nfTVCrbn6yPtgY+aA9AdelH8Z8Za7xXzLI8YdA15O2iinVq5tAa5d8/Y0cOcoeDpdJxMqvMHS5JTdEHHPbl3tz3bI76pMrbSdurX0i6cK8T/dIv+E/uqrtv3VG7JtLQ/qvkP+Cea/0ANV1XP8ldFeIqn/rHjZ8PavdSzWfqFWq7+oqqWxmEtpH2m/6B5g/+gdH4URQMqToKtX4wrp35XGbVlNvk10A3aatNtGaQu61Fb53o49U5OzYYA4xLFyzGYZfRytWGY0rW1uFXtUq37QHULnzmvGU+eh3198Lhg4REdNPjuszyOBeQPfoE4wB6cr17rONay78DZt4A7CjFFlsHEBR4Dnv+EMR+O86JkOENqcwcxGeTi9oBu8I7Lwt8M0I4ZwdmUtMW4rybJk9m9aqY+6cjRuI9yxmv4fZaNX6Dm2TTYDuYUKQYjS5jjE48D+Go9RL084BehDfzJJ7rc6V7SyowrxldATDL1J+M690kGPxkXdSdCH1n7Etcwponu8z2S7yTxoo70iNq3ZbHxk/d7Jv8ycPSf0AXx24j9yQI5wTUDP8Q2iOrP/mBssHe/3J+sfZP/Uf+mYyEW1gPxqVs/WWs28Jry50/GArKoMuS8H/NvlAfyk3ZEy/+1vU7GZNiWP7DlH7ejOdgO//PxmIHUu7De4dlO17/27Mz7z+5fvMvo3/Ni16lnKCxEqr80B1p1p38fM2Ox/X8i/mfx5zJpTMO/lXsXJ7gA89Ei2KLMn/f9y1y69Fv1QizP4lIsj3shlse9HMuzyIjlcaws+Znm56x4APMmemwv/Mbl/9Y+XPitlv+bsi8rKxfshaP87st7k9Lb/Gqa98zsRM23lKNc5X3ZHGde0cyObMi8Zvq8aTDqq0HuUjqfmSf505qpKhrJk4SzXZIv5punOrBAcsMtX+4V5JWnuaIC5rhf3QfmnIuwn0TUiXVJNjXrYn9RHJJWdnz085IGfV3ObY/0PJwLtS6FNIhxUUieP+aYy3CeymgjKNHncT49lQtfOg//ZS6VX68fjTUDA2ZLsA1szeoYt737kzFENsTpLWOg3+XrPZ/oD9R+4nu66Rq4p7STeiou3LUuJzMhDTPfjbEUJpYcaLqlXoldIIKMGBiWzHdNJtJxhKv6onEWruTBcnVbyH0QjSfevzCu0rxXzoZSLTn+bN66FvcRz/HofI34Edfjz/vt4vqXOPsy6llUr65/ccO6/U6/5eJ2a0Ob9xP9kvUeyuXfBd+IO+lKX8HYUSdWZfV7+AZzvdK3dx+wz2phTFo2NjfITmHunuSaXvBUKlexa9dm0EaYs8nyjh3o3GWMtYROjIf6uPV0GDUDP8r7Svz+JudhTcSicRTns7BF47k2v8adlM2PMGym5BqqBfIXbQ+vZtqLDeFyPgX1e24+RfoMbZ8OcTlJfCbD+mVlT5DZ4twUJ2q3PG4CxnrGfbFx/KanusIZBkWCJ9KVQG5cEiwp0BFY5ej7SJ6kvr8as8JNaIPxnFHeBZy3Mc1KYlnQ+CdwL7KwzqRfgilJjS/FurC1bKyL+PsY6yJ57gasi+Tdgvjqs/F1knevwCUhOBIxPcM4Sz3+XI5HsuiA9MnV67zr2s+rZb6k1yP3GYpXzmNCQOchuAQWs03HzapH64n8f9SPXzOOfP5mwnel5oNYbQnvlc1BpvNl6bEgfcP6FaH9x9xeqJmd7sOzWOWj37L8LNss3wz1TuYdRp9zGbYCuU4wMljvYt+wRkBXSx63CJYs1ub7RFzyiE5UDXXVKe4vKNffuS+HbjuTj0wr5aOie7rgLqKe65d77kosHDo2yMmhg9fSj/ZByXfSvV2QI12qPem6s+IoJ9bWyubPv1H78XLuenbM5dvxXXJmTxO1ucSEuXZHWMk1OKOb8X1I8ViJvHSdnt9Z7Nkp3o0r3M4fJ/cDfRYxpWlc+cF4cuzhpdcM65+UffYUJ630e8pf1gVK1roYc1fhvKi/89itFNcm0kmPbGXX6NqxvkfjLHaIbeFYRtEJpp4Hco55fd3NJan3zUZ7CjEXA3imObChTUk13BL4fjk1TX2ybsCJZC38jqTMFVY96E11LnAwRhGoUOk22jvV7wA9tK0yFxiF0RHn760Edkz2fCpYu8XFWG70Dew1X9srB7OiSn1OafSBf2RJOYyqyhx0Ah/4qSHsgU8OOsEr6vxk7bKxOq+tz8mFtXaAvuQORJxPF2gLfBEMm3qjHG5SVq0Lhe0nNSTjNY1t2rQt7xrbSWqLi+7s/Pg8hpZjvFMsDcTSZ91UxvtRrJ9mWmeyBehmiWwRYRbd3D51D/0qzn04PqVE3KErapWMGg1WInPNxgY1h4YoZta8T+8IoIlfpt+M8aqIsWiMHYq+LKU3s8q+z7AYA3mI5bbzOEc3T6a4+BzIgzCW0WlthJBvU52sPsZ9x8hLXe4cxovd1bo56prUHUXpyIltILtegi/PNUOsd2URntc3sP8+KdtAiN1FYaK42d+H9aHO+iBnMTX2sIaQZlt1rN02lCNeKL6LayNa/rsVc+dXfMzhOPLvvdSmfh0mpU7bVlAf9z2JLYfLyrAvBc+558/9IP7NVtXe9mI8m16uvyzMw8K2S87lKEeLYBIa5mcx9uFRu7flbJ3M4RzTi5kdjecqPJl4fMV26y+sC+fCnTxaxrY5SvYO+Jw4Qx0x8QY32MbP+yA4xyvhhSX49IeXymztkrp93rtnVzejVmfjwr4d9vgl1k3z7PYG9QQ4U9BGtArzEnms4feB34/2fFhLdhF8Yu0911EIn2PNjFgGeOGiOqI9fh+P94WN7KnwfNZ8XrZiYsd9WYZxU0KdB9movXEX/CfWIh/tn/beG79SZH47OAQ7tyEy7mE2gb7hDnUXA07bqvZ0qzSErctVN1adD4aLGcn/e7HjMbFvnh18unW2b3CWYjaZDZxDX+pci//71Sf+QPNraMvzYUWtvmB99ibWqTSzx77osAN757+kvu/vMCZJ+75cI53GS56RGhUm8jPIWHgeYY3E/lbYWKTuqLIZN0G2w33ArdnhGw9nBL/Euu8vnLf2mjO2/8bj+fvt1dl03hWs+/uF3x9eOFLT+A3GCs8HuJaow2H9g2hObTzLSW1WmHO8BzZmJO/A81l7ZCNIIS/+e9ftePwvi6d/w34hvp1/L83Rn1Sl9sm/gM8p+exfS3f2fA7I78n/Xj/GDQX/UD/I523yi0/+fwr/2JEgaORTo38Pzwtt+FM5CEJbCh/Fzw0D/7LJZ9IgfO6x/bpQF4SqcPX/fPoDzJljvs/3HdZhjdZtKi5mX1VttVptqvont3+cfe0fDu3O0730MJM/jMFmN5Nrg8fF83hRm9XaHbH7zpldz3lTRPN9+il3uoNV/X63e5+/TOY99aHvaPeLZmN19z7SWrxWWzaCmf7+Ije7d9OpcKe2qsLH5qPGOtOPek22lJHwKMsSYx5etMbXG//W/Hj2vEHHnM1GnZc33np8eHzsdt7vv9yAHXyYtl15lrvrwfrRbEhw/AjTD+nluzlwPg/71T2ISPb6fttfSPfqYlpZDDoOyP3B9HW1dIxgx63HoNW8WFpHeF/cSZU7/77Xf3HfZpr0GNwPtndfc2Eod3pu36w+iA93/qT9OLbrjNLT+/pK4oT71WHZqTQ2tXfb3tcHu27DG5nLd+HZFA7vY58Tm1+m9bHR31q17dNdV7YeWMnaVD61Vt3q3T0qHx0u2Kwk5v056L02Fg9AyVFd/dyZ/sxz7/3V5lH9Zge9t7pWVWW1vVusn1ujQeeNkfR7eRlYd6N5fTLufzy3H9nHj9fB9O1pOZgo9Y/vRrty/yyvB9/f1pIDed8S1LeRxX2/dqq9zvOD0G4Kn43noFmpT77q8pe6aDwNXrhFdfty9zScSgvbuv/46Dzsx+tPwR8ru1HNCKYPvaE/tY1v1xt3xKfl68ecqzDK0xu/WezYzydxv2dXO+v+6ZWR3m2z35X8bt3s6D7ItMNKw+4M5arteK7Y3kkjVlKejd7+rbJ6eX6xJ+7bytlPqjPhYyF9MJu13nO++e9q4L2vvg6D3oI3R47w1VUfnhpeY7KS396fhiuLs7qy/lT3lK9vC1P8/PvX8fOj178/7OzpnfX2PByse0+7bWNmyYywvd9ovSZfvzeVZ7PXbFaeKofl3ev6u79ZVZ/khdLZdFbSSK1ORt6j/+nf88/1x0rAW+v9rP68emx9uffd0f0g0HZ3nMg3Gm9L76O+ZdoTRZgMF77u1Wur6Qv30Lpj24EwY7+Am5ujPlcXOYufdnu17Xqv9r7kttsbjtzlczC7G03sZmt137u3a7077y1YTR/VgTcdLQT7fuXI1UbbW7PiQ+Ox3ZQqPNuvWu9BwG3uBou3AM8cQUoOCjyD6lvyud3ejKYCL3L3/Yq+q7QNzdrXls+HlaTI7P/95///81/BrscxpQYNAA==", "base64");
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
