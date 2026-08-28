import type { AgentRuntime } from "@bb/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { DISPATCH_TEST_RUNTIME_BRIDGE_LAUNCH } from "../test/command/dispatch-helpers.js";
import { createDefaultSessionDiscoveryCatalog } from "./session-discovery-sources.js";

describe("createDefaultSessionDiscoveryCatalog", () => {
  it("wires production providers and routes Codex through maintenance runtime", async () => {
    const listNativeSessions = vi.fn<AgentRuntime["listNativeSessions"]>(
      async () => ({
        data: [
          {
            cwd: "/repo",
            id: "codex-native-1",
            name: "Native thread",
            status: { type: "idle" },
          },
        ],
        nextCursor: null,
      }),
    );
    const ensureProviderMaintenanceRuntime = vi.fn(async () => ({
      listNativeSessions,
    }));
    const catalog = createDefaultSessionDiscoveryCatalog({
      claudeListSessions: async () => [],
      codexBridgeLaunch: DISPATCH_TEST_RUNTIME_BRIDGE_LAUNCH,
      dataDir: "/daemon-data",
      hostId: "host-production",
      now: () => 1_900_000_000_000,
      piListSessions: async () => [],
      runtimeManager: { ensureProviderMaintenanceRuntime },
    });

    const result = await catalog.scan({
      includeUnmapped: true,
      limitPerProvider: 25,
      projectRootPaths: ["/repo"],
    });

    expect(result.scans.map((scan) => scan.providerId)).toEqual([
      "codex",
      "claude-code",
      "pi",
      "acp-cursor",
    ]);
    expect(result.scans[0]).toMatchObject({
      availability: "supported",
      providerInstanceId: "codex:subscription:default",
      conversations: [
        {
          nativeConversation: {
            hostId: "host-production",
            nativeConversationId: "codex-native-1",
          },
          project: {
            basis: "exact_cwd",
            projectRootPath: "/repo",
          },
        },
      ],
    });
    expect(result.scans[3]).toMatchObject({
      availability: "unsupported",
      detailCode: "session_list_not_negotiated",
    });
    expect(ensureProviderMaintenanceRuntime).toHaveBeenCalledWith({
      dataDir: "/daemon-data",
    });
    expect(listNativeSessions).toHaveBeenCalledWith({
      bridgeLaunch: DISPATCH_TEST_RUNTIME_BRIDGE_LAUNCH,
      params: {
        archived: false,
        cursor: undefined,
        limit: 25,
      },
      providerId: "codex",
    });
  });
});
