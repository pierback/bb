import { Link } from "react-router-dom";
import type { ProviderCliKey } from "@bb/host-daemon-contract";
import { Icon } from "@bb/shared-ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { SidebarMenuItem } from "@/components/ui/sidebar.js";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useUpdateInventory } from "@/hooks/useUpdateInventory";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { getSettingsRoutePath } from "@/lib/route-paths";

interface SidebarUpdatesBadgeProps {
  onNavigate?: () => void;
}

const CHIP_CLASS = cn(
  "flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-sidebar-border px-2",
  "text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent",
);

function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface StaleProvider {
  provider: ProviderCliKey;
  displayName: string;
}

/**
 * The quiet update affordance (BB-48): small outlined chips in the sidebar
 * footer's lower-right corner, rendered only while an update needs attention.
 * Each distinct action gets its own state-specific chip: relaunching after a
 * downloaded BB Mesh Desktop update, retrying a machine agent update, or
 * updating agent CLIs. Provider updates carry their brand marks so it is clear
 * which agent is stale without hovering. Every chip opens the consolidated
 * Settings → Updates view where the action is performed.
 *
 * A CLI that is not installed at all is not an update and gets no chip here:
 * there is no installed version to stale against, and the Settings → Updates
 * page already surfaces the install prompt for it.
 */
export function SidebarUpdatesBadge({ onNavigate }: SidebarUpdatesBadgeProps) {
  const inventory = useUpdateInventory();
  // The marks live with the provider registrations, so the roster is what
  // turns a stale CLI's provider id into its brand mark.
  const providers = useSystemProviders().data;

  const stuckDaemonCount = inventory.machines.filter(
    (machine) => machine.canRetryDaemonUpdate,
  ).length;

  // One mark per provider, even when the same CLI is stale on several machines.
  // Missing CLIs are install prompts, not updates: skip them so the chip never
  // claims an update is available for a CLI that isn't installed.
  const staleProvidersByKey = new Map<ProviderCliKey, StaleProvider>();
  for (const machine of inventory.machines) {
    for (const issue of machine.issues) {
      if (!issue.status.installed) {
        continue;
      }
      if (!staleProvidersByKey.has(issue.provider)) {
        staleProvidersByKey.set(issue.provider, {
          provider: issue.provider,
          displayName: issue.status.displayName,
        });
      }
    }
  }
  const staleProviders = [...staleProvidersByKey.values()];

  if (
    !inventory.desktopUpdateReady &&
    stuckDaemonCount === 0 &&
    staleProviders.length === 0
  ) {
    return null;
  }

  const updatesRoutePath = getSettingsRoutePath("updates");
  const desktopLabel = "Open Updates to relaunch and install BB Mesh";
  const machineLabel = `Open Updates to retry the BB Mesh agent update on ${stuckDaemonCount} ${stuckDaemonCount === 1 ? "machine" : "machines"}`;
  const providerLabel = `${joinNames(
    staleProviders.map((stale) => stale.displayName),
  )} ${staleProviders.length === 1 ? "update" : "updates"} available`;

  return (
    // Right-alignment on a single row comes from the flexible spacer the
    // sidebar footer renders before this item, not from a margin here — a
    // margin would also push the chips right on their own wrapped line. The
    // item and its chips may both wrap: the outer footer moves this group above
    // the footer actions, while this inner row keeps simultaneous desktop,
    // machine, and provider actions inside the narrowest sidebar width.
    <SidebarMenuItem className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1">
      {inventory.desktopUpdateReady ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={desktopLabel}
              data-testid="sidebar-updates-badge-desktop"
              className={CHIP_CLASS}
            >
              <Icon name="RotateCcw" className="size-3 text-muted-foreground" />
              Relaunch
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{desktopLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {stuckDaemonCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={machineLabel}
              data-testid="sidebar-updates-badge-machines"
              className={CHIP_CLASS}
            >
              <Icon name="RotateCcw" className="size-3 text-muted-foreground" />
              Retry {stuckDaemonCount}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{machineLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {staleProviders.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={providerLabel}
              data-testid="sidebar-updates-badge-providers"
              className={CHIP_CLASS}
            >
              <Icon name="Download" className="size-3 text-muted-foreground" />
              <span className="flex items-center gap-1">
                {staleProviders.map((stale) => {
                  const providerId = stale.provider;
                  const provider = providers?.find(
                    (candidate) => candidate.id === providerId,
                  );
                  const iconInfo = getProviderIconInfo(
                    providerId,
                    provider ?? null,
                  );
                  if (iconInfo === undefined) {
                    return null;
                  }
                  return (
                    <span
                      key={stale.provider}
                      data-provider-icon={providerId}
                      aria-hidden
                    >
                      {provider === undefined ? (
                        <iconInfo.icon className="size-3" />
                      ) : (
                        <ProviderIconMark
                          provider={provider}
                          icon={iconInfo.icon}
                          className="size-3"
                        />
                      )}
                    </span>
                  );
                })}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{providerLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}
