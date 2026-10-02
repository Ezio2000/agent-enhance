// Explicit live-only end-to-end probe for one pi-enhance tool inside an SDK child session.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import module from "../packages/capabilities/search_web/zai/src/index.ts";
import { PiCredentialResolver } from "../packages/hosts/pi/src/auth.ts";
import { runSubagent } from "../packages/hosts/pi/src/subagents/runner.ts";

if (!process.argv.includes("--live")) {
  console.log("Run: npx tsx scripts/smoke-subagent-search.ts --live (uses GLM + Z.ai search quota)");
  process.exit(0);
}
const home = await mkdtemp(join(tmpdir(), "enhance-subagent-search-"));
try {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const registry = new CapabilityRegistry();
  registry.load(
    module,
    { artifactRoot: join(home, "artifacts") },
    {
      id: "pi:zai",
      label: "Pi ZAI",
      credentials: new PiCredentialResolver(new ModelRegistry(runtime), "zai"),
    },
  );
  const model = (await runtime.getAvailable()).find((m) => m.provider === "zai" && m.id === "glm-5.3-flash");
  if (!model) throw new Error("zai/glm-5.3-flash is not available in Pi.");
  const result = await runSubagent(
    {
      context:
        "必须先调用 search_web 搜索 'Node.js official documentation'，然后用一句中文概括搜索到的官方文档是什么，并附来源链接。",
      tools: ["search_web"],
      max_turns: 3,
      timeout_seconds: 120,
    },
    0,
    model,
    "off",
    registry,
    new ModelRegistry(runtime),
    AbortSignal.timeout(130_000),
  );
  console.log(result);
  if (result.status !== "completed" || !/nodejs\.org|Node\.js/i.test(result.text)) process.exitCode = 1;
} finally {
  await rm(home, { recursive: true, force: true });
}
