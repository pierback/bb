import { describe, expect, it } from "vitest";
import {
  evaluateMutationGuard,
  evaluateRuntimePhaseLifecycle,
  evaluateSessionCommandLifecycle,
  outcomeUnknownReceipt,
  RUNTIME_PHASE_LIFECYCLE,
  runtimeOwnershipAllowsMutation,
  runtimePhaseLifecycleEventValues,
  SESSION_COMMAND_LIFECYCLE,
  sessionCapabilityEvidenceSchema,
  sessionCommandLifecycleEventValues,
  sessionCommandStatusValues,
  type BillingAuthorization,
  type BillingRoute,
  type MutationGuard,
  type MutationTargetSnapshot,
} from "../src/session-fabric-control.js";
import { runtimePhaseValues } from "../src/session-fabric-identity.js";

const billingRoute: BillingRoute = {
  accountFingerprint: "sha256:account",
  accountLabel: "Team account",
  authClass: "subscription",
  credentialGeneration: 3,
  id: "route_1",
  paymentClass: "included_allowance",
  priceFingerprint: "sha256:prices",
  providerInstanceId: "provider_instance_1",
};

const billingAuthorization: BillingAuthorization = {
  allowedModelIds: ["gpt-5.6-sol"],
  billingRouteId: billingRoute.id,
  credentialGeneration: 3,
  dailySpendLimit: null,
  expiresAt: 20_000,
  id: "billing_authorization_1",
  initialSpendLimit: null,
  permissionCeiling: "auto",
  policyVersion: 1,
  providerInstanceId: "provider_instance_1",
  revokedAt: null,
  sessionSpendLimit: null,
  validFrom: 1_000,
};

const guard: MutationGuard = {
  billingAuthorizationId: billingAuthorization.id,
  commandId: "command_1",
  expectedBootNonce: "boot_nonce_1234567890",
  expectedControlEpoch: 7,
  expectedEndpointFingerprint: "stdio:runtime_1",
  expectedNativeCursor: "cursor_10",
  expectedPhase: "idle",
  expectedProviderInstanceId: "provider_instance_1",
  expectedRuntimeInstanceId: "runtime_1",
  expectedTurnId: null,
};

const target: MutationTargetSnapshot = {
  billingAuthorization,
  billingRoute,
  bootNonce: guard.expectedBootNonce,
  controlEpoch: guard.expectedControlEpoch,
  endpointFingerprint: guard.expectedEndpointFingerprint,
  nativeCursor: guard.expectedNativeCursor,
  nowMs: 10_000,
  ownership: "owned_brokered",
  permissionMode: "auto",
  phase: guard.expectedPhase,
  providerInstanceId: "provider_instance_1",
  requestedModel: { modelId: "gpt-5.6-sol", providerId: "codex" },
  requiresBillingAuthorization: true,
  runtimeInstanceId: guard.expectedRuntimeInstanceId,
  turnId: guard.expectedTurnId,
};

describe("evaluateMutationGuard", () => {
  it("accepts an exact live-incarnation, epoch, cursor, and billing match", () => {
    expect(evaluateMutationGuard({ guard, target })).toEqual({ ok: true });
  });

  it.each([
    ["runtime_instance_mismatch", { runtimeInstanceId: "runtime_reused" }],
    ["boot_nonce_mismatch", { bootNonce: "other_boot_1234567890" }],
    [
      "endpoint_fingerprint_mismatch",
      { endpointFingerprint: "stdio:runtime_2" },
    ],
    ["control_epoch_mismatch", { controlEpoch: 8 }],
    ["phase_mismatch", { phase: "running" as const }],
    ["turn_mismatch", { turnId: "turn_2" }],
    ["native_cursor_mismatch", { nativeCursor: "cursor_11" }],
  ])("rejects %s before dispatch", (reason, override) => {
    expect(
      evaluateMutationGuard({ guard, target: { ...target, ...override } }),
    ).toMatchObject({ ok: false, reason });
  });

  it.each(["unfenced_external", "unknown"] as const)(
    "keeps %s runtimes read-only",
    (ownership) => {
      expect(
        evaluateMutationGuard({ guard, target: { ...target, ownership } }),
      ).toMatchObject({ ok: false, reason: "ownership_not_controllable" });
      expect(runtimeOwnershipAllowsMutation(ownership)).toBe(false);
    },
  );

  it.each(["persisted_only", "observed_live", "outcome_unknown"] as const)(
    "rejects mutations in %s phase",
    (phase) => {
      expect(
        evaluateMutationGuard({
          guard: { ...guard, expectedPhase: phase },
          target: { ...target, phase },
        }),
      ).toMatchObject({ ok: false, reason: "phase_not_mutable" });
    },
  );

  it("invalidates authorization when credentials, model, or permissions change", () => {
    expect(
      evaluateMutationGuard({
        guard,
        target: {
          ...target,
          billingRoute: { ...billingRoute, credentialGeneration: 4 },
        },
      }),
    ).toMatchObject({ ok: false, reason: "credential_generation_mismatch" });
    expect(
      evaluateMutationGuard({
        guard,
        target: {
          ...target,
          requestedModel: { modelId: "gpt-other", providerId: "codex" },
        },
      }),
    ).toMatchObject({ ok: false, reason: "model_not_authorized" });
    expect(
      evaluateMutationGuard({
        guard,
        target: { ...target, permissionMode: "full" },
      }),
    ).toMatchObject({
      ok: false,
      reason: "permission_exceeds_authorization",
    });
  });

  it("permits a non-spending control command without billing authorization", () => {
    expect(
      evaluateMutationGuard({
        guard: { ...guard, billingAuthorizationId: null },
        target: {
          ...target,
          billingAuthorization: null,
          billingRoute: null,
          requiresBillingAuthorization: false,
        },
      }),
    ).toEqual({ ok: true });
  });

  it("still fences provider identity for a non-spending command", () => {
    expect(
      evaluateMutationGuard({
        guard: { ...guard, billingAuthorizationId: null },
        target: {
          ...target,
          billingAuthorization: null,
          billingRoute: null,
          providerInstanceId: "provider_instance_2",
          requiresBillingAuthorization: false,
        },
      }),
    ).toMatchObject({ ok: false, reason: "provider_instance_mismatch" });
  });
});

