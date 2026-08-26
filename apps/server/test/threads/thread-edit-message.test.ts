import {
  getThread,
  listEvents,
  listThreads,
  setExperiments,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import {
  defaultExperiments,
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
  type PromptInput,
  type ThreadEventTurnStatus,
  type ThreadStatus,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { editThreadMessage } from "../../src/services/threads/thread-edit-message.js";
import {
  listQueuedThreadCommands,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const MESSAGE_EDIT_PROVIDERS = ["codex", "pi", "claude-code"] as const;

function threadStartTurnRequest(harness: TestAppHarness, threadId: string) {
  const turnRequest = listEvents(harness.db, { threadId }).find(
    (event) => event.type === "client/turn/requested",
  );
  if (!turnRequest) {
    throw new Error("Expected a client/turn/requested thread-start event");
  }
  return turnRequestEventDataSchema.parse(JSON.parse(turnRequest.data));
}

function seedTurn(
  harness: TestAppHarness,
  args: {
    completionStatus?: ThreadEventTurnStatus | null;
    inputGroups?: PromptInput[][];
    initiator?: "agent" | "user";
    providerCheckpointId?: string;
    providerThreadId: string;
    requestSequence: number;
    senderThreadId?: string;
    text: string;
    threadId: string;
    turnId: string;
  },
): void {
  const requestId = encodeClientTurnRequestIdNumber({
    value: args.requestSequence,
  });
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sequence: args.requestSequence,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId,
      input: [{ type: "text", text: args.text, mentions: [] }],
      ...(args.inputGroups === undefined
        ? {}
        : { inputGroups: args.inputGroups }),
      target:
        args.requestSequence === 2
          ? { kind: "thread-start" }
          : { kind: "new-turn" },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      initiator: args.initiator ?? "user",
      senderThreadId: args.senderThreadId ?? null,
      request: { method: "turn/start", params: {} },
      source: "tell",
    },
  });
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sequence: args.requestSequence + 1,
    type: "turn/started",
    scope: turnScope(args.turnId),
    data: { providerThreadId: args.providerThreadId },
  });
  seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sequence: args.requestSequence + 2,
    type: "turn/input/accepted",
    scope: turnScope(args.turnId),
    data: {
      providerThreadId: args.providerThreadId,
      clientRequestId: requestId,
    },
  });
  if (args.completionStatus !== null) {
    seedStoredEvent(harness.deps, {
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      sequence: args.requestSequence + 4,
      type: "turn/completed",
      scope: turnScope(args.turnId),
      data: {
        providerThreadId: args.providerThreadId,
        status: args.completionStatus ?? "completed",
        ...(args.providerCheckpointId === undefined
          ? {}
          : { providerCheckpointId: args.providerCheckpointId }),
      },
    });
  }
}

function seedEditableThread(
  harness: TestAppHarness,
  args: {
    editMessagesExperiment?: boolean;
    firstCompletionStatus?: ThreadEventTurnStatus;
    includeSecondTurn?: boolean;
    providerId?: (typeof MESSAGE_EDIT_PROVIDERS)[number];
    secondCompletionStatus?: ThreadEventTurnStatus | null;
    threadStatus?: ThreadStatus;
  } = {},
) {
  setExperiments(harness.db, {
    ...defaultExperiments,
    editMessages: args.editMessagesExperiment ?? true,
  });
  const { host } = seedHostSession(harness.deps, {
    id: "host-edit-message",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/edit-message",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/edit-message",
    status: "ready",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: args.providerId ?? "codex",
    status: args.threadStatus ?? "idle",
  });
  seedStoredEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "provider-original",
    sequence: 1,
    type: "thread/identity",
    scope: threadScope(),
    data: {},
  });
  seedTurn(harness, {
    completionStatus: args.firstCompletionStatus,
    providerCheckpointId: "checkpoint-first",
    providerThreadId: "provider-original",
    requestSequence: 2,
    text: "First message",
    threadId: thread.id,
    turnId: "turn-first",
  });
  if (args.includeSecondTurn !== false) {
    seedTurn(harness, {
      completionStatus: args.secondCompletionStatus,
      providerCheckpointId: "checkpoint-last",
      providerThreadId: "provider-original",
      requestSequence: 7,
      text: "Original last message",
      threadId: thread.id,
      turnId: "turn-last",
    });
  }
  return { environment, thread };
}

