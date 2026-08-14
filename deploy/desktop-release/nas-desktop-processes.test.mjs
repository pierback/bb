import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const processModulePath = fileURLToPath(
  new URL("./nas-desktop-processes.sh", import.meta.url),
);

async function runQuiescenceHarness({
  maximumAttempts,
  quietPolls,
  signal,
  states,
}) {
  const { stdout } = await execFileAsync(
    "/bin/bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'source "$1"',
        `IFS=',' read -r -a states <<< "$TEST_STATES"`,
        "state_index=0",
        "signals=()",
        "",
        "pierback_desktop_processes_are_running() {",
        '  [[ "${states[$state_index]:-down}" == "process" ]]',
        "}",
        "",
        "pierback_desktop_coordinator_is_healthy() {",
        '  [[ "${states[$state_index]:-down}" == "healthy" ]]',
        "}",
        "",
        "pierback_signal_desktop_processes() {",
        '  signals+=("$1@$state_index")',
        "}",
        "",
        "sleep() {",
        "  state_index=$((state_index + 1))",
        "}",
        "",
        "if pierback_wait_for_desktop_process_quiescence \\",
        '  "$TEST_MAXIMUM_ATTEMPTS" \\',
        '  "$TEST_SIGNAL" \\',
        '  "$TEST_QUIET_POLLS"; then',
        '  result="success"',
        "else",
        '  result="failure"',
        "fi",
        "",
        "printf 'result=%s\\nstate_index=%s\\nsignals=%s\\n' \\",
        '  "$result" \\',
        '  "$state_index" \\',
        '  "${signals[*]:-}"',
      ].join("\n"),
      "nas-desktop-process-test",
      processModulePath,
    ],
    {
      env: {
        ...process.env,
        TEST_MAXIMUM_ATTEMPTS: String(maximumAttempts),
        TEST_QUIET_POLLS: String(quietPolls),
        TEST_SIGNAL: signal,
        TEST_STATES: states.join(","),
      },
    },
  );

  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  );
}

test("signals every observed process generation before declaring quiescence", async () => {
  const result = await runQuiescenceHarness({
    maximumAttempts: 5,
    quietPolls: 3,
    signal: "KILL",
    states: ["process", "process", "down", "down", "down"],
  });

  assert.deepEqual(result, {
    result: "success",
    signals: "KILL@0 KILL@1",
    state_index: "4",
  });
});

test("a replacement process resets the consecutive quiet observation window", async () => {
  const result = await runQuiescenceHarness({
    maximumAttempts: 6,
    quietPolls: 3,
    signal: "TERM",
    states: ["down", "down", "process", "down", "down", "down"],
  });

  assert.deepEqual(result, {
    result: "success",
    signals: "TERM@2",
    state_index: "5",
  });
});

test("fails closed when an unmatched coordinator keeps the port healthy", async () => {
  const { stdout } = await execFileAsync("/bin/bash", [
    "-c",
    [
      "set -euo pipefail",
      'source "$1"',
      "state_index=0",
      "pierback_desktop_processes_are_running() { return 1; }",
      "pierback_desktop_runtime_is_recorded() { return 1; }",
      "pierback_desktop_coordinator_is_healthy() { return 0; }",
      "pierback_signal_desktop_processes() { return 0; }",
      "pierback_stop_desktop_runtimes() { return 0; }",
      "sleep() { state_index=$((state_index + 1)); }",
      "if pierback_wait_for_desktop_cutover_quiescence 4 2; then",
      '  result="success"',
      "else",
      '  result="failure"',
      "fi",
      'printf \'result=%s\\nstate_index=%s\\n\' "$result" "$state_index"',
    ].join("\n"),
    "nas-desktop-unknown-listener-test",
    processModulePath,
  ]);

  assert.equal(stdout, "result=failure\nstate_index=4\n");
});

test("stops the supervised runtime only after the legacy GUI can no longer recreate it", async () => {
  const { stdout } = await execFileAsync("/bin/bash", [
    "-c",
    [
      "set -euo pipefail",
      'source "$1"',
      "state_index=0",
      "runtime_running=false",
      "events=()",
      "",
      "pierback_desktop_processes_are_running() {",
      '  [[ "$state_index" -eq 0 ]]',
      "}",
      "",
      "pierback_desktop_coordinator_is_healthy() {",
      '  [[ "$runtime_running" == "true" ]]',
      "}",
      "",
      "pierback_signal_desktop_processes() {",
      '  events+=("signal-$1@$state_index")',
      "  # The old ordering stopped the supervisor first. The exiting GUI then",
      "  # recreated this runtime before the replacement desktop started.",
      "  runtime_running=true",
      "}",
      "",
      "pierback_stop_desktop_runtimes() {",
      '  if [[ "$runtime_running" == "true" ]]; then',
      '    events+=("stop-runtime@$state_index")',
      "    runtime_running=false",
      "  fi",
      "}",
      "",
      "pierback_desktop_runtime_is_recorded() {",
      '  [[ "$runtime_running" == "true" ]]',
      "}",
      "",
      "sleep() {",
      "  state_index=$((state_index + 1))",
      "}",
      "",
      "if pierback_fence_desktop_cutover; then",
      '  result="success"',
      "else",
      '  result="failure"',
      "fi",
      "",
      "printf 'result=%s\\nstate_index=%s\\nevents=%s\\n' \\",
      '  "$result" \\',
      '  "$state_index" \\',
      '  "${events[*]:-}"',
    ].join("\n"),
    "nas-desktop-runtime-order-test",
    processModulePath,
  ]);

  assert.deepEqual(
    Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    ),
    {
      events: "signal-TERM@0 stop-runtime@5",
      result: "success",
      state_index: "10",
    },
  );
});

test("stops a runtime record that appears during the final quiet window", async () => {
  const { stdout } = await execFileAsync("/bin/bash", [
    "-c",
    [
      "set -euo pipefail",
      'source "$1"',
      "state_index=0",
      "runtime_running=false",
      "events=()",
      "",
      "pierback_desktop_processes_are_running() {",
      '  [[ "$state_index" -eq 0 ]]',
      "}",
      "",
      "pierback_desktop_coordinator_is_healthy() {",
      '  [[ "$runtime_running" == "true" ]]',
      "}",
      "",
      "pierback_signal_desktop_processes() {",
      '  events+=("signal-$1@$state_index")',
      "}",
      "",
      "pierback_desktop_runtime_is_recorded() {",
      '  [[ "$runtime_running" == "true" ]]',
      "}",
      "",
      "pierback_stop_desktop_runtimes() {",
      '  events+=("stop-runtime@$state_index")',
      "  runtime_running=false",
      "}",
      "",
      "sleep() {",
      "  state_index=$((state_index + 1))",
      '  if [[ "$state_index" -eq 7 ]]; then',
      "    runtime_running=true",
      "  fi",
      "}",
      "",
      "if pierback_fence_desktop_cutover; then",
      '  result="success"',
      "else",
      '  result="failure"',
      "fi",
      "",
      "printf 'result=%s\\nstate_index=%s\\nevents=%s\\n' \\",
      '  "$result" \\',
      '  "$state_index" \\',
      '  "${events[*]:-}"',
    ].join("\n"),
    "nas-desktop-delayed-runtime-test",
    processModulePath,
  ]);

  assert.deepEqual(
    Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    ),
    {
      events: "signal-TERM@0 stop-runtime@7",
      result: "success",
      state_index: "12",
    },
  );
});
