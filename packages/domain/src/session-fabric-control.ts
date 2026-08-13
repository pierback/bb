import { z } from "zod";
import { permissionModeRank, permissionModeSchema } from "./shared-types.js";
import {
  providerAccountRefSchema,
  runtimeOwnershipSchema,
  runtimePhaseSchema,
  sessionModelRefSchema,
  type RuntimeOwnership,
  type RuntimePhase,
  type SessionModelRef,
} from "./session-fabric-identity.js";

export const sessionCapabilityKindValues = [
  "discover",
  "read_history",
  "observe_runtime",
  "acquire_live_control",
  "execute",
  "quiesce",
  "release",
  "change_model",
  "resume",
  "fork",
] as const;
export const sessionCapabilityKindSchema = z.enum(sessionCapabilityKindValues);
export type SessionCapabilityKind = z.infer<typeof sessionCapabilityKindSchema>;

export const sessionCapabilityAuthorityValues = [
  "read_only",
  "shared_control",
  "exclusive_control",
] as const;
export const sessionCapabilityAuthoritySchema = z.enum(
  sessionCapabilityAuthorityValues,
);
export type SessionCapabilityAuthority = z.infer<
  typeof sessionCapabilityAuthoritySchema
>;

export const sessionCapabilityStabilityValues = [
  "stable",
  "experimental",
  "private",
] as const;
export const sessionCapabilityStabilitySchema = z.enum(
  sessionCapabilityStabilityValues,
);
export type SessionCapabilityStability = z.infer<
  typeof sessionCapabilityStabilitySchema
>;

export const sessionCapabilityIdempotencyValues = [
  "read_only",
  "broker_at_most_once",
  "provider_idempotency_key",
  "none",
] as const;
export const sessionCapabilityIdempotencySchema = z.enum(
  sessionCapabilityIdempotencyValues,
);
export type SessionCapabilityIdempotency = z.infer<
  typeof sessionCapabilityIdempotencySchema
>;

/** A time-bounded fact, not a permanent provider feature flag. */
export const sessionCapabilityEvidenceSchema = z
  .object({
    authority: sessionCapabilityAuthoritySchema,
    detail: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    idempotency: sessionCapabilityIdempotencySchema,
    kind: sessionCapabilityKindSchema,
    observedAt: z.number().int().nonnegative(),
    preconditions: z.array(z.string().min(1)),
    source: z.string().min(1),
    stability: sessionCapabilityStabilitySchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.expiresAt <= evidence.observedAt) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must be later than observedAt",
        path: ["expiresAt"],
      });
    }
  });
export type SessionCapabilityEvidence = z.infer<
  typeof sessionCapabilityEvidenceSchema
>;

export const billingAuthClassValues = [
  "subscription",
  "api_key",
  "cloud_account",
  "unknown",
] as const;
export const billingAuthClassSchema = z.enum(billingAuthClassValues);
export type BillingAuthClass = z.infer<typeof billingAuthClassSchema>;

export const billingPaymentClassValues = [
  "included_allowance",
  "metered",
  "prepaid",
  "unknown",
] as const;
export const billingPaymentClassSchema = z.enum(billingPaymentClassValues);
export type BillingPaymentClass = z.infer<typeof billingPaymentClassSchema>;

export const billingRouteSchema = z
  .object({
    accountFingerprint: z.string().min(1),
    accountLabel: z.string().min(1),
    authClass: billingAuthClassSchema,
    credentialGeneration: z.number().int().nonnegative(),
    id: z.string().min(1),
    paymentClass: billingPaymentClassSchema,
    priceFingerprint: z.string().min(1).nullable(),
    providerInstanceId: z.string().min(1),
  })
  .strict();
export type BillingRoute = z.infer<typeof billingRouteSchema>;

export const billingSpendLimitSchema = z
  .object({
    currency: z.string().length(3),
    micros: z.number().int().nonnegative(),
  })
  .strict();
export type BillingSpendLimit = z.infer<typeof billingSpendLimitSchema>;

