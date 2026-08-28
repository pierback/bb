import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  events,
  getExperiments,
  getThread,
  getThreadByCreationOperation,
  hasQueuedThreadMessages,
  hasRootStoredTurnStarted,
  listActiveBackgroundTaskCountsByThreadIds,
  type DbQueryConnection,
} from "@bb/db";
import type { Thread } from "@bb/domain";
import type { EditMessageRequest } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { parseStoredTurnRequestEvent } from "./thread-events.js";
import { parseStoredEvent } from "./thread-data.js";
import { createThreadForkFromRequest } from "./thread-fork.js";
import { resolveMessageSenderThreadId } from "./thread-send.js";

interface EditableTurn {
  requestSequence: number;
  /** Completed source event to retain, or zero for the first user message. */
  sourceSeqEnd: number;
}

type EditExecutionField =
  | "model"
  | "permissionMode"
  | "reasoningLevel"
  | "serviceTier";

function resolveExecutionOverride<TField extends EditExecutionField>(
  payload: EditMessageRequest,
  field: TField,
): EditMessageRequest[TField] | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  const sources = payload.executionInputSources;
  return sources === undefined || sources[field] !== undefined
    ? value
    : undefined;
}

function conflict(message: string): never {
  throw new ApiError(409, "invalid_request", message);
}

function editMessageOperationFingerprint(payload: EditMessageRequest): string {
  const { operationId: _operationId, ...request } = payload;
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function requireMatchingCreationOperation(
  thread: NonNullable<ReturnType<typeof getThreadByCreationOperation>>,
  fingerprint: string,
) {
  if (thread.creationOperationFingerprint !== fingerprint) {
    conflict("This operationId was already used for a different edit request");
  }
  if (thread.deletedAt !== null) {
    conflict("The fork created by this edit operation has been deleted");
  }
  return thread;
}

function getTurnCompletion(
  db: DbQueryConnection,
  threadId: string,
  turnId: string,
) {
  const row = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "turn/completed"),
        eq(events.turnId, turnId),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (!row) return null;
  const event = parseStoredEvent(row);
  return event.type === "turn/completed"
    ? { event, sequence: row.sequence }
    : null;
}

const CODEX_NATIVE_TURN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider checkpoint a completed root turn can be re-created through.
 * New timelines persist this explicitly. Older Codex timelines used their
 * native UUID as the turn id, so retain the single legacy read in one place.
 */
export function resolveTurnProviderCheckpointId(args: {
  providerCheckpointId: string | null | undefined;
  providerId: string;
  turnId: string;
}): string | null {
  if (args.providerCheckpointId) {
    return args.providerCheckpointId;
  }
  return args.providerId === "codex" &&
    CODEX_NATIVE_TURN_ID_PATTERN.test(args.turnId)
    ? args.turnId
    : null;
}

function resolveEditableTurnCandidate(
  db: DbQueryConnection,
  thread: Thread,
  requestRow: Parameters<typeof parseStoredTurnRequestEvent>[0],
): EditableTurn {
  const request = parseStoredTurnRequestEvent(requestRow);
  if (
    request.initiator !== "user" ||
    request.senderThreadId !== null ||
    (request.target.kind !== "new-turn" &&
      request.target.kind !== "thread-start")
  ) {
    conflict("The selected request is not an editable user turn");
  }
  if (request.inputGroups !== undefined) {
    conflict("Grouped messages cannot be edited yet");
  }

  const acceptedRows = db
    .select({ sequence: events.sequence, turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "turn/input/accepted"),
        sql`json_extract(${events.data}, '$.clientRequestId') = ${request.requestId}`,
      ),
    )
    .orderBy(events.sequence)
    .limit(2)
    .all();
  const accepted = acceptedRows.length === 1 ? acceptedRows[0] : undefined;
  if (!accepted?.turnId) {
    conflict("The selected request was not accepted into exactly one turn");
  }
  if (
    !hasRootStoredTurnStarted(db, {
      threadId: thread.id,
      turnId: accepted.turnId,
    })
  ) {
    conflict("The selected message does not belong to a root turn");
  }
  const turnAcceptedCount = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "turn/input/accepted"),
        eq(events.turnId, accepted.turnId),
      ),
    )
    .get()?.count;
  if (turnAcceptedCount !== 1) {
    conflict(
      "A turn containing steers or multiple accepted messages cannot be edited",
    );
  }

  const precedingTurn = db
    .select({ turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "turn/started"),
        lt(events.sequence, requestRow.sequence),
        sql`COALESCE(json_extract(${events.data}, '$.parentToolCallId'), '') = ''`,
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  const precedingTurnId = precedingTurn?.turnId ?? null;
  if (precedingTurnId === null) {
    return { requestSequence: requestRow.sequence, sourceSeqEnd: 0 };
  }

  const precedingCompletion = getTurnCompletion(db, thread.id, precedingTurnId);
  if (
    precedingCompletion === null ||
    precedingCompletion.event.providerThreadId === null
  ) {
    conflict("This earlier turn has no provider history");
  }
  const precedingProviderCheckpoint = resolveTurnProviderCheckpointId({
    providerCheckpointId: precedingCompletion.event.providerCheckpointId,
    providerId: thread.providerId,
    turnId: precedingTurnId,
  });
  if (precedingProviderCheckpoint === null) {
    conflict("This earlier provider turn has no editable history checkpoint");
  }
  return {
    requestSequence: requestRow.sequence,
    sourceSeqEnd: precedingCompletion.sequence,
  };
}

