import type {
  PermissionMode,
  PromptInput,
  ReasoningLevel,
  ServiceTier,
  Thread,
  WorkspaceProvisionType,
} from "@bb/domain";
import type { AppCreateThreadRequest } from "../api-types.js";

export const FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY =
  "forkThreadCreateSeed";

export interface ForkThreadCreateSeed {
  environmentId: string;
  model: string;
  permissionMode: PermissionMode;
  projectId: string;
  providerId: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
  sourceWorkspaceProvisionType: WorkspaceProvisionType;
  sourceSeqEnd: number | undefined;
  sourceThreadId: string;
  sourceThreadTitle: string;
}

interface BuildForkThreadRequestArgs extends ForkThreadCreateSeed {
  input: PromptInput[];
  /**
   * The source thread provider's `capabilities.supportsFork`, read from the
   * server-provided ProviderInfo (execution-options query data). False when
   * the provider is unknown or its data has not loaded — graceful absence.
   */
  providerSupportsFork: boolean;
}

type ForkableThread = Pick<Thread, "environmentId" | "providerId">;

export function isThreadForkable(
  sourceThread: ForkableThread | null,
  providerSupportsFork: boolean,
): boolean {
  if (sourceThread === null || sourceThread.environmentId === null) {
    return false;
  }
  return providerSupportsFork;
}

export function buildForkThreadRequest({
  environmentId,
  input,
  model,
  permissionMode,
  projectId,
  providerId,
  providerSupportsFork,
  reasoningLevel,
  serviceTier,
  sourceWorkspaceProvisionType,
  sourceSeqEnd,
  sourceThreadId,
}: BuildForkThreadRequestArgs): AppCreateThreadRequest | null {
  if (
    !isThreadForkable(
      {
        environmentId,
        providerId,
      },
      providerSupportsFork,
    )
  ) {
    return null;
  }

  return {
    environment:
      sourceWorkspaceProvisionType === "managed-worktree"
        ? {
            type: "host",
            workspace: {
              type: "managed-worktree",
              parentEnvironmentId: environmentId,
            },
          }
        : { type: "reuse", environmentId },
    input,
    model,
    originKind: "fork",
    permissionMode,
    projectId,
    providerId,
    reasoningLevel,
    ...(serviceTier ? { serviceTier } : {}),
    ...(sourceSeqEnd !== undefined ? { sourceSeqEnd } : {}),
    sourceThreadId,
    startedOnBehalfOf: null,
  };
}
