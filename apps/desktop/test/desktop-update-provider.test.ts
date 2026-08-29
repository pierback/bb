import { describe, expect, it } from "vitest";
import {
  createDesktopVersionFeedUrl,
  resolveDesktopUserDataPath,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";

describe("desktop user data path", () => {
  it("uses the BB Mesh release and preview identities", () => {
    const appDataPath = "/Users/example/Library/Application Support";

    expect(
      resolveDesktopUserDataPath({ appDataPath, buildFlavor: "release" }),
    ).toBe("/Users/example/Library/Application Support/BB Mesh");
    expect(
      resolveDesktopUserDataPath({ appDataPath, buildFlavor: "preview" }),
    ).toBe("/Users/example/Library/Application Support/BB Mesh Preview");
  });
});

describe("desktop update feed url", () => {
  it("gives each platform its own feed file inside one release tag", () => {
    // macOS and Linux assets share each BB Mesh channel, so a single
    // feed name would make the last publish overwrite the other platform.
    expect(createDesktopVersionFeedUrl("stable", "macos")).toBe(
      "https://updates.bb.staufingers.de/stable/desktop-version.json",
    );
    expect(createDesktopVersionFeedUrl("canary", "linux")).toBe(
      "https://updates.bb.staufingers.de/canary/desktop-version-linux.json",
    );
  });
});

const APP_IMAGE_PATH = "/home/user/Apps/bb-0.37.0-x86_64.AppImage";
const alwaysReplaceable = () => true;
const neverReplaceable = () => false;

describe("desktop update support", () => {
  it("enables both update paths on macOS", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: neverReplaceable,
        env: {},
        platform: "macos",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });

  it("installs updates on Linux only inside an AppImage", () => {
    // electron-updater replaces the running AppImage file in place. A distro
    // package or an extracted directory has nothing to replace, so it would
    // fail every download instead of quietly doing nothing.
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: {},
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: "  " },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
  });

  it("refuses to install into an AppImage it cannot replace", () => {
    // electron-updater unlinks the running AppImage before moving the new one
    // in, so attempting this in a read-only directory deletes the user's app
    // and leaves nothing behind. Version checks must survive that.
    const checked: Array<string> = [];

    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: (path) => {
          checked.push(path);
          return false;
        },
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "linux",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(checked).toEqual([APP_IMAGE_PATH]);
  });

  it("does not consult the filesystem on macOS", () => {
    // macOS installs through Squirrel, which owns its own replacement path.
    let consulted = false;

    resolveDesktopUpdateSupport({
      canReplaceAppImage: () => {
        consulted = true;
        return true;
      },
      env: { APPIMAGE: APP_IMAGE_PATH },
      platform: "macos",
    });

    expect(consulted).toBe(false);
  });
});
