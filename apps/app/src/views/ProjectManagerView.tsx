import type {
  ProjectManagerProjectionDiff,
  ProjectManagerProjectionEnvironment,
  ProjectManagerProjectionPullRequest,
  ProjectManagerProjectionSourceFreshness,
  ProjectManagerProjectionResponse,
} from "@bb/server-contract";
import type { ThreadListEntry } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { useParams } from "react-router-dom";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { PageShell } from "@/components/ui/page-shell";
import { useProjectManagerProjection } from "@/hooks/queries/project-queries";
import { getThreadRoutePath } from "@/lib/route-paths";

type MetricTone = "attention" | "danger" | "good" | "neutral";

interface MetricPresentation {
  detail: string;
  href?: string;
  label: string;
  tone: MetricTone;
}

interface MetricCardProps extends MetricPresentation {
  icon: IconName;
  title: string;
}

const METRIC_TONE_CLASS: Record<MetricTone, string> = {
  neutral: "border-border bg-background",
  good: "border-emerald-500/20 bg-emerald-500/[0.06] dark:border-emerald-400/20",
  attention: "border-amber-500/25 bg-amber-500/[0.07] dark:border-amber-400/25",
  danger: "border-destructive/25 bg-destructive/[0.06]",
};

const METRIC_LABEL_CLASS: Record<MetricTone, string> = {
  neutral: "text-foreground",
  good: "text-emerald-700 dark:text-emerald-300",
  attention: "text-amber-700 dark:text-amber-300",
  danger: "text-destructive",
};

function words(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function projectionFallback(
  dimension:
    | ProjectManagerProjectionDiff
    | ProjectManagerProjectionPullRequest
    | ProjectManagerProjectionSourceFreshness,
): MetricPresentation {
  if (dimension.state === "resolved") {
    throw new Error("Resolved projection dimensions do not need a fallback");
  }
  if (dimension.state === "not_ready") {
    return {
      label: words(dimension.environmentStatus),
      detail: "Operational data will appear when the environment is ready.",
      tone: "neutral",
    };
  }
  return {
    label: "Unavailable",
    detail: dimension.message,
    tone: "danger",
  };
}

function presentDiff(
  dimension: ProjectManagerProjectionDiff,
): MetricPresentation {
  if (dimension.state !== "resolved") {
    return projectionFallback(dimension);
  }

  const result = dimension.value;
  if (result.outcome === "not_applicable") {
    return {
      label: "Not applicable",
      detail: result.message,
      tone: "neutral",
    };
  }
  if (result.outcome === "unavailable") {
    return {
      label: "Unavailable",
      detail: "The workspace could not be resolved on its machine.",
      tone: "danger",
    };
  }

  const workingTree = result.workspace.workingTree;
  const mergeBase = result.workspace.mergeBase;
  const fileCount = workingTree.files.length + (mergeBase?.files.length ?? 0);
  const insertions = workingTree.insertions + (mergeBase?.insertions ?? 0);
  const deletions = workingTree.deletions + (mergeBase?.deletions ?? 0);
  const hasChanges =
    workingTree.hasUncommittedChanges ||
    (mergeBase?.hasCommittedUnmergedChanges ?? false);
  return {
    label: hasChanges
      ? `${fileCount} changed ${fileCount === 1 ? "file" : "files"}`
      : "Workspace clean",
    detail: hasChanges
      ? `+${insertions} / −${deletions} across working tree and branch`
      : "No committed or uncommitted changes",
    tone: hasChanges ? "attention" : "good",
  };
}

function presentPullRequest(
  dimension: ProjectManagerProjectionPullRequest,
): MetricPresentation {
  if (dimension.state !== "resolved") {
    return projectionFallback(dimension);
  }

  const result = dimension.value;
  if (result.outcome === "absent") {
    return {
      label: "No pull request",
      detail: "This branch has no open or closed pull request.",
      tone: "neutral",
    };
  }
  if (result.outcome === "unavailable") {
    return {
      label: "Unavailable",
      detail: result.message,
      tone: "danger",
    };
  }

  const pullRequest = result.pullRequest;
  const good =
    pullRequest.attention === "ready_to_merge" ||
    pullRequest.attention === "merged";
  const neutral = pullRequest.attention === "none";
  const danger = [
    "checks_failed",
    "changes_requested",
    "conflicts",
    "blocked",
  ].includes(pullRequest.attention);
  return {
    label: `#${pullRequest.number} · ${words(pullRequest.attention)}`,
    detail: pullRequest.title,
    href: pullRequest.url,
    tone: good ? "good" : danger ? "danger" : neutral ? "neutral" : "attention",
  };
}

function presentSourceFreshness(
  dimension: ProjectManagerProjectionSourceFreshness,
): MetricPresentation {
  if (dimension.state !== "resolved") {
    return projectionFallback(dimension);
  }

  const result = dimension.value;
  if (result.outcome === "not_applicable") {
    return {
      label: "Not applicable",
      detail: result.message,
      tone: "neutral",
    };
  }
  if (result.outcome === "unavailable") {
    return {
      label: "Unavailable",
      detail: "Source freshness could not be read from the machine.",
      tone: "danger",
    };
  }

  const freshness = result.sourceFreshness;
  const tone: MetricTone =
    freshness.state === "up_to_date"
      ? "good"
      : freshness.state === "ahead"
        ? "neutral"
        : freshness.state === "diverged"
          ? "danger"
          : "attention";
  return {
    label: words(freshness.state),
    detail: `+${freshness.aheadCount} / −${freshness.behindCount} against ${freshness.sourceBranch}`,
    tone,
  };
}

function MetricCard({
  detail,
  href,
  icon,
  label,
  title,
  tone,
}: MetricCardProps) {
  const labelNode = href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
    >
      {label}
      <Icon name="ExternalLink" className="size-3" aria-hidden="true" />
    </a>
  ) : (
    label
  );

  return (
    <section
      className={cn(
        "min-w-0 rounded-lg border px-3 py-3",
        METRIC_TONE_CLASS[tone],
      )}
      aria-label={title}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-subtle-foreground">
        <Icon name={icon} className="size-3.5" aria-hidden="true" />
        {title}
      </div>
      <p
        className={cn(
          "mt-2 truncate text-sm font-semibold",
          METRIC_LABEL_CLASS[tone],
        )}
      >
        {labelNode}
      </p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
        {detail}
      </p>
    </section>
  );
}

