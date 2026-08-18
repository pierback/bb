import {
  getThread,
  listVisibleConversationForksBySourceThreadIds,
  type ConversationRouteThreadRow,
  type DbConnection,
} from "@bb/db";
import type {
  ConversationRoute,
  ConversationRouteStep,
  ThreadConversationRoutesResponse,
} from "@bb/server-contract";
import { requirePublicThread } from "../lib/entity-lookup.js";

interface ThreadConversationRoutesDeps {
  db: DbConnection;
}

interface GetThreadConversationRoutesArgs {
  threadId: string;
}

type StoredThread = NonNullable<ReturnType<typeof getThread>>;

function toRouteThread(thread: StoredThread): ConversationRouteThreadRow {
  return {
    archivedAt: thread.archivedAt,
    createdAt: thread.createdAt,
    id: thread.id,
    sourceSeqEnd: thread.sourceSeqEnd,
    sourceThreadId: thread.sourceThreadId,
    status: thread.status,
    title: thread.title,
    titleFallback: thread.titleFallback,
  };
}

function toRouteStep(
  thread: ConversationRouteThreadRow,
): ConversationRouteStep {
  return {
    threadId: thread.id,
    title: thread.title,
    titleFallback: thread.titleFallback,
  };
}

function buildRoutePath(
  thread: ConversationRouteThreadRow,
  threadsById: ReadonlyMap<string, ConversationRouteThreadRow>,
): ConversationRouteStep[] {
  const reversedPath: ConversationRouteStep[] = [];
  const seen = new Set<string>();
  let current: ConversationRouteThreadRow | undefined = thread;

  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    reversedPath.push(toRouteStep(current));
    current =
      current.sourceThreadId === null
        ? undefined
        : threadsById.get(current.sourceThreadId);
  }

  return reversedPath.reverse();
}

function compareRouteThreads(
  left: ConversationRouteThreadRow,
  right: ConversationRouteThreadRow,
): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function toConversationRoute(
  thread: ConversationRouteThreadRow,
  threadsById: ReadonlyMap<string, ConversationRouteThreadRow>,
): ConversationRoute {
  return {
    archivedAt: thread.archivedAt,
    createdAt: thread.createdAt,
    path: buildRoutePath(thread, threadsById),
    sourceSeqEnd: thread.sourceSeqEnd,
    sourceThreadId: thread.sourceThreadId,
    status: thread.status,
    threadId: thread.id,
    title: thread.title,
    titleFallback: thread.titleFallback,
  };
}

function orderRouteFamily(
  rootThreadId: string,
  threadsById: ReadonlyMap<string, ConversationRouteThreadRow>,
): ConversationRouteThreadRow[] {
  const childrenBySourceId = new Map<string, ConversationRouteThreadRow[]>();
  for (const thread of threadsById.values()) {
    if (thread.sourceThreadId === null || thread.id === rootThreadId) {
      continue;
    }
    const siblings = childrenBySourceId.get(thread.sourceThreadId) ?? [];
    siblings.push(thread);
    childrenBySourceId.set(thread.sourceThreadId, siblings);
  }
  for (const siblings of childrenBySourceId.values()) {
    siblings.sort(compareRouteThreads);
  }

  const ordered: ConversationRouteThreadRow[] = [];
  const visited = new Set<string>();
  const visit = (threadId: string): void => {
    if (visited.has(threadId)) {
      return;
    }
    const thread = threadsById.get(threadId);
    if (thread === undefined) {
      return;
    }
    visited.add(threadId);
    ordered.push(thread);
    for (const child of childrenBySourceId.get(threadId) ?? []) {
      visit(child.id);
    }
  };
  visit(rootThreadId);
  return ordered;
}

/**
 * Project one immutable conversation-fork family into user-selectable routes.
 * Git branches and worktrees deliberately do not participate in this graph.
 */
export function getThreadConversationRoutes(
  deps: ThreadConversationRoutesDeps,
  args: GetThreadConversationRoutesArgs,
): ThreadConversationRoutesResponse {
  const currentThread = requirePublicThread(deps.db, args.threadId);

  // Hidden plugin-owned forks are operational context, not user-selectable
  // conversation routes. Keep their response self-contained so clients can
  // mount the query unconditionally without leaking hidden siblings.
  if (currentThread.visibility !== "visible") {
    const current = toRouteThread(currentThread);
    const currentById = new Map([[current.id, current]]);
    return {
      currentThreadId: current.id,
      rootThreadId: current.id,
      routes: [toConversationRoute(current, currentById)],
    };
  }

  const threadsById = new Map<string, ConversationRouteThreadRow>();
  let root = currentThread;
  threadsById.set(root.id, toRouteThread(root));
  const ancestorIds = new Set([root.id]);

  while (root.originKind === "fork" && root.sourceThreadId !== null) {
    if (ancestorIds.has(root.sourceThreadId)) {
      break;
    }
    const source = getThread(deps.db, root.sourceThreadId);
    if (
      source === null ||
      source.projectId !== currentThread.projectId ||
      source.deletedAt !== null ||
      source.visibility !== "visible"
    ) {
      break;
    }
    ancestorIds.add(source.id);
    threadsById.set(source.id, toRouteThread(source));
    root = source;
  }

  let frontier = [root.id];
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const child of listVisibleConversationForksBySourceThreadIds(deps.db, {
      projectId: currentThread.projectId,
      sourceThreadIds: frontier,
    })) {
      if (threadsById.has(child.id)) {
        continue;
      }
      threadsById.set(child.id, child);
      nextFrontier.push(child.id);
    }
    frontier = nextFrontier;
  }

  const routes: ConversationRoute[] = orderRouteFamily(
    root.id,
    threadsById,
  ).map((thread) => toConversationRoute(thread, threadsById));

  return {
    currentThreadId: currentThread.id,
    rootThreadId: root.id,
    routes,
  };
}
