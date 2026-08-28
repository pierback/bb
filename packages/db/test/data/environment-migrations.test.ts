import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import {
  createEnvironmentMigration,
  getActiveEnvironmentMigration,
  getEnvironmentMigration,
  listRecoverableEnvironmentMigrations,
  recordEnvironmentMigrationAuthorityCutover,
  updateEnvironmentMigration,
} from "../../src/data/environment-migrations.js";
import {
  createEnvironment,
  getEnvironment,
} from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const sourceHost = upsertHost(db, noopNotifier, {
    name: "source",
    type: "persistent",
  });
  const targetHost = upsertHost(db, noopNotifier, {
    name: "target",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "migration-project",
    source: {
      type: "local_path",
      hostId: sourceHost.id,
      path: "/source/project",
    },
  });
  const environment = createEnvironment(db, noopNotifier, {
    hostId: sourceHost.id,
    managed: true,
    path: "/source/project",
    projectId: project.id,
    status: "ready",
    workspaceProvisionType: "managed-worktree",
  });
  return { db, environment, sourceHost, targetHost };
}

describe("environment migration persistence", () => {
  it("persists checkpoints and resumable artifact progress", () => {
    const { db, environment, sourceHost, targetHost } = setup();
    const created = createEnvironmentMigration(db, {
      id: "migration-1",
      environmentId: environment.id,
      sourceHostId: sourceHost.id,
      targetHostId: targetHost.id,
      workspacePath: "/source/project",
      workspaceProvisionType: "managed-worktree",
      providerSessions: [
        { providerId: "codex", providerThreadId: "provider-thread-1" },
      ],
    });

    expect(created).toMatchObject({
      checkpoint: "created",
      artifactIndex: 0,
      artifactOffset: 0,
      bytesTransferred: 0,
    });

    updateEnvironmentMigration(db, created.id, {
      checkpoint: "target_started",
      stage: "transferring",
      artifactIndex: 2,
      artifactOffset: 512,
      bytesTransferred: 4_096,
      totalBytes: 8_192,
      manifest: { artifacts: [] },
    });

    expect(getEnvironmentMigration(db, created.id)).toMatchObject({
      checkpoint: "target_started",
      artifactIndex: 2,
      artifactOffset: 512,
      bytesTransferred: 4_096,
      totalBytes: 8_192,
      providerSessions: [
        { providerId: "codex", providerThreadId: "provider-thread-1" },
      ],
    });
    expect(
      listRecoverableEnvironmentMigrations(db, targetHost.id).map(
        (migration) => migration.id,
      ),
    ).toEqual([created.id]);
  });

  it("allows only one unfinished migration for an environment", () => {
    const { db, environment, sourceHost, targetHost } = setup();
    const input = {
      environmentId: environment.id,
      sourceHostId: sourceHost.id,
      targetHostId: targetHost.id,
      workspacePath: "/source/project",
      workspaceProvisionType: "managed-worktree" as const,
      providerSessions: [],
    };
    createEnvironmentMigration(db, { ...input, id: "migration-active" });

    expect(() =>
      createEnvironmentMigration(db, { ...input, id: "migration-conflict" }),
    ).toThrow(/UNIQUE constraint failed|active_environment/u);
    expect(getActiveEnvironmentMigration(db, environment.id)?.id).toBe(
      "migration-active",
    );

    updateEnvironmentMigration(db, "migration-active", {
      checkpoint: "rolled_back",
      completedAt: Date.now(),
      stage: "failed",
    });
    expect(
      createEnvironmentMigration(db, {
        ...input,
        id: "migration-after-rollback",
      }).id,
    ).toBe("migration-after-rollback");
  });

  it("atomically records authority cutover while preserving managed semantics", () => {
    const { db, environment, sourceHost, targetHost } = setup();
    createEnvironmentMigration(db, {
      id: "migration-cutover",
      environmentId: environment.id,
      sourceHostId: sourceHost.id,
      targetHostId: targetHost.id,
      workspacePath: "/source/project",
      workspaceProvisionType: "managed-worktree",
      providerSessions: [],
    });
    const restoredWorkspace = {
      path: "/target/restored-project",
      isGitRepo: true,
      isWorktree: false,
      branchName: "feature/moved",
      defaultBranch: "main",
    };
    updateEnvironmentMigration(db, "migration-cutover", {
      checkpoint: "target_restored",
      restoredWorkspace,
      stage: "cutting_over",
    });

    const cutover = recordEnvironmentMigrationAuthorityCutover(
      db,
      noopNotifier,
      "migration-cutover",
      restoredWorkspace,
    );

    expect(cutover?.checkpoint).toBe("authority_cutover");
    expect(getEnvironment(db, environment.id)).toMatchObject({
      hostId: targetHost.id,
      managed: true,
      path: "/target/restored-project",
      workspaceProvisionType: "managed-worktree",
    });
    expect(
      recordEnvironmentMigrationAuthorityCutover(
        db,
        noopNotifier,
        "migration-cutover",
        restoredWorkspace,
      ),
    ).toBeNull();
  });
});
