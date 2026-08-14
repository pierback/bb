export const DESKTOP_BUILD_FLAVOR_ENV_NAME = "BB_DESKTOP_BUILD_FLAVOR";

export function resolveDesktopBuildFlavor(env) {
  const rawFlavor = env[DESKTOP_BUILD_FLAVOR_ENV_NAME]?.trim();
  if (rawFlavor === undefined || rawFlavor.length === 0) {
    return "release";
  }
  if (rawFlavor === "preview" || rawFlavor === "release") {
    return rawFlavor;
  }

  throw new Error(
    `${DESKTOP_BUILD_FLAVOR_ENV_NAME} must be preview or release, got ${rawFlavor}.`,
  );
}

export function createDesktopReleaseConfig(buildFlavor) {
  if (buildFlavor === "preview") {
    return {
      appId: "de.staufingers.pierback.desktop.preview",
      applicationName: "Pierback Preview",
      artifactName: "pierback-preview-${version}-${arch}.${ext}",
      defaultUpdateChannel: "canary",
      iconFileName: "icon-nightly.png",
      macIconPath: "assets/icon-nightly.icns",
      updatesEnabled: false,
    };
  }

  return {
    appId: "de.staufingers.pierback.desktop",
    applicationName: "Pierback",
    artifactName: "pierback-${version}-${arch}.${ext}",
    defaultUpdateChannel: "stable",
    iconFileName: "icon.png",
    macIconPath: "assets/icon.icns",
    updatesEnabled: true,
    updateMetadataFileName: "stable-mac.yml",
  };
}

export function createDesktopUpdateReleaseBaseUrl(channel) {
  return `https://updates.bb.staufingers.de/${channel}/`;
}