export const billingAuthorizationSchema = z
  .object({
    allowedModelIds: z.array(z.string().min(1)).min(1),
    billingRouteId: z.string().min(1),
    credentialGeneration: z.number().int().nonnegative(),
    dailySpendLimit: billingSpendLimitSchema.nullable(),
    expiresAt: z.number().int().nonnegative(),
    id: z.string().min(1),
    initialSpendLimit: billingSpendLimitSchema.nullable(),
    permissionCeiling: permissionModeSchema,
    policyVersion: z.number().int().positive(),
    providerInstanceId: z.string().min(1),
    revokedAt: z.number().int().nonnegative().nullable(),
    sessionSpendLimit: billingSpendLimitSchema.nullable(),
    validFrom: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((authorization, context) => {
    if (authorization.expiresAt <= authorization.validFrom) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must be later than validFrom",
        path: ["expiresAt"],
      });
    }
  });
export type BillingAuthorization = z.infer<typeof billingAuthorizationSchema>;

export const mutationGuardSchema = z
  .object({
    billingAuthorizationId: z.string().min(1).nullable(),
    commandId: z.string().min(1),
    expectedBootNonce: z.string().min(16),
    expectedControlEpoch: z.number().int().nonnegative(),
    expectedEndpointFingerprint: z.string().min(1),
    expectedNativeCursor: z.string().min(1).nullable(),
    expectedPhase: runtimePhaseSchema,
    expectedProviderInstanceId: z.string().min(1),
    expectedRuntimeInstanceId: z.string().min(1),
    expectedTurnId: z.string().min(1).nullable(),
  })
  .strict();
export type MutationGuard = z.infer<typeof mutationGuardSchema>;

export interface MutationTargetSnapshot {
  billingAuthorization: BillingAuthorization | null;
  billingRoute: BillingRoute | null;
  bootNonce: string;
  controlEpoch: number;
  endpointFingerprint: string;
  nativeCursor: string | null;
  nowMs: number;
  ownership: RuntimeOwnership;
  permissionMode: z.infer<typeof permissionModeSchema>;
  phase: RuntimePhase;
  providerInstanceId: string;
  requestedModel: SessionModelRef;
  requiresBillingAuthorization: boolean;
  runtimeInstanceId: string;
  turnId: string | null;
}

export const mutationGuardRejectionReasonValues = [
  "ownership_not_controllable",
  "phase_not_mutable",
  "runtime_instance_mismatch",
  "boot_nonce_mismatch",
  "endpoint_fingerprint_mismatch",
  "control_epoch_mismatch",
  "phase_mismatch",
  "turn_mismatch",
  "native_cursor_mismatch",
  "billing_authorization_missing",
  "billing_authorization_mismatch",
  "billing_authorization_not_yet_valid",
  "billing_authorization_expired",
  "billing_authorization_revoked",
  "billing_route_missing",
  "billing_route_mismatch",
  "provider_instance_mismatch",
  "credential_generation_mismatch",
  "model_not_authorized",
  "permission_exceeds_authorization",
] as const;
export const mutationGuardRejectionReasonSchema = z.enum(
  mutationGuardRejectionReasonValues,
);
export type MutationGuardRejectionReason = z.infer<
  typeof mutationGuardRejectionReasonSchema
>;

export type MutationGuardEvaluation =
  | { ok: true }
  | {
      ok: false;
      reason: MutationGuardRejectionReason;
      detail: string;
    };

const CONTROLLABLE_OWNERSHIPS: ReadonlySet<RuntimeOwnership> = new Set([
  "owned_exclusive",
  "owned_brokered",
  "provider_shared",
  "cooperative_external",
]);

const MUTABLE_RUNTIME_PHASES: ReadonlySet<RuntimePhase> = new Set([
  "idle",
  "running",
  "awaiting_interaction",
  "retrying",
  "compacting",
]);

function mutationGuardRejected(
  reason: MutationGuardRejectionReason,
  detail: string,
): MutationGuardEvaluation {
  return { ok: false, reason, detail };
}

/**
 * Local fencing decision. The host broker must evaluate this immediately
 * before provider dispatch; an earlier server-side lease check is insufficient.
 */