function threadLabel(thread: ThreadListEntry): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

function ThreadRow({
  projectId,
  thread,
}: {
  projectId: string;
  thread: ThreadListEntry;
}) {
  return (
    <RouteAnchor
      href={getThreadRoutePath({ projectId, threadId: thread.id })}
      className="group flex min-w-0 items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/60"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          thread.hasPendingInteraction
            ? "bg-amber-500"
            : thread.status === "active"
              ? "bg-emerald-500"
              : "bg-muted-foreground/35",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground group-hover:underline group-hover:underline-offset-4">
        {threadLabel(thread)}
      </span>
      {thread.hasPendingInteraction ? (
        <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
          Waiting
        </span>
      ) : (
        <span className="shrink-0 text-xs text-subtle-foreground">
          {words(thread.status)}
        </span>
      )}
    </RouteAnchor>
  );
}

function ThreadList({
  projectId,
  threads,
}: {
  projectId: string;
  threads: ThreadListEntry[];
}) {
  if (threads.length === 0) {
    return (
      <p className="px-2 py-3 text-sm text-muted-foreground">
        No active threads in this environment.
      </p>
    );
  }
  const visibleThreads = threads.slice(0, 6);
  const remainingThreads = threads.slice(6);
  return (
    <div>
      {visibleThreads.map((thread) => (
        <ThreadRow key={thread.id} projectId={projectId} thread={thread} />
      ))}
      {remainingThreads.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer px-2 py-2 text-xs text-muted-foreground hover:text-foreground">
            Show {remainingThreads.length} more
          </summary>
          {remainingThreads.map((thread) => (
            <ThreadRow key={thread.id} projectId={projectId} thread={thread} />
          ))}
        </details>
      ) : null}
    </div>
  );
}

function environmentNeedsAttention(
  projection: ProjectManagerProjectionEnvironment,
): boolean {
  if (
    projection.environment.status !== "ready" ||
    projection.interaction.pendingThreadCount > 0
  ) {
    return true;
  }
  return [
    presentDiff(projection.diff),
    presentPullRequest(projection.pullRequest),
    presentSourceFreshness(projection.sourceFreshness),
  ].some((metric) => metric.tone === "attention" || metric.tone === "danger");
}

