import { useQuery } from "@tanstack/react-query";
import type { SessionFabricEnvironmentConnectionsResponse } from "@bb/server-contract";
import { useEnvironmentDetailRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { sdk } from "@/lib/sdk";
import { requireEnabledQueryArg } from "./query-helpers";
import { environmentSessionConnectionsQueryKey } from "./query-keys";
import { REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY } from "./query-policies";

interface QueryOptions {
  enabled?: boolean;
}

function requireEnvironmentId(
  environmentId: string | null | undefined,
  hookName: string,
): string {
  return requireEnabledQueryArg({
    value: environmentId,
    hookName,
    argName: "environmentId",
  });
}

/** Session Fabric's focused environment projection, independent of workspace queries. */
export function useEnvironmentSessionConnections(
  environmentId: string | null | undefined,
  options?: QueryOptions,
) {
  const enabled = (options?.enabled ?? true) && Boolean(environmentId);
  useEnvironmentDetailRealtimeSubscription(environmentId, { enabled });

  return useQuery<SessionFabricEnvironmentConnectionsResponse>({
    queryKey: environmentSessionConnectionsQueryKey(environmentId),
    queryFn: ({ signal }) =>
      sdk.sessionFabric.environmentConnections({
        environmentId: requireEnvironmentId(
          environmentId,
          "useEnvironmentSessionConnections",
        ),
        signal,
      }),
    enabled,
    ...REALTIME_OWNED_MOUNT_BASELINE_QUERY_POLICY,
  });
}

export function useThreadSessionConnection(
  threadId: string | null | undefined,
  environmentId: string | null | undefined,
  options?: QueryOptions,
) {
  const query = useEnvironmentSessionConnections(environmentId, {
    enabled: (options?.enabled ?? true) && Boolean(threadId),
  });
  const connection =
    query.data?.connections.find(
      (candidate) => candidate.threadId === threadId,
    ) ?? null;

  return { ...query, connection };
}
