import {
  listSessions as listClaudeSessions,
  type ListSessionsOptions,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  DiscoveredNativeConversation,
  ProviderSessionDiscoveryScan,
} from "@bb/domain";
import { z } from "zod";
import {
  assertDiscoveryRequest,
  createProviderSessionDiscoveryCapability,
  createProviderSessionDiscoveryEvidence,
  createSupportedProviderSessionDiscoveryScan,
  createUnavailableProviderSessionDiscoveryScan,
  decodeOffsetCursor,
  encodeOffsetCursor,
  normalizeProviderMetadataTitle,
  normalizeProviderReportedCwd,
  type ProviderSessionDiscoveryIdentity,
  type ProviderSessionDiscoveryRequest,
  type ProviderSessionDiscoverySource,
} from "../session-discovery.js";

const SOURCE = "claude-code.sdk.listSessions";

const claudeSessionInfoSchema = z
  .object({
    createdAt: z.number().int().nonnegative().optional(),
    customTitle: z.string().optional(),
    cwd: z.string().optional(),
    lastModified: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
  })
  .passthrough();

export type ClaudeSessionLister = (
  options?: ListSessionsOptions,
) => Promise<SDKSessionInfo[]>;

export interface CreateClaudeCodeSessionDiscoverySourceArgs extends ProviderSessionDiscoveryIdentity {
  listSessions?: ClaudeSessionLister;
  now?: () => number;
}
export function createClaudeCodeSessionDiscoverySource(
  args: CreateClaudeCodeSessionDiscoverySourceArgs,
): ProviderSessionDiscoverySource {
  const identity: ProviderSessionDiscoveryIdentity = args;
  const listSessions = args.listSessions ?? listClaudeSessions;
  const now = args.now ?? Date.now;

  return {
    providerId: identity.providerId,
    providerInstanceId: identity.providerInstanceId,
    async discover(
      request: ProviderSessionDiscoveryRequest,
    ): Promise<ProviderSessionDiscoveryScan> {
      assertDiscoveryRequest(request);
      const offset = decodeOffsetCursor(request.cursor);
      const observedAt = now();
      let sessions: SDKSessionInfo[];
      try {
        sessions = await listSessions({
          includeProgrammatic: true,
          includeWorktrees: true,
          limit: request.limit + 1,
          offset,
        });
      } catch {
        return createUnavailableProviderSessionDiscoveryScan({
          detailCode: "provider_sdk_failed",
          identity,
          observedAt,
          retryable: true,
        });
      }

      let invalidRecordCount = 0;
      const evidence = createProviderSessionDiscoveryEvidence({
        confidence: "provider_declared",
        method: "provider_sdk",
        observedAt,
        providerVersion: identity.providerVersion,
        source: SOURCE,
      });
      const conversations: DiscoveredNativeConversation[] = [];
      for (const value of sessions.slice(0, request.limit)) {
        const parsed = claudeSessionInfoSchema.safeParse(value);
        if (!parsed.success) {
          invalidRecordCount += 1;
          continue;
        }
        const session = parsed.data;
        conversations.push({
          archived: null,
          createdAt: session.createdAt ?? null,
          // summary and firstPrompt can contain prompt text; only /rename wins.
          displayTitle: normalizeProviderMetadataTitle(session.customTitle),
          evidence,
          nativeConversation: {
            hostId: identity.hostId,
            nativeConversationId: session.sessionId,
            providerId: identity.providerId,
            providerInstanceId: identity.providerInstanceId,
          },
          ownership: "unfenced_external",
          project: null,
          providerState: "persisted_only",
          reportedCwd: normalizeProviderReportedCwd(session.cwd),
          transcriptContentIncluded: false,
          updatedAt: session.lastModified,
        });
      }

      return createSupportedProviderSessionDiscoveryScan({
        capability: createProviderSessionDiscoveryCapability({
          detail: "Claude Agent SDK lists native Claude Code sessions",
          observedAt,
          preconditions: ["Claude session store readable"],
          source: SOURCE,
          stability: "stable",
        }),
        conversations,
        detailCode: invalidRecordCount === 0 ? "ok" : "partial_invalid_records",
        identity,
        nextCursor:
          sessions.length > request.limit
            ? encodeOffsetCursor(offset + request.limit)
            : null,
        observedAt,
      });
    },
  };
}
