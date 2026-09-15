import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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
const launchAgentModulePath = fileURLToPath(
  new URL("./nas-coordinator-launch-agent.sh", import.meta.url),
);

function launchAgentFixture({
  appBundle,
  dataDirectory,
  homeDirectory,
  label,
}) {
  const suffix = label.slice("de.staufingers.bb-coordinator-".length);
  return {
    KeepAlive: true,
    Label: label,
    ProgramArguments: [
      "/bin/sh",
      "-c",
      'if [ -n "${SSH_AUTH_SOCK:-}" ]; then set -- "SSH_AUTH_SOCK=$SSH_AUTH_SOCK" "$@"; fi; exec /usr/bin/env -i "$@"',
      "bb-mesh-coordinator",
      `HOME=${homeDirectory}`,
      `USER=${process.env.USER}`,
      `LOGNAME=${process.env.USER}`,
      "SHELL=/bin/zsh",
      `PATH=${homeDirectory}/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      "TMPDIR=/private/tmp",
      "ELECTRON_RUN_AS_NODE=1",
      join(appBundle, "Contents", "MacOS", "BB Mesh"),
      join(
        appBundle,
        "Contents",
        "Resources",
        "app.asar.unpacked",
        "dist",
        "bb-app-bridge.mjs",
      ),
      `--data-dir=${dataDirectory}`,
      "--server-bind-host=127.0.0.1",
      "--server-port=38886",
      "--host-daemon-port=38887",
    ],
    RunAtLoad: true,
    StandardErrorPath: join(
      dataDirectory,
      "logs",
      `coordinator-${suffix}-launchd.stderr.log`,
    ),
    StandardOutPath: join(
      dataDirectory,
      "logs",
      `coordinator-${suffix}-launchd.stdout.log`,
    ),
    ThrottleInterval: 10,
    WorkingDirectory: homeDirectory,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bb-mesh-launch-agent-test-"));
  const homeDirectory = join(root, "home");
  const launchAgentDirectory = join(homeDirectory, "Library", "LaunchAgents");
  const appBundle = join(root, "Applications", "BB Mesh.app");
  const dataDirectory = join(homeDirectory, ".bb");
  const label = "de.staufingers.bb-coordinator-bc26b7da6";
  const launchAgentPath = join(launchAgentDirectory, `${label}.plist`);
  const launchctlPath = join(root, "launchctl");
  const launchctlLog = join(root, "launchctl.log");
  const launchctlDisabled = join(root, "launchctl.disabled");
  const launchctlState = join(root, "launchctl.loaded");
  await mkdir(launchAgentDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    launchAgentPath,
    `${JSON.stringify(
      launchAgentFixture({ appBundle, dataDirectory, homeDirectory, label }),
    )}\n`,
    "utf8",
  );
  await writeFile(
    launchctlPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "$1" in',
      "  print)",
      '    [[ -f "${BB_MESH_LAUNCHCTL_STATE:?}" ]]',
      "    ;;",
      "  bootout)",
      '    printf \'bootout %s\\n\' "$2" >> "${BB_MESH_LAUNCHCTL_LOG:?}"',
      '    /bin/unlink "${BB_MESH_LAUNCHCTL_STATE:?}"',
      "    ;;",
      "  disable)",
      '    printf \'disable %s\\n\' "$2" >> "${BB_MESH_LAUNCHCTL_LOG:?}"',
      '    : > "${BB_MESH_LAUNCHCTL_DISABLED:?}"',
      "    ;;",
      "  enable)",
      '    printf \'enable %s\\n\' "$2" >> "${BB_MESH_LAUNCHCTL_LOG:?}"',
      '    if [[ -f "${BB_MESH_LAUNCHCTL_DISABLED:?}" ]]; then /bin/unlink "${BB_MESH_LAUNCHCTL_DISABLED:?}"; fi',
      "    ;;",
      "  bootstrap)",
      '    printf \'bootstrap %s %s\\n\' "$2" "$3" >> "${BB_MESH_LAUNCHCTL_LOG:?}"',
      '    : > "${BB_MESH_LAUNCHCTL_STATE:?}"',
      "    ;;",
      "  *)",
      '    echo "Unexpected launchctl command: $*" >&2',
      "    exit 64",
      "    ;;",
      "esac",
    ].join("\n"),
    "utf8",
  );
  await chmod(launchctlPath, 0o755);
  await writeFile(launchctlState, "loaded\n", "utf8");
  return {
    appBundle,
    dataDirectory,
    homeDirectory,
    label,
    launchAgentDirectory,
    launchAgentPath,
    launchctlDisabled,
    launchctlLog,
    launchctlPath,
    launchctlState,
    root,
  };
}

test("hands the verified coordinator job from bootout back to bootstrap", async () => {
  const fixture = await createFixture();
  try {
    const { stdout } = await execFileAsync(
      "/bin/bash",
      [
        "-c",
        [
          'source "$1"',
          'bb_mesh_validate_runtime_data_directory "$3"',
          'launch_agent_path="$(bb_mesh_find_coordinator_launch_agent "$2" "$3" 38886 38887)"',
          "printf 'path=%s\\n' \"$launch_agent_path\"",
          'bb_mesh_stop_coordinator_launch_agent "$launch_agent_path" "$2" "$3" 38886 38887',
          'bb_mesh_start_coordinator_launch_agent "$launch_agent_path" "$2" "$3" 38886 38887',
        ].join("; "),
        "nas-coordinator-launch-agent-test",
        launchAgentModulePath,
        fixture.appBundle,
        fixture.dataDirectory,
      ],
      {
        env: {
          ...process.env,
          BB_MESH_LAUNCHCTL_COMMAND: fixture.launchctlPath,
          BB_MESH_LAUNCHCTL_DISABLED: fixture.launchctlDisabled,
          BB_MESH_LAUNCHCTL_LOG: fixture.launchctlLog,
          BB_MESH_LAUNCHCTL_STATE: fixture.launchctlState,
          HOME: fixture.homeDirectory,
        },
      },
    );
    const uid = process.getuid();
    assert.equal(stdout, `path=${fixture.launchAgentPath}\n`);
    assert.equal(
      await readFile(fixture.launchctlLog, "utf8"),
      [
        `disable gui/${uid}/${fixture.label}`,
        `bootout gui/${uid}/${fixture.label}`,
        `enable gui/${uid}/${fixture.label}`,
        `bootstrap gui/${uid} ${fixture.launchAgentPath}`,
        "",
      ].join("\n"),
    );
    assert.equal(await readFile(fixture.launchctlState, "utf8"), "");
    await assert.rejects(readFile(fixture.launchctlDisabled), {
      code: "ENOENT",
    });
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("keeps the coordinator persistently disabled while recovery is incomplete", async () => {
  const fixture = await createFixture();
  try {
    await execFileAsync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; bb_mesh_stop_coordinator_launch_agent "$2" "$3" "$4" 38886 38887',
        "nas-coordinator-launch-agent-test",
        launchAgentModulePath,
        fixture.launchAgentPath,
        fixture.appBundle,
        fixture.dataDirectory,
      ],
      {
        env: {
          ...process.env,
          BB_MESH_LAUNCHCTL_COMMAND: fixture.launchctlPath,
          BB_MESH_LAUNCHCTL_DISABLED: fixture.launchctlDisabled,
          BB_MESH_LAUNCHCTL_LOG: fixture.launchctlLog,
          BB_MESH_LAUNCHCTL_STATE: fixture.launchctlState,
          HOME: fixture.homeDirectory,
        },
      },
    );
    const uid = process.getuid();
    assert.equal(await readFile(fixture.launchctlDisabled, "utf8"), "");
    assert.equal(
      await readFile(fixture.launchctlLog, "utf8"),
      [
        `disable gui/${uid}/${fixture.label}`,
        `bootout gui/${uid}/${fixture.label}`,
        "",
      ].join("\n"),
    );
    await assert.rejects(readFile(fixture.launchctlState), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects multiple matching coordinator jobs", async () => {
  const fixture = await createFixture();
  try {
    const secondPath = join(
      fixture.launchAgentDirectory,
      "de.staufingers.bb-coordinator-second.plist",
    );
    await writeFile(secondPath, await readFile(fixture.launchAgentPath));
    await assert.rejects(
      execFileAsync(
        "/bin/bash",
        [
          "-c",
          'source "$1"; bb_mesh_find_coordinator_launch_agent "$2" "$3" 38886 38887',
          "nas-coordinator-launch-agent-test",
          launchAgentModulePath,
          fixture.appBundle,
          fixture.dataDirectory,
        ],
        { env: { ...process.env, HOME: fixture.homeDirectory } },
      ),
      /Multiple trusted NAS coordinator LaunchAgents/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("rejects a matching coordinator job reached through a symbolic link", async () => {
  const fixture = await createFixture();
  try {
    const outsidePath = join(fixture.root, "outside.plist");
    await writeFile(outsidePath, await readFile(fixture.launchAgentPath));
    await rm(fixture.launchAgentPath);
    await symlink(outsidePath, fixture.launchAgentPath);
    await assert.rejects(
      execFileAsync(
        "/bin/bash",
        [
          "-c",
          'source "$1"; bb_mesh_find_coordinator_launch_agent "$2" "$3" 38886 38887',
          "nas-coordinator-launch-agent-test",
          launchAgentModulePath,
          fixture.appBundle,
          fixture.dataDirectory,
        ],
        { env: { ...process.env, HOME: fixture.homeDirectory } },
      ),
      /must be a regular file/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
