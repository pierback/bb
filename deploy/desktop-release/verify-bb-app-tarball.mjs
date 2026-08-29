#!/usr/bin/env node

import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REQUIRED_BB_APP_ARCHIVE_ENTRIES = [
  "package/package.json",
  "package/dist/bb-app.js",
  "package/dist/bb.js",
  "package/dist/bb-host-daemon.js",
  "package/dist/bb-server.js",
  "package/app/dist/index.html",
  "package/server/dist/index.js",
  "package/host-daemon/dist/daemon-bundle.mjs",
];

async function defaultArchiveReader(archivePath, mode) {
  const args =
    mode === "list"
      ? ["-tzf", archivePath]
      : ["-xOzf", archivePath, "package/package.json"];
  const { stdout } = await execFileAsync("tar", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function normalizedArchiveEntries(rawListing) {
  const entries = rawListing
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/u, ""));
  const uniqueEntries = new Set();
  for (const entry of entries) {
    const segments = entry.split("/");
    if (
      !entry.startsWith("package/") ||
      entry.includes("\\") ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new Error(`Unsafe bb-app archive entry: ${entry}`);
    }
    if (uniqueEntries.has(entry)) {
      throw new Error(`Duplicate bb-app archive entry: ${entry}`);
    }
    uniqueEntries.add(entry);
  }
  return uniqueEntries;
}

/**
 * Verifies the coordinator-served machine runtime without installing it. The
 * archive reader is the tar utility Adapter; all BB Mesh package invariants
 * stay local to this release-gate Module.
 */
export async function verifyBbAppTarball({
  archivePath,
  archiveReader = defaultArchiveReader,
  expectedVersion,
}) {
  const archiveStat = await lstat(archivePath);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error(`bb-app bootstrap is not a regular file: ${archivePath}`);
  }

  const entries = normalizedArchiveEntries(
    await archiveReader(archivePath, "list"),
  );
  for (const requiredEntry of REQUIRED_BB_APP_ARCHIVE_ENTRIES) {
    if (!entries.has(requiredEntry)) {
      throw new Error(`bb-app bootstrap is missing ${requiredEntry}`);
    }
  }

  let packageJson;
  try {
    packageJson = JSON.parse(await archiveReader(archivePath, "package-json"));
  } catch (error) {
    throw new Error("bb-app bootstrap contains an invalid package.json", {
      cause: error,
    });
  }
  if (
    packageJson === null ||
    typeof packageJson !== "object" ||
    packageJson.name !== "bb-app" ||
    packageJson.version !== expectedVersion ||
    packageJson.private !== true
  ) {
    throw new Error(
      `bb-app bootstrap identity did not match private BB Mesh ${expectedVersion}`,
    );
  }
  const expectedBins = {
    bb: "dist/bb.js",
    "bb-app": "dist/bb-app.js",
    "bb-host-daemon": "dist/bb-host-daemon.js",
    "bb-server": "dist/bb-server.js",
  };
  for (const [name, path] of Object.entries(expectedBins)) {
    if (packageJson.bin?.[name] !== path) {
      throw new Error(`bb-app bootstrap has an invalid ${name} executable`);
    }
  }
}

async function main() {
  const [archivePath, expectedVersion] = process.argv.slice(2);
  if (!archivePath || !expectedVersion) {
    throw new Error(
      "Usage: verify-bb-app-tarball.mjs <bb-app.tgz> <expected-version>",
    );
  }
  await verifyBbAppTarball({ archivePath, expectedVersion });
  process.stdout.write(
    `Verified coordinator-served bb-app ${expectedVersion} bootstrap.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
