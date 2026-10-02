import { exec } from "node:child_process";
import { promisify } from "node:util";
/** Pi's value syntax: $NAME/${NAME}, $$/$! escapes, and !command resolved only on execution. */
export function interpolateConfigValue(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const resolved = value.replace(/\$(\$|!|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (match, reference: string) => {
    if (reference === "$" || reference === "!") return reference;
    const name = reference.startsWith("{") ? reference.slice(1, -1) : reference;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return match;
    const replacement = env[name];
    if (!replacement) {
      missing = true;
      return "";
    }
    return replacement;
  });
  return missing ? undefined : resolved;
}
export function sourceEnvironment(env: NodeJS.ProcessEnv, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...env, ...Object.fromEntries(Object.entries(extra ?? {}).filter(([, value]) => !!value)) };
}
export function isConfiguredValue(value: unknown, env: NodeJS.ProcessEnv): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith("!") ? !!value.slice(1).trim() : !!interpolateConfigValue(value, env))
  );
}
export async function resolveConfiguredValue(
  value: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  if (!value.startsWith("!")) return interpolateConfigValue(value, env) ?? "";
  const result = await promisify(exec)(value.slice(1), {
    env,
    signal,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
