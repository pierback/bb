import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  advancePromotionState,
  initializePromotionState,
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

test("initializes one durable prepared state and reuses it", async () => {
  const path = await statePath();
  const first = await initializePromotionState({ identity, path });
  const second = await initializePromotionState({ identity, path });

  assert.equal(first.phase, "prepared");
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), first);
});

test("advances only through the resumable promotion phases", async () => {
  const path = await statePath();
  await initializePromotionState({ identity, path });
  for (const [expectedPhase, nextPhase] of [
    ["prepared", "nas-installed"],
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
    nextPhase: "nas-installed",
    path,
  });
  const repeated = await advancePromotionState({
    expectedPhase: "prepared",
    identity,
    nextPhase: "nas-installed",
    path,
  });
  assert.equal(repeated.phase, "nas-installed");
});

test("rejects skipped phases and identity reuse", async () => {
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
});
