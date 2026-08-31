#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const artifactNamePattern = /^bb-mesh-[A-Za-z0-9._+-]+\.(?:dmg|zip|blockmap)$/u;
const immutableCachePattern =
  /(?:^|,)\s*(?:public\s*,\s*)?max-age=31536000\s*,\s*immutable(?:\s*,|$)/iu;

function channelUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Public update channel URL must not contain credentials, a query, or a fragment",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  ) {
    throw new Error("Public update channel URL must use HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

function assertImmutable(response, label) {
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!immutableCachePattern.test(cacheControl)) {
    throw new Error(
      `${label} did not use the immutable BB Mesh artifact route`,
    );
  }
}

async function head(url) {
  return fetch(url, {
    headers: { "accept-encoding": "identity" },
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

export async function smokePublicUpdateRoute(baseUrl) {
  const base = channelUrl(baseUrl);
  const probeUrl = new URL("bb-mesh-route-probe.dmg", base);
  const response = await head(probeUrl);
  if (response.status !== 404) {
    throw new Error(
      `Public BB Mesh route probe returned HTTP ${response.status}, expected 404`,
    );
  }
  assertImmutable(response, "Public BB Mesh route probe");
}

async function releaseArtifactNames(releaseDirectory) {
  const manifest = await readFile(
    resolve(releaseDirectory, "SHA256SUMS"),
    "utf8",
  );
  const names = [];
  for (const line of manifest.trim().split("\n")) {
    const match = /^[0-9a-f]{64}  ([A-Za-z0-9._+-]+)$/u.exec(line);
    if (match === null) {
      throw new Error("Release SHA256SUMS contains a malformed entry");
    }
    if (artifactNamePattern.test(match[1])) {
      names.push(match[1]);
    }
  }
  if (
    !names.some((name) => name.endsWith(".dmg")) ||
    !names.some((name) => name.endsWith(".zip"))
  ) {
    throw new Error(
      "Release manifest must contain BB Mesh DMG and ZIP artifacts",
    );
  }
  return names;
}

export async function smokePublicUpdateChannel(baseUrl, releaseDirectory) {
  const base = channelUrl(baseUrl);
  await smokePublicUpdateRoute(base.href);
  const names = await releaseArtifactNames(releaseDirectory);
  for (const name of names) {
    const metadata = await stat(resolve(releaseDirectory, name));
    if (!metadata.isFile()) {
      throw new Error(`Release artifact is not a regular file: ${name}`);
    }
    const response = await head(new URL(name, base));
    if (response.status !== 200) {
      throw new Error(
        `Public release artifact ${name} returned HTTP ${response.status}`,
      );
    }
    assertImmutable(response, `Public release artifact ${name}`);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== String(metadata.size)) {
      throw new Error(
        `Public release artifact ${name} reported ${contentLength ?? "no"} bytes, expected ${metadata.size}`,
      );
    }
  }
}

async function main(args) {
  const [mode, baseUrl, releaseDirectory] = args;
  if (
    mode === "route" &&
    baseUrl !== undefined &&
    releaseDirectory === undefined
  ) {
    await smokePublicUpdateRoute(baseUrl);
    process.stdout.write(`Verified BB Mesh artifact route at ${baseUrl}.\n`);
    return;
  }
  if (
    mode === "release" &&
    baseUrl !== undefined &&
    releaseDirectory !== undefined
  ) {
    await smokePublicUpdateChannel(baseUrl, releaseDirectory);
    process.stdout.write(`Verified public BB Mesh artifacts at ${baseUrl}.\n`);
    return;
  }
  throw new Error(
    "Usage: smoke-public-channel.mjs route <channel-url> | release <channel-url> <release-directory>",
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
