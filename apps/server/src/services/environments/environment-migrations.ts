import { randomUUID } from "node:crypto";
import {
  createEnvironmentMigration,
  getActiveEnvironmentMigration,
  getEnvironment,
  getEnvironmentMigration,
  getLastStoredProviderThreadId,
  isSqliteUniqueConstraintOnColumns,
  listRecoverableEnvironmentMigrations,
  listThreads,
  recordEnvironmentMigrationAuthorityCutover,
  updateEnvironmentMigration,
  type EnvironmentMigrationRecord,
} from "@bb/db";
import {
  environmentMigrationManifestSchema,
  type EnvironmentMigrationManifest,
} from "@bb/host-daemon-contract";
import type { EnvironmentMigrationStatus } from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";

const MIGRATION_RPC_TIMEOUT_MS = 30 * 60 * 1_000;
const MIGRATION_CHUNK_BYTES = 512 * 1_024;
const QUIESCENCE_RETRY_MS = 500;

interface BeginEnvironmentMigrationArgs {
  environmentId: string;
  targetHostId: string;
}

interface PortableProviderSession {
  providerId: string;
  providerThreadId: string;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.body.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function isEnvironmentBusy(error: unknown): boolean {
  return error instanceof ApiError && error.body.code === "environment_busy";
}

function toPublicStatus(
  migration: EnvironmentMigrationRecord,
): EnvironmentMigrationStatus {
  return {
    migrationId: migration.id,
    environmentId: migration.environmentId,
    sourceHostId: migration.sourceHostId,
    targetHostId: migration.targetHostId,
    stage: migration.stage,
    bytesTransferred: migration.bytesTransferred,
    totalBytes: migration.totalBytes,
    error: migration.error,
    startedAt: migration.startedAt,
    updatedAt: migration.updatedAt,
    completedAt: migration.completedAt,
  };
}

export class EnvironmentMigrationCoordinator {
  // This set only prevents duplicate workers inside one server process. All
  // workflow authority and progress lives in the database checkpoint record.
  private readonly runningMigrationIds = new Set<string>();

  constructor(private readonly deps: LoggedWorkSessionDeps) {}

  get(migrationId: string): EnvironmentMigrationStatus | null {
    const migration = getEnvironmentMigration(this.deps.db, migrationId);
    return migration ? toPublicStatus(migration) : null;
  }

