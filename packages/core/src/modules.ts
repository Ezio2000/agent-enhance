import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EnhanceError } from "./auth.ts";
import { readJson, updateJson } from "./config.ts";
import type { CapabilityModule, ModuleManifest } from "./contracts.ts";

export interface CatalogEntry extends ModuleManifest {
  file: string;
  sha256: string;
  bytes: number;
}
export interface Catalog {
  version: 1;
  revision: string;
  repository: string;
  modules: CatalogEntry[];
}
export interface InstalledModule {
  version: string;
  sha256: string;
  file: string;
}
interface Lock {
  version: 1;
  modules: Record<string, InstalledModule>;
}
const emptyLock = (): Lock => ({ version: 1, modules: {} });
const moduleId = /^[a-z_]+\/[a-z]+$/;
const hash = /^[a-f0-9]{64}$/;
function validateLock(lock: Lock): Lock {
  if (
    lock?.version !== 1 ||
    !lock.modules ||
    typeof lock.modules !== "object" ||
    Array.isArray(lock.modules) ||
    Object.entries(lock.modules).some(
      ([id, entry]) =>
        !moduleId.test(id) ||
        !entry ||
        typeof entry.version !== "string" ||
        !hash.test(entry.sha256) ||
        entry.file !== `${id.replace("/", "--")}.mjs`,
    )
  )
    throw new EnhanceError("LOCK_INVALID", "Invalid module lock; not overwritten.");
  return lock;
}
const sameInstallation = (a: InstalledModule | undefined, b: InstalledModule | undefined) =>
  a?.sha256 === b?.sha256 && a?.version === b?.version && a?.file === b?.file;

