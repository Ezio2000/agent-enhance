import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const packagePath = join(root, "packages/capabilities/use_computer/native/runtime");
export async function nativeSourceHash(): Promise<string> {
  const files = ["Package.swift"];
  async function walk(directory: string) {
    for (const item of (await readdir(join(packagePath, directory), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = join(directory, item.name);
      if (item.isDirectory()) await walk(name);
      else if (name.endsWith(".swift")) files.push(name);
    }
  }
  await walk("Sources");
  const hash = createHash("sha256");
  for (const name of files.sort())
    hash
      .update(name)
      .update("\0")
      .update(await readFile(join(packagePath, name)))
      .update("\0");
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex");
}
export async function buildComputerNative(): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("Build the native payload on macOS; normal module builds reuse the committed payload.");
  const temp = await mkdtemp(join(tmpdir(), "enhance-native-build-"));
  try {
    const binaries: string[] = [];
    for (const arch of ["arm64", "x86_64"]) {
      const scratch = join(temp, arch);
      const flags = [
        "--package-path",
        packagePath,
        "--scratch-path",
        scratch,
        "-c",
        "release",
        "--arch",
        arch,
      ];
      console.log(`Building ComputerRuntime ${arch}…`);
      await exec("swift", ["build", ...flags], { timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
      const { stdout } = await exec("swift", ["build", ...flags, "--show-bin-path"]);
      binaries.push(join(stdout.trim(), "ComputerRuntime"));
    }
    const app = join(temp, "Agent Enhance Computer.app");
    await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
    const binary = join(app, "Contents", "MacOS", "ComputerRuntime");
    await exec("lipo", ["-create", ...binaries, "-output", binary]);
    await chmod(binary, 0o755);
    await writeFile(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.agent-enhance.computer</string>
<key>CFBundleName</key><string>Agent Enhance Computer</string>
<key>CFBundleExecutable</key><string>ComputerRuntime</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>0.4.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`,
    );
    await exec("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
    await exec("codesign", ["--verify", "--strict", app]);
    const files: { path: string; mode: number; data: string }[] = [];
    async function pack(directory: string) {
      for (const item of (await readdir(join(temp, directory), { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await pack(path);
        else
          files.push({
            path,
            mode: path.endsWith("/MacOS/ComputerRuntime") ? 0o755 : 0o644,
            data: (await readFile(join(temp, path))).toString("base64"),
          });
      }
    }
    await pack("Agent Enhance Computer.app");
    const payload = gzipSync(Buffer.from(JSON.stringify({ sourceHash: await nativeSourceHash(), files })), {
      level: 9,
    });
    await mkdir(join(root, "dist/native"), { recursive: true });
    await writeFile(join(root, "dist/native/computer-runtime.json.gz"), payload);
    console.log(`Universal signed native payload: ${payload.length} bytes.`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildComputerNative();
