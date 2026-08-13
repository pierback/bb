import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const launchModulePath = fileURLToPath(
  new URL("./nas-desktop-launch.sh", import.meta.url),
);

test("opens the exact app without Electron or runner control variables", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "pierback-open-test-"));
  const fakeOpen = join(fakeBin, "open");
  await writeFile(
    fakeOpen,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf 'app=%s\\n' \"$1\"",
      "for variable_name in BB_DESKTOP_APP_URL BB_DESKTOP_NODE_EXEC_PATH ELECTRON_RUN_AS_NODE RUNNER_TRACKING_ID; do",
      '  if [[ -n "${!variable_name+x}" ]]; then',
      "    printf '%s=set\\n' \"$variable_name\"",
      "  else",
      "    printf '%s=unset\\n' \"$variable_name\"",
      "  fi",
      "done",
    ].join("\n"),
    "utf8",
  );
  await chmod(fakeOpen, 0o755);

  try {
    const { stdout } = await execFileAsync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; pierback_open_desktop_app "/Applications/Pierback.app"',
        "nas-desktop-launch-test",
        launchModulePath,
      ],
      {
        env: {
          ...process.env,
          BB_DESKTOP_APP_URL: "http://127.0.0.1:1",
          BB_DESKTOP_NODE_EXEC_PATH: "/tmp/node",
          ELECTRON_RUN_AS_NODE: "1",
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          RUNNER_TRACKING_ID: "test-runner",
        },
      },
    );

    assert.equal(
      stdout,
      [
        "app=/Applications/Pierback.app",
        "BB_DESKTOP_APP_URL=unset",
        "BB_DESKTOP_NODE_EXEC_PATH=unset",
        "ELECTRON_RUN_AS_NODE=unset",
        "RUNNER_TRACKING_ID=unset",
        "",
      ].join("\n"),
    );
  } finally {
    await rm(fakeBin, { force: true, recursive: true });
  }
});

test("rejects a relative application path", async () => {
  await assert.rejects(
    execFileAsync("/bin/bash", [
      "-c",
      'source "$1"; pierback_open_desktop_app "Pierback.app"',
      "nas-desktop-launch-test",
      launchModulePath,
    ]),
    (error) => {
      assert.equal(error.code, 64);
      assert.match(error.stderr, /specific absolute \.app bundle/u);
      return true;
    },
  );
});
