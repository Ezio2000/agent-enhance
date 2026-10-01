export const DOCUMENTATION = `# Agent Enhance native computer API
All methods are async. JS bindings persist until task settlement/reset; prefer var for reusable bindings.
print(...values) emits every argument, like console.log. print('count:', observation.elements.length) is valid.
The final expression is displayed. screenshot() emits PNG automatically. Avoid bindings named fs/os;
Node's REPL can expose lazy built-in modules under those names. Use var app, win and observation.

computer.help() returns this documentation.
computer.showImage(savedPngPath) emits an existing PNG without any desktop action.
  Claude Code folds images into text on is_error. Use showImage in a new successful call to view a failure screenshot;
  never replay its UI actions or recapture the window just to retrieve that image.
computer.getState() -> {apps:[{id,name,pid,active,hidden}],permissions,generation,isolation,directedPointer}
computer.listApps(); computer.getApp(bundleId) -> App (does not launch/focus)
computer.launchApp(bundleId,{foreground?:boolean,accessibility?:boolean}) -> App (background default)
computer.restartApp(bundleId,{foreground?:boolean,accessibility?:boolean}) -> App (normal quit, then relaunch)
  accessibility:true passes Chromium/CEF's --force-renderer-accessibility at startup. It cannot reconfigure
  an already running app; launchApp reports accessibilityLaunch:"already_running_arguments_not_applied".
  If a CEF app remains webContent.pending and a restart is authorized, restartApp with accessibility:true.
  Restart closes app windows; it never force-kills a refused/pending quit. Acquire new app/window handles.
  Observe never restarts apps. Default isolation refuses restarting the user's active application.
computer.restoreUserFocus() -> {restored:boolean,...}
  After ISOLATION_VIOLATION, first observe state/windows and completed effects. If diagnostics report
  focusRecoveryAvailable:true, explicitly call restoreUserFocus before further UI input. It returns only
  to the app/window displaced by this runtime's recorded unexpected activation, within 90 seconds.
  If foreground has since changed, it dispatches no activation. It accepts no arbitrary app/window target,
  changes no isolation policy, and never replays the original action. Obtain fresh observations afterwards.
computer.wait(ms) (0..30000, bounded by the call deadline)
App: {id,name,pid}; app.listWindows() -> [{id,title,bounds,minimized}]
app.getWindow(id) -> Window. Copy exact opaque IDs.

Window:
observe({depth?:number}) -> {snapshot,window,bounds,elements,truncated,truncation,relatedWindows,accessibilityModes,accessibilityObserver,webContent}
  depth defaults to 12, maximum 60. truncation.depth means descendants exceeded the requested depth;
  request deeper observation before concluding chat/web controls are absent. A persistent AX observer and
  application accessibility requests prepare Chromium/CEF content without activation. Missing embedded
  trees get bounded read-only recovery; webContent.status reports ready/pending/depth_limited/node_limited/
  not_detected and missing containers. Setter status alone does not prove content is ready. ready means
  the web areas are exposed, not that an app's network content has finished loading; observe again as needed.
  For chat reading, observe({depth:60}) and search the full elements array by title/description/value.
  If the recipient is already in the conversation list, click its nearest ancestor supporting AXPress,
  even when offscreen; observe again and verify the chat header. Global search can activate a modal.
  Conversation lists can be virtualized: an absent row may need scrolling in the observed list area.
  scroll({point,x?,y?}) uses pixel deltas; y<0 moves toward later/lower content, y>0 toward earlier/upper.
  Verify the new rows after each scroll. Derive the window-relative point from observed list bounds.
  A modal's elements belong to that modal, not its parent. relatedWindows supplies its exact window ID;
  getWindow(relatedId) and observe that window before input. AXValue can be ignored/misapplied by web editors;
  EFFECT_MISMATCH is a real failure. Observe the partial state; explicit Window keyboard input is a different
  route requiring an observed target and verified effects, never an automatic replay or foreground fallback.
  elements: {id,parent?,role,title?,description?,identifier?,value?,enabled?,focused?,bounds?,actions,valueWritable,selectedRange?,selectedRangeWritable}
  selectedRange: {location,length}, in UTF-16 code units. Surrogate pairs cannot be split.
screenshot() -> {window,bounds,width,height,scaleX,scaleY} plus PNG
activate(); setBounds({x?,y?,width?,height?}); minimize(); restore()
performAction(elementId,action); menu(titlePath,options?)
setValue(elementId,string|number|boolean,options?) -> verified AX value
selectAll(elementId,options?); selectText(elementId,{location,length},options?)
replaceText(elementId,text,{range?:{location,length},expect?:Expectation}) -> verified whole value or range replacement
Semantic text APIs never substitute an unverified keyboard shortcut.
click({element?:id,point?:{x,y},button?:"left"|"right"|"middle",count?:1|2|3},options?)
pressKey(keys:string[],options?); typeText(text,options?)
  Named/layout key names are case-insensitive; Command/Cmd/Meta/Super, Control/Ctrl, Option/Alt,
  Return/Enter, Escape/Esc and Delete/Backspace are accepted. Text case/Unicode belongs in typeText.
  Foreground mode selects the window; CEF's AX focused flag alone may not select its native keyboard
  responder. Explicitly click the observed editor when needed, then verify typed text before sending.
keyDown(key,options?); keyUp(key,options?)
moveMouse(point,options?); mouseDown(point,options?); mouseUp(point,options?)
drag({from:point,to:point,duration_ms?:number,button?:string},options?)
scroll({point,x?:number,y?:number},options?) (pixel deltas)
withKeys(keys,asyncCallback,{mode?,element?,button?}) -> callback result, acquired keys released in finally
  Put expect on individual actions inside the callback, not on the modifier scope.

options: {mode?:"background"|"foreground",element?:id,button?:"left"|"right"|"middle",expect?:Expectation}
Expectation: {element:id,value?:string|number|boolean,selectedRange?:{location,length},timeout_ms?:0..2000}
An unmet expectation throws EFFECT_MISMATCH. Subsequent awaited actions do not execute.
Prefer replaceText/selectAll/selectText to Command+A. Raw key chords keep literal semantics.
Input without an expectation reports dispatched/effectConfirmed:false. Observe to verify.

The host captures an immutable isolation policy. Default isolated-only refuses foreground/HID delivery.
Only the host can opt into shared, with AGENT_ENHANCE_COMPUTER_ISOLATION=shared before starting it.
Code and tool arguments cannot change policy. No route falls back automatically.
ISOLATION_VIOLATION can be detected AFTER an action ran: never treat it as an undispatched action.
Read getState/listWindows/observe (including related modal windows) and verify completed effects first.
If focusRecoveryAvailable:true, use computer.restoreUserFocus() to return the displaced user focus before input.
For read-only tasks, do not switch shared mode or edit host configuration as an error recovery step.
Isolated input refuses the user's active window; directed keys/pointer refuse the user's active application.
AX semantic edits on an inactive sibling window do not select its app key window.
Background keyboard requires options.element and a confirmed app key window/element; withKeys inherits that target.
Foreground input, available only with shared host policy, uses explicit mode:"foreground".

A plain single-element background click prefers AXPress. Coordinate/multi/right clicks, moves, drag and scroll
use a per-context logical cursor and directed PID/window events, without moving/hiding/restoring the real cursor.
They depend on a private window-coordinate SPI (directedPointer reports availability).
Modifiers are only the scope's own keys. No hidden Command flag is added; controls that ignore inactive unmodified
mouse events remain unconfirmed. Use an observable expectation or an available AX action.
Some app menu shortcuts, hover behavior and shared-app sibling keyboard routing cannot be isolated.

Coordinates are window-relative logical points. Screenshot scaleX/scaleY converts to image pixels.
Observe/screenshot before coordinates; changed geometry invalidates the observation.
A new observe invalidates that window's older element IDs. Never guess IDs or replay failures.
withKeys scopes cannot switch windows/modes. Holds never span tool calls.
Owned keys/buttons release through their original PID/window/channel on completion, error, reset or cancellation.
Explicit keyUp/mouseUp resume the owned route; mouseUp uses its last logical cursor position.
Control requests interrupt awaiting native actions and discard queued work; completed effects are not undone.
Side effects execute in submission order, including Promise.all. Detached work is rejected.
Failures start with a concise summary and full diagnostics path; screenshots, operations, target/route and cleanup
remain available to the host. Caught native failures are recorded separately from script completion.
Only macOS system permissions apply; missing permissions produce instructions.
`;
