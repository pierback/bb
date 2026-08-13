import { describe, expect, it } from "vitest";
import {
  contextCapsuleTransferItemSchema,
  contextCapsuleSchema,
  contextCapsuleWorkspaceDigest,
  evaluateHandoffTransitionLifecycle,
  findDestinationMutationGateIssues,
  findHandoffSettlementIssues,
  findContextCapsuleRestatementIssues,
  findContextCapsuleSensitiveMaterial,
  HANDOFF_TRANSITION_LIFECYCLE,
  handoffTransitionLifecycleEventValues,
  handoffTransitionPhaseValues,
} from "../src/session-fabric-transition.js";
import type { SessionWorkspaceState } from "../src/session-fabric-identity.js";

const workspaceState: SessionWorkspaceState = {
  backgroundResources: [],
  capturedAt: 1_000,
  diffDigest: "sha256:diff",
  digestAlgorithm: "session-workspace-v1",
  externalSideEffectStatus: "not_observed",
  headSha: "abc123",
  hostId: "host_1",
  id: "workspace_state_1",
  indexDigest: "sha256:index",
  rootPath: "/repo",
  untrackedManifestDigest: "sha256:untracked",
  watcherGeneration: 4,
  worktreeId: "worktree_1",
};
const CAPSULE_HASH = `sha256:${"a".repeat(64)}`;
const EVIDENCE_HASH = `sha256:${"b".repeat(64)}`;

describe("handoff transition lifecycle", () => {
  it("covers every phase and permits abort only before active-binding swap", () => {
    expect(Object.keys(HANDOFF_TRANSITION_LIFECYCLE).sort()).toEqual(
      [...handoffTransitionPhaseValues].sort(),
    );
    for (const phase of handoffTransitionPhaseValues) {
      const abortTarget = HANDOFF_TRANSITION_LIFECYCLE[phase].abort;
      const beforeSwap =
        handoffTransitionPhaseValues.indexOf(phase) <
        handoffTransitionPhaseValues.indexOf("active_binding_swapped");
      expect(abortTarget).toBe(beforeSwap ? "aborted" : undefined);
    }
  });

  it("rejects every undeclared phase transition", () => {
    for (const phase of handoffTransitionPhaseValues) {
      for (const event of handoffTransitionLifecycleEventValues) {
        const expected = HANDOFF_TRANSITION_LIFECYCLE[phase][event];
        const evaluation = evaluateHandoffTransitionLifecycle({ event, phase });
        if (expected === undefined) {
          expect(evaluation).toMatchObject({ noop: "illegal_transition" });
        } else {
          expect(evaluation).toEqual({ to: expected });
        }
      }
    }
  });
});

describe("handoff settlement", () => {
  it("blocks every unsafe source condition independently", () => {
    expect(
      findHandoffSettlementIssues({
        acceptedQueueCount: 1,
        activeBackgroundResourceCount: 1,
        activeToolCount: 1,
        compacting: true,
        externalSideEffectStatus: "unknown",
        outcomeUnknown: true,
        partialEdit: true,
        retrying: true,
        unknownBackgroundResourceCount: 1,
        unresolvedInteractionCount: 1,
      }),
    ).toEqual([
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
    ]);
  });

  it("recognizes a settled source", () => {
    expect(
      findHandoffSettlementIssues({
        acceptedQueueCount: 0,
        activeBackgroundResourceCount: 0,
        activeToolCount: 0,
        compacting: false,
        externalSideEffectStatus: "not_observed",
        outcomeUnknown: false,
        partialEdit: false,
        retrying: false,
        unknownBackgroundResourceCount: 0,
        unresolvedInteractionCount: 0,
      }),
    ).toEqual([]);
  });
});

describe("destination mutation gate", () => {
  it("allows mutation after swap with exact workspace state and fenced source", () => {
    expect(
      findDestinationMutationGateIssues({
        actualWorkspaceState: workspaceState,
        billingAuthorized: true,
        destinationRestated: true,
        destinationWorkspaceDisposition: "source_worktree",
        expectedWorkspaceState: workspaceState,
        sourceControlDisposition: "fenced",
        transitionPhase: "active_binding_swapped",
      }),
    ).toEqual([]);
  });

  it("blocks workspace drift and an unfenced source sharing its worktree", () => {
    expect(
      findDestinationMutationGateIssues({
        actualWorkspaceState: {
          ...workspaceState,
          diffDigest: "sha256:drifted",
          headSha: "def456",
        },
        billingAuthorized: true,
        destinationRestated: true,
        destinationWorkspaceDisposition: "source_worktree",
        expectedWorkspaceState: workspaceState,
        sourceControlDisposition: "unfenced",
        transitionPhase: "active_binding_swapped",
      }),
    ).toEqual([
      "workspace_head_mismatch",
      "workspace_diff_mismatch",
      "unfenced_shared_worktree",
    ]);
  });

  it("allows an unfenced source only when the destination is isolated", () => {
    expect(
      findDestinationMutationGateIssues({
        actualWorkspaceState: workspaceState,
        billingAuthorized: true,
        destinationRestated: true,
        destinationWorkspaceDisposition: "isolated_worktree",
        expectedWorkspaceState: workspaceState,
        sourceControlDisposition: "unfenced",
        transitionPhase: "active_binding_swapped",
      }),
    ).toEqual([]);
  });
});

