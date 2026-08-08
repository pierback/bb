import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ThreadStatus } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { useEnvironmentThreadTabs } from "@/hooks/queries/environment-queries";
import { useThreads } from "@/hooks/queries/thread-queries";
import { scheduleEnvironmentThreadTabsUpdate } from "@/lib/environment-thread-tabs-sync";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { usePaneContext } from "./PaneContext";

interface WorktreeThreadTab {
  hasPendingInteraction?: boolean;
  id: string;
  status: ThreadStatus;
  title: string | null;
  titleFallback: string | null;
}

interface WorktreeThreadTabsProps {
  currentThread: WorktreeThreadTab;
  environmentId: string;
  environmentLabel: string;
  onCreateThread: () => void;
  projectId: string;
}

function statusPresentation(thread: WorktreeThreadTab): {
  className: string;
  label: string;
} {
  if (thread.hasPendingInteraction) {
    return { className: "bg-foreground", label: "needs input" };
  }
  switch (thread.status) {
    case "active":
    case "starting":
      return {
        className: "bg-foreground motion-safe:animate-pulse",
        label: "working",
      };
    case "error":
      return { className: "bg-destructive", label: "failed" };
    case "idle":
      return { className: "bg-success", label: "idle" };
    case "stopping":
      return { className: "bg-muted-foreground/45", label: "stopping" };
  }
}

function toTab(thread: WorktreeThreadTab): WorktreeThreadTab {
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    id: thread.id,
    status: thread.status,
    title: thread.title,
    titleFallback: thread.titleFallback,
  };
}

export function WorktreeThreadTabs({
  currentThread,
  environmentId,
  environmentLabel,
  onCreateThread,
  projectId,
}: WorktreeThreadTabsProps) {
  const queryClient = useQueryClient();
  const { navigateInPane } = usePaneContext();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabsQuery = useEnvironmentThreadTabs(environmentId);
  const activeThreadsQuery = useThreads({
    archived: false,
    environmentId,
    projectId,
  });
  const archivedThreadsQuery = useThreads({
    archived: true,
    environmentId,
    projectId,
  });

  useEffect(() => {
    const storedTabs = tabsQuery.data;
    if (!storedTabs || storedTabs.threadIds.includes(currentThread.id)) return;
    scheduleEnvironmentThreadTabsUpdate({
      environmentId,
      queryClient,
      update: (threadIds) =>
        threadIds.includes(currentThread.id)
          ? threadIds
          : [...threadIds, currentThread.id],
    });
  }, [currentThread.id, environmentId, queryClient, tabsQuery.data]);

  const threads = useMemo(() => {
    const byId = new Map<string, WorktreeThreadTab>();
    for (const thread of [
      ...(activeThreadsQuery.data ?? []),
      ...(archivedThreadsQuery.data ?? []),
    ]) {
      byId.set(thread.id, toTab(thread));
    }
    byId.set(currentThread.id, toTab(currentThread));

    const storedIds = tabsQuery.data?.threadIds ?? [];
    const visibleIds = storedIds.includes(currentThread.id)
      ? storedIds
      : [...storedIds, currentThread.id];
    return visibleIds.flatMap((threadId) => {
      const thread = byId.get(threadId);
      return thread ? [thread] : [];
    });
  }, [
    activeThreadsQuery.data,
    archivedThreadsQuery.data,
    currentThread,
    tabsQuery.data?.threadIds,
  ]);

  const selectThread = useCallback(
    (threadId: string) => {
      if (threadId === currentThread.id) return;
      navigateInPane({ projectId, threadId });
    },
    [currentThread.id, navigateInPane, projectId],
  );

  const closeThread = useCallback(
    (event: MouseEvent<HTMLButtonElement>, threadId: string, index: number) => {
      event.stopPropagation();
      scheduleEnvironmentThreadTabsUpdate({
        environmentId,
        queryClient,
        update: (threadIds) => threadIds.filter((id) => id !== threadId),
      });
      if (threadId !== currentThread.id) return;

      const remainingThreads = threads.filter(
        (thread) => thread.id !== threadId,
      );
      const nextThread =
        remainingThreads[Math.min(index, remainingThreads.length - 1)];
      if (nextThread) {
        navigateInPane({ projectId, threadId: nextThread.id });
      } else {
        onCreateThread();
      }
    },
    [
      currentThread.id,
      environmentId,
      navigateInPane,
      onCreateThread,
      projectId,
      queryClient,
      threads,
    ],
  );

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % threads.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + threads.length) % threads.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = threads.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextThread = threads[nextIndex];
    if (!nextThread) return;
    tabRefs.current.get(nextThread.id)?.focus();
    selectThread(nextThread.id);
  };

  return (
    <div
      className="flex h-10 min-w-0 shrink-0 items-stretch border-b border-border-hairline bg-muted/20"
      data-testid="worktree-thread-tabs"
    >
      <div
        className="flex max-w-40 shrink-0 items-center gap-1.5 border-r border-border-hairline px-3 text-xs text-muted-foreground max-md:hidden"
        title={environmentLabel}
      >
        <Icon name="GitBranch" className="size-3.5 shrink-0" />
        <span className="truncate">{environmentLabel}</span>
      </div>
      <div
        role="tablist"
        aria-label={`Threads in ${environmentLabel}`}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {threads.map((thread, index) => {
          const isActive = thread.id === currentThread.id;
          const title = getThreadDisplayTitle(thread);
          const status = statusPresentation(thread);
          return (
            <div
              key={thread.id}
              className={cn(
                "group relative flex min-w-28 max-w-56 shrink-0 items-stretch border-r border-border-hairline transition-colors",
                isActive
                  ? "bg-background text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground"
                  : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              )}
            >
              <button
                ref={(element) => {
                  if (element) tabRefs.current.set(thread.id, element);
                  else tabRefs.current.delete(thread.id);
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                title={title}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-0 pl-3 pr-1 text-xs focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={() => selectThread(thread.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span
                  aria-label={`Thread ${status.label}`}
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    status.className,
                  )}
                />
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${title}`}
                className="mr-1 flex w-6 shrink-0 items-center justify-center self-stretch rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                onClick={(event) => closeThread(event, thread.id, index)}
              >
                <Icon name="X" className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-auto w-10 shrink-0 rounded-none border-l border-border-hairline text-muted-foreground hover:text-foreground"
        aria-label="New thread in this worktree"
        onClick={onCreateThread}
      >
        <Icon name="Plus" className="size-3.5" />
      </Button>
    </div>
  );
}
