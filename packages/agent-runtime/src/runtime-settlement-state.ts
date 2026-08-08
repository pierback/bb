import type { ThreadEvent, ThreadEventItem } from "@bb/domain";
import type { AgentRuntimeThreadSettlementState } from "./types.js";

interface MutableThreadSettlementState {
  readonly activeToolIds: Set<string>;
  readonly compactingItemIds: Set<string>;
  externalSideEffectStatus: "known" | "not_observed" | "unknown";
  outcomeUnknown: boolean;
  readonly partialEditItemIds: Set<string>;
  retrying: boolean;
  unknownBackgroundResourceCount: number;
}

function createState(
  source: "fresh" | "resumed",
): MutableThreadSettlementState {
  const observationIsUnknown = source === "resumed";
  return {
    activeToolIds: new Set(),
    compactingItemIds: new Set(),
    externalSideEffectStatus: observationIsUnknown ? "unknown" : "not_observed",
    outcomeUnknown: observationIsUnknown,
    partialEditItemIds: new Set(),
    retrying: false,
    unknownBackgroundResourceCount: observationIsUnknown ? 1 : 0,
  };
}

function isToolItem(item: ThreadEventItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "imageView":
    case "toolCall":
    case "webFetch":
    case "webSearch":
      return true;
    case "agentMessage":
    case "backgroundTask":
    case "contextCompaction":
    case "plan":
    case "reasoning":
    case "userMessage":
      return false;
  }
}

function canHaveExternalSideEffects(item: ThreadEventItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "toolCall":
    case "webFetch":
    case "webSearch":
      return true;
    case "agentMessage":
    case "backgroundTask":
    case "contextCompaction":
    case "fileChange":
    case "imageView":
    case "plan":
    case "reasoning":
    case "userMessage":
      return false;
  }
}

/**
 * Maintains the host-observed facts needed to settle a source before handoff.
 *
 * A resumed native session starts unknown: the runtime did not observe work
 * that may already have been in flight before it attached. A terminal turn
 * observed end-to-end establishes a new baseline. Missing terminal item
 * events remain visible as an unknown outcome instead of being guessed safe.
 */
export class RuntimeSettlementState {
  private readonly byThreadId = new Map<string, MutableThreadSettlementState>();

  clear(): void {
    this.byThreadId.clear();
  }

  clearThread(threadId: string): void {
    this.byThreadId.delete(threadId);
  }

  markOutcomeUnknown(threadId: string): void {
    const state = this.requireState(threadId);
    state.outcomeUnknown = true;
    state.externalSideEffectStatus = "unknown";
  }

  registerFreshThread(threadId: string): void {
    this.byThreadId.set(threadId, createState("fresh"));
  }

  registerResumedThread(threadId: string): void {
    this.byThreadId.set(threadId, createState("resumed"));
  }

  snapshot(args: {
    activeBackgroundResourceCount: number;
    threadId: string;
  }): AgentRuntimeThreadSettlementState {
    const state = this.requireState(args.threadId);
    return {
      activeBackgroundResourceCount: args.activeBackgroundResourceCount,
      activeToolCount: state.activeToolIds.size,
      compacting: state.compactingItemIds.size > 0,
      externalSideEffectStatus: state.externalSideEffectStatus,
      outcomeUnknown: state.outcomeUnknown,
      partialEdit: state.partialEditItemIds.size > 0,
      retrying: state.retrying,
      unknownBackgroundResourceCount: state.unknownBackgroundResourceCount,
    };
  }

  observe(event: ThreadEvent): void {
    const state = this.requireState(event.threadId);

    if (event.type === "turn/started") {
      state.retrying = false;
      if (
        state.activeToolIds.size > 0 ||
        state.compactingItemIds.size > 0 ||
        state.partialEditItemIds.size > 0
      ) {
        state.outcomeUnknown = true;
      }
      return;
    }

    if (event.type === "item/started") {
      if (isToolItem(event.item)) {
        state.activeToolIds.add(event.item.id);
      }
      if (event.item.type === "fileChange") {
        state.partialEditItemIds.add(event.item.id);
      }
      if (event.item.type === "contextCompaction") {
        state.compactingItemIds.add(event.item.id);
      }
      if (canHaveExternalSideEffects(event.item)) {
        state.externalSideEffectStatus = "known";
      }
      return;
    }

    if (event.type === "item/completed") {
      state.activeToolIds.delete(event.item.id);
      state.partialEditItemIds.delete(event.item.id);
      state.compactingItemIds.delete(event.item.id);
      return;
    }

    if (event.type === "thread/compacted") {
      state.compactingItemIds.clear();
      return;
    }

    if (event.type === "provider/error") {
      state.retrying = event.willRetry === true;
      return;
    }

    if (event.type !== "turn/completed") {
      return;
    }

    state.retrying = false;
    state.outcomeUnknown =
      state.activeToolIds.size > 0 ||
      state.compactingItemIds.size > 0 ||
      state.partialEditItemIds.size > 0;
    if (!state.outcomeUnknown) {
      state.unknownBackgroundResourceCount = 0;
      if (state.externalSideEffectStatus === "unknown") {
        state.externalSideEffectStatus = "not_observed";
      }
    }
  }

  private requireState(threadId: string): MutableThreadSettlementState {
    let state = this.byThreadId.get(threadId);
    if (!state) {
      state = createState("resumed");
      this.byThreadId.set(threadId, state);
    }
    return state;
  }
}
