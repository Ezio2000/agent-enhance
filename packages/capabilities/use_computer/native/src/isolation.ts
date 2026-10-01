export type ComputerIsolation = "isolated-only" | "shared";
export function computerIsolation(): ComputerIsolation {
  const value = process.env.AGENT_ENHANCE_COMPUTER_ISOLATION ?? "isolated-only";
  if (value !== "isolated-only" && value !== "shared")
    throw new Error("AGENT_ENHANCE_COMPUTER_ISOLATION must be isolated-only or shared.");
  return value;
}
export function checkIsolation(policy: ComputerIsolation, method: string, params: Record<string, any>): void {
  if (
    policy === "isolated-only" &&
    (params.mode === "foreground" ||
      method === "activate" ||
      (["launchApp", "restartApp"].includes(method) && params.foreground === true))
  ) {
    throw Object.assign(
      new Error("This session is isolated-only. Shared foreground input is disabled by the host."),
      {
        code: "ISOLATION_REQUIRED",
        details: {
          isolation: policy,
          dispatched: false,
          delivery: "blocked",
          target: { app: params.app, window: params.window },
        },
      },
    );
  }
}
