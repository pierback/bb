import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const launchModulePath = fileURLToPath(
  new URL("./nas-desktop-launch.sh", import.meta.url),
);

async function createFixture(prefix = "pierback-launch-test-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const appBundle = join(root, "Pierback.app");
  const executable = join(appBundle, "Contents", "MacOS", "Pierback");
  const dataDirectory = join(root, ".bb");
  const outputPath = join(root, "launch-environment.txt");
  const outputPathLiteral = JSON.stringify(outputPath);
  await mkdir(join(appBundle, "Contents", "MacOS"), { recursive: true });
  await mkdir(dataDirectory);
  await writeFile(
    executable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'cwd=%s\\n' "$PWD" > ${outputPathLiteral}`,
      "for variable_name in HOME USER LOGNAME SHELL PATH TMPDIR LANG LC_ALL LC_CTYPE SSH_AUTH_SOCK BB_DATA_DIR BB_CLI BB_DESKTOP_APP_URL BB_DESKTOP_NODE_EXEC_PATH ELECTRON_RUN_AS_NODE RUNNER_TRACKING_ID CI GITHUB_ACTIONS RELEASE_TAG GH_TOKEN PIERBACK_TEST_OUTPUT NODE_OPTIONS; do",
      '  if [[ -n "${!variable_name+x}" ]]; then',
      '    printf \'%s=%s\\n\' "$variable_name" "${!variable_name}" >> ' +
        outputPathLiteral,
      "  else",
      "    printf '%s=unset\\n' \"$variable_name\" >> " + outputPathLiteral,
      "  fi",
      "done",
      "printf 'PIERBACK_TEST_COMPLETE=1\\n' >> " + outputPathLiteral,
    ].join("\n"),
    "utf8",
  );
  await chmod(executable, 0o755);
  return { appBundle, dataDirectory, outputPath, root };
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const contents = await readFile(path, "utf8");
      if (contents.endsWith("PIERBACK_TEST_COMPLETE=1\n")) {
        return contents;
      }
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for launched process output: ${path}`);
}

test("launches the exact executable with one protected data directory", async () => {
  const fixture = await createFixture();

  try {
    const expectedWorkingDirectory = await realpath(fixture.root);
    await execFileAsync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; pierback_open_desktop_app "$2" "$3"',
        "nas-desktop-launch-test",
        launchModulePath,
        fixture.appBundle,
        fixture.dataDirectory,
      ],
      {
        env: {
          ...process.env,
          BB_CLI: "/tmp/foreign-bb",
          BB_DATA_DIR: "/tmp/foreign-bb-data",
          BB_DESKTOP_APP_URL: "http://127.0.0.1:1",
          BB_DESKTOP_NODE_EXEC_PATH: "/tmp/node",
          ELECTRON_RUN_AS_NODE: "1",
          GITHUB_ACTIONS: "true",
          GH_TOKEN: "must-not-survive",
          HOME: fixture.root,
          LANG: "de_DE.UTF-8",
          LC_ALL: "de_DE.UTF-8",
          LC_CTYPE: "UTF-8",
          LOGNAME: "test-user",
          NODE_OPTIONS: "--no-warnings",
          PIERBACK_TEST_OUTPUT: fixture.outputPath,
          RELEASE_TAG: "pierback-desktop-v9.9.9",
          RUNNER_TRACKING_ID: "test-runner",
          SHELL: "/bin/zsh",
          SSH_AUTH_SOCK: "/tmp/test-ssh-agent.sock",
          TMPDIR: join(fixture.root, "tmp"),
          USER: "test-user",
          CI: "true",
        },
      },
    );

    assert.equal(
      await waitForFile(fixture.outputPath),
      [
        `cwd=${expectedWorkingDirectory}`,
        `HOME=${fixture.root}`,
        "USER=test-user",
        "LOGNAME=test-user",
        "SHELL=/bin/zsh",
        `PATH=${fixture.root}/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        `TMPDIR=${join(fixture.root, "tmp")}`,
        "LANG=de_DE.UTF-8",
        "LC_ALL=de_DE.UTF-8",
        "LC_CTYPE=UTF-8",
        "SSH_AUTH_SOCK=/tmp/test-ssh-agent.sock",
        `BB_DATA_DIR=${fixture.dataDirectory}`,
        "BB_CLI=unset",
        "BB_DESKTOP_APP_URL=unset",
        "BB_DESKTOP_NODE_EXEC_PATH=unset",
        "ELECTRON_RUN_AS_NODE=unset",
        "RUNNER_TRACKING_ID=unset",
        "CI=unset",
        "GITHUB_ACTIONS=unset",
        "RELEASE_TAG=unset",
        "GH_TOKEN=unset",
        "PIERBACK_TEST_OUTPUT=unset",
        "NODE_OPTIONS=unset",
        "PIERBACK_TEST_COMPLETE=1",
        "",
      ].join("\n"),
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a relative application path", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      execFileAsync("/bin/bash", [
        "-c",
        'source "$1"; pierback_open_desktop_app "Pierback.app" "$2"',
        "nas-desktop-launch-test",
        launchModulePath,
        fixture.dataDirectory,
      ]),
      (error) => {
        assert.equal(error.code, 64);
        assert.match(error.stderr, /specific absolute \.app bundle/u);
        return true;
      },
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a relative runtime data directory", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      execFileAsync("/bin/bash", [
        "-c",
        'source "$1"; pierback_open_desktop_app "$2" .bb',
        "nas-desktop-launch-test",
        launchModulePath,
        fixture.appBundle,
      ]),
      /specific absolute directory/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects persisted BB_DATA_DIR redirection", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(
      join(fixture.dataDirectory, "env.json"),
      `${JSON.stringify({ env: { BB_DATA_DIR: "/tmp/other" } })}\n`,
      "utf8",
    );
    await assert.rejects(
      execFileAsync("/bin/bash", [
        "-c",
        'source "$1"; pierback_open_desktop_app "$2" "$3"',
        "nas-desktop-launch-test",
        launchModulePath,
        fixture.appBundle,
        fixture.dataDirectory,
      ]),
      /requires BB_DATA_DIR to be absent/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a runtime data directory reached through a symbolic link", async () => {
  const fixture = await createFixture();
  const symlinkPath = join(fixture.root, "linked-bb");
  try {
    await symlink(fixture.dataDirectory, symlinkPath);
    await assert.rejects(
      execFileAsync("/bin/bash", [
        "-c",
        'source "$1"; pierback_open_desktop_app "$2" "$3"',
        "nas-desktop-launch-test",
        launchModulePath,
        fixture.appBundle,
        symlinkPath,
      ]),
      /must be a real directory/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects an app bundle without a supported executable", async () => {
  const fixture = await createFixture();
  try {
    await rm(join(fixture.appBundle, "Contents", "MacOS", "Pierback"));
    await assert.rejects(
      execFileAsync("/bin/bash", [
        "-c",
        'source "$1"; pierback_open_desktop_app "$2" "$3"',
        "nas-desktop-launch-test",
        launchModulePath,
        fixture.appBundle,
        fixture.dataDirectory,
      ]),
      /no supported regular executable/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
