import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "@bb/host-workspace";
import {
  abortEnvironmentMigrationSource,
  abortEnvironmentMigrationTarget,
  beginEnvironmentMigrationTarget,
  commitEnvironmentMigrationTarget,
  prepareEnvironmentMigrationSource,
  readEnvironmentMigrationSource,
  writeEnvironmentMigrationTarget,
} from "../../src/command-handlers/environment-migration.js";
import {
  noopEventSink,
  type CommandDispatchOptions,
} from "../../src/command-dispatch-support.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
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
      "ignored-cache/\n",
    );
    await fs.writeFile(path.join(sourceWorkspace, "tracked.txt"), "before\n");
    await fs.writeFile(path.join(sourceWorkspace, "deleted.txt"), "delete\n");
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
    await fs.mkdir(path.dirname(sourceSessionPath), { recursive: true });
    await fs.writeFile(sourceSessionPath, '{"type":"session_meta"}\n');

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
      manifest.artifacts.some((entry) => entry.kind === "provider-session"),
    ).toBe(true);

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
    await expect(
      fs.access(path.join(restored.path, "deleted.txt")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(restored.path, "ignored-cache", "cache.bin")),
    ).rejects.toThrow();
    expect(
      await fs.readFile(
        path.join(targetCodexHome, sessionRelativePath),
        "utf8",
      ),
    ).toBe('{"type":"session_meta"}\n');
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
});