describe("runtime phase lifecycle", () => {
  it("has one explicit table row for every runtime phase", () => {
    expect(Object.keys(RUNTIME_PHASE_LIFECYCLE).sort()).toEqual(
      [...runtimePhaseValues].sort(),
    );
  });

  it("accepts only declared phase edges", () => {
    for (const phase of runtimePhaseValues) {
      for (const event of runtimePhaseLifecycleEventValues) {
        const expected = RUNTIME_PHASE_LIFECYCLE[phase][event];
        const evaluation = evaluateRuntimePhaseLifecycle({ event, phase });
        if (expected === undefined) {
          expect(evaluation).toEqual({
            noop: "illegal_transition",
            detail: `no transition for ${event} from phase ${phase}`,
          });
        } else {
          expect(evaluation).toEqual({ to: expected });
        }
      }
    }
  });

  it("makes runtime loss outcome-unknown only after dispatch may have occurred", () => {
    expect(
      evaluateRuntimePhaseLifecycle({ event: "runtime_lost", phase: "idle" }),
    ).toEqual({ to: "terminal" });
    expect(
      evaluateRuntimePhaseLifecycle({
        event: "runtime_lost",
        phase: "dispatching",
      }),
    ).toEqual({ to: "outcome_unknown" });
  });

  it("settles an acknowledged configuration command without inventing a turn", () => {
    expect(
      evaluateRuntimePhaseLifecycle({
        event: "command_completed",
        phase: "dispatching",
      }),
    ).toEqual({ to: "idle" });
  });

  it("preserves an ambiguous configuration outcome for reconciliation", () => {
    expect(
      evaluateRuntimePhaseLifecycle({
        event: "command_outcome_unknown",
        phase: "dispatching",
      }),
    ).toEqual({ to: "outcome_unknown" });
  });
});

describe("session command lifecycle", () => {
  it("has one explicit table row for every command status", () => {
    expect(Object.keys(SESSION_COMMAND_LIFECYCLE).sort()).toEqual(
      [...sessionCommandStatusValues].sort(),
    );
  });

  it("accepts only declared lifecycle edges", () => {
    for (const status of sessionCommandStatusValues) {
      for (const event of sessionCommandLifecycleEventValues) {
        const expected = SESSION_COMMAND_LIFECYCLE[status][event];
        const evaluation = evaluateSessionCommandLifecycle({ event, status });
        if (expected === undefined) {
          expect(evaluation).toEqual({
            noop: "illegal_transition",
            detail: `no transition for ${event} from status ${status}`,
          });
        } else {
          expect(evaluation).toEqual({ to: expected });
        }
      }
    }
  });

  it("makes outcome-unknown terminal and auditable", () => {
    for (const event of sessionCommandLifecycleEventValues) {
      expect(
        evaluateSessionCommandLifecycle({ event, status: "outcome_unknown" }),
      ).toMatchObject({ noop: "illegal_transition" });
    }
    expect(
      outcomeUnknownReceipt({
        diagnostic: "transport closed after write",
        providerRequestId: "provider_request_1",
      }),
    ).toEqual({
      acceptance: "outcome_unknown",
      diagnostic: "transport closed after write",
      effectiveAccount: null,
      effectiveModel: null,
      observedCursor: null,
      providerRequestId: "provider_request_1",
      providerTurnId: null,
      requestedModel: null,
    });
  });
});

describe("capability evidence", () => {
  it("rejects expired-at-observation capability claims", () => {
    const evidence = {
      authority: "exclusive_control",
      detail: "broker-owned stdio child",
      expiresAt: 2_000,
      idempotency: "broker_at_most_once",
      kind: "execute",
      observedAt: 1_000,
      preconditions: ["matching boot nonce"],
      source: "codex-app-server probe",
      stability: "experimental",
    } as const;
    expect(sessionCapabilityEvidenceSchema.safeParse(evidence).success).toBe(
      true,
    );
    expect(
      sessionCapabilityEvidenceSchema.safeParse({
        ...evidence,
        expiresAt: evidence.observedAt,
      }).success,
    ).toBe(false);
  });
});
