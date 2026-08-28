import type { ProviderInfo } from "@bb/domain";
import type { SessionFabricConnection } from "@bb/server-contract";
import { Icon } from "@bb/shared-ui/icon";
import { Pill } from "@bb/shared-ui/pill";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { getProviderIconInfo } from "@/lib/provider-icon";

interface ThreadSessionConnectionStatusProps {
  connection: SessionFabricConnection;
  provider: ProviderInfo | null;
  variant: "header" | "sidebar";
}

export function isThreadSessionConnectionEnabled(
  connection: SessionFabricConnection,
): boolean {
  return (
    connection.isActiveAuthority &&
    (connection.adoptionStatus === null ||
      connection.adoptionStatus === "enabled") &&
    connection.mutationPolicy === "enabled"
  );
}

export function ThreadSessionConnectionStatus({
  connection,
  provider,
  variant,
}: ThreadSessionConnectionStatusProps) {
  const providerId = connection.nativeConversation.providerId;
  const iconInfo = getProviderIconInfo(providerId, provider);
  const ProviderIcon = iconInfo?.icon;
  const providerLabel = provider?.displayName ?? providerId;
  const isEnabled = isThreadSessionConnectionEnabled(connection);
  const statusLabel = isEnabled ? "Connected" : "Needs attention";
  const nativeTitle =
    connection.nativeConversation.title ??
    connection.nativeConversation.nativeConversationId;
  const accessibleLabel = `${providerLabel} session ${statusLabel.toLowerCase()}`;
  const title = `${accessibleLabel}: ${nativeTitle}`;
  const providerIcon = ProviderIcon ? (
    <span aria-hidden="true" className="inline-flex shrink-0">
      <ProviderIcon className="size-3.5" />
    </span>
  ) : (
    <Icon name="Code" className="size-3.5 shrink-0" aria-hidden="true" />
  );

  if (variant === "sidebar") {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-sidebar-thread-session-connection=""
              aria-label={accessibleLabel}
              className={cn(
                "relative inline-flex size-4 shrink-0 items-center justify-center",
                !isEnabled && "text-warning",
              )}
            >
              {providerIcon}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full border border-sidebar",
                  isEnabled ? "bg-success" : "bg-warning",
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{title}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <span title={title}>
      <Pill
        variant="outline"
        size="sm"
        className={cn(
          "max-w-44 gap-1.5 border-border/70 bg-transparent text-muted-foreground",
          !isEnabled && "border-warning/50 text-warning",
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {providerIcon}
          <span className="truncate">{providerLabel}</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span>{statusLabel}</span>
        </span>
      </Pill>
    </span>
  );
}
