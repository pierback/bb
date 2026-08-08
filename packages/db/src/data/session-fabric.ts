import { and, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  contextCapsuleRestatementSchema,
  contextCapsuleSchema,
  evaluateSessionCommandLifecycle,
  evaluateHandoffTransitionLifecycle,
  executionBindingSchema,
  findContextCapsuleRestatementIssues,
  findContextCapsuleSensitiveMaterial,
  findDestinationMutationGateIssues,
  findHandoffSettlementIssues,
  handoffAuthorizationEvidenceSchema,
  handoffSettlementSnapshotSchema,
  handoffTransitionSchema,
  mutationReceiptSchema,
  runtimeInstanceSchema,
  runtimeRecipeSchema,
  sessionCommandSchema,
  sessionWorkspaceStateSchema,
  serializeContextCapsuleForHash,
  type ContextCapsule,
  type ContextCapsuleRestatement,
  type DestinationWorkspaceDisposition,
  type HandoffAuthorizationEvidence,
  type HandoffSettlementSnapshot,
  type HandoffTransition,
  type HandoffTransitionLifecycleEvent,
  type MutationReceipt,
  type ProviderAccountRef,
  type RuntimeInstance,
  type RuntimeOwnership,
  type RuntimeMutationPolicy,
  type RuntimePhase,
  type RuntimeRecipe,
  type SessionCommand,
  type SessionCommandKind,
  type SessionCommandLifecycleEvent,
  type SessionModelRef,
  type SessionWorkspaceState,
  type WorkstreamBranch,
  type Workstream,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import {
  createSessionBranchId,
  createSessionAdoptionId,
  createSessionCommandEventId,
  createSessionCommandId,
  createSessionContextCapsuleId,
  createSessionExecutionBindingId,
  createSessionHandoffAuthorizationId,
  createSessionHandoffEventId,
  createSessionHandoffRestatementId,
  createSessionHandoffReviewId,
  createSessionHandoffSettlementId,
  createSessionHandoffTransitionId,
  createSessionModelEpochId,
  createSessionNativeConversationId,
  createSessionRuntimeRecipeId,
  createSessionWorkspaceStateId,
  createSessionWorkstreamId,
} from "../ids.js";
import {
  environments,
  hosts,
  sessionFabricBranches,
  sessionFabricAdoptions,
  sessionFabricCommandEvents,
  sessionFabricCommands,
  sessionFabricContextCapsules,
  sessionFabricExecutionBindings,
  sessionFabricHandoffAuthorizations,
  sessionFabricHandoffEvents,
  sessionFabricHandoffRestatements,
  sessionFabricHandoffReviews,
  sessionFabricHandoffSourceSettlements,
  sessionFabricHandoffTransitions,
  sessionFabricModelEpochs,
  sessionFabricNativeConversations,
  sessionFabricRuntimeInstances,
  sessionFabricRuntimeRecipes,
  sessionFabricWorkspaceStates,
  sessionFabricWorkstreams,
  threads,
} from "../schema.js";

type SessionFabricWriteConnection = DbConnection | DbTransaction;

export type SessionFabricWorkstreamRow =
  typeof sessionFabricWorkstreams.$inferSelect;
export type SessionFabricBranchRow = typeof sessionFabricBranches.$inferSelect;
export type SessionFabricAdoptionRow =
  typeof sessionFabricAdoptions.$inferSelect;
export type SessionFabricNativeConversationRow =
  typeof sessionFabricNativeConversations.$inferSelect;
export type SessionFabricRuntimeInstanceRow =
  typeof sessionFabricRuntimeInstances.$inferSelect;
export type SessionFabricRuntimeRecipeRow =
  typeof sessionFabricRuntimeRecipes.$inferSelect;
export type SessionFabricWorkspaceStateRow =
  typeof sessionFabricWorkspaceStates.$inferSelect;
export type SessionFabricExecutionBindingRow =
  typeof sessionFabricExecutionBindings.$inferSelect;
export type SessionFabricEnvironmentRow = typeof environments.$inferSelect;
export type SessionFabricModelEpochRow =
  typeof sessionFabricModelEpochs.$inferSelect;
export type SessionFabricCommandRow = typeof sessionFabricCommands.$inferSelect;
export type SessionFabricThreadRow = typeof threads.$inferSelect;
export type SessionFabricCommandEventRow =
  typeof sessionFabricCommandEvents.$inferSelect;
export type SessionFabricHandoffTransitionRow =
  typeof sessionFabricHandoffTransitions.$inferSelect;
export type SessionFabricHandoffEventRow =
  typeof sessionFabricHandoffEvents.$inferSelect;
export type SessionFabricHandoffSourceSettlementRow =
  typeof sessionFabricHandoffSourceSettlements.$inferSelect;
export type SessionFabricContextCapsuleRow =
  typeof sessionFabricContextCapsules.$inferSelect;
export type SessionFabricHandoffReviewRow =
  typeof sessionFabricHandoffReviews.$inferSelect;
export type SessionFabricHandoffAuthorizationRow =
  typeof sessionFabricHandoffAuthorizations.$inferSelect;
export type SessionFabricHandoffRestatementRow =
  typeof sessionFabricHandoffRestatements.$inferSelect;

export const sessionFabricPersistenceErrorCodeValues = [
  "active_binding_changed",
  "adoption_idempotency_conflict",
  "adoption_not_found",
  "adoption_status_changed",
  "binding_ingress_fenced",
  "binding_command_in_flight",
  "binding_execution_epoch_changed",
  "binding_execution_uncertain",
  "binding_not_idle",
  "binding_not_active",
  "binding_not_found",
  "branch_not_found",
  "command_not_found",
  "command_status_changed",
  "illegal_command_transition",
  "capsule_hash_mismatch",
  "capsule_sensitive_material",
  "destination_mutation_gate_closed",
  "destination_restatement_mismatch",
  "handoff_evidence_conflict",
  "handoff_idempotency_conflict",
  "handoff_illegal_transition",
  "handoff_not_found",
  "handoff_phase_changed",
  "handoff_settlement_incomplete",
  "invalid_handoff_topology",
  "invalid_binding_topology",
  "invalid_model_change_receipt",
  "invalid_model_epoch",
  "runtime_incarnation_conflict",
  "runtime_recovery_conflict",
  "thread_already_bound",
] as const;
export type SessionFabricPersistenceErrorCode =
  (typeof sessionFabricPersistenceErrorCodeValues)[number];

export class SessionFabricPersistenceError extends Error {
  constructor(
    readonly code: SessionFabricPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionFabricPersistenceError";
  }
}

function toWorkstream(row: SessionFabricWorkstreamRow): Workstream {
  return {
    activeBranchId: row.activeBranchId,
    createdAt: row.createdAt,
    id: row.id,
    objective: row.objective,
    projectId: row.projectId,
    status: row.status,
    title: row.title,
    updatedAt: row.updatedAt,
  };
}

function toBranch(row: SessionFabricBranchRow): WorkstreamBranch {
  return {
    activeBindingId: row.activeBindingId,
    createdAt: row.createdAt,
    id: row.id,
    parentBranchId: row.parentBranchId,
    status: row.status,
    workstreamId: row.workstreamId,
  };
}

function toSessionCommand(row: SessionFabricCommandRow): SessionCommand {
  return sessionCommandSchema.parse({
    bindingId: row.bindingId,
    createdAt: row.createdAt,
    guard: row.guard,
    id: row.id,
    kind: row.kind,
    modelEpochId: row.modelEpochId,
    payloadHash: row.payloadHash,
    status: row.status,
    updatedAt: row.updatedAt,
  });
}

export interface CreateSessionLineageArgs {
  objective: string;
  projectId: string;
  title: string;
  createdAt?: number;
}

export interface CreateSessionLineageResult {
  branch: WorkstreamBranch;
  workstream: Workstream;
}

/** Creates the canonical workstream and its first active branch atomically. */
export function createSessionLineage(
  db: DbConnection,
  args: CreateSessionLineageArgs,
): CreateSessionLineageResult {
  const createdAt = args.createdAt ?? Date.now();
  const workstreamId = createSessionWorkstreamId();
  const branchId = createSessionBranchId();
  return db.transaction(
    (tx) => {
      tx.insert(sessionFabricWorkstreams)
        .values({
          id: workstreamId,
          projectId: args.projectId,
          title: args.title,
          objective: args.objective,
          status: "active",
          activeBranchId: null,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
      const branch = tx
        .insert(sessionFabricBranches)
        .values({
          id: branchId,
          workstreamId,
          parentBranchId: null,
          status: "active",
          activeBindingId: null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning()
        .get();
      const workstream = tx
        .update(sessionFabricWorkstreams)
        .set({ activeBranchId: branchId, updatedAt: createdAt })
        .where(eq(sessionFabricWorkstreams.id, workstreamId))
        .returning()
        .get();
      if (!branch || !workstream) {
        throw new Error("failed to create Session Fabric lineage");
      }
      return { branch: toBranch(branch), workstream: toWorkstream(workstream) };
    },
    { behavior: "immediate" },
  );
}

export interface UpsertSessionNativeConversationArgs {
  cwd: string | null;
  hostId: string;
  lastObservedAt: number;
  nativeConversationId: string;
  projectId: string | null;
  providerId: string;
  providerInstanceId: string;
  providerState: string;
  title: string | null;
}

function upsertSessionNativeConversationInTransaction(
  db: SessionFabricWriteConnection,
  args: UpsertSessionNativeConversationArgs,
): SessionFabricNativeConversationRow {
  const existing = db
    .select()
    .from(sessionFabricNativeConversations)
    .where(
      and(
        eq(sessionFabricNativeConversations.hostId, args.hostId),
        eq(sessionFabricNativeConversations.providerId, args.providerId),
        eq(
          sessionFabricNativeConversations.providerInstanceId,
          args.providerInstanceId,
        ),
        eq(
          sessionFabricNativeConversations.nativeConversationId,
          args.nativeConversationId,
        ),
      ),
    )
    .get();
  if (existing) {
    return (
      db
        .update(sessionFabricNativeConversations)
        .set({
          cwd: args.cwd,
          lastObservedAt: args.lastObservedAt,
          projectId: args.projectId ?? existing.projectId,
          providerState: args.providerState,
          title: args.title,
          updatedAt: args.lastObservedAt,
        })
        .where(eq(sessionFabricNativeConversations.id, existing.id))
        .returning()
        .get() ?? existing
    );
  }
  return db
    .insert(sessionFabricNativeConversations)
    .values({
      id: createSessionNativeConversationId(),
      ...args,
      createdAt: args.lastObservedAt,
      updatedAt: args.lastObservedAt,
    })
    .returning()
    .get();
}

export function upsertSessionNativeConversation(
  db: DbConnection,
  args: UpsertSessionNativeConversationArgs,
): SessionFabricNativeConversationRow {
  return db.transaction(
    (tx) => upsertSessionNativeConversationInTransaction(tx, args),
    { behavior: "immediate" },
  );
}

export function getSessionNativeConversation(
  db: DbQueryConnection,
  id: string,
): SessionFabricNativeConversationRow | null {
  return (
    db
      .select()
      .from(sessionFabricNativeConversations)
      .where(eq(sessionFabricNativeConversations.id, id))
      .get() ?? null
  );
}

export interface RecordSessionRuntimeInstanceArgs extends RuntimeInstance {
  processKey: string;
  providerId: string;
}

function assertRuntimeInstanceDomain(
  args: RecordSessionRuntimeInstanceArgs,
): void {
  runtimeInstanceSchema.parse({
    bootNonce: args.bootNonce,
    connectorId: args.connectorId,
    endpointFingerprint: args.endpointFingerprint,
    hostId: args.hostId,
    id: args.id,
    providerInstanceId: args.providerInstanceId,
    startedAt: args.startedAt,
    status: args.status,
    stoppedAt: args.stoppedAt,
  });
}

function sameRuntimeInstance(
  row: SessionFabricRuntimeInstanceRow,
  args: RecordSessionRuntimeInstanceArgs,
): boolean {
  return (
    row.id === args.id &&
    row.bootNonce === args.bootNonce &&
    row.connectorId === args.connectorId &&
    row.endpointFingerprint === args.endpointFingerprint &&
    row.hostId === args.hostId &&
    row.processKey === args.processKey &&
    row.providerId === args.providerId &&
    row.providerInstanceId === args.providerInstanceId &&
    row.startedAt === args.startedAt &&
    row.status === args.status &&
    row.stoppedAt === args.stoppedAt
  );
}

/** Records immutable incarnation identity; reusing an id for new evidence fails. */
export function recordSessionRuntimeInstance(
  db: DbConnection,
  args: RecordSessionRuntimeInstanceArgs,
): SessionFabricRuntimeInstanceRow {
  assertRuntimeInstanceDomain(args);
  return db.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(sessionFabricRuntimeInstances)
        .where(eq(sessionFabricRuntimeInstances.id, args.id))
        .get();
      if (existing) {
        if (!sameRuntimeInstance(existing, args)) {
          throw new SessionFabricPersistenceError(
            "runtime_incarnation_conflict",
            `runtime instance ${args.id} already names different incarnation evidence`,
          );
        }
        return existing;
      }
      return tx
        .insert(sessionFabricRuntimeInstances)
        .values({
          ...args,
          createdAt: args.startedAt,
          updatedAt: args.startedAt,
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

export function createSessionRuntimeRecipe(
  db: SessionFabricWriteConnection,
  recipe: Omit<RuntimeRecipe, "id"> & { id?: string; createdAt?: number },
): SessionFabricRuntimeRecipeRow {
  const { createdAt, id: suppliedId, ...recipeFields } = recipe;
  const id = suppliedId ?? createSessionRuntimeRecipeId();
  const parsed = runtimeRecipeSchema.parse({ ...recipeFields, id });
  return db
    .insert(sessionFabricRuntimeRecipes)
    .values({ ...parsed, createdAt: createdAt ?? Date.now() })
    .returning()
    .get();
}

export function recordSessionWorkspaceState(
  db: SessionFabricWriteConnection,
  state: SessionWorkspaceState,
): SessionFabricWorkspaceStateRow {
  const parsed = sessionWorkspaceStateSchema.parse(state);
  return db
    .insert(sessionFabricWorkspaceStates)
    .values(parsed)
    .returning()
    .get();
}

export interface OpenSessionExecutionBindingArgs {
  controlEpoch: number;
  environmentId: string | null;
  id?: string;
  nativeConversationId: string;
  nativeCursor: string | null;
  mutationPolicy: RuntimeMutationPolicy;
  openedAt?: number;
  ownership: RuntimeOwnership;
  phase: RuntimePhase;
  providerTurnId: string | null;
  runtimeInstanceId: string | null;
  runtimeRecipeId: string;
  threadId: string | null;
  workspaceStateId: string;
  workstreamBranchId: string;
}

export function openSessionExecutionBinding(
  db: DbConnection,
  args: OpenSessionExecutionBindingArgs,
): SessionFabricExecutionBindingRow {
  const id = args.id ?? createSessionExecutionBindingId();
  const openedAt = args.openedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const branch = tx
        .select()
        .from(sessionFabricBranches)
        .where(eq(sessionFabricBranches.id, args.workstreamBranchId))
        .get();
      if (!branch) {
        throw new SessionFabricPersistenceError(
          "branch_not_found",
          `Session Fabric branch not found: ${args.workstreamBranchId}`,
        );
      }
      const workstream = tx
        .select()
        .from(sessionFabricWorkstreams)
        .where(eq(sessionFabricWorkstreams.id, branch.workstreamId))
        .get();
      const thread =
        args.threadId === null
          ? null
          : tx
              .select()
              .from(threads)
              .where(eq(threads.id, args.threadId))
              .get();
      const environment =
        args.environmentId === null
          ? null
          : tx
              .select()
              .from(environments)
              .where(eq(environments.id, args.environmentId))
              .get();
      const nativeConversation = tx
        .select()
        .from(sessionFabricNativeConversations)
        .where(
          eq(sessionFabricNativeConversations.id, args.nativeConversationId),
        )
        .get();
      const runtime =
        args.runtimeInstanceId === null
          ? null
          : tx
              .select()
              .from(sessionFabricRuntimeInstances)
              .where(
                eq(sessionFabricRuntimeInstances.id, args.runtimeInstanceId),
              )
              .get();
      const recipe = tx
        .select()
        .from(sessionFabricRuntimeRecipes)
        .where(eq(sessionFabricRuntimeRecipes.id, args.runtimeRecipeId))
        .get();
      const workspace = tx
        .select()
        .from(sessionFabricWorkspaceStates)
        .where(eq(sessionFabricWorkspaceStates.id, args.workspaceStateId))
        .get();
      if (
        !workstream ||
        (args.threadId !== null && !thread) ||
        (args.environmentId !== null && !environment) ||
        !nativeConversation ||
        !recipe ||
        !workspace
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_binding_topology",
          "binding references missing workstream, thread, environment, native conversation, recipe, or workspace state",
        );
      }
      if (
        (args.runtimeInstanceId !== null && !runtime) ||
        (runtime != null &&
          (runtime.hostId !== nativeConversation.hostId ||
            runtime.providerId !== nativeConversation.providerId ||
            runtime.providerInstanceId !==
              nativeConversation.providerInstanceId)) ||
        workspace.hostId !== nativeConversation.hostId ||
        (nativeConversation.projectId !== null &&
          nativeConversation.projectId !== workstream.projectId) ||
        (thread != null &&
          (thread.projectId !== workstream.projectId ||
            thread.providerId !== nativeConversation.providerId ||
            thread.environmentId !== args.environmentId)) ||
        (environment != null &&
          (environment.projectId !== workstream.projectId ||
            environment.hostId !== nativeConversation.hostId))
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_binding_topology",
          "binding workstream, thread, environment, runtime, native conversation, and workspace do not share project/host/provider identity",
        );
      }
      executionBindingSchema.parse({
        closedAt: null,
        controlEpoch: args.controlEpoch,
        id,
        nativeConversation: {
          hostId: nativeConversation.hostId,
          nativeConversationId: nativeConversation.nativeConversationId,
          providerId: nativeConversation.providerId,
          providerInstanceId: nativeConversation.providerInstanceId,
        },
        openedAt,
        mutationPolicy: args.mutationPolicy,
        ownership: args.ownership,
        phase: args.phase,
        runtimeInstanceId: args.runtimeInstanceId,
        runtimeRecipeId: args.runtimeRecipeId,
        workspaceStateId: args.workspaceStateId,
        workstreamBranchId: args.workstreamBranchId,
      });
      return tx
        .insert(sessionFabricExecutionBindings)
        .values({ ...args, id, openedAt, closedAt: null, updatedAt: openedAt })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

export interface SessionExecutionBindingContext {
  binding: SessionFabricExecutionBindingRow;
  branch: SessionFabricBranchRow;
  environment: SessionFabricEnvironmentRow | null;
  nativeConversation: SessionFabricNativeConversationRow;
  runtimeInstance: SessionFabricRuntimeInstanceRow | null;
  runtimeRecipe: SessionFabricRuntimeRecipeRow;
  thread: SessionFabricThreadRow | null;
  workspaceState: SessionFabricWorkspaceStateRow;
  workstream: SessionFabricWorkstreamRow;
}

/** Resolves the complete server-owned authority context for one binding. */
export function getSessionExecutionBindingContext(
  db: DbQueryConnection,
  bindingId: string,
): SessionExecutionBindingContext | null {
  const binding = db
    .select()
    .from(sessionFabricExecutionBindings)
    .where(eq(sessionFabricExecutionBindings.id, bindingId))
    .get();
  if (!binding) {
    return null;
  }
  const branch = db
    .select()
    .from(sessionFabricBranches)
    .where(eq(sessionFabricBranches.id, binding.workstreamBranchId))
    .get();
  const nativeConversation = db
    .select()
    .from(sessionFabricNativeConversations)
    .where(
      eq(sessionFabricNativeConversations.id, binding.nativeConversationId),
    )
    .get();
  const thread =
    binding.threadId === null
      ? null
      : db.select().from(threads).where(eq(threads.id, binding.threadId)).get();
  const environment =
    binding.environmentId === null
      ? null
      : db
          .select()
          .from(environments)
          .where(eq(environments.id, binding.environmentId))
          .get();
  const runtimeInstance =
    binding.runtimeInstanceId === null
      ? null
      : db
          .select()
          .from(sessionFabricRuntimeInstances)
          .where(
            eq(sessionFabricRuntimeInstances.id, binding.runtimeInstanceId),
          )
          .get();
  const runtimeRecipe = db
    .select()
    .from(sessionFabricRuntimeRecipes)
    .where(eq(sessionFabricRuntimeRecipes.id, binding.runtimeRecipeId))
    .get();
  const workspaceState = db
    .select()
    .from(sessionFabricWorkspaceStates)
    .where(eq(sessionFabricWorkspaceStates.id, binding.workspaceStateId))
    .get();
  const workstream = branch
    ? db
        .select()
        .from(sessionFabricWorkstreams)
        .where(eq(sessionFabricWorkstreams.id, branch.workstreamId))
        .get()
    : undefined;
  if (
    !branch ||
    (binding.threadId !== null && !thread) ||
    (binding.environmentId !== null && !environment) ||
    !nativeConversation ||
    (binding.runtimeInstanceId !== null && !runtimeInstance) ||
    !runtimeRecipe ||
    !workspaceState ||
    !workstream
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_binding_topology",
      `binding ${binding.id} references incomplete Session Fabric topology`,
    );
  }
  if (
    (nativeConversation.projectId !== null &&
      nativeConversation.projectId !== workstream.projectId) ||
    (runtimeInstance != null &&
      (runtimeInstance.hostId !== nativeConversation.hostId ||
        runtimeInstance.providerId !== nativeConversation.providerId ||
        runtimeInstance.providerInstanceId !==
          nativeConversation.providerInstanceId)) ||
    workspaceState.hostId !== nativeConversation.hostId ||
    (thread != null &&
      (thread.projectId !== workstream.projectId ||
        thread.providerId !== nativeConversation.providerId ||
        thread.environmentId !== binding.environmentId)) ||
    (environment != null &&
      (environment.projectId !== workstream.projectId ||
        environment.hostId !== nativeConversation.hostId))
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_binding_topology",
      `binding ${binding.id} crosses project, host, or provider boundaries`,
    );
  }
  return {
    binding,
    branch,
    environment: environment ?? null,
    nativeConversation,
    runtimeInstance: runtimeInstance ?? null,
    runtimeRecipe,
    thread: thread ?? null,
    workspaceState,
    workstream,
  };
}

export interface InitializeSessionModelEpochArgs {
  billingRouteId: string;
  bindingId: string;
  effectiveAccount: ProviderAccountRef | null;
  effectiveModel: SessionModelRef;
  reasoningLevel: ReasoningLevel;
  requestedModel: SessionModelRef;
  serviceTier: ServiceTier;
  startedAt?: number;
}

/**
 * Records epoch zero from observed runtime configuration. This is deliberately
 * separate from model-change settlement: an adopted or staged runtime already
 * exists, so it needs an initial authority record before ordinary ingress can
 * be enabled.
 */
export function initializeSessionModelEpoch(
  db: SessionFabricWriteConnection,
  args: InitializeSessionModelEpochArgs,
): SessionFabricModelEpochRow {
  const context = getSessionExecutionBindingContext(db, args.bindingId);
  const existing = db
    .select({ id: sessionFabricModelEpochs.id })
    .from(sessionFabricModelEpochs)
    .where(eq(sessionFabricModelEpochs.bindingId, args.bindingId))
    .get();
  if (
    !context ||
    existing ||
    args.requestedModel.providerId !== context.nativeConversation.providerId ||
    args.effectiveModel.providerId !== context.nativeConversation.providerId ||
    (args.effectiveAccount !== null &&
      args.effectiveAccount.providerInstanceId !==
        context.nativeConversation.providerInstanceId)
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_model_epoch",
      `binding ${args.bindingId} cannot open the requested initial model epoch`,
    );
  }
  return db
    .insert(sessionFabricModelEpochs)
    .values({
      billingRouteId: args.billingRouteId,
      bindingId: args.bindingId,
      effectiveAccount: args.effectiveAccount,
      effectiveModel: args.effectiveModel,
      endedAt: null,
      id: createSessionModelEpochId(),
      reasoningLevel: args.reasoningLevel,
      requestedModel: args.requestedModel,
      sequence: 0,
      serviceTier: args.serviceTier,
      startedAt: args.startedAt ?? Date.now(),
    })
    .returning()
    .get();
}

export interface SessionThreadExecutionAuthority {
  bindingId: string;
  effectiveModel: SessionModelRef;
  modelEpoch: SessionFabricModelEpochRow;
  providerId: string;
}

/**
 * Resolves the sole active execution authority for a thread. Any open but
 * incomplete/fenced Fabric topology fails closed instead of falling back to
 * mutable thread settings.
 */
export function getSessionThreadExecutionAuthority(
  db: DbQueryConnection,
  threadId: string,
): SessionThreadExecutionAuthority | null {
  const binding = db
    .select()
    .from(sessionFabricExecutionBindings)
    .where(
      and(
        eq(sessionFabricExecutionBindings.threadId, threadId),
        isNull(sessionFabricExecutionBindings.closedAt),
      ),
    )
    .get();
  if (!binding) {
    return null;
  }
  if (binding.mutationPolicy !== "enabled") {
    throw new SessionFabricPersistenceError(
      "binding_ingress_fenced",
      `thread ${threadId} binding ${binding.id} is staged read-only`,
    );
  }
  const context = getSessionExecutionBindingContext(db, binding.id);
  if (
    !context ||
    context.thread?.id !== threadId ||
    context.branch.status !== "active" ||
    context.branch.activeBindingId !== binding.id ||
    context.workstream.status !== "active" ||
    context.workstream.activeBranchId !== context.branch.id
  ) {
    throw new SessionFabricPersistenceError(
      "binding_not_active",
      `thread ${threadId} binding ${binding.id} is not the active Session Fabric authority`,
    );
  }
  const modelEpoch = getActiveSessionModelEpoch(db, binding.id);
  if (
    !modelEpoch ||
    modelEpoch.effectiveModel === null ||
    modelEpoch.requestedModel.providerId !== context.nativeConversation.providerId ||
    modelEpoch.effectiveModel.providerId !== context.nativeConversation.providerId ||
    modelEpoch.effectiveModel.providerId !== context.thread.providerId
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_model_epoch",
      `thread ${threadId} binding ${binding.id} has no valid active model epoch`,
    );
  }
  return {
    bindingId: binding.id,
    effectiveModel: modelEpoch.effectiveModel,
    modelEpoch,
    providerId: context.nativeConversation.providerId,
  };
}

export interface SessionAdoptionRequestIdentity {
  catalogConversationId: string;
  idempotencyKey: string;
  objective: string;
  threadId: string;
  title: string;
}

export interface SessionAdoptionRuntimeIncarnationEvidence {
  bootNonce: string;
  connectorId: string;
  endpointFingerprint: string;
  processKey: string;
  providerId: string;
  runtimeInstanceId: string;
  startedAt: number;
}

export interface SessionAdoptionRuntimeInspection {
  environmentId: string;
  execution: {
    effectiveModel: SessionModelRef;
    reasoningLevel: ReasoningLevel;
    serviceTier: ServiceTier;
  };
  incarnation: SessionAdoptionRuntimeIncarnationEvidence;
  ownership: RuntimeOwnership;
  phase: RuntimePhase;
  providerId: string;
  providerInstanceId: string;
  providerThreadId: string;
  runtimeRecipe: Omit<RuntimeRecipe, "id">;
  threadId: string;
  turnId: string | null;
  workspaceState: Omit<SessionWorkspaceState, "hostId" | "id">;
}

export interface PrepareSessionAdoptionArgs extends SessionAdoptionRequestIdentity {
  inspection: SessionAdoptionRuntimeInspection;
  preparedAt?: number;
}

export interface SessionAdoptionRuntimeControlState {
  bindingId: string;
  controlEpoch: number;
  environmentId: string;
  incarnation: SessionAdoptionRuntimeIncarnationEvidence;
  mutationPolicy: RuntimeMutationPolicy;
  nativeCursor: string | null;
  ownership: RuntimeOwnership;
  phase: RuntimePhase;
  providerInstanceId: string;
  threadId: string;
  turnId: string | null;
  workspaceId: string;
}

export interface SessionAdoptionContext {
  adoption: SessionFabricAdoptionRow;
  bindingContext: SessionExecutionBindingContext;
}

function hashSessionAdoptionRequest(
  args: SessionAdoptionRequestIdentity,
): string {
  const payload = JSON.stringify({
    catalogConversationId: args.catalogConversationId,
    objective: args.objective,
    threadId: args.threadId,
    title: args.title,
    version: "session-adoption-v1",
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function requireSessionAdoptionContext(
  db: DbQueryConnection,
  adoption: SessionFabricAdoptionRow,
): SessionAdoptionContext {
  const bindingContext = getSessionExecutionBindingContext(
    db,
    adoption.bindingId,
  );
  if (
    !bindingContext ||
    adoption.nativeConversationId !== bindingContext.nativeConversation.id ||
    adoption.threadId !== bindingContext.thread?.id ||
    adoption.environmentId !== bindingContext.environment?.id ||
    adoption.workstreamId !== bindingContext.workstream.id ||
    adoption.branchId !== bindingContext.branch.id
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_binding_topology",
      `adoption ${adoption.id} does not resolve to its recorded Session Fabric topology`,
    );
  }
  return { adoption, bindingContext };
}

function assertSessionAdoptionRequestMatches(
  adoption: SessionFabricAdoptionRow,
  args: SessionAdoptionRequestIdentity,
): void {
  if (
    adoption.requestHash !== hashSessionAdoptionRequest(args) ||
    adoption.nativeConversationId !== args.catalogConversationId ||
    adoption.threadId !== args.threadId
  ) {
    throw new SessionFabricPersistenceError(
      "adoption_idempotency_conflict",
      `idempotency key ${args.idempotencyKey} already belongs to another adoption request`,
    );
  }
}

export function getSessionAdoptionForRetry(
  db: DbQueryConnection,
  args: SessionAdoptionRequestIdentity,
): SessionAdoptionContext | null {
  const adoption = db
    .select()
    .from(sessionFabricAdoptions)
    .where(eq(sessionFabricAdoptions.idempotencyKey, args.idempotencyKey))
    .get();
  if (!adoption) {
    return null;
  }
  assertSessionAdoptionRequestMatches(adoption, args);
  return requireSessionAdoptionContext(db, adoption);
}

function assertIdleAdoptionInspection(
  args: PrepareSessionAdoptionArgs,
  nativeConversation: SessionFabricNativeConversationRow,
  thread: SessionFabricThreadRow,
  environment: SessionFabricEnvironmentRow,
): void {
  const inspection = args.inspection;
  const recipe = runtimeRecipeSchema.parse({
    ...inspection.runtimeRecipe,
    id: "inspection-runtime-recipe",
  });
  const workspace = sessionWorkspaceStateSchema.parse({
    ...inspection.workspaceState,
    hostId: nativeConversation.hostId,
    id: "inspection-workspace-state",
  });
  if (
    nativeConversation.projectId === null ||
    nativeConversation.projectId !== thread.projectId ||
    nativeConversation.projectId !== environment.projectId ||
    nativeConversation.hostId !== environment.hostId ||
    nativeConversation.providerId !== thread.providerId ||
    nativeConversation.providerId !== inspection.providerId ||
    nativeConversation.providerId !== inspection.incarnation.providerId ||
    nativeConversation.providerId !==
      inspection.execution.effectiveModel.providerId ||
    nativeConversation.providerInstanceId !== inspection.providerInstanceId ||
    nativeConversation.nativeConversationId !== inspection.providerThreadId ||
    thread.environmentId !== environment.id ||
    thread.id !== inspection.threadId ||
    environment.id !== inspection.environmentId ||
    environment.status !== "ready" ||
    thread.status !== "idle" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    inspection.ownership !== "owned_brokered" ||
    inspection.phase !== "idle" ||
    inspection.turnId !== null ||
    recipe.cwd !== workspace.rootPath ||
    !recipe.environmentReferenceIds.includes(environment.id) ||
    !recipe.workspaceWriteRoots.includes(workspace.rootPath) ||
    workspace.backgroundResources.length !== 0
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_binding_topology",
      "adoption inspection does not describe the idle thread, environment, provider-native conversation, and workspace exactly",
    );
  }
}

/**
 * Atomically reserves canonical lineage and a read-only attaching binding.
 * An identical idempotency retry returns the existing topology unchanged.
 */
export function prepareSessionAdoption(
  db: DbConnection,
  args: PrepareSessionAdoptionArgs,
): SessionAdoptionContext {
  const preparedAt = args.preparedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(sessionFabricAdoptions)
        .where(eq(sessionFabricAdoptions.idempotencyKey, args.idempotencyKey))
        .get();
      if (existing) {
        assertSessionAdoptionRequestMatches(existing, args);
        return requireSessionAdoptionContext(tx, existing);
      }

      const nativeConversation = tx
        .select()
        .from(sessionFabricNativeConversations)
        .where(
          eq(sessionFabricNativeConversations.id, args.catalogConversationId),
        )
        .get();
      const thread = tx
        .select()
        .from(threads)
        .where(eq(threads.id, args.threadId))
        .get();
      const environment =
        thread?.environmentId == null
          ? undefined
          : tx
              .select()
              .from(environments)
              .where(eq(environments.id, thread.environmentId))
              .get();
      if (!nativeConversation || !thread || !environment) {
        throw new SessionFabricPersistenceError(
          "invalid_binding_topology",
          "adoption requires a stored native conversation and an attached thread environment",
        );
      }
      assertIdleAdoptionInspection(
        args,
        nativeConversation,
        thread,
        environment,
      );
      const openBinding = tx
        .select({ id: sessionFabricExecutionBindings.id })
        .from(sessionFabricExecutionBindings)
        .where(
          and(
            eq(sessionFabricExecutionBindings.threadId, thread.id),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .get();
      if (openBinding) {
        throw new SessionFabricPersistenceError(
          "thread_already_bound",
          `thread ${thread.id} already has open binding ${openBinding.id}`,
        );
      }

      const incarnation = args.inspection.incarnation;
      const runtimeArgs: RecordSessionRuntimeInstanceArgs = {
        bootNonce: incarnation.bootNonce,
        connectorId: incarnation.connectorId,
        endpointFingerprint: incarnation.endpointFingerprint,
        hostId: nativeConversation.hostId,
        id: incarnation.runtimeInstanceId,
        processKey: incarnation.processKey,
        providerId: incarnation.providerId,
        providerInstanceId: nativeConversation.providerInstanceId,
        startedAt: incarnation.startedAt,
        status: "live",
        stoppedAt: null,
      };
      assertRuntimeInstanceDomain(runtimeArgs);
      const existingRuntime = tx
        .select()
        .from(sessionFabricRuntimeInstances)
        .where(eq(sessionFabricRuntimeInstances.id, runtimeArgs.id))
        .get();
      if (
        existingRuntime &&
        !sameRuntimeInstance(existingRuntime, runtimeArgs)
      ) {
        throw new SessionFabricPersistenceError(
          "runtime_incarnation_conflict",
          `runtime instance ${runtimeArgs.id} already names different incarnation evidence`,
        );
      }
      if (!existingRuntime) {
        tx.insert(sessionFabricRuntimeInstances)
          .values({
            ...runtimeArgs,
            createdAt: preparedAt,
            updatedAt: preparedAt,
          })
          .run();
      }

      const workstreamId = createSessionWorkstreamId();
      const branchId = createSessionBranchId();
      const bindingId = createSessionExecutionBindingId();
      const recipeId = createSessionRuntimeRecipeId();
      const workspaceStateId = createSessionWorkspaceStateId();
      const adoptionId = createSessionAdoptionId();
      tx.insert(sessionFabricWorkstreams)
        .values({
          id: workstreamId,
          projectId: nativeConversation.projectId!,
          title: args.title,
          objective: args.objective,
          status: "active",
          activeBranchId: null,
          createdAt: preparedAt,
          updatedAt: preparedAt,
        })
        .run();
      tx.insert(sessionFabricBranches)
        .values({
          id: branchId,
          workstreamId,
          parentBranchId: null,
          status: "active",
          activeBindingId: null,
          createdAt: preparedAt,
          updatedAt: preparedAt,
        })
        .run();
      createSessionRuntimeRecipe(tx, {
        ...args.inspection.runtimeRecipe,
        createdAt: preparedAt,
        id: recipeId,
      });
      recordSessionWorkspaceState(tx, {
        ...args.inspection.workspaceState,
        hostId: nativeConversation.hostId,
        id: workspaceStateId,
      });
      tx.insert(sessionFabricExecutionBindings)
        .values({
          id: bindingId,
          workstreamBranchId: branchId,
          threadId: thread.id,
          nativeConversationId: nativeConversation.id,
          runtimeInstanceId: runtimeArgs.id,
          runtimeRecipeId: recipeId,
          workspaceStateId,
          environmentId: environment.id,
          ownership: args.inspection.ownership,
          mutationPolicy: "staged_read_only",
          phase: "attaching",
          controlEpoch: 0,
          nativeCursor: null,
          providerTurnId: null,
          openedAt: preparedAt,
          closedAt: null,
          updatedAt: preparedAt,
        })
        .run();
      tx.update(sessionFabricBranches)
        .set({ activeBindingId: bindingId, updatedAt: preparedAt })
        .where(eq(sessionFabricBranches.id, branchId))
        .run();
      tx.update(sessionFabricWorkstreams)
        .set({ activeBranchId: branchId, updatedAt: preparedAt })
        .where(eq(sessionFabricWorkstreams.id, workstreamId))
        .run();
      initializeSessionModelEpoch(tx, {
        billingRouteId: `current-provider-instance:${nativeConversation.providerInstanceId}`,
        bindingId,
        effectiveAccount: null,
        effectiveModel: args.inspection.execution.effectiveModel,
        reasoningLevel: args.inspection.execution.reasoningLevel,
        requestedModel: args.inspection.execution.effectiveModel,
        serviceTier: args.inspection.execution.serviceTier,
        startedAt: preparedAt,
      });
      const adoption = tx
        .insert(sessionFabricAdoptions)
        .values({
          id: adoptionId,
          idempotencyKey: args.idempotencyKey,
          requestHash: hashSessionAdoptionRequest(args),
          nativeConversationId: nativeConversation.id,
          threadId: thread.id,
          environmentId: environment.id,
          workstreamId,
          branchId,
          bindingId,
          status: "prepared",
          createdAt: preparedAt,
          updatedAt: preparedAt,
        })
        .returning()
        .get();
      if (!adoption) {
        throw new Error("failed to prepare Session Fabric adoption");
      }
      return requireSessionAdoptionContext(tx, adoption);
    },
    { behavior: "immediate" },
  );
}

function assertAdoptionControlState(
  context: SessionAdoptionContext,
  control: SessionAdoptionRuntimeControlState,
  expected: {
    controlEpoch: number;
    mutationPolicy: RuntimeMutationPolicy;
  },
): void {
  const {
    binding,
    environment,
    nativeConversation,
    runtimeInstance,
    thread,
    workspaceState,
  } = context.bindingContext;
  const incarnation = control.incarnation;
  if (
    control.bindingId !== binding.id ||
    control.controlEpoch !== expected.controlEpoch ||
    control.environmentId !== environment?.id ||
    control.mutationPolicy !== expected.mutationPolicy ||
    control.nativeCursor !== binding.nativeCursor ||
    control.ownership !== binding.ownership ||
    control.phase !== "idle" ||
    control.providerInstanceId !== nativeConversation.providerInstanceId ||
    control.threadId !== thread?.id ||
    control.turnId !== null ||
    control.workspaceId !== workspaceState.rootPath ||
    runtimeInstance === null ||
    incarnation.runtimeInstanceId !== runtimeInstance.id ||
    incarnation.bootNonce !== runtimeInstance.bootNonce ||
    incarnation.connectorId !== runtimeInstance.connectorId ||
    incarnation.endpointFingerprint !== runtimeInstance.endpointFingerprint ||
    incarnation.processKey !== runtimeInstance.processKey ||
    incarnation.providerId !== runtimeInstance.providerId ||
    incarnation.startedAt !== runtimeInstance.startedAt
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_binding_topology",
      `host control evidence does not match prepared adoption ${context.adoption.id}`,
    );
  }
}

export function finalizePreparedSessionAdoption(
  db: DbConnection,
  args: {
    adoptionId: string;
    control: SessionAdoptionRuntimeControlState;
    finalizedAt?: number;
  },
): SessionAdoptionContext {
  const finalizedAt = args.finalizedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const adoption = tx
        .select()
        .from(sessionFabricAdoptions)
        .where(eq(sessionFabricAdoptions.id, args.adoptionId))
        .get();
      if (!adoption) {
        throw new SessionFabricPersistenceError(
          "adoption_not_found",
          `Session Fabric adoption not found: ${args.adoptionId}`,
        );
      }
      const context = requireSessionAdoptionContext(tx, adoption);
      assertAdoptionControlState(context, args.control, {
        controlEpoch: 0,
        mutationPolicy: "staged_read_only",
      });
      if (adoption.status === "host_bound") {
        if (
          context.bindingContext.binding.phase !== "idle" ||
          context.bindingContext.binding.mutationPolicy !== "staged_read_only"
        ) {
          throw new SessionFabricPersistenceError(
            "adoption_status_changed",
            `adoption ${adoption.id} host-bound status conflicts with binding state`,
          );
        }
        return context;
      }
      if (
        adoption.status !== "prepared" ||
        context.bindingContext.binding.phase !== "attaching" ||
        context.bindingContext.binding.controlEpoch !== 0 ||
        context.bindingContext.binding.mutationPolicy !== "staged_read_only"
      ) {
        throw new SessionFabricPersistenceError(
          "adoption_status_changed",
          `adoption ${adoption.id} cannot finalize host binding from ${adoption.status}`,
        );
      }
      const binding = tx
        .update(sessionFabricExecutionBindings)
        .set({
          nativeCursor: args.control.nativeCursor,
          phase: args.control.phase,
          providerTurnId: args.control.turnId,
          updatedAt: finalizedAt,
        })
        .where(
          and(
            eq(sessionFabricExecutionBindings.id, adoption.bindingId),
            eq(sessionFabricExecutionBindings.controlEpoch, 0),
            eq(
              sessionFabricExecutionBindings.mutationPolicy,
              "staged_read_only",
            ),
            eq(sessionFabricExecutionBindings.phase, "attaching"),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      const updatedAdoption = tx
        .update(sessionFabricAdoptions)
        .set({ status: "host_bound", updatedAt: finalizedAt })
        .where(
          and(
            eq(sessionFabricAdoptions.id, adoption.id),
            eq(sessionFabricAdoptions.status, "prepared"),
          ),
        )
        .returning()
        .get();
      if (!binding || !updatedAdoption) {
        throw new SessionFabricPersistenceError(
          "adoption_status_changed",
          `adoption ${adoption.id} changed while finalizing host binding`,
        );
      }
      return requireSessionAdoptionContext(tx, updatedAdoption);
    },
    { behavior: "immediate" },
  );
}

export function enablePreparedSessionAdoption(
  db: DbConnection,
  args: {
    adoptionId: string;
    control: SessionAdoptionRuntimeControlState;
    enabledAt?: number;
  },
): SessionAdoptionContext {
  const enabledAt = args.enabledAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const adoption = tx
        .select()
        .from(sessionFabricAdoptions)
        .where(eq(sessionFabricAdoptions.id, args.adoptionId))
        .get();
      if (!adoption) {
        throw new SessionFabricPersistenceError(
          "adoption_not_found",
          `Session Fabric adoption not found: ${args.adoptionId}`,
        );
      }
      const context = requireSessionAdoptionContext(tx, adoption);
      assertAdoptionControlState(context, args.control, {
        controlEpoch: 1,
        mutationPolicy: "enabled",
      });
      if (adoption.status === "enabled") {
        if (
          context.bindingContext.binding.controlEpoch !== 1 ||
          context.bindingContext.binding.mutationPolicy !== "enabled" ||
          context.bindingContext.binding.phase !== "idle"
        ) {
          throw new SessionFabricPersistenceError(
            "adoption_status_changed",
            `adoption ${adoption.id} enabled status conflicts with binding state`,
          );
        }
        return context;
      }
      if (
        adoption.status !== "host_bound" ||
        context.bindingContext.binding.controlEpoch !== 0 ||
        context.bindingContext.binding.mutationPolicy !== "staged_read_only" ||
        context.bindingContext.binding.phase !== "idle"
      ) {
        throw new SessionFabricPersistenceError(
          "adoption_status_changed",
          `adoption ${adoption.id} cannot enable mutation from ${adoption.status}`,
        );
      }
      const binding = tx
        .update(sessionFabricExecutionBindings)
        .set({
          controlEpoch: args.control.controlEpoch,
          mutationPolicy: args.control.mutationPolicy,
          nativeCursor: args.control.nativeCursor,
          phase: args.control.phase,
          providerTurnId: args.control.turnId,
          updatedAt: enabledAt,
        })
        .where(
          and(
            eq(sessionFabricExecutionBindings.id, adoption.bindingId),
            eq(sessionFabricExecutionBindings.controlEpoch, 0),
            eq(
              sessionFabricExecutionBindings.mutationPolicy,
              "staged_read_only",
            ),
            eq(sessionFabricExecutionBindings.phase, "idle"),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      const updatedAdoption = tx
        .update(sessionFabricAdoptions)
        .set({ status: "enabled", updatedAt: enabledAt })
        .where(
          and(
            eq(sessionFabricAdoptions.id, adoption.id),
            eq(sessionFabricAdoptions.status, "host_bound"),
          ),
        )
        .returning()
        .get();
      if (!binding || !updatedAdoption) {
        throw new SessionFabricPersistenceError(
          "adoption_status_changed",
          `adoption ${adoption.id} changed while enabling mutation`,
        );
      }
      return requireSessionAdoptionContext(tx, updatedAdoption);
    },
    { behavior: "immediate" },
  );
}

export interface SessionThreadIngressExecution {
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier;
}

const sessionCommandIngressBlockingStatuses = [
  "drafted",
  "authorized",
  "dispatched",
  "accepted",
  "running",
  "outcome_unknown",
] as const;

function assertSessionBindingHasCertainExecutionState(
  db: DbQueryConnection,
  bindingId: string,
): void {
  const blockingCommand = db
    .select({
      id: sessionFabricCommands.id,
      status: sessionFabricCommands.status,
    })
    .from(sessionFabricCommands)
    .where(
      and(
        eq(sessionFabricCommands.bindingId, bindingId),
        inArray(
          sessionFabricCommands.status,
          [...sessionCommandIngressBlockingStatuses],
        ),
      ),
    )
    .orderBy(desc(sessionFabricCommands.createdAt))
    .get();
  if (!blockingCommand) {
    return;
  }
  if (blockingCommand.status === "outcome_unknown") {
    throw new SessionFabricPersistenceError(
      "binding_execution_uncertain",
      `binding ${bindingId} has unresolved command ${blockingCommand.id} with an unknown provider outcome`,
    );
  }
  throw new SessionFabricPersistenceError(
    "binding_command_in_flight",
    `binding ${bindingId} has in-flight command ${blockingCommand.id} in status ${blockingCommand.status}`,
  );
}

/** Same-transaction server fence and model-epoch CAS for ordinary ingress. */
export function assertSessionThreadIngressAllowed(
  db: DbQueryConnection,
  threadId: string,
  execution?: SessionThreadIngressExecution,
): void {
  const authority = getSessionThreadExecutionAuthority(db, threadId);
  if (!authority || execution === undefined) {
    return;
  }
  assertSessionBindingHasCertainExecutionState(db, authority.bindingId);
  const epoch = authority.modelEpoch;
  if (
    epoch.effectiveModel?.modelId !== execution.model ||
    epoch.reasoningLevel !== execution.reasoningLevel ||
    epoch.serviceTier !== execution.serviceTier
  ) {
    throw new SessionFabricPersistenceError(
      "binding_execution_epoch_changed",
      `thread ${threadId} model epoch changed before the turn was queued`,
    );
  }
}

export interface CompareAndSwapActiveSessionBindingArgs {
  branchId: string;
  expectedBindingId: string | null;
  nextBindingId: string;
  updatedAt?: number;
}

/** The only writer for a branch's active execution binding. */
export function compareAndSwapActiveSessionBinding(
  db: DbConnection,
  args: CompareAndSwapActiveSessionBindingArgs,
): SessionFabricBranchRow {
  const updatedAt = args.updatedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const next = tx
        .select()
        .from(sessionFabricExecutionBindings)
        .where(eq(sessionFabricExecutionBindings.id, args.nextBindingId))
        .get();
      if (
        !next ||
        next.workstreamBranchId !== args.branchId ||
        next.closedAt !== null
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_binding_topology",
          `binding ${args.nextBindingId} is not an open member of branch ${args.branchId}`,
        );
      }
      const activePredicate =
        args.expectedBindingId === null
          ? isNull(sessionFabricBranches.activeBindingId)
          : eq(sessionFabricBranches.activeBindingId, args.expectedBindingId);
      const branch = tx
        .update(sessionFabricBranches)
        .set({ activeBindingId: args.nextBindingId, updatedAt })
        .where(
          and(eq(sessionFabricBranches.id, args.branchId), activePredicate),
        )
        .returning()
        .get();
      if (!branch) {
        throw new SessionFabricPersistenceError(
          "active_binding_changed",
          `active binding for branch ${args.branchId} changed before compare-and-swap`,
        );
      }
      return branch;
    },
    { behavior: "immediate" },
  );
}

