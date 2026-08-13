import { describe, expect, it } from "vitest";
import {
  executionBindingSchema,
  runtimeInstanceSchema,
  runtimeOwnershipValues,
  runtimePhaseValues,
} from "../src/session-fabric-identity.js";

const runtimeInstance = {
  bootNonce: "boot_nonce_1234567890",
  connectorId: "codex-app-server",
  endpointFingerprint: "sha256:endpoint",
  hostId: "host_1",
  id: "runtime_1",
  providerInstanceId: "provider_instance_1",
  startedAt: 1_000,
  status: "live" as const,
  stoppedAt: null,
};

const binding = {
  closedAt: null,
  controlEpoch: 1,
  id: "binding_1",
  mutationPolicy: "enabled" as const,
  nativeConversation: {
    hostId: "host_1",
    nativeConversationId: "native_1",
    providerId: "codex",
    providerInstanceId: "provider_instance_1",
  },
  openedAt: 1_000,
  ownership: "owned_brokered" as const,
  phase: "idle" as const,
  runtimeInstanceId: "runtime_1",
  runtimeRecipeId: "recipe_1",
  workspaceStateId: "workspace_state_1",
  workstreamBranchId: "branch_1",
};

describe("session fabric identity schemas", () => {
  it("keeps runtime incarnation separate from PID-like process evidence", () => {
    expect(runtimeInstanceSchema.parse(runtimeInstance)).toEqual(
      runtimeInstance,
    );
    expect(
      runtimeInstanceSchema.safeParse({ ...runtimeInstance, pid: 1234 })
        .success,
    ).toBe(false);
  });

  it("requires stoppedAt exactly for a stopped runtime", () => {
    expect(
      runtimeInstanceSchema.safeParse({
        ...runtimeInstance,
        status: "stopped",
      }).success,
    ).toBe(false);
    expect(
      runtimeInstanceSchema.safeParse({
        ...runtimeInstance,
        status: "stopped",
        stoppedAt: 2_000,
      }).success,
    ).toBe(true);
    expect(
      runtimeInstanceSchema.safeParse({
        ...runtimeInstance,
        status: "lost",
        stoppedAt: 2_000,
      }).success,
    ).toBe(false);
  });

  it("requires a runtime for every phase except persisted-only", () => {
    expect(executionBindingSchema.safeParse(binding).success).toBe(true);
    expect(
      executionBindingSchema.safeParse({
        ...binding,
        phase: "persisted_only",
      }).success,
    ).toBe(false);
    expect(
      executionBindingSchema.safeParse({
        ...binding,
        phase: "persisted_only",
        runtimeInstanceId: null,
      }).success,
    ).toBe(true);
    expect(
      executionBindingSchema.safeParse({
        ...binding,
        runtimeInstanceId: null,
      }).success,
    ).toBe(false);
  });

  it("pins the ownership and phase vocabularies used by persistence and wire contracts", () => {
    expect(runtimeOwnershipValues).toEqual([
      "owned_exclusive",
      "owned_brokered",
      "provider_shared",
      "cooperative_external",
      "unfenced_external",
      "unknown",
    ]);
    expect(runtimePhaseValues).toContain("outcome_unknown");
    expect(runtimePhaseValues).toContain("reconciling");
  });
});
