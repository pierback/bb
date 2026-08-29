#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preparePwaRelease, verifyPwaRelease } from "./release-package.mjs";

const SOURCE_COMMIT = "a".repeat(40);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bb-mesh-pwa-package-"));
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><script type="module" src="/assets/main.js"></script>\n',
  );
  await writeFile(
    join(directory, "assets/main.js"),
    'const route="/pair-device"; const title="Approve this Mac?";\n',
  );
  return directory;
}

test("prepares and verifies a pairing-capable immutable PWA package", async () => {
  const directory = await fixture();
  await preparePwaRelease(directory, SOURCE_COMMIT);
  await verifyPwaRelease(directory, SOURCE_COMMIT);

  const manifest = JSON.parse(
    await readFile(join(directory, "bb-mesh-pwa-release.json"), "utf8"),
  );
  assert.equal(manifest.sourceCommit, SOURCE_COMMIT);
  assert.equal(manifest.features.nativeClientPairing, true);
  assert.match(
    await readFile(join(directory, "SHA256SUMS"), "utf8"),
    /  assets\/main\.js$/mu,
  );
});

test("rejects a package whose pairing bundle changed after preparation", async () => {
  const directory = await fixture();
  await preparePwaRelease(directory, SOURCE_COMMIT);
  await writeFile(join(directory, "assets/main.js"), 'const route="/";\n');

  await assert.rejects(
    verifyPwaRelease(directory, SOURCE_COMMIT),
    /assets\/main\.js|pair-device/u,
  );
});

test("rejects a package built for another source commit", async () => {
  const directory = await fixture();
  await preparePwaRelease(directory, SOURCE_COMMIT);

  await assert.rejects(
    verifyPwaRelease(directory, "b".repeat(40)),
    /Expected values to be strictly equal/u,
  );
});
