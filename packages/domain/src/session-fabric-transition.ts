import { z } from "zod";
import {
  nativeConversationRefSchema,
  sessionModelRefSchema,
  sessionWorkspaceStateSchema,
} from "./session-fabric-identity.js";
import { mutationAcceptanceSchema } from "./session-fabric-control.js";
import {
  permissionModeSchema,
  reasoningLevelSchema,
  serviceTierSchema,
} from "./shared-types.js";

export const sessionTransitionKindValues = [
  "model_change",
  "runtime_resume",
  "native_fork",
  "cross_provider_continuation",
  "recovery_fork",
] as const;
export const sessionTransitionKindSchema = z.enum(sessionTransitionKindValues);
export type SessionTransitionKind = z.infer<typeof sessionTransitionKindSchema>;

export const sourceControlDispositionValues = [
  "fenced",
  "verified_stopped",
  "unfenced",
] as const;
export const sourceControlDispositionSchema = z.enum(
  sourceControlDispositionValues,
);
export type SourceControlDisposition = z.infer<
  typeof sourceControlDispositionSchema
>;

export const destinationWorkspaceDispositionValues = [
  "source_worktree",
  "isolated_worktree",
] as const;
export const destinationWorkspaceDispositionSchema = z.enum(
  destinationWorkspaceDispositionValues,
);
export type DestinationWorkspaceDisposition = z.infer<
  typeof destinationWorkspaceDispositionSchema
>;

export const handoffTransitionPhaseValues = [
  "requested",
  "target_preflight",
  "source_ingress_frozen",
  "source_quiescing",
  "source_reconciling",
  "workspace_snapshot_captured",
  "capsule_built",
  "user_reviewed",
  "billing_and_permission_authorized",
  "destination_staging_read_only",
  "destination_staged_read_only",
  "destination_restating",
  "destination_restated_and_verified",
  "active_binding_swapped",
  "destination_enabling",
  "destination_mutation_enabled",
  "source_retired_or_detached",
  "aborted",
] as const;
export const handoffTransitionPhaseSchema = z.enum(
  handoffTransitionPhaseValues,
);
export type HandoffTransitionPhase = z.infer<
  typeof handoffTransitionPhaseSchema
>;

export const handoffTransitionSchema = z
  .object({
    createdAt: z.number().int().nonnegative(),
    destinationBindingId: z.string().min(1).nullable(),
    destinationEnvironmentId: z.string().min(1),
    destinationHostId: z.string().min(1),
    destinationModel: sessionModelRefSchema,
    destinationProviderId: z.string().min(1),
    destinationProviderInstanceId: z.string().min(1),
    destinationReasoningLevel: reasoningLevelSchema,
    destinationServiceTier: serviceTierSchema,
    destinationThreadId: z.string().min(1),
    destinationWorkspaceDisposition: destinationWorkspaceDispositionSchema,
    id: z.string().min(1),
    kind: sessionTransitionKindSchema,
    phase: handoffTransitionPhaseSchema,
    sourceControlDisposition: sourceControlDispositionSchema,
    sourceBindingId: z.string().min(1),
    sourceProviderId: z.string().min(1),
    updatedAt: z.number().int().nonnegative(),
    workstreamBranchId: z.string().min(1),
  })
  .strict();
export type HandoffTransition = z.infer<typeof handoffTransitionSchema>;

export const handoffAuthorizationEvidenceSchema = z
  .object({
    authorizedAt: z.number().int().nonnegative(),
    billingAuthorizationId: z.string().min(1).nullable(),
    billingRouteId: z.string().min(1),
    capsuleContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    destinationModel: sessionModelRefSchema,
    destinationProviderInstanceId: z.string().min(1),
    id: z.string().min(1),
    permissionMode: permissionModeSchema,
    policyVersion: z.number().int().positive(),
    transitionId: z.string().min(1),
  })
  .strict();
export type HandoffAuthorizationEvidence = z.infer<
  typeof handoffAuthorizationEvidenceSchema
>;

