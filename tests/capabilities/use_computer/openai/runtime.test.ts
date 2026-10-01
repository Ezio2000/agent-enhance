import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  privateSocketPath,
  serviceExecutable,
} from "../../../../packages/capabilities/use_computer/openai/src/runtime.ts";

test("service executable resolves from CODEX_HOME and SKY_CUA_SERVICE_PATH", () => {
  const previous = process.env.SKY_CUA_SERVICE_PATH;
  try {
    delete process.env.SKY_CUA_SERVICE_PATH;
    assert.equal(
      serviceExecutable("/tmp/codex-home"),
      join(
        "/tmp/codex-home",
        "computer-use",
        "Codex Computer Use.app",
        "Contents",
        "MacOS",
        "SkyComputerUseService",
      ),
    );
    process.env.SKY_CUA_SERVICE_PATH = "/tmp/Custom.app";
    assert.equal(
      serviceExecutable("/tmp/codex-home"),
      join("/tmp/Custom.app", "Contents", "MacOS", "SkyComputerUseService"),
    );
    process.env.SKY_CUA_SERVICE_PATH = "/tmp/SkyComputerUseService";
    assert.equal(serviceExecutable("/tmp/codex-home"), "/tmp/SkyComputerUseService");
    process.env.SKY_CUA_SERVICE_PATH = "relative/path";
    assert.throws(() => serviceExecutable("/tmp/codex-home"), /absolute/);
  } finally {
    if (previous === undefined) delete process.env.SKY_CUA_SERVICE_PATH;
    else process.env.SKY_CUA_SERVICE_PATH = previous;
  }
});

test("private socket is unique, in the app group container, and under the sun_path limit", () => {
  const base = join(homedir(), "Library", "Group Containers", "2DC432GLL2.com.openai.sky.CUAService", "IPC");
  const first = privateSocketPath();
  const second = privateSocketPath();
  assert.equal(join(first, ".."), base);
  assert.match(first, /ae-[0-9a-f]{8}\.sock$/);
  assert.notEqual(first, second);
  assert.ok(Buffer.byteLength(first) <= 103, `socket path exceeds macOS sun_path limit: ${first}`);
});
