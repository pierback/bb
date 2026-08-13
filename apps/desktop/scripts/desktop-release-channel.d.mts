export type DesktopBuildFlavor = "preview" | "release";
export type DesktopUpdateChannel = "canary" | "stable";

interface DesktopReleaseConfigBase {
  appId:
    | "de.staufingers.pierback.desktop"
    | "de.staufingers.pierback.desktop.preview";
  applicationName: "Pierback" | "Pierback Preview";
  artifactName: string;
  defaultUpdateChannel: DesktopUpdateChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
}

export type DesktopReleaseConfig = DesktopReleaseConfigBase &
  (
    | { updatesEnabled: false; updateMetadataFileName?: never }
    | { updatesEnabled: true; updateMetadataFileName: "stable-mac.yml" }
  );

export const DESKTOP_BUILD_FLAVOR_ENV_NAME: "BB_DESKTOP_BUILD_FLAVOR";

export function resolveDesktopBuildFlavor(
  env: NodeJS.ProcessEnv,
): DesktopBuildFlavor;

export function createDesktopReleaseConfig(
  buildFlavor: DesktopBuildFlavor,
): DesktopReleaseConfig;

export function createDesktopUpdateReleaseBaseUrl(
  channel: DesktopUpdateChannel,
): string;