export interface DraftSessionCommandArgs {
  billingAuthorizationId: string | null;
  bindingId: string;
  kind: SessionCommandKind;
  payloadHash: string;
  createdAt?: number;
  id?: string;
}

/**
 * Drafts command intent from server-owned state. Callers cannot supply runtime,
 * cursor, phase, or epoch guard fields, so stale authorization is not forgeable.
 */
export function draftSessionCommand(
  db: DbConnection,
  args: DraftSessionCommandArgs,
): SessionCommand {
  const id = args.id ?? createSessionCommandId();
  const createdAt = args.createdAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const binding = tx
        .select()
        .from(sessionFabricExecutionBindings)
        .where(eq(sessionFabricExecutionBindings.id, args.bindingId))
        .get();
      if (!binding) {
        throw new SessionFabricPersistenceError(
          "binding_not_found",
          `Session Fabric binding not found: ${args.bindingId}`,
        );
      }
      const branch = tx
        .select()
        .from(sessionFabricBranches)
        .where(eq(sessionFabricBranches.id, binding.workstreamBranchId))
        .get();
      if (branch?.activeBindingId !== binding.id || binding.closedAt !== null) {
        throw new SessionFabricPersistenceError(
          "binding_not_active",
          `binding ${binding.id} is not the active open binding`,
        );
      }
      assertSessionBindingHasCertainExecutionState(tx, binding.id);
      if (args.kind === "change_model") {
        const thread =
          binding.threadId === null
            ? null
            : tx
                .select({ status: threads.status })
                .from(threads)
                .where(eq(threads.id, binding.threadId))
                .get();
        if (
          binding.phase !== "idle" ||
          binding.providerTurnId !== null ||
          thread?.status !== "idle"
        ) {
          throw new SessionFabricPersistenceError(
            "binding_not_idle",
            `binding ${binding.id} must be idle before a model-change command can be drafted`,
          );
        }
      }
      if (binding.runtimeInstanceId === null) {
        throw new SessionFabricPersistenceError(
          "invalid_binding_topology",
          `binding ${binding.id} has no live runtime instance`,
        );
      }
      const runtime = tx
        .select()
        .from(sessionFabricRuntimeInstances)
        .where(eq(sessionFabricRuntimeInstances.id, binding.runtimeInstanceId))
        .get();
      const nativeConversation = tx
        .select()
        .from(sessionFabricNativeConversations)
        .where(
          eq(sessionFabricNativeConversations.id, binding.nativeConversationId),
        )
        .get();
      if (!runtime || runtime.status !== "live" || !nativeConversation) {
        throw new SessionFabricPersistenceError(
          "invalid_binding_topology",
          `binding ${binding.id} does not resolve to a live runtime/native conversation`,
        );
      }
      const command = sessionCommandSchema.parse({
        bindingId: binding.id,
        createdAt,
        guard: {
          billingAuthorizationId: args.billingAuthorizationId,
          commandId: id,
          expectedBootNonce: runtime.bootNonce,
          expectedControlEpoch: binding.controlEpoch,
          expectedEndpointFingerprint: runtime.endpointFingerprint,
          expectedNativeCursor: binding.nativeCursor,
          expectedPhase: binding.phase,
          expectedProviderInstanceId: nativeConversation.providerInstanceId,
          expectedRuntimeInstanceId: runtime.id,
          expectedTurnId: binding.providerTurnId,
        },
        id,
        kind: args.kind,
        modelEpochId: null,
        payloadHash: args.payloadHash,
        status: "drafted",
        updatedAt: createdAt,
      });
      tx.insert(sessionFabricCommands)
        .values({ ...command, receipt: null })
        .run();
      return command;
    },
    { behavior: "immediate" },
  );
}

