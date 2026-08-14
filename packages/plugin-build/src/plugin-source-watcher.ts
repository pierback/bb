import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isIgnoredPluginDevPath } from "./plugin-dev-loop.js";

const DEFAULT_POLL_INTERVAL_MS = 250;

type RecursiveWatchListener = (relativePath: string) => void;

export interface RecursivePluginWatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): this;
}

export type RecursivePluginWatchFactory = (
  rootDir: string,
  onChange: RecursiveWatchListener,
) => RecursivePluginWatchHandle;

export type PluginSourceSnapshot = ReadonlyMap<string, string>;

export interface PluginSourceWatcherOptions {
  rootDir: string;
  onChange: RecursiveWatchListener;
  log?: (message: string) => void;
  pollIntervalMs?: number;
  watchFactory?: RecursivePluginWatchFactory;
  readSnapshot?: (rootDir: string) => Promise<PluginSourceSnapshot>;
}

export interface PluginSourceWatcher {
  close(): void;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? error.message : `${code}: ${error.message}`;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function readPluginSourceSnapshot(
  rootDir: string,
): Promise<PluginSourceSnapshot> {
  const snapshot = new Map<string, string>();

  async function visit(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath =
        relativeDirectory.length === 0
          ? entry.name
          : join(relativeDirectory, entry.name);
      if (isIgnoredPluginDevPath(relativePath)) continue;

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }

      try {
        const metadata = await lstat(absolutePath, { bigint: true });
        snapshot.set(
          relativePath,
          `${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${metadata.mode}`,
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  await visit(rootDir, "");
  return snapshot;
}

function defaultWatchFactory(
  rootDir: string,
  onChange: RecursiveWatchListener,
): FSWatcher {
  return watch(rootDir, { recursive: true }, (_event, filename) => {
    if (typeof filename === "string" && filename.length > 0) {
      onChange(filename);
    }
  });
}

function changedPaths(
  previous: PluginSourceSnapshot,
  next: PluginSourceSnapshot,
): string[] {
  const changed: string[] = [];
  for (const [relativePath, fingerprint] of next) {
    if (previous.get(relativePath) !== fingerprint) changed.push(relativePath);
  }
  for (const relativePath of previous.keys()) {
    if (!next.has(relativePath)) changed.push(relativePath);
  }
  return changed;
}

/**
 * Watches plugin sources with the platform's recursive watcher when possible.
 * Resource exhaustion and platform watcher failures transparently cut over to
 * a bounded polling adapter so development reloads remain available.
 */
export async function createPluginSourceWatcher(
  options: PluginSourceWatcherOptions,
): Promise<PluginSourceWatcher> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const watchFactory = options.watchFactory ?? defaultWatchFactory;
  const readSnapshot = options.readSnapshot ?? readPluginSourceSnapshot;
  let closed = false;
  let nativeWatcher: RecursivePluginWatchHandle | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingStarted = false;
  let fallbackPromise: Promise<void> | null = null;
  let snapshot: PluginSourceSnapshot = new Map();
  let lastPollingError: string | null = null;

  const initialSnapshotReady = (async () => {
    try {
      snapshot = await readSnapshot(options.rootDir);
    } catch (error) {
      options.log?.(`initial source scan failed: ${errorMessage(error)}`);
    }
  })();

  function schedulePoll(): void {
    if (closed || !pollingStarted || pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll();
    }, pollIntervalMs);
    pollTimer.unref?.();
  }

  async function poll(): Promise<void> {
    if (closed) return;
    try {
      const next = await readSnapshot(options.rootDir);
      if (closed) return;
      for (const relativePath of changedPaths(snapshot, next)) {
        options.onChange(relativePath);
      }
      snapshot = next;
      lastPollingError = null;
    } catch (error) {
      const message = errorMessage(error);
      if (message !== lastPollingError) {
        options.log?.(`source polling failed: ${message}`);
        lastPollingError = message;
      }
    } finally {
      schedulePoll();
    }
  }

  function fallBackToPolling(error: unknown): Promise<void> {
    if (fallbackPromise !== null) return fallbackPromise;
    fallbackPromise = (async () => {
      try {
        nativeWatcher?.close();
      } catch {
        // The native watcher is already unusable; polling owns recovery.
      }
      nativeWatcher = null;
      await initialSnapshotReady;
      if (closed) return;
      pollingStarted = true;
      options.log?.(
        `recursive source watch failed (${errorMessage(error)}); using ${pollIntervalMs}ms polling`,
      );
      await poll();
    })();
    return fallbackPromise;
  }

  try {
    nativeWatcher = watchFactory(options.rootDir, options.onChange);
    nativeWatcher.on("error", (error) => {
      void fallBackToPolling(error);
    });
  } catch (error) {
    void fallBackToPolling(error);
  }

  await initialSnapshotReady;
  if (fallbackPromise !== null) await fallbackPromise;

  return {
    close() {
      if (closed) return;
      closed = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      try {
        nativeWatcher?.close();
      } catch {
        // Closing is best-effort after a watcher failure.
      }
      nativeWatcher = null;
    },
  };
}
