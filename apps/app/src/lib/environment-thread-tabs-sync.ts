import type { QueryClient } from "@tanstack/react-query";
import { environmentThreadTabIdsSchema } from "@bb/server-contract";
import { appToast } from "@/components/ui/app-toast";
import {
  getCachedEnvironmentThreadTabs,
  invalidateCachedEnvironmentThreadTabs,
  setCachedEnvironmentThreadTabs,
} from "@/hooks/cache-owners/environment-thread-tabs-cache-owner";
import { BbHttpError, sdk } from "./sdk";

interface EnvironmentThreadTabsSyncArgs {
  environmentId: string;
  queryClient: QueryClient;
}

export interface ScheduleEnvironmentThreadTabsUpdateArgs extends EnvironmentThreadTabsSyncArgs {
  update: (threadIds: readonly string[]) => readonly string[];
}

const writeQueues = new WeakMap<QueryClient, Map<string, Promise<void>>>();
const MAX_CONFLICT_RETRIES = 3;

function areThreadIdsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((threadId, index) => threadId === right[index])
  );
}

function getWriteQueue(queryClient: QueryClient): Map<string, Promise<void>> {
  let queue = writeQueues.get(queryClient);
  if (!queue) {
    queue = new Map();
    writeQueues.set(queryClient, queue);
  }
  return queue;
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 409 &&
    error.code === "environment_thread_tabs_conflict"
  );
}

async function readCurrent(
  args: EnvironmentThreadTabsSyncArgs,
  forceNetwork: boolean,
) {
  const cached = forceNetwork
    ? undefined
    : getCachedEnvironmentThreadTabs(args.queryClient, args.environmentId);
  if (cached) return cached;
  const response = await sdk.environments.threadTabs.get({
    environmentId: args.environmentId,
  });
  setCachedEnvironmentThreadTabs(
    args.queryClient,
    args.environmentId,
    response,
  );
  return response;
}

async function applyUpdate(
  args: ScheduleEnvironmentThreadTabsUpdateArgs,
): Promise<void> {
  let forceNetwork = false;
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const current = await readCurrent(args, forceNetwork);
    const threadIds = environmentThreadTabIdsSchema.parse(
      args.update(current.threadIds),
    );
    if (areThreadIdsEqual(current.threadIds, threadIds)) return;
    try {
      const response = await sdk.environments.threadTabs.update({
        environmentId: args.environmentId,
        expectedRevision: current.revision,
        threadIds,
      });
      setCachedEnvironmentThreadTabs(
        args.queryClient,
        args.environmentId,
        response,
      );
      return;
    } catch (error) {
      if (!isConflict(error) || attempt === MAX_CONFLICT_RETRIES - 1) {
        throw error;
      }
      forceNetwork = true;
    }
  }
}

export function scheduleEnvironmentThreadTabsUpdate(
  args: ScheduleEnvironmentThreadTabsUpdateArgs,
): void {
  const queue = getWriteQueue(args.queryClient);
  const previous = queue.get(args.environmentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => applyUpdate(args));
  queue.set(args.environmentId, next);
  void next
    .catch((error: unknown) => {
      invalidateCachedEnvironmentThreadTabs(
        args.queryClient,
        args.environmentId,
      );
      appToast.error("Couldn’t sync worktree tabs", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    })
    .finally(() => {
      if (queue.get(args.environmentId) === next) {
        queue.delete(args.environmentId);
      }
    });
}
