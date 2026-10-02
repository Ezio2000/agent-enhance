import { homedir } from "node:os";
import { join } from "node:path";
import { EnhanceError } from "../../../core/src/auth.ts";
import { readJson, updateJson } from "./json.ts";

export const enhanceHome = () => process.env.AGENT_ENHANCE_HOME ?? join(homedir(), ".agent-enhance");
export interface Preferences {
  version: 1;
  preferred: Record<string, string>;
  excluded: string[];
}
export interface PiPreferences extends Preferences {
  requests: Record<string, string>;
  subagents: { enabled: boolean; model?: string };
}
export const emptyPreferences = (): Preferences => ({ version: 1, preferred: {}, excluded: [] });
export const emptyPiPreferences = (): PiPreferences => ({
  ...emptyPreferences(),
  requests: {},
  subagents: { enabled: false },
});
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function validate<T extends Preferences>(value: T, pi: boolean): T {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.preferred) ||
    Object.values(value.preferred).some((v) => typeof v !== "string" || !v) ||
    !Array.isArray(value.excluded) ||
    value.excluded.some((v) => typeof v !== "string" || !v) ||
    Object.keys(value).some(
      (k) => !["version", "preferred", "excluded", ...(pi ? ["requests", "subagents"] : [])].includes(k),
    )
  )
    throw new EnhanceError("CONFIG_INVALID", "Invalid service preferences; original file was not changed.");
  if (pi) {
    const p = value as unknown as PiPreferences;
    if (
      !record(p.requests) ||
      Object.values(p.requests).some((v) => typeof v !== "string") ||
      !record(p.subagents) ||
      typeof p.subagents.enabled !== "boolean" ||
      Object.keys(p.subagents).some((k) => !["enabled", "model"].includes(k)) ||
      (p.subagents.model !== undefined &&
        (typeof p.subagents.model !== "string" || !/^[^\s/]+\/\S+$/.test(p.subagents.model)))
    )
      throw new EnhanceError("CONFIG_INVALID", "Invalid Pi preferences; original file was not changed.");
  }
  return value;
}
/** Preferences are integration policy. They are never imported by Core. */
export class PreferenceStore<T extends Preferences = Preferences> {
  readonly path: string;
  constructor(
    home: string,
    readonly host: "pi" | "claude-code",
    private readonly empty: () => T,
    private readonly verifySettings?: (preferences: T) => void,
  ) {
    this.path = join(home, "preferences", `${host}.json`);
  }
  load(): T {
    const value = validate(readJson(this.path, this.empty), this.host === "pi");
    this.verifySettings?.(value);
    return value;
  }
  update(update: (current: T) => T): T {
    return updateJson(this.path, this.empty, (current) => {
      const before = validate(current, this.host === "pi");
      this.verifySettings?.(before);
      const after = validate(update(before), this.host === "pi");
      this.verifySettings?.(after);
      return after;
    });
  }
}
