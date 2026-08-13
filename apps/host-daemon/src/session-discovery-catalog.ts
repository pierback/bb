import path from "node:path";
import type {
  ProviderSessionDiscoveryRequest,
  ProviderSessionDiscoverySource,
} from "@bb/agent-runtime";
import {
  providerSessionDiscoveryScanSchema,
  type DiscoveredNativeConversation,
  type DiscoveryProjectAssociation,
  type ProviderSessionDiscoveryScan,
} from "@bb/domain";

export interface SessionDiscoveryProviderCursor {
  cursor: string;
  providerId: string;
  providerInstanceId: string;
}

export interface SessionDiscoveryCatalogRequest {
  includeUnmapped?: boolean;
  limitPerProvider: number;
  projectRootPaths: readonly string[];
  providerCursors?: readonly SessionDiscoveryProviderCursor[];
}

export interface SessionDiscoveryCatalogResult {
  scans: ProviderSessionDiscoveryScan[];
}

export interface CreateSessionDiscoveryCatalogArgs {
  hostId: string;
  now?: () => number;
  sources: readonly ProviderSessionDiscoverySource[];
}

interface CanonicalProjectRoot {
  path: string;
}

function providerInstanceKey(
  providerId: string,
  providerInstanceId: string,
): string {
  return JSON.stringify([providerId, providerInstanceId]);
}

function unavailableSourceScan(args: {
  detailCode: string;
  now: number;
  source: ProviderSessionDiscoverySource;
}): ProviderSessionDiscoveryScan {
  return {
    availability: "unavailable",
    capability: null,
    conversations: [],
    detailCode: args.detailCode,
    nextCursor: null,
    observedAt: args.now,
    providerId: args.source.providerId,
    providerInstanceId: args.source.providerInstanceId,
    retryable: false,
  };
}

function canonicalProjectRoots(
  projectRootPaths: readonly string[],
): CanonicalProjectRoot[] {
  const seen = new Set<string>();
  const roots: CanonicalProjectRoot[] = [];
  for (const projectRootPath of projectRootPaths) {
    if (!path.isAbsolute(projectRootPath)) {
      throw new Error("session discovery project roots must be absolute paths");
    }
    const canonical = path.resolve(projectRootPath);
    if (!seen.has(canonical)) {
      roots.push({ path: canonical });
      seen.add(canonical);
    }
  }
  roots.sort((left, right) => right.path.length - left.path.length);
  return roots;
}

function associateProject(
  reportedCwd: string | null,
  projectRoots: readonly CanonicalProjectRoot[],
): DiscoveryProjectAssociation {
  if (reportedCwd === null || !path.isAbsolute(reportedCwd)) {
    return {
      basis: "unmapped",
      confidence: "none",
      projectRootPath: null,
    };
  }
  const cwd = path.resolve(reportedCwd);
  for (const projectRoot of projectRoots) {
    if (cwd === projectRoot.path) {
      return {
        basis: "exact_cwd",
        confidence: "exact",
        projectRootPath: projectRoot.path,
      };
    }
    const relative = path.relative(projectRoot.path, cwd);
    if (
      relative.length > 0 &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      return {
        basis: "cwd_descendant",
        confidence: "high",
        projectRootPath: projectRoot.path,
      };
    }
  }
  return {
    basis: "unmapped",
    confidence: "none",
    projectRootPath: null,
  };
}

function validateSourceIdentity(args: {
  hostId: string;
  scan: ProviderSessionDiscoveryScan;
  source: ProviderSessionDiscoverySource;
}): boolean {
  if (
    args.scan.providerId !== args.source.providerId ||
    args.scan.providerInstanceId !== args.source.providerInstanceId
  ) {
    return false;
  }
  const nativeConversationIds = new Set<string>();
  for (const conversation of args.scan.conversations) {
    const native = conversation.nativeConversation;
    if (
      native.hostId !== args.hostId ||
      native.providerId !== args.source.providerId ||
      native.providerInstanceId !== args.source.providerInstanceId ||
      conversation.project !== null ||
      nativeConversationIds.has(native.nativeConversationId)
    ) {
      return false;
    }
    nativeConversationIds.add(native.nativeConversationId);
  }
  return true;
}

export class SessionDiscoveryCatalog {
  readonly #hostId: string;
  readonly #now: () => number;
  readonly #sources: readonly ProviderSessionDiscoverySource[];

  constructor(args: CreateSessionDiscoveryCatalogArgs) {
    if (!args.hostId) {
      throw new Error("session discovery catalog requires a host id");
    }
    const sourceKeys = new Set<string>();
    for (const source of args.sources) {
      const key = providerInstanceKey(
        source.providerId,
        source.providerInstanceId,
      );
      if (sourceKeys.has(key)) {
        throw new Error(
          `duplicate discovery source ${source.providerId}/${source.providerInstanceId}`,
        );
      }
      sourceKeys.add(key);
    }
    this.#hostId = args.hostId;
    this.#now = args.now ?? Date.now;
    this.#sources = [...args.sources];
  }

  async scan(
    request: SessionDiscoveryCatalogRequest,
  ): Promise<SessionDiscoveryCatalogResult> {
    if (
      !Number.isInteger(request.limitPerProvider) ||
      request.limitPerProvider < 1 ||
      request.limitPerProvider > 200
    ) {
      throw new Error("limitPerProvider must be an integer from 1 through 200");
    }
    const projectRoots = canonicalProjectRoots(request.projectRootPaths);
    const cursors = new Map<string, string>();
    for (const entry of request.providerCursors ?? []) {
      const key = providerInstanceKey(
        entry.providerId,
        entry.providerInstanceId,
      );
      if (cursors.has(key)) {
        throw new Error("duplicate provider discovery cursor");
      }
      cursors.set(key, entry.cursor);
    }

    const scans = await Promise.all(
      this.#sources.map(
        async (source): Promise<ProviderSessionDiscoveryScan> => {
          const sourceRequest: ProviderSessionDiscoveryRequest = {
            cursor:
              cursors.get(
                providerInstanceKey(
                  source.providerId,
                  source.providerInstanceId,
                ),
              ) ?? null,
            limit: request.limitPerProvider,
          };
          let candidate: unknown;
          try {
            candidate = await source.discover(sourceRequest);
          } catch {
            return unavailableSourceScan({
              detailCode: "discovery_source_failed",
              now: this.#now(),
              source,
            });
          }
          const parsed =
            providerSessionDiscoveryScanSchema.safeParse(candidate);
          if (
            !parsed.success ||
            !validateSourceIdentity({
              hostId: this.#hostId,
              scan: parsed.success
                ? parsed.data
                : unavailableSourceScan({
                    detailCode: "invalid_discovery_source_response",
                    now: this.#now(),
                    source,
                  }),
              source,
            })
          ) {
            return unavailableSourceScan({
              detailCode: "invalid_discovery_source_response",
              now: this.#now(),
              source,
            });
          }

          if (parsed.data.availability !== "supported") {
            return parsed.data;
          }
          const conversations: DiscoveredNativeConversation[] = [];
          for (const conversation of parsed.data.conversations) {
            const project = associateProject(
              conversation.reportedCwd,
              projectRoots,
            );
            if (project.basis === "unmapped" && !request.includeUnmapped) {
              continue;
            }
            conversations.push({ ...conversation, project });
          }
          return { ...parsed.data, conversations };
        },
      ),
    );

    return { scans };
  }
}
