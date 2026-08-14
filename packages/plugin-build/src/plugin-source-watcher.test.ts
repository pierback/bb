import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginSourceWatcher,
  readPluginSourceSnapshot,
  type PluginSourceWatcher,
  type RecursivePluginWatchHandle,
} from "./plugin-source-watcher.js";

const roots: string[] = [];
const watchers: PluginSourceWatcher[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bb-plugin-source-watcher-"));
  roots.push(root);
  return root;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("createPluginSourceWatcher", () => {
  it("falls back to polling when recursive watch creation fails", async () => {
    const root = await createRoot();
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "server.ts"), "before\n");
    await writeFile(join(root, "dist", "server.js"), "before\n");
    const changes: string[] = [];
    const logs: string[] = [];
    const error = Object.assign(new Error("too many open files"), {
      code: "EMFILE",
    });

    const watcher = await createPluginSourceWatcher({
      rootDir: root,
      onChange: (relativePath) => changes.push(relativePath),
      log: (message) => logs.push(message),
      pollIntervalMs: 10,
      watchFactory: () => {
        throw error;
      },
    });
    watchers.push(watcher);

    await writeFile(join(root, "server.ts"), "after\n");
    await waitFor(() => changes.includes("server.ts"));
    expect(logs).toContain(
      "recursive source watch failed (EMFILE: too many open files); using 10ms polling",
    );

    const changeCount = changes.length;
    await writeFile(join(root, "dist", "server.js"), "after\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(changes).toHaveLength(changeCount);
  });

  it("covers the handoff gap when a native watcher emits an error", async () => {
    const root = await createRoot();
    const sourcePath = join(root, "server.ts");
    await writeFile(sourcePath, "before\n");
    const changes: string[] = [];
    const native = new EventEmitter() as EventEmitter &
      RecursivePluginWatchHandle;
    native.close = vi.fn();

    const watcher = await createPluginSourceWatcher({
      rootDir: root,
      onChange: (relativePath) => changes.push(relativePath),
      pollIntervalMs: 10,
      watchFactory: () => native,
    });
    watchers.push(watcher);

    await writeFile(sourcePath, "after\n");
    native.emit(
      "error",
      Object.assign(new Error("watch resources exhausted"), { code: "ENOSPC" }),
    );

    await waitFor(() => changes.includes("server.ts"));
    expect(native.close).toHaveBeenCalledOnce();
  });
});

describe("readPluginSourceSnapshot", () => {
  it("prunes generated and dependency trees", async () => {
    const root = await createRoot();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "src", "server.ts"), "export default {}\n");
    await writeFile(join(root, "dist", "server.js"), "generated\n");
    await writeFile(
      join(root, "node_modules", "dependency", "index.js"),
      "dependency\n",
    );

    const snapshot = await readPluginSourceSnapshot(root);

    expect([...snapshot.keys()]).toEqual([join("src", "server.ts")]);
  });
});