  async begin(
    args: BeginEnvironmentMigrationArgs,
  ): Promise<EnvironmentMigrationStatus> {
    const active = getActiveEnvironmentMigration(
      this.deps.db,
      args.environmentId,
    );
    if (active) {
      throw new ApiError(
        409,
        "environment_migrating",
        `Environment ${args.environmentId} is already being moved by ${active.id}`,
      );
    }
    const environment = getEnvironment(this.deps.db, args.environmentId);
    if (!environment) {
      throw new ApiError(404, "environment_not_found", "Environment not found");
    }
    if (environment.status !== "ready" || environment.path === null) {
      throw new ApiError(
        409,
        "environment_not_ready",
        "Only a ready environment with a workspace can be moved",
      );
    }
    if (environment.hostId === args.targetHostId) {
      throw new ApiError(
        409,
        "environment_already_on_host",
        `Environment ${environment.id} is already on host ${args.targetHostId}`,
      );
    }
    const sourceHost = requireNonDestroyedHostWithStatus(
      this.deps,
      environment.hostId,
    );
    const targetHost = requireNonDestroyedHostWithStatus(
      this.deps,
      args.targetHostId,
    );
    if (
      sourceHost.status !== "connected" ||
      targetHost.status !== "connected"
    ) {
      throw new ApiError(
        409,
        "migration_host_disconnected",
        "Both the source and target hosts must be connected",
      );
    }

    const migrationId = randomUUID();
    let migration: EnvironmentMigrationRecord;
    try {
      migration = createEnvironmentMigration(this.deps.db, {
        id: migrationId,
        environmentId: environment.id,
        sourceHostId: environment.hostId,
        targetHostId: args.targetHostId,
        workspacePath: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType,
        providerSessions: this.listPortableProviderSessions(environment.id),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        isSqliteUniqueConstraintOnColumns(error, {
          columnNames: ["environment_id"],
          indexName: "environment_migrations_active_environment_idx",
          tableName: "environment_migrations",
        })
      ) {
        const concurrent = getActiveEnvironmentMigration(
          this.deps.db,
          environment.id,
        );
        throw new ApiError(
          409,
          "environment_migrating",
          `Environment ${environment.id} is already being moved${concurrent ? ` by ${concurrent.id}` : ""}`,
        );
      }
      throw error;
    }

    try {
      await this.fenceSource(migration);
      migration = this.update(migration.id, {
        checkpoint: "source_fenced",
        stage: "waiting_for_quiescence",
      });
    } catch (error) {
      this.update(migration.id, {
        checkpoint: "rollback_pending",
        stage: "failed",
        error: errorMessage(error),
      });
      await this.rollback(migration.id);
      throw error;
    }

    this.schedule(migration.id);
    return toPublicStatus(migration);
  }

  /** Resume durable jobs once either participating daemon reconnects. */
  recoverForHost(hostId: string): void {
    for (const migration of listRecoverableEnvironmentMigrations(
      this.deps.db,
      hostId,
    )) {
      if (
        this.deps.hub.hasDaemonForHost(migration.sourceHostId) &&
        this.deps.hub.hasDaemonForHost(migration.targetHostId)
      ) {
        this.schedule(migration.id);
      }
    }
  }

  private listPortableProviderSessions(
    environmentId: string,
  ): PortableProviderSession[] {
    const sessions = new Map<string, PortableProviderSession>();
    for (const thread of listThreads(this.deps.db, {
      environmentId,
      includeHidden: true,
    })) {
      const providerThreadId = getLastStoredProviderThreadId(
        this.deps.db,
        thread.id,
      );
      if (!providerThreadId) {
        continue;
      }
      const session = { providerId: thread.providerId, providerThreadId };
      sessions.set(
        `${session.providerId}\0${session.providerThreadId}`,
        session,
      );
    }
    return [...sessions.values()];
  }

  private schedule(migrationId: string): void {
    queueMicrotask(() => {
      void this.runPersisted(migrationId);
    });
  }

  private async runPersisted(migrationId: string): Promise<void> {
    if (this.runningMigrationIds.has(migrationId)) {
      return;
    }
    this.runningMigrationIds.add(migrationId);
    try {
      await this.run(migrationId);
    } catch (error) {
      this.deps.logger.error(
        { err: error, migrationId },
        "Environment migration recovery worker failed",
      );
    } finally {
      this.runningMigrationIds.delete(migrationId);
    }
  }

  private require(migrationId: string): EnvironmentMigrationRecord {
    const migration = getEnvironmentMigration(this.deps.db, migrationId);
    if (!migration) {
      throw new Error(`Unknown environment migration ${migrationId}`);
    }
    return migration;
  }

  private update(
    migrationId: string,
    input: Parameters<typeof updateEnvironmentMigration>[2],
  ): EnvironmentMigrationRecord {
    const migration = updateEnvironmentMigration(
      this.deps.db,
      migrationId,
      input,
    );
    if (!migration) {
      throw new Error(`Unknown environment migration ${migrationId}`);
    }
    return migration;
  }

  private async fenceSource(
    migration: EnvironmentMigrationRecord,
  ): Promise<void> {
    await callHostRetryableOnlineRpc(this.deps, {
      hostId: migration.sourceHostId,
      timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
      command: {
        type: "environment.migration.source_fence",
        environmentId: migration.environmentId,
        migrationId: migration.id,
      },
    });
  }

  private async prepareSource(
    migration: EnvironmentMigrationRecord,
  ): Promise<EnvironmentMigrationManifest> {
    while (true) {
      try {
        this.update(migration.id, { stage: "preparing" });
        return await callHostRetryableOnlineRpc(this.deps, {
          hostId: migration.sourceHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.source_prepare",
            environmentId: migration.environmentId,
            migrationId: migration.id,
            providerSessions: migration.providerSessions,
            workspaceContext: {
              workspacePath: migration.workspacePath,
              workspaceProvisionType: migration.workspaceProvisionType,
            },
          },
        });
      } catch (error) {
        if (!isEnvironmentBusy(error)) {
          throw error;
        }
        this.update(migration.id, { stage: "waiting_for_quiescence" });
        await wait(QUIESCENCE_RETRY_MS);
      }
    }
  }

