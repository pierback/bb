import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterCommand } from "./provider-adapter.js";
import { createAgentRuntimeWithAdapters } from "./runtime.js";
import {
  createRecordingAdapter,
  fullRuntimeOptions,
} from "./test/runtime-test-harness.js";
import { fakeProviderScriptPath } from "./test/index.js";

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
    const commands: AdapterCommand[] = [];
    const runtime = createAgentRuntimeWithAdapters({
      workspacePath,
      onEvent: () => undefined,
      onToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "ok" }],
        success: true,
      }),
      adapterFactory: () =>
        createRecordingAdapter({
          recordedCommands: commands,
          scriptPath: fakeProviderScriptPath,
        }),
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

      expect(
        commands.find((command) => command.type === "thread/fork"),
      ).toEqual(
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
