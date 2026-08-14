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
  createUnsupportedProviderSessionDiscoveryScan,
  normalizeProviderMetadataTitle,
  normalizeProviderReportedCwd,
  type ProviderSessionDiscoveryIdentity,
  type ProviderSessionDiscoveryRequest,
  type ProviderSessionDiscoverySource,
} from "../session-discovery.js";

const SOURCE = "acp.session/list";

export const acpSessionListCapabilitySchema = z
  .object({
    agentCapabilities: z
      .object({
        sessionCapabilities: z
          .object({
            list: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const acpListedSessionSchema = z
  .object({
    cwd: z.string().min(1),
    sessionId: z.string().min(1),
    title: z.string().optional().nullable(),
    updatedAt: z.string().optional().nullable(),
  })
  .passthrough();

const acpSessionListResponseSchema = z
  .object({
    nextCursor: z.string().min(1).optional().nullable(),
    sessions: z.array(z.unknown()),
  })
  .passthrough();

export interface AcpSessionListTransport {
  request(method: "session/list", params: object): Promise<unknown>;
}

export interface CreateAcpSessionDiscoverySourceArgs extends ProviderSessionDiscoveryIdentity {
  initializeResult: unknown;
  now?: () => number;
  transport: AcpSessionListTransport;
}

function parseOptionalAcpTimestamp(
  value: string | null | undefined,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function createAcpSessionDiscoverySource(
  args: CreateAcpSessionDiscoverySourceArgs,
): ProviderSessionDiscoverySource {
  const identity: ProviderSessionDiscoveryIdentity = args;
  const now = args.now ?? Date.now;
  const initialization = acpSessionListCapabilitySchema.safeParse(
    args.initializeResult,
  );
  const listSupported =
    initialization.success &&
    initialization.data.agentCapabilities?.sessionCapabilities?.list === true;

  return {
    providerId: identity.providerId,
    providerInstanceId: identity.providerInstanceId,
    async discover(
      request: ProviderSessionDiscoveryRequest,
    ): Promise<ProviderSessionDiscoveryScan> {
      assertDiscoveryRequest(request);
      const observedAt = now();
      if (!listSupported) {
        return createUnsupportedProviderSessionDiscoveryScan({
          detailCode: "session_list_not_negotiated",
          identity,
          observedAt,
        });
      }

      let response: unknown;
      try {
        response = await args.transport.request("session/list", {
          cursor: request.cursor ?? undefined,
        });
      } catch {
        return createUnavailableProviderSessionDiscoveryScan({
          detailCode: "provider_request_failed",
          identity,
          observedAt,
          retryable: true,
        });
      }
      const parsedResponse = acpSessionListResponseSchema.safeParse(response);
      if (!parsedResponse.success) {
        return createUnavailableProviderSessionDiscoveryScan({
          detailCode: "invalid_provider_response",
          identity,
          observedAt,
          retryable: false,
        });
      }

      let invalidRecordCount = 0;
      const evidence = createProviderSessionDiscoveryEvidence({
        confidence: "provider_declared",
        method: "acp_session_list",
        observedAt,
        providerVersion: identity.providerVersion,
        source: SOURCE,
      });
      const conversations: DiscoveredNativeConversation[] = [];
      for (const value of parsedResponse.data.sessions.slice(
        0,
        request.limit,
      )) {
        const parsed = acpListedSessionSchema.safeParse(value);
        if (!parsed.success) {
          invalidRecordCount += 1;
          continue;
        }
        const session = parsed.data;
        conversations.push({
          archived: null,
          createdAt: null,
          displayTitle: normalizeProviderMetadataTitle(session.title),
          evidence,
          nativeConversation: {
            hostId: identity.hostId,
            nativeConversationId: session.sessionId,
            providerId: identity.providerId,
            providerInstanceId: identity.providerInstanceId,
          },
          ownership: "unfenced_external",
          project: null,
          providerState: "unknown",
          reportedCwd: normalizeProviderReportedCwd(session.cwd),
          transcriptContentIncluded: false,
          updatedAt: parseOptionalAcpTimestamp(session.updatedAt),
        });
      }

      return createSupportedProviderSessionDiscoveryScan({
        capability: createProviderSessionDiscoveryCapability({
          detail: "ACP agent negotiated the optional session/list capability",
          observedAt,
          preconditions: ["sessionCapabilities.list negotiated"],
          source: SOURCE,
          stability: "experimental",
        }),
        conversations,
        detailCode: invalidRecordCount === 0 ? "ok" : "partial_invalid_records",
        identity,
        nextCursor: parsedResponse.data.nextCursor ?? null,
        observedAt,
      });
    },
  };
}
