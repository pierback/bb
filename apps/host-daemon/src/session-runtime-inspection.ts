import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { AgentRuntimeThreadConfigurationSnapshot } from "@bb/agent-runtime";
import type { RuntimeRecipe, SessionWorkspaceState } from "@bb/domain";
import type { RuntimeEntry } from "./runtime-manager.js";
import {
  inspectGitWorkspaceEvidence,
  inspectNonGitWorkspaceEvidence,
} from "./session-workspace-evidence.js";

type RuntimeRecipeEvidence = Omit<RuntimeRecipe, "id">;
type WorkspaceStateEvidence = Omit<SessionWorkspaceState, "hostId" | "id">;

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Cannot fingerprint non-JSON value of type ${typeof value}`);
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

async function canonicalExistingPaths(
  paths: readonly string[],
): Promise<string[]> {
  const resolved = await Promise.all(
    paths.map((candidate) => realpath(candidate)),
  );
  return [...new Set(resolved)].sort();
}

function sandboxProfile(
  configuration: AgentRuntimeThreadConfigurationSnapshot,
): string {
  const options = configuration.options;
  return [
    "bb-runtime-v1",
    options.permissionScope,
    options.approvalReviewer ?? "no-reviewer",
    options.permissionEscalation ?? "no-escalation",
    options.claudeCodePermissionMode ?? "native",
  ].join(":");
}

/** Derives secret-free, opaque recipe evidence from the live runtime config. */
export async function inspectRuntimeRecipe(args: {
  configuration: AgentRuntimeThreadConfigurationSnapshot;
  entry: RuntimeEntry;
}): Promise<RuntimeRecipeEvidence> {
  const rootPath = await realpath(args.entry.path);
  const additionalWriteRoots =
    await args.entry.workspace.getAdditionalWorkspaceWriteRoots();
  const workspaceWriteRoots = await canonicalExistingPaths([
    rootPath,
    ...additionalWriteRoots,
  ]);
  const skillRoots = args.configuration.skillRoots.map((skillRoot) => ({
    id: skillRoot.id,
    providerId: skillRoot.providerId,
  }));
  const tools = {
    disallowedTools: [...args.configuration.disallowedTools].sort(),
    dynamicTools: [...args.configuration.dynamicTools].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };

  return {
    cwd: rootPath,
    environmentFingerprint: sha256({
      environmentId: args.configuration.environmentId,
      instructionMode: args.configuration.instructionMode,
      instructions: sha256(args.configuration.instructions),
      processKey: args.configuration.processKey,
      projectId: args.configuration.projectId,
      providerId: args.configuration.providerId,
      version: "session-runtime-environment-v1",
    }),
    environmentReferenceIds: [args.configuration.environmentId],
    // Dynamic tools are the concrete MCP/tool surface delivered to this
    // thread; hash their schemas, never their runtime credentials.
    mcpServersFingerprint: sha256({ tools, version: "session-mcp-surface-v1" }),
    permissionMode: args.configuration.options.permissionMode,
    pluginsFingerprint: sha256({
      skillRoots,
      version: "session-plugin-surface-v1",
    }),
    sandboxProfile: sandboxProfile(args.configuration),
    toolsFingerprint: sha256({ tools, version: "session-tool-surface-v1" }),
    workspaceWriteRoots,
  };
}

/** Captures a bounded reconciliation checkpoint from the loaded workspace. */
export async function inspectWorkspaceState(args: {
  capturedAt: number;
  entry: RuntimeEntry;
}): Promise<WorkspaceStateEvidence> {
  const rootPath = await realpath(args.entry.path);
  const workspace = args.entry.workspace;
  if (!workspace.isGitRepo) {
    const evidence = await inspectNonGitWorkspaceEvidence(rootPath);
    return {
      backgroundResources: [],
      capturedAt: args.capturedAt,
      ...evidence,
      digestAlgorithm: "bb-session-workspace-v2:sha256",
      externalSideEffectStatus: "unknown",
      headSha: null,
      rootPath,
      watcherGeneration: 0,
      worktreeId: sha256({
        managed: workspace.managed,
        rootPath,
        version: "session-worktree-identity-v1",
      }),
    };
  }

  const [headSha, evidence] = await Promise.all([
    workspace.getHeadSha(),
    inspectGitWorkspaceEvidence(rootPath),
  ]);

  return {
    backgroundResources: [],
    capturedAt: args.capturedAt,
    ...evidence,
    digestAlgorithm: "bb-session-workspace-v2:sha256",
    externalSideEffectStatus: "unknown",
    headSha,
    rootPath,
    watcherGeneration: 0,
    worktreeId: sha256({
      isWorktree: workspace.isWorktree,
      managed: workspace.managed,
      rootPath,
      version: "session-worktree-identity-v1",
    }),
  };
}
