import { open, rename, rm, stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const STALE_MS = 30_000;
/** Cross-process exclusive section guarded by `<path>.lock`; waits instead of failing, breaks stale locks. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) =>
      error.code === "EEXIST" ? undefined : error,
    );
    if (file instanceof Error) throw file;
    if (file) {
      try {
        await file.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await file.close();
      }
      try {
        return await fn();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs > STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
    } catch {
      /* Lock vanished; retry. */
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** Atomic replace; callers hold the matching file lock. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
