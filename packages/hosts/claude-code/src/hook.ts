import { hostPid, send, sessionSockets, writeSession } from "./control.ts";

async function stdinJson(): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/**
 * Claude Code hooks bridged to the running cc-enhance servers of the same session:
 * - `prompt` (UserPromptSubmit): record session id / transcript / cwd; print recovery notices as context.
 * - `stop` (Stop): the main agent finished its turn, i.e. the task settled.
 * Hooks never fail the turn; errors are swallowed.
 */
export async function hook(event: string | undefined): Promise<void> {
  const input = await stdinJson();
  const session = sessionSockets();
  const pid = session?.pid ?? hostPid();
  await writeSession(pid, {
    sessionId: str(input.session_id),
    transcriptPath: str(input.transcript_path),
    cwd: str(input.cwd),
  }).catch(() => {});
  if (!session) return;
  const sockets = Object.values(session.sockets);
  if (event === "stop") {
    await Promise.allSettled(sockets.map((path) => send(path, { op: "settled" }, 15_000)));
  } else if (event === "prompt") {
    const replies = await Promise.allSettled(sockets.map((path) => send(path, { op: "notice" }, 3000)));
    const notices = replies.flatMap((r) =>
      r.status === "fulfilled" && Array.isArray(r.value) ? r.value : [],
    );
    if (notices.length) process.stdout.write(`[cc-enhance]\n${notices.join("\n")}\n`);
  }
}
