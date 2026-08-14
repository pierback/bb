import { z } from "zod";
import {
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "./shared-types.js";

export const sessionProviderInstanceRefSchema = z
  .object({
    hostId: z.string().min(1),
    providerId: z.string().min(1),
    providerInstanceId: z.string().min(1),
  })
  .strict();
export type SessionProviderInstanceRef = z.infer<
  typeof sessionProviderInstanceRefSchema
>;

export const nativeConversationRefSchema = sessionProviderInstanceRefSchema
  .extend({
    nativeConversationId: z.string().min(1),
  })
  .strict();
export type NativeConversationRef = z.infer<typeof nativeConversationRefSchema>;

export const sessionModelRefSchema = z
  .object({
    modelId: z.string().min(1),
    providerId: z.string().min(1),
  })
  .strict();
export type SessionModelRef = z.infer<typeof sessionModelRefSchema>;

export const providerAccountRefSchema = z
  .object({
    accountFingerprint: z.string().min(1),
    accountLabel: z.string().min(1),
    providerInstanceId: z.string().min(1),
  })
  .strict();
export type ProviderAccountRef = z.infer<typeof providerAccountRefSchema>;

export const runtimeOwnershipValues = [
  "owned_exclusive",
  "owned_brokered",
  "provider_shared",
  "cooperative_external",
  "unfenced_external",
  "unknown",
] as const;
export const runtimeOwnershipSchema = z.enum(runtimeOwnershipValues);
export type RuntimeOwnership = z.infer<typeof runtimeOwnershipSchema>;

export const runtimePhaseValues = [
  "persisted_only",
  "observed_live",
  "attaching",
  "idle",
  "dispatching",
  "running",
  "awaiting_interaction",
  "retrying",
  "compacting",
  "quiescing",
  "reconciling",
  "terminal",
  "outcome_unknown",
] as const;
export const runtimePhaseSchema = z.enum(runtimePhaseValues);
export type RuntimePhase = z.infer<typeof runtimePhaseSchema>;

export const runtimeMutationPolicyValues = [
  "enabled",
  "staged_read_only",
] as const;
export const runtimeMutationPolicySchema = z.enum(runtimeMutationPolicyValues);
export type RuntimeMutationPolicy = z.infer<typeof runtimeMutationPolicySchema>;

export const sessionAdoptionStatusValues = [
  "prepared",
  "host_bound",
  "enabled",
] as const;
export const sessionAdoptionStatusSchema = z.enum(sessionAdoptionStatusValues);
export type SessionAdoptionStatus = z.infer<typeof sessionAdoptionStatusSchema>;

export const runtimeInstanceStatusValues = [
  "starting",
  "live",
  "stopped",
  "lost",
] as const;
export const runtimeInstanceStatusSchema = z.enum(runtimeInstanceStatusValues);
export type RuntimeInstanceStatus = z.infer<typeof runtimeInstanceStatusSchema>;

/**
 * One process or endpoint incarnation. A PID may be recorded as evidence by an
 * adapter, but it is intentionally not part of this identity contract.
 */
export const runtimeInstanceSchema = z
  .object({
    bootNonce: z.string().min(16),
    connectorId: z.string().min(1),
    endpointFingerprint: z.string().min(1),
    hostId: z.string().min(1),
    id: z.string().min(1),
    providerInstanceId: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    status: runtimeInstanceStatusSchema,
    stoppedAt: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((runtime, context) => {
    const isStopped = runtime.status === "stopped";
    if (isStopped !== (runtime.stoppedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "stoppedAt must be set exactly when status is stopped",
        path: ["stoppedAt"],
      });
    }
  });
export type RuntimeInstance = z.infer<typeof runtimeInstanceSchema>;

export const workspaceExternalSideEffectStatusValues = [
  "not_observed",
  "known",
  "unknown",
] as const;
export const workspaceExternalSideEffectStatusSchema = z.enum(
  workspaceExternalSideEffectStatusValues,
);
export type WorkspaceExternalSideEffectStatus = z.infer<
  typeof workspaceExternalSideEffectStatusSchema
>;

export const workspaceBackgroundResourceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["agent", "command", "server", "workflow", "unknown"]),
    status: z.enum(["active", "settled", "unknown"]),
  })
  .strict();
export type WorkspaceBackgroundResource = z.infer<
  typeof workspaceBackgroundResourceSchema
>;

/**
 * A reconciliation checkpoint. Digests are opaque, versioned values produced
 * by the host; equality is meaningful only when their corresponding algorithm
 * identifiers match.
 */
