import { z } from "zod";
import {
  contextCapsuleRestatementSchema,
  contextCapsuleSchema,
  destinationWorkspaceDispositionSchema,
  handoffAuthorizationEvidenceSchema,
  handoffSettlementSnapshotSchema,
  handoffTransitionLifecycleEventSchema,
  handoffTransitionPhaseSchema,
  handoffTransitionSchema,
  modelEpochSchema,
  mutationReceiptSchema,
  nativeConversationRefSchema,
  providerSessionDiscoveryScanSchema,
  reasoningLevelSchema,
  runtimeInstanceStatusSchema,
  runtimeMutationPolicySchema,
  runtimeOwnershipSchema,
  runtimePhaseSchema,
  serviceTierSchema,
  sessionAdoptionStatusSchema,
  sessionCommandLifecycleEventSchema,
  sessionCommandSchema,
  sessionCommandStatusSchema,
  sessionModelRefSchema,
} from "@bb/domain";

export const sessionFabricModelChangeRequestSchema = z
  .object({
    reasoningLevel: reasoningLevelSchema,
    requestedModel: sessionModelRefSchema,
    serviceTier: serviceTierSchema,
  })
  .strict();
export type SessionFabricModelChangeRequest = z.infer<
  typeof sessionFabricModelChangeRequestSchema
>;

export const sessionFabricModelChangeResponseSchema = z
  .object({
    command: sessionCommandSchema,
    modelEpoch: modelEpochSchema.nullable(),
    receipt: mutationReceiptSchema,
  })
  .strict();
export type SessionFabricModelChangeResponse = z.infer<
  typeof sessionFabricModelChangeResponseSchema
>;

export const sessionFabricCommandEventSchema = z
  .object({
    commandId: z.string().min(1),
    event: sessionCommandLifecycleEventSchema,
    fromStatus: sessionCommandStatusSchema,
    id: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    toStatus: sessionCommandStatusSchema,
  })
  .strict();
export type SessionFabricCommandEvent = z.infer<
  typeof sessionFabricCommandEventSchema
>;

export const sessionFabricCommandAuditResponseSchema = z
  .object({
    command: sessionCommandSchema,
    events: z.array(sessionFabricCommandEventSchema),
    modelEpoch: modelEpochSchema.nullable(),
    receipt: mutationReceiptSchema.nullable(),
  })
  .strict();
export type SessionFabricCommandAuditResponse = z.infer<
  typeof sessionFabricCommandAuditResponseSchema
>;

export const sessionFabricDiscoveryProviderCursorSchema = z
  .object({
    cursor: z.string().min(1),
    providerId: z.string().min(1),
    providerInstanceId: z.string().min(1),
  })
  .strict();
export type SessionFabricDiscoveryProviderCursor = z.infer<
  typeof sessionFabricDiscoveryProviderCursorSchema
>;

export const sessionFabricDiscoveryRequestSchema = z
  .object({
    hostId: z.string().min(1),
    includeUnmapped: z.boolean(),
    limitPerProvider: z.number().int().min(1).max(200),
    projectIds: z.array(z.string().min(1)).max(200),
    providerCursors: z
      .array(sessionFabricDiscoveryProviderCursorSchema)
      .max(200),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.projectIds).size !== request.projectIds.length) {
      context.addIssue({
        code: "custom",
        message: "projectIds must not contain duplicates",
        path: ["projectIds"],
      });
    }
  });
export type SessionFabricDiscoveryRequest = z.infer<
  typeof sessionFabricDiscoveryRequestSchema
>;

export const sessionFabricDiscoveryCatalogEntrySchema = z
  .object({
    catalogConversationId: z.string().min(1),
    nativeConversation: nativeConversationRefSchema,
    projectId: z.string().min(1).nullable(),
  })
  .strict();
export type SessionFabricDiscoveryCatalogEntry = z.infer<
  typeof sessionFabricDiscoveryCatalogEntrySchema
>;

export const sessionFabricDiscoveryResponseSchema = z
  .object({
    catalogEntries: z.array(sessionFabricDiscoveryCatalogEntrySchema),
    scans: z.array(providerSessionDiscoveryScanSchema),
  })
  .strict();
