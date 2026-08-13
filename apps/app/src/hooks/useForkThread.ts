import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Environment, Thread } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import {
  FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY,
  isThreadForkable,
  type ForkThreadCreateSeed,
} from "@/lib/fork-thread-request";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import {
  environmentQueryKey,
  threadDefaultExecutionOptionsQueryKey,
} from "@/hooks/queries/query-keys";

export interface UseForkThreadArgs {
  /** Source thread the fork branches from. Null until the thread loads. */
  sourceThread: Thread | null;
}

export interface ForkThreadTarget {
  /** Last source event to include. Omit to fork from the provider's latest snapshot. */
  sourceSeqEnd?: number;
}

export function useForkThread({
  sourceThread,
}: UseForkThreadArgs): (target?: ForkThreadTarget) => Promise<void> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const forkInFlightRef = useRef(false);

  return useCallback(
    async (target?: ForkThreadTarget) => {
      if (
        sourceThread === null ||
        !isThreadForkable(sourceThread) ||
        forkInFlightRef.current
      ) {
        return;
      }

      forkInFlightRef.current = true;
      try {
        if (sourceThread.environmentId === null) {
          return;
        }
        const environmentId = sourceThread.environmentId;
        const [executionOptions, sourceEnvironment] = await Promise.all([
          queryClient.fetchQuery({
            queryKey: threadDefaultExecutionOptionsQueryKey(sourceThread.id),
            queryFn: ({ signal }) =>
              sdk.threads.defaultExecutionOptions({
                signal,
                threadId: sourceThread.id,
              }),
          }),
          queryClient.fetchQuery<Environment>({
            queryKey: environmentQueryKey(environmentId),
            queryFn: ({ signal }) =>
              sdk.environments.get({ environmentId, signal }),
          }),
        ]);
        if (executionOptions === null) {
          return;
        }

        const seed: ForkThreadCreateSeed = {
          environmentId,
          model: executionOptions.model,
          permissionMode: executionOptions.permissionMode,
          projectId: sourceThread.projectId,
          providerId: sourceThread.providerId,
          reasoningLevel: executionOptions.reasoningLevel,
          serviceTier: executionOptions.serviceTier,
          sourceWorkspaceProvisionType:
            sourceEnvironment.workspaceProvisionType,
          sourceSeqEnd: target?.sourceSeqEnd,
          sourceThreadId: sourceThread.id,
          sourceThreadTitle: getThreadDisplayTitle(sourceThread),
        };
        setRootComposeProjectId(sourceThread.projectId);
        navigate(getRootComposeRoutePath(), {
          state: {
            focusPrompt: true,
            reuseEnvironmentId: environmentId,
            [FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY]: seed,
          },
        });
      } finally {
        forkInFlightRef.current = false;
      }
    },
    [navigate, queryClient, setRootComposeProjectId, sourceThread],
  );
}
