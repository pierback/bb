import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createAcpSessionDiscoverySource } from "./acp/session-discovery.js";
import { createClaudeCodeSessionDiscoverySource } from "./claude-code/session-discovery.js";
import { createCodexSessionDiscoverySource } from "./codex/session-discovery.js";
import { createPiSessionDiscoverySource } from "./pi/session-discovery.js";
import { PI_BRIDGE_SESSION_DIR_ENV } from "./pi/bridge/session-paths.js";
import { listPiSessionsFromDefaultStores } from "./pi/session-store.js";
import { decodeOffsetCursor, encodeOffsetCursor } from "./session-discovery.js";

const OBSERVED_AT = 1_800_000_000_000;

const baseIdentity = {
  hostId: "host-1",
  providerInstanceId: "provider-install-1",
  providerVersion: "1.2.3",
};

describe("provider-native session discovery", () => {
  it("uses versioned offset cursors", () => {
    expect(encodeOffsetCursor(42)).toBe("offset-v1:42");
    expect(decodeOffsetCursor("offset-v1:42")).toBe(42);
    expect(() => decodeOffsetCursor("42")).toThrow(/invalid offset/);
  });

  it("normalizes Codex thread/list without projecting preview content", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [
        {
          id: "codex-thread-1",
          name: "  Explicit title  ",
          preview: "secret prompt text",
          cwd: "/repo",
          createdAt: 1_800_000_000,
          updatedAt: 1_800_000_001,
          status: { type: "active" },
        },
      ],
      nextCursor: "codex-cursor",
    });
    const source = createCodexSessionDiscoverySource({
      ...baseIdentity,
      providerId: "codex",
      now: () => OBSERVED_AT,
      transport: { request },
    });

    const result = await source.discover({ cursor: null, limit: 20 });

    expect(request).toHaveBeenCalledWith("thread/list", {
      archived: false,
      cursor: undefined,
      limit: 20,
    });
    expect(result.availability).toBe("supported");
    expect(result.nextCursor).toBe("codex-cursor");
    expect(result.conversations[0]).toMatchObject({
      createdAt: 1_800_000_000_000,
      displayTitle: "Explicit title",
      ownership: "unfenced_external",
      project: null,
      providerState: "provider_reported_active",
      transcriptContentIncluded: false,
      updatedAt: 1_800_000_001_000,
    });
    expect(JSON.stringify(result)).not.toContain("secret prompt text");
  });

  it("uses Claude SDK pagination and only exposes user-set titles", async () => {
    const sessions: SDKSessionInfo[] = [
      {
        sessionId: "claude-1",
        summary: "secret generated summary",
        firstPrompt: "secret first prompt",
        customTitle: "User title",
        cwd: "/repo",
        createdAt: OBSERVED_AT - 2_000,
        lastModified: OBSERVED_AT - 1_000,
      },
      {
        sessionId: "claude-2",
        summary: "another secret summary",
        cwd: "/other",
        lastModified: OBSERVED_AT - 500,
      },
    ];
    const listSessions = vi.fn().mockResolvedValue(sessions);
    const source = createClaudeCodeSessionDiscoverySource({
      ...baseIdentity,
      providerId: "claude-code",
      listSessions,
      now: () => OBSERVED_AT,
    });

    const result = await source.discover({ cursor: null, limit: 1 });

    expect(listSessions).toHaveBeenCalledWith({
      includeProgrammatic: true,
      includeWorktrees: true,
      limit: 2,
      offset: 0,
    });
    expect(result.nextCursor).toBe("offset-v1:1");
    expect(result.conversations[0]?.displayTitle).toBe("User title");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("sorts Pi metadata and never projects message text", async () => {
    const sessions: PiSessionInfo[] = [
      {
        allMessagesText: "secret transcript",
        created: new Date(OBSERVED_AT - 5_000),
        cwd: "/repo",
        firstMessage: "secret first message",
        id: "pi-older",
        messageCount: 1,
        modified: new Date(OBSERVED_AT - 2_000),
        name: "Older",
        path: "/sessions/older.jsonl",
      },
      {
        allMessagesText: "another transcript",
        created: new Date(OBSERVED_AT - 4_000),
        cwd: "/repo/subdir",
        firstMessage: "another first message",
        id: "pi-newer",
        messageCount: 2,
        modified: new Date(OBSERVED_AT - 1_000),
        path: "/sessions/newer.jsonl",
      },
    ];
    const source = createPiSessionDiscoverySource({
      ...baseIdentity,
      providerId: "pi",
      listSessions: vi.fn().mockResolvedValue(sessions),
      now: () => OBSERVED_AT,
    });

    const result = await source.discover({ cursor: null, limit: 1 });

    expect(
      result.conversations[0]?.nativeConversation.nativeConversationId,
    ).toBe("pi-newer");
    expect(result.conversations[0]?.displayTitle).toBeNull();
    expect(result.nextCursor).toBe("offset-v1:1");
    expect(JSON.stringify(result)).not.toContain("secret transcript");
    expect(JSON.stringify(result)).not.toContain("another transcript");
    expect(JSON.stringify(result)).not.toContain("secret first message");
    expect(JSON.stringify(result)).not.toContain("another first message");
  });

  it("discovers Pi sessions from both the SDK and BB bridge stores", async () => {
    const sharedSession: PiSessionInfo = {
      created: new Date(OBSERVED_AT - 5_000),
      cwd: "/repo/shared",
      firstMessage: "",
      id: "pi-shared",
      allMessagesText: "",
      messageCount: 0,
      modified: new Date(OBSERVED_AT - 2_000),
      path: "/sessions/shared.jsonl",
    };
    const providerSession: PiSessionInfo = {
      ...sharedSession,
      cwd: "/repo/provider",
      id: "pi-provider",
      path: "/sessions/provider.jsonl",
    };
    const bridgeSession: PiSessionInfo = {
      ...sharedSession,
      cwd: "/repo/bridge",
      id: "pi-bridge",
      path: "/bb-sessions/bridge.jsonl",
    };
    const listAll = vi.fn(async (sessionDir?: string) =>
      sessionDir === "/bb-sessions"
        ? [sharedSession, bridgeSession]
        : [providerSession, sharedSession],
    );

    const sessions = await listPiSessionsFromDefaultStores({
      env: { [PI_BRIDGE_SESSION_DIR_ENV]: "/bb-sessions" },
      listAll,
    });

    expect(listAll).toHaveBeenNthCalledWith(1);
    expect(listAll).toHaveBeenNthCalledWith(2, "/bb-sessions");
    expect(sessions.map((session) => session.id).sort()).toEqual([
      "pi-bridge",
      "pi-provider",
      "pi-shared",
    ]);
  });

  it("does not call ACP session/list unless the exact capability was negotiated", async () => {
    const request = vi.fn();
    const source = createAcpSessionDiscoverySource({
      ...baseIdentity,
      providerId: "acp-cursor",
      initializeResult: {
        agentCapabilities: { loadSession: true },
      },
      now: () => OBSERVED_AT,
      transport: { request },
    });

    const result = await source.discover({ cursor: null, limit: 20 });

    expect(result).toMatchObject({
      availability: "unsupported",
      detailCode: "session_list_not_negotiated",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes negotiated ACP session/list metadata", async () => {
    const request = vi.fn().mockResolvedValue({
      sessions: [
        {
          sessionId: "cursor-session-1",
          cwd: "/repo",
          title: "Cursor title",
          updatedAt: "2027-01-15T08:00:00.000Z",
          _meta: { privateProviderState: "not-copied" },
        },
      ],
      nextCursor: "acp-cursor",
    });
    const source = createAcpSessionDiscoverySource({
      ...baseIdentity,
      providerId: "acp-cursor",
      initializeResult: {
        agentCapabilities: { sessionCapabilities: { list: true } },
      },
      now: () => OBSERVED_AT,
      transport: { request },
    });

    const result = await source.discover({ cursor: "previous", limit: 20 });

    expect(request).toHaveBeenCalledWith("session/list", {
      cursor: "previous",
    });
    expect(result).toMatchObject({
      availability: "supported",
      nextCursor: "acp-cursor",
    });
    expect(result.conversations[0]).toMatchObject({
      displayTitle: "Cursor title",
      providerState: "unknown",
      updatedAt: Date.parse("2027-01-15T08:00:00.000Z"),
    });
    expect(JSON.stringify(result)).not.toContain("privateProviderState");
  });
});