export const handoffTransitionLifecycleEventValues = [
  "start_target_preflight",
  "freeze_source_ingress",
  "begin_source_quiesce",
  "begin_source_reconcile",
  "capture_workspace_snapshot",
  "build_capsule",
  "confirm_user_review",
  "authorize_billing_and_permission",
  "begin_destination_stage",
  "stage_destination_read_only",
  "begin_destination_restatement",
  "verify_destination_restatement",
  "swap_active_binding",
  "begin_destination_enablement",
  "enable_destination_mutation",
  "retire_or_detach_source",
  "abort",
] as const;
export const handoffTransitionLifecycleEventSchema = z.enum(
  handoffTransitionLifecycleEventValues,
);
export type HandoffTransitionLifecycleEvent = z.infer<
  typeof handoffTransitionLifecycleEventSchema
>;

export const HANDOFF_TRANSITION_LIFECYCLE: Record<
  HandoffTransitionPhase,
  Partial<Record<HandoffTransitionLifecycleEvent, HandoffTransitionPhase>>
> = {
  requested: {
    start_target_preflight: "target_preflight",
    abort: "aborted",
  },
  target_preflight: {
    freeze_source_ingress: "source_ingress_frozen",
    abort: "aborted",
  },
  source_ingress_frozen: {
    begin_source_quiesce: "source_quiescing",
    abort: "aborted",
  },
  source_quiescing: {
    begin_source_reconcile: "source_reconciling",
    abort: "aborted",
  },
  source_reconciling: {
    capture_workspace_snapshot: "workspace_snapshot_captured",
    abort: "aborted",
  },
  workspace_snapshot_captured: {
    build_capsule: "capsule_built",
    abort: "aborted",
  },
  capsule_built: {
    confirm_user_review: "user_reviewed",
    abort: "aborted",
  },
  user_reviewed: {
    authorize_billing_and_permission: "billing_and_permission_authorized",
    abort: "aborted",
  },
  billing_and_permission_authorized: {
    begin_destination_stage: "destination_staging_read_only",
    abort: "aborted",
  },
  destination_staging_read_only: {
    stage_destination_read_only: "destination_staged_read_only",
    abort: "aborted",
  },
  destination_staged_read_only: {
    begin_destination_restatement: "destination_restating",
    abort: "aborted",
  },
  destination_restating: {
    verify_destination_restatement: "destination_restated_and_verified",
    abort: "aborted",
  },
  destination_restated_and_verified: {
    swap_active_binding: "active_binding_swapped",
    abort: "aborted",
  },
  active_binding_swapped: {
    begin_destination_enablement: "destination_enabling",
  },
  destination_enabling: {
    enable_destination_mutation: "destination_mutation_enabled",
  },
  destination_mutation_enabled: {
    retire_or_detach_source: "source_retired_or_detached",
  },
  source_retired_or_detached: {},
  aborted: {},
};

export type HandoffTransitionLifecycleEvaluation =
  | { to: HandoffTransitionPhase }
  | { noop: "illegal_transition"; detail: string };

export function evaluateHandoffTransitionLifecycle(args: {
  event: HandoffTransitionLifecycleEvent;
  phase: HandoffTransitionPhase;
}): HandoffTransitionLifecycleEvaluation {
  const to = HANDOFF_TRANSITION_LIFECYCLE[args.phase][args.event];
  if (to === undefined) {
    return {
      noop: "illegal_transition",
      detail: `no transition for ${args.event} from phase ${args.phase}`,
    };
  }
  return { to };
}

export const handoffSettlementIssueValues = [
  "active_tools",
  "provider_retry",
  "provider_compaction",
  "unresolved_interactions",
  "accepted_queue",
  "partial_edit",
  "active_background_resources",
  "unknown_background_resources",
  "unknown_external_side_effects",
  "outcome_unknown",
] as const;
export const handoffSettlementIssueSchema = z.enum(
  handoffSettlementIssueValues,
);
export type HandoffSettlementIssue = z.infer<
  typeof handoffSettlementIssueSchema
>;

export const handoffSettlementSnapshotSchema = z
  .object({
    acceptedQueueCount: z.number().int().nonnegative(),
    activeBackgroundResourceCount: z.number().int().nonnegative(),
    activeToolCount: z.number().int().nonnegative(),
    compacting: z.boolean(),
    externalSideEffectStatus: z.enum(["not_observed", "known", "unknown"]),
    outcomeUnknown: z.boolean(),
    partialEdit: z.boolean(),
    retrying: z.boolean(),
    unknownBackgroundResourceCount: z.number().int().nonnegative(),
    unresolvedInteractionCount: z.number().int().nonnegative(),
  })
  .strict();
