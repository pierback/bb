import { Badge } from "@bb/shared-ui/badge";
import type { SessionFabricConnectionView } from "./server.js";

function displayToken(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-1.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 break-words text-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

export function ConnectionDetails({
  connection,
  showTechnicalIdentifiers,
}: {
  connection: SessionFabricConnectionView;
  showTechnicalIdentifiers: boolean;
}) {
  const conversationTitle =
    connection.nativeConversation.title ?? "Untitled provider conversation";
  const model = connection.effectiveModel
    ? `${connection.effectiveModel.providerId}/${connection.effectiveModel.modelId}`
    : "Not reported";
  const runtime = connection.runtime
    ? displayToken(connection.runtime.status)
    : "Not attached";

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-border bg-surface-raised p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {conversationTitle}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {connection.nativeConversation.providerId} provider session
            </p>
          </div>
          <Badge
            variant={connection.isActiveAuthority ? "secondary" : "outline"}
            className="shrink-0 font-normal"
          >
            {connection.isActiveAuthority ? "Active authority" : "Observed"}
          </Badge>
        </div>
      </section>

      <section aria-labelledby="fabric-runtime-heading">
        <h3
          id="fabric-runtime-heading"
          className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Runtime
        </h3>
        <dl className="divide-y divide-border-seam">
          <DetailRow label="Phase" value={displayToken(connection.phase)} />
          <DetailRow label="Runtime" value={runtime} />
          <DetailRow
            label="Mutation policy"
            value={displayToken(connection.mutationPolicy)}
          />
          <DetailRow
            label="Ownership"
            value={displayToken(connection.ownership)}
          />
          <DetailRow
            label="Provider state"
            value={connection.nativeConversation.providerState}
          />
        </dl>
      </section>

      <section aria-labelledby="fabric-model-heading">
        <h3
          id="fabric-model-heading"
          className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Model
        </h3>
        <dl className="divide-y divide-border-seam">
          <DetailRow label="Model" value={model} />
          <DetailRow
            label="Reasoning"
            value={connection.reasoningLevel ?? "Not reported"}
          />
          <DetailRow
            label="Service tier"
            value={connection.serviceTier ?? "Not reported"}
          />
        </dl>
      </section>

      <section aria-labelledby="fabric-observation-heading">
        <h3
          id="fabric-observation-heading"
          className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Observation
        </h3>
        <dl className="divide-y divide-border-seam">
          <DetailRow
            label="Provider host"
            value={connection.nativeConversation.hostId}
            mono
          />
          <DetailRow
            label="Working directory"
            value={connection.nativeConversation.cwd ?? "Not reported"}
            mono
          />
          <DetailRow
            label="Last observed"
            value={formatTimestamp(
              connection.nativeConversation.lastObservedAt,
            )}
          />
        </dl>
      </section>

      {showTechnicalIdentifiers ? (
        <section aria-labelledby="fabric-identifiers-heading">
          <h3
            id="fabric-identifiers-heading"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Technical identifiers
          </h3>
          <dl className="divide-y divide-border-seam">
            <DetailRow label="Binding" value={connection.bindingId} mono />
            <DetailRow
              label="Control epoch"
              value={String(connection.controlEpoch)}
              mono
            />
            <DetailRow
              label="Runtime"
              value={connection.runtime?.id ?? "None"}
              mono
            />
            <DetailRow
              label="Environment"
              value={connection.environmentId ?? "None"}
              mono
            />
            <DetailRow
              label="Provider instance"
              value={connection.nativeConversation.providerInstanceId}
              mono
            />
            <DetailRow
              label="Native conversation"
              value={connection.nativeConversation.nativeConversationId}
              mono
            />
            <DetailRow
              label="Catalog conversation"
              value={connection.nativeConversation.catalogConversationId}
              mono
            />
            <DetailRow
              label="Updated"
              value={formatTimestamp(connection.updatedAt)}
            />
          </dl>
        </section>
      ) : null}
    </div>
  );
}
