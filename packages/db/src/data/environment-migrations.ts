import { and, asc, eq, isNull, or } from "drizzle-orm";
import type {
  DiscoveredWorkspaceProperties,
  WorkspaceProvisionType,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import { environmentMigrations } from "../schema.js";
import { recordEnvironmentMigrationCutover } from "./environments.js";

type EnvironmentMigrationReadConnection = DbConnection | DbTransaction;
type EnvironmentMigrationWriteConnection = DbConnection | DbTransaction;

export const environmentMigrationCheckpointValues = [
  "created",
  "source_fenced",
  "source_prepared",
  "target_started",
  "artifacts_transferred",
  "target_restored",
  "authority_cutover",
  "cleanup_completed",
  "rollback_pending",
  "rolled_back",
] as const;

/** A host-acknowledged, restart-safe boundary in the migration workflow. */
export type EnvironmentMigrationCheckpoint =
  (typeof environmentMigrationCheckpointValues)[number];

export type StoredEnvironmentMigrationStage =
  | "fenced"
  | "waiting_for_quiescence"
  | "preparing"
  | "transferring"
  | "restoring"
  | "cutting_over"
  | "completed"
  | "failed";

export interface EnvironmentMigrationProviderSession {
  providerId: string;
  providerThreadId: string;
}

export interface CreateEnvironmentMigrationInput {
  id: string;
  environmentId: string;
  sourceHostId: string;
  targetHostId: string;
  workspacePath: string;
  workspaceProvisionType: WorkspaceProvisionType;
  providerSessions: EnvironmentMigrationProviderSession[];
}

export interface EnvironmentMigrationRecord {
  id: string;
  environmentId: string;
  sourceHostId: string;
  targetHostId: string;
  stage: StoredEnvironmentMigrationStage;
  checkpoint: EnvironmentMigrationCheckpoint;
  workspacePath: string;
  workspaceProvisionType: WorkspaceProvisionType;
  providerSessions: EnvironmentMigrationProviderSession[];
  manifest: unknown | null;
  restoredWorkspace: DiscoveredWorkspaceProperties | null;
  artifactIndex: number;
  artifactOffset: number;
  bytesTransferred: number;
  totalBytes: number;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface UpdateEnvironmentMigrationInput {
  stage?: StoredEnvironmentMigrationStage;
  checkpoint?: EnvironmentMigrationCheckpoint;
  manifest?: unknown | null;
  restoredWorkspace?: DiscoveredWorkspaceProperties | null;
  artifactIndex?: number;
  artifactOffset?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  error?: string | null;
  completedAt?: number | null;
}

type EnvironmentMigrationRow = typeof environmentMigrations.$inferSelect;

function parseJson<T>(json: string): T {
  return JSON.parse(json) as T;
}

function toEnvironmentMigrationRecord(
  row: EnvironmentMigrationRow,
): EnvironmentMigrationRecord {
  return {
    id: row.id,
    environmentId: row.environmentId,
    sourceHostId: row.sourceHostId,
    targetHostId: row.targetHostId,
    stage: row.stage as StoredEnvironmentMigrationStage,
    checkpoint: row.checkpoint as EnvironmentMigrationCheckpoint,
    workspacePath: row.workspacePath,
    workspaceProvisionType: row.workspaceProvisionType,
    providerSessions: parseJson<EnvironmentMigrationProviderSession[]>(
      row.providerSessionsJson,
    ),
    manifest: row.manifestJson === null ? null : parseJson(row.manifestJson),
    restoredWorkspace:
      row.restoredWorkspaceJson === null
        ? null
        : parseJson<DiscoveredWorkspaceProperties>(row.restoredWorkspaceJson),
    artifactIndex: row.artifactIndex,
    artifactOffset: row.artifactOffset,
    bytesTransferred: row.bytesTransferred,
    totalBytes: row.totalBytes,
    error: row.error,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export function createEnvironmentMigration(
  db: EnvironmentMigrationWriteConnection,
  input: CreateEnvironmentMigrationInput,
): EnvironmentMigrationRecord {
  const now = Date.now();
  const row = db
    .insert(environmentMigrations)
    .values({
      id: input.id,
      environmentId: input.environmentId,
      sourceHostId: input.sourceHostId,
      targetHostId: input.targetHostId,
      stage: "fenced",
      checkpoint: "created",
      workspacePath: input.workspacePath,
      workspaceProvisionType: input.workspaceProvisionType,
      providerSessionsJson: JSON.stringify(input.providerSessions),
      startedAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toEnvironmentMigrationRecord(row);
}

export function getEnvironmentMigration(
  db: EnvironmentMigrationReadConnection,
  migrationId: string,
): EnvironmentMigrationRecord | null {
  const row = db
    .select()
    .from(environmentMigrations)
    .where(eq(environmentMigrations.id, migrationId))
    .get();
  return row ? toEnvironmentMigrationRecord(row) : null;
}

export function getActiveEnvironmentMigration(
  db: EnvironmentMigrationReadConnection,
  environmentId: string,
): EnvironmentMigrationRecord | null {
  const row = db
    .select()
    .from(environmentMigrations)
    .where(
      and(
        eq(environmentMigrations.environmentId, environmentId),
        isNull(environmentMigrations.completedAt),
      ),
    )
    .get();
  return row ? toEnvironmentMigrationRecord(row) : null;
}

export function listRecoverableEnvironmentMigrations(
  db: EnvironmentMigrationReadConnection,
  hostId?: string,
): EnvironmentMigrationRecord[] {
  const hostPredicate = hostId
    ? or(
        eq(environmentMigrations.sourceHostId, hostId),
        eq(environmentMigrations.targetHostId, hostId),
      )
    : undefined;
  const rows = db
    .select()
    .from(environmentMigrations)
    .where(
      hostPredicate
        ? and(isNull(environmentMigrations.completedAt), hostPredicate)
        : isNull(environmentMigrations.completedAt),
    )
    .orderBy(asc(environmentMigrations.startedAt))
    .all();
  return rows.map(toEnvironmentMigrationRecord);
}

export function updateEnvironmentMigration(
  db: EnvironmentMigrationWriteConnection,
  migrationId: string,
  input: UpdateEnvironmentMigrationInput,
): EnvironmentMigrationRecord | null {
  const values: Partial<typeof environmentMigrations.$inferInsert> = {
    updatedAt: Date.now(),
  };
  if (input.stage !== undefined) values.stage = input.stage;
  if (input.checkpoint !== undefined) values.checkpoint = input.checkpoint;
  if (input.manifest !== undefined) {
    values.manifestJson =
      input.manifest === null ? null : JSON.stringify(input.manifest);
  }
  if (input.restoredWorkspace !== undefined) {
    values.restoredWorkspaceJson =
      input.restoredWorkspace === null
        ? null
        : JSON.stringify(input.restoredWorkspace);
  }
  if (input.artifactIndex !== undefined) {
    values.artifactIndex = input.artifactIndex;
  }
  if (input.artifactOffset !== undefined) {
    values.artifactOffset = input.artifactOffset;
  }
  if (input.bytesTransferred !== undefined) {
    values.bytesTransferred = input.bytesTransferred;
  }
  if (input.totalBytes !== undefined) values.totalBytes = input.totalBytes;
  if (input.error !== undefined) values.error = input.error;
  if (input.completedAt !== undefined) values.completedAt = input.completedAt;

  const row = db
    .update(environmentMigrations)
    .set(values)
    .where(eq(environmentMigrations.id, migrationId))
    .returning()
    .get();
  return row ? toEnvironmentMigrationRecord(row) : null;
}

export function recordEnvironmentMigrationAuthorityCutover(
  db: DbConnection,
  notifier: DbNotifier,
  migrationId: string,
  restoredWorkspace: DiscoveredWorkspaceProperties,
): EnvironmentMigrationRecord | null {
  return db.transaction((tx) => {
    const migration = getEnvironmentMigration(tx, migrationId);
    if (!migration || migration.checkpoint !== "target_restored") {
      return null;
    }
    const environment = recordEnvironmentMigrationCutover(
      tx,
      notifier,
      migration.environmentId,
      {
        ...restoredWorkspace,
        sourceHostId: migration.sourceHostId,
        targetHostId: migration.targetHostId,
      },
    );
    if (!environment) {
      return null;
    }
    return updateEnvironmentMigration(tx, migrationId, {
      checkpoint: "authority_cutover",
      stage: "cutting_over",
      restoredWorkspace,
    });
  });
}
