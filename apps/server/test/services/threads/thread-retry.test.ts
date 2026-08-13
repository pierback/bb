import { getThread, listEvents } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  parseStoredThreadEvent,
  threadScope,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import { listQueuedThreadCommands } from "../../helpers/commands.js";
import { readJson } from "../../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const FAILED_REQUEST_ID = encodeClientTurnRequestIdNumber({ value: 71 });
const OTHER_REQUEST_ID = encodeClientTurnRequestIdNumber({ value: 72 });

function seedFailedStarterRequest(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "codex",
    status: "error",
  });
  const providerThreadId = "provider-thread-retry";
  seedEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId,
    sequence: 1,
    type: "thread/identity",
    scope: threadScope(),
    data: {},
  });
  seedEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    sequence: 2,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId: FAILED_REQUEST_ID,
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [
        { type: "text", text: "break our features", mentions: [] },
        {
          type: "text",
          text: "Resolved plugin context",
          mentions: [],
          visibility: "agent-only",
        },
      ],
      target: { kind: "thread-start" },
      request: { method: "thread/start", params: {} },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    },
  });
  seedEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    sequence: 3,
    type: "system/error",
    scope: threadScope(),
    data: {
      code: "thread_command_failed",
      message: "Command turn.submit failed",
      detail: "JSON-RPC request timed out: thread/resume",
    },
  });
  return { environment, thread };
}

describe("thread retry", () => {
  it("replays the exact persisted starter request after a command timeout", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedFailedStarterRequest(harness);
      const response = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        ok: true,
        failedRequestId: FAILED_REQUEST_ID,
        kind: "replayed",
      });
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("active");
      const [command] = listQueuedThreadCommands(
        harness,
        "turn.submit",
        fixture.thread.id,
      );
      expect(command).toMatchObject({
        type: "turn.submit",
        target: { mode: "start" },
        input: [
          { type: "text", text: "break our features", mentions: [] },
          {
            type: "text",
            text: "Resolved plugin context",
            mentions: [],
            visibility: "agent-only",
          },
        ],
        options: {
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
        },
      });

      const requests = listEvents(harness.db, {
        threadId: fixture.thread.id,
      })
        .map((row) =>
          parseStoredThreadEvent({
            type: row.type,
            data: JSON.parse(row.data) as Record<string, unknown>,
            providerThreadId: row.providerThreadId,
            scope: threadScope(),
            threadId: row.threadId,
          }),
        )
        .filter((event) => event.type === "client/turn/requested");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({
        initiator: "user",
        input: [
          { type: "text", text: "break our features" },
          { type: "text", text: "Resolved plugin context" },
        ],
      });

      const repeated = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(repeated.status).toBe(409);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", fixture.thread.id),
      ).toHaveLength(1);
    });
  });

  it("rejects a retry guard for a different failed request", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedFailedStarterRequest(harness);
      const response = await harness.app.request(
        `/api/v1/threads/${fixture.thread.id}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ failedRequestId: OTHER_REQUEST_ID }),
        },
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "thread_retry_unavailable",
      });
      expect(getThread(harness.db, fixture.thread.id)?.status).toBe("error");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", fixture.thread.id),
      ).toHaveLength(0);
    });
  });
});
