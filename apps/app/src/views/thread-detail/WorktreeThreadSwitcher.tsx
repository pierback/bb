import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ThreadStatus } from "@bb/domain";
import type { SessionFabricConnection } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { appToast } from "@/components/ui/app-toast";
import { useEnvironmentThreadTabs } from "@/hooks/queries/environment-queries";
import { useEnvironmentSessionConnections } from "@/hooks/queries/session-fabric-queries";
import { useThreads } from "@/hooks/queries/thread-queries";
import { scheduleEnvironmentThreadTabsUpdate } from "@/lib/environment-thread-tabs-sync";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import {
  getProviderIconColorClass,
  getProviderIconInfo,
} from "@/lib/provider-icon";
import { sdk } from "@/lib/sdk";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { usePaneContext } from "./PaneContext";

interface WorktreeThreadItem {
  hasPendingInteraction?: boolean;
  id: string;
  status: ThreadStatus;
  title: string | null;
  titleFallback: string | null;
}

interface WorktreeThreadSwitcherProps {
  currentThread: WorktreeThreadItem;
  environmentId: string;
  environmentLabel: string;
  onCreateThread: () => void;
  projectId: string;
}

function statusPresentation(thread: WorktreeThreadItem): {
  className: string;
  label: string;
} {
  if (thread.hasPendingInteraction) {
    return { className: "bg-foreground", label: "Needs input" };
  }
  switch (thread.status) {
    case "active":
    case "starting":
      return {
        className: "bg-foreground motion-safe:animate-pulse",
        label: "Working",
      };
    case "error":
      return { className: "bg-destructive", label: "Failed" };
    case "idle":
      return { className: "bg-success", label: "Idle" };
    case "stopping":
      return { className: "bg-muted-foreground/45", label: "Stopping" };
  }
}

function toItem(thread: WorktreeThreadItem): WorktreeThreadItem {
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    id: thread.id,
    status: thread.status,
    title: thread.title,
    titleFallback: thread.titleFallback,
  };
}

function NativeConversationConnection({
  connection,
}: {
  connection: SessionFabricConnection;
}) {
  const providerId = connection.nativeConversation.providerId;
  const iconInfo = getProviderIconInfo(providerId);
  const ProviderIcon = iconInfo?.icon;
  const nativeTitle =
    connection.nativeConversation.title ??
    connection.nativeConversation.nativeConversationId;
  const isEnabled =
    connection.isActiveAuthority &&
    (connection.adoptionStatus === null ||
      connection.adoptionStatus === "enabled") &&
    connection.mutationPolicy === "enabled";

  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground",
        !isEnabled && "text-warning",
      )}
      title={
        isEnabled
          ? `Connected to ${nativeTitle}`
          : `Session connection is ${connection.adoptionStatus ?? connection.phase}`
      }
    >
      <Icon name="ArrowRight" className="size-3 shrink-0 opacity-55" />
      {ProviderIcon ? (
        <ProviderIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            getProviderIconColorClass(providerId),
          )}
        />
      ) : (
        <Icon name="Code" className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{nativeTitle}</span>
    </span>
  );
}

