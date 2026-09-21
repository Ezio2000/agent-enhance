import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleManager, type Catalog } from "../packages/core/src/modules.ts";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";

function release(version: string) {
  const files = new Map<string, string>();
  const catalog: Catalog = {
    version: 1,
    revision: "a".repeat(40),
    repository: "Ezio2000/agent-enhance",
    modules: [],
  };
  for (const capability of ["fast", "verbosity", "image_detail"]) {
    const manifest = {
      apiVersion: 1 as const,
      id: `${capability}/openai`,
      capability,
      provider: "openai" as const,
      kind: "request-control" as const,
      version,
    };
    const source = `export default {manifest: ${JSON.stringify(manifest)}, create() { return { status() { return '${version}'; } }; }};`;
    const file = `${capability}--openai.mjs`;
    files.set(file, source);
    catalog.modules.push({
      ...manifest,
      file,
      sha256: createHash("sha256").update(source).digest("hex"),
      bytes: Buffer.byteLength(source),
    });
  }
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const file = String(url).split("/").at(-1)!;
    requests.push(file);
    return new Response(files.get(file), { status: files.has(file) ? 200 : 404 });
  };
  return { catalog, files, requests, fetchImpl };
}
async function temporary(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "enhance-update-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("update installs only selected existing modules, commits once, and never replaces loaded instances", () =>
  temporary(async (home) => {
    const old = release("1"),
      next = release("2");
    const a = new ModuleManager(home, old.catalog, undefined, old.fetchImpl);
    await a.install("fast/openai");
    await a.install("verbosity/openai");
    const registry = new CapabilityRegistry();
    registry.load(await a.load("fast/openai"), { artifactRoot: home });
    const b = new ModuleManager(home, next.catalog, undefined, next.fetchImpl);
    assert.deepEqual(
      b.updates().map((e) => e.id),
      ["fast/openai", "verbosity/openai"],
    );
    assert.equal(next.requests.length, 0);
    await assert.rejects(b.load("fast/openai"), /MODULE_VERSION/);
    assert.equal(next.requests.length, 0, "load never downloads");
    assert.deepEqual(await b.update(["fast/openai"]), ["fast/openai"]);
    assert.equal(b.installed("verbosity/openai")!.version, "1");
    assert.deepEqual(await b.update(), ["verbosity/openai"]);
    assert.deepEqual(next.requests, ["fast--openai.mjs", "verbosity--openai.mjs"]);
    assert.equal(b.installed("image_detail/openai"), undefined);
    assert.equal((await readdir(join(home, "packages"))).length, 4, "old cached versions retained");
    assert.equal(registry.get("fast/openai")!.instance.status!(), "1");
    await registry.unload("fast/openai");
    registry.load(await b.load("fast/openai"), { artifactRoot: home });
    assert.equal(registry.get("fast/openai")!.instance.status!(), "2");
    assert.deepEqual(await b.update(), []);
    await b.install("fast/openai");
    assert.equal(next.requests.length, 2, "verified cache is reused for repeated installs");
    await assert.rejects(b.update(["image_detail/openai"]), /NOT_INSTALLED/);
    assert.equal(next.requests.length, 2);
    await registry.dispose();
  }));

test("failed batch download preserves every previous installation and can be explicitly retried", () =>
  temporary(async (home) => {
    const old = release("1"),
      next = release("2");
    const a = new ModuleManager(home, old.catalog, undefined, old.fetchImpl);
    await a.install("fast/openai");
    await a.install("verbosity/openai");
    const before = await readFile(a.lockPath, "utf8");
    let broken = true;
    const b = new ModuleManager(home, next.catalog, undefined, async (url, init) => {
      if (broken && String(url).includes("verbosity--")) return new Response("bad");
      return next.fetchImpl(url, init);
    });
    await assert.rejects(b.update(), /INTEGRITY/);
    assert.equal(await readFile(a.lockPath, "utf8"), before);
    assert.equal((await a.load("fast/openai")).manifest.version, "1");
    broken = false;
    assert.deepEqual(await b.update(), ["fast/openai", "verbosity/openai"]);
    assert.equal(
      next.requests.filter((file) => file.startsWith("fast")).length,
      1,
      "staged verified bytes reused",
    );
  }));

