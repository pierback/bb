import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedEchoRequestRecord,
  createScriptedEchoRuntime,
  fullRuntimeOptions,
} from "./test/runtime-test-harness.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("startThread historical fork", () => {
  it("forwards the exact source provider checkpoint to the adapter", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "bb-runtime-fork-"));
    temporaryDirectories.push(workspacePath);
    const record = createScriptedEchoRequestRecord();
    const runtime = createScriptedEchoRuntime({
      runtime: {
        env: record.env,
        workspacePath,
        onEvent: () => undefined,
      },
    });

    try {
      await runtime.startThread({
        environmentId: "env-1",
        fork: {
          sourceProviderCheckpointId: "turn-before-fork",
          sourceProviderThreadId: "provider-source-1",
        },
        projectId: "project-1",
        providerId: "fake",
        threadId: "thread-fork",
        options: fullRuntimeOptions,
      });

      expect(record.last("thread/fork")?.params).toEqual(
        expect.objectContaining({
          sourceProviderCheckpointId: "turn-before-fork",
          sourceProviderThreadId: "provider-source-1",
          threadId: "thread-fork",
        }),
      );
    } finally {
      await runtime.shutdown();
    }
  });
});