describe("editThreadMessage", () => {
  for (const providerId of MESSAGE_EDIT_PROVIDERS) {
    it(`creates a ${providerId} fork before the selected message without rewriting the source`, async () => {
      await withTestHarness(async (harness) => {
        const { environment, thread } = seedEditableThread(harness, {
          providerId,
          secondCompletionStatus: null,
        });
        const originalSourceEvents = listEvents(harness.db, {
          threadId: thread.id,
        });
        const replacement = [
          { type: "text" as const, text: "Replacement", mentions: [] },
        ];
        const permissionMode = providerId === "pi" ? "full" : "accept-edits";

        const fork = await editThreadMessage(harness.deps, {
          thread,
          payload: {
            operationId: `edit-${providerId}`,
            expectedRequestSequence: 7,
            input: replacement,
            model: "gpt-5.6",
            permissionMode,
            reasoningLevel: "high",
          },
        });

        expect(fork).toMatchObject({
          environmentId: environment.id,
          originKind: "fork",
          sourceSeqEnd: 6,
          sourceThreadId: thread.id,
        });
        expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
          originalSourceEvents,
        );
        expect(getThread(harness.db, thread.id)?.status).toBe("idle");
        expect(
          listQueuedThreadCommands(harness, "thread.stop", thread.id),
        ).toHaveLength(0);

        const queuedStart = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === fork.id,
        );
        if (queuedStart.command.type !== "thread.start") {
          throw new Error("Expected a thread.start command");
        }
        expect(queuedStart.command.input).toEqual(replacement);
        expect(queuedStart.command.fork).toEqual({
          sourceProviderCheckpointId:
            providerId === "codex" ? "turn-first" : "checkpoint-first",
          sourceProviderThreadId: "provider-original",
        });
        expect(queuedStart.command.options).toMatchObject({
          model: "gpt-5.6",
          permissionMode,
          permissionEscalation: permissionMode === "full" ? null : "ask",
          reasoningLevel: "high",
        });
      });
    });
  }

  it("edits the first message by creating an empty-history fork", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      const originalSourceEvents = listEvents(harness.db, {
        threadId: thread.id,
      });

      const fork = await editThreadMessage(harness.deps, {
        thread,
        payload: {
          operationId: "edit-first-message",
          expectedRequestSequence: 2,
          input: [
            { type: "text", text: "Replacement first message", mentions: [] },
          ],
        },
      });

      expect(fork).toMatchObject({
        environmentId: environment.id,
        originKind: "fork",
        sourceSeqEnd: 0,
        sourceThreadId: thread.id,
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
        originalSourceEvents,
      );
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      expect(queuedStart.command.fork).toBeUndefined();
      expect(queuedStart.command.input).toEqual([
        { type: "text", text: "Replacement first message", mentions: [] },
      ]);
    });
  });

  it("replays one edit operation without creating a duplicate fork", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedEditableThread(harness);
      const payload = {
        operationId: "edit-idempotent",
        expectedRequestSequence: 7,
        input: [{ type: "text" as const, text: "Replacement", mentions: [] }],
      };

      const first = await editThreadMessage(harness.deps, {
        thread,
        payload,
      });
      await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === first.id,
      );
      const replay = await editThreadMessage(harness.deps, {
        thread,
        payload,
      });

      expect(replay.id).toBe(first.id);
      expect(
        listThreads(harness.db, { projectId: thread.projectId }).filter(
          (candidate) => candidate.sourceThreadId === thread.id,
        ),
      ).toHaveLength(1);
      expect(
        listQueuedThreadCommands(harness, "thread.start", first.id),
      ).toHaveLength(1);

      await expect(
        editThreadMessage(harness.deps, {
          thread,
          payload: {
            ...payload,
            input: [
              {
                type: "text",
                text: "Different replacement",
                mentions: [],
              },
            ],
          },
        }),
      ).rejects.toThrow(
        "This operationId was already used for a different edit request",
      );
    });
  });

  it("keeps source execution when project defaults point at another provider", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedEditableThread(harness, { providerId: "pi" });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: thread.projectId,
        providerId: "codex",
        model: "project-default-model",
        reasoningLevel: "low",
        permissionMode: "accept-edits",
        serviceTier: "default",
      });

      const fork = await editThreadMessage(harness.deps, {
        thread,
        payload: {
          operationId: "edit-source-execution",
          executionInputSources: {},
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
          model: "displayed-but-not-selected-model",
          reasoningLevel: "low",
        },
      });

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      expect(queuedStart.command.providerId).toBe("pi");
      expect(queuedStart.command.options).toMatchObject({
        model: "gpt-5",
        permissionMode: "full",
        reasoningLevel: "medium",
      });
    });
  });

  it("targets the latest editable user message when the sequence is omitted", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedEditableThread(harness);
      seedTurn(harness, {
        initiator: "agent",
        providerCheckpointId: "checkpoint-agent",
        providerThreadId: "provider-original",
        requestSequence: 12,
        senderThreadId: "agent-thread",
        text: "Agent follow-up",
        threadId: thread.id,
        turnId: "turn-agent",
      });

      const fork = await editThreadMessage(harness.deps, {
        thread,
        payload: {
          operationId: "edit-latest-message",
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        },
      });

      expect(fork.sourceSeqEnd).toBe(6);
    });
  });

  it("keeps an agent caller's approval ceiling without rendering an agent message", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedEditableThread(harness);
      const caller = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: thread.projectId,
        providerId: "codex",
      });

      const fork = await editThreadMessage(harness.deps, {
        thread,
        payload: {
          operationId: "edit-agent-caller",
          expectedRequestSequence: 7,
          input: [{ type: "text", text: "Replacement", mentions: [] }],
          permissionMode: "accept-edits",
          senderThreadId: caller.id,
        },
      });

      const turnRequest = threadStartTurnRequest(harness, fork.id);
      expect(turnRequest.initiator).toBe("user");
      expect(turnRequest.senderThreadId).toBeNull();

      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === fork.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected a thread.start command");
      }
      expect(queuedStart.command.options).toMatchObject({
        permissionEscalation: "deny",
        permissionMode: "accept-edits",
      });
    });
  });

  it("rejects an unknown agent caller before creating the fork", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedEditableThread(harness);
      const threadsBefore = listThreads(harness.db, {
        projectId: thread.projectId,
      });

      await expect(
        editThreadMessage(harness.deps, {
          thread,
          payload: {
            operationId: "edit-unknown-caller",
            expectedRequestSequence: 7,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
            senderThreadId: "thread-unknown-agent-caller",
          },
        }),
      ).rejects.toThrow("Sender thread is invalid");

      expect(listThreads(harness.db, { projectId: thread.projectId })).toEqual(
        threadsBefore,
      );
    });
  });

  it("rejects submission while the source thread is running", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedEditableThread(harness, {
        threadStatus: "active",
      });
      const originalSourceEvents = listEvents(harness.db, {
        threadId: thread.id,
      });

      await expect(
        editThreadMessage(harness.deps, {
          thread,
          payload: {
            operationId: "edit-running-thread",
            expectedRequestSequence: 7,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
          },
        }),
      ).rejects.toThrow(
        "Wait for the current turn to finish before editing a message",
      );
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual(
        originalSourceEvents,
      );
    });
  });

  it("rejects grouped messages", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedEditableThread(harness, {
        includeSecondTurn: false,
      });
      seedTurn(harness, {
        inputGroups: [
          [{ type: "text", text: "One", mentions: [] }],
          [{ type: "text", text: "Two", mentions: [] }],
        ],
        providerCheckpointId: "checkpoint-grouped",
        providerThreadId: "provider-original",
        requestSequence: 7,
        text: "Grouped",
        threadId: thread.id,
        turnId: "turn-grouped",
      });

      await expect(
        editThreadMessage(harness.deps, {
          thread,
          payload: {
            operationId: "edit-grouped-message",
            expectedRequestSequence: 7,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
          },
        }),
      ).rejects.toThrow("Grouped messages cannot be edited yet");
    });
  });

  it("requires the edit-messages experiment", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedEditableThread(harness, {
        editMessagesExperiment: false,
      });

      await expect(
        editThreadMessage(harness.deps, {
          thread,
          payload: {
            operationId: "edit-experiment-disabled",
            expectedRequestSequence: 7,
            input: [{ type: "text", text: "Replacement", mentions: [] }],
          },
        }),
      ).rejects.toThrow(
        "Enable the Edit messages experiment before editing a message",
      );
    });
  });
});