test("cancellation and locked installation records never commit an update", () =>
  temporary(async (home) => {
    const old = release("1"),
      next = release("2");
    const a = new ModuleManager(home, old.catalog, undefined, old.fetchImpl);
    await a.install("fast/openai");
    const before = await readFile(a.lockPath, "utf8");
    const abort = new AbortController();
    const b = new ModuleManager(home, next.catalog, undefined, async (url, init) => {
      abort.abort();
      return next.fetchImpl(url, init);
    });
    await assert.rejects(b.update(undefined, abort.signal), /abort/i);
    assert.equal(await readFile(a.lockPath, "utf8"), before);
    const c = new ModuleManager(home, next.catalog, undefined, next.fetchImpl);
    await writeFile(`${c.lockPath}.lock`, "");
    await assert.rejects(c.update(), /CONFIG_LOCKED/);
    assert.equal(await readFile(a.lockPath, "utf8"), before);
    await rm(`${c.lockPath}.lock`);
    await c.update();
    assert.equal(c.installed("fast/openai")!.version, "2");
  }));

test("concurrent uninstall is not resurrected by an in-flight update", () =>
  temporary(async (home) => {
    const old = release("1"),
      next = release("2");
    const a = new ModuleManager(home, old.catalog, undefined, old.fetchImpl);
    await a.install("fast/openai");
    const b = new ModuleManager(home, next.catalog, undefined, async (url, init) => {
      a.uninstall("fast/openai");
      return next.fetchImpl(url, init);
    });
    await assert.rejects(b.update(), /MODULE_CONFLICT/);
    assert.equal(b.installed("fast/openai"), undefined);
  }));

test("concurrent changes to unrelated installations survive an update", () =>
  temporary(async (home) => {
    const old = release("1"),
      next = release("2");
    const a = new ModuleManager(home, old.catalog, undefined, old.fetchImpl);
    await a.install("fast/openai");
    const b = new ModuleManager(home, next.catalog, undefined, async (url, init) => {
      await a.install("image_detail/openai");
      return next.fetchImpl(url, init);
    });
    await b.update();
    assert.equal(b.installed("fast/openai")!.version, "2");
    assert.equal(b.installed("image_detail/openai")!.version, "1");
  }));

test("invalid catalog metadata and malformed locks fail closed without network or overwrites", () =>
  temporary(async (home) => {
    const r = release("1");
    for (const patch of [
      { bytes: -1 },
      { bytes: 0 },
      { bytes: 1.5 },
      { file: "../escape.mjs" },
      { id: "fast/xai" },
    ]) {
      const catalog = structuredClone(r.catalog);
      Object.assign(catalog.modules[0]!, patch);
      assert.throws(() => new ModuleManager(home, catalog), /CATALOG_INVALID/);
    }
    const duplicate = structuredClone(r.catalog);
    duplicate.modules.push(duplicate.modules[0]!);
    assert.throws(() => new ModuleManager(home, duplicate), /CATALOG_INVALID/);
    const m = new ModuleManager(home, r.catalog, undefined, r.fetchImpl);
    const invalid = JSON.stringify({
      version: 1,
      modules: { "fast/openai": { version: "1", sha256: "bad", file: "fast--openai.mjs" } },
    });
    await writeFile(m.lockPath, invalid);
    await assert.rejects(m.install("fast/openai"), /LOCK_INVALID/);
    assert.throws(() => m.uninstall("fast/openai"), /LOCK_INVALID/);
    assert.throws(() => m.updates(), /LOCK_INVALID/);
    assert.equal(await readFile(m.lockPath, "utf8"), invalid);
    assert.equal(r.requests.length, 0);
  }));