export type ApplySessionCommandEventNoopReason =
  | "not_found"
  | "illegal_transition"
  | "cas_conflict";

export type ApplySessionCommandEventOutcome =
  | {
      applied: true;
      command: SessionCommand;
      event: SessionFabricCommandEventRow;
    }
  | {
      applied: false;
      detail: string;
      reason: ApplySessionCommandEventNoopReason;
    };

export interface ApplySessionCommandEventArgs {
  commandId: string;
  event: SessionCommandLifecycleEvent;
  occurredAt?: number;
}

function applySessionCommandEventRecord(
  db: SessionFabricWriteConnection,
  args: ApplySessionCommandEventArgs,
): ApplySessionCommandEventOutcome {
  const commandRow = db
    .select()
    .from(sessionFabricCommands)
    .where(eq(sessionFabricCommands.id, args.commandId))
    .get();
  if (!commandRow) {
    return {
      applied: false,
      detail: `Session Fabric command not found: ${args.commandId}`,
      reason: "not_found",
    };
  }
  const evaluation = evaluateSessionCommandLifecycle({
    event: args.event,
    status: commandRow.status,
  });
  if ("noop" in evaluation) {
    return {
      applied: false,
      detail: evaluation.detail,
      reason: "illegal_transition",
    };
  }
  const occurredAt = args.occurredAt ?? Date.now();
  const updated = db
    .update(sessionFabricCommands)
    .set({ status: evaluation.to, updatedAt: occurredAt })
    .where(
      and(
        eq(sessionFabricCommands.id, commandRow.id),
        eq(sessionFabricCommands.status, commandRow.status),
      ),
    )
    .returning()
    .get();
  if (!updated) {
    return {
      applied: false,
      detail: `command ${commandRow.id} changed from ${commandRow.status} while applying ${args.event}`,
      reason: "cas_conflict",
    };
  }
  const latestEvent = db
    .select({ sequence: max(sessionFabricCommandEvents.sequence) })
    .from(sessionFabricCommandEvents)
    .where(eq(sessionFabricCommandEvents.commandId, commandRow.id))
    .get();
  const event = db
    .insert(sessionFabricCommandEvents)
    .values({
      id: createSessionCommandEventId(),
      commandId: commandRow.id,
      sequence: (latestEvent?.sequence ?? -1) + 1,
      event: args.event,
      fromStatus: commandRow.status,
      toStatus: evaluation.to,
      occurredAt,
    })
    .returning()
    .get();
  return { applied: true, command: toSessionCommand(updated), event };
}

