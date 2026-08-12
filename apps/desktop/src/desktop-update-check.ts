import semver from "semver";
import {
  bbDesktopVersionFeedSchema,
  type BbDesktopInfo,
  type BbDesktopInfoChangeHandler,
  type BbDesktopInfoUnsubscribe,
  type BbDesktopUpdateChannel,
  type BbDesktopVersionFeed,
} from "@bb/desktop-contract";

export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DESKTOP_UPDATE_CHECK_TIMEOUT_MS = 5_000;
export const DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS = 15 * 60 * 1000;

type DesktopUpdateIntervalHandle = ReturnType<typeof setInterval>;

export interface DesktopUpdateLogger {
  warn(message: string): void;
}

export interface ParseDesktopVersionFeedArgs {
  checkedAt: string;
  currentVersion: string;
  payloadText: string;
  updateChannel: BbDesktopUpdateChannel;
}

interface ValidDesktopVersionFeedParseResult {
  feed: BbDesktopVersionFeed;
  info: BbDesktopInfo;
  kind: "valid";
}

interface MalformedDesktopVersionFeedParseResult {
  kind: "malformed";
  reason: string;
}

export type DesktopVersionFeedParseResult =
  | MalformedDesktopVersionFeedParseResult
  | ValidDesktopVersionFeedParseResult;

export interface CreateDesktopUpdateServiceArgs {
  channel: BbDesktopUpdateChannel;
  currentVersion: string;
  enabled: boolean;
  feedUrl: string;
  fetchImpl?: typeof fetch;
  logger?: DesktopUpdateLogger;
  now?: () => number;
}

