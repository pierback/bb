import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const activateScript = fileURLToPath(
  new URL("./activate-gateway-config.sh", import.meta.url),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function executable(path, contents) {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-mesh-gateway-config-"));
  const bin = join(root, "bin");
  const configDirectory = join(root, "etc", "caddy");
  const staged = join(root, "staged-Caddyfile");
  const target = join(configDirectory, "Caddyfile");
  const reloadLog = join(root, "reload.log");
  const failReload = join(root, "fail-reload-once");
  await mkdir(bin, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await executable(
    join(bin, "sudo"),
    '#!/usr/bin/env bash\nset -euo pipefail\n[[ "${1:-}" == "-n" ]] && shift\nexec "$@"\n',
  );
  await executable(
    join(bin, "caddy"),
    '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == "validate" ]]\n[[ "$2" == "--config" ]]\n! grep -q INVALID "$3"\n',
  );
  await executable(
    join(bin, "systemctl"),
    '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == "reload" ]]\n[[ "$2" == "caddy.service" ]]\nprintf "reload\\n" >> "$BB_MESH_TEST_RELOAD_LOG"\nif [[ -f "$BB_MESH_TEST_FAIL_RELOAD" ]]; then\n  rm -f -- "$BB_MESH_TEST_FAIL_RELOAD"\n  exit 1\nfi\n',
  );
  return {
    caddy: join(bin, "caddy"),
    failReload,
    reloadLog,
    root,
    staged,
    sudo: join(bin, "sudo"),
    systemctl: join(bin, "systemctl"),
    target,
  };
}

function activate(paths, contents) {
  return spawnSync(
    "/bin/bash",
    [
      activateScript,
      paths.staged,
      sha256(contents),
      paths.target,
      paths.caddy,
      paths.systemctl,
      "caddy.service",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        BB_MESH_SUDO_BIN: paths.sudo,
        BB_MESH_TEST_FAIL_RELOAD: paths.failReload,
        BB_MESH_TEST_RELOAD_LOG: paths.reloadLog,
      },
    },
  );
}

test("validates, atomically installs, and reloads the gateway config", async () => {
  const paths = await fixture();
  const previous = "old config\n";
  const candidate = "new config\n";
  await writeFile(paths.target, previous);
  await writeFile(paths.staged, candidate);

  const result = activate(paths, candidate);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(paths.target, "utf8"), candidate);
  assert.equal(await readFile(paths.reloadLog, "utf8"), "reload\n");
});

test("does not touch the active config when candidate validation fails", async () => {
  const paths = await fixture();
  const previous = "old config\n";
  const candidate = "INVALID config\n";
  await writeFile(paths.target, previous);
  await writeFile(paths.staged, candidate);

  const result = activate(paths, candidate);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(paths.target, "utf8"), previous);
});

test("restores and reloads the previous config when activation fails", async () => {
  const paths = await fixture();
  const previous = "old config\n";
  const candidate = "new config\n";
  await writeFile(paths.target, previous);
  await writeFile(paths.staged, candidate);
  await writeFile(paths.failReload, "fail once\n");

  const result = activate(paths, candidate);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restored the previous config/u);
  assert.equal(await readFile(paths.target, "utf8"), previous);
  assert.equal(await readFile(paths.reloadLog, "utf8"), "reload\nreload\n");
});
