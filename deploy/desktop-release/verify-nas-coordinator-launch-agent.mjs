import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const LABEL_PREFIX = "de.staufingers.bb-coordinator-";
export const NAS_COORDINATOR_LAUNCH_SHELL =
  'if [ -n "${SSH_AUTH_SOCK:-}" ]; then set -- "SSH_AUTH_SOCK=$SSH_AUTH_SOCK" "$@"; fi; exec /usr/bin/env -i "$@"';
const TOOLCHAIN_PATH_SUFFIX =
  ".local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function fail(message) {
  throw new Error(`Untrusted NAS coordinator LaunchAgent: ${message}`);
}

function requireRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be a dictionary`);
  }
  return value;
}

function requireExactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      `${name} keys were ${actual.join(", ")}, expected ${wanted.join(", ")}`,
    );
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

function requireEqual(actual, expected, name) {
  if (actual !== expected) {
    fail(
      `${name} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

export function validateNasCoordinatorLaunchAgent(value, expected) {
  const plist = requireRecord(value, "root");
  const appBundle = requireString(expected.appBundle, "expected app bundle");
  const dataDirectory = requireString(
    expected.dataDirectory,
    "expected data directory",
  );
  const homeDirectory = requireString(
    expected.homeDirectory,
    "expected home directory",
  );
  const userName = requireString(expected.userName, "expected user name");
  if (userName.includes("=")) {
    fail("expected user name must not contain an equals sign");
  }
  if (![appBundle, dataDirectory, homeDirectory].every(isAbsolute)) {
    fail("expected paths must be absolute");
  }
  if (
    !Number.isInteger(expected.serverPort) ||
    !Number.isInteger(expected.hostDaemonPort)
  ) {
    fail("expected ports must be integers");
  }

  requireExactKeys(
    plist,
    [
      "KeepAlive",
      "Label",
      "ProgramArguments",
      "RunAtLoad",
      "StandardErrorPath",
      "StandardOutPath",
      "ThrottleInterval",
      "WorkingDirectory",
    ],
    "root",
  );

  const label = requireString(plist.Label, "Label");
  if (!/^de\.staufingers\.bb-coordinator-[a-z0-9]+$/u.test(label)) {
    fail(
      `Label ${JSON.stringify(label)} is outside the BB Mesh coordinator namespace`,
    );
  }
  const labelSuffix = label.slice(LABEL_PREFIX.length);
  const executable = join(appBundle, "Contents", "MacOS", "BB Mesh");
  const bridge = join(
    appBundle,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "bb-app-bridge.mjs",
  );
  const expectedArguments = [
    "/bin/sh",
    "-c",
    NAS_COORDINATOR_LAUNCH_SHELL,
    "bb-mesh-coordinator",
    `HOME=${homeDirectory}`,
    `USER=${userName}`,
    `LOGNAME=${userName}`,
    "SHELL=/bin/zsh",
    `PATH=${homeDirectory}/${TOOLCHAIN_PATH_SUFFIX}`,
    "TMPDIR=/private/tmp",
    "ELECTRON_RUN_AS_NODE=1",
    executable,
    bridge,
    `--data-dir=${dataDirectory}`,
    "--server-bind-host=127.0.0.1",
    `--server-port=${expected.serverPort}`,
    `--host-daemon-port=${expected.hostDaemonPort}`,
  ];
  if (
    !Array.isArray(plist.ProgramArguments) ||
    plist.ProgramArguments.length !== expectedArguments.length ||
    plist.ProgramArguments.some(
      (argument, index) => argument !== expectedArguments[index],
    )
  ) {
    fail(
      "ProgramArguments do not identify the exact signed coordinator runtime",
    );
  }

  requireEqual(plist.KeepAlive, true, "KeepAlive");
  requireEqual(plist.RunAtLoad, true, "RunAtLoad");
  requireEqual(plist.ThrottleInterval, 10, "ThrottleInterval");
  requireEqual(plist.WorkingDirectory, homeDirectory, "WorkingDirectory");
  requireEqual(
    plist.StandardOutPath,
    join(
      dataDirectory,
      "logs",
      `coordinator-${labelSuffix}-launchd.stdout.log`,
    ),
    "StandardOutPath",
  );
  requireEqual(
    plist.StandardErrorPath,
    join(
      dataDirectory,
      "logs",
      `coordinator-${labelSuffix}-launchd.stderr.log`,
    ),
    "StandardErrorPath",
  );

  return { label };
}

async function main() {
  const [
    plistPath,
    appBundle,
    dataDirectory,
    serverPortRaw,
    hostDaemonPortRaw,
  ] = process.argv.slice(2);
  if (
    plistPath === undefined ||
    appBundle === undefined ||
    dataDirectory === undefined ||
    serverPortRaw === undefined ||
    hostDaemonPortRaw === undefined ||
    process.argv.length !== 7
  ) {
    throw new Error(
      "Usage: verify-nas-coordinator-launch-agent.mjs <plist> <app-bundle> <data-directory> <server-port> <host-daemon-port>",
    );
  }
  const { stdout } = await execFileAsync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", plistPath],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  const result = validateNasCoordinatorLaunchAgent(JSON.parse(stdout), {
    appBundle,
    dataDirectory,
    homeDirectory: process.env.HOME,
    hostDaemonPort: Number(hostDaemonPortRaw),
    serverPort: Number(serverPortRaw),
    userName: process.env.USER,
  });
  process.stdout.write(`${result.label}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
