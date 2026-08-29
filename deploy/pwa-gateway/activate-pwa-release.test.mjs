#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preparePwaRelease } from "./release-package.mjs";

const SOURCE_COMMIT = "c".repeat(40);
const RELEASE_ID = `bb-mesh-pwa-${SOURCE_COMMIT}`;
const activateScript = fileURLToPath(
  new URL("./activate-pwa-release.sh", import.meta.url),
);

async function releaseFixture(root, suffix = "") {
  const directory = join(root, `dist${suffix}`);
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><script type="module" src="/assets/main.js"></script>\n',
  );
  await writeFile(
    join(directory, "assets/main.js"),
    `const route="/pair-device"; const title="Approve this Mac?";${suffix}\n`,
  );
  await preparePwaRelease(directory, SOURCE_COMMIT);
  return directory;
}

async function stagedArchive(root, releaseDirectory, suffix) {
  const incoming = join(root, ".incoming");
  await mkdir(incoming, { recursive: true });
  const archive = join(incoming, `${RELEASE_ID}-${suffix}.tgz`);
  const tar = spawnSync("tar", ["-czf", archive, "-C", releaseDirectory, "."], {
    encoding: "utf8",
  });
  assert.equal(tar.status, 0, tar.stderr);
  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  return { archive, checksum };
}

function activate(root, archive, checksum) {
  return spawnSync(
    "bash",
    [activateScript, archive, root, RELEASE_ID, SOURCE_COMMIT, checksum],
    { encoding: "utf8" },
  );
}

test("atomically activates and safely reuses an identical immutable release", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "bb-mesh-pwa-activate-"));
  const root = join(sandbox, "pwa");
  const release = await releaseFixture(sandbox);
  const first = await stagedArchive(root, release, "first");
  const firstResult = activate(root, first.archive, first.checksum);
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(await readlink(join(root, "current")), `releases/${RELEASE_ID}`);
  assert.equal(
    (await lstat(join(root, "releases", RELEASE_ID))).isDirectory(),
    true,
  );

  const retry = await stagedArchive(root, release, "retry");
  const retryResult = activate(root, retry.archive, retry.checksum);
  assert.equal(retryResult.status, 0, retryResult.stderr);
  assert.equal(await readlink(join(root, "current")), `releases/${RELEASE_ID}`);
});

test("rejects different content for an existing immutable release", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "bb-mesh-pwa-conflict-"));
  const root = join(sandbox, "pwa");
  const original = await releaseFixture(sandbox, "-original");
  const first = await stagedArchive(root, original, "first");
  assert.equal(activate(root, first.archive, first.checksum).status, 0);

  const changed = await releaseFixture(sandbox, "-changed");
  const conflict = await stagedArchive(root, changed, "conflict");
  const result = activate(root, conflict.archive, conflict.checksum);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists with different content/u);
});

test("does not overwrite a non-symlink current deployment", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "bb-mesh-pwa-current-"));
  const root = join(sandbox, "pwa");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "current"), "operator-owned\n");
  const release = await releaseFixture(sandbox);
  const staged = await stagedArchive(root, release, "blocked");

  const result = activate(root, staged.archive, staged.checksum);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to replace non-symlink/u);
  assert.equal(
    await readFile(join(root, "current"), "utf8"),
    "operator-owned\n",
  );
});

test("replaces a dangling current symlink during recovery", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "bb-mesh-pwa-dangling-"));
  const root = join(sandbox, "pwa");
  await mkdir(root, { recursive: true });
  await symlink("releases/missing", join(root, "current"));
  const release = await releaseFixture(sandbox);
  const staged = await stagedArchive(root, release, "recovery");

  const result = activate(root, staged.archive, staged.checksum);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readlink(join(root, "current")), `releases/${RELEASE_ID}`);
});