export function applySessionCommandEvent(
  db: DbConnection,
  args: ApplySessionCommandEventArgs,
): ApplySessionCommandEventOutcome {
  return db.transaction((tx) => applySessionCommandEventRecord(tx, args), {
    behavior: "immediate",
  });
}

function requireAppliedCommandEvent(
  outcome: ApplySessionCommandEventOutcome,
): SessionCommand {
  if (!outcome.applied) {
    const code =
      outcome.reason === "illegal_transition"
        ? "illegal_command_transition"
        : outcome.reason === "cas_conflict"
          ? "command_status_changed"
          : "command_not_found";
    throw new SessionFabricPersistenceError(code, outcome.detail);
  }
  return outcome.command;
}

export interface RecordSessionMutationReceiptArgs {
  commandId: string;
  receipt: MutationReceipt;
  occurredAt?: number;
}

/** Records provider acceptance classification exactly once and advances audit state. */
export function recordSessionMutationReceipt(
  db: DbConnection,
  args: RecordSessionMutationReceiptArgs,
): SessionCommand {
  const receipt = mutationReceiptSchema.parse(args.receipt);
  return db.transaction(
    (tx) => {
      const event: SessionCommandLifecycleEvent =
        receipt.acceptance === "accepted"
          ? "accept"
          : receipt.acceptance === "not_accepted"
            ? "reject_before_acceptance"
            : "lose_outcome";
      const command = requireAppliedCommandEvent(
        applySessionCommandEventRecord(tx, {
          commandId: args.commandId,
          event,
          occurredAt: args.occurredAt,
        }),
      );
      const updated = tx
        .update(sessionFabricCommands)
        .set({ receipt, updatedAt: command.updatedAt })
        .where(
          and(
            eq(sessionFabricCommands.id, command.id),
            isNull(sessionFabricCommands.receipt),
          ),
        )
        .returning()
        .get();
      if (!updated) {
        throw new SessionFabricPersistenceError(
          "command_status_changed",
          `command ${command.id} already has a mutation receipt`,
        );
      }
      return toSessionCommand(updated);
    },
    { behavior: "immediate" },
  );
}

export interface SettleSessionModelChangeArgs extends RecordSessionMutationReceiptArgs {
  billingRouteId: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier;
}

export interface SettleSessionModelChangeResult {
  command: SessionCommand;
  modelEpoch: SessionFabricModelEpochRow | null;
}

function sameMutationReceipt(
  left: MutationReceipt,
  right: MutationReceipt,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getSettledModelChange(
  db: SessionFabricWriteConnection,
  row: SessionFabricCommandRow,
  args: SettleSessionModelChangeArgs,
  receipt: MutationReceipt,
): SettleSessionModelChangeResult {
  const existingReceipt = mutationReceiptSchema.parse(row.receipt);
  const expectedStatus =
    receipt.acceptance === "accepted"
      ? "succeeded"
      : receipt.acceptance === "not_accepted"
        ? "not_accepted"
        : "outcome_unknown";
  if (
    !sameMutationReceipt(existingReceipt, receipt) ||
    row.status !== expectedStatus
  ) {
    throw new SessionFabricPersistenceError(
      "command_status_changed",
      `command ${row.id} was already settled with a different outcome`,
    );
  }
  const modelEpoch =
    row.modelEpochId === null
      ? null
      : (db
          .select()
          .from(sessionFabricModelEpochs)
          .where(eq(sessionFabricModelEpochs.id, row.modelEpochId))
          .get() ?? null);
  if (
    receipt.acceptance === "accepted" &&
    (!modelEpoch ||
      modelEpoch.billingRouteId !== args.billingRouteId ||
      modelEpoch.reasoningLevel !== args.reasoningLevel ||
      modelEpoch.serviceTier !== args.serviceTier)
  ) {
    throw new SessionFabricPersistenceError(
      "command_status_changed",
      `command ${row.id} was already settled with different model epoch metadata`,
    );
  }
  if (receipt.acceptance !== "accepted" && modelEpoch !== null) {
    throw new SessionFabricPersistenceError(
      "invalid_model_change_receipt",
      `non-accepted command ${row.id} unexpectedly references a model epoch`,
    );
  }
  return { command: toSessionCommand(row), modelEpoch };
}

/**
 * Acknowledged model changes atomically close the previous epoch, open the
 * observed effective epoch, and mark the command succeeded. Ambiguous or
 * rejected receipts never alter model history.
 */
export function settleSessionModelChange(
  db: DbConnection,
  args: SettleSessionModelChangeArgs,
): SettleSessionModelChangeResult {
  const receipt = mutationReceiptSchema.parse(args.receipt);
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(sessionFabricCommands)
        .where(eq(sessionFabricCommands.id, args.commandId))
        .get();
      if (!row) {
        throw new SessionFabricPersistenceError(
          "command_not_found",
          `Session Fabric command not found: ${args.commandId}`,
        );
      }
      if (row.kind !== "change_model") {
        throw new SessionFabricPersistenceError(
          "invalid_model_change_receipt",
          `command ${row.id} is ${row.kind}, not change_model`,
        );
      }
      if (row.receipt !== null) {
        return getSettledModelChange(tx, row, args, receipt);
      }
      const requestedModel = receipt.requestedModel;
      const effectiveModel = receipt.effectiveModel;
      if (
        receipt.acceptance === "accepted" &&
        (requestedModel === null || effectiveModel === null)
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_model_change_receipt",
          "accepted model change must identify requested and effective models",
        );
      }
      const event: SessionCommandLifecycleEvent =
        receipt.acceptance === "accepted"
          ? "accept"
          : receipt.acceptance === "not_accepted"
            ? "reject_before_acceptance"
            : "lose_outcome";
      let command = requireAppliedCommandEvent(
        applySessionCommandEventRecord(tx, {
          commandId: args.commandId,
          event,
          occurredAt: args.occurredAt,
        }),
      );
      const receiptRow = tx
        .update(sessionFabricCommands)
        .set({ receipt, updatedAt: command.updatedAt })
        .where(
          and(
            eq(sessionFabricCommands.id, command.id),
            isNull(sessionFabricCommands.receipt),
          ),
        )
        .returning()
        .get();
      if (!receiptRow) {
        throw new SessionFabricPersistenceError(
          "command_status_changed",
          `command ${command.id} already has a mutation receipt`,
        );
      }
      if (receipt.acceptance !== "accepted") {
        return { command: toSessionCommand(receiptRow), modelEpoch: null };
      }
      if (requestedModel === null || effectiveModel === null) {
        throw new SessionFabricPersistenceError(
          "invalid_model_change_receipt",
          "accepted model change lost required model evidence",
        );
      }
      const occurredAt = args.occurredAt ?? Date.now();
      const activeEpoch = tx
        .select()
        .from(sessionFabricModelEpochs)
        .where(
          and(
            eq(sessionFabricModelEpochs.bindingId, row.bindingId),
            isNull(sessionFabricModelEpochs.endedAt),
          ),
        )
        .get();
      if (activeEpoch) {
        tx.update(sessionFabricModelEpochs)
          .set({ endedAt: occurredAt })
          .where(
            and(
              eq(sessionFabricModelEpochs.id, activeEpoch.id),
              isNull(sessionFabricModelEpochs.endedAt),
            ),
          )
          .run();
      }
      const latest = tx
        .select({ sequence: max(sessionFabricModelEpochs.sequence) })
        .from(sessionFabricModelEpochs)
        .where(eq(sessionFabricModelEpochs.bindingId, row.bindingId))
        .get();
      const modelEpoch = tx
        .insert(sessionFabricModelEpochs)
        .values({
          id: createSessionModelEpochId(),
          bindingId: row.bindingId,
          sequence: (latest?.sequence ?? -1) + 1,
          requestedModel,
          effectiveModel,
          effectiveAccount: receipt.effectiveAccount,
          billingRouteId: args.billingRouteId,
          reasoningLevel: args.reasoningLevel,
          serviceTier: args.serviceTier,
          startedAt: occurredAt,
          endedAt: null,
        })
        .returning()
        .get();
      const linkedCommand = tx
        .update(sessionFabricCommands)
        .set({ modelEpochId: modelEpoch.id, updatedAt: occurredAt })
        .where(
          and(
            eq(sessionFabricCommands.id, row.id),
            eq(sessionFabricCommands.status, "accepted"),
            isNull(sessionFabricCommands.modelEpochId),
          ),
        )
        .returning()
        .get();
      if (!linkedCommand) {
        throw new SessionFabricPersistenceError(
          "command_status_changed",
          `command ${row.id} changed while linking its model epoch`,
        );
      }
      command = requireAppliedCommandEvent(
        applySessionCommandEventRecord(tx, {
          commandId: row.id,
          event: "succeed",
          occurredAt,
        }),
      );
      return { command, modelEpoch };
    },
    { behavior: "immediate" },
  );
}

export function getSessionCommand(
  db: DbQueryConnection,
  commandId: string,
): SessionCommand | null {
  const row = db
    .select()
    .from(sessionFabricCommands)
    .where(eq(sessionFabricCommands.id, commandId))
    .get();
  return row ? toSessionCommand(row) : null;
}

export interface SessionCommandAudit {
  command: SessionCommand;
  events: SessionFabricCommandEventRow[];
  modelEpoch: SessionFabricModelEpochRow | null;
  receipt: MutationReceipt | null;
}

/** Returns the durable command, receipt, event history, and resulting epoch. */
export function getSessionCommandAudit(
  db: DbQueryConnection,
  commandId: string,
): SessionCommandAudit | null {
  const row = db
    .select()
    .from(sessionFabricCommands)
    .where(eq(sessionFabricCommands.id, commandId))
    .get();
  if (!row) {
    return null;
  }
  const modelEpoch =
    row.modelEpochId === null
      ? null
      : (db
          .select()
          .from(sessionFabricModelEpochs)
          .where(eq(sessionFabricModelEpochs.id, row.modelEpochId))
          .get() ?? null);
  return {
    command: toSessionCommand(row),
    events: listSessionCommandEvents(db, commandId),
    modelEpoch,
    receipt:
      row.receipt === null ? null : mutationReceiptSchema.parse(row.receipt),
  };
}