export function evaluateMutationGuard(args: {
  guard: MutationGuard;
  target: MutationTargetSnapshot;
}): MutationGuardEvaluation {
  const { guard, target } = args;
  if (!CONTROLLABLE_OWNERSHIPS.has(target.ownership)) {
    return mutationGuardRejected(
      "ownership_not_controllable",
      `ownership ${target.ownership} is read-only`,
    );
  }
  if (!MUTABLE_RUNTIME_PHASES.has(target.phase)) {
    return mutationGuardRejected(
      "phase_not_mutable",
      `phase ${target.phase} does not accept mutations`,
    );
  }
  if (guard.expectedRuntimeInstanceId !== target.runtimeInstanceId) {
    return mutationGuardRejected(
      "runtime_instance_mismatch",
      "runtime instance changed",
    );
  }
  if (guard.expectedBootNonce !== target.bootNonce) {
    return mutationGuardRejected(
      "boot_nonce_mismatch",
      "runtime incarnation changed",
    );
  }
  if (guard.expectedEndpointFingerprint !== target.endpointFingerprint) {
    return mutationGuardRejected(
      "endpoint_fingerprint_mismatch",
      "provider control endpoint changed",
    );
  }
  if (guard.expectedProviderInstanceId !== target.providerInstanceId) {
    return mutationGuardRejected(
      "provider_instance_mismatch",
      "provider instance changed",
    );
  }
  if (guard.expectedControlEpoch !== target.controlEpoch) {
    return mutationGuardRejected(
      "control_epoch_mismatch",
      "control epoch changed",
    );
  }
  if (guard.expectedPhase !== target.phase) {
    return mutationGuardRejected("phase_mismatch", "runtime phase changed");
  }
  if (guard.expectedTurnId !== target.turnId) {
    return mutationGuardRejected("turn_mismatch", "active turn changed");
  }
  if (guard.expectedNativeCursor !== target.nativeCursor) {
    return mutationGuardRejected(
      "native_cursor_mismatch",
      "provider cursor changed",
    );
  }
  if (!target.requiresBillingAuthorization) {
    return { ok: true };
  }

  const authorization = target.billingAuthorization;
  if (authorization === null || guard.billingAuthorizationId === null) {
    return mutationGuardRejected(
      "billing_authorization_missing",
      "spend-bearing mutation requires billing authorization",
    );
  }
  if (guard.billingAuthorizationId !== authorization.id) {
    return mutationGuardRejected(
      "billing_authorization_mismatch",
      "billing authorization changed",
    );
  }
  if (target.nowMs < authorization.validFrom) {
    return mutationGuardRejected(
      "billing_authorization_not_yet_valid",
      "billing authorization is not yet valid",
    );
  }
  if (target.nowMs >= authorization.expiresAt) {
    return mutationGuardRejected(
      "billing_authorization_expired",
      "billing authorization expired",
    );
  }
  if (authorization.revokedAt !== null) {
    return mutationGuardRejected(
      "billing_authorization_revoked",
      "billing authorization was revoked",
    );
  }
  const route = target.billingRoute;
  if (route === null) {
    return mutationGuardRejected(
      "billing_route_missing",
      "authorized billing route is unavailable",
    );
  }
  if (authorization.billingRouteId !== route.id) {
    return mutationGuardRejected(
      "billing_route_mismatch",
      "billing route changed",
    );
  }
  if (
    authorization.providerInstanceId !== target.providerInstanceId ||
    route.providerInstanceId !== target.providerInstanceId
  ) {
    return mutationGuardRejected(
      "provider_instance_mismatch",
      "provider instance changed",
    );
  }
  if (authorization.credentialGeneration !== route.credentialGeneration) {
    return mutationGuardRejected(
      "credential_generation_mismatch",
      "provider credentials changed",
    );
  }
  if (!authorization.allowedModelIds.includes(target.requestedModel.modelId)) {
    return mutationGuardRejected(
      "model_not_authorized",
      `model ${target.requestedModel.modelId} is not authorized`,
    );
  }
  if (
    permissionModeRank(target.permissionMode) >
    permissionModeRank(authorization.permissionCeiling)
  ) {
    return mutationGuardRejected(
      "permission_exceeds_authorization",
      "runtime permission exceeds the billing authorization ceiling",
    );
  }
  return { ok: true };
}

