import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSessionRuntimeBrokerStateStore } from "./session-runtime-broker-state-store.js";

describe("FileSessionRuntimeBrokerStateStore", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  function makeStatePath(): string {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "bb-session-runtime-state-store-test-"),
    );
    temporaryDirectories.push(directory);
    return path.join(directory, "session-fabric", "runtime-broker-v1.json");
  }

  it("treats an absent state file as empty and round-trips a validated snapshot", () => {
    const statePath = makeStatePath();
    const stateStore = createFileSessionRuntimeBrokerStateStore(statePath);
    const snapshot = {
      bindings: [],
      handoffRestatementReceipts: [],
      runtimeRecoveryReceipts: [],
    };

    expect(stateStore.load()).toBeNull();
    stateStore.save(snapshot);

    expect(stateStore.load()).toEqual(snapshot);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
      ...snapshot,
      version: 1,
    });
  });

  it("fails closed when the persisted envelope is not valid JSON", () => {
    const statePath = makeStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{not-json\n", { mode: 0o600 });

    expect(() =>
      createFileSessionRuntimeBrokerStateStore(statePath).load(),
    ).toThrow(/not valid JSON/);
  });
});
