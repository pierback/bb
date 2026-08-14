import { describe, expect, it } from "vitest";
import {
  createDesktopUpdateChannelStore,
  type DesktopUpdateChannelFs,
} from "../src/desktop-update-channel-store.js";

function createMemoryFs(initial: Record<string, string> = {}): {
  files: Map<string, string>;
  fs: DesktopUpdateChannelFs;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    fs: {
      async mkdir() {
        return undefined;
      },
      async readFile(path) {
        const value = files.get(path);
        if (value === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return value;
      },
      async rename(oldPath, newPath) {
        const value = files.get(oldPath);
        if (value === undefined) {
          throw new Error(`ENOENT: ${oldPath}`);
        }
        files.delete(oldPath);
        files.set(newPath, value);
      },
      async unlink(path) {
        files.delete(path);
      },
      async writeFile(path, value) {
        files.set(path, value);
      },
    },
  };
}

describe("desktop update channel store", () => {
  it("uses the build flavor's default when no persisted selection exists", async () => {
    const store = createDesktopUpdateChannelStore({
      defaultChannel: "stable",
      fs: createMemoryFs().fs,
      storagePath: "/tmp/update-channel.json",
    });

    await store.load();

    expect(store.getChannel()).toBe("stable");
  });

  it("atomically persists and reloads an explicit canary selection", async () => {
    const { files, fs } = createMemoryFs();
    const storagePath = "/tmp/update-channel.json";
    const store = createDesktopUpdateChannelStore({
      defaultChannel: "stable",
      fs,
      storagePath,
    });

    await store.setChannel("canary");

    expect(files.get(storagePath)).toBe(
      '{\n  "channel": "canary",\n  "schemaVersion": 1\n}\n',
    );
    const reloaded = createDesktopUpdateChannelStore({
      defaultChannel: "stable",
      fs,
      storagePath,
    });
    await reloaded.load();
    expect(reloaded.getChannel()).toBe("canary");
  });

  it("fails closed to the supplied default for malformed state", async () => {
    const store = createDesktopUpdateChannelStore({
      defaultChannel: "canary",
      fs: createMemoryFs({
        "/tmp/update-channel.json": JSON.stringify({
          channel: "latest",
          schemaVersion: 1,
        }),
      }).fs,
      storagePath: "/tmp/update-channel.json",
    });

    await store.load();

    expect(store.getChannel()).toBe("canary");
  });

  it("adopts an externally persisted selection without writing the file again", () => {
    const { files, fs } = createMemoryFs();
    const store = createDesktopUpdateChannelStore({
      defaultChannel: "stable",
      fs,
      storagePath: "/tmp/update-channel.json",
    });

    store.adoptChannel("canary");

    expect(store.getChannel()).toBe("canary");
    expect(files.size).toBe(0);
  });

  it("does not publish the new channel when the atomic rename fails", async () => {
    const { files, fs } = createMemoryFs();
    fs.rename = async () => {
      throw new Error("disk full");
    };
    const store = createDesktopUpdateChannelStore({
      defaultChannel: "stable",
      fs,
      storagePath: "/tmp/update-channel.json",
    });

    await expect(store.setChannel("canary")).rejects.toThrow("disk full");

    expect(store.getChannel()).toBe("stable");
    expect([...files.keys()]).toEqual([]);
  });
});
