import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
// A nonempty PKCS#12 password is required by macOS's importer. This is a local backup format, not a secret.
const backupPassword = "agent-enhance-local-signing";
export const computerIdentifier = "com.agent-enhance.computer";
export const computerCertificateSha1 = "355b5123185084167f8e316011222470fc581ab9";
const signingDirectory = () =>
  resolve(process.env.AE_COMPUTER_SIGNING_DIR ?? join(homedir(), ".agent-enhance/signing/computer"));
type Identity = { version: 1; certificateSha1: string };

export function computerRequirement(certificateSha1: string): string {
  if (!/^[a-fA-F0-9]{40}$/.test(certificateSha1)) throw new Error("Invalid signing certificate SHA-1.");
  return `identifier "${computerIdentifier}" and certificate leaf = H"${certificateSha1.toLowerCase()}"`;
}

async function certificateFingerprint(directory: string): Promise<string> {
  const { stdout } = await exec("openssl", [
    "x509",
    "-in",
    join(directory, "certificate.pem"),
    "-noout",
    "-fingerprint",
    "-sha1",
  ]);
  const fingerprint = stdout.trim().split("=").at(-1)?.replaceAll(":", "").toLowerCase();
  if (!fingerprint || !/^[a-f0-9]{40}$/.test(fingerprint))
    throw new Error("Cannot read signing certificate.");
  return fingerprint;
}

async function importKeychain(directory: string): Promise<void> {
  const keychain = join(directory, "computer.keychain-db");
  if (!(await readdir(directory)).includes("computer.keychain-db"))
    await exec("security", ["create-keychain", "-p", "", keychain]);
  // An explicit --keychain is used for signing; do not leave this keychain in the user's search list.
  const { stdout } = await exec("security", ["list-keychains", "-d", "user"]);
  const paths = [...stdout.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((path) => path !== keychain);
  await exec("security", ["list-keychains", "-d", "user", "-s", ...paths]);
  await exec("security", ["set-keychain-settings", keychain]);
  await exec("security", ["unlock-keychain", "-p", "", keychain]);
  await exec("security", [
    "import",
    join(directory, "identity.p12"),
    "-k",
    keychain,
    "-f",
    "pkcs12",
    "-P",
    backupPassword,
    "-T",
    "/usr/bin/codesign",
  ]);
  await exec("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    "",
    keychain,
  ]);
}

export async function setupComputerSigning(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Native signing setup requires macOS.");
  await loadComputerSigning();
  console.log(`Reusing fixed computer signing identity in ${signingDirectory()}.`);
}

export async function loadComputerSigning(): Promise<{
  identity: string;
  keychain: string;
  requirement: string;
}> {
  const directory = signingDirectory();
  let identity: Identity;
  try {
    identity = JSON.parse(await readFile(join(directory, "identity.json"), "utf8")) as Identity;
    if (identity.certificateSha1 !== computerCertificateSha1)
      throw new Error("The certificate does not match the published computer identity.");
    if (identity.version !== 1) throw new Error("Unsupported signing identity version.");
    computerRequirement(identity.certificateSha1);
    if ((await certificateFingerprint(directory)) !== identity.certificateSha1)
      throw new Error("Signing certificate changed.");
    await readFile(join(directory, "identity.p12"));
  } catch (cause) {
    throw new Error(
      `Fixed signing identity unavailable in ${directory}. Restore identity.json, certificate.pem and identity.p12 from the original signing backup, then run npm run setup:computer-signing. No ad-hoc fallback or certificate rotation is performed.`,
      { cause },
    );
  }
  const keychain = join(directory, "computer.keychain-db");
  if (!(await readdir(directory)).includes("computer.keychain-db")) await importKeychain(directory);
  await exec("security", ["unlock-keychain", "-p", "", keychain]);
  const { stdout } = await exec("security", ["find-identity", "-p", "codesigning", keychain]);
  if (!stdout.toLowerCase().includes(identity.certificateSha1)) {
    await importKeychain(directory);
    const restored = await exec("security", ["find-identity", "-p", "codesigning", keychain]);
    if (!restored.stdout.toLowerCase().includes(identity.certificateSha1))
      throw new Error("The restored keychain does not contain the original signing identity.");
  }
  return {
    identity: identity.certificateSha1,
    keychain,
    requirement: computerRequirement(identity.certificateSha1),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await setupComputerSigning();
