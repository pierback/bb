import { ThreadSessionConnectionStatus } from "@/components/thread/ThreadSessionConnectionStatus";
import { useThreadSessionConnection } from "@/hooks/queries/session-fabric-queries";

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

  return connection ? (
    <ThreadSessionConnectionStatus connection={connection} variant="sidebar" />
  ) : null;
}
