import {
  createAcpSessionDiscoverySource,
  createClaudeCodeSessionDiscoverySource,
  createCodexSessionDiscoverySource,
  createPiSessionDiscoverySource,
  type AgentRuntime,
  type ClaudeSessionLister,
  type PiSessionLister,
} from "@bb/agent-runtime";
import { SessionDiscoveryCatalog } from "./session-discovery-catalog.js";

const AMBIENT_PROVIDER_INSTANCE_IDS = {
  "acp-cursor": "acp-cursor:ambient:default",
  "claude-code": "claude-code:subscription:default",
  codex: "codex:subscription:default",
  pi: "pi:ambient:default",
} as const;

interface SessionDiscoveryRuntimeManager {
  ensureProviderMaintenanceRuntime(args: {
    dataDir: string;
  }): Promise<Pick<AgentRuntime, "listNativeSessions">>;
}

export interface CreateDefaultSessionDiscoveryCatalogArgs {
  claudeListSessions?: ClaudeSessionLister;
  dataDir: string;
  hostId: string;
  now?: () => number;
  piListSessions?: PiSessionLister;
  runtimeManager: SessionDiscoveryRuntimeManager;
}

/**
 * Builds the production discovery source set. Provider-instance ids name the
 * daemon's ambient credential/install route; the host id remains a separate
 * part of every native-conversation identity.
 */
export function createDefaultSessionDiscoveryCatalog(
  args: CreateDefaultSessionDiscoveryCatalogArgs,
): SessionDiscoveryCatalog {
  const identity = (providerId: keyof typeof AMBIENT_PROVIDER_INSTANCE_IDS) =>
    ({
      hostId: args.hostId,
      providerId,
      providerInstanceId: AMBIENT_PROVIDER_INSTANCE_IDS[providerId],
      providerVersion: null,
    }) as const;

  return new SessionDiscoveryCatalog({
    hostId: args.hostId,
    ...(args.now ? { now: args.now } : {}),
    sources: [
      createCodexSessionDiscoverySource({
        ...identity("codex"),
        ...(args.now ? { now: args.now } : {}),
        transport: {
          async request(_method, params) {
            const runtime =
              await args.runtimeManager.ensureProviderMaintenanceRuntime({
                dataDir: args.dataDir,
              });
            return runtime.listNativeSessions({
              params,
              providerId: "codex",
            });
          },
        },
      }),
      createClaudeCodeSessionDiscoverySource({
        ...identity("claude-code"),
        ...(args.claudeListSessions
          ? { listSessions: args.claudeListSessions }
          : {}),
        ...(args.now ? { now: args.now } : {}),
      }),
      createPiSessionDiscoverySource({
        ...identity("pi"),
        ...(args.piListSessions ? { listSessions: args.piListSessions } : {}),
        ...(args.now ? { now: args.now } : {}),
      }),
      createAcpSessionDiscoverySource({
        ...identity("acp-cursor"),
        initializeResult: {},
        ...(args.now ? { now: args.now } : {}),
        transport: {
          async request() {
            throw new Error(
              "ACP session/list cannot run before capability negotiation",
            );
          },
        },
      }),
    ],
  });
}
