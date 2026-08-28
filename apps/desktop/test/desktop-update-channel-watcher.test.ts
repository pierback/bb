import { describe, expect, it, vi } from "vitest";
import { serializePierbackDesktopUpdateChannelPreference } from "@bb/desktop-contract";
import {
  startDesktopUpdateChannelWatcher,
  type DesktopUpdateChannelWatchAdapter,
} from "../src/desktop-update-channel-watcher.js";

describe("desktop update channel watcher", () => {
  it("applies SDK and CLI preference writes while Pierback is running", async () => {
    let listener: (() => void) | undefined;
    const adapter: DesktopUpdateChannelWatchAdapter = {
      read: vi.fn(async () =>
        serializePierbackDesktopUpdateChannelPreference("canary"),
      ),
      start: vi.fn((_path, nextListener) => {
        listener = nextListener;
      }),
      stop: vi.fn(),
    };
    const onChannel = vi.fn(async () => undefined);
    const watcher = startDesktopUpdateChannelWatcher({
      adapter,
      logger: { warn: vi.fn() },
      onChannel,
      storagePath: "/tmp/desktop-update-channel.json",
    });

    listener?.();
    await vi.waitFor(() => expect(onChannel).toHaveBeenCalledWith("canary"));
    watcher.close();

    expect(adapter.stop).toHaveBeenCalledOnce();
  });

  it("retains and retries a selection that the busy updater initially rejects", async () => {
    vi.useFakeTimers();
    try {
      let listener: (() => void) | undefined;
      const adapter: DesktopUpdateChannelWatchAdapter = {
        read: vi.fn(async () =>
          serializePierbackDesktopUpdateChannelPreference("canary"),
        ),
        start: vi.fn((_path, nextListener) => {
          listener = nextListener;
        }),
        stop: vi.fn(),
      };
      const onChannel = vi
        .fn<(_: "canary" | "stable") => Promise<void>>()
        .mockRejectedValueOnce(new Error("updater is busy"))
        .mockResolvedValue(undefined);
      const logger = { warn: vi.fn() };
      const watcher = startDesktopUpdateChannelWatcher({
        adapter,
        logger,
        onChannel,
        retryDelayMs: 10,
        storagePath: "/tmp/desktop-update-channel.json",
      });

      listener?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(onChannel).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10);
      expect(onChannel).toHaveBeenCalledTimes(2);
      expect(onChannel).toHaveBeenLastCalledWith("canary");
      watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending retry when the watcher closes", async () => {
    vi.useFakeTimers();
    try {
      let listener: (() => void) | undefined;
      const adapter: DesktopUpdateChannelWatchAdapter = {
        read: vi.fn(async () =>
          serializePierbackDesktopUpdateChannelPreference("canary"),
        ),
        start: vi.fn((_path, nextListener) => {
          listener = nextListener;
        }),
        stop: vi.fn(),
      };
      const onChannel = vi.fn(async () => {
        throw new Error("updater is busy");
      });
      const watcher = startDesktopUpdateChannelWatcher({
        adapter,
        logger: { warn: vi.fn() },
        onChannel,
        retryDelayMs: 10,
        storagePath: "/tmp/desktop-update-channel.json",
      });

      listener?.();
      await vi.advanceTimersByTimeAsync(0);
      watcher.close();
      await vi.advanceTimersByTimeAsync(10);

      expect(onChannel).toHaveBeenCalledOnce();
      expect(adapter.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
