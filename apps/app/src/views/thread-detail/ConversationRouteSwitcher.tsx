import { useState } from "react";
import type { ConversationRoute } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { useThreadConversationRoutes } from "@/hooks/queries/thread-queries";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { usePaneContext } from "./PaneContext";

interface ConversationRouteSwitcherProps {
  projectId: string;
  threadId: string;
}

function getRouteTitle(
  route: Pick<ConversationRoute, "threadId" | "title" | "titleFallback">,
): string {
  return getThreadDisplayTitle({
    id: route.threadId,
    title: route.title,
    titleFallback: route.titleFallback,
  });
}

function getRouteStatusPresentation(route: ConversationRoute): {
  className: string;
  label: string;
} {
  switch (route.status) {
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

function RouteTreeGlyph({ depth }: { depth: number }) {
  return (
    <span className="flex shrink-0 items-center pt-0.5" aria-hidden="true">
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} className="h-5 w-3 border-l border-border-hairline" />
      ))}
      <Icon
        name={depth === 0 ? "MessageSquare" : "Fork"}
        className="size-4 text-subtle-foreground"
      />
    </span>
  );
}

function RouteRow({
  current,
  onSelect,
  route,
}: {
  current: boolean;
  onSelect: () => void;
  route: ConversationRoute;
}) {
  const depth = route.path.length - 1;
  const parent = depth > 0 ? route.path.at(-2) : undefined;
  const status = getRouteStatusPresentation(route);
  const title = getRouteTitle(route);
  const subtitle =
    parent === undefined
      ? "Original conversation"
      : `Forked from ${getThreadDisplayTitle({
          id: parent.threadId,
          title: parent.title,
          titleFallback: parent.titleFallback,
        })}`;

  return (
    <button
      type="button"
      aria-label={`${title}, ${status.label}${route.archivedAt === null ? "" : ", archived"}${current ? ", current route" : ""}`}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-md px-3 py-3 text-left outline-none transition-colors",
        current
          ? "bg-surface-selected"
          : "hover:bg-state-hover focus-visible:bg-state-hover",
      )}
      onClick={onSelect}
    >
      <RouteTreeGlyph depth={depth} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {route.archivedAt === null ? null : (
            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground">
              Archived
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-1 text-xs text-muted-foreground">
        <span
          className={cn("size-2 rounded-full", status.className)}
          aria-hidden="true"
        />
        <span>{status.label}</span>
        {current ? <Icon name="Check" className="size-4" aria-hidden /> : null}
      </span>
    </button>
  );
}

export function ConversationRouteSwitcher({
  projectId,
  threadId,
}: ConversationRouteSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { navigateInPane } = usePaneContext();
  const routesQuery = useThreadConversationRoutes(threadId);
  const routes = routesQuery.data?.routes ?? [];

  if (routes.length <= 1) {
    return null;
  }

  const currentIndex = Math.max(
    0,
    routes.findIndex((route) => route.threadId === threadId),
  );
  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-muted-foreground"
      aria-label={`Choose conversation route. Route ${currentIndex + 1} of ${routes.length} selected.`}
    >
      <Icon name="Fork" className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">
        Route {currentIndex + 1} of {routes.length}
      </span>
      <span className="sm:hidden">
        {currentIndex + 1}/{routes.length}
      </span>
    </Button>
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Choose conversation route</TooltipContent>
      </Tooltip>
      <DialogContent className="max-h-[min(85dvh,42rem)] overflow-hidden sm:max-w-xl sm:gap-0 sm:p-0">
        <DialogHeader className="border-b border-border-hairline sm:px-5 sm:py-4">
          <DialogTitle>Choose conversation route</DialogTitle>
          <DialogDescription>
            Switch between alternate histories without changing either
            conversation.
          </DialogDescription>
        </DialogHeader>
        <ul
          aria-label="Conversation routes"
          className="max-h-[min(65dvh,32rem)] space-y-1 overflow-y-auto sm:p-2"
        >
          {routes.map((route) => (
            <li key={route.threadId}>
              <RouteRow
                route={route}
                current={route.threadId === threadId}
                onSelect={() => {
                  setIsOpen(false);
                  if (route.threadId === threadId) {
                    return;
                  }
                  navigateInPane({ projectId, threadId: route.threadId });
                }}
              />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
