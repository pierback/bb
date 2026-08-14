import {
  getLastStoredTurnRequestEvent,
  getLatestStoredEventRowByType,
  getStoredTurnRequestEventForTurn,
  getThread,
  type DbQueryConnection,
} from "@bb/db";
import {
  clientTurnRequestIdSchema,
  resolvedThreadExecutionOptionsSchema,
  type ClientTurnRequestId,
  type Environment,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
  type Thread,
} from "@bb/domain";
import type { RetryThreadResponse } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { parseStoredEvent } from "./thread-data.js";
import { parseStoredTurnRequestEvent } from "./thread-events.js";
import {
  continueThreadAfterProviderRateLimit,
  getProviderRateLimitRecoveryStatus,
} from "./provider-rate-limit-recovery.js";
import { sendThreadMessage } from "./thread-send.js";

interface ThreadRetryCandidate {
  execution: ResolvedThreadExecutionOptions;
  failedRequestId: ClientTurnRequestId;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  requestSequence: number;
}

interface InspectThreadRetryArgs {
  db: DbQueryConnection;
  thread: Thread;
}

function hasCurrentCommandFailure(
  args: InspectThreadRetryArgs,
  requestSequence: number,
): boolean {
  const row = getLatestStoredEventRowByType(args.db, {
    threadId: args.thread.id,
    type: "system/error",
  });
  if (!row || row.sequence <= requestSequence) {
    return false;
  }
  const event = parseStoredEvent(row);
  return (
    event.type === "system/error" && event.code === "thread_command_failed"
  );
}

function hasCurrentFailedTurn(
  args: InspectThreadRetryArgs,
  requestSequence: number,
): boolean {
  const completedRow = getLatestStoredEventRowByType(args.db, {
    threadId: args.thread.id,
    type: "turn/completed",
  });
  if (!completedRow || completedRow.turnId === null) {
    return false;
  }
  const completed = parseStoredEvent(completedRow);
  if (completed.type !== "turn/completed" || completed.status !== "failed") {
    return false;
  }
  const requestRow = getStoredTurnRequestEventForTurn(args.db, {
    threadId: args.thread.id,
    turnId: completedRow.turnId,
  });
  return requestRow?.sequence === requestSequence;
}

function inspectThreadRetry(
  args: InspectThreadRetryArgs,
): ThreadRetryCandidate | null {
  if (args.thread.status !== "error") {
    return null;
  }
  const requestRow = getLastStoredTurnRequestEvent(args.db, args.thread.id);
  if (!requestRow) {
    return null;
  }
  const request = parseStoredTurnRequestEvent(requestRow);
  if (
    request.initiator !== "user" ||
    request.senderThreadId !== null ||
    request.input.length === 0
  ) {
    return null;
  }
  if (
    !hasCurrentCommandFailure(args, requestRow.sequence) &&
    !hasCurrentFailedTurn(args, requestRow.sequence)
  ) {
    return null;
  }
  const execution = resolvedThreadExecutionOptionsSchema.safeParse(
    request.execution,
  );
  const failedRequestId = clientTurnRequestIdSchema.safeParse(
    request.requestId,
  );
  if (!execution.success || !failedRequestId.success) {
    return null;
  }
  return {
    execution: execution.data,
    failedRequestId: failedRequestId.data,
    input: request.input,
    ...(request.inputGroups !== undefined
      ? { inputGroups: request.inputGroups }
      : {}),
    requestSequence: requestRow.sequence,
  };
}

function retryUnavailableError(): ApiError {
  return new ApiError(
    409,
    "thread_retry_unavailable",
    "This thread no longer has a current failed user request to retry.",
  );
}

function requireMatchingCandidate(
  candidate: ThreadRetryCandidate | null,
  failedRequestId: ClientTurnRequestId | undefined,
): ThreadRetryCandidate {
  if (
    candidate === null ||
    (failedRequestId !== undefined &&
      candidate.failedRequestId !== failedRequestId)
  ) {
    throw retryUnavailableError();
  }
  return candidate;
}

export async function retryThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    environment: Environment;
    failedRequestId?: ClientTurnRequestId;
    thread: Thread;
  },
): Promise<RetryThreadResponse> {
  const candidate = requireMatchingCandidate(
    inspectThreadRetry({ db: deps.db, thread: args.thread }),
    args.failedRequestId,
  );
  const rateLimitRecovery = getProviderRateLimitRecoveryStatus(deps, {
    environment: args.environment,
    thread: args.thread,
  });
  if (
    rateLimitRecovery.candidate?.failedRequestId === candidate.failedRequestId
  ) {
    await continueThreadAfterProviderRateLimit(deps, {
      environment: args.environment,
      failedRequestId: candidate.failedRequestId,
      thread: args.thread,
    });
    return {
      ok: true,
      failedRequestId: candidate.failedRequestId,
      kind: "continued",
    };
  }

  await sendThreadMessage(deps, {
    beforeAppendInTransaction: ({ tx }) => {
      const currentThread = getThread(tx, args.thread.id);
      if (!currentThread) {
        throw retryUnavailableError();
      }
      const currentCandidate = requireMatchingCandidate(
        inspectThreadRetry({ db: tx, thread: currentThread }),
        candidate.failedRequestId,
      );
      if (currentCandidate.requestSequence !== candidate.requestSequence) {
        throw retryUnavailableError();
      }
    },
    environment: args.environment,
    payload: {
      input: candidate.input,
      ...(candidate.inputGroups !== undefined
        ? { inputGroups: candidate.inputGroups }
        : {}),
      mode: "start",
      model: candidate.execution.model,
      permissionMode: candidate.execution.permissionMode,
      reasoningLevel: candidate.execution.reasoningLevel,
      serviceTier: candidate.execution.serviceTier,
    },
    skipPluginMentionResolution: true,
    thread: args.thread,
    trigger: "user",
  });
  return {
    ok: true,
    failedRequestId: candidate.failedRequestId,
    kind: "replayed",
  };
}
