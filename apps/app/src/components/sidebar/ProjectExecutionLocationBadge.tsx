import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { PersistentHostIconName } from "@/lib/host-display";
import type { ProjectExecutionLocation } from "./projectExecutionLocation";

interface ProjectExecutionLocationBadgeProps {
  location: ProjectExecutionLocation;
}

export function ProjectExecutionLocationBadge({
  location,
}: ProjectExecutionLocationBadgeProps) {
  const [open, setOpen] = useState(false);
  const desktopNetwork = getBbDesktopInfo()?.network ?? null;
  const addressesQuery = useQuery({
    queryKey: ["desktop-machine-addresses", location.machineName],
    queryFn: () =>
      desktopNetwork!.resolveMachineAddresses({
        hostname: location.machineName,
      }),
    enabled: open && desktopNetwork !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const addresses = addressesQuery.data?.addresses ?? [];

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            aria-label={location.title}
            tabIndex={0}
            className={cn(
              "inline-flex max-w-24 shrink-0 items-center gap-2 rounded-sm text-xs font-normal leading-none text-subtle-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
              !location.connected && "opacity-60",
            )}
          >
            <Icon
              name={PersistentHostIconName}
              className="size-3 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{location.label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          className="w-72 border border-border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <Icon
                name={PersistentHostIconName}
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate text-sm font-medium">
                {location.label}
              </span>
            </div>
            <div className="flex items-center gap-2 border-t border-border pt-2.5 text-xs text-subtle-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  location.connected ? "bg-success" : "bg-muted-foreground",
                )}
              />
              {location.connected ? "Connected" : "Offline"}
            </div>
            <div className="flex items-start gap-2 text-xs">
              <Icon
                name="Globe"
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <div className="text-subtle-foreground">
                  {addresses.length === 1 ? "IP address" : "IP addresses"}
                </div>
                {addresses.length > 0 ? (
                  <div className="mt-0.5 space-y-0.5 font-mono text-foreground">
                    {addresses.map((address) => (
                      <div key={address} className="break-all">
                        {address}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-0.5 text-subtle-foreground">
                    {desktopNetwork === null
                      ? "Available in the desktop app"
                      : addressesQuery.isPending
                        ? "Looking up…"
                        : "Not found on this network"}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-start gap-2 border-t border-border pt-2.5 text-xs">
              <Icon
                name="Folder"
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 break-all font-mono text-subtle-foreground">
                {location.path}
              </span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
