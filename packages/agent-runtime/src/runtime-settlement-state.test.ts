import { threadScope, turnScope, type ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { RuntimeSettlementState } from "./runtime-settlement-state.js";

const THREAD_ID = "thread-settlement";
const PROVIDER_THREAD_ID = "provider-thread-settlement";
const TURN_ID = "turn-settlement";

function event(
  value: { type: ThreadEvent["type"] } & Record<string, unknown>,
): ThreadEvent {
  return {
    providerThreadId: PROVIDER_THREAD_ID,
    scope: turnScope(TURN_ID),
    threadId: THREAD_ID,
    ...value,
  } as unknown as ThreadEvent;
}

describe("RuntimeSettlementState", () => {
  it("treats a fresh idle thread as observed and a resumed thread as unknown", () => {
    const state = new RuntimeSettlementState();
    state.registerFreshThread(THREAD_ID);
    expect(
      state.snapshot({ activeBackgroundResourceCount: 0, threadId: THREAD_ID }),
    ).toEqual({
      activeBackgroundResourceCount: 0,
      activeToolCount: 0,
      compacting: false,
      externalSideEffectStatus: "not_observed",
      outcomeUnknown: false,
      partialEdit: false,
      retrying: false,
      unknownBackgroundResourceCount: 0,
    });

    state.registerResumedThread(THREAD_ID);
    expect(
      state.snapshot({ activeBackgroundResourceCount: 0, threadId: THREAD_ID }),
    ).toMatchObject({
      externalSideEffectStatus: "unknown",
      outcomeUnknown: true,
      unknownBackgroundResourceCount: 1,
    });
  });

  it("establishes a certain baseline after an end-to-end clean turn", () => {
    const state = new RuntimeSettlementState();
    state.registerResumedThread(THREAD_ID);
    state.observe(event({ type: "turn/started" }));
    state.observe(
      event({
        type: "turn/completed",
        status: "completed",
      }),
    );

    expect(
      state.snapshot({ activeBackgroundResourceCount: 0, threadId: THREAD_ID }),
    ).toMatchObject({
      externalSideEffectStatus: "not_observed",
      outcomeUnknown: false,
      unknownBackgroundResourceCount: 0,
    });
  });

  it("tracks tools, partial edits, compaction, retries, and known side effects", () => {
    const state = new RuntimeSettlementState();
    state.registerFreshThread(THREAD_ID);
    state.observe(event({ type: "turn/started" }));
    state.observe(
      event({
        type: "item/started",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "deploy",
          status: "pending",
        },
      }),
    );
    state.observe(
      event({
        type: "item/started",
        item: {
          type: "fileChange",
          id: "edit-1",
          changes: [{ kind: "update", path: "src/index.ts" }],
          status: "pending",
          approvalStatus: null,
        },
      }),
    );
    state.observe(
      event({
        type: "item/started",
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    state.observe(
      event({
        type: "provider/error",
        message: "retrying",
        willRetry: true,
      }),
    );

    expect(
      state.snapshot({ activeBackgroundResourceCount: 2, threadId: THREAD_ID }),
    ).toMatchObject({
      activeBackgroundResourceCount: 2,
      activeToolCount: 2,
      compacting: true,
      externalSideEffectStatus: "known",
      partialEdit: true,
      retrying: true,
    });

    state.observe(
      event({
        type: "item/completed",
        item: {
          type: "toolCall",
          id: "tool-1",
          tool: "deploy",
          status: "completed",
        },
      }),
    );
    state.observe(
      event({
        type: "item/completed",
        item: {
          type: "fileChange",
          id: "edit-1",
          changes: [{ kind: "update", path: "src/index.ts" }],
          status: "completed",
          approvalStatus: null,
        },
      }),
    );
    state.observe(
      event({
        type: "thread/compacted",
        scope: threadScope(),
      }),
    );
    state.observe(
      event({
        type: "turn/completed",
        status: "completed",
      }),
    );

    expect(
      state.snapshot({ activeBackgroundResourceCount: 0, threadId: THREAD_ID }),
    ).toMatchObject({
      activeToolCount: 0,
      compacting: false,
      externalSideEffectStatus: "known",
      outcomeUnknown: false,
      partialEdit: false,
      retrying: false,
    });
  });

  it("does not guess that a terminal turn settled missing item events", () => {
    const state = new RuntimeSettlementState();
    state.registerFreshThread(THREAD_ID);
    state.observe(
      event({
        type: "item/started",
        item: {
          type: "commandExecution",
          id: "command-1",
          command: "deploy",
          cwd: "/repo",
          status: "pending",
          approvalStatus: null,
        },
      }),
    );
    state.observe(
      event({
        type: "turn/completed",
        status: "interrupted",
      }),
    );

    expect(
      state.snapshot({ activeBackgroundResourceCount: 0, threadId: THREAD_ID }),
    ).toMatchObject({ activeToolCount: 1, outcomeUnknown: true });
  });
});
