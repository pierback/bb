import {
  createBbDesktopVersionFeedFileName,
  type BbDesktopUpdateChannel,
  type BbDesktopVersionFeedPlatform,
} from "@bb/desktop-contract";

export type DesktopBuildFlavor = "preview" | "release";

export interface DesktopReleaseInfo {
  applicationName: "Pierback" | "Pierback Preview";
  buildFlavor: DesktopBuildFlavor;
  iconFileName: "icon.png" | "icon-nightly.png";
}

export const PIERBACK_UPDATE_ORIGIN = "https://updates.bb.staufingers.de";

export function getDefaultDesktopUpdateChannel(
  buildFlavor: DesktopBuildFlavor,
): BbDesktopUpdateChannel {
  return buildFlavor === "preview" ? "canary" : "stable";
}

export function createDesktopReleaseInfo(
  buildFlavor: DesktopBuildFlavor,
): DesktopReleaseInfo {
  const preview = buildFlavor === "preview";
  return {
    applicationName: preview ? "Pierback Preview" : "Pierback",
    buildFlavor,
    iconFileName: preview ? "icon-nightly.png" : "icon.png",
  };
}

export function createDesktopUpdateReleaseBaseUrl(
  channel: BbDesktopUpdateChannel,
): string {
  return `${PIERBACK_UPDATE_ORIGIN}/${channel}/`;
}

export function createDesktopVersionFeedUrl(
  channel: BbDesktopUpdateChannel,
  platform: BbDesktopVersionFeedPlatform,
): string {
  return `${createDesktopUpdateReleaseBaseUrl(channel)}${createBbDesktopVersionFeedFileName(platform)}`;
}

export interface DesktopAutoUpdateFeedConfig {
  channel: BbDesktopUpdateChannel;
  provider: "generic";
  url: string;
}

export function createDesktopAutoUpdateFeedConfig(
  channel: BbDesktopUpdateChannel,
): DesktopAutoUpdateFeedConfig {
  return {
    channel,
    provider: "generic",
    url: createDesktopUpdateReleaseBaseUrl(channel),
  };
}

function resolveBuiltDesktopFlavor(
  rawFlavor: string | undefined,
): DesktopBuildFlavor {
  if (rawFlavor === undefined || rawFlavor.length === 0) {
    return "release";
  }
  if (rawFlavor === "preview" || rawFlavor === "release") {
    return rawFlavor;
  }

  throw new Error(
    `Built desktop flavor must be preview or release, got ${String(rawFlavor)}.`,
  );
}

export const DESKTOP_BUILD_FLAVOR = resolveBuiltDesktopFlavor(
  process.env.BB_DESKTOP_BUILD_FLAVOR,
);
export const DESKTOP_RELEASE_INFO =
  createDesktopReleaseInfo(DESKTOP_BUILD_FLAVOR);
export const DESKTOP_DEFAULT_UPDATE_CHANNEL =
  getDefaultDesktopUpdateChannel(DESKTOP_BUILD_FLAVOR);

export interface DesktopUpdateSupport {
  /** Whether electron-updater can replace this installation in place. */
  autoUpdate: boolean;
  /** Whether the platform-specific JSON feed can be polled. */
  versionCheck: boolean;
}

export interface ResolveDesktopUpdateSupportArgs {
  canReplaceAppImage: (appImagePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  platform: BbDesktopVersionFeedPlatform;
}

export function resolveDesktopUpdateSupport(
  args: ResolveDesktopUpdateSupportArgs,
): DesktopUpdateSupport {
  if (args.platform === "macos") {
    return { autoUpdate: true, versionCheck: true };
  }

  const appImagePath = args.env.APPIMAGE?.trim() ?? "";
  if (appImagePath.length === 0) {
    return { autoUpdate: false, versionCheck: true };
  }

  return {
    autoUpdate: args.canReplaceAppImage(appImagePath),
    versionCheck: true,
  };
}
