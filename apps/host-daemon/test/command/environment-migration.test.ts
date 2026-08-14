import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPersonalWorkspaceRoot, runGit } from "@bb/host-workspace";
import {
  abortEnvironmentMigrationSource,
  abortEnvironmentMigrationTarget,
  beginEnvironmentMigrationTarget,
  commitEnvironmentMigrationTarget,
  prepareEnvironmentMigrationSource,
  readEnvironmentMigrationSource,
  writeEnvironmentMigrationTarget,
} from "../../src/command-handlers/environment-migration.js";
import { quarantineLegacyEnvironmentMigrationStages } from "../../src/environment-migration-storage.js";
import {
  noopEventSink,
  type CommandDispatchOptions,
} from "../../src/command-dispatch-support.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import { MIGRATED_MANAGED_COMMON_GIT_DIRECTORY } from "../../src/workspace-provision-target.js";
import {
  createFakeRuntime,
  createSessionFabricTestDependencies,
  unexpectedProjectAttachmentFetch,
} from "./dispatch-helpers.js";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-environment-migration-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function createDispatchOptions(args: {
  codexHome: string;
  dataDir: string;
}): CommandDispatchOptions {
  const { runtime } = createFakeRuntime();
  return {
    ...createSessionFabricTestDependencies(),
    dataDir: args.dataDir,
    eventSink: noopEventSink,
    fetchProjectAttachment: unexpectedProjectAttachmentFetch,
    runtimeManager: new RuntimeManager({
      createRuntime: () => runtime,
      shellEnv: { CODEX_HOME: args.codexHome },
    }),
    threadStorageRootPath: path.join(args.dataDir, "thread-storage"),
  };
}

