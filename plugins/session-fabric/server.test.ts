import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin, {
  SESSION_FABRIC_PLUGIN_VERSION,
  projectConnection,
} from "./server.js";

const connection = {
  adoptionStatus: "enabled",
  bindingId: "binding-1",
  controlEpoch: 4,
  effectiveModel: { modelId: "gpt-5.6", providerId: "codex" },
  environmentId: "environment-1",
  isActiveAuthority: true,
  mutationPolicy: "enabled",
  nativeConversation: {
    catalogConversationId: "catalog-1",
    cwd: "/workspace/project",
    hostId: "host-this-mac",
    lastObservedAt: 1_786_000_000_000,
    nativeConversationId: "conversation-1",
    providerId: "codex",
    providerInstanceId: "codex-default",
    providerState: "idle",
    title: "Implement portable sessions",
  },
  openedAt: 1_785_000_000_000,
  ownership: "owned_brokered",
  phase: "idle",
  reasoningLevel: "high",
  runtime: { id: "runtime-1", status: "live" },
  serviceTier: "fast",
  threadId: "thread-1",
  updatedAt: 1_786_000_000_000,
} as const;

function fakeHost() {
  return createFakePluginHost({
    pluginId: "session-fabric",
    sdk: {
      sessionFabric: {
        async threadConnection({ threadId }: { threadId: string }) {
          return {
            connection: threadId === connection.threadId ? connection : null,
          } as never;
        },
        async connectThread({ threadId }: { threadId: string }) {
          return {
            connection: { ...connection, threadId },
          } as never;
        },
        async commandAudit({ commandId }: { commandId: string }) {
          return {
            command: {
              id: commandId,
              kind: "change_model",
              status: "committed",
              bindingId: connection.bindingId,
            },
            events: [{ id: "event-1" }],
            modelEpoch: null,
            receipt: { id: "receipt-1" },
          } as never;
        },
        async handoffAudit({ transitionId }: { transitionId: string }) {
          return {
            transition: {
              id: transitionId,
              phase: "completed",
              sourceBindingId: connection.bindingId,
              destinationThreadId: "thread-2",
            },
            events: [],
            authorization: { id: "authorization-1" },
            capsule: { id: "capsule-1" },
            review: null,
            restatement: null,
            settlement: { id: "settlement-1" },
          } as never;
        },
      },
    },
  });
}

describe("Session Fabric plugin", () => {
  it("projects the public SDK connection into its own app contract", () => {
    expect(projectConnection(connection)).toEqual(connection);
  });

  it("registers typed RPC and the operator CLI", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);

    await expect(
      harness.callRpc("threadConnection", { threadId: "thread-1" }),
    ).resolves.toEqual({ connection });
    await expect(
      harness.callRpc("threadConnection", { threadId: "thread-missing" }),
    ).resolves.toEqual({ connection: null });

    const connected = await harness.runCli(["connect", "thread-new", "--json"]);
    expect(connected.exitCode).toBe(0);
    expect(JSON.parse(connected.stdout)).toMatchObject({
      connection: { threadId: "thread-new", bindingId: "binding-1" },
    });

    expect(harness.logEntries).toContainEqual({
      level: "info",
      message: `Session Fabric ${SESSION_FABRIC_PLUGIN_VERSION} loaded`,
    });
    await harness.dispose();
  });

  it("renders status and durable audits for operators", async () => {
    const { bb, harness } = fakeHost();
    await plugin(bb);

    await expect(harness.runCli(["status", "thread-1"])).resolves.toMatchObject(
      {
        exitCode: 0,
        stdout: expect.stringContaining("Active authority".toLowerCase()),
      },
    );
    await expect(
      harness.runCli(["command", "command-1"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Status: committed"),
    });
    await expect(
      harness.runCli(["handoff", "transition-1"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining(
        "Evidence: authorization, capsule, settlement",
      ),
    });
    await expect(harness.runCli(["status"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("thread id is required"),
    });
    await harness.dispose();
  });
});
