import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { EnhanceError } from "./auth.ts";
export function enhanceHome(): string {
  return process.env.AGENT_ENHANCE_HOME ?? join(homedir(), ".agent-enhance");
}
export interface HostConfig {
  version: 1;
  autoload: string[];
  defaults: Record<string, string>;
  controls: Record<string, string>;
}
export const emptyConfig = (): HostConfig => ({ version: 1, autoload: [], defaults: {}, controls: {} });
export function readJson<T>(path: string, fallback: () => T): T {
  if (!existsSync(path)) return fallback();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } catch {
    throw new EnhanceError("CONFIG_INVALID", `Cannot read ${path}; original file was not changed.`);
  } finally {
    closeSync(fd);
  }
}
export function updateJson<T>(path: string, fallback: () => T, update: (current: T) => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new EnhanceError("CONFIG_LOCKED", `Retry after the other writer finishes: ${path}`);
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const value = update(readJson(path, fallback));
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    return value;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
function validate(config: HostConfig): HostConfig {
  if (
    config?.version !== 1 ||
    !Array.isArray(config.autoload) ||
    config.autoload.some((x) => typeof x !== "string") ||
    !config.defaults ||
    !config.controls ||
    typeof config.defaults !== "object" ||
    typeof config.controls !== "object" ||
    Array.isArray(config.defaults) ||
    Array.isArray(config.controls) ||
    Object.values(config.defaults).some((x) => typeof x !== "string") ||
    Object.values(config.controls).some((x) => typeof x !== "string")
  )
    throw new EnhanceError("CONFIG_INVALID", "Unsupported host configuration; not overwritten.");
  return config;
}
export class ConfigStore {
  readonly path: string;
  constructor(home: string, host: string) {
    if (!/^[a-z][a-z0-9-]*$/.test(host)) throw new Error("Invalid host ID");
    this.path = join(home, "hosts", `${host}.json`);
  }
  load(): HostConfig {
    return validate(readJson(this.path, emptyConfig));
  }
  update(update: (config: HostConfig) => HostConfig): HostConfig {
    return updateJson(this.path, emptyConfig, (c) => validate(update(validate(c))));
  }
}
