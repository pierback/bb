import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  acknowledgePromotionRecovery,
  advancePromotionState,
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

test("initializes one durable prepared state with the hard-cutover schema", async () => {
  const path = await statePath();
  const first = await initializePromotionState({ identity, path });
  const second = await initializePromotionState({ identity, path });

  assert.equal(first.phase, "prepared");
  assert.equal(first.schemaVersion, 2);
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
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
    })}\n`,
  );
  await assert.rejects(
    initializePromotionState({ identity, path: retiredPath }),
    /invalid schema/u,
  );
});