export type HandoffSettlementSnapshot = z.infer<
  typeof handoffSettlementSnapshotSchema
>;

export function findHandoffSettlementIssues(
  snapshot: HandoffSettlementSnapshot,
): HandoffSettlementIssue[] {
  const issues: HandoffSettlementIssue[] = [];
  if (snapshot.activeToolCount > 0) issues.push("active_tools");
  if (snapshot.retrying) issues.push("provider_retry");
  if (snapshot.compacting) issues.push("provider_compaction");
  if (snapshot.unresolvedInteractionCount > 0) {
    issues.push("unresolved_interactions");
  }
  if (snapshot.acceptedQueueCount > 0) issues.push("accepted_queue");
  if (snapshot.partialEdit) issues.push("partial_edit");
  if (snapshot.activeBackgroundResourceCount > 0) {
    issues.push("active_background_resources");
  }
  if (snapshot.unknownBackgroundResourceCount > 0) {
    issues.push("unknown_background_resources");
  }
  if (snapshot.externalSideEffectStatus === "unknown") {
    issues.push("unknown_external_side_effects");
  }
  if (snapshot.outcomeUnknown) issues.push("outcome_unknown");
  return issues;
}

export const destinationMutationGateIssueValues = [
  "binding_not_swapped",
  "destination_not_restated",
  "billing_not_authorized",
  "workspace_identity_mismatch",
  "workspace_head_mismatch",
  "workspace_index_mismatch",
  "workspace_diff_mismatch",
  "workspace_untracked_manifest_mismatch",
  "unfenced_shared_worktree",
] as const;
export const destinationMutationGateIssueSchema = z.enum(
  destinationMutationGateIssueValues,
);
export type DestinationMutationGateIssue = z.infer<
  typeof destinationMutationGateIssueSchema
>;

export interface DestinationMutationGateSnapshot {
  actualWorkspaceState: z.infer<typeof sessionWorkspaceStateSchema>;
  billingAuthorized: boolean;
  destinationRestated: boolean;
  destinationWorkspaceDisposition: DestinationWorkspaceDisposition;
  expectedWorkspaceState: z.infer<typeof sessionWorkspaceStateSchema>;
  sourceControlDisposition: SourceControlDisposition;
  transitionPhase: HandoffTransitionPhase;
}

/** Workspace equality is necessary but never treated as side-effect rollback. */
export function findDestinationMutationGateIssues(
  snapshot: DestinationMutationGateSnapshot,
): DestinationMutationGateIssue[] {
  const issues: DestinationMutationGateIssue[] = [];
  const expected = snapshot.expectedWorkspaceState;
  const actual = snapshot.actualWorkspaceState;
  if (
    snapshot.transitionPhase !== "active_binding_swapped" &&
    snapshot.transitionPhase !== "destination_enabling"
  ) {
    issues.push("binding_not_swapped");
  }
  if (!snapshot.destinationRestated) {
    issues.push("destination_not_restated");
  }
  if (!snapshot.billingAuthorized) {
    issues.push("billing_not_authorized");
  }
  if (
    expected.hostId !== actual.hostId ||
    expected.rootPath !== actual.rootPath ||
    expected.worktreeId !== actual.worktreeId ||
    expected.digestAlgorithm !== actual.digestAlgorithm
  ) {
    issues.push("workspace_identity_mismatch");
  }
  if (expected.headSha !== actual.headSha) {
    issues.push("workspace_head_mismatch");
  }
  if (expected.indexDigest !== actual.indexDigest) {
    issues.push("workspace_index_mismatch");
  }
  if (expected.diffDigest !== actual.diffDigest) {
    issues.push("workspace_diff_mismatch");
  }
  if (expected.untrackedManifestDigest !== actual.untrackedManifestDigest) {
    issues.push("workspace_untracked_manifest_mismatch");
  }
  if (
    snapshot.sourceControlDisposition === "unfenced" &&
    snapshot.destinationWorkspaceDisposition === "source_worktree"
  ) {
    issues.push("unfenced_shared_worktree");
  }
  return issues;
}

export const contextCapsuleEvidenceSchema = z
  .object({
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    kind: z.enum([
      "turn",
      "tool_result",
      "test_result",
      "failure",
      "decision",
      "workspace_reference",
    ]),
    nativeCursor: z.string().min(1).nullable(),
    provenance: z.string().min(1),
    trust: z.literal("untrusted_evidence"),
  })
  .strict();
