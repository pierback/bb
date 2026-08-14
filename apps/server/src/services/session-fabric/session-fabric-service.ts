import { createHash } from "node:crypto";
import {
  applySessionCommandEvent,
  draftSessionCommand,
  enablePreparedSessionAdoption,
  finalizePreparedSessionAdoption,
  getEnvironment,
  getNonDestroyedHost,
  getProject,
  getSessionAdoptionForRetry,
  getSessionCommandAudit,
  getSessionExecutionBindingContext,
  getSessionFabricThreadConnection as getStoredSessionFabricThreadConnection,
  getSessionNativeConversation,
  getThread,
  listSessionFabricEnvironmentConnections as listStoredSessionFabricEnvironmentConnections,
  listProjectSourcesByProjectIds,
  prepareSessionAdoption,
  SessionFabricPersistenceError,
  settleSessionModelChange,
  upsertSessionNativeConversation,
  type SessionExecutionBindingContext,
  type SessionFabricConnectionProjection,
  type SessionAdoptionContext,
  type SessionAdoptionRequestIdentity,
} from "@bb/db";
import {
  outcomeUnknownReceipt,
  runtimeOwnershipAllowsMutation,
  type MutationReceipt,
  type SessionCommandLifecycleEvent,
  type SessionModelRef,
} from "@bb/domain";
import type {
  SessionFabricAdoptionRequest,
  SessionFabricAdoptionResponse,
  SessionFabricCommandAuditResponse,
  SessionFabricConnectResponse,
  SessionFabricDiscoveryCatalogEntry,
  SessionFabricDiscoveryRequest,
  SessionFabricDiscoveryResponse,
  SessionFabricEnvironmentConnectionsResponse,
  SessionFabricModelChangeRequest,
  SessionFabricModelChangeResponse,
  SessionFabricThreadConnectionResponse,
} from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpc,
} from "../hosts/online-rpc.js";
import { getLastProviderThreadId } from "../threads/thread-events.js";

const THREAD_CONNECTION_DISCOVERY_LIMIT = 200;

export function throwSessionFabricPersistenceApiError(
  error: SessionFabricPersistenceError,
): never {
  if (
    error.code === "adoption_not_found" ||
    error.code === "binding_not_found" ||
    error.code === "command_not_found" ||
    error.code === "handoff_not_found"
  ) {
    throw new ApiError(404, error.code, error.message);
  }
  if (error.code === "invalid_model_change_receipt") {
    throw new ApiError(502, error.code, error.message, false);
  }
  throw new ApiError(409, error.code, error.message, false);
}

function adoptionIdentity(
  catalogConversationId: string,
  request: SessionFabricAdoptionRequest,
): SessionAdoptionRequestIdentity {
  return {
    catalogConversationId,
    idempotencyKey: request.idempotencyKey,
    objective: request.objective,
    threadId: request.threadId,
    title: request.title,
  };
}

function toAdoptionResponse(
  context: SessionAdoptionContext,
): SessionFabricAdoptionResponse {
  const runtimeInstanceId = context.bindingContext.binding.runtimeInstanceId;
  if (runtimeInstanceId === null) {
    throw new ApiError(
      500,
      "invalid_binding_topology",
      `Adoption ${context.adoption.id} has no runtime instance`,
      false,
    );
  }
  return {
    adoptionId: context.adoption.id,
    bindingId: context.bindingContext.binding.id,
    branchId: context.bindingContext.branch.id,
    controlEpoch: context.bindingContext.binding.controlEpoch,
    mutationPolicy: context.bindingContext.binding.mutationPolicy,
    phase: context.bindingContext.binding.phase,
    runtimeInstanceId,
    status: context.adoption.status,
    threadId: context.adoption.threadId,
    workstreamId: context.bindingContext.workstream.id,
  };
}