function EnvironmentCard({
  projectId,
  projection,
}: {
  projectId: string;
  projection: ProjectManagerProjectionEnvironment;
}) {
  const environment = projection.environment;
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-muted/20 px-4 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon
              name="Workflow"
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="truncate text-base font-semibold text-foreground">
              {environment.name ?? environment.branchName ?? "Environment"}
            </h2>
          </div>
          <p className="mt-1 truncate pl-6 text-xs text-muted-foreground">
            {environment.branchName ?? environment.path ?? environment.id}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {projection.interaction.pendingThreadCount > 0 ? (
            <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
              {projection.interaction.pendingThreadCount} waiting
            </span>
          ) : null}
          <span className="rounded-full border border-border bg-background px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {words(environment.status)}
          </span>
        </div>
      </header>

      <div className="grid gap-2 p-3 md:grid-cols-3">
        <MetricCard
          title="Diff"
          icon="FileDiff"
          {...presentDiff(projection.diff)}
        />
        <MetricCard
          title="Pull request"
          icon="GitPullRequest"
          {...presentPullRequest(projection.pullRequest)}
        />
        <MetricCard
          title="Source freshness"
          icon="GitBranch"
          {...presentSourceFreshness(projection.sourceFreshness)}
        />
      </div>

      <section
        className="border-t border-border px-3 py-3"
        aria-label="Threads"
      >
        <div className="mb-1 flex items-center justify-between px-2">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-subtle-foreground">
            Active threads
          </h3>
          <span className="text-xs tabular-nums text-muted-foreground">
            {projection.threads.length}
          </span>
        </div>
        <ThreadList projectId={projectId} threads={projection.threads} />
      </section>
    </article>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function ManagerDashboard({
  data,
}: {
  data: ProjectManagerProjectionResponse;
}) {
  const threadCount = data.environments.reduce(
    (count, environment) => count + environment.threads.length,
    data.unassignedThreads.length,
  );
  const attentionCount = data.environments.filter(
    environmentNeedsAttention,
  ).length;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-subtle-foreground">
            Manager projection
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            {data.project.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational state without conversation transcripts
          </p>
        </div>
        <p className="text-xs text-subtle-foreground">
          Updated{" "}
          {new Date(data.generatedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </p>
      </header>

      <section
        className="grid grid-cols-2 gap-2 md:grid-cols-4"
        aria-label="Project summary"
      >
        <SummaryCard label="Environments" value={data.environments.length} />
        <SummaryCard label="Active threads" value={threadCount} />
        <SummaryCard
          label="Waiting for input"
          value={data.interaction.pendingThreadCount}
        />
        <SummaryCard label="Need attention" value={attentionCount} />
      </section>

      {data.environments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <Icon
            name="Workflow"
            className="mx-auto size-6 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="mt-3 text-sm font-semibold text-foreground">
            No environments yet
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational state appears here once an environment is created.
          </p>
        </div>
      ) : (
        <section className="space-y-3" aria-label="Environments">
          {data.environments.map((projection) => (
            <EnvironmentCard
              key={projection.environment.id}
              projectId={data.project.id}
              projection={projection}
            />
          ))}
        </section>
      )}

      {data.unassignedThreads.length > 0 ? (
        <section className="rounded-xl border border-border bg-card p-3">
          <div className="mb-1 flex items-center justify-between px-2 py-1">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Project threads
              </h2>
              <p className="text-xs text-muted-foreground">
                Active threads that are not attached to an environment
              </p>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {data.unassignedThreads.length}
            </span>
          </div>
          <ThreadList
            projectId={data.project.id}
            threads={data.unassignedThreads}
          />
        </section>
      ) : null}
    </div>
  );
}

export function ProjectManagerView() {
  const { projectId } = useParams<{ projectId: string }>();
  const projection = useProjectManagerProjection(projectId);

  return (
    <PageShell maxWidthClassName="max-w-none" contentClassName="pt-4 md:pt-5">
      {projection.isPending ? (
        <div
          className="mx-auto w-full max-w-6xl space-y-3"
          aria-label="Loading manager projection"
        >
          <div className="h-24 rounded-xl border border-border bg-card" />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <div
                key={index}
                className="h-20 rounded-lg border border-border bg-card"
              />
            ))}
          </div>
          <div className="h-72 rounded-xl border border-border bg-card" />
        </div>
      ) : projection.isError || !projection.data ? (
        <div className="mx-auto mt-16 max-w-md rounded-xl border border-destructive/25 bg-destructive/[0.04] p-6 text-center">
          <Icon
            name="AlertCircle"
            className="mx-auto size-6 text-destructive"
            aria-hidden="true"
          />
          <h1 className="mt-3 text-base font-semibold text-foreground">
            Manager projection unavailable
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {projection.error instanceof Error
              ? projection.error.message
              : "The operational view could not be loaded."}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => projection.refetch()}
          >
            <Icon name="RotateCcw" className="size-3.5" aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : (
        <ManagerDashboard data={projection.data} />
      )}
    </PageShell>
  );
}
