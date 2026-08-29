import { describe, expect, it } from "vitest";
import {
  canAttachToDesktopRuntime,
  createDesktopRuntimeProcessEnv,
  resolveDesktopRuntimeProfile,
} from "../src/desktop-runtime-profile.js";
import { DEFAULT_BB_SERVER_PORT } from "../src/types.js";

describe("desktop runtime profile", () => {
  it("isolates the packaged release from official bb", () => {
    const profile = resolveDesktopRuntimeProfile({
      allowPackagedPortOverrides: false,
      buildFlavor: "release",
      env: {},
      homeDir: "/Users/example",
      isPackaged: true,
      userDataPath: "/Users/example/Library/Application Support/BB Mesh",
    });

    expect(profile).toEqual({
      dataDir: "/Users/example/Library/Application Support/BB Mesh/runtime",
      hostDaemonPort: 39_887,
      serverPort: 39_886,
      serverUrl: "http://127.0.0.1:39886",
    });
    expect(profile.serverPort).not.toBe(DEFAULT_BB_SERVER_PORT);
    expect(profile.dataDir).not.toBe("/Users/example/.bb");
  });

  it("keeps preview isolated from both release and official bb", () => {
    const profile = resolveDesktopRuntimeProfile({
      allowPackagedPortOverrides: false,
      buildFlavor: "preview",
      env: {},
      homeDir: "/Users/example",
      isPackaged: true,
      userDataPath:
        "/Users/example/Library/Application Support/BB Mesh Preview",
    });

    expect(profile).toEqual({
      dataDir:
        "/Users/example/Library/Application Support/BB Mesh Preview/runtime",
      hostDaemonPort: 39_889,
      serverPort: 39_888,
      serverUrl: "http://127.0.0.1:39888",
    });
  });

  it("retains the configured worktree runtime in development", () => {
    const profile = resolveDesktopRuntimeProfile({
      allowPackagedPortOverrides: false,
      buildFlavor: "release",
      env: {
        BB_DATA_DIR: "~/bb-dev-data",
        BB_HOST_DAEMON_PORT: "48887",
        BB_SERVER_PORT: "48886",
      },
      homeDir: "/Users/example",
      isPackaged: false,
      userDataPath: "/tmp/bb-dev-desktop",
    });

    expect(profile).toEqual({
      dataDir: "/Users/example/bb-dev-data",
      hostDaemonPort: 48_887,
      serverPort: 48_886,
      serverUrl: "http://127.0.0.1:48886",
    });
  });

  it("forces the owned runtime process onto the resolved profile", () => {
    const profile = resolveDesktopRuntimeProfile({
      allowPackagedPortOverrides: false,
      buildFlavor: "release",
      env: {},
      homeDir: "/Users/example",
      isPackaged: true,
      userDataPath: "/Users/example/Library/Application Support/BB Mesh",
    });

    expect(
      createDesktopRuntimeProcessEnv({
        env: {
          BB_DATA_DIR: "/Users/example/.bb",
          BB_HOST_DAEMON_PORT: "38887",
          BB_SERVER_PORT: "38886",
          KEEP_ME: "yes",
        },
        profile,
      }),
    ).toMatchObject({
      BB_DATA_DIR: "/Users/example/Library/Application Support/BB Mesh/runtime",
      BB_HOST_DAEMON_PORT: "39887",
      BB_SERVER_PORT: "39886",
      KEEP_ME: "yes",
    });
  });

  it("fails closed instead of attaching packaged Mesh to official bb", () => {
    const profile = resolveDesktopRuntimeProfile({
      allowPackagedPortOverrides: false,
      buildFlavor: "release",
      env: {},
      homeDir: "/Users/example",
      isPackaged: true,
      userDataPath: "/Users/example/Library/Application Support/BB Mesh",
    });

    expect(
      canAttachToDesktopRuntime({
        allowForeignRuntime: false,
        dataDir: "/Users/example/.bb",
        isPackaged: true,
        profile,
      }),
    ).toBe(false);
    expect(
      canAttachToDesktopRuntime({
        allowForeignRuntime: false,
        dataDir: profile.dataDir,
        isPackaged: true,
        profile,
      }),
    ).toBe(true);
  });

  it("ignores inherited port overrides in packaged builds", () => {
    expect(
      resolveDesktopRuntimeProfile({
        allowPackagedPortOverrides: false,
        buildFlavor: "release",
        env: {
          BB_HOST_DAEMON_PORT: "38887",
          BB_SERVER_PORT: "38886",
        },
        homeDir: "/Users/example",
        isPackaged: true,
        userDataPath: "/tmp/bb-mesh",
      }),
    ).toMatchObject({
      hostDaemonPort: 39_887,
      serverPort: 39_886,
    });
  });

  it("allows the explicit packaged smoke harness to select its stub port", () => {
    expect(
      resolveDesktopRuntimeProfile({
        allowPackagedPortOverrides: true,
        buildFlavor: "release",
        env: {
          BB_HOST_DAEMON_PORT: "49887",
          BB_SERVER_PORT: "49886",
        },
        homeDir: "/Users/example",
        isPackaged: true,
        userDataPath: "/tmp/bb-mesh-smoke",
      }),
    ).toMatchObject({
      hostDaemonPort: 49_887,
      serverPort: 49_886,
      serverUrl: "http://127.0.0.1:49886",
    });
  });
});
