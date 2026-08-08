import type {
  SessionFabricAdoptionRequest,
  SessionFabricAdoptionResponse,
  SessionFabricCommandAuditResponse,
  SessionFabricDiscoveryRequest,
  SessionFabricDiscoveryResponse,
  SessionFabricHandoffAbortResponse,
  SessionFabricHandoffActivateRequest,
  SessionFabricHandoffActivateResponse,
  SessionFabricHandoffAuditResponse,
  SessionFabricHandoffPrepareRequest,
  SessionFabricHandoffPrepareResponse,
  SessionFabricModelChangeRequest,
  SessionFabricModelChangeResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface SessionFabricDiscoverArgs extends SessionFabricDiscoveryRequest {
  signal?: AbortSignal;
}

export interface SessionFabricAdoptArgs extends SessionFabricAdoptionRequest {
  catalogConversationId: string;
  signal?: AbortSignal;
}

export interface SessionFabricChangeModelArgs extends SessionFabricModelChangeRequest {
  bindingId: string;
  signal?: AbortSignal;
}

export interface SessionFabricCommandAuditArgs {
  commandId: string;
  signal?: AbortSignal;
}

export interface SessionFabricPrepareHandoffArgs extends SessionFabricHandoffPrepareRequest {
  signal?: AbortSignal;
  sourceBindingId: string;
}

export interface SessionFabricActivateHandoffArgs extends SessionFabricHandoffActivateRequest {
  signal?: AbortSignal;
  transitionId: string;
}

export interface SessionFabricHandoffTargetArgs {
  signal?: AbortSignal;
  transitionId: string;
}

export type SessionFabricDiscoverResult = SessionFabricDiscoveryResponse;
export type SessionFabricAdoptResult = SessionFabricAdoptionResponse;
export type SessionFabricChangeModelResult = SessionFabricModelChangeResponse;
export type SessionFabricCommandAuditResult = SessionFabricCommandAuditResponse;
export type SessionFabricPrepareHandoffResult =
  SessionFabricHandoffPrepareResponse;
export type SessionFabricActivateHandoffResult =
  SessionFabricHandoffActivateResponse;
export type SessionFabricAbortHandoffResult = SessionFabricHandoffAbortResponse;
export type SessionFabricHandoffAuditResult = SessionFabricHandoffAuditResponse;

export interface SessionFabricArea {
  abortHandoff(
    args: SessionFabricHandoffTargetArgs,
  ): Promise<SessionFabricAbortHandoffResult>;
  activateHandoff(
    args: SessionFabricActivateHandoffArgs,
  ): Promise<SessionFabricActivateHandoffResult>;
  adopt(args: SessionFabricAdoptArgs): Promise<SessionFabricAdoptResult>;
  changeModel(
    args: SessionFabricChangeModelArgs,
  ): Promise<SessionFabricChangeModelResult>;
  commandAudit(
    args: SessionFabricCommandAuditArgs,
  ): Promise<SessionFabricCommandAuditResult>;
  discover(
    args: SessionFabricDiscoverArgs,
  ): Promise<SessionFabricDiscoverResult>;
  handoffAudit(
    args: SessionFabricHandoffTargetArgs,
  ): Promise<SessionFabricHandoffAuditResult>;
  prepareHandoff(
    args: SessionFabricPrepareHandoffArgs,
  ): Promise<SessionFabricPrepareHandoffResult>;
}

function withoutKeys<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

export function createSessionFabricArea(
  args: CreateSdkAreaArgs,
): SessionFabricArea {
  const { transport } = args;
  const routes = () => transport.api.v1["session-fabric"];
  return {
    async abortHandoff(input) {
      return transport.readJson(
        routes().handoffs[":transitionId"].abort.$post(
          {
            param: { transitionId: input.transitionId },
            json: {},
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async activateHandoff(input) {
      return transport.readJson(
        routes().handoffs[":transitionId"].activate.$post(
          {
            param: { transitionId: input.transitionId },
            json: withoutKeys(input, ["signal", "transitionId"]),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async adopt(input) {
      return transport.readJson(
        routes()["native-conversations"][":catalogConversationId"].adopt.$post(
          {
            param: { catalogConversationId: input.catalogConversationId },
            json: withoutKeys(input, ["catalogConversationId", "signal"]),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async changeModel(input) {
      return transport.readJson(
        routes().bindings[":bindingId"].model.$post(
          {
            param: { bindingId: input.bindingId },
            json: withoutKeys(input, ["bindingId", "signal"]),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async commandAudit(input) {
      return transport.readJson(
        routes().commands[":commandId"].$get(
          { param: { commandId: input.commandId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async discover(input) {
      return transport.readJson(
        routes().discovery.scan.$post(
          { json: withoutKeys(input, ["signal"]) },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async handoffAudit(input) {
      return transport.readJson(
        routes().handoffs[":transitionId"].$get(
          { param: { transitionId: input.transitionId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async prepareHandoff(input) {
      return transport.readJson(
        routes().bindings[":sourceBindingId"].handoffs.$post(
          {
            param: { sourceBindingId: input.sourceBindingId },
            json: withoutKeys(input, ["signal", "sourceBindingId"]),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
