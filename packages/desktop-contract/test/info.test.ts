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
  it("accepts the strict Pierback update state", () => {
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
});
