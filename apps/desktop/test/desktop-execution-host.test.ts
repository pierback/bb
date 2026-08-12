import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_EXECUTION_DAEMON_PATH_ENV,
  prepareDesktopExecutionHostAuth,
  readDesktopExecutionHostAuth,
  resolveDesktopExecutionDaemonOverride,
} from "../src/desktop-execution-host.js";
import {
  desktopExecutionHostAuthenticationEnv,
  validateDesktopCoordinatorHostKey,
} from "../src/desktop-coordinator-auth.js";

const SERVER_URL = "https://bb.example.test";

function executionHostDataDir(userDataPath: string): string {
  const originHash = createHash("sha256")
    .update(new URL(SERVER_URL).origin)
    .digest("hex")
    .slice(0, 16);
  return join(userDataPath, "execution-hosts", originHash);
}

describe("resolveDesktopExecutionDaemonOverride", () => {
  it("keeps Connect and self-hosted native daemon authentication disjoint", () => {
    expect(
      desktopExecutionHostAuthenticationEnv({
        credential: "bbcm_machine",
        kind: "connect",
        machineId: "machine_1",
      }),
    ).toEqual({
      BB_CONNECT_MACHINE_CREDENTIAL: "bbcm_machine",
      BB_CONNECT_MACHINE_ID: "machine_1",
    });
    expect(desktopExecutionHostAuthenticationEnv({ kind: "native" })).toEqual({
      BB_NATIVE_CLIENT_AUTH: "1",
    });
  });

  it("uses only an explicit absolute local daemon path", () => {
    expect(resolveDesktopExecutionDaemonOverride({})).toBeNull();
    expect(
      resolveDesktopExecutionDaemonOverride({
        [DESKTOP_EXECUTION_DAEMON_PATH_ENV]:
          "  /Applications/bb.app/daemon-bundle.mjs  ",
      }),
    ).toBe("/Applications/bb.app/daemon-bundle.mjs");
    expect(() =>
      resolveDesktopExecutionDaemonOverride({
        [DESKTOP_EXECUTION_DAEMON_PATH_ENV]: "./downloaded-daemon.mjs",
      }),
    ).toThrow(`${DESKTOP_EXECUTION_DAEMON_PATH_ENV} must be absolute`);
  });

  it("keeps the native coordinator host key scoped to the server origin", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "bb-desktop-host-auth-"));
    const serverUrl = "https://bb.example.test/path-is-not-identity";
    const originHash = createHash("sha256")
      .update(new URL(serverUrl).origin)
      .digest("hex")
      .slice(0, 16);
    const dataDir = join(userDataPath, "execution-hosts", originHash);
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, "auth.json"),
        JSON.stringify({ hostId: "host_desktop", hostKey: "host-key" }),
      );

      await expect(
        readDesktopExecutionHostAuth({ serverUrl, userDataPath }),
      ).resolves.toEqual({ hostId: "host_desktop", hostKey: "host-key" });

      await writeFile(
        join(dataDir, "auth.json"),
        JSON.stringify({ hostId: "host_desktop" }),
      );
      await expect(
        readDesktopExecutionHostAuth({ serverUrl, userDataPath }),
      ).resolves.toBeNull();
    } finally {
      await rm(userDataPath, { force: true, recursive: true });
    }
  });

  it("validates a host key without following an Authelia redirect", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));

    await expect(
      validateDesktopCoordinatorHostKey({
        authentication: { kind: "native" },
        fetchImpl,
        hostKey: "host-key",
        serverUrl: SERVER_URL,
      }),
    ).resolves.toBe("accepted");
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://bb.example.test/health"),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer host-key",
          "x-bb-native-client": "host-key-v1",
        }),
        redirect: "manual",
      }),
    );

    fetchImpl.mockResolvedValueOnce(
      new Response(null, {
        headers: { location: "https://auth.example.test" },
        status: 302,
      }),
    );
    await expect(
      validateDesktopCoordinatorHostKey({
        authentication: { kind: "native" },
        fetchImpl,
        hostKey: "host-key",
        serverUrl: SERVER_URL,
      }),
    ).rejects.toThrow("Could not validate this Mac");
  });

  it("re-pairs only after the coordinator rejects the saved host key", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "bb-desktop-repair-"));
    const dataDir = executionHostDataDir(userDataPath);
    const authPath = join(dataDir, "auth.json");
    const hostIdPath = join(dataDir, "host-id");
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        authPath,
        JSON.stringify({ hostId: "host_old", hostKey: "revoked-key" }),
      );
      await writeFile(hostIdPath, "host_old\n");

      await expect(
        prepareDesktopExecutionHostAuth({
          authentication: { kind: "native" },
          fetchImpl: vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 401 })),
          serverUrl: SERVER_URL,
          userDataPath,
        }),
      ).resolves.toBeNull();
      await expect(access(authPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(hostIdPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(userDataPath, { force: true, recursive: true });
    }
  });

  it("preserves saved enrollment across coordinator network failures", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "bb-desktop-offline-"));
    const dataDir = executionHostDataDir(userDataPath);
    const authPath = join(dataDir, "auth.json");
    const hostIdPath = join(dataDir, "host-id");
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        authPath,
        JSON.stringify({ hostId: "host_saved", hostKey: "saved-key" }),
      );
      await writeFile(hostIdPath, "host_saved\n");

      await expect(
        prepareDesktopExecutionHostAuth({
          authentication: { kind: "native" },
          fetchImpl: vi
            .fn<typeof fetch>()
            .mockRejectedValue(new Error("NAS is offline")),
          serverUrl: SERVER_URL,
          userDataPath,
        }),
      ).rejects.toThrow("NAS is offline");
      await expect(readFile(authPath, "utf8")).resolves.toContain("saved-key");
      await expect(readFile(hostIdPath, "utf8")).resolves.toBe("host_saved\n");
    } finally {
      await rm(userDataPath, { force: true, recursive: true });
    }
  });
});
