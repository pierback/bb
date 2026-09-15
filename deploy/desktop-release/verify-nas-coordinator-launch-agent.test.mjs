import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  NAS_COORDINATOR_LAUNCH_SHELL,
  validateNasCoordinatorLaunchAgent,
} from "./verify-nas-coordinator-launch-agent.mjs";

const execFileAsync = promisify(execFile);

const expected = {
  appBundle: "/Applications/BB Mesh.app",
  dataDirectory: "/Users/nas/.bb",
  homeDirectory: "/Users/nas",
  hostDaemonPort: 38887,
  serverPort: 38886,
  userName: "nas",
};

function validLaunchAgent() {
  return {
    KeepAlive: true,
    Label: "de.staufingers.bb-coordinator-bc26b7da6",
    ProgramArguments: [
      "/bin/sh",
      "-c",
      NAS_COORDINATOR_LAUNCH_SHELL,
      "bb-mesh-coordinator",
      "HOME=/Users/nas",
      "USER=nas",
      "LOGNAME=nas",
      "SHELL=/bin/zsh",
      "PATH=/Users/nas/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      "TMPDIR=/private/tmp",
      "ELECTRON_RUN_AS_NODE=1",
      "/Applications/BB Mesh.app/Contents/MacOS/BB Mesh",
      "/Applications/BB Mesh.app/Contents/Resources/app.asar.unpacked/dist/bb-app-bridge.mjs",
      "--data-dir=/Users/nas/.bb",
      "--server-bind-host=127.0.0.1",
      "--server-port=38886",
      "--host-daemon-port=38887",
    ],
    RunAtLoad: true,
    StandardErrorPath:
      "/Users/nas/.bb/logs/coordinator-bc26b7da6-launchd.stderr.log",
    StandardOutPath:
      "/Users/nas/.bb/logs/coordinator-bc26b7da6-launchd.stdout.log",
    ThrottleInterval: 10,
    WorkingDirectory: "/Users/nas",
  };
}

test("accepts the exact persistent BB Mesh coordinator job", () => {
  assert.deepEqual(
    validateNasCoordinatorLaunchAgent(validLaunchAgent(), expected),
    { label: "de.staufingers.bb-coordinator-bc26b7da6" },
  );
});

test("rejects launch arguments outside the signed coordinator identity", () => {
  const launchAgent = validLaunchAgent();
  launchAgent.ProgramArguments.push("start");

  assert.throws(
    () => validateNasCoordinatorLaunchAgent(launchAgent, expected),
    /ProgramArguments do not identify the exact signed coordinator runtime/u,
  );
});

test("rejects inherited environment variables", () => {
  const launchAgent = validLaunchAgent();
  launchAgent.EnvironmentVariables = { GH_TOKEN: "must-not-survive" };

  assert.throws(
    () => validateNasCoordinatorLaunchAgent(launchAgent, expected),
    /root keys/u,
  );
});

test("rejects a different coordinator port", () => {
  const launchAgent = validLaunchAgent();
  const serverPortIndex = launchAgent.ProgramArguments.indexOf(
    "--server-port=38886",
  );
  launchAgent.ProgramArguments[serverPortIndex] = "--server-port=48886";

  assert.throws(
    () => validateNasCoordinatorLaunchAgent(launchAgent, expected),
    /ProgramArguments do not identify the exact signed coordinator runtime/u,
  );
});

test("rejects jobs outside the coordinator label namespace", () => {
  const launchAgent = validLaunchAgent();
  launchAgent.Label = "com.example.coordinator";

  assert.throws(
    () => validateNasCoordinatorLaunchAgent(launchAgent, expected),
    /outside the BB Mesh coordinator namespace/u,
  );
});

test("rejects unexpected root properties", () => {
  const launchAgent = validLaunchAgent();
  launchAgent.ProcessType = "Interactive";

  assert.throws(
    () => validateNasCoordinatorLaunchAgent(launchAgent, expected),
    /root keys/u,
  );
});

test("preserves only the native SSH agent from the inherited environment", async () => {
  const { stdout } = await execFileAsync(
    "/bin/sh",
    [
      "-c",
      NAS_COORDINATOR_LAUNCH_SHELL,
      "bb-mesh-coordinator-test",
      "BB_MESH_STATIC=expected",
      "/usr/bin/env",
    ],
    {
      env: {
        NODE_OPTIONS: "--must-not-survive",
        SSH_AUTH_SOCK: "/private/tmp/bb-mesh-agent.sock",
      },
    },
  );

  assert.deepEqual(stdout.trim().split("\n").sort(), [
    "BB_MESH_STATIC=expected",
    "SSH_AUTH_SOCK=/private/tmp/bb-mesh-agent.sock",
  ]);
});
