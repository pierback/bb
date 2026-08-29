import { describe, expect, it } from "vitest";
import { bbDesktopInfoSchema } from "../src/info.js";

const baseInfo = {
  downloadState: "idle",
  lastCheckedAt: null,
  latestVersion: "0.0.32",
  pendingVersion: null,
  platform: "macos",
  updatesEnabled: true,
  updateAvailable: true,
  updateChannel: "stable",
  updateDownloaded: false,
  version: "0.0.31",
} as const;

describe("bbDesktopInfoSchema", () => {
  it("accepts the strict BB Mesh update state", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        downloadState: "downloading",
      }).success,
    ).toBe(true);
  });

  it("rejects the retired shell payload without channel, availability, or download state", () => {
    const {
      downloadState: _downloadState,
      updateChannel: _updateChannel,
      updatesEnabled: _updatesEnabled,
      ...retiredInfo
    } = baseInfo;
    expect(bbDesktopInfoSchema.safeParse(retiredInfo).success).toBe(false);
  });

  it("rejects an unknown download state", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        downloadState: "available",
      }).success,
    ).toBe(false);
  });

  it("accepts linux", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "linux",
      }).success,
    ).toBe(true);
  });

  it("rejects win32", () => {
    expect(
      bbDesktopInfoSchema.safeParse({
        ...baseInfo,
        platform: "win32",
      }).success,
    ).toBe(false);
  });
});
