import { describe, expect, it } from "vitest";
import {
  resolveDesktopBridgePath,
  resolveDesktopIconPath,
  resolveDesktopRendererAssetsPath,
  type DesktopPathContext,
} from "../src/app-paths.js";

describe("desktop app paths", () => {
  it("resolves the packaged bb-app bridge beside the active asar", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Pierback.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Pierback.app/Contents/Resources",
    };

    expect(resolveDesktopBridgePath({ paths })).toBe(
      "/Applications/Pierback.app/Contents/Resources/app.asar.unpacked/dist/bb-app-bridge.mjs",
    );
  });

  it("resolves the universal packaged bb-app bridge beside the selected arch asar", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Pierback.app/Contents/Resources/app-arm64.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Pierback.app/Contents/Resources",
    };

    expect(resolveDesktopBridgePath({ paths })).toBe(
      "/Applications/Pierback.app/Contents/Resources/app-arm64.asar.unpacked/dist/bb-app-bridge.mjs",
    );
  });

  it("resolves packaged renderer assets without a running coordinator", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Pierback.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Pierback.app/Contents/Resources",
    };

    expect(resolveDesktopRendererAssetsPath({ paths })).toBe(
      "/Applications/Pierback.app/Contents/Resources/app.asar/node_modules/bb-app/app/dist",
    );
  });

  it("resolves development renderer assets from the workspace dependency", () => {
    const paths: DesktopPathContext = {
      appPath: "/checkout/apps/desktop",
      isPackaged: false,
      resourcesPath: "/checkout/apps/desktop",
    };

    expect(resolveDesktopRendererAssetsPath({ paths })).toBe(
      "/checkout/apps/desktop/node_modules/bb-app/app/dist",
    );
  });

  it("uses the release-specific icon inside packaged apps", () => {
    const paths: DesktopPathContext = {
      appPath: "/Applications/Pierback Preview.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Pierback Preview.app/Contents/Resources",
    };

    expect(
      resolveDesktopIconPath({
        packagedIconFileName: "icon-nightly.png",
        paths,
      }),
    ).toBe(
      "/Applications/Pierback Preview.app/Contents/Resources/app.asar/assets/icon-nightly.png",
    );
  });

  it("keeps the development icon independent of the release channel", () => {
    const paths: DesktopPathContext = {
      appPath: "/checkout/apps/desktop",
      isPackaged: false,
      resourcesPath: "/checkout/apps/desktop",
    };

    expect(
      resolveDesktopIconPath({
        packagedIconFileName: "icon-nightly.png",
        paths,
      }),
    ).toBe("/checkout/apps/desktop/assets/icon-dev.png");
  });
});
