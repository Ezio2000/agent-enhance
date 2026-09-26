import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CHANNELS,
  ClaudeCodeCredentialResolver,
  CredentialStore,
  codexAuthPath,
  type ApiKeyEntry,
} from "./credentials.ts";
import { pollDeviceCode, requestDeviceCode, type DeviceCode } from "./xai.ts";

const usage = [
  "/cc-enhance login                       show login state of every provider",
  "/cc-enhance login openai                check the Codex CLI login (~/.codex/auth.json)",
  "/cc-enhance login xai                   start xAI device login (SuperGrok / X Premium)",
  "/cc-enhance login opencode <api-key>    OpenCode Go key",
  "/cc-enhance login minimax <key> [--global]   MiniMax Token Plan key (sk-cp-…); --global uses api.minimax.io",
  "/cc-enhance login zai <key> [--cn]      Z.ai GLM Coding Plan key; --cn uses open.bigmodel.cn",
  "/cc-enhance login import-pi             copy API keys from Pi (~/.pi/agent/auth.json)",
  "/cc-enhance logout <provider>           remove a stored credential",
].join("\n");
const channelOf = (provider: string) => Object.keys(CHANNELS).find((c) => CHANNELS[c]!.provider === provider);

export async function loginStatus(home: string): Promise<string> {
  const resolver = new ClaudeCodeCredentialResolver(home);
  const lines = ["Provider credentials (" + resolver.store.path + "):"];
  for (const channel of Object.keys(CHANNELS)) {
    const [provider, name] = channel.split("/") as [string, string];
    const result = await resolver.resolve(
      { provider: provider as never, channel: name, acceptedKinds: ["oauth", "api_key"] },
      { interactive: false },
    );
    lines.push(
      `  ${channel.padEnd(20)} ${result.status === "ready" ? `ready (${result.credential.kind}${result.credential.baseUrl ? `, ${result.credential.baseUrl}` : ""})` : `${result.status} — ${result.guidance}`}`,
    );
  }
  return lines.join("\n");
}

async function saveKey(home: string, provider: string, entry: ApiKeyEntry): Promise<string> {
  const channel = channelOf(provider)!;
  await new CredentialStore(home).set(channel, entry);
  return `Saved ${channel} API key${entry.baseUrl ? ` (${entry.baseUrl})` : ""}. Active on the next tool call; no restart needed.`;
}

export async function login(home: string, args: string[]): Promise<string> {
  const [provider, ...rest] = args;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const key = rest.find((a) => !a.startsWith("--"));
  if (!provider) return (await loginStatus(home)) + "\n\n" + usage;
  switch (provider) {
    case "openai": {
      const resolver = new ClaudeCodeCredentialResolver(home);
      const result = await resolver.resolve(
        { provider: "openai", channel: "codex", acceptedKinds: ["oauth"] },
        { interactive: false },
      );
      return result.status === "ready"
        ? `Codex login OK (${codexAuthPath()}). OpenAI capabilities use your ChatGPT subscription.`
        : `${result.guidance}\nRun \`codex login\` in a terminal (or \`! codex login\` in Claude Code), then retry.`;
    }
    case "opencode":
      if (!key) return "Usage: /cc-enhance login opencode <api-key>";
      return saveKey(home, "opencode", { kind: "api_key", key });
    case "minimax":
      if (!key) return "Usage: /cc-enhance login minimax <sk-cp-key> [--global]";
      if (!key.startsWith("sk-cp-") && !key.startsWith("eyJ"))
        return "MiniMax media tools need a Token Plan key (sk-cp-…), not a platform API key.";
      return saveKey(home, "minimax", {
        kind: "api_key",
        key,
        baseUrl: flags.has("--global") ? "https://api.minimax.io" : "https://api.minimaxi.com",
      });
    case "zai":
      if (!key) return "Usage: /cc-enhance login zai <api-key> [--cn]";
      return saveKey(home, "zai", {
        kind: "api_key",
        key,
        baseUrl: flags.has("--cn") ? "https://open.bigmodel.cn" : "https://api.z.ai",
      });
    case "xai": {
      const device = await requestDeviceCode();
      if (flags.has("--wait")) {
        console.log(`Open ${device.verificationUri} and confirm code ${device.userCode}. Waiting…`);
        await new CredentialStore(home).set("xai/imagine", await pollDeviceCode(device));
        return "xAI login complete.";
      }
      // Poll in a detached process so the slash command returns immediately.
      const child = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1]!, "poll-xai", JSON.stringify(device)],
        {
          detached: true,
          stdio: "ignore",
          env: process.env,
        },
      );
      child.unref();
      return [
        `1. Open: ${device.verificationUri}`,
        `2. Confirm code: ${device.userCode}`,
        `3. Sign in with SuperGrok / X Premium and approve. Valid for ${Math.round(device.expiresInSeconds / 60)} minutes.`,
        "Login is saved automatically in the background; run /cc-enhance login afterwards to confirm xai/imagine is ready.",
      ].join("\n");
    }
    case "import-pi":
      return importPi(home);
    default:
      return `Unknown provider ${provider}.\n${usage}`;
  }
}