function resolveEditableTurn(
  db: DbQueryConnection,
  thread: Thread,
  supportsSessionRewind: boolean,
  requestSequence?: number,
): EditableTurn {
  if (!supportsSessionRewind) {
    conflict(`Editing messages is not supported for ${thread.providerId}`);
  }
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    conflict("The thread is not writable");
  }
  if (thread.status !== "idle" && thread.status !== "error") {
    conflict("Wait for the current turn to finish before editing a message");
  }
  if (hasQueuedThreadMessages(db, thread.id)) {
    conflict("Send or remove queued messages before editing a message");
  }
  const backgroundActivity = listActiveBackgroundTaskCountsByThreadIds(db, {
    threadIds: [thread.id],
  })[0];
  if (
    backgroundActivity &&
    (backgroundActivity.activeBackgroundAgentCount > 0 ||
      backgroundActivity.activeBackgroundCommandCount > 0 ||
      backgroundActivity.activeWorkflowCount > 0)
  ) {
    conflict("Wait for background work to finish before editing the message");
  }

  if (requestSequence !== undefined) {
    const requestRow = db
      .select({
        data: events.data,
        sequence: events.sequence,
        threadId: events.threadId,
        type: events.type,
      })
      .from(events)
      .where(
        and(
          eq(events.threadId, thread.id),
          eq(events.type, "client/turn/requested"),
          eq(events.sequence, requestSequence),
        ),
      )
      .limit(1)
      .get();
    if (requestRow !== undefined) {
      return resolveEditableTurnCandidate(db, thread, requestRow);
    }
    conflict("The thread has no editable user message");
  }

  const requestRows = db
    .select({
      data: events.data,
      sequence: events.sequence,
      threadId: events.threadId,
      type: events.type,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "client/turn/requested"),
        sql`json_extract(${events.data}, '$.initiator') = 'user'`,
        sql`json_extract(${events.data}, '$.senderThreadId') IS NULL`,
        sql`json_extract(${events.data}, '$.target.kind') IN ('new-turn', 'thread-start')`,
      ),
    )
    .orderBy(desc(events.sequence))
    .all();
  for (const requestRow of requestRows) {
    try {
      return resolveEditableTurnCandidate(db, thread, requestRow);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        error.body.code !== "invalid_request"
      ) {
        throw error;
      }
    }
  }
  conflict("The thread has no editable user message");
}

export async function editThreadMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    payload: EditMessageRequest;
    thread: Thread;
  },
) {
  const sourceThread = getThread(deps.db, args.thread.id);
  if (!sourceThread) conflict("Thread not found");
  const operationFingerprint = editMessageOperationFingerprint(args.payload);
  const existingOperation = getThreadByCreationOperation(deps.db, {
    operationId: args.payload.operationId,
    sourceThreadId: sourceThread.id,
  });
  if (existingOperation !== null) {
    return requireMatchingCreationOperation(
      existingOperation,
      operationFingerprint,
    );
  }
  if (!getExperiments(deps.db).editMessages) {
    conflict("Enable the Edit messages experiment before editing a message");
  }
  if (deps.pendingInteractions.hasPendingThreadInteraction(args.thread.id)) {
    conflict("Resolve the pending interaction before editing the message");
  }
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: args.payload.senderThreadId,
    targetThread: sourceThread,
  });
  const target = resolveEditableTurn(
    deps.db,
    sourceThread,
    deps.providerRegistry.supportsSessionRewind(sourceThread.providerId),
    args.payload.expectedRequestSequence,
  );
  const model = resolveExecutionOverride(args.payload, "model");
  const permissionMode = resolveExecutionOverride(
    args.payload,
    "permissionMode",
  );
  const reasoningLevel = resolveExecutionOverride(
    args.payload,
    "reasoningLevel",
  );
  const serviceTier = resolveExecutionOverride(args.payload, "serviceTier");

  try {
    return await createThreadForkFromRequest(
      deps,
      {
        sourceThreadId: sourceThread.id,
        sourceSeqEnd: target.sourceSeqEnd,
        input: args.payload.input,
        ...(permissionMode === undefined ? {} : { permissionMode }),
        visibility: sourceThread.visibility,
        workspace: "reuse",
        origin: "sdk",
      },
      {
        creationOperation: {
          fingerprint: operationFingerprint,
          id: args.payload.operationId,
        },
        permissionInitiator: senderThreadId === null ? "user" : "agent",
        execution: {
          ...(model === undefined ? {} : { model }),
          ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
          ...(serviceTier === undefined ? {} : { serviceTier }),
          ...(args.payload.executionInputSources === undefined
            ? {}
            : {
                executionInputSources: args.payload.executionInputSources,
              }),
        },
      },
    );
  } catch (error) {
    const concurrentlyCreated = getThreadByCreationOperation(deps.db, {
      operationId: args.payload.operationId,
      sourceThreadId: sourceThread.id,
    });
    if (concurrentlyCreated !== null) {
      return requireMatchingCreationOperation(
        concurrentlyCreated,
        operationFingerprint,
      );
    }
    throw error;
  }
}
