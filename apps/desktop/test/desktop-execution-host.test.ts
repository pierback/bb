import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_EXECUTION_DAEMON_PATH_ENV,
  readDesktopExecutionHostAuth,
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

  it("keeps the native coordinator host key scoped to the server origin", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "bb-desktop-host-auth-"));
    const serverUrl = "https://bb.example.test/path-is-not-identity";
    const originHash = createHash("sha256")
      .update(new URL(serverUrl).origin)
      .digest("hex")
      .slice(0, 16);
    const dataDir = join(userDataPath, "execution-hosts", originHash);
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, "auth.json"),
        JSON.stringify({ hostId: "host_desktop", hostKey: "host-key" }),
      );

      await expect(
        readDesktopExecutionHostAuth({ serverUrl, userDataPath }),
      ).resolves.toEqual({ hostId: "host_desktop", hostKey: "host-key" });

      await writeFile(
        join(dataDir, "auth.json"),
        JSON.stringify({ hostId: "host_desktop" }),
      );
      await expect(
        readDesktopExecutionHostAuth({ serverUrl, userDataPath }),
      ).resolves.toBeNull();
    } finally {
      await rm(userDataPath, { force: true, recursive: true });
    }
  });
});
