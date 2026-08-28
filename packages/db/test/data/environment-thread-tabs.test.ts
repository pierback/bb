import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import {
  getStoredEnvironmentThreadTabs,
  listEnvironmentThreadTabEligibleIds,
  replaceStoredEnvironmentThreadTabs,
} from "../../src/data/environment-thread-tabs.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread, markThreadDeleted } from "../../src/data/threads.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "tabs-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "tabs-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/tabs" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    isGitRepo: true,
    isWorktree: true,
    managed: true,
    path: "/tmp/tabs-worktree",
    projectId: project.id,
    status: "ready",
    workspaceProvisionType: "managed-worktree",
  });
  return { db, environment, project };
}

describe("environment thread tabs", () => {
  it("stores an ordered tab set with compare-and-swap revisions", () => {
    const { db, environment } = setup();
    expect(getStoredEnvironmentThreadTabs(db, environment.id)).toBeNull();

    expect(
      replaceStoredEnvironmentThreadTabs(db, {
        environmentId: environment.id,
        expectedRevision: 0,
        threadIdsJson: '["thread-b","thread-a"]',
      }),
    ).toEqual({ outcome: "updated", revision: 1 });
    expect(getStoredEnvironmentThreadTabs(db, environment.id)).toEqual({
      revision: 1,
      threadIdsJson: '["thread-b","thread-a"]',
    });

    expect(
      replaceStoredEnvironmentThreadTabs(db, {
        environmentId: environment.id,
        expectedRevision: 0,
        threadIdsJson: "[]",
      }),
    ).toEqual({ outcome: "conflict", revision: 1 });
  });

  it("selects only visible, non-deleted threads in the environment", () => {
    const { db, environment, project } = setup();
    const eligible = createThread(db, noopNotifier, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
      visibility: "visible",
    });
    const hidden = createThread(db, noopNotifier, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
      visibility: "hidden",
    });
    const deleted = createThread(db, noopNotifier, {
      environmentId: environment.id,
      projectId: project.id,
      providerId: "codex",
    });
    markThreadDeleted(db, noopNotifier, { threadId: deleted.id });

    expect(
      listEnvironmentThreadTabEligibleIds(db, {
        environmentId: environment.id,
        threadIds: [eligible.id, hidden.id, deleted.id, "missing"],
      }),
    ).toEqual([eligible.id]);
  });
});
