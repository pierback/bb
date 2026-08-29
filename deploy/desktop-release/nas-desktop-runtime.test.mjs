import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const runtimeModulePath = fileURLToPath(
  new URL("./nas-desktop-runtime.sh", import.meta.url),
);

test("stops the recorded runtime through the packaged bridge", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-runtime-test-"));
  const appBundle = join(fixtureRoot, "BB Mesh.app");
  const executable = join(appBundle, "Contents", "MacOS", "BB Mesh");
  const bridge = join(
    appBundle,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "bb-app-bridge.mjs",
  );
  const dataDirectory = join(fixtureRoot, ".bb");
  await mkdir(join(appBundle, "Contents", "MacOS"), { recursive: true });
  await mkdir(join(bridge, ".."), { recursive: true });
  await writeFile(
    executable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf 'arg=%s\\n' \"$@\"",
      "for variable_name in BB_CLI BB_DATA_DIR BB_DESKTOP_APP_URL BB_DESKTOP_NODE_EXEC_PATH RUNNER_TRACKING_ID; do",
      '  if [[ -n "${!variable_name+x}" ]]; then',
      "    printf '%s=set\\n' \"$variable_name\"",
      "  else",
      "    printf '%s=unset\\n' \"$variable_name\"",
      "  fi",
      "done",
      "printf 'ELECTRON_RUN_AS_NODE=%s\\n' \"${ELECTRON_RUN_AS_NODE:-unset}\"",
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o755);
  await writeFile(bridge, "// fixture\n", "utf8");

  try {
    const { stdout } = await execFileAsync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; bb_mesh_stop_desktop_runtime "$2" "$3"',
        "nas-desktop-runtime-test",
        runtimeModulePath,
        appBundle,
        dataDirectory,
      ],
      {
        env: {
          ...process.env,
          BB_CLI: "/tmp/bb",
          BB_DATA_DIR: "/tmp/wrong-data",
          BB_DESKTOP_APP_URL: "http://127.0.0.1:1",
          BB_DESKTOP_NODE_EXEC_PATH: "/tmp/node",
          ELECTRON_RUN_AS_NODE: "0",
          RUNNER_TRACKING_ID: "test-runner",
        },
      },
    );

    assert.equal(
      stdout,
      [
        `arg=${bridge}`,
        "arg=--data-dir",
        `arg=${dataDirectory}`,
        "arg=stop",
        "BB_CLI=unset",
        "BB_DATA_DIR=unset",
        "BB_DESKTOP_APP_URL=unset",
        "BB_DESKTOP_NODE_EXEC_PATH=unset",
        "RUNNER_TRACKING_ID=unset",
        "ELECTRON_RUN_AS_NODE=1",
        "",
      ].join("\n"),
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("rejects an unsafe runtime data directory", async () => {
  await assert.rejects(
    execFileAsync("/bin/bash", [
      "-c",
      'source "$1"; bb_mesh_stop_desktop_runtime "/Applications/BB Mesh.app" "/"',
      "nas-desktop-runtime-test",
      runtimeModulePath,
    ]),
    (error) => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /specific absolute directory/u);
      return true;
    },
  );
});
