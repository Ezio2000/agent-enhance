import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installEnhanceFooter } from "../packages/hosts/pi/src/footer.ts";

const identityTheme = {
  fg: (_name: string, text: string) => text,
};

const home = process.env.HOME ?? "/home/tester";

function fakeContext(entries: unknown[] = []) {
  let factory:
    ((tui: unknown, theme: unknown, footerData: unknown) => { render(width: number): string[] }) | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setFooter(f: unknown) {
        factory = f as typeof factory;
      },
    },
    sessionManager: {
      getCwd: () => `${home}/projects/demo`,
      getSessionName: () => undefined,
      getEntries: () => entries,
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 100000, percent: 1 }),
    model: { id: "gpt-6-astra", provider: "openai-codex", reasoning: true },
    thinkingLevel: "medium",
  };
  return {
    ctx,
    render(width: number, statuses: Record<string, string> = {}, branch: string | null = null): string[] {
      assert.ok(factory, "footer factory not installed");
      const component = factory!({ requestRender() {} }, identityTheme, {
        getGitBranch: () => branch,
        getExtensionStatuses: () => new Map(Object.entries(statuses)),
        getAvailableProviderCount: () => 2,
        onBranchChange: () => () => {},
      }) as unknown as { render(width: number): string[] };
      return component.render(width);
    },
  };
}

test("footer renders control labels right of the project path", () => {
  const fake = fakeContext();
  const labels = [
    { id: "fast", value: "on(2.5x)", active: true },
    { id: "verbosity", value: "off", active: false },
  ];
  installEnhanceFooter(fake.ctx as never, "pi-enhance", () => labels);
  const lines = fake.render(100);
  const first = lines[0]!;
  const pwdIndex = first.indexOf("~/projects/demo");
  const fastIndex = first.indexOf("fast:on(2.5x)");
  const verbosityIndex = first.indexOf("verbosity:off");
  assert.ok(pwdIndex >= 0 && fastIndex > pwdIndex && verbosityIndex > pwdIndex, first);
  // Right-aligned: labels end at the line width.
  assert.equal(visibleWidth(first), 100);
});

test("footer hides labels when none apply and keeps other extensions' statuses", () => {
  const fake = fakeContext();
  installEnhanceFooter(fake.ctx as never, "pi-enhance", () => []);
  const lines = fake.render(80, { "pi-enhance": "fast:off", "other-ext": "ready" }, "main");
  assert.match(lines[0]!, /~\/projects\/demo \(main\)/);
  assert.ok(!lines[0]!.includes("fast"));
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /^ready$/);
});

test("footer truncates labels rather than the path on narrow terminals", () => {
  const fake = fakeContext();
  const labels = [
    { id: "fast", value: "off", active: false },
    { id: "verbosity", value: "high", active: true },
    { id: "image_detail", value: "off", active: false },
  ];
  installEnhanceFooter(fake.ctx as never, "pi-enhance", () => labels);
  const lines = fake.render(30);
  assert.ok(lines[0]!.startsWith("~/projects/demo"));
  assert.ok(visibleWidth(lines[0]!) <= 30);
  assert.ok(!lines[0]!.includes("verbosity"), lines[0]);
});

test("footer computes usage stats and model info from the session context", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: { total: 0.5 } },
      },
    },
  ];
  const fake = fakeContext(entries);
  installEnhanceFooter(fake.ctx as never, "pi-enhance", () => []);
  const lines = fake.render(120);
  assert.match(lines[1]!, /↑10 ↓5 R100/);
  assert.match(lines[1]!, /CH90\.9%/);
  assert.match(lines[1]!, /\$0\.500/);
  assert.match(lines[1]!, /gpt-6-astra • medium/);
  assert.match(lines[1]!, /\(openai-codex\)/);
});
