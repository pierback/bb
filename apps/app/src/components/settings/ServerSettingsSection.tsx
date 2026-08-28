import { useEffect, useRef, useState } from "react";
import type {
  BbDesktopServerApi,
  BbDesktopServerOption,
  BbDesktopServerState,
} from "@bb/desktop-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  SettingsBadge,
  SettingsSection,
} from "@/components/ui/settings-section";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

const SERVER_SECTION_DESCRIPTION =
  "Choose where BB stores chats, tasks, and orchestration state. BB Desktop keeps execution and filesystem access on this Mac.";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The server selection could not be loaded.";
}

function serverIconName(kind: BbDesktopServerOption["kind"]): IconName {
  if (kind === "builtin") return "Cloud";
  if (kind === "connect") return "Globe";
  return "ElectricPlugs";
}

function serverKindLabel(kind: BbDesktopServerOption["kind"]): string {
  if (kind === "builtin") return "Local server";
  if (kind === "connect") return "BB Connect server";
  return "Custom server";
}

interface ServerOptionRowProps {
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  server: BbDesktopServerOption;
  switching: boolean;
}

function ServerOptionRow({
  active,
  disabled,
  onSelect,
  server,
  switching,
}: ServerOptionRowProps) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-label={
        active
          ? `${server.name} is the current coordination server`
          : `Use ${server.name} as the coordination server`
      }
      className={cn(
        "flex min-h-14 w-full items-center gap-3 rounded-md px-3 py-2.5 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-state-active text-foreground"
          : "hover:bg-state-hover active:bg-state-active",
        disabled && !active && "cursor-wait opacity-60",
      )}
      disabled={disabled || active}
      onClick={onSelect}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border",
          active
            ? "border-border bg-card text-foreground"
            : "border-border/70 bg-muted/35 text-muted-foreground",
        )}
      >
        <Icon
          aria-hidden="true"
          name={serverIconName(server.kind)}
          className="size-4"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {server.name}
          </span>
          {active ? <SettingsBadge>Current server</SettingsBadge> : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-subtle-foreground">
          {serverKindLabel(server.kind)} · {server.url}
        </span>
      </span>
      {switching ? (
        <span className="shrink-0 text-xs text-muted-foreground" role="status">
          Switching…
        </span>
      ) : active ? (
        <Icon
          aria-hidden="true"
          name="Check"
          className="size-4 shrink-0 text-foreground"
        />
      ) : (
        <Icon
          aria-hidden="true"
          name="ChevronRight"
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
    </button>
  );
}

export interface ServerSettingsSectionContentProps {
  browserServerUrl: string;
  error: string | null;
  isDesktop: boolean;
  isRefreshing: boolean;
  onOpenCustomServerDialog: () => void;
  onRefresh: () => void;
  onSelect: (serverId: string) => void;
  serverState: BbDesktopServerState | null;
  switchingServerId: string | null;
}

export function ServerSettingsSectionContent({
  browserServerUrl,
  error,
  isDesktop,
  isRefreshing,
  onOpenCustomServerDialog,
  onRefresh,
  onSelect,
  serverState,
  switchingServerId,
}: ServerSettingsSectionContentProps) {
  const activeServer = serverState?.servers.find(
    (server) => server.id === serverState.activeServerId,
  );
  const executionHost = serverState?.executionHost ?? null;
  const usesRemoteCoordinator = activeServer?.kind !== "builtin";

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Coordination server"
        description={SERVER_SECTION_DESCRIPTION}
        action={
          isDesktop ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="max-md:pointer-coarse:min-h-11"
              disabled={isRefreshing || switchingServerId !== null}
              onClick={onRefresh}
            >
              <Icon
                aria-hidden="true"
                name="RotateCcw"
                className={cn(
                  "size-3.5",
                  isRefreshing && "animate-spin motion-reduce:animate-none",
                )}
              />
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-state-active px-3 py-3">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-foreground">
                <Icon aria-hidden="true" name="Globe" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-2xs font-medium uppercase tracking-wide text-subtle-foreground">
                  Current coordination server
                </p>
                <p className="mt-0.5 truncate text-sm font-semibold text-foreground">
                  {activeServer?.name ?? browserServerUrl}
                </p>
                <p className="mt-0.5 truncate font-mono text-xs text-readback-foreground">
                  {activeServer?.url ?? browserServerUrl}
                </p>
              </div>
              <SettingsBadge>{isDesktop ? "Desktop" : "Browser"}</SettingsBadge>
            </div>
          </div>

          <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
            <div className="flex gap-2.5">
              <Icon
                aria-hidden="true"
                name="Cloud"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Server coordinates
                </p>
                <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
                  Chats, tasks, agent orchestration, and durable BB state.
                </p>
              </div>
            </div>
            <div className="flex gap-2.5">
              <Icon
                aria-hidden="true"
                name="Laptop"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Machines execute
                </p>
                <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">
                  Filesystems, source edits, terminals, builds, Xcode, and
                  Simulator.
                </p>
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>

      {isDesktop ? (
        <SettingsSection
          title="Choose server"
          description="Switching changes where desktop windows read and write chats. This Mac remains the default machine for projects, files, terminals, and agent execution."
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-md:pointer-coarse:min-h-11"
              disabled={switchingServerId !== null}
              onClick={onOpenCustomServerDialog}
            >
              <Icon aria-hidden="true" name="Plus" className="size-3.5" />
              Set server URL…
            </Button>
          }
        >
          {serverState === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading available servers…
            </p>
          ) : (
            <div
              className="space-y-1"
              role="group"
              aria-label="Available BB servers"
            >
              {serverState.servers.map((server) => (
                <ServerOptionRow
                  key={server.id}
                  active={server.id === serverState.activeServerId}
                  disabled={switchingServerId !== null}
                  onSelect={() => onSelect(server.id)}
                  server={server}
                  switching={server.id === switchingServerId}
                />
              ))}
            </div>
          )}
          {error !== null ? (
            <p className="mt-3 text-xs text-destructive-text" role="alert">
              {error}
            </p>
          ) : null}
          <p className="mt-3 border-t border-border pt-3 text-xs leading-snug text-subtle-foreground">
            A NAS appears here only after a BB server is running there and is
            paired with BB Connect. Adding the NAS as a machine does not make it
            the server. Choosing it here changes coordination only.
          </p>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="Switch server"
          description="A browser tab is attached to the server in its address bar."
        >
          <p className="text-sm leading-relaxed text-subtle-foreground">
            Open another BB server URL to switch. BB desktop also provides a
            saved server picker for This Mac, BB Connect servers, and custom
            URLs.
          </p>
        </SettingsSection>
      )}

      <div className="rounded-md border border-border bg-card px-3 py-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/35 text-muted-foreground">
            <Icon aria-hidden="true" name="Laptop" className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Execution on this Mac
            </p>
            <p
              className={cn(
                "mt-1 text-xs leading-relaxed",
                executionHost?.status === "error"
                  ? "text-destructive-text"
                  : "text-subtle-foreground",
              )}
              role={executionHost?.status === "error" ? "alert" : "status"}
            >
              {!isDesktop || !usesRemoteCoordinator
                ? "This Mac runs the selected projects, files, terminals, builds, Xcode, and Simulator."
                : executionHost?.status === "connected"
                  ? `Connected to ${activeServer?.name ?? "the coordination server"}. Chats stay there; projects, browsing, files, terminals, builds, Xcode, and Simulator stay on this Mac.`
                  : executionHost?.status === "error"
                    ? `This Mac could not connect as the execution machine: ${executionHost.error ?? "Unknown error"}`
                    : "Connecting this Mac as the execution machine…"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ServerSettingsSection() {
  const [desktopServerApi] = useState<BbDesktopServerApi | null>(
    () => getBbDesktopInfo()?.server ?? null,
  );
  const [serverState, setServerState] = useState<BbDesktopServerState | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [switchingServerId, setSwitchingServerId] = useState<string | null>(
    null,
  );
  const pushedStateVersionRef = useRef(0);

  useEffect(() => {
    if (desktopServerApi === null) return;

    let mounted = true;
    const unsubscribe = desktopServerApi.onStateChange((nextState) => {
      if (!mounted) return;
      pushedStateVersionRef.current += 1;
      setServerState(nextState);
      setError(null);
    });
    void (async () => {
      const initialStateVersion = pushedStateVersionRef.current;
      try {
        const initialState = await desktopServerApi.getState();
        if (!mounted || pushedStateVersionRef.current !== initialStateVersion) {
          return;
        }
        setServerState(initialState);
        setError(null);
      } catch (loadError) {
        if (!mounted || pushedStateVersionRef.current !== initialStateVersion) {
          return;
        }
        setError(errorMessage(loadError));
      }

      if (!mounted) return;
      setIsRefreshing(true);
      const refreshStateVersion = pushedStateVersionRef.current;
      try {
        const refreshedState = await desktopServerApi.refresh();
        if (!mounted || pushedStateVersionRef.current !== refreshStateVersion) {
          return;
        }
        setServerState(refreshedState);
        setError(null);
      } catch (refreshError) {
        if (!mounted || pushedStateVersionRef.current !== refreshStateVersion) {
          return;
        }
        setError(errorMessage(refreshError));
      } finally {
        if (mounted) setIsRefreshing(false);
      }
    })();

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [desktopServerApi]);

  const handleRefresh = (): void => {
    if (desktopServerApi === null || isRefreshing) return;
    const refreshStateVersion = pushedStateVersionRef.current;
    setIsRefreshing(true);
    setError(null);
    void desktopServerApi
      .refresh()
      .then((refreshedState) => {
        if (pushedStateVersionRef.current !== refreshStateVersion) return;
        setServerState(refreshedState);
      })
      .catch((refreshError: unknown) => {
        if (pushedStateVersionRef.current !== refreshStateVersion) return;
        setError(errorMessage(refreshError));
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  };

  const handleSelect = (serverId: string): void => {
    if (desktopServerApi === null || switchingServerId !== null) return;
    setSwitchingServerId(serverId);
    setError(null);
    void desktopServerApi.select(serverId).catch((selectionError: unknown) => {
      setSwitchingServerId(null);
      setError(errorMessage(selectionError));
    });
  };

  const browserServerUrl =
    typeof window === "undefined" ? "Unknown server" : window.location.origin;

  return (
    <ServerSettingsSectionContent
      browserServerUrl={browserServerUrl}
      error={error}
      isDesktop={desktopServerApi !== null}
      isRefreshing={isRefreshing}
      onOpenCustomServerDialog={() =>
        desktopServerApi?.openCustomServerDialog()
      }
      onRefresh={handleRefresh}
      onSelect={handleSelect}
      serverState={serverState}
      switchingServerId={switchingServerId}
    />
  );
}
