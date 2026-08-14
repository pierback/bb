import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  createDesktopUpdateReleaseBaseUrl,
  resolveDesktopBuildFlavor,
} from "./desktop-release-channel.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const baseConfigPath = resolve(
  desktopPackageRoot,
  "electron-builder.config.json",
);
const generatedConfigPath = resolve(
  desktopPackageRoot,
  ".electron-builder.generated.json",
);
const electronBuilderBin = resolve(
  desktopPackageRoot,
  "node_modules",
  ".bin",
  "electron-builder",
);

const codeSigningKeys = ["CSC_LINK", "CSC_KEY_PASSWORD"];
const notarizationKeys = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
];
const requiredSigningEnvironmentKeys = [
  ...codeSigningKeys,
  ...notarizationKeys,
];

const printConfigFlag = "--print-config";
const developerIdApplicationPrefix = "Developer ID Application:";

function envValueIsSet(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function missingEnvironmentKeys(keys, env) {
  return keys.filter((key) => !envValueIsSet(env[key]));
}

function presentEnvironmentKeys(keys, env) {
  return keys.filter((key) => envValueIsSet(env[key]));
}

function formatEnvironmentKeyList(keys) {
  if (keys.length === 0) {
    return "none";
  }

  return keys.join(", ");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function logWarning(message) {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.warn(`::warning::${message}`);
    return;
  }

  console.warn(message);
}

function logSigningPlan(signingPlan) {
  if (signingPlan.mode === "environment") {
    if (signingPlan.identityName) {
      console.log(
        `macOS code signing enabled with CSC_NAME identity "${signingPlan.identityName}".`,
      );
    } else {
      console.log(
        "macOS code signing enabled; electron-builder will derive the identity from CSC_LINK.",
      );
    }
  } else if (signingPlan.mode === "keychain") {
    if (signingPlan.identityName) {
      console.log(
        `macOS code signing via keychain identity "${signingPlan.identityName}".`,
      );
    } else {
      console.log(
        "macOS code signing via keychain auto-discovery; artifacts stay unsigned if no identity is installed.",
      );
    }
  } else {
    logWarning(
      "macOS signing skipped: CSC_IDENTITY_AUTO_DISCOVERY=false and no signing secrets found. Artifacts will be unsigned.",
    );
  }

  if (signingPlan.notarizationEnabled) {
    console.log("macOS notarization enabled.");
  }
}

function autoDiscoveryExplicitlyDisabled(env) {
  return (
    envValueIsSet(env.CSC_IDENTITY_AUTO_DISCOVERY) &&
    env.CSC_IDENTITY_AUTO_DISCOVERY.trim() === "false"
  );
}

/**
 * Resolves one of three signing modes:
 *
 * - "environment": a certificate plus all notarization credentials are set —
 *   import/sign with the provided certificate and notarize.
 * - "keychain": sign with an explicit or auto-discovered keychain identity.
 *   The NAS release worker also notarizes in this mode when all Apple
 *   credentials are present. Local builds without those credentials skip
 *   notarization. Locally built apps never get the quarantine xattr, so
 *   notarization is unnecessary, but a valid signature is not optional: an
 *   unsigned bundle is provenance-tracked by macOS, which forces syspolicyd to
 *   evaluate every exec in the app's process tree and can stall execs
 *   system-wide. Machines without a signing identity fall back to unsigned
 *   artifacts inside electron-builder.
 * - "disabled": no secrets and CSC_IDENTITY_AUTO_DISCOVERY=false — explicitly
 *   unsigned (the CI path for workflow-artifact-only builds).
 */
function createSigningPlan(env) {
  const presentCertificateKeys = presentEnvironmentKeys(codeSigningKeys, env);
  const missingCertificateKeys = missingEnvironmentKeys(codeSigningKeys, env);
  const hasAnyCertificateKeys = presentCertificateKeys.length > 0;
  const hasAllCertificateKeys = missingCertificateKeys.length === 0;
  const presentNotarizationKeys = presentEnvironmentKeys(notarizationKeys, env);
  const missingNotarizationKeys = missingEnvironmentKeys(notarizationKeys, env);
  const hasAnyNotarizationKeys = presentNotarizationKeys.length > 0;
  const hasAllNotarizationKeys = missingNotarizationKeys.length === 0;
  const identityName = envValueIsSet(env.CSC_NAME)
    ? env.CSC_NAME.trim()
    : undefined;

  if (identityName?.startsWith(developerIdApplicationPrefix) === true) {
    throw new Error(
      `CSC_NAME must omit the "${developerIdApplicationPrefix}" prefix. Use only the certificate owner selector, for example "Pierback (TEAMID1234)".`,
    );
  }

  if (hasAnyCertificateKeys && !hasAllCertificateKeys) {
    throw new Error(
      `Incomplete macOS certificate environment. Present: ${formatEnvironmentKeyList(
        presentCertificateKeys,
      )}. Missing: ${formatEnvironmentKeyList(missingCertificateKeys)}.`,
    );
  }

  if (hasAnyNotarizationKeys && !hasAllNotarizationKeys) {
    const presentSigningKeys = [
      ...presentCertificateKeys,
      ...presentNotarizationKeys,
    ];
    const missingSigningKeys = [
      ...missingCertificateKeys,
      ...missingNotarizationKeys,
    ];
    throw new Error(
      `Incomplete macOS signing/notarization environment. Present: ${formatEnvironmentKeyList(
        presentSigningKeys,
      )}. Missing: ${formatEnvironmentKeyList(missingSigningKeys)}.`,
    );
  }

  if (hasAllCertificateKeys && hasAllNotarizationKeys) {
    return {
      mode: "environment",
      identityName,
      notarizationEnabled: true,
    };
  }

  if (hasAllCertificateKeys) {
    throw new Error(
      "A packaged certificate release must include all Apple notarization credentials.",
    );
  }

  if (hasAllNotarizationKeys && identityName === undefined) {
    throw new Error(
      "NAS keychain notarization requires CSC_NAME to select one Developer ID Application identity.",
    );
  }

  return {
    mode:
      identityName !== undefined || !autoDiscoveryExplicitlyDisabled(env)
        ? "keychain"
        : "disabled",
    identityName,
    notarizationEnabled: hasAllNotarizationKeys,
  };
}

export function resolveElectronBuilderConfig(baseConfig, env) {
  const signingPlan = createSigningPlan(env);
  const buildFlavor = resolveDesktopBuildFlavor(env);
  const releaseConfig = createDesktopReleaseConfig(buildFlavor);
  const config = cloneJson(baseConfig);
  const mac = {
    ...config.mac,
    icon: releaseConfig.macIconPath,
    notarize: signingPlan.notarizationEnabled,
  };

  if (signingPlan.mode === "disabled") {
    mac.identity = null;
  } else if (signingPlan.identityName) {
    mac.identity = signingPlan.identityName;
  } else {
    // Let electron-builder resolve the identity (CSC_LINK or keychain).
    delete mac.identity;
  }

  config.mac = mac;
  config.appId = releaseConfig.appId;
  config.artifactName = releaseConfig.artifactName;
  config.productName = releaseConfig.applicationName;
  config.publish = releaseConfig.updatesEnabled
    ? [
        {
          channel: releaseConfig.defaultUpdateChannel,
          provider: "generic",
          url: createDesktopUpdateReleaseBaseUrl(
            releaseConfig.defaultUpdateChannel,
          ),
        },
      ]
    : [];

  return {
    config,
    buildFlavor,
    signingPlan,
  };
}

function createElectronBuilderEnv(signingPlan) {
  const childEnv = {
    ...process.env,
  };

  childEnv.CSC_IDENTITY_AUTO_DISCOVERY =
    signingPlan.mode !== "disabled" && !signingPlan.identityName
      ? "true"
      : "false";

  return childEnv;
}

async function readBaseConfig() {
  const configText = await readFile(baseConfigPath, "utf8");
  return JSON.parse(configText);
}

async function writeGeneratedConfig(config) {
  await writeFile(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeGeneratedConfig() {
  await rm(generatedConfigPath, { force: true });
}

async function runElectronBuilder(args, signingPlan) {
  const child = spawn(
    electronBuilderBin,
    ["--config", generatedConfigPath, ...args],
    {
      cwd: desktopPackageRoot,
      env: createElectronBuilderEnv(signingPlan),
      stdio: "inherit",
    },
  );

  const exitCode = await new Promise((resolveExitCode) => {
    child.on("error", () => {
      resolveExitCode(1);
    });
    child.on("close", resolveExitCode);
  });

  if (typeof exitCode === "number") {
    process.exitCode = exitCode;
    return;
  }

  process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const printConfig = args.includes(printConfigFlag);
  const electronBuilderArgs = args.filter((arg) => arg !== printConfigFlag);
  const baseConfig = await readBaseConfig();
  const { config, signingPlan } = resolveElectronBuilderConfig(
    baseConfig,
    process.env,
  );

  if (printConfig) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  logSigningPlan(signingPlan);
  await mkdir(dirname(generatedConfigPath), { recursive: true });
  await writeGeneratedConfig(config);
  try {
    await runElectronBuilder(electronBuilderArgs, signingPlan);
  } finally {
    await removeGeneratedConfig();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }

    process.exitCode = 1;
  });
}

export const electronBuilderSigningEnvironment = {
  codeSigningKeys,
  missingEnvironmentKeys,
  notarizationKeys,
  requiredSigningEnvironmentKeys,
};