export function listSessionCommandEvents(
  db: DbQueryConnection,
  commandId: string,
): SessionFabricCommandEventRow[] {
  return db
    .select()
    .from(sessionFabricCommandEvents)
    .where(eq(sessionFabricCommandEvents.commandId, commandId))
    .orderBy(sessionFabricCommandEvents.sequence)
    .all();
}

export function getActiveSessionModelEpoch(
  db: DbQueryConnection,
  bindingId: string,
): SessionFabricModelEpochRow | null {
  return (
    db
      .select()
      .from(sessionFabricModelEpochs)
      .where(
        and(
          eq(sessionFabricModelEpochs.bindingId, bindingId),
          isNull(sessionFabricModelEpochs.endedAt),
        ),
      )
      .orderBy(desc(sessionFabricModelEpochs.sequence))
      .get() ?? null
  );
}

export interface SessionRuntimeRecoveryControlState
  extends SessionAdoptionRuntimeControlState {
  executionSafety: "handoff_restatement" | "standard";
  handoffCheckpoint:
    | "destination_restated"
    | "destination_staged"
    | "not_applicable"
    | "source_fenced";
  handoffRole: "destination" | "source" | null;
  handoffTransitionId: string | null;
}

export interface SessionRuntimeRecoveryInspection
  extends SessionAdoptionRuntimeInspection {
  executionSafety: "handoff_restatement" | "standard";
}

export interface RecoverSessionExecutionBindingArgs {
  bindingId: string;
  control: SessionRuntimeRecoveryControlState;
  expectedControlEpoch: number;
  expectedRuntimeInstanceId: string;
  inspection: SessionRuntimeRecoveryInspection;
  recoveredAt?: number;
}

function sameRuntimeRecipeEvidence(
  row: SessionFabricRuntimeRecipeRow,
  recipe: Omit<RuntimeRecipe, "id">,
): boolean {
  return (
    row.cwd === recipe.cwd &&
    row.environmentFingerprint === recipe.environmentFingerprint &&
    JSON.stringify(row.environmentReferenceIds) ===
      JSON.stringify(recipe.environmentReferenceIds) &&
    row.mcpServersFingerprint === recipe.mcpServersFingerprint &&
    row.permissionMode === recipe.permissionMode &&
    row.pluginsFingerprint === recipe.pluginsFingerprint &&
    row.sandboxProfile === recipe.sandboxProfile &&
    row.toolsFingerprint === recipe.toolsFingerprint &&
    JSON.stringify(row.workspaceWriteRoots) ===
      JSON.stringify(recipe.workspaceWriteRoots)
  );
}

function sameWorkspaceDigestEvidence(
  row: SessionFabricWorkspaceStateRow,
  workspace: Omit<SessionWorkspaceState, "hostId" | "id">,
): boolean {
  return (
    row.diffDigest === workspace.diffDigest &&
    row.digestAlgorithm === workspace.digestAlgorithm &&
    row.headSha === workspace.headSha &&
    row.indexDigest === workspace.indexDigest &&
    row.rootPath === workspace.rootPath &&
    row.untrackedManifestDigest === workspace.untrackedManifestDigest &&
    row.worktreeId === workspace.worktreeId
  );
}

/**
 * Atomically reconciles a host-proven idle provider restart into the durable
 * execution authority. The old incarnation is marked lost, the equivalent new
 * incarnation and workspace checkpoint are recorded, and the binding epoch is
 * advanced exactly once. Identical lost-response retries return the committed
 * authority; every mismatched replay fails closed.
 */
export function recoverSessionExecutionBinding(
  db: DbConnection,
  args: RecoverSessionExecutionBindingArgs,
): SessionExecutionBindingContext {
  const recoveredAt = args.recoveredAt ?? Date.now();
  if (args.control.controlEpoch !== args.expectedControlEpoch + 1) {
    throw new SessionFabricPersistenceError(
      "runtime_recovery_conflict",
      "runtime recovery must advance the binding control epoch exactly once",
    );
  }
  return db.transaction(
    (tx) => {
      const context = getSessionExecutionBindingContext(tx, args.bindingId);
      const { control, inspection } = args;
      if (
        !context ||
        context.binding.closedAt !== null ||
        context.binding.id !== control.bindingId ||
        context.binding.environmentId !== control.environmentId ||
        context.binding.threadId !== control.threadId ||
        context.binding.nativeCursor !== control.nativeCursor ||
        context.binding.mutationPolicy !== control.mutationPolicy ||
        context.binding.ownership !== control.ownership ||
        control.phase !== "idle" ||
        control.turnId !== null ||
        control.providerInstanceId !==
          context.nativeConversation.providerInstanceId ||
        control.workspaceId !== inspection.workspaceState.rootPath ||
        inspection.environmentId !== control.environmentId ||
        inspection.executionSafety !== control.executionSafety ||
        inspection.ownership !== control.ownership ||
        inspection.phase !== "idle" ||
        inspection.providerId !== context.nativeConversation.providerId ||
        inspection.providerInstanceId !== control.providerInstanceId ||
        inspection.providerThreadId !==
          context.nativeConversation.nativeConversationId ||
        inspection.threadId !== control.threadId ||
        inspection.turnId !== null ||
        !sameIncarnationEvidence(control.incarnation, inspection.incarnation) ||
        !sameRuntimeRecipeEvidence(context.runtimeRecipe, inspection.runtimeRecipe) ||
        !sameWorkspaceDigestEvidence(
          context.workspaceState,
          inspection.workspaceState,
        ) ||
        inspection.workspaceState.backgroundResources.some(
          (resource) => resource.status !== "settled",
        )
      ) {
        throw new SessionFabricPersistenceError(
          "runtime_recovery_conflict",
          `runtime recovery evidence does not match binding ${args.bindingId}`,
        );
      }
      const activeModelEpoch = getActiveSessionModelEpoch(tx, args.bindingId);
      if (
        !activeModelEpoch ||
        activeModelEpoch.effectiveModel === null ||
        !sameSessionModel(
          activeModelEpoch.effectiveModel,
          inspection.execution.effectiveModel,
        ) ||
        activeModelEpoch.reasoningLevel !== inspection.execution.reasoningLevel ||
        activeModelEpoch.serviceTier !== inspection.execution.serviceTier
      ) {
        throw new SessionFabricPersistenceError(
          "runtime_recovery_conflict",
          `runtime recovery changed the active execution epoch for binding ${args.bindingId}`,
        );
      }

      const recoveredRuntimeArgs: RecordSessionRuntimeInstanceArgs = {
        bootNonce: inspection.incarnation.bootNonce,
        connectorId: inspection.incarnation.connectorId,
        endpointFingerprint: inspection.incarnation.endpointFingerprint,
        hostId: context.nativeConversation.hostId,
        id: inspection.incarnation.runtimeInstanceId,
        processKey: inspection.incarnation.processKey,
        providerId: inspection.incarnation.providerId,
        providerInstanceId: inspection.providerInstanceId,
        startedAt: inspection.incarnation.startedAt,
        status: "live",
        stoppedAt: null,
      };
      assertRuntimeInstanceDomain(recoveredRuntimeArgs);

      if (
        context.binding.controlEpoch === args.expectedControlEpoch + 1 &&
        context.binding.runtimeInstanceId === recoveredRuntimeArgs.id &&
        context.runtimeInstance !== null &&
        sameRuntimeInstance(context.runtimeInstance, recoveredRuntimeArgs)
      ) {
        const previousRuntime = tx
          .select()
          .from(sessionFabricRuntimeInstances)
          .where(
            eq(
              sessionFabricRuntimeInstances.id,
              args.expectedRuntimeInstanceId,
            ),
          )
          .get();
        if (previousRuntime?.status !== "lost") {
          throw new SessionFabricPersistenceError(
            "runtime_recovery_conflict",
            `recovered binding ${args.bindingId} has no matching lost predecessor`,
          );
        }
        return context;
      }

      const previousRuntime = context.runtimeInstance;
      if (
        context.binding.controlEpoch !== args.expectedControlEpoch ||
        context.binding.runtimeInstanceId !== args.expectedRuntimeInstanceId ||
        previousRuntime === null ||
        previousRuntime.id !== args.expectedRuntimeInstanceId ||
        previousRuntime.status !== "live" ||
        previousRuntime.providerId !== recoveredRuntimeArgs.providerId ||
        previousRuntime.providerInstanceId !==
          recoveredRuntimeArgs.providerInstanceId ||
        previousRuntime.connectorId !== recoveredRuntimeArgs.connectorId ||
        previousRuntime.processKey !== recoveredRuntimeArgs.processKey ||
        previousRuntime.id === recoveredRuntimeArgs.id ||
        (previousRuntime.bootNonce === recoveredRuntimeArgs.bootNonce &&
          previousRuntime.endpointFingerprint ===
            recoveredRuntimeArgs.endpointFingerprint)
      ) {
        throw new SessionFabricPersistenceError(
          "runtime_recovery_conflict",
          `binding ${args.bindingId} is not at the exact recoverable incarnation`,
        );
      }

      const existingRecoveredRuntime = tx
        .select()
        .from(sessionFabricRuntimeInstances)
        .where(eq(sessionFabricRuntimeInstances.id, recoveredRuntimeArgs.id))
        .get();
      if (
        existingRecoveredRuntime &&
        !sameRuntimeInstance(existingRecoveredRuntime, recoveredRuntimeArgs)
      ) {
        throw new SessionFabricPersistenceError(
          "runtime_incarnation_conflict",
          `runtime instance ${recoveredRuntimeArgs.id} already names different incarnation evidence`,
        );
      }
      if (!existingRecoveredRuntime) {
        tx.insert(sessionFabricRuntimeInstances)
          .values({
            ...recoveredRuntimeArgs,
            createdAt: recoveredAt,
            updatedAt: recoveredAt,
          })
          .run();
      }
      const lost = tx
        .update(sessionFabricRuntimeInstances)
        .set({ status: "lost", stoppedAt: null, updatedAt: recoveredAt })
        .where(
          and(
            eq(sessionFabricRuntimeInstances.id, previousRuntime.id),
            eq(sessionFabricRuntimeInstances.status, "live"),
          ),
        )
        .returning()
        .get();
      if (!lost) {
        throw new SessionFabricPersistenceError(
          "runtime_recovery_conflict",
          `previous runtime ${previousRuntime.id} changed before recovery commit`,
        );
      }

      const workspaceStateId = createSessionWorkspaceStateId();
      recordSessionWorkspaceState(tx, {
        ...inspection.workspaceState,
        externalSideEffectStatus:
          context.workspaceState.externalSideEffectStatus,
        hostId: context.nativeConversation.hostId,
        id: workspaceStateId,
      });
      const binding = tx
        .update(sessionFabricExecutionBindings)
        .set({
          controlEpoch: control.controlEpoch,
          nativeCursor: control.nativeCursor,
          phase: "idle",
          providerTurnId: null,
          runtimeInstanceId: recoveredRuntimeArgs.id,
          updatedAt: recoveredAt,
          workspaceStateId,
        })
        .where(
          and(
            eq(sessionFabricExecutionBindings.id, args.bindingId),
            eq(
              sessionFabricExecutionBindings.controlEpoch,
              args.expectedControlEpoch,
            ),
            eq(
              sessionFabricExecutionBindings.runtimeInstanceId,
              args.expectedRuntimeInstanceId,
            ),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      if (!binding) {
        throw new SessionFabricPersistenceError(
          "runtime_recovery_conflict",
          `binding ${args.bindingId} changed before recovery commit`,
        );
      }
      const recovered = getSessionExecutionBindingContext(tx, args.bindingId);
      if (!recovered) {
        throw new SessionFabricPersistenceError(
          "runtime_recovery_conflict",
          `binding ${args.bindingId} disappeared after recovery commit`,
        );
      }
      return recovered;
    },
    { behavior: "immediate" },
  );
}

function toSessionWorkspaceState(
  row: SessionFabricWorkspaceStateRow,
): SessionWorkspaceState {
  return sessionWorkspaceStateSchema.parse(row);
}

function toHandoffTransition(
  row: SessionFabricHandoffTransitionRow,
): HandoffTransition {
  return handoffTransitionSchema.parse({
    createdAt: row.createdAt,
    destinationBindingId: row.destinationBindingId,
    destinationEnvironmentId: row.destinationEnvironmentId,
    destinationHostId: row.destinationHostId,
    destinationModel: row.destinationModel,
    destinationProviderId: row.destinationProviderId,
    destinationProviderInstanceId: row.destinationProviderInstanceId,
    destinationReasoningLevel: row.destinationReasoningLevel,
    destinationServiceTier: row.destinationServiceTier,
    destinationThreadId: row.destinationThreadId,
    destinationWorkspaceDisposition: row.destinationWorkspaceDisposition,
    id: row.id,
    kind: row.kind,
    phase: row.phase,
    sourceBindingId: row.sourceBindingId,
    sourceControlDisposition: row.sourceControlDisposition,
    sourceProviderId: row.sourceProviderId,
    updatedAt: row.updatedAt,
    workstreamBranchId: row.workstreamBranchId,
  });
}

function requireHandoffTransitionRow(
  db: SessionFabricWriteConnection | DbQueryConnection,
  transitionId: string,
): SessionFabricHandoffTransitionRow {
  const row = db
    .select()
    .from(sessionFabricHandoffTransitions)
    .where(eq(sessionFabricHandoffTransitions.id, transitionId))
    .get();
  if (!row) {
    throw new SessionFabricPersistenceError(
      "handoff_not_found",
      `Session Fabric handoff not found: ${transitionId}`,
    );
  }
  return row;
}

function requireWorkspaceStateRow(
  db: SessionFabricWriteConnection | DbQueryConnection,
  workspaceStateId: string,
): SessionFabricWorkspaceStateRow {
  const row = db
    .select()
    .from(sessionFabricWorkspaceStates)
    .where(eq(sessionFabricWorkspaceStates.id, workspaceStateId))
    .get();
  if (!row) {
    throw new SessionFabricPersistenceError(
      "invalid_handoff_topology",
      `workspace state not found: ${workspaceStateId}`,
    );
  }
  return row;
}

function sameSessionModel(
  left: SessionModelRef,
  right: SessionModelRef,
): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

function sameWorkspaceContent(
  left: SessionFabricWorkspaceStateRow,
  right: SessionFabricWorkspaceStateRow,
): boolean {
  return (
    left.digestAlgorithm === right.digestAlgorithm &&
    left.headSha === right.headSha &&
    left.indexDigest === right.indexDigest &&
    left.diffDigest === right.diffDigest &&
    left.untrackedManifestDigest === right.untrackedManifestDigest &&
    left.externalSideEffectStatus === right.externalSideEffectStatus
  );
}

function appendHandoffEvent(
  db: SessionFabricWriteConnection,
  args: {
    event: HandoffTransitionLifecycleEvent;
    occurredAt: number;
    transitionId: string;
  },
): { event: SessionFabricHandoffEventRow; transition: HandoffTransition } {
  const row = requireHandoffTransitionRow(db, args.transitionId);
  const evaluation = evaluateHandoffTransitionLifecycle({
    event: args.event,
    phase: row.phase,
  });
  if ("noop" in evaluation) {
    throw new SessionFabricPersistenceError(
      "handoff_illegal_transition",
      evaluation.detail,
    );
  }
  const updated = db
    .update(sessionFabricHandoffTransitions)
    .set({ phase: evaluation.to, updatedAt: args.occurredAt })
    .where(
      and(
        eq(sessionFabricHandoffTransitions.id, row.id),
        eq(sessionFabricHandoffTransitions.phase, row.phase),
      ),
    )
    .returning()
    .get();
  if (!updated) {
    throw new SessionFabricPersistenceError(
      "handoff_phase_changed",
      `handoff ${row.id} changed from ${row.phase} while applying ${args.event}`,
    );
  }
  const latest = db
    .select({ sequence: max(sessionFabricHandoffEvents.sequence) })
    .from(sessionFabricHandoffEvents)
    .where(eq(sessionFabricHandoffEvents.transitionId, row.id))
    .get();
  const event = db
    .insert(sessionFabricHandoffEvents)
    .values({
      event: args.event,
      fromPhase: row.phase,
      id: createSessionHandoffEventId(),
      occurredAt: args.occurredAt,
      sequence: (latest?.sequence ?? -1) + 1,
      toPhase: evaluation.to,
      transitionId: row.id,
    })
    .returning()
    .get();
  return { event, transition: toHandoffTransition(updated) };
}

export interface CreateSessionHandoffTransitionArgs {
  createdAt?: number;
  destinationEnvironmentId: string;
  destinationHostId: string;
  destinationModel: SessionModelRef;
  destinationProviderInstanceId: string;
  destinationReasoningLevel: ReasoningLevel;
  destinationServiceTier: ServiceTier;
  destinationThreadId: string;
  destinationWorkspaceDisposition: DestinationWorkspaceDisposition;
  id?: string;
  idempotencyKey: string;
  requestHash: string;
  sourceBindingId: string;
}

/** Creates one cross-provider handoff rooted in the exact active binding. */
export function createSessionHandoffTransition(
  db: DbConnection,
  args: CreateSessionHandoffTransitionArgs,
): HandoffTransition {
  const createdAt = args.createdAt ?? Date.now();
  const id = args.id ?? createSessionHandoffTransitionId();
  return db.transaction(
    (tx) => {
      const existingByIdempotencyKey = tx
        .select()
        .from(sessionFabricHandoffTransitions)
        .where(
          eq(
            sessionFabricHandoffTransitions.idempotencyKey,
            args.idempotencyKey,
          ),
        )
        .get();
      if (existingByIdempotencyKey) {
        if (
          existingByIdempotencyKey.requestHash !== args.requestHash ||
          existingByIdempotencyKey.sourceBindingId !== args.sourceBindingId ||
          existingByIdempotencyKey.destinationEnvironmentId !==
            args.destinationEnvironmentId ||
          existingByIdempotencyKey.destinationThreadId !==
            args.destinationThreadId
        ) {
          throw new SessionFabricPersistenceError(
            "handoff_idempotency_conflict",
            `idempotency key ${args.idempotencyKey} already belongs to another handoff request`,
          );
        }
        return toHandoffTransition(existingByIdempotencyKey);
      }
      const source = getSessionExecutionBindingContext(
        tx,
        args.sourceBindingId,
      );
      if (!source) {
        throw new SessionFabricPersistenceError(
          "binding_not_found",
          `Session Fabric binding not found: ${args.sourceBindingId}`,
        );
      }
      if (
        source.binding.closedAt !== null ||
        source.branch.activeBindingId !== source.binding.id ||
        source.branch.status !== "active" ||
        source.workstream.activeBranchId !== source.branch.id ||
        source.workstream.status !== "active"
      ) {
        throw new SessionFabricPersistenceError(
          "binding_not_active",
          `binding ${source.binding.id} is not the active open binding`,
        );
      }
      if (
        source.nativeConversation.providerId ===
        args.destinationModel.providerId
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "cross-provider continuation requires a different destination provider",
        );
      }
      const destinationHost = tx
        .select({ id: hosts.id })
        .from(hosts)
        .where(eq(hosts.id, args.destinationHostId))
        .get();
      if (!destinationHost) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          `destination host not found: ${args.destinationHostId}`,
        );
      }
      const destinationEnvironment = tx
        .select()
        .from(environments)
        .where(eq(environments.id, args.destinationEnvironmentId))
        .get();
      const destinationThread = tx
        .select()
        .from(threads)
        .where(eq(threads.id, args.destinationThreadId))
        .get();
      const destinationThreadBinding = tx
        .select({ id: sessionFabricExecutionBindings.id })
        .from(sessionFabricExecutionBindings)
        .where(
          and(
            eq(
              sessionFabricExecutionBindings.threadId,
              args.destinationThreadId,
            ),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .get();
      if (
        source.environment === null ||
        source.thread === null ||
        !destinationEnvironment ||
        !destinationThread ||
        destinationThreadBinding ||
        destinationEnvironment.hostId !== args.destinationHostId ||
        destinationEnvironment.projectId !== source.workstream.projectId ||
        destinationEnvironment.status !== "ready" ||
        destinationThread.environmentId !== destinationEnvironment.id ||
        destinationThread.projectId !== source.workstream.projectId ||
        destinationThread.providerId !== args.destinationModel.providerId ||
        destinationThread.status !== "idle" ||
        destinationThread.archivedAt !== null ||
        destinationThread.deletedAt !== null ||
        destinationThread.id === source.thread.id ||
        (args.destinationWorkspaceDisposition === "source_worktree" &&
          destinationEnvironment.id !== source.environment.id) ||
        (args.destinationWorkspaceDisposition === "isolated_worktree" &&
          destinationEnvironment.id === source.environment.id)
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "destination thread and environment must be pristine, idle, provider-matched, and use the requested worktree disposition",
        );
      }
      const existing = tx
        .select()
        .from(sessionFabricHandoffTransitions)
        .where(
          eq(
            sessionFabricHandoffTransitions.workstreamBranchId,
            source.branch.id,
          ),
        )
        .all()
        .find(
          (candidate) =>
            candidate.phase !== "aborted" &&
            candidate.phase !== "source_retired_or_detached",
        );
      if (existing) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          `branch ${source.branch.id} already has active handoff ${existing.id}`,
        );
      }
      const transition = handoffTransitionSchema.parse({
        createdAt,
        destinationBindingId: null,
        destinationEnvironmentId: destinationEnvironment.id,
        destinationHostId: args.destinationHostId,
        destinationModel: args.destinationModel,
        destinationProviderId: args.destinationModel.providerId,
        destinationProviderInstanceId: args.destinationProviderInstanceId,
        destinationReasoningLevel: args.destinationReasoningLevel,
        destinationServiceTier: args.destinationServiceTier,
        destinationThreadId: destinationThread.id,
        destinationWorkspaceDisposition: args.destinationWorkspaceDisposition,
        id,
        kind: "cross_provider_continuation",
        phase: "requested",
        sourceBindingId: source.binding.id,
        sourceControlDisposition: "unfenced",
        sourceProviderId: source.nativeConversation.providerId,
        updatedAt: createdAt,
        workstreamBranchId: source.branch.id,
      });
      tx.insert(sessionFabricHandoffTransitions)
        .values({
          ...transition,
          expectedWorkspaceStateId: null,
          idempotencyKey: args.idempotencyKey,
          requestHash: args.requestHash,
        })
        .run();
      return transition;
    },
    { behavior: "immediate" },
  );
}

