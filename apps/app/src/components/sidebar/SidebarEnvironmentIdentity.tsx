import {
  useEnvironment,
  useEnvironmentWorkStatus,
} from "@/hooks/queries/environment-queries";

interface SidebarEnvironmentIdentityProps {
  environmentId: string;
  displayName: string;
  branchName: string | null;
}

function formatWorkingTreeChanges(count: number): string {
  return `${count} change${count === 1 ? "" : "s"}`;
}

export function SidebarEnvironmentIdentity({
  environmentId,
  displayName,
  branchName,
}: SidebarEnvironmentIdentityProps) {
  const environmentQuery = useEnvironment(environmentId);
  const workStatusQuery = useEnvironmentWorkStatus(environmentId);
  const workspace =
    workStatusQuery.data?.outcome === "available"
      ? workStatusQuery.data.workspace
      : null;
  const resolvedBranchName =
    branchName ??
    (workspace?.checkout.kind === "branch"
      ? workspace.checkout.branchName
      : null);
  const changedFiles = workspace?.workingTree.hasUncommittedChanges
    ? workspace.workingTree.files.length
    : 0;
  const showBranch =
    resolvedBranchName !== null && resolvedBranchName !== displayName;

  return (
    <span
      className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5"
      title={environmentQuery.data?.path ?? undefined}
    >
      <span className="min-w-0 truncate">{displayName}</span>
      {showBranch ? (
        <span
          className="min-w-0 truncate text-subtle-foreground/60"
          aria-label={`Branch ${resolvedBranchName}`}
        >
          {resolvedBranchName}
        </span>
      ) : null}
      {changedFiles > 0 ? (
        <span className="shrink-0 rounded-sm bg-warning/10 px-1 text-xs leading-4 text-warning">
          {formatWorkingTreeChanges(changedFiles)}
        </span>
      ) : null}
    </span>
  );
}