export class ModuleManager {
  readonly lockPath: string;
  constructor(
    readonly home: string,
    readonly catalog: Catalog,
    private readonly bundledDirectory?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.lockPath = join(home, "modules.lock.json");
    if (
      catalog.version !== 1 ||
      catalog.repository !== "Ezio2000/agent-enhance" ||
      !Array.isArray(catalog.modules)
    )
      throw new EnhanceError("CATALOG_INVALID", "Untrusted module catalog.");
    const ids = new Set<string>();
    for (const entry of catalog.modules) {
      if (
        !moduleId.test(entry.id) ||
        entry.id !== `${entry.capability}/${entry.provider}` ||
        entry.apiVersion !== 1 ||
        typeof entry.version !== "string" ||
        entry.file !== `${entry.id.replace("/", "--")}.mjs` ||
        !hash.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes <= 0 ||
        entry.bytes > 25 * 1024 * 1024 ||
        ids.has(entry.id)
      )
        throw new EnhanceError("CATALOG_INVALID", "Invalid module entry.");
      ids.add(entry.id);
    }
  }
  find(id: string): CatalogEntry {
    const entry = this.catalog.modules.find((e) => e.id === id);
    if (!entry) throw new EnhanceError("MODULE_UNKNOWN", `Unknown capability/provider: ${id}`);
    return entry;
  }
  private readLock(): Lock {
    return validateLock(readJson(this.lockPath, emptyLock));
  }
  installed(id: string): InstalledModule | undefined {
    return this.readLock().modules[id];
  }
  /** Local catalog comparison only: no network, imports, or authentication. */
  updates(): CatalogEntry[] {
    const lock = this.readLock();
    return this.catalog.modules.filter((e) => lock.modules[e.id] && lock.modules[e.id]!.sha256 !== e.sha256);
  }
  private path(entry: CatalogEntry): string {
    return join(this.home, "packages", `${entry.sha256}-${entry.file}`);
  }
  private verify(bytes: Uint8Array, entry: CatalogEntry): void {
    if (bytes.byteLength !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new EnhanceError("MODULE_INTEGRITY", `Integrity verification failed: ${entry.id}`);
  }
  /** Stage verified bytes without changing installation records or executing the module. */
  private async stage(entry: CatalogEntry, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    try {
      this.verify(await readFile(this.path(entry), { signal }), entry);
      return;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof EnhanceError && error.code === "MODULE_INTEGRITY")
      )
        throw error;
    }
    let bytes: Uint8Array | undefined;
    if (this.bundledDirectory) {
      try {
        bytes = await readFile(join(this.bundledDirectory, entry.file), { signal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!bytes) {
      if (!/^[a-f0-9]{40}$/.test(this.catalog.revision))
        throw new EnhanceError(
          "MODULE_SOURCE",
          "This development catalog has no immutable download revision. Build locally first.",
        );
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
      const url = `https://raw.githubusercontent.com/${this.catalog.repository}/${this.catalog.revision}/dist/modules/${entry.file}`;
      const response = await this.fetchImpl(url, { redirect: "error", signal: requestSignal });
      if (!response.ok || !response.body)
        throw new EnhanceError("MODULE_DOWNLOAD", `Module download returned HTTP ${response.status}.`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        requestSignal.throwIfAborted();
        size += chunk.byteLength;
        if (size > entry.bytes)
          throw new EnhanceError("MODULE_INTEGRITY", "Downloaded module exceeds its declared size.");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    this.verify(bytes, entry);
    signal?.throwIfAborted();
    await mkdir(join(this.home, "packages"), { recursive: true, mode: 0o700 });
    const target = this.path(entry),
      temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { mode: 0o600, flag: "wx", signal });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async commit(entries: CatalogEntry[], before: Lock, signal?: AbortSignal): Promise<void> {
    if (!entries.length) return;
    for (const entry of entries) await this.stage(entry, signal);
    signal?.throwIfAborted();
    // One atomic lock-file commit for the entire batch. Detect competing installs/uninstalls,
    // while preserving changes to unrelated modules made during downloads.
    updateJson<Lock>(this.lockPath, emptyLock, (raw) => {
      const current = validateLock(raw);
      for (const entry of entries)
        if (!sameInstallation(current.modules[entry.id], before.modules[entry.id]))
          throw new EnhanceError(
            "MODULE_CONFLICT",
            `Installation changed during download: ${entry.id}. Retry explicitly.`,
          );
      const modules = { ...current.modules };
      for (const entry of entries)
        modules[entry.id] = { version: entry.version, sha256: entry.sha256, file: entry.file };
      return { version: 1, modules };
    });
  }
  async install(id: string, signal?: AbortSignal): Promise<void> {
    await this.commit([this.find(id)], this.readLock(), signal);
  }
  /** Updates installed modules only; loaded instances remain untouched until a later load. */
  async update(ids?: string[], signal?: AbortSignal): Promise<string[]> {
    const before = this.readLock();
    const entries = [
      ...new Set(ids ?? this.catalog.modules.filter((e) => before.modules[e.id]).map((e) => e.id)),
    ]
      .map((id) => {
        const entry = this.find(id);
        if (!before.modules[id])
          throw new EnhanceError("MODULE_NOT_INSTALLED", `Install ${id} explicitly before updating.`);
        return entry;
      })
      .filter((entry) => before.modules[entry.id]!.sha256 !== entry.sha256);
    await this.commit(entries, before, signal);
    return entries.map((e) => e.id);
  }
  async load(id: string): Promise<CapabilityModule> {
    const entry = this.find(id),
      installed = this.installed(id);
    if (!installed)
      throw new EnhanceError("MODULE_NOT_INSTALLED", `Install ${id} explicitly before loading.`);
    if (installed.sha256 !== entry.sha256)
      throw new EnhanceError("MODULE_VERSION", `Update or reinstall ${id} to match this host catalog.`);
    this.verify(await readFile(this.path(entry)), entry);
    const loaded = (await import(pathToFileURL(this.path(entry)).href)).default as CapabilityModule;
    if (
      JSON.stringify(loaded?.manifest) !==
      JSON.stringify(
        Object.fromEntries(
          Object.entries(entry).filter(([key]) => !["file", "sha256", "bytes"].includes(key)),
        ),
      )
    )
      throw new EnhanceError("MODULE_CONTRACT", "Downloaded manifest does not match catalog.");
    return loaded;
  }
  uninstall(id: string): void {
    this.find(id);
    // Other processes may still use cached files. Never remove user artifacts.
    updateJson<Lock>(this.lockPath, emptyLock, (raw) => {
      const modules = { ...validateLock(raw).modules };
      delete modules[id];
      return { version: 1, modules };
    });
  }
}
