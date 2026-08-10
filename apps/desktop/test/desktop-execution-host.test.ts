import { describe, expect, it } from "vitest";
import {
  DESKTOP_EXECUTION_DAEMON_PATH_ENV,
  resolveDesktopExecutionDaemonOverride,
} from "../src/desktop-execution-host.js";

describe("resolveDesktopExecutionDaemonOverride", () => {
  it("uses only an explicit absolute local daemon path", () => {
    expect(resolveDesktopExecutionDaemonOverride({})).toBeNull();
    expect(
      resolveDesktopExecutionDaemonOverride({
        [DESKTOP_EXECUTION_DAEMON_PATH_ENV]:
          "  /Applications/bb.app/daemon-bundle.mjs  ",
      }),
    ).toBe("/Applications/bb.app/daemon-bundle.mjs");
    expect(() =>
      resolveDesktopExecutionDaemonOverride({
        [DESKTOP_EXECUTION_DAEMON_PATH_ENV]: "./downloaded-daemon.mjs",
      }),
    ).toThrow(`${DESKTOP_EXECUTION_DAEMON_PATH_ENV} must be absolute`);
  });
});
