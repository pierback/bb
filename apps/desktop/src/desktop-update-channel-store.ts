import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parsePierbackDesktopUpdateChannelPreference,
  PIERBACK_DESKTOP_UPDATE_CHANNEL_FILE_NAME,
  serializePierbackDesktopUpdateChannelPreference,
  type BbDesktopUpdateChannel,
} from "@bb/desktop-contract";

export const DESKTOP_UPDATE_CHANNEL_FILE_NAME =
  PIERBACK_DESKTOP_UPDATE_CHANNEL_FILE_NAME;

export interface DesktopUpdateChannelFs {
  mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

export interface DesktopUpdateChannelStore {
  adoptChannel(channel: BbDesktopUpdateChannel): void;
  getChannel(): BbDesktopUpdateChannel;
  load(): Promise<void>;
  setChannel(channel: BbDesktopUpdateChannel): Promise<void>;
}

export interface CreateDesktopUpdateChannelStoreArgs {
  defaultChannel: BbDesktopUpdateChannel;
  fs?: DesktopUpdateChannelFs;
  storagePath: string;
}

const defaultFs: DesktopUpdateChannelFs = {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
};

function parsePersistedChannel(raw: string): BbDesktopUpdateChannel | null {
  try {
    return parsePierbackDesktopUpdateChannelPreference(raw);
  } catch {
    return null;
  }
}

export function createDesktopUpdateChannelStore(
  args: CreateDesktopUpdateChannelStoreArgs,
): DesktopUpdateChannelStore {
  const fsImpl = args.fs ?? defaultFs;
  let channel = args.defaultChannel;

  async function persist(nextChannel: BbDesktopUpdateChannel): Promise<void> {
    const parentPath = dirname(args.storagePath);
    const temporaryPath = `${args.storagePath}.${randomUUID()}.tmp`;
    await fsImpl.mkdir(parentPath, { recursive: true });
    try {
      await fsImpl.writeFile(
        temporaryPath,
        serializePierbackDesktopUpdateChannelPreference(nextChannel),
        "utf8",
      );
      await fsImpl.rename(temporaryPath, args.storagePath);
    } catch (error) {
      await fsImpl.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  return {
    adoptChannel(nextChannel) {
      channel = nextChannel;
    },
    getChannel() {
      return channel;
    },
    async load() {
      try {
        channel =
          parsePersistedChannel(
            await fsImpl.readFile(args.storagePath, "utf8"),
          ) ?? args.defaultChannel;
      } catch {
        channel = args.defaultChannel;
      }
    },
    async setChannel(nextChannel) {
      if (channel === nextChannel) {
        return;
      }
      await persist(nextChannel);
      channel = nextChannel;
    },
  };
}
