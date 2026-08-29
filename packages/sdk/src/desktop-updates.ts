import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  bbDesktopUpdateChannelSchema,
  parseBbMeshDesktopUpdateChannelPreference,
  BB_MESH_DESKTOP_UPDATE_CHANNEL_FILE_NAME,
  serializeBbMeshDesktopUpdateChannelPreference,
  type BbDesktopUpdateChannel,
} from "@bb/desktop-contract";

export interface NodeDesktopUpdates {
  readonly storagePath: string;
  getChannel(): Promise<BbDesktopUpdateChannel>;
  setChannel(channel: BbDesktopUpdateChannel): Promise<BbDesktopUpdateChannel>;
}

export interface DesktopUpdatesFileSystem {
  mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

export interface ResolveBbMeshDesktopUserDataPathArgs {
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  /** OS platform identifier. Values other than macOS and Windows use XDG paths. */
  platform?: string;
}

export interface CreateNodeDesktopUpdatesArgs extends ResolveBbMeshDesktopUserDataPathArgs {
  fileSystem?: DesktopUpdatesFileSystem;
  storagePath?: string;
}

const defaultFileSystem: DesktopUpdatesFileSystem = {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export function resolveBbMeshDesktopUserDataPath(
  args: ResolveBbMeshDesktopUserDataPathArgs = {},
): string {
  const env = args.env ?? process.env;
  const homeDirectory = args.homeDirectory ?? homedir();
  const platform = args.platform ?? process.platform;
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "BB Mesh");
  }
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(homeDirectory, "AppData", "Roaming"),
      "BB Mesh",
    );
  }
  return join(env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), "BB Mesh");
}

export function createNodeDesktopUpdates(
  args: CreateNodeDesktopUpdatesArgs = {},
): NodeDesktopUpdates {
  const fileSystem = args.fileSystem ?? defaultFileSystem;
  const storagePath =
    args.storagePath ??
    join(
      resolveBbMeshDesktopUserDataPath(args),
      BB_MESH_DESKTOP_UPDATE_CHANNEL_FILE_NAME,
    );

  return {
    storagePath,
    async getChannel() {
      try {
        return parseBbMeshDesktopUpdateChannelPreference(
          await fileSystem.readFile(storagePath, "utf8"),
        );
      } catch (error) {
        if (errorCode(error) === "ENOENT") return "stable";
        throw error;
      }
    },
    async setChannel(channel) {
      const parsedChannel = bbDesktopUpdateChannelSchema.parse(channel);
      const temporaryPath = `${storagePath}.${randomUUID()}.tmp`;
      await fileSystem.mkdir(dirname(storagePath), { recursive: true });
      try {
        await fileSystem.writeFile(
          temporaryPath,
          serializeBbMeshDesktopUpdateChannelPreference(parsedChannel),
          "utf8",
        );
        await fileSystem.rename(temporaryPath, storagePath);
      } catch (error) {
        await fileSystem
          .rm(temporaryPath, { force: true })
          .catch(() => undefined);
        throw error;
      }
      return parsedChannel;
    },
  };
}
