import { resolve } from "node:path";
import {
  SessionManager,
  type SessionInfo as PiSessionInfo,
} from "@earendil-works/pi-coding-agent";
import { resolvePiBridgeSessionDir } from "./bridge/session-paths.js";

export type PiSessionListAll = (
  sessionDir?: string,
) => Promise<PiSessionInfo[]>;

export interface ListPiSessionsFromDefaultStoresArgs {
  env?: NodeJS.ProcessEnv;
  listAll?: PiSessionListAll;
}

export interface FindPiBridgeSessionPathsArgs extends ListPiSessionsFromDefaultStoresArgs {
  nativeConversationId: string;
}

const defaultListAll: PiSessionListAll = (sessionDir) =>
  SessionManager.listAll(sessionDir);

/**
 * Pi's default SDK store and BB's bridge store are distinct roots. Discovery
 * must inspect both because BB-launched sessions are persisted in the latter.
 */
export async function listPiSessionsFromDefaultStores(
  args: ListPiSessionsFromDefaultStoresArgs = {},
): Promise<PiSessionInfo[]> {
  const listAll = args.listAll ?? defaultListAll;
  const bridgeSessionDir = resolvePiBridgeSessionDir({
    env: args.env ?? process.env,
  });
  const [providerSessions, bridgeSessions] = await Promise.all([
    listAll(),
    listAll(bridgeSessionDir),
  ]);
  const sessionsByPath = new Map<string, PiSessionInfo>();
  for (const session of [...providerSessions, ...bridgeSessions]) {
    sessionsByPath.set(resolve(session.path), session);
  }
  return [...sessionsByPath.values()];
}

/**
 * Resolve a provider-native Pi id only inside BB's host-local bridge store.
 * Callers fail closed unless this returns exactly one path.
 */
export async function findPiBridgeSessionPaths(
  args: FindPiBridgeSessionPathsArgs,
): Promise<string[]> {
  const listAll = args.listAll ?? defaultListAll;
  const bridgeSessionDir = resolvePiBridgeSessionDir({
    env: args.env ?? process.env,
  });
  const sessions = await listAll(bridgeSessionDir);
  return [
    ...new Set(
      sessions
        .filter((session) => session.id === args.nativeConversationId)
        .map((session) => resolve(session.path)),
    ),
  ];
}
