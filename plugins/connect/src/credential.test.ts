import { describe, expect, it } from "vitest";
import { createKvCredentialStore } from "./credential.js";

function createKv() {
  const values = new Map<string, unknown>();
  return {
    async delete(key: string) {
      values.delete(key);
    },
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      values.set(key, value);
    },
  };
}

describe("connect server credential store", () => {
  it("restores a server pairing credential without a client machine id", async () => {
    const store = createKvCredentialStore(createKv());
    const credential = {
      credential: "bbcred_server",
      handle: "pierback-nas",
      serverUrl: "https://pierback-nas.getbb.app",
    };

    await store.write(credential);

    await expect(store.read()).resolves.toEqual(credential);
  });
});
