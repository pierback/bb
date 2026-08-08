import { useState, type FormEvent } from "react";
import type { EnvironmentPreviewResourceKind } from "@bb/domain";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import {
  useCreateEnvironmentPreviewResource,
  useRemoveEnvironmentPreviewResource,
  useSelectEnvironmentPreviewResource,
} from "@/hooks/mutations/environment-mutations";
import { useEnvironmentPreviewResources } from "@/hooks/queries/environment-queries";

interface EnvironmentPreviewWorkspaceProps {
  environmentId: string;
}

interface AddEnvironmentPreviewDialogProps {
  environmentId: string;
  expectedRevision: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EnvironmentPreviewWorkspace({
  environmentId,
}: EnvironmentPreviewWorkspaceProps) {
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const previewsQuery = useEnvironmentPreviewResources(environmentId);
  const selectPreview = useSelectEnvironmentPreviewResource();
  const removePreview = useRemoveEnvironmentPreviewResource();
  const state = previewsQuery.data;
  const selectedResource =
    state?.previewResources.find(
      ({ id }) => id === state.selectedPreviewResourceId,
    ) ?? null;
  const mutationPending = selectPreview.isPending || removePreview.isPending;

  const changeSelection = (selectedPreviewResourceId: string | null) => {
    if (!state || selectedPreviewResourceId === state.selectedPreviewResourceId)
      return;
    selectPreview.mutate({
      environmentId,
      expectedRevision: state.revision,
      selectedPreviewResourceId,
    });
  };

  return (
    <section
      aria-label="Environment preview"
      className="shrink-0 border-b border-border-hairline bg-background"
      data-testid="environment-preview-workspace"
    >
      <div className="flex h-10 min-w-0 items-center gap-2 bg-muted/10 px-2.5">
        <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-foreground">
          <Icon name="Globe" className="size-3.5 text-muted-foreground" />
          <span className="max-sm:sr-only">Preview</span>
        </div>
        <select
          aria-label="Selected environment preview"
          className="h-7 min-w-0 max-w-72 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          disabled={!state || mutationPending}
          value={state?.selectedPreviewResourceId ?? ""}
          onChange={(event) =>
            changeSelection(
              event.target.value.length > 0 ? event.target.value : null,
            )
          }
        >
          <option value="">No preview selected</option>
          {state?.previewResources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.label} ·{" "}
              {resource.kind === "remote_novnc" ? "noVNC" : "browser"}
            </option>
          ))}
        </select>
        {selectedResource ? (
          <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-2xs text-muted-foreground lg:inline">
            {selectedResource.kind === "remote_novnc" ? "REMOTE" : "LOCAL"}
          </span>
        ) : null}
        {selectedResource ? (
          <a
            aria-label={`Open ${selectedResource.label} in a new tab`}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={selectedResource.url}
            rel="noreferrer"
            target="_blank"
          >
            <Icon name="ExternalLink" className="size-3.5" />
          </a>
        ) : null}
        {selectedResource && state ? (
          <Button
            aria-label={`Remove ${selectedResource.label}`}
            className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
            disabled={mutationPending}
            size="icon"
            type="button"
            variant="ghost"
            onClick={() =>
              removePreview.mutate({
                environmentId,
                expectedRevision: state.revision,
                resourceId: selectedResource.id,
              })
            }
          >
            <Icon name="Trash2" className="size-3.5" />
          </Button>
        ) : null}
        <Button
          className="h-7 shrink-0 gap-1.5 px-2 text-xs"
          disabled={!state}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => setAddDialogOpen(true)}
        >
          <Icon name="Plus" className="size-3.5" />
          <span className="max-sm:sr-only">Add preview</span>
        </Button>
      </div>
      {selectedResource ? (
        <div className="relative h-[min(38vh,28rem)] min-h-48 overflow-hidden border-t border-border-hairline bg-muted/25">
          <iframe
            key={selectedResource.id}
            allow="clipboard-read; clipboard-write; fullscreen"
            className="h-full w-full border-0 bg-background"
            data-testid="environment-preview-frame"
            referrerPolicy="no-referrer"
            sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
            src={selectedResource.url}
            title={`${selectedResource.label} environment preview`}
          />
        </div>
      ) : null}
      {state ? (
        <AddEnvironmentPreviewDialog
          environmentId={environmentId}
          expectedRevision={state.revision}
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
        />
      ) : null}
    </section>
  );
}

function AddEnvironmentPreviewDialog({
  environmentId,
  expectedRevision,
  open,
  onOpenChange,
}: AddEnvironmentPreviewDialogProps) {
  const createPreview = useCreateEnvironmentPreviewResource();
  const [kind, setKind] =
    useState<EnvironmentPreviewResourceKind>("local_browser");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedLabel = label.trim();
    const normalizedUrl = url.trim();
    if (normalizedLabel.length === 0 || normalizedUrl.length === 0) return;
    try {
      await createPreview.mutateAsync({
        environmentId,
        expectedRevision,
        kind,
        label: normalizedLabel,
        url: normalizedUrl,
      });
      onOpenChange(false);
      setLabel("");
      setUrl("");
    } catch {
      // The shared mutation error boundary owns the user-facing toast.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add environment preview</DialogTitle>
          <DialogDescription>
            Register a browser URL or an existing noVNC endpoint. BB stores the
            resource and selection; it does not provision a noVNC server.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Kind</span>
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={createPreview.isPending}
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as EnvironmentPreviewResourceKind)
              }
            >
              <option value="local_browser">Local browser</option>
              <option value="remote_novnc">Remote noVNC</option>
            </select>
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Label</span>
            <Input
              autoFocus
              disabled={createPreview.isPending}
              placeholder="Development app"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>URL</span>
            <Input
              autoCapitalize="off"
              autoCorrect="off"
              disabled={createPreview.isPending}
              placeholder={
                kind === "remote_novnc"
                  ? "https://preview.example/vnc.html"
                  : "http://127.0.0.1:3000"
              }
              spellCheck={false}
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button
              disabled={
                createPreview.isPending ||
                label.trim().length === 0 ||
                url.trim().length === 0
              }
              type="submit"
            >
              Add preview
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
