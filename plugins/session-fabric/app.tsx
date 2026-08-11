import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useSettings,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { ConnectionDetails } from "./connection-details.js";
import type {
  SessionFabricConnectionView,
  sessionFabricRpcContract,
} from "./server.js";

type PanelState =
  | { status: "loading" }
  | { status: "connecting" }
  | { status: "ready"; connection: SessionFabricConnectionView | null }
  | { status: "error"; message: string };

function LoadingPanel() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading Session Fabric">
      <Skeleton className="h-20 w-full rounded-lg" />
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function SessionFabricThreadPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof sessionFabricRpcContract>();
  const settings = useSettings();
  const requestSequence = useRef(0);
  const [state, setState] = useState<PanelState>({ status: "loading" });

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const result = await rpc.call("threadConnection", { threadId });
      if (requestSequence.current === sequence) {
        setState({ status: "ready", connection: result.connection });
      }
    } catch (error) {
      if (requestSequence.current === sequence) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [rpc, threadId]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    void rpc.call("threadConnection", { threadId }).then(
      (result) => {
        if (requestSequence.current === sequence) {
          setState({ status: "ready", connection: result.connection });
        }
      },
      (error: unknown) => {
        if (requestSequence.current === sequence) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      requestSequence.current += 1;
    };
  }, [rpc, threadId]);

  const reload = () => {
    setState({ status: "loading" });
    void load();
  };

  const connect = async () => {
    const sequence = ++requestSequence.current;
    setState({ status: "connecting" });
    try {
      const result = await rpc.call("connectThread", { threadId });
      if (requestSequence.current === sequence) {
        setState({ status: "ready", connection: result.connection });
      }
    } catch (error) {
      if (requestSequence.current === sequence) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  if (state.status === "loading") return <LoadingPanel />;

  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <div>
          <p className="text-sm font-medium text-foreground">
            Session Fabric is unavailable
          </p>
          <p className="mt-1 break-words text-xs text-destructive-text">
            {state.message}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }

  if (state.status === "connecting" || state.connection === null) {
    const connecting = state.status === "connecting";
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">
            No portable session is connected
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Connect this BB thread to its current provider conversation so the
            session can be inspected and handed off safely.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={connecting}
          onClick={() => void connect()}
        >
          {connecting ? "Connecting…" : "Connect thread"}
        </Button>
      </div>
    );
  }

  const showTechnicalIdentifiers =
    settings.values?.showTechnicalIdentifiers === true;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Session Fabric
          </h2>
          <p className="text-xs text-muted-foreground">
            Portable provider-session state for this thread
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={reload}>
          Refresh
        </Button>
      </div>
      <ConnectionDetails
        connection={state.connection}
        showTechnicalIdentifiers={showTechnicalIdentifiers}
      />
    </div>
  );
}

export function SessionFabricPanel({ threadId }: PluginThreadPanelProps) {
  return <SessionFabricThreadPanel key={threadId} threadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "session-fabric",
    title: "Session Fabric",
    icon: "Workflow",
    component: SessionFabricPanel,
  });
});
