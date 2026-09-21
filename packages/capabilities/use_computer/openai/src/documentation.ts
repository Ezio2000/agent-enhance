/** Project the bundled superset documentation onto the surface enabled by runtime.ts.
 * Never alter the confirmation policy or arbitrary application observations.
 */
export function computerDocumentation(text: string): string {
  if (!text.startsWith("## Computer Use\n") || !text.includes("# Computer Use Confirmations Policy"))
    return text;
  const start = text.indexOf("## API\n");
  const end = text.indexOf("## Workflow\n", start);
  if (start < 0 || end < 0)
    throw new Error(
      "Computer runtime documentation changed; cannot safely project its API to computer-only mode.",
    );
  const api = text.slice(start, end);
  // Keep the official Target/App method signatures; remove disabled Browser/Tab declarations.
  const browserStart = api.indexOf("type BrowserInfo =");
  if (browserStart < 0 || !api.includes("declare const cua:"))
    throw new Error("Unsupported Computer runtime API documentation.");
  const projected =
    api.slice(0, browserStart) +
    `type State = { apps: AppInfo[]; browsers: [] };

declare const cua: {
  getState(options?: ObservationOptions): Promise<State>;
  getApp(app: string): Promise<App>;
  listApps(options?: ObservationOptions): Promise<AppInfo[]>;
};
\`\`\`

`;
  const mode = `## Agent bridge capabilities (computer-only)

Only native macOS applications are enabled. Browser-provider/Tab APIs are unavailable, even when other parts of the bundled guidance discuss browsers. Control Safari through cua.getApp("com.apple.Safari"); control Chrome through cua.getApp("com.google.Chrome"). Prefer the exact bundle ID from apps[].id over localized display names.

Use native app pressKey/paste/click with fresh UI observations for navigation. Do not call getBrowser, createBrowserTab, getTab, listBrowsers, listTabs, or Tab.goto. Do not switch to shell open/AppleScript or another desktop-control path after a denial, timeout, or API error. Stop on denial/user intervention; after a timeout, inspect state before any further action. getApp already emits the initial AX state; do not immediately request the same state again. Allow enough time for the first app approval (normally use the default 60 seconds or up to 120); the outer deadline includes approval waiting.

All JS state is discarded when the host task fully settles; session application grants remain until explicitly revoked or the host session changes. Automatic continuation before settlement retains JS state. Initialize again on each new task.

`;
  return mode + text.slice(0, start) + projected + text.slice(end);
}
