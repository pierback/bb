import type { QueryClient } from "@tanstack/react-query";
import type { EnvironmentThreadTabsResponse } from "@bb/server-contract";
import { environmentThreadTabsQueryKey } from "../queries/query-keys";

export function getCachedEnvironmentThreadTabs(
  queryClient: QueryClient,
  environmentId: string,
): EnvironmentThreadTabsResponse | undefined {
  return queryClient.getQueryData<EnvironmentThreadTabsResponse>(
    environmentThreadTabsQueryKey(environmentId),
  );
}

export function setCachedEnvironmentThreadTabs(
  queryClient: QueryClient,
  environmentId: string,
  response: EnvironmentThreadTabsResponse,
): void {
  queryClient.setQueryData(
    environmentThreadTabsQueryKey(environmentId),
    response,
  );
}

export function invalidateCachedEnvironmentThreadTabs(
  queryClient: QueryClient,
  environmentId: string,
): void {
  queryClient.invalidateQueries({
    queryKey: environmentThreadTabsQueryKey(environmentId),
  });
}
