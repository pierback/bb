import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortableSessionPort } from "../portable-session-registry.js";
import { createCodexPortableSessionAdapter } from "./portable-session.js";

const tempDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-codex-portable-session-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function sessionMetadata(providerThreadId: string): string {
  return `${JSON.stringify({
    timestamp: "2026-08-10T00:00:00.000Z",
    type: "session_meta",
    payload: { id: providerThreadId },
  })}\n`;
}

async function writeSession(args: {
  codexHome: string;
  content: string;
  relativePath: string;
}): Promise<string> {
  const filePath = path.join(args.codexHome, args.relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, args.content);
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("Codex portable sessions", () => {
  it("exports sessions by exact metadata identity instead of filename text", async () => {
    const codexHome = await createTempDirectory();
    const requestedId = "019fde03-efb1-7c13-b195-9de038cf9aad";
    const missingId = "019fde03-efb1-7c13-b195-9de038cf9aae";
    await writeSession({
      codexHome,
      content: sessionMetadata("different-provider-thread"),
      relativePath: path.join(
        "sessions",
        "2026",
        "08",
        `rollout-${requestedId}.jsonl`,
      ),
    });
    const exactSessionPath = await writeSession({
      codexHome,
      content: sessionMetadata(requestedId),
      relativePath: path.join(
        "archived_sessions",
        "rollout-without-thread-id-in-filename.jsonl",
      ),
    });

    const adapter = createCodexPortableSessionAdapter({
      env: { CODEX_HOME: codexHome },
    });
    const result = await adapter.exportSessions([requestedId, missingId]);

    expect(result).toEqual({
      artifacts: [
        {
          adapterPath:
            "archived_sessions/rollout-without-thread-id-in-filename.jsonl",
          sourcePath: exactSessionPath,
        },
      ],
      missingProviderThreadIds: [missingId],
    });
  });

  it("imports idempotently, reports conflicts, and cleans up by opaque token", async () => {
    const root = await createTempDirectory();
    const sourcePath = path.join(root, "source.jsonl");
    const codexHome = path.join(root, "target-codex");
    const adapterPath = "sessions/2026/08/10/rollout.jsonl";
    const targetPath = path.join(codexHome, adapterPath);
    const content = sessionMetadata("provider-thread-1");
    await fs.writeFile(sourcePath, content);
    const adapter = createCodexPortableSessionAdapter({
      env: { CODEX_HOME: codexHome },
    });
    const registeredTokens: string[] = [];
    const registerCleanup = vi.fn(async (token: string) => {
      await expect(fs.access(targetPath)).rejects.toThrow();
      registeredTokens.push(token);
    });
    const importArgs = {
      adapterPath,
      expectedSha256: createHash("sha256").update(content).digest("hex"),
      mode: 0o640,
      registerCleanup,
      sourcePath,
    };

    await expect(adapter.importArtifact(importArgs)).resolves.toEqual({
      outcome: "installed",
    });
    await expect(adapter.importArtifact(importArgs)).resolves.toEqual({
      outcome: "already_present",
    });
    expect(registerCleanup).toHaveBeenCalledTimes(1);
    expect(registeredTokens).toEqual([adapterPath]);
    expect(await fs.readFile(targetPath, "utf8")).toBe(content);
    expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o640);

    await adapter.cleanupImport(registeredTokens[0] ?? "missing");
    await adapter.cleanupImport(registeredTokens[0] ?? "missing");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "different");
    await expect(adapter.importArtifact(importArgs)).resolves.toEqual({
      outcome: "conflict",
    });
    expect(registerCleanup).toHaveBeenCalledTimes(1);
  });

  it("returns typed unsupported capability results for other providers", async () => {
    const port = createPortableSessionPort({ env: {} });

    await expect(
      port.exportSessions({
        providerId: "claude-code",
        providerThreadIds: ["session-1"],
      }),
    ).resolves.toEqual({
      availability: "unsupported",
      providerId: "claude-code",
    });
    await expect(
      port.importArtifact({
        expectedSha256: "a".repeat(64),
        mode: 0o600,
        portablePath: "claude-code/sessions/session.jsonl",
        registerCleanup: vi.fn(),
        sourcePath: "/unused",
      }),
    ).resolves.toEqual({
      availability: "unsupported",
      providerId: "claude-code",
    });
    await expect(
      port.cleanupImport({ providerId: "claude-code", token: "opaque" }),
    ).resolves.toEqual({
      availability: "unsupported",
      providerId: "claude-code",
    });
  });
});
