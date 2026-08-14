import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  bbDesktopVersionFeedSchema,
  type BbDesktopVersionFeed,
} from "@bb/desktop-contract";
import {
  createDesktopReleaseConfig,
  resolveDesktopBuildFlavor,
} from "./desktop-release-channel.mjs";

const packageRoot = process.cwd();
const packageJsonPath = resolve(packageRoot, "package.json");
const buildFlavor = resolveDesktopBuildFlavor(process.env);
const releaseConfig = createDesktopReleaseConfig(buildFlavor);
if (!releaseConfig.updatesEnabled) {
  throw new Error(
    `${releaseConfig.applicationName} has automatic updates disabled and cannot produce a version feed`,
  );
}
const updateChannel = releaseConfig.defaultUpdateChannel;
const updateMetadataPath = resolve(
  packageRoot,
  "release",
  releaseConfig.updateMetadataFileName,
);
const desktopVersionFeedPath = resolve(
  packageRoot,
  "release",
  "desktop-version.json",
);

const packageJsonSchema = z.object({
  version: z.string().min(1),
});

const latestMacFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const latestMacSchema = z.object({
  version: z.string().min(1),
  files: z.array(latestMacFileSchema).min(1),
  path: z.string().min(1),
  sha512: z.string().min(1),
  releaseDate: z.iso.datetime(),
});

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

const packageJson = packageJsonSchema.parse(
  parseJson(await readFile(packageJsonPath, "utf8")),
);
const updateMetadata = latestMacSchema.parse(
  parseYaml(await readFile(updateMetadataPath, "utf8")),
);

if (updateMetadata.version !== packageJson.version) {
  throw new Error(
    `${releaseConfig.updateMetadataFileName} version ${updateMetadata.version} did not match apps/desktop/package.json version ${packageJson.version}`,
  );
}

const desktopVersionFeed: BbDesktopVersionFeed = {
  channel: updateChannel,
  files: updateMetadata.files,
  minimumSystemVersion: null,
  path: updateMetadata.path,
  platform: "macos",
  releaseDate: updateMetadata.releaseDate,
  releaseName: `${releaseConfig.applicationName} desktop ${packageJson.version}`,
  releaseNotes: null,
  schemaVersion: 1,
  sha512: updateMetadata.sha512,
  stagingPercentage: null,
  version: packageJson.version,
};

const validatedFeed = bbDesktopVersionFeedSchema.parse(desktopVersionFeed);
await writeFile(
  desktopVersionFeedPath,
  `${JSON.stringify(validatedFeed, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`Wrote ${desktopVersionFeedPath}\n`);