export interface DesktopUpdateInfoService {
  checkAfterActive(): Promise<BbDesktopInfo | null>;
  checkForUpdates(): Promise<BbDesktopInfo>;
  getInfo(): BbDesktopInfo;
  start(): void;
  stop(): void;
  subscribe(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe;
}

export interface DesktopUpdateService extends DesktopUpdateInfoService {
  setUpdateTarget(target: DesktopUpdateTarget): void;
}

export interface DesktopUpdateTarget {
  channel: BbDesktopUpdateChannel;
  feedUrl: string;
}

interface FetchDesktopVersionFeedArgs {
  feedUrl: string;
  fetchImpl: typeof fetch;
}

interface ApplyFailureArgs {
  checkedAt: string;
  message: string;
}

function createBaseInfo(
  currentVersion: string,
  updateChannel: BbDesktopUpdateChannel,
  updatesEnabled: boolean,
): BbDesktopInfo {
  return {
    downloadState: "idle",
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform: "macos",
    updatesEnabled,
    updateAvailable: false,
    updateChannel,
    updateDownloaded: false,
    version: currentVersion,
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function areDesktopInfoValuesEqual(
  left: BbDesktopInfo,
  right: BbDesktopInfo,
): boolean {
  return (
    left.lastCheckedAt === right.lastCheckedAt &&
    left.latestVersion === right.latestVersion &&
    left.pendingVersion === right.pendingVersion &&
    left.platform === right.platform &&
    left.updatesEnabled === right.updatesEnabled &&
    left.updateAvailable === right.updateAvailable &&
    left.updateChannel === right.updateChannel &&
    left.updateDownloaded === right.updateDownloaded &&
    left.version === right.version
  );
}

function parseJsonPayload(payloadText: string): unknown {
  return JSON.parse(payloadText);
}

export function parseDesktopVersionFeed(
  args: ParseDesktopVersionFeedArgs,
): DesktopVersionFeedParseResult {
  let payload: unknown;
  try {
    payload = parseJsonPayload(args.payloadText);
  } catch (error) {
    return {
      kind: "malformed",
      reason: `desktop-version.json was not valid JSON: ${formatErrorMessage(
        error,
      )}`,
    };
  }

  const parsedFeed = bbDesktopVersionFeedSchema.safeParse(payload);
  if (!parsedFeed.success) {
    return {
      kind: "malformed",
      reason: `desktop-version.json did not match schema: ${parsedFeed.error.message}`,
    };
  }

  if (parsedFeed.data.channel !== args.updateChannel) {
    return {
      kind: "malformed",
      reason: `desktop-version.json channel ${parsedFeed.data.channel} did not match selected channel ${args.updateChannel}`,
    };
  }

  const parsedCurrentVersion = semver.parse(args.currentVersion);
  const parsedFeedVersion = semver.parse(parsedFeed.data.version);
  if (parsedCurrentVersion === null || parsedFeedVersion === null) {
    return {
      kind: "malformed",
      reason: `desktop-version.json contained an invalid version: current=${args.currentVersion} feed=${parsedFeed.data.version}`,
    };
  }

  return {
    feed: parsedFeed.data,
    info: {
      downloadState: "idle",
      lastCheckedAt: args.checkedAt,
      latestVersion: parsedFeed.data.version,
      pendingVersion: null,
      platform: "macos",
      updatesEnabled: true,
      updateAvailable: semver.gt(parsedFeedVersion, parsedCurrentVersion),
      updateChannel: args.updateChannel,
      updateDownloaded: false,
      version: args.currentVersion,
    },
    kind: "valid",
  };
}

async function fetchDesktopVersionFeed(
  args: FetchDesktopVersionFeedArgs,
): Promise<string> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    DESKTOP_UPDATE_CHECK_TIMEOUT_MS,
  );

  try {
    const response = await args.fetchImpl(args.feedUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function createDesktopUpdateService(
  args: CreateDesktopUpdateServiceArgs,
): DesktopUpdateService {
  const fetchImpl = args.fetchImpl ?? fetch;
  const logger = args.logger ?? console;
  const now = args.now ?? (() => Date.now());

  let target: DesktopUpdateTarget = {
    channel: args.channel,
    feedUrl: args.feedUrl,
  };
  let targetGeneration = 0;
  let currentInfo = createBaseInfo(
    args.currentVersion,
    target.channel,
    args.enabled,
  );
  let inflight: Promise<BbDesktopInfo> | null = null;
  let intervalHandle: DesktopUpdateIntervalHandle | null = null;
  let lastAttemptedAt: number | null = null;
  const listeners = new Set<BbDesktopInfoChangeHandler>();

  function updateInfo(nextInfo: BbDesktopInfo): void {
    if (areDesktopInfoValuesEqual(currentInfo, nextInfo)) {
      return;
    }
    currentInfo = nextInfo;
    for (const listener of listeners) {
      listener(currentInfo);
    }
  }

  function applyFailure(failureArgs: ApplyFailureArgs): BbDesktopInfo {
    logger.warn(failureArgs.message);
    updateInfo({
      ...currentInfo,
      lastCheckedAt: failureArgs.checkedAt,
    });
    return currentInfo;
  }

  async function checkForUpdates(): Promise<BbDesktopInfo> {
    if (!args.enabled) {
      return currentInfo;
    }
    if (inflight !== null) {
      return inflight;
    }

    const requestTarget = { ...target };
    const requestGeneration = targetGeneration;
    const requestPromise = (async () => {
      lastAttemptedAt = now();
      const checkedAt = new Date(lastAttemptedAt).toISOString();

      let payloadText: string;
      try {
        payloadText = await fetchDesktopVersionFeed({
          feedUrl: requestTarget.feedUrl,
          fetchImpl,
        });
      } catch (error) {
        if (requestGeneration !== targetGeneration) {
          return currentInfo;
        }
        return applyFailure({
          checkedAt,
          message: `Desktop update check network failure; preserving session state, and update prompts stay disabled without a valid prior feed: ${formatErrorMessage(
            error,
          )}`,
        });
      }

      if (requestGeneration !== targetGeneration) {
        return currentInfo;
      }

      const parsed = parseDesktopVersionFeed({
        checkedAt,
        currentVersion: args.currentVersion,
        payloadText,
        updateChannel: requestTarget.channel,
      });
      if (parsed.kind === "malformed") {
        return applyFailure({
          checkedAt,
          message: `Desktop update check malformed feed; ignoring response and keeping prior valid session state, with update prompts disabled if none exists: ${parsed.reason}`,
        });
      }

      if (semver.lt(parsed.feed.version, args.currentVersion)) {
        logger.warn(
          `Desktop update check saw a lower feed version; downgrade feeds never trigger desktop update prompts: current=${args.currentVersion} feed=${parsed.feed.version}`,
        );
      }
      updateInfo(parsed.info);
      return currentInfo;
    })();

    inflight = requestPromise;
    try {
      return await requestPromise;
    } finally {
      if (inflight === requestPromise) {
        inflight = null;
      }
    }
  }

  return {
    async checkAfterActive(): Promise<BbDesktopInfo | null> {
      if (!args.enabled) {
        return null;
      }
      const currentTime = now();
      if (
        lastAttemptedAt !== null &&
        currentTime - lastAttemptedAt < DESKTOP_UPDATE_ACTIVE_MIN_INTERVAL_MS
      ) {
        return currentInfo;
      }
      return checkForUpdates();
    },
    checkForUpdates,
    getInfo(): BbDesktopInfo {
      return currentInfo;
    },
    setUpdateTarget(nextTarget): void {
      if (
        target.channel === nextTarget.channel &&
        target.feedUrl === nextTarget.feedUrl
      ) {
        return;
      }
      target = { ...nextTarget };
      targetGeneration += 1;
      lastAttemptedAt = null;
      updateInfo(
        createBaseInfo(args.currentVersion, target.channel, args.enabled),
      );
    },
    start(): void {
      if (!args.enabled || intervalHandle !== null) {
        return;
      }
      void checkForUpdates();
      intervalHandle = setInterval(() => {
        void checkForUpdates();
      }, DESKTOP_UPDATE_CHECK_INTERVAL_MS);
    },
    stop(): void {
      if (intervalHandle === null) {
        return;
      }
      clearInterval(intervalHandle);
      intervalHandle = null;
    },
    subscribe(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
