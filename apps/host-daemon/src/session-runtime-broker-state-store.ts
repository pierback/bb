import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  clientTurnRequestIdSchema,
  contextCapsuleRestatementSchema,
  sessionWorkspaceStateSchema,
  type ClientTurnRequestId,
  type ContextCapsuleRestatement,
  type SessionWorkspaceState,
} from "@bb/domain";
import {
  hostDaemonRuntimeIncarnationSchema,
  hostDaemonSessionRuntimeControlStateSchema,
  type HostDaemonRuntimeIncarnation,
  type HostDaemonSessionRuntimeControlState,
} from "@bb/host-daemon-contract";
import { z } from "zod";

const SESSION_RUNTIME_BROKER_STATE_VERSION = 1 as const;

const persistedRestatementReceiptSchema = z
  .object({
    bindingId: z.string().min(1),
    capsuleContentHash: z.string().min(1),
    requestId: clientTurnRequestIdSchema,
    restatement: contextCapsuleRestatementSchema,
    transitionId: z.string().min(1),
    turnId: z.string().min(1),
    workspaceState: sessionWorkspaceStateSchema.omit({
      hostId: true,
      id: true,
    }),
  })
  .strict();

const persistedRuntimeRecoveryReceiptSchema = z
  .object({
    bindingId: z.string().min(1),
    previousControlEpoch: z.number().int().nonnegative(),
    previousIncarnation: hostDaemonRuntimeIncarnationSchema,
  })
  .strict();

const persistedSessionRuntimeBrokerStateSchema = z
  .object({
    bindings: z.array(
      z
        .object({
          control: hostDaemonSessionRuntimeControlStateSchema,
          providerThreadId: z.string().min(1).nullable(),
          runtimeProcessId: z.number().int().positive().nullable(),
        })
        .strict(),
    ),
    handoffRestatementReceipts: z.array(persistedRestatementReceiptSchema),
    runtimeRecoveryReceipts: z.array(persistedRuntimeRecoveryReceiptSchema),
    version: z.literal(SESSION_RUNTIME_BROKER_STATE_VERSION),
  })
  .strict();

export interface PersistedSessionRuntimeBinding {
  readonly control: HostDaemonSessionRuntimeControlState;
  readonly providerThreadId: string | null;
  readonly runtimeProcessId: number | null;
}

export interface PersistedSessionRuntimeHandoffRestatementReceipt {
  readonly bindingId: string;
  readonly capsuleContentHash: string;
  readonly requestId: ClientTurnRequestId;
  readonly restatement: ContextCapsuleRestatement;
  readonly transitionId: string;
  readonly turnId: string;
  readonly workspaceState: Omit<SessionWorkspaceState, "hostId" | "id">;
}

export interface PersistedSessionRuntimeRecoveryReceipt {
  readonly bindingId: string;
  readonly previousControlEpoch: number;
  readonly previousIncarnation: HostDaemonRuntimeIncarnation;
}

export interface SessionRuntimeBrokerStateSnapshot {
  readonly bindings: readonly PersistedSessionRuntimeBinding[];
  readonly handoffRestatementReceipts: readonly PersistedSessionRuntimeHandoffRestatementReceipt[];
  readonly runtimeRecoveryReceipts: readonly PersistedSessionRuntimeRecoveryReceipt[];
}

export interface SessionRuntimeBrokerStateStore {
  load(): SessionRuntimeBrokerStateSnapshot | null;
  save(state: SessionRuntimeBrokerStateSnapshot): void;
}

export class SessionRuntimeBrokerStateStorePersistenceError extends Error {
  constructor(
    message: string,
    readonly stateMayBeCommitted: boolean,
    options: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionRuntimeBrokerStateStorePersistenceError";
  }
}

class FileSessionRuntimeBrokerStateStore implements SessionRuntimeBrokerStateStore {
  constructor(private readonly statePath: string) {}

  load(): SessionRuntimeBrokerStateSnapshot | null {
    let source: string;
    try {
      source = fs.readFileSync(this.statePath, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch (error) {
      throw new Error(
        `Session Runtime Broker state is not valid JSON: ${this.statePath}`,
        { cause: error },
      );
    }
    const persisted = persistedSessionRuntimeBrokerStateSchema.parse(decoded);
    return {
      bindings: persisted.bindings,
      handoffRestatementReceipts: persisted.handoffRestatementReceipts,
      runtimeRecoveryReceipts: persisted.runtimeRecoveryReceipts,
    };
  }

  save(state: SessionRuntimeBrokerStateSnapshot): void {
    const persisted = persistedSessionRuntimeBrokerStateSchema.parse({
      ...state,
      version: SESSION_RUNTIME_BROKER_STATE_VERSION,
    });
    const directoryPath = path.dirname(this.statePath);
    fs.mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    let stateMayBeCommitted = false;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(persisted)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, this.statePath);
      stateMayBeCommitted = true;
      const directoryDescriptor = fs.openSync(directoryPath, "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (descriptor !== null) {
        fs.closeSync(descriptor);
      }
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (
          !(
            cleanupError instanceof Error &&
            "code" in cleanupError &&
            cleanupError.code === "ENOENT"
          )
        ) {
          throw new AggregateError(
            [error, cleanupError],
            "Failed to persist and clean up Session Runtime Broker state",
          );
        }
      }
      throw new SessionRuntimeBrokerStateStorePersistenceError(
        `Failed to persist Session Runtime Broker state at ${this.statePath}`,
        stateMayBeCommitted,
        { cause: error },
      );
    }
  }
}

export function createFileSessionRuntimeBrokerStateStore(
  statePath: string,
): SessionRuntimeBrokerStateStore {
  return new FileSessionRuntimeBrokerStateStore(statePath);
}

export function sessionRuntimeBrokerStatePath(dataDir: string): string {
  return path.join(dataDir, "session-fabric", "runtime-broker-v1.json");
}
