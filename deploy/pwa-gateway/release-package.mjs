#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_NAME = "bb-mesh-pwa-release.json";
const CHECKSUMS_NAME = "SHA256SUMS";
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_RELEASE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/u;

async function regularFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`PWA releases must not contain symlinks: ${path}`);
    }
    if (entry.isDirectory()) {
      paths.push(...(await regularFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `PWA releases may contain only files and directories: ${path}`,
      );
    }
    const releasePath = relative(root, path).split(sep).join("/");
    if (
      releasePath.length === 0 ||
      !SAFE_RELEASE_PATH_PATTERN.test(releasePath) ||
      releasePath.split("/").includes("..")
    ) {
      throw new Error(`Unsafe PWA release path: ${releasePath}`);
    }
    paths.push(releasePath);
  }
  return paths.sort();
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function assertPairingBundle(releaseDirectory, files) {
  const javascriptFiles = files.filter((path) => path.endsWith(".js"));
  assert.ok(
    javascriptFiles.length > 0,
    "PWA release has no JavaScript bundles",
  );

  let containsRoute = false;
  let containsApprovalView = false;
  for (const path of javascriptFiles) {
    const source = await readFile(join(releaseDirectory, path), "utf8");
    containsRoute ||= source.includes("/pair-device");
    containsApprovalView ||= source.includes("Approve this Mac?");
  }
  assert.ok(
    containsRoute,
    "PWA release does not contain the /pair-device route",
  );
  assert.ok(
    containsApprovalView,
    "PWA release does not contain the native-client approval view",
  );
}

function parseChecksums(value) {
  const records = new Map();
  for (const line of value.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/u.exec(line);
    assert.ok(match, `Invalid SHA256SUMS entry: ${line}`);
    const [, checksum, path] = match;
    assert.ok(!path.startsWith("/"), `Absolute checksum path: ${path}`);
    assert.ok(
      !path.split("/").includes(".."),
      `Traversal checksum path: ${path}`,
    );
    assert.ok(!records.has(path), `Duplicate checksum path: ${path}`);
    records.set(path, checksum);
  }
  return records;
}

export async function preparePwaRelease(releaseDirectoryInput, sourceCommit) {
  assert.match(sourceCommit, SOURCE_COMMIT_PATTERN, "Invalid source commit");
  const releaseDirectory = resolve(releaseDirectoryInput);
  const directoryStat = await lstat(releaseDirectory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());

  await unlink(join(releaseDirectory, CHECKSUMS_NAME)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });

  const indexPath = join(releaseDirectory, "index.html");
  const indexStat = await lstat(indexPath);
  assert.ok(indexStat.isFile() && !indexStat.isSymbolicLink());

  const initialFiles = await regularFiles(releaseDirectory);
  await assertPairingBundle(releaseDirectory, initialFiles);
  const manifest = {
    schemaVersion: 1,
    sourceCommit,
    indexSha256: await sha256(indexPath),
    features: { nativeClientPairing: true },
  };
  await writeFile(
    join(releaseDirectory, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const files = (await regularFiles(releaseDirectory)).filter(
    (path) => path !== CHECKSUMS_NAME,
  );
  const checksumLines = [];
  for (const path of files) {
    checksumLines.push(
      `${await sha256(join(releaseDirectory, path))}  ${path}`,
    );
  }
  await writeFile(
    join(releaseDirectory, CHECKSUMS_NAME),
    `${checksumLines.join("\n")}\n`,
    "utf8",
  );
  await verifyPwaRelease(releaseDirectory, sourceCommit);
}

export async function verifyPwaRelease(releaseDirectoryInput, sourceCommit) {
  if (sourceCommit !== undefined) {
    assert.match(sourceCommit, SOURCE_COMMIT_PATTERN, "Invalid source commit");
  }
  const releaseDirectory = resolve(releaseDirectoryInput);
  const files = await regularFiles(releaseDirectory);
  assert.ok(files.includes("index.html"), "PWA release is missing index.html");
  assert.ok(
    files.includes(MANIFEST_NAME),
    `PWA release is missing ${MANIFEST_NAME}`,
  );
  assert.ok(
    files.includes(CHECKSUMS_NAME),
    `PWA release is missing ${CHECKSUMS_NAME}`,
  );

  const manifest = JSON.parse(
    await readFile(join(releaseDirectory, MANIFEST_NAME), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest).sort(), [
    "features",
    "indexSha256",
    "schemaVersion",
    "sourceCommit",
  ]);
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.sourceCommit, SOURCE_COMMIT_PATTERN);
  assert.equal(manifest.features?.nativeClientPairing, true);
  assert.equal(
    manifest.indexSha256,
    await sha256(join(releaseDirectory, "index.html")),
  );
  if (sourceCommit !== undefined)
    assert.equal(manifest.sourceCommit, sourceCommit);

  const checksums = parseChecksums(
    await readFile(join(releaseDirectory, CHECKSUMS_NAME), "utf8"),
  );
  const payloadFiles = files.filter((path) => path !== CHECKSUMS_NAME);
  assert.deepEqual([...checksums.keys()].sort(), payloadFiles);
  for (const [path, expected] of checksums) {
    assert.equal(await sha256(join(releaseDirectory, path)), expected, path);
  }
  await assertPairingBundle(releaseDirectory, payloadFiles);
}

async function main() {
  const [command, releaseDirectory, sourceCommit] = process.argv.slice(2);
  if (
    (command !== "prepare" && command !== "verify") ||
    releaseDirectory === undefined ||
    sourceCommit === undefined
  ) {
    throw new Error(
      `Usage: ${basename(process.argv[1])} <prepare|verify> <release-directory> <40-char-source-commit>`,
    );
  }
  if (command === "prepare") {
    await preparePwaRelease(releaseDirectory, sourceCommit);
  } else {
    await verifyPwaRelease(releaseDirectory, sourceCommit);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
