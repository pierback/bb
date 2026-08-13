import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const expectedKeys = [
  "applicationId",
  "applicationName",
  "desktopVersion",
  "hostDaemonProtocolVersion",
  "primaryZip",
  "schemaVersion",
  "sourceCommit",
];
const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const primaryZipPattern = /^pierback-[A-Za-z0-9._-]+\.zip$/u;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePierbackReleaseManifest(value) {
  if (!isRecord(value)) {
    throw new Error("Pierback release manifest must be an object.");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Pierback release manifest keys did not match the strict schema: ${keys.join(", ")}`,
    );
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Pierback release manifest schemaVersion must be 1.");
  }
  if (value.applicationId !== "de.staufingers.pierback.desktop") {
    throw new Error("Pierback release manifest applicationId was unexpected.");
  }
  if (value.applicationName !== "Pierback") {
    throw new Error(
      "Pierback release manifest applicationName was unexpected.",
    );
  }
  if (
    typeof value.desktopVersion !== "string" ||
    !semverPattern.test(value.desktopVersion)
  ) {
    throw new Error("Pierback release manifest desktopVersion was not SemVer.");
  }
  if (
    !Number.isSafeInteger(value.hostDaemonProtocolVersion) ||
    value.hostDaemonProtocolVersion <= 0
  ) {
    throw new Error(
      "Pierback release manifest hostDaemonProtocolVersion must be a positive integer.",
    );
  }
  if (
    typeof value.primaryZip !== "string" ||
    !primaryZipPattern.test(value.primaryZip)
  ) {
    throw new Error("Pierback release manifest primaryZip was unsafe.");
  }
  if (
    typeof value.sourceCommit !== "string" ||
    !sourceCommitPattern.test(value.sourceCommit)
  ) {
    throw new Error(
      "Pierback release manifest sourceCommit was not a Git SHA.",
    );
  }
  return value;
}

export async function readPierbackReleaseManifest(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not parse Pierback release manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsePierbackReleaseManifest(value);
}

async function main() {
  const [path, field] = process.argv.slice(2);
  if (
    path === undefined ||
    field === undefined ||
    !expectedKeys.includes(field)
  ) {
    throw new Error(
      `Usage: release-manifest.mjs <release-manifest.json> <${expectedKeys.join("|")}>`,
    );
  }
  const manifest = await readPierbackReleaseManifest(path);
  process.stdout.write(String(manifest[field]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
