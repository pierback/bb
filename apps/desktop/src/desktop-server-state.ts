import type {
  BbDesktopExecutionHostState,
  BbDesktopServerOption,
  BbDesktopServerState,
} from "@bb/desktop-contract";
import {
  BUILTIN_SERVER_NAME,
  type ConnectServerRef,
  type DesktopServerTarget,
} from "./server-target.js";

export const BUILTIN_SERVER_ID = "builtin";
export const CUSTOM_SERVER_ID = "custom";

export function connectServerId(handle: string): string {
  return `connect:${handle}`;
}

export interface BuildDesktopServerStateArgs {
  builtinServerUrl: string;
  connectServers: readonly ConnectServerRef[];
  customServerUrl: string | null;
  executionHost: BbDesktopExecutionHostState | null;
  savedConnectServer: ConnectServerRef | null;
  target: DesktopServerTarget;
}

function customServerName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? parsed.host : url;
  } catch {
    return url;
  }
}

/**
 * One read model shared by the native Server menu and Settings → BB Server.
 * The persisted Connect target is retained if account sync is temporarily
 * unavailable so the selected row never disappears.
 */
export function buildDesktopServerState(
  args: BuildDesktopServerStateArgs,
): BbDesktopServerState {
  const connectServers = [...args.connectServers];
  const savedConnectServer =
    args.savedConnectServer ??
    (args.target.kind === "connect" ? args.target.server : null);
  if (savedConnectServer !== null) {
    if (
      !connectServers.some(
        (server) => server.handle === savedConnectServer.handle,
      )
    ) {
      connectServers.push(savedConnectServer);
    }
  }

  const servers: BbDesktopServerState["servers"] = [
    {
      id: BUILTIN_SERVER_ID,
      kind: "builtin",
      name: BUILTIN_SERVER_NAME,
      url: args.builtinServerUrl,
    },
    ...connectServers.map<BbDesktopServerOption>((server) => ({
      handle: server.handle,
      id: connectServerId(server.handle),
      kind: "connect",
      name: server.name,
      url: server.url,
    })),
  ];

  if (args.customServerUrl !== null) {
    servers.push({
      id: CUSTOM_SERVER_ID,
      kind: "custom",
      name: customServerName(args.customServerUrl),
      url: args.customServerUrl,
    });
  }

  const activeServerId =
    args.target.kind === "builtin"
      ? BUILTIN_SERVER_ID
      : args.target.kind === "custom"
        ? CUSTOM_SERVER_ID
        : connectServerId(args.target.server.handle);

  return { activeServerId, executionHost: args.executionHost, servers };
}
