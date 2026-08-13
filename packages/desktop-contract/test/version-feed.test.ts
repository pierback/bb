import { describe, expect, it } from "vitest";
import {
  bbDesktopInfoSchema,
  bbDesktopThemeSchema,
  bbDesktopVersionFeedSchema,
  bbDesktopWindowStateSchema,
} from "../src/index.js";

const checkedAt = "2026-05-21T00:00:00.000Z";

describe("desktop info schema", () => {
  it("accepts the desktop update info payload", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        downloadState: "idle",
        lastCheckedAt: checkedAt,
        latestVersion: "0.0.2",
        pendingVersion: null,
        platform: "macos",
        updateAvailable: true,
        updateChannel: "stable",
        updateDownloaded: false,
        updatesEnabled: true,
        version: "0.0.1",
      }).success,
    ).toBe(true);
  });

  it("accepts the desktop theme values", () => {
    expect(bbDesktopThemeSchema.safeParse("dark").success).toBe(true);
    expect(bbDesktopThemeSchema.safeParse("light").success).toBe(true);
    expect(bbDesktopThemeSchema.safeParse("system").success).toBe(true);
    expect(
      bbDesktopThemeSchema.safeParse({
        canvasColor: "oklch(0.195 0 0)",
        inkColor: "oklch(0.81 0 0)",
        mode: "dark",
      }).success,
    ).toBe(false);
  });

  it("accepts strict desktop window state payloads", () => {
    expect(
      bbDesktopWindowStateSchema.safeParse({ isFullScreen: true }).success,
    ).toBe(true);
    expect(
      bbDesktopWindowStateSchema.safeParse({
        isFullScreen: true,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("desktop version feed schema", () => {
  it("accepts a valid desktop-version.json payload", () => {
    expect(
      bbDesktopVersionFeedSchema.safeParse({
        channel: "stable",
        files: [
          {
            sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
            size: 123456789,
            url: "pierback-0.0.2-arm64.zip",
          },
        ],
        minimumSystemVersion: null,
        path: "pierback-0.0.2-arm64.zip",
        platform: "macos",
        releaseDate: checkedAt,
        releaseName: "Pierback Desktop 0.0.2",
        releaseNotes: null,
        schemaVersion: 1,
        sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
        stagingPercentage: null,
        version: "0.0.2",
      }).success,
    ).toBe(true);
  });

  it("accepts the Pierback canary desktop channel", () => {
    expect(
      bbDesktopVersionFeedSchema.safeParse({
        channel: "canary",
        files: [
          {
            sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
            size: 123456789,
            url: "pierback-0.0.2-arm64.zip",
          },
        ],
        minimumSystemVersion: null,
        path: "pierback-0.0.2-arm64.zip",
        platform: "macos",
        releaseDate: checkedAt,
        releaseName: "Pierback Desktop 0.0.2",
        releaseNotes: null,
        schemaVersion: 1,
        sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
        stagingPercentage: null,
        version: "0.0.2",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed version feed payloads", () => {
    expect(
      bbDesktopVersionFeedSchema.safeParse({
        channel: "stable",
        files: [],
        minimumSystemVersion: null,
        path: "bb-0.0.2-universal.zip",
        platform: "macos",
        releaseDate: checkedAt,
        releaseName: "Pierback Desktop 0.0.2",
        releaseNotes: null,
        schemaVersion: 1,
        sha512: "BASE64_SHA512_FROM_ELECTRON_BUILDER",
        stagingPercentage: null,
        version: "0.0.2",
      }).success,
    ).toBe(false);
  });
});
