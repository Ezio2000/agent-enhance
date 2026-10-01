/** Evaluated by a child Node process; source stays plain JS so a standalone module needs no loader. */
export const WORKER_SOURCE = String.raw`
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
  const keyAliases={cmd:'command',meta:'command',super:'command',ctrl:'control',alt:'option',esc:'escape',enter:'return',backspace:'delete'};
  const normalizeKey=key=>{
    if(typeof key!=='string') return key;
    const lower=key.trim().toLowerCase(); return Object.hasOwn(keyAliases,lower)?keyAliases[lower]:lower;
  };
  let isolation = 'isolated-only';
  const emitPNG = (data, mimeType='image/png') => {
    const call=calls.getStore();
    if(!call?.active) throw new Error('The JS call has ended. No image was emitted.');
    const bytes=Buffer.byteLength(data,'base64');
    if(call.images >= 4 || call.imageBytes + bytes > 24*1024*1024) {
      output('[Screenshot omitted: maximum 4 images / 24 MiB per call.]'); return;
    }
    call.images++;call.imageBytes+=bytes;
    const block={type:'image',data,mimeType};call.content.push(block);
    process.send({type:'output',id:call.id,block});
  };
  const options = (window, opts) => {
    const scope = scopes.getStore();
    if (scope && (scope.window !== window || (opts?.mode && opts.mode !== scope.mode))) {
      throw new Error('An input scope cannot change its target window or mode.');
    }
    const mode = opts?.mode ?? scope?.mode ?? 'background';
    if(isolation === 'isolated-only' && mode === 'foreground') {
      const error = new Error('This session is isolated-only. The host has disabled shared foreground input.');
      error.code='ISOLATION_REQUIRED';
      error.details={isolation,dispatched:false,delivery:'blocked',target:{window}}; throw error;
    }
    return {...scope?.options,...opts,mode};
  };
  class Window {
    constructor(id) { this.id=id; }
    [inspect.custom]() { return {window:this.id}; }
    invoke(method, params={}, opts={}) {
      if(Object.prototype.hasOwnProperty.call(params,'mode')) throw new Error('Put mode in the separate options argument, e.g. window.click({element:id}, {mode:"foreground"}). No action was dispatched.');
      const selected=options(this.id,opts);
      if(!['pressKey','typeText','keyDown','keyUp'].includes(method)) delete selected.element;
      return rpc(method,{...selected,...params,window:this.id});
    }
    async observe(opts={}) {
      const result=await this.invoke('observe',opts);
      if(result.webContent?.status==='pending') output('OBSERVATION_INCOMPLETE: Embedded web content is still absent after bounded AX recovery. This is a partial tree, not proof that chats/controls are absent. Use screenshot to inspect the window. Some CEF apps require launch-time --force-renderer-accessibility; when a restart is authorized, use computer.restartApp(appId,{accessibility:true}), then obtain fresh app/window handles. Never change global isolation settings or automatically restart an app from an observation.');
      if(result.webContent?.status==='depth_limited') output('OBSERVATION_DEPTH_LIMIT: Embedded web content exceeds the requested depth. Observe with depth:60 before concluding controls are absent.');
      return result;
    }
    async screenshot() {
      const result = await this.invoke('screenshot');
      emitPNG(result.image ?? '',result.mimeType);
      const {image,...meta}=result; return meta;
    }
    activate() { return this.invoke('activate',{}, {mode:'foreground'}); }
    setBounds(rect) { return this.invoke('setBounds',rect); }
    minimize() { return this.invoke('minimize'); }
    restore() { return this.invoke('restore'); }
    performAction(element,action) { return this.invoke('performAction',{element,action}); }
    setValue(element,value,opts={}) { return this.invoke('setValue',{element,value},opts); }
    selectAll(element,opts={}) { return this.invoke('selectAll',{element},opts); }
    selectText(element,range,opts={}) { return this.invoke('selectText',{element,range},opts); }
    replaceText(element,text,opts={}) { const {range,...options}=opts; return this.invoke('replaceText',{element,text,range},options); }
    menu(path,opts={}) { return this.invoke('menu',{path},opts); }
    click(target,opts={}) { return this.invoke('click',target,opts); }
    pressKey(keys,opts={}) { return this.invoke('pressKey',{keys:Array.isArray(keys)?keys.map(normalizeKey):keys},opts); }
    typeText(text,opts={}) { return this.invoke('typeText',{text},opts); }
    keyDown(key,opts={}) { return this.invoke('keyDown',{key:normalizeKey(key)},opts); }
    keyUp(key,opts={}) { return this.invoke('keyUp',{key:normalizeKey(key)},opts); }
    moveMouse(point,opts={}) { return this.invoke('moveMouse',{point},opts); }
    mouseDown(point,opts={}) { return this.invoke('mouseDown',{point},opts); }
    mouseUp(point,opts={}) { return this.invoke('mouseUp',{point},opts); }
    drag(path,opts={}) { return this.invoke('drag',path,opts); }
    scroll(delta,opts={}) { return this.invoke('scroll',delta,opts); }
    async withKeys(keys,callback,opts={}) {
      if(Array.isArray(keys)) keys=keys.map(normalizeKey);
      const selected = options(this.id,opts);
      if(selected.expect !== undefined) {
        const error=new Error('Put expect on the action inside withKeys, not on the modifier scope. No key was held.');
        error.code='INVALID_ARGUMENT'; throw error;
      }
      if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length || typeof callback !== 'function') {
        throw new Error('withKeys requires unique keys and an async callback.');
      }
      return scopes.run({window:this.id,mode:selected.mode,options:selected},async()=>{
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
            error.details=failure?.details ?? errors[0]?.details;
            throw error;
          }
        }
      });
    }
  }
  class App {
    constructor(info) { Object.assign(this,info); }
    [inspect.custom]() { return {id:this.id,name:this.name,pid:this.pid,...(this.accessibilityLaunch?{accessibilityLaunch:this.accessibilityLaunch}:{})}; }
    listWindows() { return rpc('listWindows',{app:this.id}); }
    async getWindow(id) {
      if (!(await this.listWindows()).some(window=>window.id===id)) throw new Error('Window ID does not belong to this app. List windows again.');
      return new Window(id);
    }
  }
  const computer={
    help:()=>documentation,
    showImage:async(path)=>{
      if(typeof path !== 'string' || !path) throw new Error('showImage requires a saved PNG path.');
      const {readFile,stat}=await import('node:fs/promises');
      if((await stat(path)).size>24*1024*1024) throw new Error('PNG artifact exceeds 24 MiB.');
      const bytes=await readFile(path);
      if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('showImage accepts PNG artifacts.');
      emitPNG(bytes.toString('base64'));return {path,mimeType:'image/png'};
    },
    getState:()=>rpc('getState'),
    listApps:async()=>(await rpc('getState')).apps,
    getApp:async(app)=>new App(await rpc('getApp',{app})),
    launchApp:async(app,opts={})=>new App(await rpc('launchApp',{app,...opts})),
    restartApp:async(app,opts={})=>new App(await rpc('restartApp',{app,...opts})),
    wait:async(ms)=>{
      const call=calls.getStore();
      if (!call?.active || !Number.isFinite(ms) || ms<0 || ms>30000) throw new Error('wait requires 0..30000 ms within an active call.');
      await new Promise(resolve=>setTimeout(resolve,ms));
      if(!call.active) throw new Error('Call ended while waiting.');
    }
  };
  const input=new PassThrough();
  const shell=start({input,output:new Writable({write(chunk,encoding,done){done();}}),terminal:false,prompt:'',useGlobal:false});
  const log=(...args)=>output(args.map(value=>typeof value==='string'?value:inspect(value,{depth:12,maxArrayLength:2000,maxStringLength:32000,colors:false})).join(' '));
  Object.assign(shell.context,{computer,print:log,console:{log,info:log,warn:log,error:log}});
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
    isolation=message.isolation;
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
        failure={message:error?.stack ?? String(error),code:error?.code,indeterminate:error?.indeterminate,details:error?.details};
        await Promise.allSettled([...call.pending]);
      } finally { call.active=false; executing=false; }
      process.send({type:'result',id:message.id,content:call.content,error:failure});
    });
  });
  process.on('disconnect',()=>process.exit(0));
  process.send({type:'ready'});
})().catch(error=>{process.stderr.write(String(error.stack ?? error));process.exit(1);});
`;