export type ContextCapsuleEvidence = z.infer<
  typeof contextCapsuleEvidenceSchema
>;

export const contextCapsuleTransferActionValues = [
  "transfer",
  "drop",
  "redact",
] as const;
export const contextCapsuleTransferActionSchema = z.enum(
  contextCapsuleTransferActionValues,
);
export type ContextCapsuleTransferAction = z.infer<
  typeof contextCapsuleTransferActionSchema
>;

export const contextCapsuleTransferItemSchema = z
  .object({
    action: contextCapsuleTransferActionSchema,
    contentHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    kind: z.enum([
      "message",
      "tool_output",
      "instruction",
      "approval",
      "permission",
      "credential",
      "reasoning",
      "provider_cache",
      "process_handle",
      "workspace_reference",
    ]),
    reason: z.string().min(1),
  })
  .strict()
  .superRefine((item, context) => {
    const nonTransferableKinds = new Set([
      "approval",
      "permission",
      "credential",
      "reasoning",
      "provider_cache",
      "process_handle",
    ]);
    if (nonTransferableKinds.has(item.kind) && item.action !== "drop") {
      context.addIssue({
        code: "custom",
        message: `${item.kind} must be dropped at a provider boundary`,
        path: ["action"],
      });
    }
    if (item.action !== "drop" && item.contentHash === null) {
      context.addIssue({
        code: "custom",
        message: `${item.action} items must identify their transferred content`,
        path: ["contentHash"],
      });
    }
  });
export type ContextCapsuleTransferItem = z.infer<
  typeof contextCapsuleTransferItemSchema
>;

export const contextCapsuleSchema = z
  .object({
    ambiguities: z.array(z.string().min(1).max(32_768)).max(200),
    constraints: z.array(z.string().min(1).max(32_768)).max(200),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    createdAt: z.number().int().nonnegative(),
    decisions: z.array(z.string().min(1).max(32_768)).max(200),
    destinationToolDifferences: z.array(z.string().min(1).max(32_768)).max(200),
    evidence: z.array(contextCapsuleEvidenceSchema).max(1_000),
    expectedWorkspaceState: sessionWorkspaceStateSchema,
    failureAcceptance: mutationAcceptanceSchema.nullable(),
    id: z.string().min(1),
    instructions: z.array(z.string().min(1).max(32_768)).max(200),
    objective: z.string().min(1).max(131_072),
    openTasks: z.array(z.string().min(1).max(32_768)).max(500),
    plan: z.array(z.string().min(1).max(32_768)).max(500),
    rejectedApproaches: z.array(z.string().min(1).max(32_768)).max(200),
    schemaVersion: z.literal(1),
    sensitivityLabels: z.array(z.string().min(1).max(256)).max(100),
    sourceConversation: nativeConversationRefSchema,
    successCriteria: z.array(z.string().min(1).max(32_768)).max(200),
    transferManifest: z.array(contextCapsuleTransferItemSchema).max(1_000),
    transitionId: z.string().min(1),
    unresolvedSideEffects: z.array(z.string().min(1).max(32_768)).max(200),
  })
  .strict();
export type ContextCapsule = z.infer<typeof contextCapsuleSchema>;

type ContextCapsuleHashPayload = Omit<ContextCapsule, "contentHash">;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

/** Canonical bytes hashed by the server when sealing an immutable capsule. */
export function serializeContextCapsuleForHash(
  capsule: ContextCapsuleHashPayload,
): string {
  return JSON.stringify(canonicalJsonValue(capsule));
}

export const contextCapsuleSensitiveMaterialKindValues = [
  "private_key",
  "bearer_token",
  "provider_token",
  "cloud_access_key",
  "secret_assignment",
] as const;
export type ContextCapsuleSensitiveMaterialKind =
  (typeof contextCapsuleSensitiveMaterialKindValues)[number];