export const sessionCommandKindValues = [
  "execute",
  "steer",
  "interrupt",
  "respond_interaction",
  "change_model",
  "quiesce",
  "release",
] as const;
export const sessionCommandKindSchema = z.enum(sessionCommandKindValues);
export type SessionCommandKind = z.infer<typeof sessionCommandKindSchema>;

export const sessionCommandStatusValues = [
  "drafted",
  "authorized",
  "dispatched",
  "accepted",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "not_accepted",
  "outcome_unknown",
] as const;
export const sessionCommandStatusSchema = z.enum(sessionCommandStatusValues);
export type SessionCommandStatus = z.infer<typeof sessionCommandStatusSchema>;

export const sessionCommandSchema = z
  .object({
    bindingId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    guard: mutationGuardSchema,
    id: z.string().min(1),
    kind: sessionCommandKindSchema,
    modelEpochId: z.string().min(1).nullable(),
    payloadHash: z.string().min(1),
    status: sessionCommandStatusSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.guard.commandId !== command.id) {
      context.addIssue({
        code: "custom",
        message: "guard commandId must match command id",
        path: ["guard", "commandId"],
      });
    }
  });
export type SessionCommand = z.infer<typeof sessionCommandSchema>;

export const sessionCommandLifecycleEventValues = [
  "authorize",
  "dispatch",
  "accept",
  "start_running",
  "succeed",
  "fail",
  "interrupt",
  "reject_before_acceptance",
  "lose_outcome",
] as const;
export const sessionCommandLifecycleEventSchema = z.enum(
  sessionCommandLifecycleEventValues,
);
export type SessionCommandLifecycleEvent = z.infer<
  typeof sessionCommandLifecycleEventSchema
>;

export const SESSION_COMMAND_LIFECYCLE: Record<
  SessionCommandStatus,
  Partial<Record<SessionCommandLifecycleEvent, SessionCommandStatus>>
> = {
  drafted: { authorize: "authorized" },
  authorized: { dispatch: "dispatched" },
  dispatched: {
    accept: "accepted",
    reject_before_acceptance: "not_accepted",
    lose_outcome: "outcome_unknown",
  },
  accepted: {
    start_running: "running",
    succeed: "succeeded",
    fail: "failed",
    interrupt: "interrupted",
    lose_outcome: "outcome_unknown",
  },
  running: {
    succeed: "succeeded",
    fail: "failed",
    interrupt: "interrupted",
    lose_outcome: "outcome_unknown",
  },
  succeeded: {},
  failed: {},
  interrupted: {},
  not_accepted: {},
  outcome_unknown: {},
};

export type SessionCommandLifecycleEvaluation =
  | { to: SessionCommandStatus }
  | { noop: "illegal_transition"; detail: string };

export function evaluateSessionCommandLifecycle(args: {
  event: SessionCommandLifecycleEvent;
  status: SessionCommandStatus;
}): SessionCommandLifecycleEvaluation {
  const to = SESSION_COMMAND_LIFECYCLE[args.status][args.event];
  if (to === undefined) {
    return {
      noop: "illegal_transition",
      detail: `no transition for ${args.event} from status ${args.status}`,
    };
  }
  return { to };
}

export const mutationAcceptanceValues = [
  "not_accepted",
  "accepted",
  "outcome_unknown",
] as const;
export const mutationAcceptanceSchema = z.enum(mutationAcceptanceValues);
export type MutationAcceptance = z.infer<typeof mutationAcceptanceSchema>;

export const mutationReceiptSchema = z
  .object({
    acceptance: mutationAcceptanceSchema,
    diagnostic: z.string().min(1).nullable(),
    effectiveAccount: providerAccountRefSchema.nullable(),
    effectiveModel: sessionModelRefSchema.nullable(),
    observedCursor: z.string().min(1).nullable(),
    providerRequestId: z.string().min(1).nullable(),
    providerTurnId: z.string().min(1).nullable(),
    requestedModel: sessionModelRefSchema.nullable(),
  })
  .strict();
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;

export function outcomeUnknownReceipt(args: {
  diagnostic: string;
  providerRequestId?: string;
  requestedModel?: SessionModelRef;
}): MutationReceipt {
  return {
    acceptance: "outcome_unknown",
    diagnostic: args.diagnostic,
    effectiveAccount: null,
    effectiveModel: null,
    observedCursor: null,
    providerRequestId: args.providerRequestId ?? null,
    providerTurnId: null,
    requestedModel: args.requestedModel ?? null,
  };
}

