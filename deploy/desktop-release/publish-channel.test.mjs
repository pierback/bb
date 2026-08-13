import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "publish-channel.sh",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createStaging(updateRoot, name, overrides = {}) {
  const staging = resolve(updateRoot, ".incoming", name);
  await mkdir(staging, { recursive: true });
  const files = {
    "canary-desktop-version.json": '{"channel":"canary"}\n',
    "canary-mac.yml": "version: 1.2.3\n",
    "pierback-1.2.3-arm64.dmg": "signed-dmg",
    "pierback-1.2.3-arm64.zip": "signed-zip",
    "pierback-1.2.3-arm64.zip.blockmap": "blockmap",
    "release-manifest.json": '{"schemaVersion":1}\n',
    "stable-desktop-version.json": '{"channel":"stable"}\n',
    "stable-mac.yml": "version: 1.2.3\n",
    ...overrides,
  };
  await Promise.all(
    Object.entries(files).map(([name, value]) =>
      writeFile(resolve(staging, name), value),
    ),
  );
  const manifest = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fileName, value]) => `${sha256(value)}  ${fileName}`)
    .join("\n");
  await writeFile(resolve(staging, "SHA256SUMS"), `${manifest}\n`);
  return staging;
}

async function runPublisher(...args) {
  const child = spawn("/bin/bash", [scriptPath, ...args]);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const exitCode = await new Promise((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });
  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

async function verifyPublishedChecksums(directory) {
  const manifest = await readFile(resolve(directory, "SHA256SUMS"), "utf8");
  const manifestEntries = manifest
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
      assert.notEqual(
        match,
        null,
        `Malformed published checksum line: ${line}`,
      );
      return { digest: match[1], name: match[2] };
    });
  const publishedFiles = (await readdir(directory))
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  assert.deepEqual(
    manifestEntries.map(({ name }) => name).sort(),
    publishedFiles,
  );
  for (const { digest, name } of manifestEntries) {
    assert.equal(sha256(await readFile(resolve(directory, name))), digest);
  }
}

async function verifyPublicPermissions(directory) {
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  for (const name of await readdir(directory)) {
    assert.equal(
      (await stat(resolve(directory, name))).mode & 0o777,
      0o644,
      `${name} must be readable by the update web server`,
    );
  }
}

test("publishes independent canary and stable views over one immutable release", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pierback-updates-"));
  const tag = "pierback-desktop-v1.2.3";
  const canaryStaging = await createStaging(root, "canary-upload");
  const canary = await runPublisher(canaryStaging, root, tag, "canary");
  assert.equal(canary.exitCode, 0, canary.stderr);
  assert.equal(await readlink(resolve(root, "canary")), `views/${tag}-canary`);
  assert.equal(
    await readFile(resolve(root, "canary", "desktop-version.json"), "utf8"),
    '{"channel":"canary"}\n',
  );
  assert.deepEqual(
    (await readdir(resolve(root, "canary")))
      .filter((name) => name.endsWith("mac.yml"))
      .sort(),
    ["canary-mac.yml", "stable-mac.yml"],
  );
  await verifyPublishedChecksums(resolve(root, "canary"));
  await verifyPublicPermissions(resolve(root, "canary"));

  const stableStaging = await createStaging(root, "stable-upload");
  const stable = await runPublisher(stableStaging, root, tag, "stable");
  assert.equal(stable.exitCode, 0, stable.stderr);
  assert.equal(await readlink(resolve(root, "stable")), `views/${tag}-stable`);
  assert.equal(
    await readFile(resolve(root, "stable", "desktop-version.json"), "utf8"),
    '{"channel":"stable"}\n',
  );
  await verifyPublishedChecksums(resolve(root, "stable"));
  assert.equal(
    await readFile(resolve(root, "stable", "pierback-1.2.3-arm64.zip"), "utf8"),
    await readFile(resolve(root, "canary", "pierback-1.2.3-arm64.zip"), "utf8"),
  );
  assert.equal((await lstat(resolve(root, "stable"))).isSymbolicLink(), true);
  await verifyPublicPermissions(resolve(root, "stable"));
});

test("republishing identical bytes repairs a private channel view", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pierback-updates-"));
  const tag = "pierback-desktop-v1.2.3";
  const firstStaging = await createStaging(root, "first-upload");
  assert.equal(
    (await runPublisher(firstStaging, root, tag, "canary")).exitCode,
    0,
  );

  const view = resolve(root, "views", `${tag}-canary`);
  await chmod(view, 0o700);
  await Promise.all(
    (await readdir(view)).map((name) => chmod(resolve(view, name), 0o600)),
  );

  const retryStaging = await createStaging(root, "retry-upload");
  const retry = await runPublisher(retryStaging, root, tag, "canary");
  assert.equal(retry.exitCode, 0, retry.stderr);
  await verifyPublishedChecksums(resolve(root, "canary"));
  await verifyPublicPermissions(view);
});

test("refuses to mutate an existing release tag", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pierback-updates-"));
  const tag = "pierback-desktop-v1.2.3";
  const firstStaging = await createStaging(root, "first-upload");
  assert.equal(
    (await runPublisher(firstStaging, root, tag, "canary")).exitCode,
    0,
  );

  const changedStaging = await createStaging(root, "changed-upload", {
    "pierback-1.2.3-arm64.zip": "different-signed-zip",
  });
  const changed = await runPublisher(changedStaging, root, tag, "canary");
  assert.notEqual(changed.exitCode, 0);
  assert.match(changed.stderr, /already exists with different checksums/u);
  assert.equal(
    await readFile(resolve(root, "canary", "pierback-1.2.3-arm64.zip"), "utf8"),
    "signed-zip",
  );
});

test("rejects files outside the release allowlist", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pierback-updates-"));
  const staging = await createStaging(root, "unexpected-upload", {
    "server-secret.txt": "must-never-publish",
  });
  const result = await runPublisher(
    staging,
    root,
    "pierback-desktop-v1.2.3",
    "canary",
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /unexpected file/u);
});

test("refuses to publish the incoming root as a release", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pierback-updates-"));
  const incomingRoot = await createStaging(root, ".");
  const result = await runPublisher(
    incomingRoot,
    root,
    "pierback-desktop-v1.2.3",
    "canary",
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /one direct child/u);
});
