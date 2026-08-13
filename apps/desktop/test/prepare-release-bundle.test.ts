import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { bbDesktopVersionFeedSchema } from "@bb/desktop-contract";
import { prepareDesktopReleaseBundle } from "../scripts/prepare-release-bundle.mjs";

function sha512(value: string): string {
  return createHash("sha512").update(value).digest("base64");
}

describe("prepare desktop release bundle", () => {
  it("creates canary and stable metadata over the same immutable artifacts", async () => {
    const releaseDirectory = await mkdtemp(
      resolve(tmpdir(), "pierback-release-bundle-"),
    );
    const zipName = "pierback-1.2.3-arm64-mac.zip";
    const dmgName = "pierback-1.2.3-arm64.dmg";
    const blockmapName = `${zipName}.blockmap`;
    const zip = "signed-zip";
    await Promise.all([
      writeFile(resolve(releaseDirectory, zipName), zip),
      writeFile(resolve(releaseDirectory, dmgName), "signed-dmg"),
      writeFile(resolve(releaseDirectory, blockmapName), "blockmap"),
      writeFile(
        resolve(releaseDirectory, "stable-mac.yml"),
        stringifyYaml({
          files: [
            {
              sha512: sha512(zip),
              size: Buffer.byteLength(zip),
              url: zipName,
            },
          ],
          path: zipName,
          releaseDate: "2026-08-12T00:00:00.000Z",
          sha512: sha512(zip),
          version: "1.2.3",
        }),
      ),
    ]);

    const files = await prepareDesktopReleaseBundle({
      releaseDirectory,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      version: "1.2.3",
    });

    expect(files).toContain("SHA256SUMS");
    const releaseManifest = JSON.parse(
      await readFile(
        resolve(releaseDirectory, "release-manifest.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(releaseManifest).toMatchObject({
      applicationId: "de.staufingers.pierback.desktop",
      applicationName: "Pierback",
      desktopVersion: "1.2.3",
      primaryZip: zipName,
      schemaVersion: 1,
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(releaseManifest.hostDaemonProtocolVersion).toBeTypeOf("number");
    await expect(
      readFile(resolve(releaseDirectory, "canary-mac.yml"), "utf8"),
    ).resolves.toBe(
      await readFile(resolve(releaseDirectory, "stable-mac.yml"), "utf8"),
    );
    for (const channel of ["canary", "stable"] as const) {
      const feed = bbDesktopVersionFeedSchema.parse(
        JSON.parse(
          await readFile(
            resolve(releaseDirectory, `${channel}-desktop-version.json`),
            "utf8",
          ),
        ),
      );
      expect(feed.channel).toBe(channel);
      expect(feed.path).toBe(zipName);
      expect(feed.sha512).toBe(sha512(zip));
    }
    const manifest = await readFile(
      resolve(releaseDirectory, "SHA256SUMS"),
      "utf8",
    );
    expect(manifest).toContain(`  ${zipName}\n`);
    expect(manifest).toContain("  canary-mac.yml\n");
    expect(manifest).toContain("  stable-mac.yml\n");
  });

  it("rejects metadata that points outside the release bundle", async () => {
    const releaseDirectory = await mkdtemp(
      resolve(tmpdir(), "pierback-release-bundle-"),
    );
    await writeFile(
      resolve(releaseDirectory, "stable-mac.yml"),
      stringifyYaml({
        files: [{ sha512: "x", size: 1, url: "../escape.zip" }],
        path: "../escape.zip",
        releaseDate: "2026-08-12T00:00:00.000Z",
        sha512: "x",
        version: "1.2.3",
      }),
    );

    await expect(
      prepareDesktopReleaseBundle({
        releaseDirectory,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        version: "1.2.3",
      }),
    ).rejects.toThrow("Unsafe or unexpected Pierback release artifact");
  });
});
