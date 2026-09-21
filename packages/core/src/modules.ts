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
interface Installed {
  version: string;
  sha256: string;
  file: string;
}
interface Lock {
  version: 1;
  modules: Record<string, Installed>;
}
const emptyLock = (): Lock => ({ version: 1, modules: {} });
export class ModuleManager {
  readonly lockPath: string;
  constructor(
    readonly home: string,
    readonly catalog: Catalog,
    private readonly bundledDirectory?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.lockPath = join(home, "modules.lock.json");
    if (catalog.version !== 1 || catalog.repository !== "Ezio2000/agent-enhance")
      throw new EnhanceError("CATALOG_INVALID", "Untrusted module catalog.");
    for (const entry of catalog.modules)
      if (
        !/^[a-z_]+\/[a-z]+$/.test(entry.id) ||
        !/^[a-z_]+--[a-z]+\.mjs$/.test(entry.file) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        entry.bytes > 25 * 1024 * 1024
      )
        throw new EnhanceError("CATALOG_INVALID", "Invalid module entry.");
  }
  find(id: string): CatalogEntry {
    const entry = this.catalog.modules.find((e) => e.id === id);
    if (!entry) throw new EnhanceError("MODULE_UNKNOWN", `Unknown capability/provider: ${id}`);
    return entry;
  }
  installed(id: string): Installed | undefined {
    const lock = readJson(this.lockPath, emptyLock);
    if (lock.version !== 1 || !lock.modules)
      throw new EnhanceError("LOCK_INVALID", "Invalid module lock; not overwritten.");
    return lock.modules[id];
  }
  private path(entry: CatalogEntry): string {
    return join(this.home, "packages", `${entry.sha256}-${entry.file}`);
  }
  private verify(bytes: Uint8Array, entry: CatalogEntry): void {
    if (bytes.byteLength !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new EnhanceError("MODULE_INTEGRITY", `Integrity verification failed: ${entry.id}`);
  }
  async install(id: string, signal?: AbortSignal): Promise<void> {
    const entry = this.find(id);
    signal?.throwIfAborted();
    let bytes: Uint8Array | undefined;
    if (this.bundledDirectory) {
      try {
        bytes = await readFile(join(this.bundledDirectory, entry.file), { signal });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
    updateJson<Lock>(this.lockPath, emptyLock, (lock) => ({
      version: 1,
      modules: { ...lock.modules, [id]: { version: entry.version, sha256: entry.sha256, file: entry.file } },
    }));
  }
  async load(id: string): Promise<CapabilityModule> {
    const entry = this.find(id),
      installed = this.installed(id);
    if (!installed)
      throw new EnhanceError("MODULE_NOT_INSTALLED", `Install ${id} explicitly before loading.`);
    if (installed.sha256 !== entry.sha256)
      throw new EnhanceError("MODULE_VERSION", `Reinstall ${id} to match this host version.`);
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
    // Keep content-addressed files: another process may still be using them. No user artifacts are deleted.
    updateJson<Lock>(this.lockPath, emptyLock, (lock) => {
      const modules = { ...lock.modules };
      delete modules[id];
      return { version: 1, modules };
    });
  }
}
