#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMOTION_PHASES = [
  "prepared",
  "nas-installing",
  "nas-installed",
  "stable-verified",
  "complete",
  "recovery-required",
];
const PROMOTION_ADVANCES = new Map([
  ["prepared", "nas-installing"],
  ["nas-installing", "nas-installed"],
  ["nas-installed", "stable-verified"],
  ["stable-verified", "complete"],
]);
const TAG_PATTERN = /^bb-mesh-desktop-v[0-9][0-9A-Za-z.+-]*$/u;
const RETIRED_PIERBACK_TAG_PATTERN =
  /^pierback-desktop-v[0-9][0-9A-Za-z.+-]*$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const LEGACY_SCHEMA_VERSIONS = new Set([1, 2]);
const RETIRED_GLOBAL_SCHEMA_VERSIONS = new Set([3]);
const REPLACEABLE_PROMOTION_PHASES = new Set(["prepared", "complete"]);

function validateIdentity(identity) {
  if (!TAG_PATTERN.test(identity.releaseTag)) {
    throw new Error(`Unsafe BB Mesh release tag: ${identity.releaseTag}`);
  }
  if (!VERSION_PATTERN.test(identity.desktopVersion)) {
    throw new Error(
      `Promotion version must be plain SemVer: ${identity.desktopVersion}`,
    );
  }
  if (!COMMIT_PATTERN.test(identity.sourceCommit)) {
    throw new Error(`Invalid BB Mesh source commit: ${identity.sourceCommit}`);
  }
  if (identity.releaseTag !== `bb-mesh-desktop-v${identity.desktopVersion}`) {
    throw new Error(
      `BB Mesh release tag ${identity.releaseTag} did not match version ${identity.desktopVersion}`,
    );
  }
}

function parseState(raw) {
  const state = JSON.parse(raw);
  if (
    state === null ||
    typeof state !== "object" ||
    state.schemaVersion !== 3 ||
    !PROMOTION_PHASES.includes(state.phase) ||
    typeof state.updatedAt !== "string" ||
    Number.isNaN(Date.parse(state.updatedAt))
  ) {
    throw new Error("BB Mesh promotion state has an invalid schema");
  }
  validateIdentity(state);
  return state;
}

function parseRetiredPierbackState(raw, path, schemaVersions) {
  const state = JSON.parse(raw);
  if (
    state === null ||
    typeof state !== "object" ||
    !schemaVersions.has(state.schemaVersion) ||
    !PROMOTION_PHASES.includes(state.phase) ||
    typeof state.updatedAt !== "string" ||
    Number.isNaN(Date.parse(state.updatedAt))
  ) {
    throw new Error(`Retired Pierback promotion state ${path} is invalid`);
  }
  validateRetiredPierbackIdentity(state);
  return state;
}

function validateRetiredPierbackIdentity(identity) {
  if (!VERSION_PATTERN.test(identity.desktopVersion)) {
    throw new Error(
      `Retired Pierback promotion version must be plain SemVer: ${identity.desktopVersion}`,
    );
  }
  if (!COMMIT_PATTERN.test(identity.sourceCommit)) {
    throw new Error(
      `Invalid retired Pierback source commit: ${identity.sourceCommit}`,
    );
  }
  if (identity.releaseTag !== `pierback-desktop-v${identity.desktopVersion}`) {
    throw new Error(
      `Retired Pierback release tag ${identity.releaseTag} did not match version ${identity.desktopVersion}`,
    );
  }
}

function identityMismatch(state, identity) {
  for (const key of ["releaseTag", "desktopVersion", "sourceCommit"]) {
    if (state[key] !== identity[key]) {
      return key;
    }
  }
  return null;
}

function createPreparedState(identity) {
  return {
    ...identity,
    phase: "prepared",
    schemaVersion: 3,
    updatedAt: new Date().toISOString(),
  };
}

function legacyPromotionStateIsSafe(state) {
  return (
    state.phase === "complete" ||
    (state.schemaVersion === 2 && state.phase === "prepared")
  );
}

function validateStatePath(path) {
  if (!isAbsolute(path) || path === "/") {
    throw new Error("Promotion state path must be a specific absolute path");
  }
}

export async function assertNoActiveLegacyPromotionStates({ directory }) {
  validateStatePath(directory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) {
      continue;
    }
    const path = join(directory, entry.name);
    if (!entry.isFile()) {
      throw new Error(`Retired Pierback promotion state ${path} is not a file`);
    }
    if (entry.name === "nas-coordinator.json") {
      const state = parseRetiredPierbackState(
        await readFile(path, "utf8"),
        path,
        RETIRED_GLOBAL_SCHEMA_VERSIONS,
      );
      if (!REPLACEABLE_PROMOTION_PHASES.has(state.phase)) {
        throw new Error(
          `Retired Pierback global promotion ${state.releaseTag} remains in ${state.phase}; restore and validate the NAS before starting the BB Mesh cutover`,
        );
      }
      continue;
    }
    const releaseTag = entry.name.slice(0, -".json".length);
    if (!RETIRED_PIERBACK_TAG_PATTERN.test(releaseTag)) {
      continue;
    }
    const state = parseRetiredPierbackState(
      await readFile(path, "utf8"),
      path,
      LEGACY_SCHEMA_VERSIONS,
    );
    if (state.releaseTag !== releaseTag) {
      throw new Error(
        `Legacy Pierback promotion state ${path} does not match its filename`,
      );
    }
    if (!legacyPromotionStateIsSafe(state)) {
      throw new Error(
        `Legacy Pierback promotion ${state.releaseTag} schema ${state.schemaVersion} remains in ${state.phase}; restore and validate the NAS before removing its retired journal`,
      );
    }
  }
}

