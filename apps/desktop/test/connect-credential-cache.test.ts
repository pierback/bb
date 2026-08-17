import { describe, expect, it, vi } from "vitest";
import {
  createConnectCredentialCache,
  type ConnectCredentialCacheFs,
  type ConnectCredentialEncryption,
} from "../src/connect-credential-cache.js";

const CREDENTIAL = {
  credential: "bbcm_desktop",
  handle: "laptop",
  machineId: "machine-1",
  serverUrl: "https://laptop.getbb.app",
};

/** Stand-in for the OS keychain: a reversible byte tag, never plain JSON. */
function createEncryption(
  available = true,
): ConnectCredentialEncryption & { available: boolean } {
  return {
    available,
    getSelectedStorageBackend() {
      return "gnome_libsecret";
    },
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(plainText) {
      return Buffer.from(`sealed:${plainText}`);
    },
    decryptString(encrypted) {
      const text = encrypted.toString();
      if (!text.startsWith("sealed:")) {
        throw new Error("cannot decrypt");
      }
      return text.slice("sealed:".length);
    },
  };
}

function createFs(seed: Buffer | null = null): ConnectCredentialCacheFs & {
  file: Buffer | null;
} {
  return {
    file: seed,
    async readFile() {
      if (this.file === null) {
        throw new Error("ENOENT");
      }
      return this.file;
    },
    async rm() {
      this.file = null;
    },
    async writeFile(_path, data) {
      this.file = data;
    },
  };
}

describe("createConnectCredentialCache", () => {
  it("round-trips a credential through the keychain", async () => {
    const fs = createFs();
    const cache = createConnectCredentialCache({
      encryption: createEncryption(),
      fs,
      platform: "darwin",
      userDataPath: "/data",
    });

    await cache.write(CREDENTIAL);
    // Only sealed bytes reach the disk; the cache never writes plain JSON.
    expect(fs.file?.toString().startsWith("sealed:")).toBe(true);
    await expect(cache.read()).resolves.toEqual(CREDENTIAL);

    await cache.clear();
    await expect(cache.read()).resolves.toBeNull();
  });

  it("never writes the secret when the OS offers no encryption", async () => {
    const fs = createFs();
    const encryption = createEncryption(false);
    const encryptString = vi.spyOn(encryption, "encryptString");

    const cache = createConnectCredentialCache({
      encryption,
      fs,
      platform: "darwin",
      userDataPath: "/data",
    });
    await cache.write(CREDENTIAL);

    // The caller checks this before enrolling, so a keychain-less machine
    // never burns an account machine slot on every launch.
    expect(cache.canPersist()).toBe(false);
    expect(encryptString).not.toHaveBeenCalled();
    expect(fs.file).toBeNull();
    await expect(cache.read()).resolves.toBeNull();
  });

  it("does not consult the keychain when no cached credential exists", async () => {
    const fs = createFs();
    const encryption = createEncryption();
    const isEncryptionAvailable = vi.spyOn(encryption, "isEncryptionAvailable");
    const cache = createConnectCredentialCache({
      encryption,
      fs,
      platform: "darwin",
      userDataPath: "/data",
    });

    await expect(cache.read()).resolves.toBeNull();
    expect(isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it("drops bytes it cannot decrypt or parse", async () => {
    const undecryptable = createFs(Buffer.from("from-another-machine"));
    await expect(
      createConnectCredentialCache({
        encryption: createEncryption(),
        fs: undecryptable,
        platform: "darwin",
        userDataPath: "/data",
      }).read(),
    ).resolves.toBeNull();
    expect(undecryptable.file).toBeNull();

    const wrongShape = createFs(
      Buffer.from(`sealed:${JSON.stringify({ handle: "laptop" })}`),
    );
    await expect(
      createConnectCredentialCache({
        encryption: createEncryption(),
        fs: wrongShape,
        platform: "darwin",
        userDataPath: "/data",
      }).read(),
    ).resolves.toBeNull();
    expect(wrongShape.file).toBeNull();
  });

  it("drops a server pairing credential that has no client machine identity", async () => {
    const serverCredential = createFs(
      Buffer.from(
        `sealed:${JSON.stringify({
          credential: "bbcred_server",
          handle: "laptop",
          serverUrl: "https://laptop.getbb.app",
        })}`,
      ),
    );

    await expect(
      createConnectCredentialCache({
        encryption: createEncryption(),
        fs: serverCredential,
        platform: "darwin",
        userDataPath: "/data",
      }).read(),
    ).resolves.toBeNull();
    expect(serverCredential.file).toBeNull();
  });

  it("removes credentials when Linux has no secure storage backend", async () => {
    for (const backend of ["basic_text", "unknown"] as const) {
      const fs = createFs(Buffer.from("recoverable-legacy-credential"));
      const encryption = createEncryption();
      encryption.getSelectedStorageBackend = () => backend;
      const encryptString = vi.spyOn(encryption, "encryptString");
      const cache = createConnectCredentialCache({
        encryption,
        fs,
        platform: "linux",
        userDataPath: "/data",
      });

      expect(cache.canPersist()).toBe(false);
      await expect(cache.read()).resolves.toBeNull();
      expect(fs.file).toBeNull();

      fs.file = Buffer.from("recoverable-legacy-credential");
      await cache.write(CREDENTIAL);
      expect(encryptString).not.toHaveBeenCalled();
      expect(fs.file).toBeNull();
    }
  });
});
