import { ThreadSessionConnectionStatus } from "@/components/thread/ThreadSessionConnectionStatus";
import { useThreadSessionConnection } from "@/hooks/queries/session-fabric-queries";
import { useSystemProviderInfo } from "@/hooks/queries/system-queries";

interface SidebarThreadSessionConnectionBadgeProps {
  environmentId: string | null;
  threadId: string;
}

export function SidebarThreadSessionConnectionBadge({
  environmentId,
  threadId,
}: SidebarThreadSessionConnectionBadgeProps) {
  const connection = useThreadSessionConnection(
    threadId,
    environmentId,
  ).connection;
  const providerId = connection?.nativeConversation.providerId;
  const provider = useSystemProviderInfo(
    environmentId !== null
      ? {
          enabled: connection !== null,
          environmentId,
          providerId,
        }
      : { enabled: connection !== null, providerId },
  );

  return connection ? (
    <ThreadSessionConnectionStatus
      connection={connection}
      provider={provider}
      variant="sidebar"
    />
  ) : null;
}