function notifySessionFabricConnectionChange(
  deps: Pick<AppDeps, "hub">,
  context: SessionAdoptionContext,
): void {
  const environmentId = context.bindingContext.environment?.id;
  if (environmentId) {
    deps.hub.notifyEnvironment(environmentId, ["session-connections-changed"]);
  }
}

function readSessionFabricThreadConnection(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): SessionFabricConnectionProjection | null {
  try {
    return getStoredSessionFabricThreadConnection(deps.db, threadId);
  } catch (error) {
    if (error instanceof SessionFabricPersistenceError) {
      throwSessionFabricPersistenceApiError(error);
    }
    throw error;
  }
}

export function getSessionFabricThreadConnection(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): SessionFabricThreadConnectionResponse {
  const thread = getThread(deps.db, threadId);
  if (!thread || thread.deletedAt !== null) {
    throw new ApiError(
      404,
      "thread_not_found",
      `Thread not found: ${threadId}`,
    );
  }
  return { connection: readSessionFabricThreadConnection(deps, threadId) };
}

export function listSessionFabricEnvironmentConnections(
  deps: Pick<AppDeps, "db">,
  environmentId: string,
): SessionFabricEnvironmentConnectionsResponse {
  const environment = getEnvironment(deps.db, environmentId);
  if (!environment || environment.status === "destroyed") {
    throw new ApiError(
      404,
      "environment_not_found",
      `Environment not found: ${environmentId}`,
    );
  }
  try {
    return {
      connections: listStoredSessionFabricEnvironmentConnections(
        deps.db,
        environmentId,
      ),
    };
  } catch (error) {
    if (error instanceof SessionFabricPersistenceError) {
      throwSessionFabricPersistenceApiError(error);
    }
    throw error;
  }
}

function requireAdoptionRuntimeContext(context: SessionAdoptionContext) {
  const { environment, runtimeInstance, thread } = context.bindingContext;
  if (!environment || !runtimeInstance || !thread) {
    throw new ApiError(
      409,
      "invalid_binding_topology",
      `Adoption ${context.adoption.id} has incomplete runtime topology`,
      false,
    );
  }
  return { environment, runtimeInstance, thread };
}

