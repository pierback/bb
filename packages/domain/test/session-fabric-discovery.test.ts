import { describe, expect, it } from "vitest";
import {
  discoveredNativeConversationSchema,
  discoveryProjectAssociationSchema,
  providerSessionDiscoveryScanSchema,
  type DiscoveredNativeConversation,
  type SessionCapabilityEvidence,
} from "../src/index.js";

const OBSERVED_AT = 1_800_000_000_000;

function discoveryCapability(): SessionCapabilityEvidence {
  return {
    authority: "read_only",
    detail: "Codex app-server thread/list",
    expiresAt: OBSERVED_AT + 60_000,
    idempotency: "read_only",
    kind: "discover",
    observedAt: OBSERVED_AT,
    preconditions: ["provider process initialized"],
    source: "codex.app-server.thread/list",
    stability: "stable",
  };
}

function discoveredConversation(): DiscoveredNativeConversation {
  return {
    archived: false,
    createdAt: OBSERVED_AT - 1_000,
    displayTitle: "Named session",
    evidence: {
      confidence: "provider_authoritative",
      method: "provider_api",
      observedAt: OBSERVED_AT,
      parserVersion: 1,
      providerVersion: "1.2.3",
      source: "codex.app-server.thread/list",
    },
    nativeConversation: {
      hostId: "host-1",
      nativeConversationId: "native-1",
      providerId: "codex",
      providerInstanceId: "codex-install-1",
    },
    ownership: "unfenced_external",
    project: {
      basis: "exact_cwd",
      confidence: "exact",
      projectRootPath: "/repo",
    },
    providerState: "persisted_only",
    reportedCwd: "/repo",
    transcriptContentIncluded: false,
    updatedAt: OBSERVED_AT,
  };
}

describe("session fabric discovery schemas", () => {
  it("accepts metadata-only unfenced observations", () => {
    expect(
      discoveredNativeConversationSchema.parse(discoveredConversation()),
    ).toEqual(discoveredConversation());
  });

  it("rejects inconsistent project mapping confidence", () => {
    expect(() =>
      discoveryProjectAssociationSchema.parse({
        basis: "cwd_descendant",
        confidence: "exact",
        projectRootPath: "/repo",
      }),
    ).toThrow(/only exact cwd matches/);
  });

  it("requires read-only discovery evidence for supported scans", () => {
    expect(() =>
      providerSessionDiscoveryScanSchema.parse({
        availability: "supported",
        capability: {
          ...discoveryCapability(),
          authority: "shared_control",
        },
        conversations: [discoveredConversation()],
        detailCode: "ok",
        nextCursor: null,
        observedAt: OBSERVED_AT,
        providerId: "codex",
        providerInstanceId: "codex-install-1",
        retryable: false,
      }),
    ).toThrow(/must be read-only/);
  });

  it("does not let unsupported sources smuggle records or cursors", () => {
    expect(() =>
      providerSessionDiscoveryScanSchema.parse({
        availability: "unsupported",
        capability: null,
        conversations: [discoveredConversation()],
        detailCode: "session_list_not_negotiated",
        nextCursor: "provider-cursor",
        observedAt: OBSERVED_AT,
        providerId: "acp-cursor",
        providerInstanceId: "cursor-install-1",
        retryable: false,
      }),
    ).toThrow(/has no records/);
  });
});
