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
  normalizeProviderMetadataTitle,
  normalizeProviderReportedCwd,
  type ProviderSessionDiscoveryIdentity,
  type ProviderSessionDiscoveryRequest,
  type ProviderSessionDiscoverySource,
} from "../session-discovery.js";

const SOURCE = "codex.app-server.thread/list";

const codexThreadListItemSchema = z
  .object({
    archived: z.boolean().optional(),
    createdAt: z.number().finite().nonnegative().optional(),
    cwd: z.string().optional().nullable(),
    id: z.string().min(1),
    name: z.string().optional().nullable(),
    status: z
      .object({
        type: z.enum(["notLoaded", "idle", "systemError", "active"]),
      })
      .passthrough()
      .optional(),
    updatedAt: z.number().finite().nonnegative().optional(),
  })
  .passthrough();

const codexThreadListResponseSchema = z
  .object({
    data: z.array(z.unknown()),
    nextCursor: z.string().min(1).nullable().optional(),
  })
  .passthrough();

export interface CodexThreadListTransport {
  request(method: "thread/list", params: object): Promise<unknown>;
}

export interface CreateCodexSessionDiscoverySourceArgs extends ProviderSessionDiscoveryIdentity {
  now?: () => number;
  transport: CodexThreadListTransport;
}

function secondsToMilliseconds(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const milliseconds = Math.round(value * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function normalizeCodexState(
  status: z.infer<typeof codexThreadListItemSchema>["status"],
): DiscoveredNativeConversation["providerState"] {
  switch (status?.type) {
    case "notLoaded":
      return "persisted_only";
    case "idle":
      return "provider_reported_idle";
    case "active":
      return "provider_reported_active";
    case "systemError":
      return "provider_reported_error";
    case undefined:
      return "unknown";
  }
}

export function createCodexSessionDiscoverySource(
  args: CreateCodexSessionDiscoverySourceArgs,
): ProviderSessionDiscoverySource {
  const identity: ProviderSessionDiscoveryIdentity = args;
  const now = args.now ?? Date.now;

  return {
    providerId: identity.providerId,
    providerInstanceId: identity.providerInstanceId,
    async discover(
      request: ProviderSessionDiscoveryRequest,
    ): Promise<ProviderSessionDiscoveryScan> {
      assertDiscoveryRequest(request);
      const observedAt = now();
      let response: unknown;
      try {
        response = await args.transport.request("thread/list", {
          archived: false,
          cursor: request.cursor ?? undefined,
          limit: request.limit,
        });
      } catch {
        return createUnavailableProviderSessionDiscoveryScan({
          detailCode: "provider_request_failed",
          identity,
          observedAt,
          retryable: true,
        });
      }

      const parsedResponse = codexThreadListResponseSchema.safeParse(response);
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
        confidence: "provider_authoritative",
        method: "provider_api",
        observedAt,
        providerVersion: identity.providerVersion,
        source: SOURCE,
      });
      const conversations: DiscoveredNativeConversation[] = [];
      for (const value of parsedResponse.data.data) {
        const parsedItem = codexThreadListItemSchema.safeParse(value);
        if (!parsedItem.success) {
          invalidRecordCount += 1;
          continue;
        }
        const item = parsedItem.data;
        conversations.push({
          archived: item.archived ?? null,
          createdAt: secondsToMilliseconds(item.createdAt),
          displayTitle: normalizeProviderMetadataTitle(item.name),
          evidence,
          nativeConversation: {
            hostId: identity.hostId,
            nativeConversationId: item.id,
            providerId: identity.providerId,
            providerInstanceId: identity.providerInstanceId,
          },
          ownership: "unfenced_external",
          project: null,
          providerState: normalizeCodexState(item.status),
          reportedCwd: normalizeProviderReportedCwd(item.cwd),
          transcriptContentIncluded: false,
          updatedAt: secondsToMilliseconds(item.updatedAt),
        });
      }

      return createSupportedProviderSessionDiscoveryScan({
        capability: createProviderSessionDiscoveryCapability({
          detail: "Codex app-server lists persisted native threads",
          observedAt,
          preconditions: ["app-server initialized"],
          source: SOURCE,
          stability: "stable",
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
