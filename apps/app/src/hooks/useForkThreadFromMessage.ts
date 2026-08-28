import { useCallback, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Environment, Thread } from "@bb/domain";
import { sdk } from "@/lib/sdk";
import {
  FORK_THREAD_CREATE_SEED_LOCATION_STATE_KEY,
  isThreadForkable,
  type ForkThreadCreateSeed,
} from "@bb/client-core";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import {
  environmentQueryKey,
  threadDefaultExecutionOptionsQueryKey,
} from "@/hooks/queries/query-keys";
import { findCachedProviderInfo } from "@/hooks/queries/system-queries";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";

interface UseForkThreadFromMessageArgs {
  /** Source thread the fork branches from. Null until the thread loads. */
  sourceThread: Thread | null;
}

interface ForkThreadFromMessageTarget {
  sourceSeqEnd: number;
}

/**
 * Returns a handler whose identity is stable for the lifetime of the caller.
 * It reads the source thread from a ref at click time: the handler feeds the
 * timeline's static context, so a new identity per thread-detail refetch
 * would re-render every mounted message row.
 */
export function useForkThreadFromMessage({
  sourceThread,
}: UseForkThreadFromMessageArgs): (
  target: ForkThreadFromMessageTarget,
) => Promise<void> {
  const navigate = useRouteNavigate();
  const queryClient = useQueryClient();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const forkInFlightRef = useRef(false);
  const sourceThreadRef = useRef(sourceThread);
  useLayoutEffect(() => {
    sourceThreadRef.current = sourceThread;
  }, [sourceThread]);

  return useCallback(
    async (target: ForkThreadFromMessageTarget) => {
      const source = sourceThreadRef.current;
      if (
        source === null ||
        !isThreadForkable(
          source,
          findCachedProviderInfo(queryClient, source.providerId)?.capabilities
            .supportsFork ?? false,
        ) ||
        forkInFlightRef.current
      ) {
        return;
      }

      forkInFlightRef.current = true;
      try {
        if (source.environmentId === null) {
          return;
        }
        const environmentId = source.environmentId;
        const [executionOptions, sourceEnvironment] = await Promise.all([
          queryClient.fetchQuery({
            queryKey: threadDefaultExecutionOptionsQueryKey(source.id),
            queryFn: ({ signal }) =>
              sdk.threads.defaultExecutionOptions({
                signal,
                threadId: source.id,
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
          projectId: source.projectId,
          providerId: source.providerId,
          reasoningLevel: executionOptions.reasoningLevel,
          serviceTier: executionOptions.serviceTier,
          sourceWorkspaceProvisionType:
            sourceEnvironment.workspaceProvisionType,
          sourceSeqEnd: target.sourceSeqEnd,
          sourceThreadId: source.id,
          sourceThreadTitle: getThreadDisplayTitle(source),
        };
        setRootComposeProjectId(source.projectId);
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
    [navigate, queryClient, setRootComposeProjectId],
  );
}
