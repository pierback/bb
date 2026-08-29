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

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }

  throw new Error(
    `Desktop builds support darwin and linux only, got ${nodePlatform}.`,
  );
}

export function createDesktopReleaseConfig(buildFlavor) {
  if (buildFlavor === "preview") {
    return {
      appId: "de.staufingers.bb-mesh.desktop.preview",
      applicationName: "BB Mesh Preview",
      artifactName: "bb-mesh-preview-${version}-${arch}.${ext}",
      bundleName: "BB Mesh Preview",
      defaultUpdateChannel: "canary",
      iconFileName: "icon-nightly.png",
      // The Linux binary name must differ from stable so both channels can be
      // installed at once without one shadowing the other on PATH.
      linuxExecutableName: "bb-nightly",
      macIconPath: "assets/icon-nightly.icns",
      packageName: "bb-mesh-preview-desktop",
      updatesEnabled: false,
    };
  }

  return {
    appId: "de.staufingers.bb-mesh.desktop",
    applicationName: "BB Mesh",
    artifactName: "bb-mesh-${version}-${arch}.${ext}",
    bundleName: "BB Mesh",
    defaultUpdateChannel: "stable",
    iconFileName: "icon.png",
    linuxExecutableName: "bb",
    macIconPath: "assets/icon.icns",
    packageName: "bb-mesh-desktop",
    updatesEnabled: true,
    updateMetadataFileNames: {
      linux: "stable-linux.yml",
      macos: "stable-mac.yml",
    },
  };
}

export function createDesktopUpdateReleaseBaseUrl(channel) {
  return `https://updates.bb.staufingers.de/${channel}/`;
}