export type SessionFabricDiscoveryResponse = z.infer<
  typeof sessionFabricDiscoveryResponseSchema
>;

export const sessionFabricAdoptionRequestSchema = z
  .object({
    idempotencyKey: z.string().min(16).max(200),
    objective: z.string().min(1).max(10_000),
    threadId: z.string().min(1),
    title: z.string().min(1).max(500),
  })
  .strict();
export type SessionFabricAdoptionRequest = z.infer<
  typeof sessionFabricAdoptionRequestSchema
>;

export const sessionFabricAdoptionResponseSchema = z
  .object({
    adoptionId: z.string().min(1),
    bindingId: z.string().min(1),
    branchId: z.string().min(1),
    controlEpoch: z.number().int().nonnegative(),
    mutationPolicy: runtimeMutationPolicySchema,
    phase: runtimePhaseSchema,
    runtimeInstanceId: z.string().min(1),
    status: sessionAdoptionStatusSchema,
    threadId: z.string().min(1),
    workstreamId: z.string().min(1),
  })
  .strict();
export type SessionFabricAdoptionResponse = z.infer<
  typeof sessionFabricAdoptionResponseSchema
>;

export const sessionFabricConnectionSchema = z
  .object({
    adoptionStatus: sessionAdoptionStatusSchema.nullable(),
    bindingId: z.string().min(1),
    controlEpoch: z.number().int().nonnegative(),
    effectiveModel: sessionModelRefSchema.nullable(),
    environmentId: z.string().min(1).nullable(),
    isActiveAuthority: z.boolean(),
    mutationPolicy: runtimeMutationPolicySchema,
    nativeConversation: nativeConversationRefSchema.extend({
      catalogConversationId: z.string().min(1),
      cwd: z.string().min(1).nullable(),
      lastObservedAt: z.number().int().nonnegative(),
      providerState: z.string().min(1),
      title: z.string().min(1).nullable(),
    }),
    openedAt: z.number().int().nonnegative(),
    ownership: runtimeOwnershipSchema,
    phase: runtimePhaseSchema,
    reasoningLevel: reasoningLevelSchema.nullable(),
    runtime: z
      .object({
        id: z.string().min(1),
        status: runtimeInstanceStatusSchema,
      })
      .strict()
      .nullable(),
    serviceTier: serviceTierSchema.nullable(),
    threadId: z.string().min(1),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type SessionFabricConnection = z.infer<
  typeof sessionFabricConnectionSchema
>;

export const sessionFabricThreadConnectionResponseSchema = z
  .object({ connection: sessionFabricConnectionSchema.nullable() })
  .strict();
export type SessionFabricThreadConnectionResponse = z.infer<
  typeof sessionFabricThreadConnectionResponseSchema
>;

export const sessionFabricEnvironmentConnectionsResponseSchema = z
  .object({ connections: z.array(sessionFabricConnectionSchema) })
  .strict();
export type SessionFabricEnvironmentConnectionsResponse = z.infer<
  typeof sessionFabricEnvironmentConnectionsResponseSchema
>;

export const sessionFabricConnectRequestSchema = z.object({}).strict();
export type SessionFabricConnectRequest = z.infer<
  typeof sessionFabricConnectRequestSchema
>;

export const sessionFabricConnectResponseSchema = z
  .object({ connection: sessionFabricConnectionSchema })
  .strict();
export type SessionFabricConnectResponse = z.infer<
  typeof sessionFabricConnectResponseSchema
>;

export const sessionFabricContextCapsuleDraftSchema = contextCapsuleSchema
  .omit({
    contentHash: true,
    createdAt: true,
    expectedWorkspaceState: true,
    id: true,
    sourceConversation: true,
    transitionId: true,
  })
  .strict();
export type SessionFabricContextCapsuleDraft = z.infer<
  typeof sessionFabricContextCapsuleDraftSchema
>;

export const sessionFabricHandoffPrepareRequestSchema = z
  .object({
    capsule: sessionFabricContextCapsuleDraftSchema,
    destinationEnvironmentId: z.string().min(1),
    destinationHostId: z.string().min(1),
    destinationModel: sessionModelRefSchema,
    destinationProviderInstanceId: z.string().min(1),
    destinationReasoningLevel: reasoningLevelSchema,
    destinationServiceTier: serviceTierSchema,
    destinationThreadId: z.string().min(1),
    destinationWorkspaceDisposition: destinationWorkspaceDispositionSchema,
    idempotencyKey: z.string().min(16).max(200),
  })
  .strict();
export type SessionFabricHandoffPrepareRequest = z.infer<
  typeof sessionFabricHandoffPrepareRequestSchema
>;

export const sessionFabricHandoffPrepareResponseSchema = z
  .object({
    capsule: contextCapsuleSchema,
    transition: handoffTransitionSchema,
  })
  .strict();
export type SessionFabricHandoffPrepareResponse = z.infer<
  typeof sessionFabricHandoffPrepareResponseSchema
>;

export const sessionFabricHandoffActivateRequestSchema = z
  .object({
    capsuleContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    reviewerId: z.string().min(1),
  })
  .strict();
export type SessionFabricHandoffActivateRequest = z.infer<
  typeof sessionFabricHandoffActivateRequestSchema
>;

export const sessionFabricHandoffActivateResponseSchema = z
  .object({
    destinationBindingId: z.string().min(1),
    transition: handoffTransitionSchema,
  })
  .strict();
export type SessionFabricHandoffActivateResponse = z.infer<
  typeof sessionFabricHandoffActivateResponseSchema
>;

export const sessionFabricHandoffAbortRequestSchema = z.object({}).strict();
export type SessionFabricHandoffAbortRequest = z.infer<
  typeof sessionFabricHandoffAbortRequestSchema
>;

export const sessionFabricHandoffAbortResponseSchema = z
  .object({ transition: handoffTransitionSchema })
  .strict();
export type SessionFabricHandoffAbortResponse = z.infer<
  typeof sessionFabricHandoffAbortResponseSchema
>;

export const sessionFabricHandoffEventSchema = z
  .object({
    event: handoffTransitionLifecycleEventSchema,
    fromPhase: handoffTransitionPhaseSchema,
    id: z.string().min(1),
    occurredAt: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    toPhase: handoffTransitionPhaseSchema,
    transitionId: z.string().min(1),
  })
  .strict();

export const sessionFabricHandoffReviewSchema = z
  .object({
    capsuleContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    id: z.string().min(1),
    reviewedAt: z.number().int().nonnegative(),
    reviewerId: z.string().min(1),
    transitionId: z.string().min(1),
  })
  .strict();

export const sessionFabricHandoffRestatementEvidenceSchema = z
  .object({
    capsuleContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    destinationBindingId: z.string().min(1),
    id: z.string().min(1),
    observedWorkspaceStateId: z.string().min(1),
    restatement: contextCapsuleRestatementSchema,
    transitionId: z.string().min(1),
    verifiedAt: z.number().int().nonnegative(),
  })
  .strict();

export const sessionFabricHandoffSettlementEvidenceSchema = z
  .object({
    capturedAt: z.number().int().nonnegative(),
    id: z.string().min(1),
    snapshot: handoffSettlementSnapshotSchema,
    sourceControlDisposition: z.enum([
      "fenced",
      "verified_stopped",
      "unfenced",
    ]),
    sourceWorkspaceStateId: z.string().min(1),
    transitionId: z.string().min(1),
  })
  .strict();

export const sessionFabricHandoffAuditResponseSchema = z
  .object({
    authorization: handoffAuthorizationEvidenceSchema.nullable(),
    capsule: contextCapsuleSchema.nullable(),
    events: z.array(sessionFabricHandoffEventSchema),
    restatement: sessionFabricHandoffRestatementEvidenceSchema.nullable(),
    review: sessionFabricHandoffReviewSchema.nullable(),
    settlement: sessionFabricHandoffSettlementEvidenceSchema.nullable(),
    transition: handoffTransitionSchema,
  })
  .strict();
export type SessionFabricHandoffAuditResponse = z.infer<
  typeof sessionFabricHandoffAuditResponseSchema
>;
