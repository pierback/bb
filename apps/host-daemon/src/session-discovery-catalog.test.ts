import type { ProviderSessionDiscoverySource } from "@bb/agent-runtime";
import type {
  DiscoveredNativeConversation,
  ProviderSessionDiscoveryScan,
  SessionCapabilityEvidence,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { SessionDiscoveryCatalog } from "./session-discovery-catalog.js";

const OBSERVED_AT = 1_800_000_000_000;

function capability(): SessionCapabilityEvidence {
  return {
    authority: "read_only",
    detail: "test discovery",
    expiresAt: OBSERVED_AT + 60_000,
    idempotency: "read_only",
    kind: "discover",
    observedAt: OBSERVED_AT,
    preconditions: ["test"],
    source: "test.source",
    stability: "stable",
  };
}

function conversation(args: {
  cwd: string | null;
  id: string;
  project?: DiscoveredNativeConversation["project"];
  providerId?: string;
  providerInstanceId?: string;
}): DiscoveredNativeConversation {
  return {
    archived: null,
    createdAt: null,
    displayTitle: null,
    evidence: {
      confidence: "provider_authoritative",
      method: "provider_api",
      observedAt: OBSERVED_AT,
      parserVersion: 1,
      providerVersion: null,
      source: "test.source",
    },
    nativeConversation: {
      hostId: "host-1",
      nativeConversationId: args.id,
      providerId: args.providerId ?? "codex",
      providerInstanceId: args.providerInstanceId ?? "codex-install-1",
    },
    ownership: "unfenced_external",
    project: args.project ?? null,
    providerState: "persisted_only",
    reportedCwd: args.cwd,
    transcriptContentIncluded: false,
    updatedAt: null,
  };
}

function supportedScan(
  conversations: DiscoveredNativeConversation[],
): ProviderSessionDiscoveryScan {
  return {
    availability: "supported",
    capability: capability(),
    conversations,
    detailCode: "ok",
    nextCursor: null,
    observedAt: OBSERVED_AT,
    providerId: "codex",
    providerInstanceId: "codex-install-1",
    retryable: false,
  };
}

function source(
  discover: ProviderSessionDiscoverySource["discover"],
): ProviderSessionDiscoverySource {
  return {
    discover,
    providerId: "codex",
    providerInstanceId: "codex-install-1",
  };
}

describe("SessionDiscoveryCatalog", () => {
  it("maps exact and descendant cwd evidence to the most specific project", async () => {
    const discoverySource = source(
      vi
        .fn()
        .mockResolvedValue(
          supportedScan([
            conversation({ cwd: "/repo", id: "exact" }),
            conversation({ cwd: "/repo/packages/app", id: "nested" }),
            conversation({ cwd: "/outside", id: "outside" }),
            conversation({ cwd: null, id: "no-cwd" }),
          ]),
        ),
    );
    const catalog = new SessionDiscoveryCatalog({
      hostId: "host-1",
      now: () => OBSERVED_AT,
      sources: [discoverySource],
    });

    const result = await catalog.scan({
      limitPerProvider: 50,
      projectRootPaths: ["/repo", "/repo/packages"],
    });

    expect(result.scans[0]?.conversations).toMatchObject([
      {
        nativeConversation: { nativeConversationId: "exact" },
        project: {
          basis: "exact_cwd",
          confidence: "exact",
          projectRootPath: "/repo",
        },
      },
      {
        nativeConversation: { nativeConversationId: "nested" },
        project: {
          basis: "cwd_descendant",
          confidence: "high",
          projectRootPath: "/repo/packages",
        },
      },
    ]);
  });

  it("can include explicit unmapped records without inventing confidence", async () => {
    const catalog = new SessionDiscoveryCatalog({
      hostId: "host-1",
      sources: [
        source(
          vi
            .fn()
            .mockResolvedValue(
              supportedScan([conversation({ cwd: "/outside", id: "outside" })]),
            ),
        ),
      ],
    });

    const result = await catalog.scan({
      includeUnmapped: true,
      limitPerProvider: 20,
      projectRootPaths: ["/repo"],
    });

    expect(result.scans[0]?.conversations[0]?.project).toEqual({
      basis: "unmapped",
      confidence: "none",
      projectRootPath: null,
    });
  });

  it("routes opaque cursors to the matching provider instance", async () => {
    const discover = vi.fn().mockResolvedValue(supportedScan([]));
    const catalog = new SessionDiscoveryCatalog({
      hostId: "host-1",
      sources: [source(discover)],
    });

    await catalog.scan({
      limitPerProvider: 10,
      projectRootPaths: [],
      providerCursors: [
        {
          cursor: "native-cursor",
          providerId: "codex",
          providerInstanceId: "codex-install-1",
        },
      ],
    });

    expect(discover).toHaveBeenCalledWith({
      cursor: "native-cursor",
      limit: 10,
    });
  });

  it("rejects provider identity spoofing and pre-mapped adapter records", async () => {
    const spoofed = supportedScan([
      conversation({
        cwd: "/repo",
        id: "spoofed",
        providerId: "claude-code",
      }),
    ]);
    const catalog = new SessionDiscoveryCatalog({
      hostId: "host-1",
      now: () => OBSERVED_AT,
      sources: [source(vi.fn().mockResolvedValue(spoofed))],
    });

    const result = await catalog.scan({
      limitPerProvider: 10,
      projectRootPaths: ["/repo"],
    });

    expect(result.scans[0]).toMatchObject({
      availability: "unavailable",
      conversations: [],
      detailCode: "invalid_discovery_source_response",
    });
  });

  it("isolates a throwing provider source", async () => {
    const catalog = new SessionDiscoveryCatalog({
      hostId: "host-1",
      now: () => OBSERVED_AT,
      sources: [
        source(vi.fn().mockRejectedValue(new Error("secret provider failure"))),
      ],
    });

    const result = await catalog.scan({
      limitPerProvider: 10,
      projectRootPaths: ["/repo"],
    });

    expect(result.scans[0]).toMatchObject({
      availability: "unavailable",
      detailCode: "discovery_source_failed",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret provider failure");
  });
});