export const sessionWorkspaceStateSchema = z
  .object({
    backgroundResources: z.array(workspaceBackgroundResourceSchema),
    capturedAt: z.number().int().nonnegative(),
    diffDigest: z.string().min(1),
    digestAlgorithm: z.string().min(1),
    externalSideEffectStatus: workspaceExternalSideEffectStatusSchema,
    headSha: z.string().min(1).nullable(),
    hostId: z.string().min(1),
    id: z.string().min(1),
    indexDigest: z.string().min(1),
    rootPath: z.string().min(1),
    untrackedManifestDigest: z.string().min(1),
    watcherGeneration: z.number().int().nonnegative(),
    worktreeId: z.string().min(1),
  })
  .strict();
export type SessionWorkspaceState = z.infer<typeof sessionWorkspaceStateSchema>;

/**
 * Reproducible runtime configuration without credential values. The named
 * references and fingerprints are resolved only by the owning host daemon.
 */
export const runtimeRecipeSchema = z
  .object({
    cwd: z.string().min(1),
    environmentFingerprint: z.string().min(1),
    environmentReferenceIds: z.array(z.string().min(1)),
    id: z.string().min(1),
    mcpServersFingerprint: z.string().min(1),
    permissionMode: permissionModeSchema,
    pluginsFingerprint: z.string().min(1),
    sandboxProfile: z.string().min(1),
    toolsFingerprint: z.string().min(1),
    workspaceWriteRoots: z.array(z.string().min(1)),
  })
  .strict();
export type RuntimeRecipe = z.infer<typeof runtimeRecipeSchema>;

export const workstreamStatusValues = [
  "active",
  "completed",
  "abandoned",
] as const;
export const workstreamStatusSchema = z.enum(workstreamStatusValues);
export type WorkstreamStatus = z.infer<typeof workstreamStatusSchema>;

export const workstreamSchema = z
  .object({
    activeBranchId: z.string().min(1).nullable(),
    createdAt: z.number().int().nonnegative(),
    id: z.string().min(1),
    objective: z.string().min(1),
    projectId: z.string().min(1),
    status: workstreamStatusSchema,
    title: z.string().min(1),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type Workstream = z.infer<typeof workstreamSchema>;

export const workstreamBranchStatusValues = [
  "active",
  "inactive",
  "closed",
] as const;
export const workstreamBranchStatusSchema = z.enum(
  workstreamBranchStatusValues,
);
export type WorkstreamBranchStatus = z.infer<
  typeof workstreamBranchStatusSchema
>;

export const workstreamBranchSchema = z
  .object({
    activeBindingId: z.string().min(1).nullable(),
    createdAt: z.number().int().nonnegative(),
    id: z.string().min(1),
    parentBranchId: z.string().min(1).nullable(),
    status: workstreamBranchStatusSchema,
    workstreamId: z.string().min(1),
  })
  .strict();
export type WorkstreamBranch = z.infer<typeof workstreamBranchSchema>;

export const executionBindingSchema = z
  .object({
    closedAt: z.number().int().nonnegative().nullable(),
    controlEpoch: z.number().int().nonnegative(),
    id: z.string().min(1),
    nativeConversation: nativeConversationRefSchema,
    openedAt: z.number().int().nonnegative(),
    mutationPolicy: runtimeMutationPolicySchema,
    ownership: runtimeOwnershipSchema,
    phase: runtimePhaseSchema,
    runtimeInstanceId: z.string().min(1).nullable(),
    runtimeRecipeId: z.string().min(1),
    workspaceStateId: z.string().min(1),
    workstreamBranchId: z.string().min(1),
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      binding.phase === "persisted_only" &&
      binding.runtimeInstanceId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "persisted-only bindings cannot name a runtime instance",
        path: ["runtimeInstanceId"],
      });
    }
    if (
      binding.phase !== "persisted_only" &&
      binding.runtimeInstanceId === null
    ) {
      context.addIssue({
        code: "custom",
        message: "non-persisted bindings must name a runtime instance",
        path: ["runtimeInstanceId"],
      });
    }
  });
export type ExecutionBinding = z.infer<typeof executionBindingSchema>;

export const modelEpochSchema = z
  .object({
    billingRouteId: z.string().min(1),
    bindingId: z.string().min(1),
    effectiveAccount: providerAccountRefSchema.nullable(),
    effectiveModel: sessionModelRefSchema.nullable(),
    endedAt: z.number().int().nonnegative().nullable(),
    id: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
    requestedModel: sessionModelRefSchema,
    sequence: z.number().int().nonnegative(),
    serviceTier: serviceTierSchema,
    startedAt: z.number().int().nonnegative(),
  })
  .strict();
export type ModelEpoch = z.infer<typeof modelEpochSchema>;
