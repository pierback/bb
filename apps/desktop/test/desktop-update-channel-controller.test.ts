import { describe, expect, it, vi } from "vitest";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import type { DesktopAutoUpdateService } from "../src/desktop-auto-update.js";
import type { DesktopUpdateService } from "../src/desktop-update-check.js";
import { createDesktopUpdateChannelController } from "../src/desktop-update-channel-controller.js";
import type { DesktopUpdateChannelStore } from "../src/desktop-update-channel-store.js";

function createInfo(channel: "canary" | "stable"): BbDesktopInfo {
  return {
    downloadState: "idle",
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform: "macos",
    updatesEnabled: true,
    updateAvailable: false,
    updateChannel: channel,
    updateDownloaded: false,
    version: "1.0.0",
  };
}

function createServices() {
  const updateTargets: unknown[] = [];
  const autoTargets: unknown[] = [];
  const serviceBase = {
    checkAfterActive: vi.fn(),
    checkForUpdates: vi.fn(),
    getInfo: vi.fn(() => createInfo("stable")),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  };
  const updateService: DesktopUpdateService = {
    ...serviceBase,
    setUpdateTarget(target) {
      updateTargets.push(target);
    },
  };
  const autoUpdateService: DesktopAutoUpdateService = {
    ...serviceBase,
    assertUpdateTargetCanChange: vi.fn(),
    installUpdate: vi.fn(),
    setUpdateTarget(target) {
      autoTargets.push(target);
    },
  };
  return { autoTargets, autoUpdateService, updateService, updateTargets };
}

function createStore(
  setChannel: DesktopUpdateChannelStore["setChannel"] = async () => undefined,
): DesktopUpdateChannelStore {
  let channel: "canary" | "stable" = "stable";
  return {
    adoptChannel(nextChannel) {
      channel = nextChannel;
    },
    getChannel() {
      return channel;
    },
    async load() {},
    async setChannel(nextChannel) {
      await setChannel(nextChannel);
      channel = nextChannel;
    },
  };
}

describe("desktop update channel controller", () => {
  it("serializes overlapping changes so the latest requested channel wins", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    const services = createServices();
    const store = createStore(async () => {
      writeCount += 1;
      if (writeCount === 1) {
        await firstWrite;
      }
    });
    const controller = createDesktopUpdateChannelController({
      autoUpdateService: services.autoUpdateService,
      channelStore: store,
      platform: "macos",
      updateService: services.updateService,
    });

    const selectCanary = controller.setChannel("canary");
    const selectStable = controller.setChannel("stable");
    releaseFirstWrite?.();
    await Promise.all([selectCanary, selectStable]);

    expect(controller.getChannel()).toBe("stable");
    expect(
      services.autoTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary", "stable"]);
    expect(
      services.updateTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary", "stable"]);
  });

  it("moves both live update clients to the Pierback canary feed and commits the preference", async () => {
    const services = createServices();
    const store = createStore();
    const controller = createDesktopUpdateChannelController({
      autoUpdateService: services.autoUpdateService,
      channelStore: store,
      platform: "macos",
      updateService: services.updateService,
    });

    await controller.setChannel("canary");

    expect(controller.getChannel()).toBe("canary");
    expect(services.autoTargets).toEqual([
      {
        channel: "canary",
        provider: "generic",
        url: "https://updates.bb.staufingers.de/canary/",
      },
    ]);
    expect(services.updateTargets).toEqual([
      {
        channel: "canary",
        feedUrl:
          "https://updates.bb.staufingers.de/canary/desktop-version.json",
      },
    ]);
  });

  it("reconciles an already-persisted external selection without rewriting it", async () => {
    const services = createServices();
    const persist = vi.fn(async () => undefined);
    const store = createStore(persist);
    const controller = createDesktopUpdateChannelController({
      autoUpdateService: services.autoUpdateService,
      channelStore: store,
      platform: "macos",
      updateService: services.updateService,
    });

    await controller.reconcilePersistedChannel("canary");

    expect(controller.getChannel()).toBe("canary");
    expect(persist).not.toHaveBeenCalled();
    expect(
      services.autoTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary"]);
    expect(
      services.updateTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary"]);
  });

  it("rolls both live clients back when the preference cannot be committed", async () => {
    const services = createServices();
    const store = createStore(async () => {
      throw new Error("read-only disk");
    });
    const controller = createDesktopUpdateChannelController({
      autoUpdateService: services.autoUpdateService,
      channelStore: store,
      platform: "macos",
      updateService: services.updateService,
    });

    await expect(controller.setChannel("canary")).rejects.toThrow(
      "read-only disk",
    );

    expect(controller.getChannel()).toBe("stable");
    expect(
      services.autoTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary", "stable"]);
    expect(
      services.updateTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary", "stable"]);
  });

  it("rolls the native updater back when the version-feed target rejects the transition", async () => {
    const services = createServices();
    services.updateService.setUpdateTarget = (target) => {
      services.updateTargets.push(target);
      if (target.channel === "canary") {
        throw new Error("invalid feed target");
      }
    };
    const store = createStore();
    const controller = createDesktopUpdateChannelController({
      autoUpdateService: services.autoUpdateService,
      channelStore: store,
      platform: "macos",
      updateService: services.updateService,
    });

    await expect(controller.setChannel("canary")).rejects.toThrow(
      "invalid feed target",
    );

    expect(controller.getChannel()).toBe("stable");
    expect(
      services.autoTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary", "stable"]);
    expect(
      services.updateTargets.map(
        (target) => (target as { channel: string }).channel,
      ),
    ).toEqual(["canary", "stable"]);
  });
});
