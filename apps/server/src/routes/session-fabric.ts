import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import {
  abortSessionFabricHandoff,
  activateSessionFabricHandoff,
  getSessionFabricHandoffAudit,
  prepareSessionFabricHandoff,
} from "../services/session-fabric/session-handoff-service.js";
import {
  adoptSessionFabricConversation,
  changeSessionFabricModel,
  connectSessionFabricThread,
  discoverSessionFabricConversations,
  getSessionFabricCommandAudit,
  getSessionFabricThreadConnection,
  listSessionFabricEnvironmentConnections,
} from "../services/session-fabric/session-fabric-service.js";
import type { AppDeps } from "../types.js";

export function registerSessionFabricRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.sessionFabric;

  post(routes.prepareHandoff, async (context, payload) =>
    context.json(
      await prepareSessionFabricHandoff(
        deps,
        context.req.param("sourceBindingId"),
        payload,
      ),
    ),
  );

  post(routes.activateHandoff, async (context, payload) =>
    context.json(
      await activateSessionFabricHandoff(
        deps,
        context.req.param("transitionId"),
        payload,
      ),
    ),
  );

  post(routes.abortHandoff, async (context) =>
    context.json(
      await abortSessionFabricHandoff(deps, context.req.param("transitionId")),
    ),
  );

  get(routes.getHandoffAudit, (context) =>
    context.json(
      getSessionFabricHandoffAudit(deps, context.req.param("transitionId")),
    ),
  );

  post(routes.adopt, async (context, payload) =>
    context.json(
      await adoptSessionFabricConversation(
        deps,
        context.req.param("catalogConversationId"),
        payload,
      ),
    ),
  );

  post(routes.changeModel, async (context, payload) =>
    context.json(
      await changeSessionFabricModel(
        deps,
        context.req.param("bindingId"),
        payload,
      ),
    ),
  );

  post(routes.discover, async (context, payload) =>
    context.json(await discoverSessionFabricConversations(deps, payload)),
  );

  post(routes.connectThread, async (context) =>
    context.json(
      await connectSessionFabricThread(deps, context.req.param("threadId")),
    ),
  );

  get(routes.getThreadConnection, (context) =>
    context.json(
      getSessionFabricThreadConnection(deps, context.req.param("threadId")),
    ),
  );

  get(routes.listEnvironmentConnections, (context) =>
    context.json(
      listSessionFabricEnvironmentConnections(
        deps,
        context.req.param("environmentId"),
      ),
    ),
  );

  get(routes.getCommandAudit, (context) =>
    context.json(
      getSessionFabricCommandAudit(deps, context.req.param("commandId")),
    ),
  );
}
