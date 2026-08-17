export type DesktopBuildFlavor = "preview" | "release";
export type DesktopUpdateChannel = "canary" | "stable";
export type DesktopBuildPlatform = "macos" | "linux";

export interface DesktopUpdateMetadataFileNames {
  linux: "stable-linux.yml";
  macos: "stable-mac.yml";
}

interface DesktopReleaseConfigBase {
  appId:
    | "de.staufingers.pierback.desktop"
    | "de.staufingers.pierback.desktop.preview";
  applicationName: "Pierback" | "Pierback Preview";
  artifactName: string;
  defaultUpdateChannel: DesktopUpdateChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxExecutableName: "bb" | "bb-nightly";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
}

export type DesktopReleaseConfig = DesktopReleaseConfigBase &
  (
    | { updatesEnabled: false; updateMetadataFileNames?: never }
    | {
        updatesEnabled: true;
        updateMetadataFileNames: DesktopUpdateMetadataFileNames;
      }
  );

export const DESKTOP_BUILD_FLAVOR_ENV_NAME: "BB_DESKTOP_BUILD_FLAVOR";

export function resolveDesktopBuildFlavor(
  env: NodeJS.ProcessEnv,
): DesktopBuildFlavor;

export function resolveDesktopBuildPlatform(
  nodePlatform: string,
): DesktopBuildPlatform;

export function createDesktopReleaseConfig(
  buildFlavor: DesktopBuildFlavor,
): DesktopReleaseConfig;

export function createDesktopUpdateReleaseBaseUrl(
  channel: DesktopUpdateChannel,
): string;