export function WorktreeThreadSwitcher({
  currentThread,
  environmentId,
  environmentLabel,
  onCreateThread,
  projectId,
}: WorktreeThreadSwitcherProps) {
  const queryClient = useQueryClient();
  const { navigateInPane } = usePaneContext();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const [isOpen, setIsOpen] = useState(false);
  const tabsQuery = useEnvironmentThreadTabs(environmentId);
  const connectionsQuery = useEnvironmentSessionConnections(environmentId);
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
  const connectionsByThreadId = useMemo(
    () =>
      new Map(
        (connectionsQuery.data?.connections ?? []).map((connection) => [
          connection.threadId,
          connection,
        ]),
      ),
    [connectionsQuery.data?.connections],
  );
  const connectThread = useMutation({
    mutationFn: (threadId: string) =>
      sdk.sessionFabric.connectThread({ threadId }),
    onSuccess: async ({ connection }) => {
      await connectionsQuery.refetch();
      appToast.success("Conversation connected", {
        description:
          connection.nativeConversation.title ??
          connection.nativeConversation.nativeConversationId,
      });
    },
    onError: (error) => {
      appToast.error("Could not connect conversation", {
        description: getMutationErrorMessage({
          error,
          fallbackMessage: "Session Fabric could not bind this conversation.",
        }),
      });
    },
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
    const byId = new Map<string, WorktreeThreadItem>();
    for (const thread of [
      ...(activeThreadsQuery.data ?? []),
      ...(archivedThreadsQuery.data ?? []),
    ]) {
      byId.set(thread.id, toItem(thread));
    }
    byId.set(currentThread.id, toItem(currentThread));

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
      setIsOpen(false);
      if (threadId === currentThread.id) return;
      navigateInPane({ projectId, threadId });
    },
    [currentThread.id, navigateInPane, projectId],
  );

  const closeThread = useCallback(
    (threadId: string, index: number) => {
      scheduleEnvironmentThreadTabsUpdate({
        environmentId,
        queryClient,
        update: (threadIds) => threadIds.filter((id) => id !== threadId),
      });
      if (threadId !== currentThread.id) return;

      setIsOpen(false);
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

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = (index + 1) % threads.length;
    } else if (event.key === "ArrowUp") {
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
    rowRefs.current.get(nextThread.id)?.focus();
  };

  const currentStatus = statusPresentation(currentThread);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 max-w-48 shrink-0 gap-1.5 px-2 font-normal text-muted-foreground max-md:pointer-coarse:h-9 max-sm:w-11 max-sm:px-1.5"
          aria-label={`Open threads in ${environmentLabel}`}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full max-sm:hidden",
              currentStatus.className,
            )}
          />
          <Icon name="GitBranch" className="size-3.5" />
          <span className="truncate max-sm:hidden">{environmentLabel}</span>
          <span className="text-2xs tabular-nums text-muted-foreground/75">
            {threads.length}
          </span>
          <Icon
            name="ChevronDown"
            className="size-3 opacity-55 max-sm:hidden"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        mobileTitle={`Threads in ${environmentLabel}`}
        mobileClassName="max-h-[min(85dvh,42rem)]"
        className="w-full overflow-hidden px-0 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))] md:w-96 md:p-0"
        data-testid="worktree-thread-switcher"
      >
        <div className="flex items-start gap-3 border-b border-border-hairline px-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Worktree
            </p>
            <p className="mt-0.5 break-words text-sm font-medium">
              {environmentLabel}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2.5 font-normal"
            onClick={() => {
              setIsOpen(false);
              onCreateThread();
            }}
          >
            <Icon name="Plus" className="size-3.5" />
            New thread
          </Button>
        </div>
        <div
          role="list"
          aria-label={`Open threads in ${environmentLabel}`}
          className="max-h-[min(28rem,60dvh)] overflow-y-auto p-1.5"
        >
          {threads.map((thread, index) => {
            const isCurrent = thread.id === currentThread.id;
            const title = getThreadDisplayTitle(thread);
            const status = statusPresentation(thread);
            const connection = connectionsByThreadId.get(thread.id);
            const canConnect =
              isCurrent &&
              connectionsQuery.isSuccess &&
              connection === undefined;
            const isConnecting =
              connectThread.isPending && connectThread.variables === thread.id;
            return (
              <div
                key={thread.id}
                role="listitem"
                className={cn(
                  "group flex min-w-0 items-stretch rounded-md",
                  isCurrent ? "bg-state-active" : "hover:bg-state-hover",
                )}
              >
                <button
                  ref={(element) => {
                    if (element) rowRefs.current.set(thread.id, element);
                    else rowRefs.current.delete(thread.id);
                  }}
                  type="button"
                  aria-current={isCurrent ? "page" : undefined}
                  className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={() => selectThread(thread.id)}
                  onKeyDown={(event) => handleRowKeyDown(event, index)}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      status.className,
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block line-clamp-2 text-xs font-medium leading-5">
                      {title}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-2">
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {status.label}
                      </span>
                      {connection ? (
                        <NativeConversationConnection connection={connection} />
                      ) : null}
                    </span>
                  </span>
                </button>
                {canConnect ? (
                  <button
                    type="button"
                    aria-label={`Connect ${title} to its provider conversation`}
                    className="my-2 flex h-8 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-2xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    disabled={connectThread.isPending}
                    onClick={() => connectThread.mutate(thread.id)}
                  >
                    <Icon
                      name={isConnecting ? "Spinner" : "ElectricPlugs"}
                      className={cn(
                        "size-3",
                        isConnecting && "motion-safe:animate-spin",
                      )}
                    />
                    Connect
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  className="m-1.5 flex size-9 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => closeThread(thread.id, index)}
                >
                  <Icon name="X" className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
