import type { BbDesktopInfo } from "@bb/desktop-contract";

interface MergeDesktopUpdateInfoArgs {
  autoInfo: BbDesktopInfo | null;
  feedInfo: BbDesktopInfo | null;
}

function latestCheckedAt(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left > right ? left : right;
}

/**
 * The version feed can establish availability, but only electron-updater can
 * establish native download activity. Keep those facts separate so a feed-only
 * result never masquerades as an active download.
 */
export function mergeDesktopUpdateInfo(
  args: MergeDesktopUpdateInfoArgs,
): BbDesktopInfo | null {
  const baseInfo = args.feedInfo ?? args.autoInfo;
  if (baseInfo === null) {
    return null;
  }

  const feedUpdateAvailable = args.feedInfo?.updateAvailable ?? false;
  const autoUpdateAvailable = args.autoInfo?.updateAvailable ?? false;
  const updateDownloaded = args.autoInfo?.updateDownloaded ?? false;
  const pendingVersion = args.autoInfo?.pendingVersion ?? null;
  const latestVersion =
    pendingVersion ??
    args.feedInfo?.latestVersion ??
    args.autoInfo?.latestVersion ??
    null;

  return {
    ...baseInfo,
    downloadState: args.autoInfo?.downloadState ?? baseInfo.downloadState,
    lastCheckedAt: latestCheckedAt(
      args.feedInfo?.lastCheckedAt ?? null,
      args.autoInfo?.lastCheckedAt ?? null,
    ),
    latestVersion,
    pendingVersion,
    updatesEnabled:
      (args.feedInfo?.updatesEnabled ?? false) ||
      (args.autoInfo?.updatesEnabled ?? false),
    updateAvailable:
      feedUpdateAvailable || autoUpdateAvailable || updateDownloaded,
    updateChannel: args.autoInfo?.updateChannel ?? baseInfo.updateChannel,
    updateDownloaded,
  };
}
