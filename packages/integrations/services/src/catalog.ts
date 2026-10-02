import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CapabilityModule, ModuleManifest } from "../../../core/src/contracts.ts";
import { MODULE_API_VERSION } from "../../../core/src/module.ts";
export const CATALOG_VERSION = 2;
export interface CatalogEntry extends ModuleManifest {
  file: string;
  bytes: number;
  label: string;
  group: string;
}
export interface Catalog {
  version: typeof CATALOG_VERSION;
  release: string;
  modules: CatalogEntry[];
}
/** Modules belong to the same release as their host. No installation registry or download state. */
export class ModuleCatalog {
  constructor(
    readonly catalog: Catalog,
    readonly directory: string,
  ) {
    if (catalog.version !== CATALOG_VERSION || !Array.isArray(catalog.modules))
      throw new Error("Invalid module catalog.");
    const ids = new Set<string>();
    for (const entry of catalog.modules) {
      if (
        entry.apiVersion !== MODULE_API_VERSION ||
        !/^[a-z][a-z0-9_]*\/[a-z][a-z0-9-]*$/.test(entry.id) ||
        entry.id !== `${entry.capability}/${entry.provider}` ||
        entry.file !== `${entry.capability}--${entry.provider}.mjs` ||
        ids.has(entry.id)
      )
        throw new Error("Invalid module catalog entry.");
      ids.add(entry.id);
    }
  }
  find(id: string): CatalogEntry {
    const entry = this.catalog.modules.find((e) => e.id === id);
    if (!entry) throw new Error(`Unknown capability/provider: ${id}`);
    return entry;
  }
  async load(id: string): Promise<CapabilityModule> {
    const entry = this.find(id);
    const module = (await import(pathToFileURL(join(this.directory, entry.file)).href))
      .default as CapabilityModule;
    const { file: _file, bytes: _bytes, label: _label, group: _group, ...manifest } = entry;
    if (
      JSON.stringify(module.manifest) !== JSON.stringify(manifest) ||
      module.definition.id !== entry.capability
    )
      throw new Error(`Module contract does not match this release: ${id}`);
    return module;
  }
}
export async function readCatalog(directory: string): Promise<Catalog> {
  return JSON.parse(await readFile(join(directory, "catalog.json"), "utf8")) as Catalog;
}
