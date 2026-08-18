import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

const RESPONSE = {
  currentThreadId: "thread-fork",
  rootThreadId: "thread-root",
  routes: [
    {
      archivedAt: null,
      createdAt: 1,
      path: [
        {
          threadId: "thread-root",
          title: "Original route",
          titleFallback: null,
        },
      ],
      sourceSeqEnd: null,
      sourceThreadId: null,
      status: "idle" as const,
      threadId: "thread-root",
      title: "Original route",
      titleFallback: null,
    },
    {
      archivedAt: null,
      createdAt: 2,
      path: [
        {
          threadId: "thread-root",
          title: "Original route",
          titleFallback: null,
        },
        {
          threadId: "thread-fork",
          title: "Alternate route",
          titleFallback: null,
        },
      ],
      sourceSeqEnd: 42,
      sourceThreadId: "thread-root",
      status: "active" as const,
      threadId: "thread-fork",
      title: "Alternate route",
      titleFallback: null,
    },
  ],
};

describe("bb thread routes command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("lists the selectable conversation family and marks the current route", async () => {
    const get = vi.fn(async () => RESPONSE);
    stubServerApi({ "v1.threads.:id.conversation-routes.$get": get });

    await runCommand(["thread", "routes", "thread-fork"], register);

    expect(get).toHaveBeenCalledWith({ param: { id: "thread-fork" } });
    expect(collectLogLines(vi.mocked(console.log))).toEqual([
      "Conversation routes (2 of 2 selected):",
      "○ Original route · idle · thread-root",
      "● └─ Alternate route · active · thread-fork",
      "Open one with: bb thread open <thread-id>",
    ]);
  });

  it("resolves --self and preserves the complete projection in JSON", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-fork");
    const get = vi.fn(async () => RESPONSE);
    stubServerApi({ "v1.threads.:id.conversation-routes.$get": get });

    await runCommand(["thread", "routes", "--self", "--json"], register);

    expect(
      JSON.parse(vi.mocked(console.log).mock.calls[0]?.[0] as string),
    ).toEqual(RESPONSE);
  });
});
