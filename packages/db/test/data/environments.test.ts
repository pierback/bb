import { describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  createEnvironment,
  hasNonDestroyedChildEnvironments,
  listRetiredLoadedEnvironmentIdsOnHost,
  recordEnvironmentCurrentBranch,
  recordEnvironmentMigrationCutover,
  recordProvisionedEnvironmentWorkspace,
  updateEnvironmentMetadata,
} from "../../src/data/environments.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

function createNotifierSpy(): DbNotifier {
  return {
    notifyThread: vi.fn(),
    notifyProject: vi.fn(),
    notifyEnvironment: vi.fn(),
    notifyHost: vi.fn(),
    notifySystem: vi.fn(),
  };
}

describe("environments", () => {
  it("persists nested managed-worktree provenance and indexes live children", () => {
    const { db, host, project } = setup();
    const parentEnvironment = createEnvironment(db, noopNotifier, {
      hostId: host.id,
      isWorktree: true,
      managed: true,
      projectId: project.id,
      status: "ready",
      workspaceProvisionType: "managed-worktree",
    });
    const parentBaseCommit =
      "0123456789abcdef0123456789abcdef01234567";

    const childEnvironment = createEnvironment(db, noopNotifier, {
      hostId: host.id,
      isWorktree: true,
      managed: true,
      parentBaseCommit,
      parentEnvironmentId: parentEnvironment.id,
      parentHadUncommittedChanges: true,
      projectId: project.id,
      status: "ready",
      workspaceProvisionType: "managed-worktree",
    });

    expect(childEnvironment).toMatchObject({
      parentBaseCommit,
      parentEnvironmentId: parentEnvironment.id,
      parentHadUncommittedChanges: true,
    });
    expect(
      hasNonDestroyedChildEnvironments(db, parentEnvironment.id),
    ).toBe(true);
    expect(() =>
      createEnvironment(db, noopNotifier, {
        hostId: host.id,
        parentBaseCommit,
        projectId: project.id,
        workspaceProvisionType: "unmanaged",
      }),
    ).toThrow();
  });

  it("emits metadata-changed when merge base branch changes", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      mergeBaseBranch: "release",
    });

    expect(updated?.mergeBaseBranch).toBe("release");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("emits metadata-changed when environment name changes", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      name: "Review workspace",
    });

    expect(updated?.name).toBe("Review workspace");
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("does not emit metadata-changed when merge base branch is unchanged", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      mergeBaseBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      mergeBaseBranch: "main",
    });

    expect(updated?.mergeBaseBranch).toBe("main");
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("does not emit metadata-changed when environment name is unchanged", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      name: "Review workspace",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = updateEnvironmentMetadata(db, notifier, environment.id, {
      name: "Review workspace",
    });

    expect(updated?.name).toBe("Review workspace");
    expect(notifier.notifyEnvironment).not.toHaveBeenCalled();
  });

  it("records provisioned workspace metadata without touching status", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      status: "provisioning",
    });
    const notifier = createNotifierSpy();

    const updated = recordProvisionedEnvironmentWorkspace(
      db,
      notifier,
      environment.id,
      {
        path: "/tmp/project",
        isGitRepo: true,
        isWorktree: false,
        branchName: "bb/test",
        defaultBranch: "main",
      },
    );

    expect(updated).toMatchObject({
      path: "/tmp/project",
      status: "provisioning",
      isGitRepo: true,
      branchName: "bb/test",
      defaultBranch: "main",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("cuts environment authority over exactly once after target restore", () => {
    const { db, host, project } = setup();
    const targetHost = upsertHost(db, noopNotifier, {
      name: "target-host",
      type: "persistent",
    });
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      managed: true,
      workspaceProvisionType: "managed-worktree",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = recordEnvironmentMigrationCutover(
      db,
      notifier,
      environment.id,
      {
        sourceHostId: host.id,
        targetHostId: targetHost.id,
        path: "/target/migrated-workspace",
        isGitRepo: true,
        isWorktree: false,
        branchName: "feature/moved",
        defaultBranch: "main",
      },
    );

    expect(updated).toMatchObject({
      hostId: targetHost.id,
      path: "/target/migrated-workspace",
      managed: true,
      workspaceProvisionType: "managed-worktree",
      branchName: "feature/moved",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledTimes(1);

    const staleCutover = recordEnvironmentMigrationCutover(
      db,
      notifier,
      environment.id,
      {
        sourceHostId: host.id,
        targetHostId: "host-third",
        path: "/wrong/path",
        isGitRepo: false,
        isWorktree: false,
        branchName: null,
        defaultBranch: null,
      },
    );
    expect(staleCutover).toBeNull();
    expect(notifier.notifyEnvironment).toHaveBeenCalledTimes(1);
  });

  it("records the current branch observed for an environment", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      branchName: "bb/old",
      defaultBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = recordEnvironmentCurrentBranch(
      db,
      notifier,
      environment.id,
      {
        branchName: "feature/current",
        defaultBranch: "trunk",
      },
    );

    expect(updated).toMatchObject({
      branchName: "feature/current",
      defaultBranch: "trunk",
      baseBranch: null,
      mergeBaseBranch: null,
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("clears the current branch when a detached checkout is observed", () => {
    const { db, host, project } = setup();
    const environment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "managed-worktree",
      branchName: "bb/old",
      defaultBranch: "main",
      status: "ready",
    });
    const notifier = createNotifierSpy();

    const updated = recordEnvironmentCurrentBranch(
      db,
      notifier,
      environment.id,
      {
        branchName: null,
      },
    );

    expect(updated).toMatchObject({
      branchName: null,
      defaultBranch: "main",
    });
    expect(notifier.notifyEnvironment).toHaveBeenCalledWith(environment.id, [
      "metadata-changed",
    ]);
  });

  it("lists loaded environments that no longer belong to the host as live records", () => {
    const { db, host, project } = setup();
    const otherHost = upsertHost(db, noopNotifier, {
      name: "other-host",
      type: "persistent",
    });
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: {
        type: "local_path",
        hostId: otherHost.id,
        path: "/tmp/other",
      },
    });
    const retainedEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });
    const destroyedEnvironment = createEnvironment(db, noopNotifier, {
      projectId: project.id,
      hostId: host.id,
      workspaceProvisionType: "unmanaged",
      status: "destroyed",
    });
    const otherHostEnvironment = createEnvironment(db, noopNotifier, {
      projectId: otherProject.id,
      hostId: otherHost.id,
      workspaceProvisionType: "unmanaged",
      status: "ready",
    });

    expect(
      listRetiredLoadedEnvironmentIdsOnHost(db, {
        hostId: host.id,
        environmentIds: [
          retainedEnvironment.id,
          destroyedEnvironment.id,
          otherHostEnvironment.id,
          "env_missing",
        ],
      }),
    ).toEqual([
      destroyedEnvironment.id,
      otherHostEnvironment.id,
      "env_missing",
    ]);
  });
});
