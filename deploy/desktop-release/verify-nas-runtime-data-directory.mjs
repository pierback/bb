#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORTABLE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function verifyNasRuntimeDataDirectory(dataDirectory) {
  if (!isAbsolute(dataDirectory) || dataDirectory === "/") {
    throw new Error(
      "NAS runtime data directory must be a specific absolute directory.",
    );
  }

  const metadata = await lstat(dataDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `NAS runtime data directory must be a real directory: ${dataDirectory}`,
    );
  }
  const envPath = join(dataDirectory, "env.json");
  let rawEnv;
  try {
    rawEnv = await readFile(envPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawEnv);
  } catch {
    throw new Error(`NAS runtime environment is invalid JSON: ${envPath}`);
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "env")) {
    throw new Error(
      `NAS runtime environment has an invalid schema: ${envPath}`,
    );
  }
  if (parsed.env === undefined) {
    return;
  }
  if (!isRecord(parsed.env)) {
    throw new Error(
      `NAS runtime environment has an invalid schema: ${envPath}`,
    );
  }
  for (const [name, value] of Object.entries(parsed.env)) {
    if (!PORTABLE_ENV_NAME_PATTERN.test(name) || typeof value !== "string") {
      throw new Error(
        `NAS runtime environment has an invalid entry name or value: ${envPath}`,
      );
    }
  }
  if (Object.hasOwn(parsed.env, "BB_DATA_DIR")) {
    throw new Error(
      `NAS release cutover requires BB_DATA_DIR to be absent from ${envPath}; the installer supplies the one protected data directory explicitly.`,
    );
  }
}

async function main() {
  const [dataDirectory, ...rest] = process.argv.slice(2);
  if (dataDirectory === undefined || rest.length !== 0) {
    throw new Error(
      "Usage: verify-nas-runtime-data-directory.mjs <absolute-data-directory>",
    );
  }
  await verifyNasRuntimeDataDirectory(dataDirectory);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
