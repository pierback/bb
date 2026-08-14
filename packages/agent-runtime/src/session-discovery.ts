import type {
  DiscoveredNativeConversation,
  ProviderSessionDiscoveryScan,
  SessionCapabilityEvidence,
  SessionCapabilityStability,
  SessionDiscoveryConfidence,
  SessionDiscoveryMethod,
} from "@bb/domain";

const DISCOVERY_CAPABILITY_TTL_MS = 5 * 60 * 1_000;
const MAX_METADATA_TITLE_LENGTH = 512;

export interface ProviderSessionDiscoveryRequest {
  cursor: string | null;
  limit: number;
}

export interface ProviderSessionDiscoverySource {
  readonly providerId: string;
  readonly providerInstanceId: string;
  discover(
    request: ProviderSessionDiscoveryRequest,
  ): Promise<ProviderSessionDiscoveryScan>;
}

export interface ProviderSessionDiscoveryIdentity {
  hostId: string;
  providerId: string;
  providerInstanceId: string;
  providerVersion: string | null;
}

export interface ProviderSessionDiscoveryEvidenceArgs {
  confidence: SessionDiscoveryConfidence;
  method: SessionDiscoveryMethod;
  observedAt: number;
  parserVersion?: number;
  providerVersion: string | null;
  source: string;
}

export interface ProviderSessionDiscoveryCapabilityArgs {
  detail: string;
  observedAt: number;
  preconditions: string[];
  source: string;
  stability: SessionCapabilityStability;
}

export function createProviderSessionDiscoveryCapability(
  args: ProviderSessionDiscoveryCapabilityArgs,
): SessionCapabilityEvidence {
  return {
    authority: "read_only",
    detail: args.detail,
    expiresAt: args.observedAt + DISCOVERY_CAPABILITY_TTL_MS,
    idempotency: "read_only",
    kind: "discover",
    observedAt: args.observedAt,
    preconditions: args.preconditions,
    source: args.source,
    stability: args.stability,
  };
}

export function createProviderSessionDiscoveryEvidence(
  args: ProviderSessionDiscoveryEvidenceArgs,
): DiscoveredNativeConversation["evidence"] {
  return {
    confidence: args.confidence,
    method: args.method,
    observedAt: args.observedAt,
    parserVersion: args.parserVersion ?? 1,
    providerVersion: args.providerVersion,
    source: args.source,
  };
}

export function createSupportedProviderSessionDiscoveryScan(args: {
  capability: SessionCapabilityEvidence;
  conversations: DiscoveredNativeConversation[];
  detailCode?: string;
  identity: ProviderSessionDiscoveryIdentity;
  nextCursor: string | null;
  observedAt: number;
}): ProviderSessionDiscoveryScan {
  return {
    availability: "supported",
    capability: args.capability,
    conversations: args.conversations,
    detailCode: args.detailCode ?? "ok",
    nextCursor: args.nextCursor,
    observedAt: args.observedAt,
    providerId: args.identity.providerId,
    providerInstanceId: args.identity.providerInstanceId,
    retryable: false,
  };
}

export function createUnavailableProviderSessionDiscoveryScan(args: {
  detailCode: string;
  identity: ProviderSessionDiscoveryIdentity;
  observedAt: number;
  retryable: boolean;
}): ProviderSessionDiscoveryScan {
  return {
    availability: "unavailable",
    capability: null,
    conversations: [],
    detailCode: args.detailCode,
    nextCursor: null,
    observedAt: args.observedAt,
    providerId: args.identity.providerId,
    providerInstanceId: args.identity.providerInstanceId,
    retryable: args.retryable,
  };
}

export function createUnsupportedProviderSessionDiscoveryScan(args: {
  detailCode: string;
  identity: ProviderSessionDiscoveryIdentity;
  observedAt: number;
}): ProviderSessionDiscoveryScan {
  return {
    availability: "unsupported",
    capability: null,
    conversations: [],
    detailCode: args.detailCode,
    nextCursor: null,
    observedAt: args.observedAt,
    providerId: args.identity.providerId,
    providerInstanceId: args.identity.providerInstanceId,
    retryable: false,
  };
}

export function normalizeProviderMetadataTitle(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_METADATA_TITLE_LENGTH);
}

export function normalizeProviderReportedCwd(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function decodeOffsetCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const match = /^offset-v1:(0|[1-9][0-9]*)$/.exec(cursor);
  if (!match) {
    throw new Error("invalid offset discovery cursor");
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("offset discovery cursor exceeds safe integer range");
  }
  return offset;
}

export function encodeOffsetCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("discovery offset must be a non-negative safe integer");
  }
  return `offset-v1:${offset}`;
}

export function assertDiscoveryRequest(
  request: ProviderSessionDiscoveryRequest,
): void {
  if (
    !Number.isInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 200
  ) {
    throw new Error("discovery limit must be an integer from 1 through 200");
  }
}