async function transferMigrationArtifacts(args: {
  commandTarget: { environmentId: string; migrationId: string };
  manifest: Awaited<ReturnType<typeof prepareEnvironmentMigrationSource>>;
  sourceOptions: CommandDispatchOptions;
  targetOptions: CommandDispatchOptions;
}): Promise<void> {
  await beginEnvironmentMigrationTarget(
    {
      type: "environment.migration.target_begin",
      ...args.commandTarget,
      manifest: args.manifest,
    },
    args.targetOptions,
  );
  for (const artifact of args.manifest.artifacts) {
    let offset = 0;
    while (offset < artifact.sizeBytes) {
      const chunk = await readEnvironmentMigrationSource(
        {
          type: "environment.migration.source_read",
          ...args.commandTarget,
          artifactId: artifact.id,
          offset,
          maxBytes: 1_024,
        },
        args.sourceOptions,
      );
      const written = await writeEnvironmentMigrationTarget(
        {
          type: "environment.migration.target_write",
          ...args.commandTarget,
          artifactId: artifact.id,
          offset,
          contentBase64: chunk.contentBase64,
        },
        args.targetOptions,
      );
      expect(written.nextOffset).toBe(chunk.nextOffset);
      offset = written.nextOffset;
    }
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("environment migration handlers", () => {
  it("quarantines obsolete migration stages and starts v2 stages separately", async () => {
    const root = await createTempDirectory();
    const dataDir = path.join(root, "data");
    const legacyStagePath = path.join(
      dataDir,
      "environment-migrations",
      "target",
      "legacy-stage",
    );
    await fs.mkdir(legacyStagePath, { recursive: true });
    await fs.writeFile(
      path.join(legacyStagePath, "manifest.json"),
      JSON.stringify({ legacy: true }),
    );

    const quarantinePath =
      await quarantineLegacyEnvironmentMigrationStages(dataDir);

    expect(path.basename(quarantinePath ?? "")).toMatch(
      /^environment-migrations-obsolete-v1-/u,
    );
    await expect(
      fs.readFile(
        path.join(
          quarantinePath ?? "",
          "target",
          "legacy-stage",
          "manifest.json",
        ),
        "utf8",
      ),
    ).resolves.toBe('{"legacy":true}');
    await expect(
      fs.access(path.join(dataDir, "environment-migrations")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      quarantineLegacyEnvironmentMigrationStages(dataDir),
    ).resolves.toBeNull();
  });

  it("restores a managed environment as a real worktree with its branch and lifecycle root", async () => {
    const root = await createTempDirectory();
    const sourceRepository = path.join(root, "source-repository");
    const sourceWorkspace = path.join(root, "source-worktree");
    await fs.mkdir(sourceRepository, { recursive: true });
    await runGit(["init", "-b", "main"], { cwd: sourceRepository });
    await runGit(["config", "user.email", "migration-test@example.com"], {
      cwd: sourceRepository,
    });
    await runGit(["config", "user.name", "Migration Test"], {
      cwd: sourceRepository,
    });
    await fs.writeFile(path.join(sourceRepository, "tracked.txt"), "base\n");
    await runGit(["add", "tracked.txt"], { cwd: sourceRepository });
    await runGit(["commit", "-m", "initial"], { cwd: sourceRepository });
    await runGit(
      ["worktree", "add", "-b", "feature/migrated", sourceWorkspace, "main"],
      { cwd: sourceRepository },
    );
    await fs.writeFile(path.join(sourceWorkspace, "tracked.txt"), "dirty\n");
    await fs.writeFile(
      path.join(sourceWorkspace, "untracked.txt"),
      "portable\n",
    );
    await runGit(
      [
        "remote",
        "add",
        "origin",
        "https://migration-user:migration-secret@example.com/acme/repo.git?token=secret#fragment",
      ],
      { cwd: sourceWorkspace },
    );
    await runGit(["config", "branch.feature/migrated.remote", "origin"], {
      cwd: sourceWorkspace,
    });
    await runGit(
      ["config", "branch.feature/migrated.merge", "refs/heads/main"],
      { cwd: sourceWorkspace },
    );

    const sourceOptions = createDispatchOptions({
      codexHome: path.join(root, "source-codex"),
      dataDir: path.join(root, "source-data"),
    });
    const targetOptions = createDispatchOptions({
      codexHome: path.join(root, "target-codex"),
      dataDir: path.join(root, "target-data"),
    });
    const commandTarget = {
      environmentId: "env-managed-migration",
      migrationId: "managed-migration",
    };
    const manifest = await prepareEnvironmentMigrationSource(
      {
        type: "environment.migration.source_prepare",
        ...commandTarget,
        providerSessions: [],
        workspaceContext: {
          workspacePath: sourceWorkspace,
          workspaceProvisionType: "managed-worktree",
        },
      },
      sourceOptions,
    );
    const sourceHead = (
      await runGit(["rev-parse", "HEAD"], { cwd: sourceWorkspace })
    ).stdout.trim();
    expect(manifest.gitCheckout).toEqual({
      kind: "branch",
      branchName: "feature/migrated",
      headSha: sourceHead,
    });
    expect(manifest.gitRemotes).toEqual([
      {
        name: "origin",
        fetchUrls: ["https://example.com/acme/repo.git"],
        pushUrls: ["https://example.com/acme/repo.git"],
      },
    ]);
    expect(manifest.gitBranchTracking).toEqual({
      remoteName: "origin",
      mergeRef: "refs/heads/main",
    });

    await transferMigrationArtifacts({
      commandTarget,
      manifest,
      sourceOptions,
      targetOptions,
    });
    const restored = await commitEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_commit",
        ...commandTarget,
      },
      targetOptions,
    );

    expect(restored).toMatchObject({
      isGitRepo: true,
      isWorktree: true,
      branchName: "feature/migrated",
    });
    expect(path.basename(restored.path)).toBe("workspace");
    expect(
      await fs.readFile(path.join(restored.path, "tracked.txt"), "utf8"),
    ).toBe("dirty\n");
    expect(
      await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8"),
    ).toBe("portable\n");
    const restoredCommonGitDir = await fs.realpath(
      path.resolve(
        restored.path,
        (
          await runGit(["rev-parse", "--git-common-dir"], {
            cwd: restored.path,
          })
        ).stdout.trim(),
      ),
    );
    expect(path.basename(restoredCommonGitDir)).toBe(
      MIGRATED_MANAGED_COMMON_GIT_DIRECTORY,
    );
    const [sourceStatus, restoredStatus] = await Promise.all([
      runGit(["status", "--porcelain"], { cwd: sourceWorkspace }),
      runGit(["status", "--porcelain"], { cwd: restored.path }),
    ]);
    expect(restoredStatus.stdout).toBe(sourceStatus.stdout);
    await expect(
      runGit(["remote", "get-url", "origin"], { cwd: restored.path }),
    ).resolves.toMatchObject({ stdout: "https://example.com/acme/repo.git\n" });
    await expect(
      runGit(["config", "--get", "branch.feature/migrated.remote"], {
        cwd: restored.path,
      }),
    ).resolves.toMatchObject({ stdout: "origin\n" });
    await expect(
      runGit(["config", "--get", "branch.feature/migrated.merge"], {
        cwd: restored.path,
      }),
    ).resolves.toMatchObject({ stdout: "refs/heads/main\n" });

    const migrationRoot = path.dirname(restored.path);
    await abortEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_abort",
        ...commandTarget,
      },
      targetOptions,
    );
    await expect(fs.access(migrationRoot)).rejects.toThrow();
  });

  it("restores a dirty git workspace and Codex rollout, then rolls both back", async () => {
    const root = await createTempDirectory();
    const sourceWorkspace = path.join(root, "source-workspace");
    const sourceCodexHome = path.join(root, "source-codex");
    const targetCodexHome = path.join(root, "target-codex");
    const providerThreadId = "019fde03-efb1-7c13-b195-9de038cf9aad";
    const sessionRelativePath = path.join(
      "sessions",
      "2026",
      "08",
      "08",
      `rollout-2026-08-08T00-00-00-${providerThreadId}.jsonl`,
    );
    const sourceSessionPath = path.join(sourceCodexHome, sessionRelativePath);
    const sessionContent = `${JSON.stringify({
      timestamp: "2026-08-08T00:00:00.000Z",
      type: "session_meta",
      payload: { id: providerThreadId },
    })}\n`;
    await fs.mkdir(sourceWorkspace, { recursive: true });
    await runGit(["init", "-b", "main"], { cwd: sourceWorkspace });
    await runGit(["config", "user.email", "migration-test@example.com"], {
      cwd: sourceWorkspace,
    });
    await runGit(["config", "user.name", "Migration Test"], {
      cwd: sourceWorkspace,
    });
    await fs.writeFile(
      path.join(sourceWorkspace, ".gitignore"),
      "ignored-cache/\n.env\n",
    );
    await fs.writeFile(path.join(sourceWorkspace, "tracked.txt"), "before\n");
    await fs.writeFile(path.join(sourceWorkspace, "deleted.txt"), "delete\n");
    await fs.symlink("tracked.txt", path.join(sourceWorkspace, "tracked-link"));
    await runGit(["add", "."], { cwd: sourceWorkspace });
    await runGit(["commit", "-m", "initial"], { cwd: sourceWorkspace });
    await fs.writeFile(path.join(sourceWorkspace, "tracked.txt"), "after\n");
    await fs.rm(path.join(sourceWorkspace, "deleted.txt"));
    await fs.writeFile(path.join(sourceWorkspace, "untracked.txt"), "new\n");
    await fs.mkdir(path.join(sourceWorkspace, "ignored-cache"));
    await fs.writeFile(
      path.join(sourceWorkspace, "ignored-cache", "cache.bin"),
      "cache\n",
    );
    await fs.writeFile(path.join(sourceWorkspace, ".env"), "TOKEN=secret\n");
    await fs.mkdir(path.join(sourceWorkspace, ".bb"));
    await fs.writeFile(
      path.join(sourceWorkspace, ".bb", "environment-transfer.json"),
      JSON.stringify({
        version: 1,
        includeIgnoredFiles: ["ignored-cache/cache.bin"],
      }),
    );
    await fs.mkdir(path.dirname(sourceSessionPath), { recursive: true });
    await fs.writeFile(sourceSessionPath, sessionContent);

    const sourceOptions = createDispatchOptions({
      codexHome: sourceCodexHome,
      dataDir: path.join(root, "source-data"),
    });
    const targetOptions = createDispatchOptions({
      codexHome: targetCodexHome,
      dataDir: path.join(root, "target-data"),
    });
    const commandTarget = {
      environmentId: "env-migration-test",
      migrationId: "migration-test",
    };
    const manifest = await prepareEnvironmentMigrationSource(
      {
        type: "environment.migration.source_prepare",
        ...commandTarget,
        providerSessions: [{ providerId: "codex", providerThreadId }],
        workspaceContext: {
          workspacePath: sourceWorkspace,
          workspaceProvisionType: "unmanaged",
        },
      },
      sourceOptions,
    );
    expect(
      manifest.artifacts.some((entry) => entry.kind === "git-bundle"),
    ).toBe(true);
    expect(
      manifest.artifacts.find((entry) => entry.kind === "provider-session"),
    ).toMatchObject({
      relativePath: `codex/${sessionRelativePath.split(path.sep).join("/")}`,
    });

    await beginEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_begin",
        ...commandTarget,
        manifest,
      },
      targetOptions,
    );
    for (const artifact of manifest.artifacts) {
      let offset = 0;
      while (offset < artifact.sizeBytes) {
        const chunk = await readEnvironmentMigrationSource(
          {
            type: "environment.migration.source_read",
            ...commandTarget,
            artifactId: artifact.id,
            offset,
            maxBytes: 7,
          },
          sourceOptions,
        );
        const written = await writeEnvironmentMigrationTarget(
          {
            type: "environment.migration.target_write",
            ...commandTarget,
            artifactId: artifact.id,
            offset,
            contentBase64: chunk.contentBase64,
          },
          targetOptions,
        );
        expect(written.nextOffset).toBe(chunk.nextOffset);
        offset = written.nextOffset;
      }
    }

    const restored = await commitEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_commit",
        ...commandTarget,
      },
      targetOptions,
    );
    expect(
      await fs.readFile(path.join(restored.path, "tracked.txt"), "utf8"),
    ).toBe("after\n");
    expect(
      await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8"),
    ).toBe("new\n");
    expect(await fs.readlink(path.join(restored.path, "tracked-link"))).toBe(
      "tracked.txt",
    );
    await expect(
      fs.access(path.join(restored.path, "deleted.txt")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(restored.path, "ignored-cache", "cache.bin"),
        "utf8",
      ),
    ).toBe("cache\n");
    await expect(fs.access(path.join(restored.path, ".env"))).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(targetCodexHome, sessionRelativePath),
        "utf8",
      ),
    ).toBe(sessionContent);
    const [sourceStatus, restoredStatus] = await Promise.all([
      runGit(["status", "--porcelain"], { cwd: sourceWorkspace }),
      runGit(["status", "--porcelain"], { cwd: restored.path }),
    ]);
    expect(restoredStatus.stdout).toBe(sourceStatus.stdout);

    await abortEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_abort",
        ...commandTarget,
      },
      targetOptions,
    );
    await expect(fs.access(restored.path)).rejects.toThrow();
    await expect(
      fs.access(path.join(targetCodexHome, sessionRelativePath)),
    ).rejects.toThrow();
    await abortEnvironmentMigrationSource(
      {
        type: "environment.migration.source_abort",
        ...commandTarget,
      },
      sourceOptions,
    );
  });

  it("creates a fresh target host's personal workspace parent before cutover", async () => {
    const root = await createTempDirectory();
    const environmentId = "env-personal-migration";
    const sourceDataDir = path.join(root, "source-data");
    const targetDataDir = path.join(root, "target-data");
    const sourceWorkspace = path.join(
      getPersonalWorkspaceRoot(sourceDataDir),
      environmentId,
    );
    await fs.mkdir(sourceWorkspace, { recursive: true });
    await fs.writeFile(path.join(sourceWorkspace, "notes.md"), "portable\n");

    const sourceOptions = createDispatchOptions({
      codexHome: path.join(root, "source-codex"),
      dataDir: sourceDataDir,
    });
    const targetOptions = createDispatchOptions({
      codexHome: path.join(root, "target-codex"),
      dataDir: targetDataDir,
    });
    const commandTarget = {
      environmentId,
      migrationId: "personal-migration",
    };
    const manifest = await prepareEnvironmentMigrationSource(
      {
        type: "environment.migration.source_prepare",
        ...commandTarget,
        providerSessions: [],
        workspaceContext: {
          workspacePath: sourceWorkspace,
          workspaceProvisionType: "personal",
        },
      },
      sourceOptions,
    );
    await transferMigrationArtifacts({
      commandTarget,
      manifest,
      sourceOptions,
      targetOptions,
    });

    const targetPersonalRoot = getPersonalWorkspaceRoot(targetDataDir);
    await expect(fs.access(targetPersonalRoot)).rejects.toThrow();
    const restored = await commitEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_commit",
        ...commandTarget,
      },
      targetOptions,
    );

    expect(restored.path).toBe(path.join(targetPersonalRoot, environmentId));
    expect(
      await fs.readFile(path.join(restored.path, "notes.md"), "utf8"),
    ).toBe("portable\n");
  });

  it("rejects providers without a portable-session capability", async () => {
    const root = await createTempDirectory();
    const sourceWorkspace = path.join(root, "source-workspace");
    await fs.mkdir(sourceWorkspace, { recursive: true });

    await expect(
      prepareEnvironmentMigrationSource(
        {
          type: "environment.migration.source_prepare",
          environmentId: "env-unsupported-provider",
          migrationId: "migration-unsupported-provider",
          providerSessions: [
            {
              providerId: "claude-code",
              providerThreadId: "claude-session-1",
            },
          ],
          workspaceContext: {
            workspacePath: sourceWorkspace,
            workspaceProvisionType: "unmanaged",
          },
        },
        createDispatchOptions({
          codexHome: path.join(root, "source-codex"),
          dataDir: path.join(root, "source-data"),
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_provider_migration" });
  });

  it("rejects malformed transfer manifests before reading allowlisted paths", async () => {
    const root = await createTempDirectory();
    const sourceWorkspace = path.join(root, "source-workspace");
    await fs.mkdir(path.join(sourceWorkspace, ".bb"), { recursive: true });
    await runGit(["init", "-b", "main"], { cwd: sourceWorkspace });
    await fs.writeFile(
      path.join(sourceWorkspace, ".bb", "environment-transfer.json"),
      JSON.stringify({
        version: 1,
        includeIgnoredFiles: ["../outside-secret"],
      }),
    );

    await expect(
      prepareEnvironmentMigrationSource(
        {
          type: "environment.migration.source_prepare",
          environmentId: "env-invalid-transfer-manifest",
          migrationId: "migration-invalid-transfer-manifest",
          providerSessions: [],
          workspaceContext: {
            workspacePath: sourceWorkspace,
            workspaceProvisionType: "unmanaged",
          },
        },
        createDispatchOptions({
          codexHome: path.join(root, "source-codex"),
          dataDir: path.join(root, "source-data"),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_environment_transfer_manifest" });
  });

  it("rejects workspace symlinks that resolve outside the workspace", async () => {
    const root = await createTempDirectory();
    const sourceWorkspace = path.join(root, "source-workspace");
    await fs.mkdir(sourceWorkspace, { recursive: true });
    await runGit(["init", "-b", "main"], { cwd: sourceWorkspace });
    await fs.writeFile(path.join(root, "outside.txt"), "outside\n");
    await fs.symlink("../outside.txt", path.join(sourceWorkspace, "escape"));

    await expect(
      prepareEnvironmentMigrationSource(
        {
          type: "environment.migration.source_prepare",
          environmentId: "env-unsafe-symlink",
          migrationId: "migration-unsafe-symlink",
          providerSessions: [],
          workspaceContext: {
            workspacePath: sourceWorkspace,
            workspaceProvisionType: "unmanaged",
          },
        },
        createDispatchOptions({
          codexHome: path.join(root, "source-codex"),
          dataDir: path.join(root, "source-data"),
        }),
      ),
    ).rejects.toMatchObject({ code: "unsafe_migration_symlink" });
  });

  it("rejects unsafe symlink artifacts again on the target", async () => {
    const root = await createTempDirectory();
    const targetOptions = createDispatchOptions({
      codexHome: path.join(root, "target-codex"),
      dataDir: path.join(root, "target-data"),
    });
    const commandTarget = {
      environmentId: "env-malicious-symlink",
      migrationId: "migration-malicious-symlink",
    };
    const content = Buffer.from("../../outside", "utf8");
    const artifactId = "c".repeat(64);
    await beginEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_begin",
        ...commandTarget,
        manifest: {
          artifacts: [
            {
              id: artifactId,
              kind: "workspace-symlink",
              mode: 0o777,
              relativePath: "unsafe-link",
              sha256: createHash("sha256").update(content).digest("hex"),
              sizeBytes: content.byteLength,
            },
          ],
          gitBranchTracking: null,
          gitCheckout: null,
          gitRemotes: [],
          isGitRepo: false,
          totalBytes: content.byteLength,
          workspaceName: "malicious-symlink-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      targetOptions,
    );
    await writeEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_write",
        ...commandTarget,
        artifactId,
        contentBase64: content.toString("base64"),
        offset: 0,
      },
      targetOptions,
    );

    await expect(
      commitEnvironmentMigrationTarget(
        {
          type: "environment.migration.target_commit",
          ...commandTarget,
        },
        targetOptions,
      ),
    ).rejects.toMatchObject({ code: "unsafe_migration_symlink" });
  });

  it("rejects a target artifact whose transferred bytes do not match its digest", async () => {
    const root = await createTempDirectory();
    const targetOptions = createDispatchOptions({
      codexHome: path.join(root, "target-codex"),
      dataDir: path.join(root, "target-data"),
    });
    const commandTarget = {
      environmentId: "env-corrupt-test",
      migrationId: "migration-corrupt-test",
    };
    const artifactId = "a".repeat(64);
    await beginEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_begin",
        ...commandTarget,
        manifest: {
          artifacts: [
            {
              id: artifactId,
              kind: "workspace-file",
              mode: 0o644,
              relativePath: "file.txt",
              sha256:
                "770e607624d689265ca6c44884d0807d9b054d23c473c106c72be9de08b7376c",
              sizeBytes: 4,
            },
          ],
          gitBranchTracking: null,
          gitCheckout: null,
          gitRemotes: [],
          isGitRepo: false,
          totalBytes: 4,
          workspaceName: "corrupt-workspace",
          workspaceProvisionType: "unmanaged",
        },
      },
      targetOptions,
    );
    await writeEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_write",
        ...commandTarget,
        artifactId,
        contentBase64: Buffer.from("evil").toString("base64"),
        offset: 0,
      },
      targetOptions,
    );

    await expect(
      commitEnvironmentMigrationTarget(
        {
          type: "environment.migration.target_commit",
          ...commandTarget,
        },
        targetOptions,
      ),
    ).rejects.toMatchObject({ code: "migration_checksum_mismatch" });
  });

  it("replays target begin, writes, and commit without duplicating bytes", async () => {
    const root = await createTempDirectory();
    const targetOptions = createDispatchOptions({
      codexHome: path.join(root, "target-codex"),
      dataDir: path.join(root, "target-data"),
    });
    const commandTarget = {
      environmentId: "env-replay-test",
      migrationId: "migration-replay-test",
    };
    const artifactId = "b".repeat(64);
    const manifest = {
      artifacts: [
        {
          id: artifactId,
          kind: "workspace-file" as const,
          mode: 0o644,
          relativePath: "file.txt",
          sha256:
            "770e607624d689265ca6c44884d0807d9b054d23c473c106c72be9de08b7376c",
          sizeBytes: 4,
        },
      ],
      gitBranchTracking: null,
      gitCheckout: null,
      gitRemotes: [],
      isGitRepo: false,
      totalBytes: 4,
      workspaceName: "replayed-workspace",
      workspaceProvisionType: "unmanaged" as const,
    };

    await beginEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_begin",
        ...commandTarget,
        manifest,
      },
      targetOptions,
    );
    await beginEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_begin",
        ...commandTarget,
        manifest,
      },
      targetOptions,
    );
    const firstChunk = {
      type: "environment.migration.target_write" as const,
      ...commandTarget,
      artifactId,
      contentBase64: Buffer.from("go").toString("base64"),
      offset: 0,
    };
    await writeEnvironmentMigrationTarget(firstChunk, targetOptions);
    await expect(
      writeEnvironmentMigrationTarget(
        {
          ...firstChunk,
          contentBase64: Buffer.from("no").toString("base64"),
        },
        targetOptions,
      ),
    ).rejects.toMatchObject({ code: "migration_chunk_conflict" });
    expect(
      await writeEnvironmentMigrationTarget(firstChunk, targetOptions),
    ).toEqual({ nextOffset: 2 });
    await writeEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_write",
        ...commandTarget,
        artifactId,
        contentBase64: Buffer.from("od").toString("base64"),
        offset: 2,
      },
      targetOptions,
    );

    const firstCommit = await commitEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_commit",
        ...commandTarget,
      },
      targetOptions,
    );
    const replayedCommit = await commitEnvironmentMigrationTarget(
      {
        type: "environment.migration.target_commit",
        ...commandTarget,
      },
      targetOptions,
    );

    expect(replayedCommit.path).toBe(firstCommit.path);
    expect(
      await fs.readFile(path.join(replayedCommit.path, "file.txt"), "utf8"),
    ).toBe("good");
  });
});