export type AdvanceSessionHandoffEvent = Extract<
  HandoffTransitionLifecycleEvent,
  | "start_target_preflight"
  | "begin_source_quiesce"
  | "begin_source_reconcile"
  | "begin_destination_stage"
  | "begin_destination_restatement"
  | "begin_destination_enablement"
>;

export function advanceSessionHandoff(
  db: DbConnection,
  args: {
    event: AdvanceSessionHandoffEvent;
    occurredAt?: number;
    transitionId: string;
  },
): HandoffTransition {
  return db.transaction(
    (tx) =>
      appendHandoffEvent(tx, {
        event: args.event,
        occurredAt: args.occurredAt ?? Date.now(),
        transitionId: args.transitionId,
      }).transition,
    { behavior: "immediate" },
  );
}

export interface FenceSessionHandoffSourceIngressArgs {
  expectedControlEpoch: number;
  fencedAt?: number;
  fencedControlEpoch: number;
  transitionId: string;
}

/**
 * Persists the exact host-applied source fence before any source settlement is
 * trusted. Identical retries return the already-recorded state.
 */
export function fenceSessionHandoffSourceIngress(
  db: DbConnection,
  args: FenceSessionHandoffSourceIngressArgs,
): HandoffTransition {
  const fencedAt = args.fencedAt ?? Date.now();
  if (args.fencedControlEpoch !== args.expectedControlEpoch + 1) {
    throw new SessionFabricPersistenceError(
      "handoff_evidence_conflict",
      "source fence must advance the control epoch exactly once",
    );
  }
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      const source = tx
        .select()
        .from(sessionFabricExecutionBindings)
        .where(
          eq(sessionFabricExecutionBindings.id, transition.sourceBindingId),
        )
        .get();
      if (
        transition.phase === "source_ingress_frozen" &&
        transition.sourceControlDisposition === "fenced" &&
        source?.controlEpoch === args.fencedControlEpoch &&
        source.mutationPolicy === "staged_read_only"
      ) {
        return toHandoffTransition(transition);
      }
      if (transition.phase !== "target_preflight") {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `source ingress cannot be fenced from ${transition.phase}`,
        );
      }
      const branch = tx
        .select()
        .from(sessionFabricBranches)
        .where(eq(sessionFabricBranches.id, transition.workstreamBranchId))
        .get();
      if (
        !source ||
        source.closedAt !== null ||
        branch?.activeBindingId !== source.id
      ) {
        throw new SessionFabricPersistenceError(
          "binding_not_active",
          "handoff source is no longer the active open binding",
        );
      }
      const fencedSource = tx
        .update(sessionFabricExecutionBindings)
        .set({
          controlEpoch: args.fencedControlEpoch,
          mutationPolicy: "staged_read_only",
          updatedAt: fencedAt,
        })
        .where(
          and(
            eq(sessionFabricExecutionBindings.id, source.id),
            eq(
              sessionFabricExecutionBindings.controlEpoch,
              args.expectedControlEpoch,
            ),
            eq(sessionFabricExecutionBindings.mutationPolicy, "enabled"),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      if (!fencedSource) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "source control epoch or mutation policy changed before fence persistence",
        );
      }
      const dispositionUpdated = tx
        .update(sessionFabricHandoffTransitions)
        .set({
          sourceControlDisposition: "fenced",
          updatedAt: fencedAt,
        })
        .where(
          and(
            eq(sessionFabricHandoffTransitions.id, transition.id),
            eq(sessionFabricHandoffTransitions.phase, "target_preflight"),
            eq(
              sessionFabricHandoffTransitions.sourceControlDisposition,
              "unfenced",
            ),
          ),
        )
        .returning()
        .get();
      if (!dispositionUpdated) {
        throw new SessionFabricPersistenceError(
          "handoff_phase_changed",
          `handoff ${transition.id} changed while persisting its source fence`,
        );
      }
      return appendHandoffEvent(tx, {
        event: "freeze_source_ingress",
        occurredAt: fencedAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export interface CaptureSessionHandoffWorkspaceSnapshotArgs {
  capturedAt?: number;
  expectedWorkspaceStateId: string;
  settlement: HandoffSettlementSnapshot;
  sourceWorkspaceStateId: string;
  transitionId: string;
}

/** Seals source settlement and the expected destination workspace atomically. */
export function captureSessionHandoffWorkspaceSnapshot(
  db: DbConnection,
  args: CaptureSessionHandoffWorkspaceSnapshotArgs,
): HandoffTransition {
  const capturedAt = args.capturedAt ?? Date.now();
  const settlement = handoffSettlementSnapshotSchema.parse(args.settlement);
  const issues = findHandoffSettlementIssues(settlement);
  if (issues.length > 0) {
    throw new SessionFabricPersistenceError(
      "handoff_settlement_incomplete",
      `source settlement is incomplete: ${issues.join(",")}`,
    );
  }
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      if (transition.phase !== "source_reconciling") {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `workspace snapshot cannot be captured from ${transition.phase}`,
        );
      }
      const source = getSessionExecutionBindingContext(
        tx,
        transition.sourceBindingId,
      );
      if (!source) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "handoff source binding disappeared",
        );
      }
      const sourceWorkspace = requireWorkspaceStateRow(
        tx,
        args.sourceWorkspaceStateId,
      );
      const expectedWorkspace = requireWorkspaceStateRow(
        tx,
        args.expectedWorkspaceStateId,
      );
      if (
        transition.sourceControlDisposition === "fenced" &&
        source.binding.mutationPolicy !== "staged_read_only"
      ) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "source fence evidence does not match the source binding mutation policy",
        );
      }
      const activeResources = sourceWorkspace.backgroundResources.filter(
        (resource) => resource.status === "active",
      ).length;
      const unknownResources = sourceWorkspace.backgroundResources.filter(
        (resource) => resource.status === "unknown",
      ).length;
      if (
        sourceWorkspace.hostId !== source.workspaceState.hostId ||
        sourceWorkspace.rootPath !== source.workspaceState.rootPath ||
        sourceWorkspace.worktreeId !== source.workspaceState.worktreeId ||
        activeResources !== settlement.activeBackgroundResourceCount ||
        unknownResources !== settlement.unknownBackgroundResourceCount ||
        sourceWorkspace.externalSideEffectStatus !==
          settlement.externalSideEffectStatus
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "source settlement does not match its durable workspace observation",
        );
      }
      if (transition.destinationWorkspaceDisposition === "source_worktree") {
        if (
          expectedWorkspace.hostId !== sourceWorkspace.hostId ||
          expectedWorkspace.rootPath !== sourceWorkspace.rootPath ||
          expectedWorkspace.worktreeId !== sourceWorkspace.worktreeId ||
          !sameWorkspaceContent(expectedWorkspace, sourceWorkspace)
        ) {
          throw new SessionFabricPersistenceError(
            "invalid_handoff_topology",
            "shared-worktree destination must use the reconciled source workspace",
          );
        }
        if (transition.sourceControlDisposition === "unfenced") {
          throw new SessionFabricPersistenceError(
            "destination_mutation_gate_closed",
            "an unfenced source cannot hand off its live worktree",
          );
        }
      } else if (
        expectedWorkspace.hostId !== transition.destinationHostId ||
        expectedWorkspace.worktreeId === sourceWorkspace.worktreeId ||
        !sameWorkspaceContent(expectedWorkspace, sourceWorkspace)
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "isolated destination must preserve reconciled content in a different worktree",
        );
      }
      tx.insert(sessionFabricHandoffSourceSettlements)
        .values({
          capturedAt,
          id: createSessionHandoffSettlementId(),
          snapshot: settlement,
          sourceControlDisposition: transition.sourceControlDisposition,
          sourceWorkspaceStateId: sourceWorkspace.id,
          transitionId: transition.id,
        })
        .run();
      const updated = tx
        .update(sessionFabricHandoffTransitions)
        .set({
          expectedWorkspaceStateId: expectedWorkspace.id,
          updatedAt: capturedAt,
        })
        .where(
          and(
            eq(sessionFabricHandoffTransitions.id, transition.id),
            eq(sessionFabricHandoffTransitions.phase, transition.phase),
            isNull(sessionFabricHandoffTransitions.expectedWorkspaceStateId),
          ),
        )
        .returning()
        .get();
      if (!updated) {
        throw new SessionFabricPersistenceError(
          "handoff_phase_changed",
          `handoff ${transition.id} changed while recording workspace evidence`,
        );
      }
      return appendHandoffEvent(tx, {
        event: "capture_workspace_snapshot",
        occurredAt: capturedAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export type SessionContextCapsuleDraft = Omit<
  ContextCapsule,
  | "contentHash"
  | "createdAt"
  | "expectedWorkspaceState"
  | "id"
  | "sourceConversation"
  | "transitionId"
>;

export interface SealSessionContextCapsuleArgs {
  capsule: SessionContextCapsuleDraft;
  createdAt?: number;
  id?: string;
  transitionId: string;
}

/** Builds, hashes, scans, and seals the immutable provider-boundary capsule. */
export function sealSessionContextCapsule(
  db: DbConnection,
  args: SealSessionContextCapsuleArgs,
): ContextCapsule {
  const createdAt = args.createdAt ?? Date.now();
  const id = args.id ?? createSessionContextCapsuleId();
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      if (
        transition.phase !== "workspace_snapshot_captured" ||
        transition.expectedWorkspaceStateId === null
      ) {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `capsule cannot be sealed from ${transition.phase}`,
        );
      }
      const source = getSessionExecutionBindingContext(
        tx,
        transition.sourceBindingId,
      );
      if (!source) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "handoff source binding disappeared",
        );
      }
      const expectedWorkspace = requireWorkspaceStateRow(
        tx,
        transition.expectedWorkspaceStateId,
      );
      const hashPayload = {
        ...args.capsule,
        createdAt,
        expectedWorkspaceState: toSessionWorkspaceState(expectedWorkspace),
        id,
        sourceConversation: {
          hostId: source.nativeConversation.hostId,
          nativeConversationId: source.nativeConversation.nativeConversationId,
          providerId: source.nativeConversation.providerId,
          providerInstanceId: source.nativeConversation.providerInstanceId,
        },
        transitionId: transition.id,
      };
      const contentHash = `sha256:${createHash("sha256")
        .update(serializeContextCapsuleForHash(hashPayload))
        .digest("hex")}`;
      const capsule = contextCapsuleSchema.parse({
        ...hashPayload,
        contentHash,
      });
      const sensitiveFindings = findContextCapsuleSensitiveMaterial(capsule);
      if (sensitiveFindings.length > 0) {
        throw new SessionFabricPersistenceError(
          "capsule_sensitive_material",
          `capsule contains prohibited sensitive material: ${sensitiveFindings.join(",")}`,
        );
      }
      tx.insert(sessionFabricContextCapsules)
        .values({
          capsule,
          contentHash,
          createdAt,
          expectedWorkspaceStateId: expectedWorkspace.id,
          id,
          transitionId: transition.id,
        })
        .run();
      appendHandoffEvent(tx, {
        event: "build_capsule",
        occurredAt: createdAt,
        transitionId: transition.id,
      });
      return capsule;
    },
    { behavior: "immediate" },
  );
}

