import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ImageArtifactStore,
  decodeImage,
  resolveImage,
} from "../../../../packages/capabilities/gen_image/openai/src/artifacts.ts";
import { png } from "../../../fixtures/openai/fixtures.ts";

test("image file validation and exclusive path/URL references", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-image-test-"));
  try {
    await writeFile(join(root, "source.png"), png());
    const source = await resolveImage({ path: "@source.png" }, root);
    assert.equal(source.info?.width, 16);
    const data = await resolveImage({ image_url: `data:image/png;base64,${png().toString("base64")}` }, root);
    assert.deepEqual(data.bytes, source.bytes);
    await assert.rejects(resolveImage({ file_id: "removed" } as never, root), /only support/);
    await assert.rejects(
      resolveImage({ path: "source.png", image_url: "https://example.com/x" }, root),
      /exactly one/,
    );
    await assert.rejects(resolveImage({ image_url: "file:///etc/passwd" }, root));
    await assert.rejects(resolveImage({ path: "." }, root), /regular/);
    await assert.rejects(
      resolveImage({ image_url: `data:image/jpeg;base64,${png().toString("base64")}` }, root),
      /MIME/,
    );
    assert.throws(() => decodeImage(Buffer.from("not an image").toString("base64")), /supported/);
    assert.throws(() => decodeImage("invalid%%%"), /base64/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifacts use exclusive private files and never overwrite originals", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-artifact-test-"));
  try {
    const store = new ImageArtifactStore(root);
    const first = await store.saveImages("session", [{ b64_json: png().toString("base64") }]);
    const second = await store.saveImages("session", [{ b64_json: png().toString("base64") }]);
    assert.notEqual(first[0]?.path, second[0]?.path);
    assert.equal((await stat(first[0]!.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(first[0]!.path), png());
    await symlink(root, join(root, "bad-session"));
    await assert.rejects(
      store.saveImages("bad-session", [{ b64_json: png().toString("base64") }]),
      /symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
