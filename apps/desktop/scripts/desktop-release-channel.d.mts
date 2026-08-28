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
  applicationName: "BB Mesh" | "BB Mesh Preview";
  artifactName: string;
  bundleName: "Pierback" | "Pierback Preview";
  defaultUpdateChannel: DesktopUpdateChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  linuxExecutableName: "bb" | "bb-nightly";
  macIconPath: "assets/icon.icns" | "assets/icon-nightly.icns";
  packageName: "pierback-desktop" | "pierback-preview-desktop";
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