export function runtimeOwnershipAllowsMutation(
  ownership: z.infer<typeof runtimeOwnershipSchema>,
): boolean {
  return CONTROLLABLE_OWNERSHIPS.has(ownership);
}

export function runtimePhaseAllowsMutation(phase: RuntimePhase): boolean {
  return MUTABLE_RUNTIME_PHASES.has(phase);
}

export const runtimePhaseLifecycleEventValues = [
  "discover_live",
  "begin_attach",
  "attach_ready",
  "begin_dispatch",
  "command_accepted",
  "command_completed",
  "command_outcome_unknown",
  "command_rejected",
  "request_interaction",
  "resolve_interaction",
  "schedule_retry",
  "resume_retry",
  "begin_compaction",
  "finish_compaction",
  "settle_turn",
  "begin_quiesce",
  "begin_reconcile",
  "finish_reconcile",
  "stop",
  "runtime_lost",
] as const;
export const runtimePhaseLifecycleEventSchema = z.enum(
  runtimePhaseLifecycleEventValues,
);
export type RuntimePhaseLifecycleEvent = z.infer<
  typeof runtimePhaseLifecycleEventSchema
>;

export const RUNTIME_PHASE_LIFECYCLE: Record<
  RuntimePhase,
  Partial<Record<RuntimePhaseLifecycleEvent, RuntimePhase>>
> = {
  persisted_only: {
    discover_live: "observed_live",
    begin_attach: "attaching",
    stop: "terminal",
  },
  observed_live: {
    begin_attach: "attaching",
    stop: "terminal",
    runtime_lost: "terminal",
  },
  attaching: {
    attach_ready: "idle",
    stop: "terminal",
    runtime_lost: "terminal",
  },
  idle: {
    begin_dispatch: "dispatching",
    begin_quiesce: "quiescing",
    stop: "terminal",
    runtime_lost: "terminal",
  },
  dispatching: {
    command_accepted: "running",
    command_completed: "idle",
    command_outcome_unknown: "outcome_unknown",
    command_rejected: "idle",
    stop: "terminal",
    runtime_lost: "outcome_unknown",
  },
  running: {
    request_interaction: "awaiting_interaction",
    schedule_retry: "retrying",
    begin_compaction: "compacting",
    settle_turn: "idle",
    begin_quiesce: "quiescing",
    stop: "terminal",
    runtime_lost: "outcome_unknown",
  },
  awaiting_interaction: {
    resolve_interaction: "running",
    settle_turn: "idle",
    begin_quiesce: "quiescing",
    stop: "terminal",
    runtime_lost: "outcome_unknown",
  },
  retrying: {
    resume_retry: "running",
    settle_turn: "idle",
    begin_quiesce: "quiescing",
    stop: "terminal",
    runtime_lost: "outcome_unknown",
  },
  compacting: {
    finish_compaction: "running",
    settle_turn: "idle",
    begin_quiesce: "quiescing",
    stop: "terminal",
    runtime_lost: "outcome_unknown",
  },
  quiescing: {
    begin_reconcile: "reconciling",
    stop: "terminal",
    runtime_lost: "outcome_unknown",
  },
  reconciling: {
    finish_reconcile: "idle",
    stop: "terminal",
    runtime_lost: "outcome_unknown",
  },
  terminal: {},
  outcome_unknown: {
    begin_reconcile: "reconciling",
    stop: "terminal",
  },
};

export type RuntimePhaseLifecycleEvaluation =
  | { to: RuntimePhase }
  | { noop: "illegal_transition"; detail: string };

export function evaluateRuntimePhaseLifecycle(args: {
  event: RuntimePhaseLifecycleEvent;
  phase: RuntimePhase;
}): RuntimePhaseLifecycleEvaluation {
  const to = RUNTIME_PHASE_LIFECYCLE[args.phase][args.event];
  if (to === undefined) {
    return {
      noop: "illegal_transition",
      detail: `no transition for ${args.event} from phase ${args.phase}`,
    };
  }
  return { to };
}
