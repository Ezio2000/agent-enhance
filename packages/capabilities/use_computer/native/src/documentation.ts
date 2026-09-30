export const DOCUMENTATION = `# Agent Enhance native computer API
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
