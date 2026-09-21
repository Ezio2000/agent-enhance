import { createInterface } from "node:readline";
let counter = 0,
  cleanupError = false;
const approvals = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method && approvals.has(m.id)) {
    const pending = approvals.get(m.id);
    approvals.delete(m.id);
    if (!pending.hang)
      send({
        id: pending.id,
        result: {
          isError: m.result?.action !== "accept",
          content: [{ type: "text", text: m.result?.action === "accept" ? "approved" : "approval denied" }],
        },
      });
    return;
  }
  if (m.id === undefined || !m.method) return;
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: "2024-11-05" } });
  if (m.method === "tools/list")
    return send({ id: m.id, result: { tools: [{ name: "js" }, { name: "turn_ended" }] } });
  if (m.method === "tools/call") {
    if (m.params.name === "turn_ended")
      return send({
        id: m.id,
        result: {
          isError: cleanupError,
          content: [{ type: "text", text: cleanupError ? "cleanup failed" : "cleaned" }],
        },
      });
    const code = m.params.arguments.code;
    if (code === "cleanup-error") cleanupError = true;
    if (code === "approve" || code === "approve-hang") {
      const id = "approval-" + m.id;
      approvals.set(id, { id: m.id, hang: code === "approve-hang" });
      return send({
        id,
        method: "elicitation/create",
        params: {
          mode: "form",
          message: "Allow Safari?",
          requestedSchema: { type: "object", properties: {} },
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            connector_id: "computer-use",
            tool_name: "get_app_state",
            tool_params: { app: "com.apple.Safari" },
            persist: ["session"],
            riskLevel: "high",
          },
        },
      });
    }
    if (code === "stubborn") {
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    }
    if (code === "hang") return;
    if (code === "crash") return process.exit(2);
    if (code === "malformed") return process.stdout.write("not-json\n");
    if (code === "error")
      return send({
        id: m.id,
        result: { isError: true, content: [{ type: "text", text: "partial failure" }] },
      });
    const current = ++counter;
    setTimeout(
      () =>
        send({
          id: m.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ counter: current, meta: m.params._meta }) }],
          },
        }),
      code === "slow" ? 50 : 0,
    );
  }
});
