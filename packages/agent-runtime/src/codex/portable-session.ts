import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  PortableSessionAdapter,
  PortableSessionAdapterExportArtifact,
} from "../portable-session.js";

const CODEX_SESSION_DIRECTORIES = ["sessions", "archived_sessions"] as const;

const codexSessionMetadataSchema = z
  .object({
    payload: z
      .object({
        id: z.string().min(1),
      })
      .passthrough(),
    type: z.literal("session_meta"),
  })
  .passthrough();

export interface CreateCodexPortableSessionAdapterArgs {
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
}
function codexHome(args: CreateCodexPortableSessionAdapterArgs): string {
  const configured = args.env.CODEX_HOME;
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(args.homeDirectory ?? os.homedir(), ".codex");
}

function resolveAdapterPath(homePath: string, adapterPath: string): string {
  const segments = adapterPath.split("/");
  if (
    !CODEX_SESSION_DIRECTORIES.includes(
      segments[0] as (typeof CODEX_SESSION_DIRECTORIES)[number],
    ) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid Codex portable-session path: ${adapterPath}`);
  }
  const resolved = path.resolve(homePath, ...segments);
  const root = path.resolve(homePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Codex portable-session path escapes home: ${adapterPath}`);
  }
  return resolved;
}

function toAdapterPath(homePath: string, filePath: string): string {
  const relative = path.relative(homePath, filePath);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Codex session path escapes home: ${filePath}`);
  }
  return relative.split(path.sep).join("/");
}

async function listSessionFiles(rootPath: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSessionFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readSessionIdentity(filePath: string): Promise<string | null> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ crlfDelay: Infinity, input });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return null;
      }
      const metadata = codexSessionMetadataSchema.safeParse(parsed);
      return metadata.success ? metadata.data.payload.id : null;
    }
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

export function createCodexPortableSessionAdapter(
  args: CreateCodexPortableSessionAdapterArgs,
): PortableSessionAdapter {
  const homePath = codexHome(args);
  return {
    async cleanupImport(token: string): Promise<void> {
      await fs.rm(resolveAdapterPath(homePath, token), { force: true });
    },

    async exportSessions(providerThreadIds: readonly string[]): Promise<{
      artifacts: PortableSessionAdapterExportArtifact[];
      missingProviderThreadIds: string[];
    }> {
      const requested = new Set(providerThreadIds);
      const matched = new Set<string>();
      const artifacts: PortableSessionAdapterExportArtifact[] = [];
      const candidates = (
        await Promise.all(
          CODEX_SESSION_DIRECTORIES.map((directory) =>
            listSessionFiles(path.join(homePath, directory)),
          ),
        )
      )
        .flat()
        .sort();
      for (const sourcePath of candidates) {
        const providerThreadId = await readSessionIdentity(sourcePath);
        if (providerThreadId === null || !requested.has(providerThreadId)) {
          continue;
        }
        matched.add(providerThreadId);
        artifacts.push({
          adapterPath: toAdapterPath(homePath, sourcePath),
          sourcePath,
        });
      }
      return {
        artifacts,
        missingProviderThreadIds: [...requested].filter(
          (providerThreadId) => !matched.has(providerThreadId),
        ),
      };
    },

    async importArtifact(importArgs) {
      const targetPath = resolveAdapterPath(homePath, importArgs.adapterPath);
      try {
        const existingHash = await sha256(targetPath);
        return {
          outcome:
            existingHash === importArgs.expectedSha256
              ? "already_present"
              : "conflict",
        };
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await importArgs.registerCleanup(importArgs.adapterPath);
      await fs.copyFile(importArgs.sourcePath, targetPath);
      await fs.chmod(targetPath, importArgs.mode);
      return { outcome: "installed" };
    },
  };
}
