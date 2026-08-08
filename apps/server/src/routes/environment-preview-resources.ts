import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import {
  createEnvironmentPreviewResource,
  deleteEnvironmentPreviewResource,
  listEnvironmentPreviewResources,
  selectEnvironmentPreviewResource,
} from "../services/environments/preview-resources.js";
import type { AppDeps } from "../types.js";

export function registerEnvironmentPreviewResourceRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { del, get, post, put } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.environments;

  get(routes.previewResources, (context) =>
    context.json(
      listEnvironmentPreviewResources(deps, context.req.param("id")),
    ),
  );
  post(routes.createPreviewResource, (context, payload) =>
    context.json(
      createEnvironmentPreviewResource(deps, context.req.param("id"), payload),
      201,
    ),
  );
  del(routes.deletePreviewResource, (context, payload) =>
    context.json(
      deleteEnvironmentPreviewResource(deps, {
        environmentId: context.req.param("id"),
        expectedRevision: payload.expectedRevision,
        resourceId: context.req.param("resourceId"),
      }),
    ),
  );
  put(routes.selectPreviewResource, (context, payload) =>
    context.json(
      selectEnvironmentPreviewResource(deps, {
        environmentId: context.req.param("id"),
        expectedRevision: payload.expectedRevision,
        selectedPreviewResourceId: payload.selectedPreviewResourceId,
      }),
    ),
  );
}
