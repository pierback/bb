import { z } from "zod";

export const ENVIRONMENT_PREVIEW_RESOURCE_MAX_COUNT = 24;

export const environmentPreviewResourceKindValues = [
  "local_browser",
  "remote_novnc",
] as const;

export const environmentPreviewResourceKindSchema = z.enum(
  environmentPreviewResourceKindValues,
);
export type EnvironmentPreviewResourceKind = z.infer<
  typeof environmentPreviewResourceKindSchema
>;

export const environmentPreviewResourceUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "Preview resource URLs must use http or https",
      });
    }
    if (url.username.length > 0 || url.password.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Preview resource URLs cannot contain credentials",
      });
    }
  });

export const environmentPreviewResourceSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: environmentPreviewResourceKindSchema,
    label: z.string().trim().min(1).max(80),
    url: environmentPreviewResourceUrlSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type EnvironmentPreviewResource = z.infer<
  typeof environmentPreviewResourceSchema
>;

export const environmentPreviewResourcesStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    previewResources: z
      .array(environmentPreviewResourceSchema)
      .max(ENVIRONMENT_PREVIEW_RESOURCE_MAX_COUNT),
    selectedPreviewResourceId: z.string().min(1).max(100).nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    const ids = new Set<string>();
    for (const [index, resource] of state.previewResources.entries()) {
      if (ids.has(resource.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate preview resource id: ${resource.id}`,
          path: ["previewResources", index, "id"],
        });
      }
      ids.add(resource.id);
    }
    if (
      state.selectedPreviewResourceId !== null &&
      !ids.has(state.selectedPreviewResourceId)
    ) {
      context.addIssue({
        code: "custom",
        message: "The selected preview resource must exist",
        path: ["selectedPreviewResourceId"],
      });
    }
  });
export type EnvironmentPreviewResourcesState = z.infer<
  typeof environmentPreviewResourcesStateSchema
>;

export type EnvironmentPreviewResourceCommand =
  | { type: "add"; resource: EnvironmentPreviewResource }
  | { type: "remove"; resourceId: string }
  | { type: "select"; resourceId: string | null };

export type EnvironmentPreviewResourceTransitionErrorCode =
  | "duplicate_resource"
  | "resource_limit_reached"
  | "resource_not_found";

export class EnvironmentPreviewResourceTransitionError extends Error {
  readonly code: EnvironmentPreviewResourceTransitionErrorCode;

  constructor(
    code: EnvironmentPreviewResourceTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentPreviewResourceTransitionError";
    this.code = code;
  }
}

/**
 * Pure preview-selection state machine. Persistence and compare-and-swap live
 * in the application/database layers; this function owns cross-surface state
 * invariants so API, CLI, SDK, and app behavior cannot drift.
 */
export function transitionEnvironmentPreviewResources(
  current: EnvironmentPreviewResourcesState,
  command: EnvironmentPreviewResourceCommand,
): EnvironmentPreviewResourcesState {
  const state = environmentPreviewResourcesStateSchema.parse(current);
  switch (command.type) {
    case "add": {
      const resource = environmentPreviewResourceSchema.parse(command.resource);
      if (state.previewResources.some(({ id }) => id === resource.id)) {
        throw new EnvironmentPreviewResourceTransitionError(
          "duplicate_resource",
          `Preview resource already exists: ${resource.id}`,
        );
      }
      if (
        state.previewResources.length >= ENVIRONMENT_PREVIEW_RESOURCE_MAX_COUNT
      ) {
        throw new EnvironmentPreviewResourceTransitionError(
          "resource_limit_reached",
          `An environment can have at most ${ENVIRONMENT_PREVIEW_RESOURCE_MAX_COUNT} preview resources`,
        );
      }
      return environmentPreviewResourcesStateSchema.parse({
        ...state,
        revision: state.revision + 1,
        previewResources: [...state.previewResources, resource],
      });
    }
    case "remove": {
      if (!state.previewResources.some(({ id }) => id === command.resourceId)) {
        throw new EnvironmentPreviewResourceTransitionError(
          "resource_not_found",
          `Preview resource not found: ${command.resourceId}`,
        );
      }
      return environmentPreviewResourcesStateSchema.parse({
        revision: state.revision + 1,
        previewResources: state.previewResources.filter(
          ({ id }) => id !== command.resourceId,
        ),
        selectedPreviewResourceId:
          state.selectedPreviewResourceId === command.resourceId
            ? null
            : state.selectedPreviewResourceId,
      });
    }
    case "select": {
      if (
        command.resourceId !== null &&
        !state.previewResources.some(({ id }) => id === command.resourceId)
      ) {
        throw new EnvironmentPreviewResourceTransitionError(
          "resource_not_found",
          `Preview resource not found: ${command.resourceId}`,
        );
      }
      if (state.selectedPreviewResourceId === command.resourceId) return state;
      return environmentPreviewResourcesStateSchema.parse({
        ...state,
        revision: state.revision + 1,
        selectedPreviewResourceId: command.resourceId,
      });
    }
  }
}
