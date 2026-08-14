import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  acknowledgePromotionRecovery,
  advancePromotionState,
  assertNoActiveLegacyPromotionStates,
  initializePromotionState,
  markPromotionRecoveryRequired,
  markPromotionRollbackComplete,
} from "./promotion-state.mjs";

const tempDirectories = [];
const identity = {
  desktopVersion: "1.2.3",
  releaseTag: "pierback-desktop-v1.2.3",
  sourceCommit: "a".repeat(40),
};
const nextIdentity = {
  desktopVersion: "1.2.4",
  releaseTag: "pierback-desktop-v1.2.4",
  sourceCommit: "b".repeat(40),
};

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), "pierback-promotion-state-"));
  tempDirectories.push(directory);
  return join(directory, "nested", "state.json");
}

async function legacyStateDirectory() {
  const directory = await mkdtemp(
    join(tmpdir(), "pierback-legacy-promotion-state-"),
  );
  tempDirectories.push(directory);
  return directory;
}

async function writeLegacyState(
  directory,
  legacyIdentity,
  phase,
  schemaVersion,
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${legacyIdentity.releaseTag}.json`),
    `${JSON.stringify({
      ...legacyIdentity,
      phase,
      schemaVersion,
      updatedAt: new Date().toISOString(),
    })}\n`,
  );
}

test("initializes one durable prepared state with the hard-cutover schema", async () => {
  const path = await statePath();
  const first = await initializePromotionState({ identity, path });
  const second = await initializePromotionState({ identity, path });

  assert.equal(first.phase, "prepared");
  assert.equal(first.schemaVersion, 3);
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), first);
});

test("advances through the complete NAS-first promotion transaction", async () => {
  const path = await statePath();
  await initializePromotionState({ identity, path });
  for (const [expectedPhase, nextPhase] of [
    ["prepared", "nas-installing"],
    ["nas-installing", "nas-installed"],
    ["nas-installed", "stable-verified"],
    ["stable-verified", "complete"],
  ]) {
    const state = await advancePromotionState({
      expectedPhase,
      identity,
      nextPhase,
      path,
    });
    assert.equal(state.phase, nextPhase);
  }
});

test("makes a repeated completed transition idempotent", async () => {
  const path = await statePath();
  await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installing",
    path,
  });
  const repeated = await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installing",
    path,
  });
  assert.equal(repeated.phase, "nas-installing");
});

test("a completed automatic rollback safely re-arms the candidate", async () => {
  const path = await statePath();
  await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installing",
    path,
  });
  assert.equal(
    (await markPromotionRollbackComplete({ identity, path })).phase,
    "prepared",
  );
  assert.equal(
    (await markPromotionRollbackComplete({ identity, path })).phase,
    "prepared",
  );
});

test("incomplete recovery blocks retries until explicit acknowledgement", async () => {
  const path = await statePath();
  await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installing",
    path,
  });
  assert.equal(
    (await markPromotionRecoveryRequired({ identity, path })).phase,
    "recovery-required",
  );
  assert.equal(
    (await markPromotionRecoveryRequired({ identity, path })).phase,
    "recovery-required",
  );
  await assert.rejects(
    advancePromotionState({
      expectedPhase: "prepared",
      identity,
      nextPhase: "nas-installing",
      path,
    }),
    /Cannot advance/u,
  );
  assert.equal(
    (await acknowledgePromotionRecovery({ identity, path })).phase,
    "prepared",
  );
});

test("one host-global journal blocks another candidate until completion", async () => {
  const path = await statePath();
  await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installing",
    path,
  });
  await markPromotionRecoveryRequired({ identity, path });

  await assert.rejects(
    initializePromotionState({ identity: nextIdentity, path }),
    /active promotion.*recovery-required/u,
  );
});

test("one host-global journal rolls over after a verified rollback", async () => {
  const path = await statePath();
  await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installing",
    path,
  });
  assert.equal(
    (await markPromotionRollbackComplete({ identity, path })).phase,
    "prepared",
  );

  const nextState = await initializePromotionState({
    identity: nextIdentity,
    path,
  });
  assert.equal(nextState.phase, "prepared");
  assert.equal(nextState.releaseTag, nextIdentity.releaseTag);
  assert.equal(nextState.desktopVersion, nextIdentity.desktopVersion);
  assert.equal(nextState.sourceCommit, nextIdentity.sourceCommit);
});

test("only proven-safe legacy journals pass the global cutover", async () => {
  for (const [schemaVersion, phase] of [
    [1, "complete"],
    [2, "prepared"],
    [2, "complete"],
  ]) {
    const directory = await legacyStateDirectory();
    await writeLegacyState(directory, identity, phase, schemaVersion);
    await assert.doesNotReject(
      assertNoActiveLegacyPromotionStates({ directory }),
    );
  }
});

test("legacy schema-1 prepared journals fail closed after the global cutover", async () => {
  const directory = await legacyStateDirectory();
  await writeLegacyState(directory, identity, "prepared", 1);

  await assert.rejects(
    assertNoActiveLegacyPromotionStates({ directory }),
    /schema 1 remains in prepared/u,
  );
});

test("legacy in-flight journals fail closed after the global cutover", async () => {
  for (const phase of [
    "nas-installing",
    "nas-installed",
    "stable-verified",
    "recovery-required",
  ]) {
    const directory = await legacyStateDirectory();
    await writeLegacyState(directory, identity, phase, 2);
    await assert.rejects(
      assertNoActiveLegacyPromotionStates({ directory }),
      new RegExp(`remains in ${phase}`, "u"),
    );
  }
});

test("malformed legacy journals fail closed after the global cutover", async () => {
  const directory = await legacyStateDirectory();
  await writeFile(
    join(directory, `${identity.releaseTag}.json`),
    `${JSON.stringify({ ...identity, phase: "prepared", schemaVersion: 99 })}\n`,
  );

  await assert.rejects(
    assertNoActiveLegacyPromotionStates({ directory }),
    /is invalid/u,
  );
});

test("one host-global journal rolls over after the prior release completes", async () => {
  const path = await statePath();
  for (const [expectedPhase, nextPhase] of [
    ["prepared", "nas-installing"],
    ["nas-installing", "nas-installed"],
    ["nas-installed", "stable-verified"],
    ["stable-verified", "complete"],
  ]) {
    await advancePromotionState({
      expectedPhase,
      identity,
      nextPhase,
      path,
    });
  }

  const nextState = await initializePromotionState({
    identity: nextIdentity,
    path,
  });
  assert.equal(nextState.phase, "prepared");
  assert.equal(nextState.releaseTag, nextIdentity.releaseTag);
  assert.equal(nextState.desktopVersion, nextIdentity.desktopVersion);
  assert.equal(nextState.sourceCommit, nextIdentity.sourceCommit);
});

test("manual acknowledgement can clear an interrupted installing phase", async () => {
  const path = await statePath();
  await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installing",
    path,
  });
  assert.equal(
    (await acknowledgePromotionRecovery({ identity, path })).phase,
    "prepared",
  );
});

test("rejects skipped phases, identity reuse, and the retired schema", async () => {
  const path = await statePath();
  await initializePromotionState({ identity, path });
  await assert.rejects(
    advancePromotionState({
      expectedPhase: "nas-installed",
      identity,
      nextPhase: "stable-verified",
      path,
    }),
    /Cannot advance/u,
  );
  await assert.rejects(
    initializePromotionState({
      identity: { ...identity, sourceCommit: "b".repeat(40) },
      path,
    }),
    /sourceCommit/u,
  );
  await assert.rejects(
    initializePromotionState({
      identity: { ...identity, releaseTag: "pierback-desktop-v1.2.4" },
      path: await statePath(),
    }),
    /did not match version/u,
  );

  const retiredPath = await statePath();
  await initializePromotionState({ identity, path: retiredPath });
  await writeFile(
    retiredPath,
    `${JSON.stringify({
      ...identity,
      phase: "prepared",
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
    })}\n`,
  );
  await assert.rejects(
    initializePromotionState({ identity, path: retiredPath }),
    /invalid schema/u,
  );
});
