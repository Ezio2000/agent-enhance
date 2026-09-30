import { join } from "node:path";
import type { CapabilityModule, ModuleServices, ModuleInstance } from "../../../../core/src/contracts.ts";
import { enhanceHome } from "../../../../core/src/config.ts";
import { manifest } from "./manifest.ts";
import { ComputerSession } from "./session.ts";
import { ComputerOutput } from "./output.ts";
import { computerTool } from "./tool.ts";
export function createComputer(
  services: ModuleServices,
  session = new ComputerSession(services.runtimeRoot ?? join(enhanceHome(), "runtimes")),
): ModuleInstance {
  return {
    tool: computerTool(session, new ComputerOutput(services.artifactRoot)),
    notice: () => session.recoveryNotice(),
    status: () => session.status(),
    async lifecycle(event, isIdle) {
      if (event === "task_settled") await session.endTurn(isIdle);
      else await session.reset(event);
    },
    async manage(action) {
      if (action === "reset") await session.reset(action);
      else if (action !== "status") throw new Error("Choose status / reset.");
      return JSON.stringify(session.status(), null, 2);
    },
    async dispose() {
      await session.reset("unload");
    },
  };
}
export default { manifest, create: createComputer } satisfies CapabilityModule;
