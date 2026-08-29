import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNodeDesktopUpdates,
  resolveBbMeshDesktopUserDataPath,
} from "../src/desktop-updates.js";

describe("Node desktop updates SDK", () => {
  it("reads and atomically changes the installed BB Mesh channel", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "bb-mesh-sdk-updates-"));
    const storagePath = resolve(directory, "desktop-update-channel.json");
    const updates = createNodeDesktopUpdates({ storagePath });

    await expect(updates.getChannel()).resolves.toBe("stable");
    await expect(updates.setChannel("canary")).resolves.toBe("canary");
    await expect(updates.getChannel()).resolves.toBe("canary");
    await expect(readFile(storagePath, "utf8")).resolves.toContain(
      '"channel": "canary"',
    );
  });

  it("fails closed on a malformed existing preference", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "bb-mesh-sdk-updates-"));
    const storagePath = resolve(directory, "desktop-update-channel.json");
    await writeFile(storagePath, '{"channel":"official"}\n', "utf8");

    await expect(
      createNodeDesktopUpdates({ storagePath }).getChannel(),
    ).rejects.toThrow();
  });

  it("resolves Electron's BB Mesh user-data directory on macOS", () => {
    expect(
      resolveBbMeshDesktopUserDataPath({
        homeDirectory: "/Users/tester",
        platform: "darwin",
      }),
    ).toBe("/Users/tester/Library/Application Support/BB Mesh");
  });
});