export function confirmSessionHandoffUserReview(
  db: DbConnection,
  args: {
    capsuleContentHash: string;
    reviewedAt?: number;
    reviewerId: string;
    transitionId: string;
  },
): HandoffTransition {
  const reviewedAt = args.reviewedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      const capsule = tx
        .select()
        .from(sessionFabricContextCapsules)
        .where(eq(sessionFabricContextCapsules.transitionId, transition.id))
        .get();
      if (!capsule || capsule.contentHash !== args.capsuleContentHash) {
        throw new SessionFabricPersistenceError(
          "capsule_hash_mismatch",
          "user review did not name the sealed capsule hash",
        );
      }
      tx.insert(sessionFabricHandoffReviews)
        .values({
          capsuleContentHash: capsule.contentHash,
          id: createSessionHandoffReviewId(),
          reviewedAt,
          reviewerId: args.reviewerId,
          transitionId: transition.id,
        })
        .run();
      return appendHandoffEvent(tx, {
        event: "confirm_user_review",
        occurredAt: reviewedAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export type AuthorizeSessionHandoffDestinationArgs = Omit<
  HandoffAuthorizationEvidence,
  "authorizedAt" | "capsuleContentHash" | "id" | "transitionId"
> & {
  authorizedAt?: number;
  id?: string;
  transitionId: string;
};

/** Records freshly-derived destination billing and permission authorization. */
export function authorizeSessionHandoffDestination(
  db: DbConnection,
  args: AuthorizeSessionHandoffDestinationArgs,
): HandoffAuthorizationEvidence {
  const authorizedAt = args.authorizedAt ?? Date.now();
  const id = args.id ?? createSessionHandoffAuthorizationId();
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      const review = tx
        .select()
        .from(sessionFabricHandoffReviews)
        .where(eq(sessionFabricHandoffReviews.transitionId, transition.id))
        .get();
      if (!review) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "destination authorization requires immutable user review evidence",
        );
      }
      if (
        args.destinationProviderInstanceId !==
          transition.destinationProviderInstanceId ||
        !sameSessionModel(args.destinationModel, transition.destinationModel)
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "destination authorization does not match the requested provider target",
        );
      }
      const evidence = handoffAuthorizationEvidenceSchema.parse({
        ...args,
        authorizedAt,
        capsuleContentHash: review.capsuleContentHash,
        id,
        transitionId: transition.id,
      });
      tx.insert(sessionFabricHandoffAuthorizations).values(evidence).run();
      appendHandoffEvent(tx, {
        event: "authorize_billing_and_permission",
        occurredAt: authorizedAt,
        transitionId: transition.id,
      });
      return evidence;
    },
    { behavior: "immediate" },
  );
}

export interface SessionHandoffRuntimeInspection
  extends SessionAdoptionRuntimeInspection {
  executionSafety: "handoff_restatement";
}

export interface SessionHandoffRuntimeControlState
  extends SessionAdoptionRuntimeControlState {
  executionSafety: "handoff_restatement";
  handoffCheckpoint: "destination_staged";
  handoffRole: "destination";
  handoffTransitionId: string;
}

export interface StageSessionHandoffDestinationArgs {
  control: SessionHandoffRuntimeControlState;
  destinationBindingId: string;
  effectiveAccount: ProviderAccountRef | null;
  effectiveModel: SessionModelRef;
  inspection: SessionHandoffRuntimeInspection;
  stagedAt?: number;
  transitionId: string;
}

function sameIncarnationEvidence(
  left: SessionAdoptionRuntimeIncarnationEvidence,
  right: SessionAdoptionRuntimeIncarnationEvidence,
): boolean {
  return (
    left.bootNonce === right.bootNonce &&
    left.connectorId === right.connectorId &&
    left.endpointFingerprint === right.endpointFingerprint &&
    left.processKey === right.processKey &&
    left.providerId === right.providerId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.startedAt === right.startedAt
  );
}

/**
 * Persists a host-created read-only destination as one atomic evidence set.
 * The host stage RPC carries a transition-derived binding id and is exactly
 * replayable, so no partial server topology may leak if validation or
 * persistence fails after its result arrives.
 */
