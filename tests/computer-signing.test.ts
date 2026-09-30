import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computerRequirement,
  computerCertificateSha1,
  loadComputerSigning,
  setupComputerSigning,
} from "../scripts/computer-signing.ts";

test("computer identity binds the certificate, independently of binary hashes", () => {
  const certificate = "0123456789ABCDEF0123456789ABCDEF01234567";
  assert.equal(
    computerRequirement(certificate),
    'identifier "com.agent-enhance.computer" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"',
  );
  assert.throws(() => computerRequirement('invalid" or true'), /Invalid/);
});

test("missing or damaged signing state never creates a replacement identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ae-signing-test-"));
  const previous = process.env.AE_COMPUTER_SIGNING_DIR;
  process.env.AE_COMPUTER_SIGNING_DIR = directory;
  try {
    await assert.rejects(loadComputerSigning(), /original signing backup/);
    assert.deepEqual(await readdir(directory), []);
    await writeFile(
      join(directory, "identity.json"),
      JSON.stringify({ version: 1, certificateSha1: "0".repeat(40) }),
    );
    await assert.rejects(loadComputerSigning(), /No ad-hoc fallback/);
    if (process.platform === "darwin") await assert.rejects(setupComputerSigning(), /No ad-hoc fallback/);
    assert.deepEqual(await readdir(directory), ["identity.json"]);
    await writeFile(
      join(directory, "identity.json"),
      JSON.stringify({ version: 1, certificateSha1: computerCertificateSha1 }),
    );
    await assert.rejects(loadComputerSigning(), /original signing backup/);
    assert.deepEqual(await readdir(directory), ["identity.json"]);
  } finally {
    if (previous === undefined) delete process.env.AE_COMPUTER_SIGNING_DIR;
    else process.env.AE_COMPUTER_SIGNING_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
