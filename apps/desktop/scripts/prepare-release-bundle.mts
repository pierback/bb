import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  bbDesktopVersionFeedSchema,
  type BbDesktopUpdateChannel,
  type BbDesktopVersionFeed,
} from "@bb/desktop-contract";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { createDesktopReleaseConfig } from "./desktop-release-channel.mjs";

const updateMetadataFileSchema = z.object({
  files: z
    .array(
      z.object({
        sha512: z.string().min(1),
        size: z.number().int().nonnegative(),
        url: z.string().min(1),
      }),
    )
    .min(1),
  path: z.string().min(1),
  releaseDate: z.iso.datetime(),
  sha512: z.string().min(1),
  version: z.string().min(1),
});

export interface PrepareDesktopReleaseBundleArgs {
  buildDirectory: string;
  bundleDirectory: string;
  sourceCommit: string;
  version: string;
}

const sourceCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

function assertArtifactName(name: string): string {
  if (
    basename(name) !== name ||
    !/^pierback-[a-zA-Z0-9._-]+\.(?:blockmap|dmg|zip)$/u.test(name)
  ) {
    throw new Error(`Unsafe or unexpected Pierback release artifact: ${name}`);
  }
  return name;
}

function createVersionFeed(args: {
  channel: BbDesktopUpdateChannel;
  metadata: z.infer<typeof updateMetadataFileSchema>;
}): BbDesktopVersionFeed {
  return bbDesktopVersionFeedSchema.parse({
    channel: args.channel,
    files: args.metadata.files,
    minimumSystemVersion: null,
    path: args.metadata.path,
    platform: "macos",
    releaseDate: args.metadata.releaseDate,
    releaseName: `Pierback Desktop ${args.metadata.version}`,
    releaseNotes: null,
    schemaVersion: 1,
    sha512: args.metadata.sha512,
    stagingPercentage: null,
    version: args.metadata.version,
  });
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function prepareDesktopReleaseBundle(
  args: PrepareDesktopReleaseBundleArgs,
): Promise<string[]> {
  const buildDirectory = resolve(args.buildDirectory);
  const bundleDirectory = resolve(args.bundleDirectory);
  if (
    dirname(bundleDirectory) !== buildDirectory ||
    basename(bundleDirectory) !== "bundle"
  ) {
    throw new Error(
      "Pierback release bundle directory must be the build directory's bundle child",
    );
  }
  const stableMetadataName = "stable-mac.yml";
  const canaryMetadataName = "canary-mac.yml";
  const stableMetadataPath = resolve(buildDirectory, stableMetadataName);
  const metadata = updateMetadataFileSchema.parse(
    parseYaml(await readFile(stableMetadataPath, "utf8")),
  );
  if (metadata.version !== args.version) {
    throw new Error(
      `stable-mac.yml version ${metadata.version} did not match package version ${args.version}`,
    );
  }
  const sourceCommit = sourceCommitSchema.parse(args.sourceCommit);

  const referencedArtifacts = new Set(
    [...metadata.files.map((file) => file.url), metadata.path].map(
      assertArtifactName,
    ),
  );
  const releaseEntries = await readdir(buildDirectory, {
    withFileTypes: true,
  });
  const releaseArtifacts = releaseEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^pierback-[a-zA-Z0-9._-]+\.(?:blockmap|dmg|zip)$/u.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  for (const artifactName of referencedArtifacts) {
    if (!releaseArtifacts.includes(artifactName)) {
      throw new Error(
        `stable-mac.yml referenced missing release artifact ${artifactName}`,
      );
    }
  }
  if (!releaseArtifacts.some((name) => name.endsWith(".dmg"))) {
    throw new Error("Pierback release bundle did not contain a DMG");
  }
  if (!metadata.path.endsWith(".zip")) {
    throw new Error("stable-mac.yml primary artifact must be a ZIP");
  }

  await rm(bundleDirectory, { force: true, recursive: true });
  await mkdir(bundleDirectory);
  for (const artifactName of releaseArtifacts) {
    await copyFile(
      resolve(buildDirectory, artifactName),
      resolve(bundleDirectory, artifactName),
    );
  }
  await copyFile(
    stableMetadataPath,
    resolve(bundleDirectory, stableMetadataName),
  );
  await copyFile(
    stableMetadataPath,
    resolve(bundleDirectory, canaryMetadataName),
  );
  const channelMetadata = [stableMetadataName, canaryMetadataName];
  const versionFeedNames: string[] = [];
  for (const channel of ["canary", "stable"] as const) {
    const feedName = `${channel}-desktop-version.json`;
    await writeFile(
      resolve(bundleDirectory, feedName),
      `${JSON.stringify(createVersionFeed({ channel, metadata }), null, 2)}\n`,
      "utf8",
    );
    versionFeedNames.push(feedName);
  }

  const releaseConfig = createDesktopReleaseConfig("release");
  const releaseManifestName = "release-manifest.json";
  await writeFile(
    resolve(bundleDirectory, releaseManifestName),
    `${JSON.stringify(
      {
        applicationId: releaseConfig.appId,
        applicationName: releaseConfig.applicationName,
        desktopVersion: args.version,
        hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        primaryZip: metadata.path,
        schemaVersion: 1,
        sourceCommit,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const manifestEntries = [
    ...releaseArtifacts,
    ...channelMetadata,
    ...versionFeedNames,
    releaseManifestName,
  ].sort();
  const manifestLines: string[] = [];
  for (const name of manifestEntries) {
    manifestLines.push(
      `${await sha256(resolve(bundleDirectory, name))}  ${name}`,
    );
  }
  await writeFile(
    resolve(bundleDirectory, "SHA256SUMS"),
    `${manifestLines.join("\n")}\n`,
    "utf8",
  );
  return [...manifestEntries, "SHA256SUMS"];
}

async function main(): Promise<void> {
  if (process.env.BB_DESKTOP_BUILD_FLAVOR === "preview") {
    throw new Error(
      "Release bundles must be built with the Pierback release identity",
    );
  }
  const packageRoot = process.cwd();
  const packageJson = z
    .object({ version: z.string().min(1) })
    .parse(
      JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")),
    );
  const files = await prepareDesktopReleaseBundle({
    buildDirectory: resolve(packageRoot, "release"),
    bundleDirectory: resolve(packageRoot, "release", "bundle"),
    sourceCommit: sourceCommitSchema.parse(
      process.env.PIERBACK_RELEASE_SOURCE_COMMIT ?? process.env.GITHUB_SHA,
    ),
    version: packageJson.version,
  });
  process.stdout.write(`Prepared ${files.length} immutable release files.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
