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
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EnhanceError } from "../../../core/src/auth.ts";
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
