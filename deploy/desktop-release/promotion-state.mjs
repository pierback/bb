#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
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
const TAG_PATTERN = /^pierback-desktop-v[0-9][0-9A-Za-z.+-]*$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function validateIdentity(identity) {
  if (!TAG_PATTERN.test(identity.releaseTag)) {
    throw new Error(`Unsafe Pierback release tag: ${identity.releaseTag}`);
  }
  if (!VERSION_PATTERN.test(identity.desktopVersion)) {
    throw new Error(
      `Promotion version must be plain SemVer: ${identity.desktopVersion}`,
    );
  }
  if (!COMMIT_PATTERN.test(identity.sourceCommit)) {
    throw new Error(`Invalid Pierback source commit: ${identity.sourceCommit}`);
  }
  if (identity.releaseTag !== `pierback-desktop-v${identity.desktopVersion}`) {
    throw new Error(
      `Pierback release tag ${identity.releaseTag} did not match version ${identity.desktopVersion}`,
    );
  }
}

function parseState(raw, identity) {
  const state = JSON.parse(raw);
  if (
    state === null ||
    typeof state !== "object" ||
    state.schemaVersion !== 2 ||
    !PROMOTION_PHASES.includes(state.phase) ||
    typeof state.updatedAt !== "string" ||
    Number.isNaN(Date.parse(state.updatedAt))
  ) {
    throw new Error("Pierback promotion state has an invalid schema");
  }
  for (const key of ["releaseTag", "desktopVersion", "sourceCommit"]) {
    if (state[key] !== identity[key]) {
      throw new Error(
        `Pierback promotion state ${key} ${state[key]} did not match ${identity[key]}`,
      );
    }
  }
  return state;
}

function validateStatePath(path) {
  if (!isAbsolute(path) || path === "/") {
    throw new Error("Promotion state path must be a specific absolute path");
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
  try {
    return parseState(await readFile(path, "utf8"), identity);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  const state = {
    ...identity,
    phase: "prepared",
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
  };
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
      `Invalid Pierback promotion transition ${expectedPhase} -> ${nextPhase}`,
    );
  }
  if (state.phase === nextPhase) {
    return state;
  }
  if (state.phase !== expectedPhase) {
    throw new Error(
      `Cannot advance Pierback promotion from ${state.phase}; expected ${expectedPhase} -> ${nextPhase}`,
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
      `Cannot record a completed Pierback rollback from ${state.phase}`,
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
    throw new Error(`Cannot require Pierback recovery from ${state.phase}`);
  }
  return writePhase(path, state, "recovery-required");
}

export async function acknowledgePromotionRecovery({ identity, path }) {
  const state = await initializePromotionState({ identity, path });
  if (state.phase === "prepared") {
    return state;
  }
  if (state.phase !== "nas-installing" && state.phase !== "recovery-required") {
    throw new Error(`Cannot acknowledge Pierback recovery from ${state.phase}`);
  }
  return writePhase(path, state, "prepared");
}

async function main() {
  const [command, path, releaseTag, desktopVersion, sourceCommit, ...rest] =
    process.argv.slice(2);
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
      "Usage: promotion-state.mjs <initialize|advance|rollback-complete|recovery-required|acknowledge-recovery> <absolute-state-path> <release-tag> <desktop-version> <source-commit> [expected-phase next-phase]",
    );
  }
  process.stdout.write(`${state.phase}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
