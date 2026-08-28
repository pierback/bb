import { describe, expect, it } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import { RuntimeTurnCompletionState } from "./runtime-turn-completion-state.js";

function event(value: ThreadEvent): ThreadEvent {
  return value;
}

describe("RuntimeTurnCompletionState", () => {
  it("collects only top-level assistant messages from the next completed turn", async () => {
    const state = new RuntimeTurnCompletionState();
    const observation = state.begin({
      threadId: "thr_destination",
      timeoutMs: 1_000,
    });

    state.observe(
      event({
        type: "turn/started",
        threadId: "thr_destination",
        providerThreadId: "native_destination",
        scope: { kind: "turn", turnId: "turn_restatement" },
      }),
    );
    state.observe(
      event({
        type: "item/completed",
        threadId: "thr_destination",
        providerThreadId: "native_destination",
        scope: { kind: "turn", turnId: "turn_restatement" },
        item: {
          type: "agentMessage",
          id: "msg_nested",
          text: "ignore nested output",
          parentToolCallId: "tool_parent",
        },
      }),
    );
    state.observe(
      event({
        type: "item/completed",
        threadId: "thr_destination",
        providerThreadId: "native_destination",
        scope: { kind: "turn", turnId: "turn_restatement" },
        item: {
          type: "agentMessage",
          id: "msg_root",
          text: '{"capsuleContentHash":"sha256:abc"}',
        },
      }),
    );
    state.observe(
      event({
        type: "turn/completed",
        threadId: "thr_destination",
        providerThreadId: "native_destination",
        scope: { kind: "turn", turnId: "turn_restatement" },
        status: "completed",
      }),
    );

    await expect(observation.promise).resolves.toEqual({
      assistantText: '{"capsuleContentHash":"sha256:abc"}',
      errorMessage: null,
      status: "completed",
      turnId: "turn_restatement",
    });
  });

  it("rejects when the hosted thread detaches", async () => {
    const state = new RuntimeTurnCompletionState();
    const observation = state.begin({
      threadId: "thr_destination",
      timeoutMs: 1_000,
    });

    state.clearThread("thr_destination");

    await expect(observation.promise).rejects.toThrow(
      "detached before its turn completed",
    );
  });
});
