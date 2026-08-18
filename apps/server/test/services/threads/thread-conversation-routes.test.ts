import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveThread,
  createConnection,
  createProject,
  createThread,
  markThreadDeleted,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import { getThreadConversationRoutes } from "../../../src/services/threads/thread-conversation-routes.js";

describe("thread conversation routes", () => {
  let db: DbConnection;
  let projectId: string;

  beforeEach(() => {
    db = createConnection(":memory:");
    migrate(db);
    const host = upsertHost(db, noopNotifier, {
      name: "conversation-route-host",
      type: "persistent",
    });
    projectId = createProject(db, noopNotifier, {
      name: "Conversation routes",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/conversation-routes",
      },
    }).project.id;
  });

  afterEach(() => {
    db.$client.close();
  });

  it("projects the complete visible fork family from any selected route", () => {
    const root = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      status: "idle",
      title: "Original",
    });
    const firstFork = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      originKind: "fork",
      sourceSeqEnd: 12,
      sourceThreadId: root.id,
      status: "active",
      title: "Try API approach",
    });
    const nestedFork = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      originKind: "fork",
      sourceSeqEnd: 28,
      sourceThreadId: firstFork.id,
      status: "error",
      title: "Recover API approach",
    });
    const secondFork = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      originKind: "fork",
      sourceSeqEnd: 20,
      sourceThreadId: root.id,
      status: "idle",
      title: "Try UI approach",
    });
    archiveThread(db, noopNotifier, secondFork.id);

    const hiddenFork = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      originKind: "fork",
      sourceSeqEnd: 30,
      sourceThreadId: root.id,
      title: "Plugin worker",
      visibility: "hidden",
    });
    const deletedFork = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      originKind: "fork",
      sourceSeqEnd: 31,
      sourceThreadId: root.id,
      title: "Deleted route",
    });
    markThreadDeleted(db, noopNotifier, { threadId: deletedFork.id });
    createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      title: "Unrelated conversation",
    });

    const result = getThreadConversationRoutes(
      { db },
      { threadId: nestedFork.id },
    );

    expect(result.currentThreadId).toBe(nestedFork.id);
    expect(result.rootThreadId).toBe(root.id);
    expect(result.routes[0]?.threadId).toBe(root.id);
    expect(
      new Set(result.routes.slice(1).map((route) => route.threadId)),
    ).toEqual(new Set([firstFork.id, nestedFork.id, secondFork.id]));
    expect(
      result.routes.find((route) => route.threadId === nestedFork.id),
    ).toMatchObject({
      sourceSeqEnd: 28,
      sourceThreadId: firstFork.id,
      path: [
        { threadId: root.id, title: "Original" },
        { threadId: firstFork.id, title: "Try API approach" },
        { threadId: nestedFork.id, title: "Recover API approach" },
      ],
    });
    expect(
      result.routes.find((route) => route.threadId === secondFork.id)
        ?.archivedAt,
    ).not.toBeNull();
    expect(
      result.routes.some((route) => route.threadId === hiddenFork.id),
    ).toBe(false);
  });

  it("keeps a hidden plugin fork self-contained", () => {
    const root = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      title: "Visible source",
    });
    const hiddenFork = createThread(db, noopNotifier, {
      projectId,
      providerId: "codex",
      originKind: "fork",
      sourceSeqEnd: 4,
      sourceThreadId: root.id,
      title: "Hidden worker",
      visibility: "hidden",
    });

    expect(
      getThreadConversationRoutes({ db }, { threadId: hiddenFork.id }),
    ).toMatchObject({
      currentThreadId: hiddenFork.id,
      rootThreadId: hiddenFork.id,
      routes: [
        { threadId: hiddenFork.id, path: [{ threadId: hiddenFork.id }] },
      ],
    });
  });
});
