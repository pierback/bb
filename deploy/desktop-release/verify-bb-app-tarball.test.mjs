import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  REQUIRED_BB_APP_ARCHIVE_ENTRIES,
  verifyBbAppTarball,
} from "./verify-bb-app-tarball.mjs";

const tempDirectories = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pierback-bb-app-verify-"));
  tempDirectories.push(directory);
  const archivePath = join(directory, "bb-app.tgz");
  await writeFile(archivePath, "fixture", "utf8");
  return archivePath;
}

function packageJson(version = "1.2.3") {
  return JSON.stringify({
    bin: {
      bb: "dist/bb.js",
      "bb-app": "dist/bb-app.js",
      "bb-host-daemon": "dist/bb-host-daemon.js",
      "bb-server": "dist/bb-server.js",
    },
    name: "bb-app",
    private: true,
    version,
  });
}

function reader(args = {}) {
  return async (_archivePath, mode) =>
    mode === "list"
      ? `${(args.entries ?? REQUIRED_BB_APP_ARCHIVE_ENTRIES).join("\n")}\n`
      : (args.packageJson ?? packageJson());
}

test("accepts the exact private Pierback machine runtime", async () => {
  await verifyBbAppTarball({
    archivePath: await createFixture(),
    archiveReader: reader(),
    expectedVersion: "1.2.3",
  });
});

test("rejects a runtime missing a required executable", async () => {
  await assert.rejects(
    verifyBbAppTarball({
      archivePath: await createFixture(),
      archiveReader: reader({ entries: ["package/package.json"] }),
      expectedVersion: "1.2.3",
    }),
    /missing package\/dist\/bb-app\.js/u,
  );
});

test("rejects traversal, duplicate entries, and the wrong package version", async () => {
  for (const entries of [
    [...REQUIRED_BB_APP_ARCHIVE_ENTRIES, "package/../outside"],
    [...REQUIRED_BB_APP_ARCHIVE_ENTRIES, "package/package.json"],
  ]) {
    await assert.rejects(
      verifyBbAppTarball({
        archivePath: await createFixture(),
        archiveReader: reader({ entries }),
        expectedVersion: "1.2.3",
      }),
      /Unsafe|Duplicate/u,
    );
  }
  await assert.rejects(
    verifyBbAppTarball({
      archivePath: await createFixture(),
      archiveReader: reader({ packageJson: packageJson("9.9.9") }),
      expectedVersion: "1.2.3",
    }),
    /identity did not match/u,
  );
});
