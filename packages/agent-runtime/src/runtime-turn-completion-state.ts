import { requireThreadEventScopeTurnId, type ThreadEvent } from "@bb/domain";
import type { RunTurnAndWaitForCompletionResult } from "./types.js";

interface PendingTurnCompletion {
  assistantMessages: string[];
  reject: (error: Error) => void;
  resolve: (result: RunTurnAndWaitForCompletionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  turnId: string | null;
}

export interface BeginTurnCompletionObservationArgs {
  threadId: string;
  timeoutMs: number;
}

export interface PendingTurnCompletionObservation {
  cancel(error: Error): void;
  promise: Promise<RunTurnAndWaitForCompletionResult>;
}

/**
 * One-shot observation for the next top-level turn on an idle hosted thread.
 * Registration happens before dispatch so even a provider that completes in
 * the same event-loop tick cannot outrun the waiter.
 */
export class RuntimeTurnCompletionState {
  private readonly pendingByThreadId = new Map<string, PendingTurnCompletion>();

  begin(
    args: BeginTurnCompletionObservationArgs,
  ): PendingTurnCompletionObservation {
    if (this.pendingByThreadId.has(args.threadId)) {
      throw new Error(
        `thread ${args.threadId} already has a pending turn completion observation`,
      );
    }

    let pending!: PendingTurnCompletion;
    const promise = new Promise<RunTurnAndWaitForCompletionResult>(
      (resolve, reject) => {
        pending = {
          assistantMessages: [],
          reject,
          resolve,
          timeout: setTimeout(() => {
            if (this.pendingByThreadId.get(args.threadId) !== pending) {
              return;
            }
            this.pendingByThreadId.delete(args.threadId);
            reject(
              new Error(
                `timed out waiting for a completed provider turn on thread ${args.threadId}`,
              ),
            );
          }, args.timeoutMs),
          turnId: null,
        };
      },
    );
    this.pendingByThreadId.set(args.threadId, pending);

    return {
      cancel: (error) => this.rejectThread(args.threadId, error),
      promise,
    };
  }

  clear(): void {
    for (const threadId of [...this.pendingByThreadId.keys()]) {
      this.rejectThread(
        threadId,
        new Error(`runtime shut down while waiting for thread ${threadId}`),
      );
    }
  }

  clearThread(threadId: string): void {
    this.rejectThread(
      threadId,
      new Error(`thread ${threadId} detached before its turn completed`),
    );
  }

  observe(event: ThreadEvent): void {
    const pending = this.pendingByThreadId.get(event.threadId);
    if (!pending) {
      return;
    }

    if (event.type === "turn/started") {
      if (event.parentToolCallId || pending.turnId !== null) {
        return;
      }
      pending.turnId = requireThreadEventScopeTurnId({
        scope: event.scope,
        type: event.type,
      });
      return;
    }

    if (
      event.type === "item/completed" &&
      pending.turnId !== null &&
      event.item.type === "agentMessage" &&
      !event.item.parentToolCallId &&
      requireThreadEventScopeTurnId({
        scope: event.scope,
        type: event.type,
      }) === pending.turnId
    ) {
      pending.assistantMessages.push(event.item.text);
      return;
    }

    if (event.type !== "turn/completed" || pending.turnId === null) {
      return;
    }
    const turnId = requireThreadEventScopeTurnId({
      scope: event.scope,
      type: event.type,
    });
    if (turnId !== pending.turnId) {
      return;
    }

    this.pendingByThreadId.delete(event.threadId);
    clearTimeout(pending.timeout);
    pending.resolve({
      assistantText: pending.assistantMessages.join("\n\n"),
      errorMessage: event.error?.message ?? null,
      status: event.status,
      turnId,
    });
  }

  private rejectThread(threadId: string, error: Error): void {
    const pending = this.pendingByThreadId.get(threadId);
    if (!pending) {
      return;
    }
    this.pendingByThreadId.delete(threadId);
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
}