export async function logout(home: string, provider: string | undefined): Promise<string> {
  const channel = provider && channelOf(provider);
  if (!channel || channel === "openai/codex")
    return "Usage: /cc-enhance logout xai|opencode|minimax|zai (OpenAI uses the Codex CLI login: `codex logout`).";
  await new CredentialStore(home).set(channel, undefined);
  return `Removed ${channel}.`;
}

/** Background poller entry for `login xai`. */
export async function pollXai(home: string, raw: string): Promise<void> {
  const device = JSON.parse(raw) as DeviceCode;
  await new CredentialStore(home).set("xai/imagine", await pollDeviceCode(device));
}

// Pi provider id -> cc-enhance channel + fixed media origin. Only API keys are imported: OAuth refresh
// tokens (xAI) may rotate, so a shared copy would log one of the hosts out.
const PI_KEYS: [string, string, string | undefined][] = [
  ["opencode-go", "opencode/go", undefined],
  ["minimax-cn", "minimax/token-plan", "https://api.minimaxi.com"],
  ["minimax", "minimax/token-plan", "https://api.minimax.io"],
  ["zai", "zai/coding-plan", "https://api.z.ai"],
  ["zai-coding-cn", "zai/coding-plan", "https://open.bigmodel.cn"],
];
export async function importPi(home: string): Promise<string> {
  const path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
  let auth: Record<string, { type?: string; key?: string }>;
  try {
    auth = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return `No readable Pi credentials at ${path}.`;
  }
  const imported: string[] = [];
  const skipped: string[] = [];
  await new CredentialStore(home).update((file) => {
    const credentials = { ...file.credentials };
    const done = new Set<string>();
    for (const [piId, channel, baseUrl] of PI_KEYS) {
      const entry = auth[piId];
      if (!entry || done.has(channel)) continue;
      // Pi also accepts env-var names / shell commands as keys; only literal keys are copied.
      if (
        entry.type !== "api_key" ||
        typeof entry.key !== "string" ||
        !entry.key ||
        /^[!$]/.test(entry.key)
      ) {
        skipped.push(`${piId} (not a literal API key)`);
        continue;
      }
      credentials[channel] = { kind: "api_key", key: entry.key, ...(baseUrl ? { baseUrl } : {}) };
      done.add(channel);
      imported.push(`${piId} → ${channel}${baseUrl ? ` (${baseUrl})` : ""}`);
    }
    return { version: 1, credentials };
  });
  if (auth.xai) skipped.push("xai (OAuth is not shared; run /cc-enhance login xai)");
  if (auth["openai-codex"])
    skipped.push("openai-codex (cc-enhance uses the Codex CLI login; see /cc-enhance login openai)");
  return [
    imported.length ? `Imported:\n  ${imported.join("\n  ")}` : "No API keys imported.",
    ...(skipped.length ? [`Skipped:\n  ${skipped.join("\n  ")}`] : []),
  ].join("\n");
}
