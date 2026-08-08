import { randomUUID } from "node:crypto";
import {
  getEnvironment,
  getLastStoredProviderThreadId,
  listThreads,
  recordEnvironmentMigrationCutover,
} from "@bb/db";
import type { EnvironmentMigrationManifest } from "@bb/host-daemon-contract";
import type {
  EnvironmentMigrationStage,
  EnvironmentMigrationStatus,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { requireNonDestroyedHostWithStatus } from "../lib/entity-lookup.js";
import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpc,
} from "../hosts/online-rpc.js";

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

export class EnvironmentMigrationCoordinator {
  private readonly statuses = new Map<string, EnvironmentMigrationStatus>();
  private readonly activeByEnvironmentId = new Map<string, string>();

  constructor(private readonly deps: LoggedWorkSessionDeps) {}

  get(migrationId: string): EnvironmentMigrationStatus | null {
    const status = this.statuses.get(migrationId);
    return status ? { ...status } : null;
  }

  async begin(
    args: BeginEnvironmentMigrationArgs,
  ): Promise<EnvironmentMigrationStatus> {
    const existingMigrationId = this.activeByEnvironmentId.get(
      args.environmentId,
    );
    if (existingMigrationId) {
      throw new ApiError(
        409,
        "environment_migrating",
        `Environment ${args.environmentId} is already being moved by ${existingMigrationId}`,
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
    const workspacePath = environment.path;

    const migrationId = randomUUID();
    const now = Date.now();
    const status: EnvironmentMigrationStatus = {
      migrationId,
      environmentId: environment.id,
      sourceHostId: environment.hostId,
      targetHostId: args.targetHostId,
      stage: "fenced",
      bytesTransferred: 0,
      totalBytes: 0,
      error: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.statuses.set(migrationId, status);
    this.activeByEnvironmentId.set(environment.id, migrationId);

    try {
      await callHostRetryableOnlineRpc(this.deps, {
        hostId: environment.hostId,
        timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
        command: {
          type: "environment.migration.source_fence",
          environmentId: environment.id,
          migrationId,
        },
      });
    } catch (error) {
      this.activeByEnvironmentId.delete(environment.id);
      this.statuses.delete(migrationId);
      throw error;
    }

    const providerSessions = this.listPortableProviderSessions(environment.id);
    this.setStage(migrationId, "waiting_for_quiescence");
    queueMicrotask(() => {
      void this.run({
        environmentId: environment.id,
        migrationId,
        providerSessions,
        sourceHostId: environment.hostId,
        targetHostId: args.targetHostId,
        workspaceContext: {
          workspacePath,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
      });
    });
    return this.requireStatus(migrationId);
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

  private requireStatus(migrationId: string): EnvironmentMigrationStatus {
    const status = this.statuses.get(migrationId);
    if (!status) {
      throw new Error(`Unknown environment migration ${migrationId}`);
    }
    return { ...status };
  }

  private updateStatus(
    migrationId: string,
    update: Partial<EnvironmentMigrationStatus>,
  ): void {
    const current = this.statuses.get(migrationId);
    if (!current) {
      throw new Error(`Unknown environment migration ${migrationId}`);
    }
    this.statuses.set(migrationId, {
      ...current,
      ...update,
      updatedAt: Date.now(),
    });
  }

  private setStage(
    migrationId: string,
    stage: EnvironmentMigrationStage,
  ): void {
    this.updateStatus(migrationId, { stage });
  }

  private async prepareSource(args: {
    environmentId: string;
    migrationId: string;
    providerSessions: PortableProviderSession[];
    sourceHostId: string;
    workspaceContext: {
      workspacePath: string;
      workspaceProvisionType: "unmanaged" | "managed-worktree" | "personal";
    };
  }): Promise<EnvironmentMigrationManifest> {
    while (true) {
      try {
        this.setStage(args.migrationId, "preparing");
        return await callHostOnlineRpc(this.deps, {
          hostId: args.sourceHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.source_prepare",
            environmentId: args.environmentId,
            migrationId: args.migrationId,
            providerSessions: args.providerSessions,
            workspaceContext: args.workspaceContext,
          },
        });
      } catch (error) {
        if (!isEnvironmentBusy(error)) {
          throw error;
        }
        this.setStage(args.migrationId, "waiting_for_quiescence");
        await wait(QUIESCENCE_RETRY_MS);
      }
    }
  }

  private async transferArtifacts(args: {
    environmentId: string;
    manifest: EnvironmentMigrationManifest;
    migrationId: string;
    sourceHostId: string;
    targetHostId: string;
  }): Promise<void> {
    for (const artifact of args.manifest.artifacts) {
      let offset = 0;
      while (offset < artifact.sizeBytes) {
        const chunk = await callHostRetryableOnlineRpc(this.deps, {
          hostId: args.sourceHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.source_read",
            environmentId: args.environmentId,
            migrationId: args.migrationId,
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
        const written = await callHostOnlineRpc(this.deps, {
          hostId: args.targetHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.target_write",
            environmentId: args.environmentId,
            migrationId: args.migrationId,
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
        this.updateStatus(args.migrationId, {
          bytesTransferred:
            this.requireStatus(args.migrationId).bytesTransferred +
            (written.nextOffset - offset),
        });
        offset = written.nextOffset;
      }
    }
  }

  private async run(args: {
    environmentId: string;
    migrationId: string;
    providerSessions: PortableProviderSession[];
    sourceHostId: string;
    targetHostId: string;
    workspaceContext: {
      workspacePath: string;
      workspaceProvisionType: "unmanaged" | "managed-worktree" | "personal";
    };
  }): Promise<void> {
    let targetStarted = false;
    let cutoverCompleted = false;
    try {
      const manifest = await this.prepareSource(args);
      this.updateStatus(args.migrationId, {
        stage: "transferring",
        totalBytes: manifest.totalBytes,
      });
      await callHostOnlineRpc(this.deps, {
        hostId: args.targetHostId,
        timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
        command: {
          type: "environment.migration.target_begin",
          environmentId: args.environmentId,
          migrationId: args.migrationId,
          manifest,
        },
      });
      targetStarted = true;
      await this.transferArtifacts({ ...args, manifest });
      this.setStage(args.migrationId, "restoring");
      const restoredWorkspace = await callHostOnlineRpc(this.deps, {
        hostId: args.targetHostId,
        timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
        command: {
          type: "environment.migration.target_commit",
          environmentId: args.environmentId,
          migrationId: args.migrationId,
        },
      });
      this.setStage(args.migrationId, "cutting_over");
      const updated = recordEnvironmentMigrationCutover(
        this.deps.db,
        this.deps.hub,
        args.environmentId,
        {
          ...restoredWorkspace,
          sourceHostId: args.sourceHostId,
          targetHostId: args.targetHostId,
        },
      );
      if (!updated) {
        throw new ApiError(
          409,
          "migration_cutover_conflict",
          "Environment authority changed before migration cutover",
        );
      }
      cutoverCompleted = true;
      const completedAt = Date.now();
      this.updateStatus(args.migrationId, {
        stage: "completed",
        bytesTransferred: manifest.totalBytes,
        completedAt,
      });
      this.activeByEnvironmentId.delete(args.environmentId);

      const cleanup = await Promise.allSettled([
        callHostOnlineRpc(this.deps, {
          hostId: args.sourceHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.source_complete",
            environmentId: args.environmentId,
            migrationId: args.migrationId,
          },
        }),
        callHostOnlineRpc(this.deps, {
          hostId: args.targetHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.target_complete",
            environmentId: args.environmentId,
            migrationId: args.migrationId,
          },
        }),
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected") {
          this.deps.logger.warn(
            { err: result.reason, migrationId: args.migrationId },
            "Environment migration cleanup failed after cutover",
          );
        }
      }
    } catch (error) {
      if (cutoverCompleted) {
        this.deps.logger.error(
          { err: error, migrationId: args.migrationId },
          "Environment migration failed after authority cutover",
        );
        return;
      }
      const rollbackTasks: Promise<unknown>[] = [
        callHostOnlineRpc(this.deps, {
          hostId: args.sourceHostId,
          timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
          command: {
            type: "environment.migration.source_abort",
            environmentId: args.environmentId,
            migrationId: args.migrationId,
          },
        }),
      ];
      if (targetStarted) {
        rollbackTasks.push(
          callHostOnlineRpc(this.deps, {
            hostId: args.targetHostId,
            timeoutMs: MIGRATION_RPC_TIMEOUT_MS,
            command: {
              type: "environment.migration.target_abort",
              environmentId: args.environmentId,
              migrationId: args.migrationId,
            },
          }),
        );
      }
      await Promise.allSettled(rollbackTasks);
      const completedAt = Date.now();
      this.updateStatus(args.migrationId, {
        stage: "failed",
        error: errorMessage(error),
        completedAt,
      });
      this.activeByEnvironmentId.delete(args.environmentId);
      this.deps.logger.error(
        { err: error, migrationId: args.migrationId },
        "Environment migration failed before cutover",
      );
    }
  }
}
