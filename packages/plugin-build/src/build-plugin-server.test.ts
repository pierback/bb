import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPluginServer,
  PLUGIN_SERVER_EXTERNALS,
} from "./build-plugin-server.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";

/** The monorepo's own toolchain; resolves esbuild without downloading. */
function testToolchain() {
  return resolvePluginBuildToolchain(join(tmpdir(), "bb-toolchain-unused"));
}

describe("plugin server build", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("keeps only the published SDK package external", () => {
    expect(PLUGIN_SERVER_EXTERNALS).toContain("@get-bb/plugin-sdk");
    expect(PLUGIN_SERVER_EXTERNALS).not.toContain("@bb/plugin-sdk");
  });

  it("rejects a pre-rename SDK import until the plugin is migrated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-plugin-server-legacy-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-legacy-sdk-fixture",
        version: "0.0.0",
        bb: {
          name: "Legacy SDK fixture",
          description: "Verifies the pre-rename SDK specifier is rejected.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "server.ts"),
      [
        'import type { BbPluginApi } from "@bb/plugin-sdk";',
        'import { defineRpcContract } from "@bb/plugin-sdk";',
        "export default function plugin(bb: BbPluginApi) {",
        "  void defineRpcContract;",
        "  void bb;",
        "}",
        "",
      ].join("\n"),
    );

    await expect(
      buildPluginServer(dir, "0.0.0-test", await testToolchain()),
    ).rejects.toThrow(/Could not resolve "@bb\/plugin-sdk"/u);
  });
});