describe("context capsule", () => {
  it.each([
    "approval",
    "permission",
    "credential",
    "reasoning",
    "provider_cache",
    "process_handle",
  ] as const)("forbids transferring %s across provider boundaries", (kind) => {
    expect(
      contextCapsuleTransferItemSchema.safeParse({
        action: "transfer",
        contentHash: EVIDENCE_HASH,
        kind,
        reason: "unsafe authority carry-over",
      }).success,
    ).toBe(false);
    expect(
      contextCapsuleTransferItemSchema.safeParse({
        action: "drop",
        contentHash: EVIDENCE_HASH,
        kind,
        reason: "must be re-established at destination",
      }).success,
    ).toBe(true);
  });
  it("marks imported provider evidence as untrusted and approvals as dropped", () => {
    const capsule = {
      ambiguities: [],
      constraints: ["do not mutate before workspace verification"],
      contentHash: CAPSULE_HASH,
      createdAt: 2_000,
      decisions: ["continue with Pi"],
      destinationToolDifferences: ["Codex-only tool unavailable"],
      evidence: [
        {
          contentHash: EVIDENCE_HASH,
          kind: "turn",
          nativeCursor: "cursor_10",
          provenance: "codex:native_1",
          trust: "untrusted_evidence",
        },
      ],
      expectedWorkspaceState: workspaceState,
      failureAcceptance: null,
      id: "capsule_1",
      instructions: ["AGENTS.md"],
      objective: "finish Session Fabric",
      openTasks: ["add Pi adapter"],
      plan: ["stage Pi read-only"],
      rejectedApproaches: ["forge provider transcript"],
      schemaVersion: 1,
      sensitivityLabels: ["source-code"],
      sourceConversation: {
        hostId: "host_1",
        nativeConversationId: "native_1",
        providerId: "codex",
        providerInstanceId: "provider_instance_1",
      },
      successCriteria: ["workspace hash gate passes"],
      transferManifest: [
        {
          action: "drop",
          contentHash: null,
          kind: "approval",
          reason: "approvals never transfer",
        },
      ],
      transitionId: "transition_1",
      unresolvedSideEffects: [],
    } as const;

    const parsedCapsule = contextCapsuleSchema.parse(capsule);
    expect(parsedCapsule).toEqual(capsule);
    expect(
      contextCapsuleSchema.safeParse({
        ...capsule,
        evidence: [{ ...capsule.evidence[0], trust: "trusted" }],
      }).success,
    ).toBe(false);

    expect(
      findContextCapsuleRestatementIssues(parsedCapsule, {
        ambiguities: parsedCapsule.ambiguities,
        capsuleContentHash: parsedCapsule.contentHash,
        constraints: parsedCapsule.constraints,
        decisions: parsedCapsule.decisions,
        destinationToolDifferences: parsedCapsule.destinationToolDifferences,
        expectedWorkspace: contextCapsuleWorkspaceDigest(workspaceState),
        objective: parsedCapsule.objective,
        openTasks: parsedCapsule.openTasks,
      }),
    ).toEqual([]);
    expect(
      findContextCapsuleRestatementIssues(parsedCapsule, {
        ambiguities: parsedCapsule.ambiguities,
        capsuleContentHash: `sha256:${"c".repeat(64)}`,
        constraints: parsedCapsule.constraints,
        decisions: parsedCapsule.decisions,
        destinationToolDifferences: [],
        expectedWorkspace: {
          ...contextCapsuleWorkspaceDigest(workspaceState),
          diffDigest: "sha256:drifted",
        },
        objective: "different objective",
        openTasks: parsedCapsule.openTasks,
      }),
    ).toEqual([
      "capsule_hash_mismatch",
      "objective_mismatch",
      "workspace_digest_mismatch",
      "destination_tools_mismatch",
    ]);
    expect(findContextCapsuleSensitiveMaterial(parsedCapsule)).toEqual([]);
    expect(
      findContextCapsuleSensitiveMaterial({
        ...parsedCapsule,
        instructions: [
          "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        ],
      }),
    ).toEqual(["bearer_token"]);
  });
});