export function stageSessionHandoffDestination(
  db: DbConnection,
  args: StageSessionHandoffDestinationArgs,
): HandoffTransition {
  const stagedAt = args.stagedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      if (
        transition.phase === "destination_staged_read_only" &&
        transition.destinationBindingId === args.destinationBindingId
      ) {
        return toHandoffTransition(transition);
      }
      if (
        transition.phase !== "destination_staging_read_only" ||
        transition.destinationBindingId !== null ||
        transition.expectedWorkspaceStateId === null
      ) {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `destination stage evidence cannot be persisted from ${transition.phase}`,
        );
      }
      const source = getSessionExecutionBindingContext(
        tx,
        transition.sourceBindingId,
      );
      const destinationEnvironment = tx
        .select()
        .from(environments)
        .where(eq(environments.id, transition.destinationEnvironmentId))
        .get();
      const destinationThread = tx
        .select()
        .from(threads)
        .where(eq(threads.id, transition.destinationThreadId))
        .get();
      const authorization = tx
        .select()
        .from(sessionFabricHandoffAuthorizations)
        .where(
          eq(sessionFabricHandoffAuthorizations.transitionId, transition.id),
        )
        .get();
      const expectedWorkspace = requireWorkspaceStateRow(
        tx,
        transition.expectedWorkspaceStateId,
      );
      const existingThreadBinding = tx
        .select({ id: sessionFabricExecutionBindings.id })
        .from(sessionFabricExecutionBindings)
        .where(
          and(
            eq(
              sessionFabricExecutionBindings.threadId,
              transition.destinationThreadId,
            ),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .get();
      if (
        !source ||
        !destinationEnvironment ||
        !destinationThread ||
        !authorization ||
        existingThreadBinding ||
        source.branch.activeBindingId !== source.binding.id ||
        destinationEnvironment.hostId !== transition.destinationHostId ||
        destinationEnvironment.projectId !== source.workstream.projectId ||
        destinationEnvironment.status !== "ready" ||
        destinationThread.environmentId !== destinationEnvironment.id ||
        destinationThread.projectId !== source.workstream.projectId ||
        destinationThread.providerId !== transition.destinationProviderId ||
        destinationThread.status !== "idle" ||
        destinationThread.archivedAt !== null ||
        destinationThread.deletedAt !== null
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "destination stage no longer matches its reserved idle thread and environment",
        );
      }

      const { control, inspection } = args;
      if (
        control.bindingId !== args.destinationBindingId ||
        control.controlEpoch < 0 ||
        control.environmentId !== destinationEnvironment.id ||
        control.executionSafety !== "handoff_restatement" ||
        control.handoffCheckpoint !== "destination_staged" ||
        control.handoffRole !== "destination" ||
        control.handoffTransitionId !== transition.id ||
        control.mutationPolicy !== "staged_read_only" ||
        control.nativeCursor !== null ||
        control.ownership !== "owned_brokered" ||
        control.phase !== "idle" ||
        control.providerInstanceId !==
          transition.destinationProviderInstanceId ||
        control.threadId !== destinationThread.id ||
        control.turnId !== null ||
        control.workspaceId !== inspection.workspaceState.rootPath ||
        inspection.environmentId !== destinationEnvironment.id ||
        inspection.executionSafety !== "handoff_restatement" ||
        inspection.ownership !== "owned_brokered" ||
        inspection.phase !== "idle" ||
        inspection.providerId !== transition.destinationProviderId ||
        inspection.providerInstanceId !==
          transition.destinationProviderInstanceId ||
        inspection.threadId !== destinationThread.id ||
        inspection.turnId !== null ||
        !sameIncarnationEvidence(control.incarnation, inspection.incarnation) ||
        inspection.incarnation.providerId !==
          transition.destinationProviderId ||
        inspection.runtimeRecipe.cwd !== inspection.workspaceState.rootPath ||
        inspection.runtimeRecipe.permissionMode !==
          authorization.permissionMode ||
        !inspection.runtimeRecipe.environmentReferenceIds.includes(
          destinationEnvironment.id,
        ) ||
        !inspection.runtimeRecipe.workspaceWriteRoots.includes(
          inspection.workspaceState.rootPath,
        ) ||
        inspection.workspaceState.backgroundResources.length !== 0 ||
        !sameSessionModel(args.effectiveModel, transition.destinationModel) ||
        (args.effectiveAccount !== null &&
          args.effectiveAccount.providerInstanceId !==
            transition.destinationProviderInstanceId)
      ) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "host stage evidence does not match the reserved handoff target, isolation policy, or authorization",
        );
      }

      const runtimeArgs: RecordSessionRuntimeInstanceArgs = {
        bootNonce: inspection.incarnation.bootNonce,
        connectorId: inspection.incarnation.connectorId,
        endpointFingerprint: inspection.incarnation.endpointFingerprint,
        hostId: transition.destinationHostId,
        id: inspection.incarnation.runtimeInstanceId,
        processKey: inspection.incarnation.processKey,
        providerId: inspection.incarnation.providerId,
        providerInstanceId: inspection.providerInstanceId,
        startedAt: inspection.incarnation.startedAt,
        status: "live",
        stoppedAt: null,
      };
      assertRuntimeInstanceDomain(runtimeArgs);
      const existingRuntime = tx
        .select()
        .from(sessionFabricRuntimeInstances)
        .where(eq(sessionFabricRuntimeInstances.id, runtimeArgs.id))
        .get();
      if (existingRuntime && !sameRuntimeInstance(existingRuntime, runtimeArgs)) {
        throw new SessionFabricPersistenceError(
          "runtime_incarnation_conflict",
          `runtime instance ${runtimeArgs.id} already names different incarnation evidence`,
        );
      }
      if (!existingRuntime) {
        tx.insert(sessionFabricRuntimeInstances)
          .values({
            ...runtimeArgs,
            createdAt: stagedAt,
            updatedAt: stagedAt,
          })
          .run();
      }

      const nativeConversation = upsertSessionNativeConversationInTransaction(
        tx,
        {
          cwd: inspection.workspaceState.rootPath,
          hostId: transition.destinationHostId,
          lastObservedAt: stagedAt,
          nativeConversationId: inspection.providerThreadId,
          projectId: source.workstream.projectId,
          providerId: transition.destinationProviderId,
          providerInstanceId: transition.destinationProviderInstanceId,
          providerState: "provider_reported_idle",
          title: destinationThread.title,
        },
      );
      const recipeId = createSessionRuntimeRecipeId();
      createSessionRuntimeRecipe(tx, {
        ...inspection.runtimeRecipe,
        createdAt: stagedAt,
        id: recipeId,
      });
      const observedWorkspaceId = createSessionWorkspaceStateId();
      const observedWorkspace = recordSessionWorkspaceState(tx, {
        ...inspection.workspaceState,
        hostId: transition.destinationHostId,
        id: observedWorkspaceId,
      });
      if (
        expectedWorkspace.hostId !== observedWorkspace.hostId ||
        expectedWorkspace.rootPath !== observedWorkspace.rootPath ||
        expectedWorkspace.worktreeId !== observedWorkspace.worktreeId ||
        !sameWorkspaceContent(expectedWorkspace, observedWorkspace)
      ) {
        throw new SessionFabricPersistenceError(
          "destination_mutation_gate_closed",
          "host-staged destination workspace differs from the sealed expected state",
        );
      }

      executionBindingSchema.parse({
        closedAt: null,
        controlEpoch: control.controlEpoch,
        id: args.destinationBindingId,
        mutationPolicy: control.mutationPolicy,
        nativeConversation: {
          hostId: nativeConversation.hostId,
          nativeConversationId: nativeConversation.nativeConversationId,
          providerId: nativeConversation.providerId,
          providerInstanceId: nativeConversation.providerInstanceId,
        },
        openedAt: stagedAt,
        ownership: control.ownership,
        phase: control.phase,
        runtimeInstanceId: runtimeArgs.id,
        runtimeRecipeId: recipeId,
        workspaceStateId: observedWorkspace.id,
        workstreamBranchId: transition.workstreamBranchId,
      });
      tx.insert(sessionFabricExecutionBindings)
        .values({
          closedAt: null,
          controlEpoch: control.controlEpoch,
          environmentId: destinationEnvironment.id,
          id: args.destinationBindingId,
          mutationPolicy: control.mutationPolicy,
          nativeConversationId: nativeConversation.id,
          nativeCursor: control.nativeCursor,
          openedAt: stagedAt,
          ownership: control.ownership,
          phase: control.phase,
          providerTurnId: control.turnId,
          runtimeInstanceId: runtimeArgs.id,
          runtimeRecipeId: recipeId,
          threadId: destinationThread.id,
          updatedAt: stagedAt,
          workspaceStateId: observedWorkspace.id,
          workstreamBranchId: transition.workstreamBranchId,
        })
        .run();
      tx.insert(sessionFabricModelEpochs)
        .values({
          billingRouteId: authorization.billingRouteId,
          bindingId: args.destinationBindingId,
          effectiveAccount: args.effectiveAccount,
          effectiveModel: args.effectiveModel,
          endedAt: null,
          id: createSessionModelEpochId(),
          reasoningLevel: transition.destinationReasoningLevel,
          requestedModel: transition.destinationModel,
          sequence: 0,
          serviceTier: transition.destinationServiceTier,
          startedAt: stagedAt,
        })
        .run();
      const updated = tx
        .update(sessionFabricHandoffTransitions)
        .set({
          destinationBindingId: args.destinationBindingId,
          updatedAt: stagedAt,
        })
        .where(
          and(
            eq(sessionFabricHandoffTransitions.id, transition.id),
            eq(sessionFabricHandoffTransitions.phase, transition.phase),
            isNull(sessionFabricHandoffTransitions.destinationBindingId),
          ),
        )
        .returning()
        .get();
      if (!updated) {
        throw new SessionFabricPersistenceError(
          "handoff_phase_changed",
          `handoff ${transition.id} changed while persisting destination stage evidence`,
        );
      }
      return appendHandoffEvent(tx, {
        event: "stage_destination_read_only",
        occurredAt: stagedAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

function requireHandoffMutationGateOpen(
  db: SessionFabricWriteConnection,
  transition: SessionFabricHandoffTransitionRow,
  observedWorkspaceStateId: string,
): void {
  if (
    transition.destinationBindingId === null ||
    transition.expectedWorkspaceStateId === null
  ) {
    throw new SessionFabricPersistenceError(
      "invalid_handoff_topology",
      "handoff has no staged destination or expected workspace",
    );
  }
  const expectedWorkspace = requireWorkspaceStateRow(
    db,
    transition.expectedWorkspaceStateId,
  );
  const actualWorkspace = requireWorkspaceStateRow(
    db,
    observedWorkspaceStateId,
  );
  const authorization = db
    .select()
    .from(sessionFabricHandoffAuthorizations)
    .where(eq(sessionFabricHandoffAuthorizations.transitionId, transition.id))
    .get();
  const restatement = db
    .select()
    .from(sessionFabricHandoffRestatements)
    .where(eq(sessionFabricHandoffRestatements.transitionId, transition.id))
    .get();
  const issues = findDestinationMutationGateIssues({
    actualWorkspaceState: toSessionWorkspaceState(actualWorkspace),
    billingAuthorized: authorization !== undefined,
    destinationRestated: restatement !== undefined,
    destinationWorkspaceDisposition: transition.destinationWorkspaceDisposition,
    expectedWorkspaceState: toSessionWorkspaceState(expectedWorkspace),
    sourceControlDisposition: transition.sourceControlDisposition,
    transitionPhase: "active_binding_swapped",
  });
  if (issues.length > 0) {
    throw new SessionFabricPersistenceError(
      "destination_mutation_gate_closed",
      `destination mutation gate is closed: ${issues.join(",")}`,
    );
  }
}

export function verifySessionHandoffDestinationRestatement(
  db: DbConnection,
  args: {
    expectedControlEpoch: number;
    observedWorkspaceStateId: string;
    restatement: ContextCapsuleRestatement;
    restatedControlEpoch: number;
    transitionId: string;
    verifiedAt?: number;
  },
): HandoffTransition {
  const verifiedAt = args.verifiedAt ?? Date.now();
  const restatement = contextCapsuleRestatementSchema.parse(args.restatement);
  if (args.restatedControlEpoch !== args.expectedControlEpoch + 1) {
    throw new SessionFabricPersistenceError(
      "handoff_evidence_conflict",
      "destination restatement must advance the control epoch exactly once",
    );
  }
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      if (
        transition.phase !== "destination_restating" ||
        transition.destinationBindingId === null
      ) {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `destination restatement cannot be verified from ${transition.phase}`,
        );
      }
      const capsuleRow = tx
        .select()
        .from(sessionFabricContextCapsules)
        .where(eq(sessionFabricContextCapsules.transitionId, transition.id))
        .get();
      const destination = tx
        .select()
        .from(sessionFabricExecutionBindings)
        .where(
          eq(
            sessionFabricExecutionBindings.id,
            transition.destinationBindingId,
          ),
        )
        .get();
      if (!capsuleRow || !destination) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "capsule or staged destination is missing",
        );
      }
      const capsule = contextCapsuleSchema.parse(capsuleRow.capsule);
      const issues = findContextCapsuleRestatementIssues(capsule, restatement);
      if (issues.length > 0) {
        throw new SessionFabricPersistenceError(
          "destination_restatement_mismatch",
          `destination restatement differs from capsule: ${issues.join(",")}`,
        );
      }
      if (destination.mutationPolicy !== "staged_read_only") {
        throw new SessionFabricPersistenceError(
          "destination_mutation_gate_closed",
          "destination was not kept staged read-only during restatement",
        );
      }
      const restatedDestination = tx
        .update(sessionFabricExecutionBindings)
        .set({
          controlEpoch: args.restatedControlEpoch,
          updatedAt: verifiedAt,
          workspaceStateId: args.observedWorkspaceStateId,
        })
        .where(
          and(
            eq(sessionFabricExecutionBindings.id, destination.id),
            eq(
              sessionFabricExecutionBindings.controlEpoch,
              args.expectedControlEpoch,
            ),
            eq(
              sessionFabricExecutionBindings.mutationPolicy,
              "staged_read_only",
            ),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      if (!restatedDestination) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "destination control epoch changed before restatement evidence was persisted",
        );
      }
      tx.insert(sessionFabricHandoffRestatements)
        .values({
          capsuleContentHash: capsule.contentHash,
          destinationBindingId: destination.id,
          id: createSessionHandoffRestatementId(),
          observedWorkspaceStateId: args.observedWorkspaceStateId,
          restatement,
          transitionId: transition.id,
          verifiedAt,
        })
        .run();
      requireHandoffMutationGateOpen(
        tx,
        transition,
        args.observedWorkspaceStateId,
      );
      return appendHandoffEvent(tx, {
        event: "verify_destination_restatement",
        occurredAt: verifiedAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export function swapSessionHandoffActiveBinding(
  db: DbConnection,
  args: {
    observedWorkspaceStateId: string;
    swappedAt?: number;
    transitionId: string;
  },
): HandoffTransition {
  const swappedAt = args.swappedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      if (
        transition.phase !== "destination_restated_and_verified" ||
        transition.destinationBindingId === null
      ) {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `active binding cannot be swapped from ${transition.phase}`,
        );
      }
      requireHandoffMutationGateOpen(
        tx,
        transition,
        args.observedWorkspaceStateId,
      );
      const destination = tx
        .update(sessionFabricExecutionBindings)
        .set({
          updatedAt: swappedAt,
          workspaceStateId: args.observedWorkspaceStateId,
        })
        .where(
          and(
            eq(
              sessionFabricExecutionBindings.id,
              transition.destinationBindingId,
            ),
            eq(
              sessionFabricExecutionBindings.workstreamBranchId,
              transition.workstreamBranchId,
            ),
            eq(
              sessionFabricExecutionBindings.mutationPolicy,
              "staged_read_only",
            ),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      if (!destination) {
        throw new SessionFabricPersistenceError(
          "invalid_handoff_topology",
          "destination binding is no longer open and staged read-only",
        );
      }
      const branch = tx
        .update(sessionFabricBranches)
        .set({
          activeBindingId: destination.id,
          updatedAt: swappedAt,
        })
        .where(
          and(
            eq(sessionFabricBranches.id, transition.workstreamBranchId),
            eq(
              sessionFabricBranches.activeBindingId,
              transition.sourceBindingId,
            ),
          ),
        )
        .returning()
        .get();
      if (!branch) {
        throw new SessionFabricPersistenceError(
          "active_binding_changed",
          "source binding changed before the handoff compare-and-swap",
        );
      }
      return appendHandoffEvent(tx, {
        event: "swap_active_binding",
        occurredAt: swappedAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export function enableSessionHandoffDestinationMutation(
  db: DbConnection,
  args: {
    enabledAt?: number;
    enabledControlEpoch: number;
    expectedControlEpoch: number;
    observedWorkspaceStateId: string;
    transitionId: string;
  },
): HandoffTransition {
  const enabledAt = args.enabledAt ?? Date.now();
  if (args.enabledControlEpoch !== args.expectedControlEpoch + 1) {
    throw new SessionFabricPersistenceError(
      "handoff_evidence_conflict",
      "destination enablement must advance the control epoch exactly once",
    );
  }
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      if (transition.phase === "destination_mutation_enabled") {
        const destination =
          transition.destinationBindingId === null
            ? null
            : tx
                .select()
                .from(sessionFabricExecutionBindings)
                .where(
                  eq(
                    sessionFabricExecutionBindings.id,
                    transition.destinationBindingId,
                  ),
                )
                .get();
        if (
          destination?.controlEpoch === args.enabledControlEpoch &&
          destination.mutationPolicy === "enabled"
        ) {
          return toHandoffTransition(transition);
        }
      }
      if (
        transition.phase !== "destination_enabling" ||
        transition.destinationBindingId === null
      ) {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `destination mutation cannot be enabled from ${transition.phase}`,
        );
      }
      requireHandoffMutationGateOpen(
        tx,
        transition,
        args.observedWorkspaceStateId,
      );
      const branch = tx
        .select()
        .from(sessionFabricBranches)
        .where(eq(sessionFabricBranches.id, transition.workstreamBranchId))
        .get();
      if (branch?.activeBindingId !== transition.destinationBindingId) {
        throw new SessionFabricPersistenceError(
          "active_binding_changed",
          "destination is no longer the active binding",
        );
      }
      const destination = tx
        .update(sessionFabricExecutionBindings)
        .set({
          controlEpoch: args.enabledControlEpoch,
          mutationPolicy: "enabled",
          updatedAt: enabledAt,
          workspaceStateId: args.observedWorkspaceStateId,
        })
        .where(
          and(
            eq(
              sessionFabricExecutionBindings.id,
              transition.destinationBindingId,
            ),
            eq(
              sessionFabricExecutionBindings.controlEpoch,
              args.expectedControlEpoch,
            ),
            eq(
              sessionFabricExecutionBindings.mutationPolicy,
              "staged_read_only",
            ),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      if (!destination) {
        throw new SessionFabricPersistenceError(
          "handoff_phase_changed",
          "destination control epoch or mutation policy changed before enablement",
        );
      }
      return appendHandoffEvent(tx, {
        event: "enable_destination_mutation",
        occurredAt: enabledAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export function retireSessionHandoffSource(
  db: DbConnection,
  args: {
    retiredAt?: number;
    sourceRetirement: {
      expectedControlEpoch: number;
      terminalControlEpoch: number;
    };
    transitionId: string;
  },
): HandoffTransition {
  const retiredAt = args.retiredAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      if (transition.phase !== "destination_mutation_enabled") {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          `source cannot be retired or detached from ${transition.phase}`,
        );
      }
      if (
        args.sourceRetirement.terminalControlEpoch !==
        args.sourceRetirement.expectedControlEpoch + 1
      ) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "source retirement requires the next terminal host control epoch",
        );
      }
      const source = tx
        .update(sessionFabricExecutionBindings)
        .set({
          closedAt: retiredAt,
          controlEpoch: args.sourceRetirement.terminalControlEpoch,
          phase: "terminal",
          providerTurnId: null,
          updatedAt: retiredAt,
        })
        .where(
          and(
            eq(sessionFabricExecutionBindings.id, transition.sourceBindingId),
            eq(
              sessionFabricExecutionBindings.controlEpoch,
              args.sourceRetirement.expectedControlEpoch,
            ),
            eq(sessionFabricExecutionBindings.mutationPolicy, "staged_read_only"),
            eq(sessionFabricExecutionBindings.phase, "idle"),
            isNull(sessionFabricExecutionBindings.closedAt),
          ),
        )
        .returning()
        .get();
      if (!source) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "source binding was already closed before retirement evidence",
        );
      }
      tx.update(sessionFabricModelEpochs)
        .set({ endedAt: retiredAt })
        .where(
          and(
            eq(sessionFabricModelEpochs.bindingId, transition.sourceBindingId),
            isNull(sessionFabricModelEpochs.endedAt),
          ),
        )
        .run();
      return appendHandoffEvent(tx, {
        event: "retire_or_detach_source",
        occurredAt: retiredAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export function abortSessionHandoff(
  db: DbConnection,
  args: {
    abortedAt?: number;
    sourceRestore?: {
      enabledControlEpoch: number;
      expectedControlEpoch: number;
    };
    destinationDiscard?: {
      bindingId: string;
      expectedControlEpoch: number;
      terminalControlEpoch: number;
    };
    transitionId: string;
  },
): HandoffTransition {
  const abortedAt = args.abortedAt ?? Date.now();
  return db.transaction(
    (tx) => {
      const transition = requireHandoffTransitionRow(tx, args.transitionId);
      const evaluation = evaluateHandoffTransitionLifecycle({
        event: "abort",
        phase: transition.phase,
      });
      if ("noop" in evaluation) {
        throw new SessionFabricPersistenceError(
          "handoff_illegal_transition",
          evaluation.detail,
        );
      }
      if (transition.sourceControlDisposition === "fenced") {
        if (
          !args.sourceRestore ||
          args.sourceRestore.enabledControlEpoch !==
            args.sourceRestore.expectedControlEpoch + 1
        ) {
          throw new SessionFabricPersistenceError(
            "handoff_evidence_conflict",
            "aborting a fenced handoff requires exact host source-restore evidence",
          );
        }
        const restoredSource = tx
          .update(sessionFabricExecutionBindings)
          .set({
            controlEpoch: args.sourceRestore.enabledControlEpoch,
            mutationPolicy: "enabled",
            updatedAt: abortedAt,
          })
          .where(
            and(
              eq(sessionFabricExecutionBindings.id, transition.sourceBindingId),
              eq(
                sessionFabricExecutionBindings.controlEpoch,
                args.sourceRestore.expectedControlEpoch,
              ),
              eq(
                sessionFabricExecutionBindings.mutationPolicy,
                "staged_read_only",
              ),
              isNull(sessionFabricExecutionBindings.closedAt),
            ),
          )
          .returning()
          .get();
        if (!restoredSource) {
          throw new SessionFabricPersistenceError(
            "handoff_evidence_conflict",
            "source control epoch or mutation policy changed before abort restore",
          );
        }
        tx.update(sessionFabricHandoffTransitions)
          .set({
            sourceControlDisposition: "unfenced",
            updatedAt: abortedAt,
          })
          .where(eq(sessionFabricHandoffTransitions.id, transition.id))
          .run();
      } else if (args.sourceRestore !== undefined) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "source-restore evidence was supplied for a handoff that was not fenced",
        );
      }
      if (transition.destinationBindingId !== null) {
        if (
          !args.destinationDiscard ||
          args.destinationDiscard.bindingId !==
            transition.destinationBindingId ||
          args.destinationDiscard.terminalControlEpoch !==
            args.destinationDiscard.expectedControlEpoch + 1
        ) {
          throw new SessionFabricPersistenceError(
            "handoff_evidence_conflict",
            "aborting a staged destination requires exact terminal host evidence",
          );
        }
        const discardedDestination = tx
          .update(sessionFabricExecutionBindings)
          .set({
            closedAt: abortedAt,
            controlEpoch: args.destinationDiscard.terminalControlEpoch,
            phase: "terminal",
            providerTurnId: null,
            updatedAt: abortedAt,
          })
          .where(
            and(
              eq(
                sessionFabricExecutionBindings.id,
                transition.destinationBindingId,
              ),
              eq(
                sessionFabricExecutionBindings.controlEpoch,
                args.destinationDiscard.expectedControlEpoch,
              ),
              eq(
                sessionFabricExecutionBindings.mutationPolicy,
                "staged_read_only",
              ),
              eq(sessionFabricExecutionBindings.phase, "idle"),
              isNull(sessionFabricExecutionBindings.closedAt),
            ),
          )
          .returning()
          .get();
        if (!discardedDestination) {
          throw new SessionFabricPersistenceError(
            "handoff_evidence_conflict",
            "destination control changed before terminal abort evidence was recorded",
          );
        }
        tx.update(sessionFabricModelEpochs)
          .set({ endedAt: abortedAt })
          .where(
            and(
              eq(
                sessionFabricModelEpochs.bindingId,
                transition.destinationBindingId,
              ),
              isNull(sessionFabricModelEpochs.endedAt),
            ),
          )
          .run();
      } else if (args.destinationDiscard !== undefined) {
        throw new SessionFabricPersistenceError(
          "handoff_evidence_conflict",
          "destination terminal evidence was supplied before a binding was persisted",
        );
      }
      return appendHandoffEvent(tx, {
        event: "abort",
        occurredAt: abortedAt,
        transitionId: transition.id,
      }).transition;
    },
    { behavior: "immediate" },
  );
}

export function getSessionHandoffTransition(
  db: DbQueryConnection,
  transitionId: string,
): HandoffTransition | null {
  const row = db
    .select()
    .from(sessionFabricHandoffTransitions)
    .where(eq(sessionFabricHandoffTransitions.id, transitionId))
    .get();
  return row ? toHandoffTransition(row) : null;
}

export function listSessionHandoffEvents(
  db: DbQueryConnection,
  transitionId: string,
): SessionFabricHandoffEventRow[] {
  return db
    .select()
    .from(sessionFabricHandoffEvents)
    .where(eq(sessionFabricHandoffEvents.transitionId, transitionId))
    .orderBy(sessionFabricHandoffEvents.sequence)
    .all();
}

export interface SessionHandoffAudit {
  authorization: SessionFabricHandoffAuthorizationRow | null;
  capsule: SessionFabricContextCapsuleRow | null;
  events: SessionFabricHandoffEventRow[];
  restatement: SessionFabricHandoffRestatementRow | null;
  review: SessionFabricHandoffReviewRow | null;
  settlement: SessionFabricHandoffSourceSettlementRow | null;
  transition: HandoffTransition;
}

export function getSessionHandoffAudit(
  db: DbQueryConnection,
  transitionId: string,
): SessionHandoffAudit | null {
  const row = db
    .select()
    .from(sessionFabricHandoffTransitions)
    .where(eq(sessionFabricHandoffTransitions.id, transitionId))
    .get();
  if (!row) return null;
  return {
    authorization:
      db
        .select()
        .from(sessionFabricHandoffAuthorizations)
        .where(
          eq(sessionFabricHandoffAuthorizations.transitionId, transitionId),
        )
        .get() ?? null,
    capsule:
      db
        .select()
        .from(sessionFabricContextCapsules)
        .where(eq(sessionFabricContextCapsules.transitionId, transitionId))
        .get() ?? null,
    events: listSessionHandoffEvents(db, transitionId),
    restatement:
      db
        .select()
        .from(sessionFabricHandoffRestatements)
        .where(eq(sessionFabricHandoffRestatements.transitionId, transitionId))
        .get() ?? null,
    review:
      db
        .select()
        .from(sessionFabricHandoffReviews)
        .where(eq(sessionFabricHandoffReviews.transitionId, transitionId))
        .get() ?? null,
    settlement:
      db
        .select()
        .from(sessionFabricHandoffSourceSettlements)
        .where(
          eq(sessionFabricHandoffSourceSettlements.transitionId, transitionId),
        )
        .get() ?? null,
    transition: toHandoffTransition(row),
  };
}
