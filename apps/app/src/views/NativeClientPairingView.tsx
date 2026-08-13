import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { useSearchParams } from "react-router-dom";
import { BbHttpError, sdk } from "@/lib/sdk";

interface PairingTarget {
  code: string;
  requestId: string;
}

function pairingTarget(searchParams: URLSearchParams): PairingTarget | null {
  const requestId = searchParams.get("requestId")?.trim();
  const code = searchParams.get("code")?.trim();
  if (!requestId || !code) return null;
  return { code, requestId };
}

function formatRemaining(expiresAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function PairingShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="h-[var(--bb-shell-height)] overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 py-10 sm:px-8">
        {children}
      </div>
    </main>
  );
}

function PairingFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry(): void;
}) {
  const expired = error instanceof BbHttpError && error.status === 410;
  const invalid = error instanceof BbHttpError && error.status === 404;
  return (
    <PairingShell>
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <Icon name={expired ? "Clock" : "AlertCircle"} className="size-5" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">
          {expired
            ? "This pairing request expired"
            : invalid
              ? "This pairing link is not valid"
              : "Couldn’t load this pairing request"}
        </h1>
        <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
          {expired || invalid
            ? "Return to BB Desktop and start Connect this Mac again. Each link works only for its short approval window."
            : "The coordination server could not verify the request. Check your connection and try again."}
        </p>
        {!expired && !invalid ? (
          <Button className="mt-6" variant="outline" onClick={onRetry}>
            <Icon name="RotateCcw" />
            Try again
          </Button>
        ) : null}
      </section>
    </PairingShell>
  );
}

function InvalidPairingLink() {
  return (
    <PairingShell>
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon name="AlertCircle" className="size-5" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight">
          Open this page from BB Desktop
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          In BB Desktop, choose your coordination server and select Connect this
          Mac. The app will create a short-lived approval link for you.
        </p>
      </section>
    </PairingShell>
  );
}

export function NativeClientPairingView() {
  const [searchParams] = useSearchParams();
  const target = pairingTarget(searchParams);
  const [now, setNow] = useState(() => Date.now());
  const inspect = useQuery({
    enabled: target !== null,
    queryFn: ({ signal }) =>
      sdk.hosts.inspectNativeClientPairing({ ...target!, signal }),
    queryKey: ["native-client-pairing", target?.requestId, target?.code],
    retry: false,
  });
  const approve = useMutation({
    mutationFn: () => sdk.hosts.approveNativeClientPairing(target!),
  });

  const pairing = approve.data ?? inspect.data;
  const isApproved = pairing?.status === "approved";
  const isExpired = pairing !== undefined && pairing.expiresAt <= now;

  useEffect(() => {
    if (pairing === undefined || isApproved) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [isApproved, pairing]);

  if (target === null) return <InvalidPairingLink />;
  if (inspect.isError) {
    return (
      <PairingFailure error={inspect.error} onRetry={() => inspect.refetch()} />
    );
  }

  if (pairing === undefined) {
    return (
      <PairingShell>
        <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
          <Icon name="Spinner" className="size-5 animate-spin" />
          Checking the pairing request…
        </div>
      </PairingShell>
    );
  }

  if (isExpired) {
    return (
      <PairingFailure
        error={
          new BbHttpError({
            body: null,
            code: "native_pairing_expired",
            message: "The native pairing request expired",
            status: 410,
          })
        }
        onRetry={() => undefined}
      />
    );
  }

  return (
    <PairingShell>
      <div className="mb-5 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <span className="flex size-7 items-center justify-center rounded-md border border-border bg-card">
          <Icon name="Lock" className="size-3.5" />
        </span>
        Connect this Mac
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="p-6 sm:p-8">
          {isApproved ? (
            <>
              <div className="flex size-11 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                <Icon name="CircleCheck" className="size-6" />
              </div>
              <h1 className="mt-5 text-2xl font-semibold tracking-tight">
                This Mac is connected
              </h1>
              <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
                BB Desktop is finishing enrollment with this coordination
                server. You can close this tab and return to the app.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">
                Approve this Mac?
              </h1>
              <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
                Approve only if you just started Connect this Mac in BB Desktop
                and the code below matches the one shown there.
              </p>

              <div className="mt-7 grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-background px-4 py-3.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Icon name="Laptop" className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">Device</div>
                    <div className="truncate text-sm font-medium">
                      {pairing.deviceName}
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background px-5 py-3.5 text-center sm:min-w-48">
                  <div className="text-xs text-muted-foreground">
                    Matching code
                  </div>
                  <div className="mt-1 font-mono text-lg font-semibold tracking-[0.14em]">
                    {pairing.userCode}
                  </div>
                </div>
              </div>

              {approve.isError ? (
                <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  Approval failed. The request may have expired; return to BB
                  Desktop and try again.
                </div>
              ) : null}

              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icon name="Clock" className="size-3.5" />
                  Expires in {formatRemaining(pairing.expiresAt, now)}
                </div>
                <Button
                  disabled={approve.isPending}
                  onClick={() => approve.mutate()}
                >
                  {approve.isPending ? (
                    <Icon name="Spinner" className="animate-spin" />
                  ) : (
                    <Icon name="CircleCheck" />
                  )}
                  Approve this Mac
                </Button>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-border bg-muted/30 px-6 py-4 text-xs leading-5 text-muted-foreground sm:px-8">
          Your Authelia session stays in this browser. BB Desktop receives only
          a one-time machine enrollment and never receives your browser cookie.
        </div>
      </section>
    </PairingShell>
  );
}