const CONTEXT_CAPSULE_SENSITIVE_PATTERNS: ReadonlyArray<{
  kind: ContextCapsuleSensitiveMaterialKind;
  pattern: RegExp;
}> = [
  { kind: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { kind: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/iu },
  {
    kind: "provider_token",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u,
  },
  { kind: "cloud_access_key", pattern: /\bAKIA[A-Z0-9]{16}\b/u },
  {
    kind: "secret_assignment",
    pattern:
      /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/iu,
  },
];

/** Returns finding categories only; it never returns or logs matched secrets. */
export function findContextCapsuleSensitiveMaterial(
  capsule: ContextCapsule,
): ContextCapsuleSensitiveMaterialKind[] {
  const serialized = JSON.stringify(capsule);
  return CONTEXT_CAPSULE_SENSITIVE_PATTERNS.filter(({ pattern }) =>
    pattern.test(serialized),
  ).map(({ kind }) => kind);
}

export const contextCapsuleWorkspaceDigestSchema = z
  .object({
    diffDigest: z.string().min(1),
    digestAlgorithm: z.string().min(1),
    headSha: z.string().min(1).nullable(),
    indexDigest: z.string().min(1),
    rootPath: z.string().min(1),
    untrackedManifestDigest: z.string().min(1),
    worktreeId: z.string().min(1),
  })
  .strict();
export type ContextCapsuleWorkspaceDigest = z.infer<
  typeof contextCapsuleWorkspaceDigestSchema
>;

export const contextCapsuleRestatementSchema = z
  .object({
    ambiguities: z.array(z.string().min(1).max(32_768)).max(200),
    capsuleContentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    constraints: z.array(z.string().min(1).max(32_768)).max(200),
    decisions: z.array(z.string().min(1).max(32_768)).max(200),
    destinationToolDifferences: z.array(z.string().min(1).max(32_768)).max(200),
    expectedWorkspace: contextCapsuleWorkspaceDigestSchema,
    objective: z.string().min(1).max(131_072),
    openTasks: z.array(z.string().min(1).max(32_768)).max(500),
  })
  .strict();
export type ContextCapsuleRestatement = z.infer<
  typeof contextCapsuleRestatementSchema
>;

export const contextCapsuleRestatementIssueValues = [
  "capsule_hash_mismatch",
  "objective_mismatch",
  "constraints_mismatch",
  "decisions_mismatch",
  "open_tasks_mismatch",
  "ambiguities_mismatch",
  "workspace_digest_mismatch",
  "destination_tools_mismatch",
] as const;
export type ContextCapsuleRestatementIssue =
  (typeof contextCapsuleRestatementIssueValues)[number];

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function contextCapsuleWorkspaceDigest(
  workspace: z.infer<typeof sessionWorkspaceStateSchema>,
): ContextCapsuleWorkspaceDigest {
  return {
    diffDigest: workspace.diffDigest,
    digestAlgorithm: workspace.digestAlgorithm,
    headSha: workspace.headSha,
    indexDigest: workspace.indexDigest,
    rootPath: workspace.rootPath,
    untrackedManifestDigest: workspace.untrackedManifestDigest,
    worktreeId: workspace.worktreeId,
  };
}

export function findContextCapsuleRestatementIssues(
  capsule: ContextCapsule,
  restatement: ContextCapsuleRestatement,
): ContextCapsuleRestatementIssue[] {
  const issues: ContextCapsuleRestatementIssue[] = [];
  if (restatement.capsuleContentHash !== capsule.contentHash) {
    issues.push("capsule_hash_mismatch");
  }
  if (restatement.objective !== capsule.objective) {
    issues.push("objective_mismatch");
  }
  if (!sameJson(restatement.constraints, capsule.constraints)) {
    issues.push("constraints_mismatch");
  }
  if (!sameJson(restatement.decisions, capsule.decisions)) {
    issues.push("decisions_mismatch");
  }
  if (!sameJson(restatement.openTasks, capsule.openTasks)) {
    issues.push("open_tasks_mismatch");
  }
  if (!sameJson(restatement.ambiguities, capsule.ambiguities)) {
    issues.push("ambiguities_mismatch");
  }
  if (
    !sameJson(
      restatement.expectedWorkspace,
      contextCapsuleWorkspaceDigest(capsule.expectedWorkspaceState),
    )
  ) {
    issues.push("workspace_digest_mismatch");
  }
  if (
    !sameJson(
      restatement.destinationToolDifferences,
      capsule.destinationToolDifferences,
    )
  ) {
    issues.push("destination_tools_mismatch");
  }
  return issues;
}