async function atomicWrite(path, state) {
  const parentPath = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(parentPath, { mode: 0o700, recursive: true });
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const parentHandle = await open(parentPath, "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writePhase(path, state, phase) {
  const nextState = {
    ...state,
    phase,
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(path, nextState);
  return nextState;
}

export async function initializePromotionState({ identity, path }) {
  validateStatePath(path);
  validateIdentity(identity);
  let existingState;
  try {
    existingState = parseState(await readFile(path, "utf8"));
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  if (existingState !== undefined) {
    const mismatch = identityMismatch(existingState, identity);
    if (mismatch === null) {
      return existingState;
    }
    if (!REPLACEABLE_PROMOTION_PHASES.has(existingState.phase)) {
      throw new Error(
        `Cannot replace active promotion ${existingState.releaseTag} in ${existingState.phase}; ${mismatch} ${existingState[mismatch]} did not match ${identity[mismatch]}`,
      );
    }
    if (
      existingState.releaseTag === identity.releaseTag ||
      existingState.desktopVersion === identity.desktopVersion
    ) {
      throw new Error(
        `BB Mesh release ${existingState.releaseTag} cannot reuse ${mismatch} ${existingState[mismatch]} as ${identity[mismatch]}`,
      );
    }
  }

  const state = createPreparedState(identity);
  await atomicWrite(path, state);
  return state;
}

export async function advancePromotionState({
  expectedPhase,
  identity,
  nextPhase,
  path,
}) {
  const state = await initializePromotionState({ identity, path });
  if (PROMOTION_ADVANCES.get(expectedPhase) !== nextPhase) {
    throw new Error(
      `Invalid BB Mesh promotion transition ${expectedPhase} -> ${nextPhase}`,
    );
  }
  if (state.phase === nextPhase) {
    return state;
  }
  if (state.phase !== expectedPhase) {
    throw new Error(
      `Cannot advance BB Mesh promotion from ${state.phase}; expected ${expectedPhase} -> ${nextPhase}`,
    );
  }
  return writePhase(path, state, nextPhase);
}

export async function markPromotionRollbackComplete({ identity, path }) {
  const state = await initializePromotionState({ identity, path });
  if (state.phase === "prepared") {
    return state;
  }
  if (state.phase !== "nas-installing") {
    throw new Error(
      `Cannot record a completed BB Mesh rollback from ${state.phase}`,
    );
  }
  return writePhase(path, state, "prepared");
}

export async function markPromotionRecoveryRequired({ identity, path }) {
  const state = await initializePromotionState({ identity, path });
  if (state.phase === "recovery-required") {
    return state;
  }
  if (state.phase !== "nas-installing") {
    throw new Error(`Cannot require BB Mesh recovery from ${state.phase}`);
  }
  return writePhase(path, state, "recovery-required");
}

export async function acknowledgePromotionRecovery({ identity, path }) {
  const state = await initializePromotionState({ identity, path });
  if (state.phase === "prepared") {
    return state;
  }
  if (state.phase !== "nas-installing" && state.phase !== "recovery-required") {
    throw new Error(`Cannot acknowledge BB Mesh recovery from ${state.phase}`);
  }
  return writePhase(path, state, "prepared");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "assert-legacy-safe" && arguments_.length === 1) {
    await assertNoActiveLegacyPromotionStates({ directory: arguments_[0] });
    process.stdout.write("safe\n");
    return;
  }
  const [path, releaseTag, desktopVersion, sourceCommit, ...rest] = arguments_;
  const identity = { desktopVersion, releaseTag, sourceCommit };
  let state;
  if (command === "initialize" && rest.length === 0) {
    state = await initializePromotionState({ identity, path });
  } else if (command === "advance" && rest.length === 2) {
    state = await advancePromotionState({
      expectedPhase: rest[0],
      identity,
      nextPhase: rest[1],
      path,
    });
  } else if (command === "rollback-complete" && rest.length === 0) {
    state = await markPromotionRollbackComplete({ identity, path });
  } else if (command === "recovery-required" && rest.length === 0) {
    state = await markPromotionRecoveryRequired({ identity, path });
  } else if (command === "acknowledge-recovery" && rest.length === 0) {
    state = await acknowledgePromotionRecovery({ identity, path });
  } else {
    throw new Error(
      "Usage: promotion-state.mjs assert-legacy-safe <absolute-state-directory> | <initialize|advance|rollback-complete|recovery-required|acknowledge-recovery> <absolute-state-path> <release-tag> <desktop-version> <source-commit> [expected-phase next-phase]",
    );
  }
  process.stdout.write(`${state.phase}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
