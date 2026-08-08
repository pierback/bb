import type { SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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

const SOURCE = "pi.sdk.SessionManager.listAll";

const piSessionInfoSchema = z
  .object({
    created: z.date(),
    cwd: z.string(),
    id: z.string().min(1),
    modified: z.date(),
    name: z.string().optional(),
  })
  .passthrough();

export type PiSessionLister = () => Promise<PiSessionInfo[]>;

export interface CreatePiSessionDiscoverySourceArgs extends ProviderSessionDiscoveryIdentity {
  listSessions?: PiSessionLister;
  now?: () => number;
}

export function createPiSessionDiscoverySource(
  args: CreatePiSessionDiscoverySourceArgs,
): ProviderSessionDiscoverySource {
  const identity: ProviderSessionDiscoveryIdentity = args;
  const listSessions = args.listSessions ?? (() => SessionManager.listAll());
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
      let sessions: PiSessionInfo[];
      try {
        sessions = await listSessions();
      } catch {
        return createUnavailableProviderSessionDiscoveryScan({
          detailCode: "provider_sdk_failed",
          identity,
          observedAt,
          retryable: true,
        });
      }

      sessions.sort(
        (left, right) =>
          right.modified.getTime() - left.modified.getTime() ||
          left.id.localeCompare(right.id),
      );
      const page = sessions.slice(offset, offset + request.limit + 1);
      let invalidRecordCount = 0;
      const evidence = createProviderSessionDiscoveryEvidence({
        confidence: "native_store_parsed",
        method: "provider_sdk",
        observedAt,
        providerVersion: identity.providerVersion,
        source: SOURCE,
      });
      const conversations: DiscoveredNativeConversation[] = [];
      for (const value of page.slice(0, request.limit)) {
        const parsed = piSessionInfoSchema.safeParse(value);
        if (!parsed.success) {
          invalidRecordCount += 1;
          continue;
        }
        const session = parsed.data;
        conversations.push({
          archived: null,
          createdAt: session.created.getTime(),
          // firstMessage/allMessagesText are intentionally never projected.
          displayTitle: normalizeProviderMetadataTitle(session.name),
          evidence,
          nativeConversation: {
            hostId: identity.hostId,
            nativeConversationId: session.id,
            providerId: identity.providerId,
            providerInstanceId: identity.providerInstanceId,
          },
          ownership: "unfenced_external",
          project: null,
          providerState: "persisted_only",
          reportedCwd: normalizeProviderReportedCwd(session.cwd),
          transcriptContentIncluded: false,
          updatedAt: session.modified.getTime(),
        });
      }

      return createSupportedProviderSessionDiscoveryScan({
        capability: createProviderSessionDiscoveryCapability({
          detail: "Pi SDK parses native versioned JSONL sessions",
          observedAt,
          preconditions: ["Pi session store readable"],
          source: SOURCE,
          stability: "stable",
        }),
        conversations,
        detailCode: invalidRecordCount === 0 ? "ok" : "partial_invalid_records",
        identity,
        nextCursor:
          page.length > request.limit
            ? encodeOffsetCursor(offset + request.limit)
            : null,
        observedAt,
      });
    },
  };
}
