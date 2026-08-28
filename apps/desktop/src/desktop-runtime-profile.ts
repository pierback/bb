import { join } from "node:path";
import {
  BB_LOOPBACK_HOST,
  BB_MESH_PREVIEW_HOST_DAEMON_PORT,
  BB_MESH_PREVIEW_SERVER_PORT,
  BB_MESH_RELEASE_HOST_DAEMON_PORT,
  BB_MESH_RELEASE_SERVER_PORT,
  BB_PROD_HOST_DAEMON_PORT,
  BB_PROD_SERVER_PORT,
  resolveConfiguredDataDir,
  resolvePortFromEnv,
} from "@bb/config/runtime";
import type { DesktopBuildFlavor } from "./desktop-update-provider.js";

const PACKAGED_RUNTIME_PORTS: Record<
  DesktopBuildFlavor,
  { hostDaemonPort: number; serverPort: number }
> = {
  preview: {
    hostDaemonPort: BB_MESH_PREVIEW_HOST_DAEMON_PORT,
    serverPort: BB_MESH_PREVIEW_SERVER_PORT,
  },
  release: {
    hostDaemonPort: BB_MESH_RELEASE_HOST_DAEMON_PORT,
    serverPort: BB_MESH_RELEASE_SERVER_PORT,
  },
};

export interface DesktopRuntimeProfile {
  dataDir: string;
  hostDaemonPort: number;
  serverPort: number;
  serverUrl: string;
}

interface ResolveDesktopRuntimeProfileArgs {
  allowPackagedPortOverrides: boolean;
  buildFlavor: DesktopBuildFlavor;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  isPackaged: boolean;
  userDataPath: string;
}

interface CreateDesktopRuntimeProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  profile: DesktopRuntimeProfile;
}

interface CanAttachToDesktopRuntimeArgs {
  allowForeignRuntime: boolean;
  dataDir: string | null;
  isPackaged: boolean;
  profile: DesktopRuntimeProfile;
}

/**
 * Resolves the private local runtime owned by one desktop product.
 *
 * Packaged BB Mesh builds must never share official bb's ports or `~/.bb`
 * directory: sharing either lets one product attach to the other's renderer or
 * collide with its daemon lock. Development intentionally retains the
 * worktree-provided bb runtime so HMR and the desktop shell can attach.
 */
export function resolveDesktopRuntimeProfile(
  args: ResolveDesktopRuntimeProfileArgs,
): DesktopRuntimeProfile {
  const packagedDefaults = PACKAGED_RUNTIME_PORTS[args.buildFlavor];
  const portOverrideEnv =
    !args.isPackaged || args.allowPackagedPortOverrides ? args.env : {};
  const serverPort = resolvePortFromEnv({
    defaultPort: args.isPackaged
      ? packagedDefaults.serverPort
      : BB_PROD_SERVER_PORT,
    env: portOverrideEnv,
    name: "BB_SERVER_PORT",
  });
  const hostDaemonPort = resolvePortFromEnv({
    defaultPort: args.isPackaged
      ? packagedDefaults.hostDaemonPort
      : BB_PROD_HOST_DAEMON_PORT,
    env: portOverrideEnv,
    name: "BB_HOST_DAEMON_PORT",
  });

  return {
    dataDir: args.isPackaged
      ? join(args.userDataPath, "runtime")
      : resolveConfiguredDataDir({
          defaultDataDir: join(args.homeDir, ".bb"),
          env: args.env,
          homeDir: args.homeDir,
        }),
    hostDaemonPort,
    serverPort,
    serverUrl: `http://${BB_LOOPBACK_HOST}:${String(serverPort)}`,
  };
}

export function createDesktopRuntimeProcessEnv(
  args: CreateDesktopRuntimeProcessEnvArgs,
): NodeJS.ProcessEnv {
  return {
    ...args.env,
    BB_DATA_DIR: args.profile.dataDir,
    BB_HOST_DAEMON_PORT: String(args.profile.hostDaemonPort),
    BB_SERVER_PORT: String(args.profile.serverPort),
  };
}

/**
 * Packaged builds attach only to the private runtime profile they own. A
 * compatible bb API on the same port is not sufficient product identity.
 * Development and explicit smoke-test harnesses may deliberately attach to a
 * separately launched server.
 */
export function canAttachToDesktopRuntime(
  args: CanAttachToDesktopRuntimeArgs,
): boolean {
  if (!args.isPackaged || args.allowForeignRuntime) {
    return true;
  }
  return args.dataDir === args.profile.dataDir;
}
