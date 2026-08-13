import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  bbDesktopUpdateChannelSchema,
  parsePierbackDesktopUpdateChannelPreference,
  PIERBACK_DESKTOP_UPDATE_CHANNEL_FILE_NAME,
  serializePierbackDesktopUpdateChannelPreference,
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

export interface ResolvePierbackDesktopUserDataPathArgs {
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

export interface CreateNodeDesktopUpdatesArgs extends ResolvePierbackDesktopUserDataPathArgs {
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

export function resolvePierbackDesktopUserDataPath(
  args: ResolvePierbackDesktopUserDataPathArgs = {},
): string {
  const env = args.env ?? process.env;
  const homeDirectory = args.homeDirectory ?? homedir();
  const platform = args.platform ?? process.platform;
  if (platform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", "Pierback");
  }
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(homeDirectory, "AppData", "Roaming"),
      "Pierback",
    );
  }
  return join(
    env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"),
    "Pierback",
  );
}

export function createNodeDesktopUpdates(
  args: CreateNodeDesktopUpdatesArgs = {},
): NodeDesktopUpdates {
  const fileSystem = args.fileSystem ?? defaultFileSystem;
  const storagePath =
    args.storagePath ??
    join(
      resolvePierbackDesktopUserDataPath(args),
      PIERBACK_DESKTOP_UPDATE_CHANNEL_FILE_NAME,
    );

  return {
    storagePath,
    async getChannel() {
      try {
        return parsePierbackDesktopUpdateChannelPreference(
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
          serializePierbackDesktopUpdateChannelPreference(parsedChannel),
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
