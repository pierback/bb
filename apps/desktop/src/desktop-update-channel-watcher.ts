import { readFile, watchFile, unwatchFile } from "node:fs";
import {
  parseBbMeshDesktopUpdateChannelPreference,
  type BbDesktopUpdateChannel,
} from "@bb/desktop-contract";

const UPDATE_CHANNEL_WATCH_INTERVAL_MS = 250;
const UPDATE_CHANNEL_RETRY_INTERVAL_MS = 1_000;

export interface DesktopUpdateChannelWatcher {
  close(): void;
}

export interface DesktopUpdateChannelWatchAdapter {
  read(path: string): Promise<string>;
  start(path: string, listener: () => void): void;
  stop(path: string, listener: () => void): void;
}

export interface StartDesktopUpdateChannelWatcherArgs {
  adapter?: DesktopUpdateChannelWatchAdapter;
  logger: { warn(message: string): void };
  onChannel(channel: BbDesktopUpdateChannel): Promise<void>;
  retryDelayMs?: number;
  storagePath: string;
}

const defaultAdapter: DesktopUpdateChannelWatchAdapter = {
  read: (path) =>
    new Promise<string>((resolve, reject) => {
      readFile(path, "utf8", (error, data) =>
        error ? reject(error) : resolve(data),
      );
    }),
  start(path, listener) {
    watchFile(
      path,
      { interval: UPDATE_CHANNEL_WATCH_INTERVAL_MS, persistent: false },
      listener,
    );
  },
  stop(path, listener) {
    unwatchFile(path, listener);
  },
};

export function startDesktopUpdateChannelWatcher(
  args: StartDesktopUpdateChannelWatcherArgs,
): DesktopUpdateChannelWatcher {
  const adapter = args.adapter ?? defaultAdapter;
  let stopped = false;
  let desiredChannel: BbDesktopUpdateChannel | null = null;
  let lastWarnedChannel: BbDesktopUpdateChannel | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let transitionTail: Promise<void> = Promise.resolve();

  function clearRetry(): void {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function queueApply(): void {
    transitionTail = transitionTail.then(applyDesiredChannel);
  }

  function scheduleRetry(): void {
    if (stopped || desiredChannel === null || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      queueApply();
    }, args.retryDelayMs ?? UPDATE_CHANNEL_RETRY_INTERVAL_MS);
    retryTimer.unref();
  }

  async function applyDesiredChannel(): Promise<void> {
    if (stopped || desiredChannel === null) return;
    const channel = desiredChannel;
    try {
      await args.onChannel(channel);
    } catch (error) {
      if (lastWarnedChannel !== channel) {
        args.logger.warn(
          `Could not apply the externally selected BB Mesh update channel: ${formatError(
            error,
          )}`,
        );
        lastWarnedChannel = channel;
      }
      scheduleRetry();
      return;
    }

    if (desiredChannel === channel) {
      desiredChannel = null;
    }
    lastWarnedChannel = null;
    clearRetry();
  }

  const handleChange = (): void => {
    transitionTail = transitionTail.then(async () => {
      if (stopped) return;
      let channel: BbDesktopUpdateChannel;
      try {
        channel = parseBbMeshDesktopUpdateChannelPreference(
          await adapter.read(args.storagePath),
        );
      } catch (error) {
        args.logger.warn(
          `Could not read the externally selected BB Mesh update channel: ${formatError(error)}`,
        );
        return;
      }
      desiredChannel = channel;
      if (lastWarnedChannel !== channel) {
        lastWarnedChannel = null;
      }
      clearRetry();
      await applyDesiredChannel();
    });
  };

  adapter.start(args.storagePath, handleChange);
  return {
    close() {
      if (stopped) return;
      stopped = true;
      clearRetry();
      adapter.stop(args.storagePath, handleChange);
    },
  };
}
