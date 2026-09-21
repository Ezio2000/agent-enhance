import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

if (!process.argv.includes("--live")) {
  console.log(
    "Explicit live test: npm run smoke -- --live [--images] [--video] [--computer]. Uses the INSTALLED Pi extension and existing credentials. Uploads synthetic fixtures; may consume quota. No requests made.",
  );
  process.exit(0);
}
const root = resolve("artifacts/smoke", new Date().toISOString().replaceAll(":", "-"));
await mkdir(root, { recursive: true, mode: 0o700 });
const results: Record<string, unknown>[] = [];
function pdf(): Buffer {
  const text = "BT /F1 18 Tf 50 740 Td (Agent Enhance test. Verification code: BLUE-42.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
const settingsManager = SettingsManager.create(root, getAgentDir());
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir: getAgentDir(),
  settingsManager,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
const { session } = await createAgentSession({
  cwd: root,
  resourceLoader: loader,
  settingsManager,
  modelRuntime,
  sessionManager: SessionManager.inMemory(root),
});
await session.bindExtensions({
  mode: "print",
  onError: (error) => {
    console.error("Extension error:", error.error);
  },
});
let failed = false;
async function call(name: string, args: Record<string, unknown>, key = name): Promise<any> {
  const tool = session.agent.state.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Installed tool missing: ${name}`);
  const started = Date.now();
  try {
    const result = await tool.execute(randomUUID(), args, AbortSignal.timeout(360_000));
    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (!text.trim()) throw new Error("Empty tool result");
    const details = result.details as Record<string, any>;
    if (details?.status === "error") throw new Error("Tool returned an error status");
    const paths = [
      ...(details?.images ?? []).map((image: any) => (typeof image === "string" ? image : image.path)),
      ...(details?.video?.path ? [details.video.path] : []),
    ];
    for (const path of paths) if (!(await stat(path)).size) throw new Error("Empty artifact");
    results.push({
      key,
      status: "passed",
      elapsedMs: Date.now() - started,
      provider: details?.provider,
      chars: text.length,
      paths,
    });
    console.log(`${key}: PASS (${Date.now() - started}ms)`, paths);
    return { text, details };
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : "Unknown failure";
    results.push({ key, status: "failed", elapsedMs: Date.now() - started, error: message });
    console.error(`${key}: FAIL: ${message}`);
  } finally {
    await writeFile(join(root, "report.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  }
}
try {
  const names = session.getActiveToolNames();
  console.log("Installed tools:", names.join(", "));
  if (names.some((n) => /^(codex_|grok_|muse_)/.test(n))) throw new Error("Legacy tool still active");
  if (names.filter((n) => n === "gen_image").length !== 1) throw new Error("Expected one merged image tool");
  await call("search_web", {
    provider: "openai",
    search_query: [
      { q: "OpenAI official image generation documentation", domains: ["developers.openai.com"] },
    ],
    include_context: false,
    max_output_tokens: 800,
  });
  const pdfPath = join(root, "fixture.pdf");
  await writeFile(pdfPath, pdf(), { mode: 0o600 });
  const viewed = await call("view_pdf", {
    provider: "opencode",
    path: pdfPath,
    prompt: "Return only the verification code printed in this PDF.",
    max_output_tokens: 128,
  });
  if (viewed && !viewed.text.includes("BLUE-42")) {
    failed = true;
    results.push({ key: "view_pdf/content", status: "failed", error: "Verification code absent" });
  }
  await promisify(execFile)("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=512x512:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(root, "fixture.mp4"),
  ]);
  await call("view_video", {
    provider: "opencode",
    path: join(root, "fixture.mp4"),
    prompt: "What is the dominant color in this synthetic video? Answer in one word.",
    max_output_tokens: 128,
  });
  if (process.argv.includes("--images"))
    await Promise.all([
      call(
        "gen_image",
        {
          provider: "openai",
          prompt: "A single solid blue circle centered on a plain white background. No text.",
          options: { openai: { size: "1024x1024", quality: "low" } },
        },
        "gen_image/openai",
      ),
      call(
        "gen_image",
        {
          provider: "xai",
          prompt: "A single solid blue circle centered on a plain white background. No text.",
          options: { xai: { aspect_ratio: "1:1", resolution: "1k", quality: "low" } },
        },
        "gen_image/xai",
      ),
    ]);
  if (process.argv.includes("--video")) {
    const reference = join(root, "reference.png");
    await promisify(execFile)("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=512x512",
      "-frames:v",
      "1",
      reference,
    ]);
    await call("gen_video", {
      provider: "xai",
      image: { path: reference },
      prompt: "Keep the blue field still, no movement, no text.",
      duration: 6,
      resolution: "480p",
    });
  }
  if (process.argv.includes("--computer")) {
    await call("use_computer", {
      provider: "openai",
      code: "await cua.getState()",
      title: "Read-only installation smoke test",
      timeout_seconds: 60,
    });
    await session.extensionRunner.emit({ type: "agent_settled" });
    await session.prompt("/pi-enhance openai use_computer status");
    const last = session.messages.at(-1) as any;
    const status = JSON.parse(last.content);
    const cleanup = status.lastCleanup;
    if (status.connected || !cleanup?.shutdown?.processGroupStopped) {
      failed = true;
      results.push({ key: "use_computer/cleanup", status: "failed", details: status });
    } else results.push({ key: "use_computer/cleanup", status: "passed", details: status });
  }
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  await writeFile(join(root, "report.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(`Report: ${join(root, "report.json")}`);
}
if (failed) process.exitCode = 1;