export async function adoptSessionFabricConversation(
  deps: AppDeps,
  catalogConversationId: string,
  request: SessionFabricAdoptionRequest,
): Promise<SessionFabricAdoptionResponse> {
  const identity = adoptionIdentity(catalogConversationId, request);
  let context: SessionAdoptionContext | null;
  try {
    context = getSessionAdoptionForRetry(deps.db, identity);
  } catch (error) {
    if (error instanceof SessionFabricPersistenceError) {
      throwSessionFabricPersistenceApiError(error);
    }
    throw error;
  }

  if (!context) {
    const nativeConversation = getSessionNativeConversation(
      deps.db,
      catalogConversationId,
    );
    if (!nativeConversation) {
      throw new ApiError(
        404,
        "native_conversation_not_found",
        `Session Fabric native conversation not found: ${catalogConversationId}`,
      );
    }
    const thread = getThread(deps.db, request.threadId);
    const environment =
      thread?.environmentId == null
        ? null
        : getEnvironment(deps.db, thread.environmentId);
    if (!thread || !environment) {
      throw new ApiError(
        409,
        "adoption_thread_environment_unavailable",
        "Adoption requires a thread attached to a live environment",
        false,
      );
    }
    const inspection = await callHostRetryableOnlineRpc(deps, {
      command: {
        type: "session.runtime.inspect",
        environmentId: environment.id,
        expectedProviderId: nativeConversation.providerId,
        expectedProviderThreadId: nativeConversation.nativeConversationId,
        providerInstanceId: nativeConversation.providerInstanceId,
        threadId: thread.id,
      },
      hostId: nativeConversation.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    try {
      context = prepareSessionAdoption(deps.db, {
        ...identity,
        inspection,
      });
      notifySessionFabricConnectionChange(deps, context);
    } catch (error) {
      if (error instanceof SessionFabricPersistenceError) {
        throwSessionFabricPersistenceApiError(error);
      }
      throw error;
    }
  }

  if (context.adoption.status === "prepared") {
    const { environment, runtimeInstance, thread } =
      requireAdoptionRuntimeContext(context);
    const control = await callHostRetryableOnlineRpc(deps, {
      command: {
        type: "session.runtime.bind",
        bindingId: context.bindingContext.binding.id,
        controlEpoch: context.bindingContext.binding.controlEpoch,
        environmentId: environment.id,
        expectedBootNonce: runtimeInstance.bootNonce,
        expectedEndpointFingerprint: runtimeInstance.endpointFingerprint,
        expectedProviderId:
          context.bindingContext.nativeConversation.providerId,
        expectedProviderThreadId:
          context.bindingContext.nativeConversation.nativeConversationId,
        expectedRuntimeInstanceId: runtimeInstance.id,
        mutationPolicy: "staged_read_only",
        providerInstanceId:
          context.bindingContext.nativeConversation.providerInstanceId,
        threadId: thread.id,
      },
      hostId: context.bindingContext.nativeConversation.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    try {
      context = finalizePreparedSessionAdoption(deps.db, {
        adoptionId: context.adoption.id,
        control,
      });
      notifySessionFabricConnectionChange(deps, context);
    } catch (error) {
      if (error instanceof SessionFabricPersistenceError) {
        throwSessionFabricPersistenceApiError(error);
      }
      throw error;
    }
  }

  if (context.adoption.status === "host_bound") {
    const { environment, runtimeInstance, thread } =
      requireAdoptionRuntimeContext(context);
    const control = await callHostRetryableOnlineRpc(deps, {
      command: {
        type: "session.runtime.set_mutation_policy",
        bindingId: context.bindingContext.binding.id,
        bootNonce: runtimeInstance.bootNonce,
        endpointFingerprint: runtimeInstance.endpointFingerprint,
        environmentId: environment.id,
        expectedControlEpoch: context.bindingContext.binding.controlEpoch,
        expectedMutationPolicy: "staged_read_only",
        nextMutationPolicy: "enabled",
        runtimeInstanceId: runtimeInstance.id,
        threadId: thread.id,
      },
      hostId: context.bindingContext.nativeConversation.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    try {
      context = enablePreparedSessionAdoption(deps.db, {
        adoptionId: context.adoption.id,
        control,
      });
      notifySessionFabricConnectionChange(deps, context);
    } catch (error) {
      if (error instanceof SessionFabricPersistenceError) {
        throwSessionFabricPersistenceApiError(error);
      }
      throw error;
    }
  }

  if (context.adoption.status !== "enabled") {
    throw new ApiError(
      409,
      "adoption_incomplete",
      `Adoption ${context.adoption.id} stopped in ${context.adoption.status}`,
      false,
    );
  }
  return toAdoptionResponse(context);
}

function requireBindingContext(
  deps: Pick<AppDeps, "db">,
  bindingId: string,
): SessionExecutionBindingContext {
  try {
    const context = getSessionExecutionBindingContext(deps.db, bindingId);
    if (!context) {
      throw new ApiError(
        404,
        "binding_not_found",
        `Session Fabric binding not found: ${bindingId}`,
      );
    }
    return context;
  } catch (error) {
    if (error instanceof SessionFabricPersistenceError) {
      throwSessionFabricPersistenceApiError(error);
    }
    throw error;
  }
}

function applyCommandEvent(
  deps: Pick<AppDeps, "db">,
  commandId: string,
  event: SessionCommandLifecycleEvent,
) {
  const outcome = applySessionCommandEvent(deps.db, { commandId, event });
  if (!outcome.applied) {
    throw new ApiError(
      outcome.reason === "not_found" ? 404 : 409,
      `session_command_${outcome.reason}`,
      outcome.detail,
      false,
    );
  }
  return outcome.command;
}

function assertModelChangeAuthority(
  context: SessionExecutionBindingContext,
  requestedModel: SessionModelRef,
): asserts context is SessionExecutionBindingContext & {
  environment: NonNullable<SessionExecutionBindingContext["environment"]>;
  runtimeInstance: NonNullable<
    SessionExecutionBindingContext["runtimeInstance"]
  >;
  thread: NonNullable<SessionExecutionBindingContext["thread"]>;
} {
  const { binding, branch, environment, nativeConversation, runtimeInstance } =
    context;
  const thread = context.thread;
  if (
    branch.activeBindingId !== binding.id ||
    branch.status !== "active" ||
    context.workstream.activeBranchId !== branch.id ||
    context.workstream.status !== "active" ||
    binding.closedAt !== null
  ) {
    throw new ApiError(
      409,
      "binding_not_active",
      "Model changes require the active open Session Fabric binding",
      false,
    );
  }
  if (
    binding.phase !== "idle" ||
    binding.providerTurnId !== null ||
    thread?.status !== "idle"
  ) {
    throw new ApiError(
      409,
      "runtime_not_idle",
      "Model changes are only allowed while the bound runtime is idle",
      false,
    );
  }
  if (!runtimeOwnershipAllowsMutation(binding.ownership)) {
    throw new ApiError(
      409,
      "runtime_not_controllable",
      `Runtime ownership ${binding.ownership} does not permit mutation`,
      false,
    );
  }
  if (binding.mutationPolicy !== "enabled") {
    throw new ApiError(
      409,
      "runtime_mutation_policy_read_only",
      "Model changes are forbidden while the Session Fabric binding is staged read-only",
      false,
    );
  }
  if (
    !runtimeInstance ||
    runtimeInstance.status !== "live" ||
    !thread ||
    !environment ||
    environment.status !== "ready"
  ) {
    throw new ApiError(
      409,
      "binding_runtime_unavailable",
      "Model changes require a live runtime, idle thread, and ready environment",
      false,
    );
  }
  if (
    requestedModel.providerId !== nativeConversation.providerId ||
    requestedModel.providerId !== runtimeInstance.providerId ||
    requestedModel.providerId !== thread.providerId
  ) {
    throw new ApiError(
      409,
      "cross_provider_model_change_forbidden",
      "A model change cannot switch the binding to another provider",
      false,
    );
  }
}

function modelChangePayloadHash(
  bindingId: string,
  request: SessionFabricModelChangeRequest,
): string {
  const payload = JSON.stringify({
    bindingId,
    reasoningLevel: request.reasoningLevel,
    requestedModel: {
      modelId: request.requestedModel.modelId,
      providerId: request.requestedModel.providerId,
    },
    serviceTier: request.serviceTier,
    version: "session-model-change-v1",
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.body.code : "transport_error";
}

function preDispatchRejection(
  error: unknown,
  requestedModel: SessionModelRef,
): MutationReceipt {
  return {
    acceptance: "not_accepted",
    diagnostic: `host unavailable before transport dispatch (${errorCode(error)})`,
    effectiveAccount: null,
    effectiveModel: null,
    observedCursor: null,
    providerRequestId: null,
    providerTurnId: null,
    requestedModel,
  };
}

function ambiguousTransportReceipt(
  error: unknown,
  requestedModel: SessionModelRef,
): MutationReceipt {
  return outcomeUnknownReceipt({
    diagnostic: `model-change outcome was not observed (${errorCode(error)})`,
    requestedModel,
  });
}

function normalizeDaemonReceipt(
  receipt: MutationReceipt,
  requestedModel: SessionModelRef,
  providerInstanceId: string,
): MutationReceipt {
  const requestedMatches =
    receipt.requestedModel?.providerId === requestedModel.providerId &&
    receipt.requestedModel.modelId === requestedModel.modelId;
  const effectiveProviderMatches =
    receipt.effectiveModel === null ||
    receipt.effectiveModel.providerId === requestedModel.providerId;
  const effectiveAccountMatches =
    receipt.effectiveAccount === null ||
    receipt.effectiveAccount.providerInstanceId === providerInstanceId;
  if (
    !requestedMatches ||
    !effectiveProviderMatches ||
    !effectiveAccountMatches
  ) {
    return outcomeUnknownReceipt({
      diagnostic:
        "daemon returned model-change evidence for a different provider identity",
      providerRequestId: receipt.providerRequestId ?? undefined,
      requestedModel,
    });
  }
  return receipt;
}

export async function changeSessionFabricModel(
  deps: AppDeps,
  bindingId: string,
  request: SessionFabricModelChangeRequest,
): Promise<SessionFabricModelChangeResponse> {
  const context = requireBindingContext(deps, bindingId);
  assertModelChangeAuthority(context, request.requestedModel);
  const providerInstanceId = context.nativeConversation.providerInstanceId;
  let command;
  try {
    command = draftSessionCommand(deps.db, {
      billingAuthorizationId: null,
      bindingId,
      kind: "change_model",
      payloadHash: modelChangePayloadHash(bindingId, request),
    });
  } catch (error) {
    if (error instanceof SessionFabricPersistenceError) {
      throwSessionFabricPersistenceApiError(error);
    }
    throw error;
  }
  applyCommandEvent(deps, command.id, "authorize");

  let receipt: MutationReceipt;
  let preflightError: unknown = null;
  try {
    await ensureHostSessionReadyForWork(deps, {
      hostId: context.nativeConversation.hostId,
    });
  } catch (error) {
    preflightError = error;
  }

  applyCommandEvent(deps, command.id, "dispatch");
  if (preflightError !== null) {
    receipt = preDispatchRejection(preflightError, request.requestedModel);
  } else {
    try {
      const daemonReceipt = await callHostOnlineRpc(deps, {
        command: {
          type: "session.model_change",
          billingAuthorization: null,
          billingRoute: null,
          bindingId,
          environmentId: context.environment.id,
          guard: command.guard,
          reasoningLevel: request.reasoningLevel,
          requestedModel: request.requestedModel,
          requiresBillingAuthorization: false,
          serviceTier: request.serviceTier,
          threadId: context.thread.id,
        },
        hostId: context.nativeConversation.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      receipt = normalizeDaemonReceipt(
        daemonReceipt,
        request.requestedModel,
        providerInstanceId,
      );
    } catch (error) {
      receipt = ambiguousTransportReceipt(error, request.requestedModel);
    }
  }

  try {
    const settled = settleSessionModelChange(deps.db, {
      billingRouteId: `current-provider-instance:${providerInstanceId}`,
      commandId: command.id,
      reasoningLevel: request.reasoningLevel,
      receipt,
      serviceTier: request.serviceTier,
    });
    return { ...settled, receipt };
  } catch (error) {
    if (error instanceof SessionFabricPersistenceError) {
      throwSessionFabricPersistenceApiError(error);
    }
    throw error;
  }
}

export function getSessionFabricCommandAudit(
  deps: Pick<AppDeps, "db">,
  commandId: string,
): SessionFabricCommandAuditResponse {
  const audit = getSessionCommandAudit(deps.db, commandId);
  if (!audit) {
    throw new ApiError(
      404,
      "command_not_found",
      `Session Fabric command not found: ${commandId}`,
    );
  }
  return audit;
}

function requireDiscoveryProjectPaths(
  deps: Pick<AppDeps, "db">,
  request: SessionFabricDiscoveryRequest,
): Map<string, string> {
  const projects = request.projectIds.map((projectId) =>
    getProject(deps.db, projectId),
  );
  const missingIndex = projects.findIndex(
    (project) => project === null || project.deletedAt !== null,
  );
  if (missingIndex >= 0) {
    throw new ApiError(
      404,
      "project_not_found",
      `Project not found: ${request.projectIds[missingIndex]}`,
    );
  }
  const sources = listProjectSourcesByProjectIds(
    deps.db,
    request.projectIds,
  ).filter((source) => source.hostId === request.hostId);
  const pathToProjectId = new Map<string, string>();
  for (const projectId of request.projectIds) {
    if (!sources.some((source) => source.projectId === projectId)) {
      throw new ApiError(
        409,
        "project_source_not_found_on_host",
        `Project ${projectId} has no source on host ${request.hostId}`,
        false,
      );
    }
  }
  for (const source of sources) {
    const existingProjectId = pathToProjectId.get(source.path);
    if (existingProjectId && existingProjectId !== source.projectId) {
      throw new ApiError(
        409,
        "ambiguous_project_source_path",
        `Host path ${source.path} belongs to multiple requested projects`,
        false,
      );
    }
    pathToProjectId.set(source.path, source.projectId);
  }
  return pathToProjectId;
}

async function discoverSessionFabricConversationsFromPaths(
  deps: AppDeps,
  request: SessionFabricDiscoveryRequest,
  pathToProjectId: Map<string, string>,
): Promise<SessionFabricDiscoveryResponse> {
  const result = await callHostRetryableOnlineRpc(deps, {
    command: {
      type: "session.discovery.scan",
      includeUnmapped: request.includeUnmapped,
      limitPerProvider: request.limitPerProvider,
      projectRootPaths: [...pathToProjectId.keys()],
      providerCursors: request.providerCursors,
    },
    hostId: request.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });

  const catalogEntries: SessionFabricDiscoveryCatalogEntry[] = [];
  for (const scan of result.scans) {
    for (const conversation of scan.conversations) {
      const nativeConversation = conversation.nativeConversation;
      if (
        nativeConversation.hostId !== request.hostId ||
        nativeConversation.providerId !== scan.providerId ||
        nativeConversation.providerInstanceId !== scan.providerInstanceId
      ) {
        throw new ApiError(
          502,
          "invalid_discovery_identity",
          "Host discovery returned a conversation outside its scan identity",
          false,
        );
      }
      const projectRootPath = conversation.project?.projectRootPath ?? null;
      const projectId =
        projectRootPath === null
          ? null
          : (pathToProjectId.get(projectRootPath) ?? null);
      if (projectRootPath !== null && projectId === null) {
        throw new ApiError(
          502,
          "invalid_discovery_project",
          "Host discovery returned an unrequested project association",
          false,
        );
      }
      const stored = upsertSessionNativeConversation(deps.db, {
        cwd: conversation.reportedCwd,
        hostId: nativeConversation.hostId,
        lastObservedAt: conversation.evidence.observedAt,
        nativeConversationId: nativeConversation.nativeConversationId,
        projectId,
        providerId: nativeConversation.providerId,
        providerInstanceId: nativeConversation.providerInstanceId,
        providerState: conversation.providerState,
        title: conversation.displayTitle,
      });
      catalogEntries.push({
        catalogConversationId: stored.id,
        nativeConversation,
        projectId: stored.projectId,
      });
    }
  }
  return { catalogEntries, scans: result.scans };
}

export async function discoverSessionFabricConversations(
  deps: AppDeps,
  request: SessionFabricDiscoveryRequest,
): Promise<SessionFabricDiscoveryResponse> {
  if (!getNonDestroyedHost(deps.db, request.hostId)) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  return discoverSessionFabricConversationsFromPaths(
    deps,
    request,
    requireDiscoveryProjectPaths(deps, request),
  );
}

function threadConnectionAdoptionRequest(
  threadId: string,
): SessionFabricAdoptionRequest {
  return {
    idempotencyKey: `session-fabric-connect:${threadId}`,
    objective: `Bind bb thread ${threadId} to its exact provider-native conversation.`,
    threadId,
    title: `bb thread ${threadId}`,
  };
}

function requireConnectedProjection(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): SessionFabricConnectionProjection {
  const connection = readSessionFabricThreadConnection(deps, threadId);
  if (!connection) {
    throw new ApiError(
      500,
      "session_connection_missing",
      `Session Fabric adoption completed without a connection for thread ${threadId}`,
      false,
    );
  }
  return connection;
}

export async function connectSessionFabricThread(
  deps: AppDeps,
  threadId: string,
): Promise<SessionFabricConnectResponse> {
  const thread = getThread(deps.db, threadId);
  if (!thread || thread.deletedAt !== null) {
    throw new ApiError(
      404,
      "thread_not_found",
      `Thread not found: ${threadId}`,
    );
  }
  const environment =
    thread.environmentId === null
      ? null
      : getEnvironment(deps.db, thread.environmentId);
  if (
    !environment ||
    environment.status === "destroyed" ||
    environment.path === null
  ) {
    throw new ApiError(
      409,
      "thread_environment_unavailable",
      "Connecting a provider conversation requires a live thread workspace",
      false,
    );
  }

  const adoptionRequest = threadConnectionAdoptionRequest(thread.id);
  const existingConnection = readSessionFabricThreadConnection(deps, thread.id);
  if (existingConnection) {
    if (
      existingConnection.adoptionStatus !== null &&
      existingConnection.adoptionStatus !== "enabled"
    ) {
      await adoptSessionFabricConversation(
        deps,
        existingConnection.nativeConversation.catalogConversationId,
        adoptionRequest,
      );
    }
    return { connection: requireConnectedProjection(deps, thread.id) };
  }

  const providerThreadId = getLastProviderThreadId(deps, thread.id);
  if (!providerThreadId) {
    throw new ApiError(
      409,
      "provider_conversation_unavailable",
      "This thread has not opened a provider-native conversation yet",
      false,
    );
  }

  const discoveryRequest: SessionFabricDiscoveryRequest = {
    hostId: environment.hostId,
    includeUnmapped: true,
    limitPerProvider: THREAD_CONNECTION_DISCOVERY_LIMIT,
    projectIds: [thread.projectId],
    providerCursors: [],
  };
  if (!getNonDestroyedHost(deps.db, discoveryRequest.hostId)) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  // A connection is scoped to the thread's authoritative execution binding,
  // not to every source registered for the project. Personal workspaces may
  // have no project source at all, while the environment still records the
  // exact host and path that own execution for this thread.
  const pathToProjectId = new Map([[environment.path, thread.projectId]]);
  const discovery = await discoverSessionFabricConversationsFromPaths(
    deps,
    discoveryRequest,
    pathToProjectId,
  );
  const exactWorkspaceConversations = discovery.scans.flatMap((scan) =>
    scan.conversations.filter(
      (conversation) =>
        conversation.project?.projectRootPath === environment.path &&
        conversation.nativeConversation.providerId === thread.providerId &&
        conversation.nativeConversation.nativeConversationId ===
          providerThreadId,
    ),
  );
  const matches = discovery.catalogEntries.filter(
    (entry) =>
      entry.projectId === thread.projectId &&
      entry.nativeConversation.providerId === thread.providerId &&
      entry.nativeConversation.nativeConversationId === providerThreadId &&
      exactWorkspaceConversations.some(
        (conversation) =>
          conversation.nativeConversation.hostId ===
            entry.nativeConversation.hostId &&
          conversation.nativeConversation.providerInstanceId ===
            entry.nativeConversation.providerInstanceId,
      ),
  );
  if (matches.length !== 1) {
    throw new ApiError(
      409,
      matches.length === 0
        ? "provider_conversation_not_discovered"
        : "provider_conversation_ambiguous",
      matches.length === 0
        ? "The exact live provider conversation for this thread was not discovered on its host"
        : "More than one provider instance reported this thread's native conversation",
      false,
    );
  }

  await adoptSessionFabricConversation(
    deps,
    matches[0]!.catalogConversationId,
    adoptionRequest,
  );
  return { connection: requireConnectedProjection(deps, thread.id) };
}
