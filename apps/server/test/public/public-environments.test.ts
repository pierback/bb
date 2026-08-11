import { describe, expect, it } from "vitest";
import { getEnvironment } from "@bb/db";
import type { EnvironmentSourceFreshness } from "@bb/domain";
import type { EnvironmentMigrationManifest } from "@bb/host-daemon-contract";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function sourceFreshness(
  overrides: Partial<EnvironmentSourceFreshness> = {},
): EnvironmentSourceFreshness {
  return {
    sourceBranch: "main",
    currentBranch: "bb/source-freshness",
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    state: "behind",
    aheadCount: 0,
    behindCount: 1,
    hasUncommittedChanges: false,
    gitOperation: { kind: "none" },
    ...overrides,
  };
}

describe("public environments", () => {
  it("cuts over environment authority only after the target restores the snapshot", async () => {
    await withTestHarness(async (harness) => {
      const source = seedHostSession(harness.deps, {
        id: "host-environment-migration-source",
      });
      const target = seedHostSession(harness.deps, {
        id: "host-environment-migration-target",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: source.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: source.host.id,
        projectId: project.id,
        branchName: "feature/source",
        defaultBranch: "main",
        path: "/source/workspace",
        workspaceProvisionType: "managed-worktree",
      });

      const moveResponsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/migrations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetHostId: target.host.id }),
        },
      );
      const fence = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === source.host.id &&
          command.type === "environment.migration.source_fence",
      );
      await reportQueuedCommandSuccess(harness, fence, {});
      const moveResponse = await moveResponsePromise;
      expect(moveResponse.status).toBe(202);
      const accepted = await readJson(moveResponse);
      expect(accepted).toMatchObject({
        environmentId: environment.id,
        sourceHostId: source.host.id,
        targetHostId: target.host.id,
      });
      if (
        typeof accepted !== "object" ||
        accepted === null ||
        !("migrationId" in accepted) ||
        typeof accepted.migrationId !== "string"
      ) {
        throw new Error("Migration response did not include a migrationId");
      }
      const migrationId = accepted.migrationId;

      const prepare = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === source.host.id &&
          command.type === "environment.migration.source_prepare",
      );
      expect(prepare.command).toMatchObject({
        environmentId: environment.id,
        migrationId,
        workspaceContext: {
          workspacePath: "/source/workspace",
          workspaceProvisionType: "managed-worktree",
        },
      });
      const artifactId = "a".repeat(64);
      const manifest: EnvironmentMigrationManifest = {
        artifacts: [
          {
            id: artifactId,
            kind: "git-bundle",
            relativePath: "workspace.bundle",
            sizeBytes: 4,
            sha256: "b".repeat(64),
            mode: 0o644,
          },
        ],
        gitCheckout: {
          kind: "branch",
          branchName: "feature/source",
          headSha: "a".repeat(40),
        },
        totalBytes: 4,
        workspaceName: "workspace",
        workspaceProvisionType: "managed-worktree",
        isGitRepo: true,
      };
      await reportQueuedCommandSuccess(harness, prepare, manifest);

      const targetBegin = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === target.host.id &&
          command.type === "environment.migration.target_begin",
      );
      expect(targetBegin.command).toMatchObject({ manifest });
      await reportQueuedCommandSuccess(harness, targetBegin, {});

      const sourceRead = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.migration.source_read",
      );
      await reportQueuedCommandSuccess(harness, sourceRead, {
        contentBase64: Buffer.from("data").toString("base64"),
        nextOffset: 4,
        eof: true,
      });
      const targetWrite = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.migration.target_write",
      );
      await reportQueuedCommandSuccess(harness, targetWrite, { nextOffset: 4 });

      const targetCommit = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.migration.target_commit",
      );
      expect(getEnvironment(harness.db, environment.id)?.hostId).toBe(
        source.host.id,
      );
      await reportQueuedCommandSuccess(harness, targetCommit, {
        path: "/target/migrated-workspace/workspace",
        isGitRepo: true,
        isWorktree: true,
        branchName: "feature/source",
        defaultBranch: "main",
      });

      const [sourceComplete, targetComplete] = await Promise.all([
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.migration.source_complete",
        ),
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.migration.target_complete",
        ),
      ]);
      await Promise.all([
        reportQueuedCommandSuccess(harness, sourceComplete, {}),
        reportQueuedCommandSuccess(harness, targetComplete, {}),
      ]);

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        hostId: target.host.id,
        path: "/target/migrated-workspace/workspace",
        managed: false,
        workspaceProvisionType: "managed-worktree",
      });
      const statusResponse = await harness.app.request(
        `/api/v1/environment-migrations/${migrationId}`,
      );
      expect(statusResponse.status).toBe(200);
      await expect(readJson(statusResponse)).resolves.toMatchObject({
        migrationId,
        stage: "completed",
        bytesTransferred: 4,
        totalBytes: 4,
      });
    });
  });

  it("keeps source authority and rolls the target back on restore failure", async () => {
    await withTestHarness(async (harness) => {
      const source = seedHostSession(harness.deps, {
        id: "host-environment-rollback-source",
      });
      const target = seedHostSession(harness.deps, {
        id: "host-environment-rollback-target",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: source.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: source.host.id,
        projectId: project.id,
        path: "/source/rollback-workspace",
        workspaceProvisionType: "unmanaged",
      });

      const moveResponsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/migrations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetHostId: target.host.id }),
        },
      );
      const fence = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.migration.source_fence" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, fence, {});
      const moveResponse = await moveResponsePromise;
      const accepted = await readJson(moveResponse);
      if (
        typeof accepted !== "object" ||
        accepted === null ||
        !("migrationId" in accepted) ||
        typeof accepted.migrationId !== "string"
      ) {
        throw new Error("Migration response did not include a migrationId");
      }

      const prepare = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.migration.source_prepare" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, prepare, {
        artifacts: [],
        gitCheckout: null,
        totalBytes: 0,
        workspaceName: "rollback-workspace",
        workspaceProvisionType: "unmanaged",
        isGitRepo: false,
      });
      const targetBegin = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.migration.target_begin",
      );
      await reportQueuedCommandSuccess(harness, targetBegin, {});
      const targetCommit = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "environment.migration.target_commit",
      );
      await reportQueuedCommandError(harness, targetCommit, {
        errorCode: "migration_checksum_mismatch",
        errorMessage: "restore failed",
      });

      const [targetAbort, sourceAbort] = await Promise.all([
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.migration.target_abort",
        ),
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "environment.migration.source_abort",
        ),
      ]);
      await Promise.all([
        reportQueuedCommandSuccess(harness, targetAbort, {}),
        reportQueuedCommandSuccess(harness, sourceAbort, {}),
      ]);

      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        hostId: source.host.id,
        path: "/source/rollback-workspace",
      });
      const statusResponse = await harness.app.request(
        `/api/v1/environment-migrations/${accepted.migrationId}`,
      );
      await expect(readJson(statusResponse)).resolves.toMatchObject({
        stage: "failed",
        error: "restore failed",
      });
    });
  });

  it("records the daemon-observed current branch after workspace status", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-current-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        branchName: "bb/stale",
        defaultBranch: "main",
        path: "/tmp/current-branch-env",
        workspaceProvisionType: "managed-worktree",
      });

      const statusPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/status`,
      );
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        outcome: "available",
        workspaceStatus: {
          workingTree: {
            insertions: 0,
            deletions: 0,
            files: [],
            hasUncommittedChanges: false,
            state: "clean",
          },
          branch: {
            currentBranch: "feature/current",
            defaultBranch: "trunk",
          },
          checkout: {
            kind: "branch",
            branchName: "feature/current",
            headSha: null,
          },
          mergeBase: null,
        },
      });

      const response = await statusPromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "available",
        workspace: {
          branch: {
            currentBranch: "feature/current",
            defaultBranch: "trunk",
          },
        },
      });
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        branchName: "feature/current",
        defaultBranch: "trunk",
      });
    });
  });

  it("automatically fast-forwards a clean idle environment that is behind", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-source-auto-update",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        baseBranch: "main",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/source-freshness`,
      );
      const read = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.source_freshness" &&
          command.environmentId === environment.id,
      );
      expect(read.command).toMatchObject({ sourceBranch: "main" });
      const before = sourceFreshness();
      await reportQueuedCommandSuccess(harness, read, {
        outcome: "available",
        sourceFreshness: before,
        environmentQuiescent: true,
      });
      const update = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.source_update" &&
          command.environmentId === environment.id,
      );
      expect(update.command).toMatchObject({
        sourceBranch: "main",
        mode: "automatic",
      });
      const after = sourceFreshness({
        headSha: before.sourceSha,
        state: "up_to_date",
        behindCount: 0,
      });
      await reportQueuedCommandSuccess(harness, update, {
        updated: true,
        strategy: "fast_forward",
        before,
        after,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        outcome: "available",
        sourceFreshness: { state: "up_to_date", behindCount: 0 },
        autoUpdated: true,
        updateAction: { kind: "none" },
      });
    });
  });

  it("exposes dirty freshness without automatically changing the workspace", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-source-dirty",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        baseBranch: "main",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/source-freshness`,
      );
      const read = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.source_freshness",
      );
      await reportQueuedCommandSuccess(harness, read, {
        outcome: "available",
        sourceFreshness: sourceFreshness({ hasUncommittedChanges: true }),
        environmentQuiescent: true,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        sourceFreshness: { state: "behind" },
        autoUpdated: false,
        updateAction: {
          kind: "manual",
          enabled: false,
          blockers: ["uncommitted_changes"],
        },
      });
    });
  });

  it("manually rebases a clean idle diverged environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-source-manual",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        managed: true,
        workspaceProvisionType: "managed-worktree",
        baseBranch: "main",
      });

      const responsePromise = harness.app.request(
        `/api/v1/environments/${environment.id}/source-update`,
        { method: "POST" },
      );
      const read = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.source_freshness",
      );
      const before = sourceFreshness({
        state: "diverged",
        aheadCount: 1,
      });
      await reportQueuedCommandSuccess(harness, read, {
        outcome: "available",
        sourceFreshness: before,
        environmentQuiescent: true,
      });
      const update = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "workspace.source_update",
      );
      expect(update.command).toMatchObject({ mode: "manual" });
      const after = sourceFreshness({
        state: "ahead",
        aheadCount: 1,
        behindCount: 0,
      });
      await reportQueuedCommandSuccess(harness, update, {
        updated: true,
        strategy: "rebase",
        before,
        after,
      });

      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        updated: true,
        strategy: "rebase",
        sourceFreshness: { state: "ahead", behindCount: 0 },
      });
    });
  });

  it("clears the stored branch after detached workspace status", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-detached-branch",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        branchName: "bb/stale",
        defaultBranch: "main",
        path: "/tmp/detached-branch-env",
        workspaceProvisionType: "managed-worktree",
      });

      const statusPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/status`,
      );
      const statusCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.status" &&
          command.environmentId === environment.id,
      );
      await reportQueuedCommandSuccess(harness, statusCommand, {
        outcome: "available",
        workspaceStatus: {
          workingTree: {
            insertions: 0,
            deletions: 0,
            files: [],
            hasUncommittedChanges: false,
            state: "clean",
          },
          branch: {
            currentBranch: null,
            defaultBranch: "main",
          },
          checkout: {
            kind: "detached",
            headSha: "0123456789abcdef0123456789abcdef01234567",
          },
          mergeBase: null,
        },
      });

      const response = await statusPromise;
      expect(response.status).toBe(200);
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        branchName: null,
        defaultBranch: "main",
      });
    });
  });

  it("renames an environment through the public update route", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-rename",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        workspaceProvisionType: "managed-worktree",
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "  Review workspace  " }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        id: environment.id,
        name: "Review workspace",
      });
    });
  });

  it("rejects empty environment updates", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/environments/env_missing",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  it("lists workspace paths via host.list_paths for a personal-workspace environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-paths",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      // A "personal" workspace is exactly what a projectless thread runs in.
      // The environment-scoped route remains the direct surface used by
      // existing-thread file search for a personal workspace.
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/personal-workspace",
        workspaceProvisionType: "personal",
      });

      const pathsPromise = harness.app.request(
        `/api/v1/environments/${environment.id}/paths?query=app&includeFiles=true&includeDirectories=false`,
      );
      const pathsCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_paths" &&
          command.path === "/tmp/personal-workspace",
      );
      expect(pathsCommand.command).toMatchObject({
        path: "/tmp/personal-workspace",
        query: "app",
        includeFiles: true,
        includeDirectories: false,
      });
      await reportQueuedCommandSuccess(harness, pathsCommand, {
        paths: [
          {
            kind: "file",
            path: "src/app.ts",
            name: "app.ts",
            score: 80,
            positions: [0, 1, 2],
          },
        ],
        truncated: false,
      });

      const pathsResponse = await pathsPromise;
      expect(pathsResponse.status).toBe(200);
      await expect(readJson(pathsResponse)).resolves.toEqual({
        paths: [
          {
            kind: "file",
            path: "src/app.ts",
            name: "app.ts",
            score: 80,
            positions: [0, 1, 2],
          },
        ],
        truncated: false,
      });
    });
  });

  it("returns not-ready for workspace path search on an unprovisioned environment", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-environment-paths-pending",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        status: "provisioning",
      });

      const response = await harness.app.request(
        `/api/v1/environments/${environment.id}/paths?query=app&includeFiles=true&includeDirectories=false`,
      );

      expect(response.status).toBe(409);
    });
  });
});
