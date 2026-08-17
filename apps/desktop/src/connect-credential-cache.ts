import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  connectMachineCredentialSchema,
  type ConnectMachineCredential,
} from "@bb/connect-client";

export const CONNECT_CREDENTIAL_FILE_NAME = "connect-credential.bin";

export type ConnectCredentialStorageBackend =
  | "basic_text"
  | "gnome_libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6"
  | "unknown";

/** Electron's `safeStorage`, narrowed to what the cache uses. */
export interface ConnectCredentialEncryption {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  getSelectedStorageBackend(): ConnectCredentialStorageBackend;
  isEncryptionAvailable(): boolean;
}

export interface ConnectCredentialCacheFs {
  readFile(path: string): Promise<Buffer>;
  rm(path: string, options: { force: true }): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
}

export interface CreateConnectCredentialCacheArgs {
  encryption: ConnectCredentialEncryption;
  fs?: ConnectCredentialCacheFs;
  platform: NodeJS.Platform;
  userDataPath: string;
}

export interface ConnectCredentialCache {
  /**
   * Whether a written credential survives a restart. False means the OS gave
   * Electron no encryption backend, so callers must not enroll: the credential
   * would live in memory only, and every launch would enroll another machine.
   */
  canPersist(): boolean;
  clear(): Promise<void>;
  read(): Promise<ConnectMachineCredential | null>;
  write(credential: ConnectMachineCredential): Promise<void>;
}

const defaultFs: ConnectCredentialCacheFs = {
  readFile,
  rm,
  writeFile,
};

/**
 * The desktop app's own connect machine credential, encrypted at rest with the
 * OS keychain through Electron `safeStorage`. It lets the app mint a Connect
 * session cookie and list account servers with no local bb server running.
 *
 * When the OS offers no encryption backend the cache turns into a no-op rather
 * than writing a durable secret in the clear; the app then falls back to the
 * local server for those two calls.
 */
export function createConnectCredentialCache(
  args: CreateConnectCredentialCacheArgs,
): ConnectCredentialCache {
  const fsImpl = args.fs ?? defaultFs;
  const filePath = join(args.userDataPath, CONNECT_CREDENTIAL_FILE_NAME);

  function canPersistSecurely(): boolean {
    if (!args.encryption.isEncryptionAvailable()) {
      return false;
    }
    if (args.platform !== "linux") {
      return true;
    }
    const backend = args.encryption.getSelectedStorageBackend();
    return backend !== "basic_text" && backend !== "unknown";
  }

  async function clear(): Promise<void> {
    await fsImpl.rm(filePath, { force: true });
  }

  return {
    canPersist() {
      return canPersistSecurely();
    },
    clear,
    async read() {
      let encrypted: Buffer;
      try {
        encrypted = await fsImpl.readFile(filePath);
      } catch {
        return null;
      }
      // Asking Electron whether safeStorage is available can synchronously
      // consult the macOS Keychain. Do not make every fresh desktop launch pay
      // that cost (or surface a Keychain prompt) when there are no encrypted
      // bytes to decrypt.
      if (!canPersistSecurely()) {
        // A previous build may have persisted this credential with Electron's
        // reversible Linux basic_text backend. Refusing to read it is not
        // enough: remove the recoverable secret from disk during cutover.
        await clear();
        return null;
      }
      let plainText: string;
      try {
        plainText = args.encryption.decryptString(encrypted);
      } catch {
        // A keychain the OS can no longer unlock, or a file from another
        // machine: the bytes are useless, so drop them and re-enroll.
        await clear();
        return null;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(plainText);
      } catch {
        await clear();
        return null;
      }
      const parsed = connectMachineCredentialSchema.safeParse(parsedJson);
      if (!parsed.success) {
        await clear();
        return null;
      }
      return parsed.data;
    },
    async write(credential) {
      if (!canPersistSecurely()) {
        // Backend availability can regress after a credential was written.
        // Never leave stale bytes behind when persistence is no longer safe.
        await clear();
        return;
      }
      await fsImpl.writeFile(
        filePath,
        args.encryption.encryptString(JSON.stringify(credential)),
      );
    },
  };
}