  private async transferArtifacts(
    migration: EnvironmentMigrationRecord,
    manifest: EnvironmentMigrationManifest,
  ): Promise<void> {
    if (migration.artifactIndex > manifest.artifacts.length) {
      throw new Error("Stored migration artifact index exceeds the manifest");
    }
    for (
      let artifactIndex = migration.artifactIndex;
      artifactIndex < manifest.artifacts.length;
      artifactIndex += 1
    ) {
      const artifact = manifest.artifacts[artifactIndex];
      if (!artifact) {
        throw new Error(`Missing migration artifact ${artifactIndex}`);
      }
      let offset =
        artifactIndex === migration.artifactIndex
          ? migration.artifactOffset
          : 0;
      if (offset > artifact.sizeBytes) {
        throw new Error(`Stored offset exceeds ${artifact.relativePath}`);
      }
      while (offset < artifact.sizeBytes) {
        const chunk = await callHostRetryableOnlineRpc(this.deps, {
          hostId: migration.sourceHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.source_read",
            environmentId: migration.environmentId,
            migrationId: migration.id,
            artifactId: artifact.id,
            offset,
            maxBytes: MIGRATION_CHUNK_BYTES,
          },
        });
        if (
          chunk.nextOffset <= offset ||
          chunk.nextOffset > artifact.sizeBytes
        ) {
          throw new Error(
            `Source returned invalid progress for ${artifact.relativePath}`,
          );
        }
        const written = await callHostRetryableOnlineRpc(this.deps, {
          hostId: migration.targetHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.target_write",
            environmentId: migration.environmentId,
            migrationId: migration.id,
            artifactId: artifact.id,
            offset,
            contentBase64: chunk.contentBase64,
          },
        });
        if (written.nextOffset !== chunk.nextOffset) {
          throw new Error(
            `Target returned invalid progress for ${artifact.relativePath}`,
          );
        }
        migration = this.update(migration.id, {
          artifactIndex,
          artifactOffset: written.nextOffset,
          bytesTransferred:
            migration.bytesTransferred + (written.nextOffset - offset),
        });
        offset = written.nextOffset;
      }
      migration = this.update(migration.id, {
        artifactIndex: artifactIndex + 1,
        artifactOffset: 0,
      });
    }
  }

  private async cleanupAfterCutover(
    migration: EnvironmentMigrationRecord,
  ): Promise<void> {
    const cleanup = await Promise.allSettled([
      callHostRetryableOnlineRpc(this.deps, {
        hostId: migration.sourceHostId,
        timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
        command: {
          type: "environment.migration.source_complete",
          environmentId: migration.environmentId,
          migrationId: migration.id,
        },
      }),
      callHostRetryableOnlineRpc(this.deps, {
        hostId: migration.targetHostId,
        timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
        command: {
          type: "environment.migration.target_complete",
          environmentId: migration.environmentId,
          migrationId: migration.id,
        },
      }),
    ]);
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        this.deps.logger.warn(
          { err: failure.reason, migrationId: migration.id },
          "Environment migration cleanup will resume after reconnect",
        );
      }
      return;
    }
    this.update(migration.id, {
      checkpoint: "cleanup_completed",
      stage: "completed",
      bytesTransferred: migration.totalBytes,
      error: null,
      completedAt: Date.now(),
    });
  }

  private async rollback(migrationId: string): Promise<void> {
    const migration = this.require(migrationId);
    const cleanup = await Promise.allSettled([
      callHostRetryableOnlineRpc(this.deps, {
        hostId: migration.sourceHostId,
        timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
        command: {
          type: "environment.migration.source_abort",
          environmentId: migration.environmentId,
          migrationId: migration.id,
        },
      }),
      callHostRetryableOnlineRpc(this.deps, {
        hostId: migration.targetHostId,
        timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
        command: {
          type: "environment.migration.target_abort",
          environmentId: migration.environmentId,
          migrationId: migration.id,
        },
      }),
    ]);
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        this.deps.logger.warn(
          { err: failure.reason, migrationId },
          "Environment migration rollback will resume after reconnect",
        );
      }
      return;
    }
    this.update(migrationId, {
      checkpoint: "rolled_back",
      stage: "failed",
      completedAt: Date.now(),
    });
  }

  private async run(migrationId: string): Promise<void> {
    let migration = this.require(migrationId);
    if (
      migration.checkpoint === "cleanup_completed" ||
      migration.checkpoint === "rolled_back"
    ) {
      return;
    }
    if (migration.checkpoint === "rollback_pending") {
      await this.rollback(migrationId);
      return;
    }

    try {
      if (migration.checkpoint === "created") {
        await this.fenceSource(migration);
        migration = this.update(migration.id, {
          checkpoint: "source_fenced",
          stage: "waiting_for_quiescence",
        });
      }

      if (migration.checkpoint === "source_fenced") {
        const manifest = await this.prepareSource(migration);
        migration = this.update(migration.id, {
          checkpoint: "source_prepared",
          stage: "transferring",
          manifest,
          totalBytes: manifest.totalBytes,
        });
      }

      const manifest = environmentMigrationManifestSchema.parse(
        migration.manifest,
      );
      if (migration.checkpoint === "source_prepared") {
        await callHostRetryableOnlineRpc(this.deps, {
          hostId: migration.targetHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.target_begin",
            environmentId: migration.environmentId,
            migrationId: migration.id,
            manifest,
          },
        });
        migration = this.update(migration.id, {
          checkpoint: "target_started",
          stage: "transferring",
        });
      }

      if (migration.checkpoint === "target_started") {
        await this.transferArtifacts(migration, manifest);
        migration = this.update(migration.id, {
          checkpoint: "artifacts_transferred",
          stage: "restoring",
          artifactIndex: manifest.artifacts.length,
          artifactOffset: 0,
          bytesTransferred: manifest.totalBytes,
        });
      }

      if (migration.checkpoint === "artifacts_transferred") {
        const restoredWorkspace = await callHostRetryableOnlineRpc(this.deps, {
          hostId: migration.targetHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.target_commit",
            environmentId: migration.environmentId,
            migrationId: migration.id,
          },
        });
        migration = this.update(migration.id, {
          checkpoint: "target_restored",
          stage: "cutting_over",
          restoredWorkspace,
        });
      }

      if (migration.checkpoint === "target_restored") {
        if (!migration.restoredWorkspace) {
          throw new Error(
            "Target restore checkpoint is missing workspace data",
          );
        }
        const cutover = recordEnvironmentMigrationAuthorityCutover(
          this.deps.db,
          this.deps.hub,
          migration.id,
          migration.restoredWorkspace,
        );
        if (!cutover) {
          throw new ApiError(
            409,
            "migration_cutover_conflict",
            "Environment authority changed before migration cutover",
          );
        }
        migration = cutover;
      }

      if (migration.checkpoint === "authority_cutover") {
        await this.cleanupAfterCutover(migration);
      }
    } catch (error) {
      const latest = this.require(migrationId);
      if (latest.checkpoint === "authority_cutover") {
        this.deps.logger.error(
          { err: error, migrationId },
          "Environment migration cleanup failed after authority cutover",
        );
        return;
      }
      this.update(migrationId, {
        checkpoint: "rollback_pending",
        stage: "failed",
        error: errorMessage(error),
      });
      await this.rollback(migrationId);
      this.deps.logger.error(
        { err: error, migrationId },
        "Environment migration failed before cutover",
      );
    }
  }
}
