import type { CapabilityModule, ModuleServices, ModuleInstance } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { ComputerSession } from "./session.ts";
import { ComputerOutput } from "./output.ts";
import { computerTool } from "./tool.ts";
export function createComputer(services: ModuleServices, session = new ComputerSession()): ModuleInstance {
  return {
    tool: computerTool(session, new ComputerOutput(services.artifactRoot)),
    notice: () => session.recoveryNotice(),
    status: () => session.status(),
    async lifecycle(event, isIdle) {
      if (event === "task_settled") await session.endTurn(isIdle ?? (() => true));
      else await session.reset(event);
    },
    async manage(action) {
      if (action === "ask" || action === "revoke") await session.setApprovalMode("ask", action);
      else if (action === "auto") await session.setApprovalMode("auto-app", action);
      else if (action === "reset") await session.reset(action);
      else if (action !== "status") throw new Error("Choose status / reset / revoke / ask / auto.");
      return JSON.stringify(session.status(), null, 2);
    },
    async dispose() {
      await session.reset("unload");
    },
  };
}
export default { manifest, create: createComputer } satisfies CapabilityModule;
