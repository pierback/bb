import { describe, expect, it } from "vitest";
import {
  EnvironmentPreviewResourceTransitionError,
  environmentPreviewResourceUrlSchema,
  transitionEnvironmentPreviewResources,
  type EnvironmentPreviewResourcesState,
} from "../src/environment-preview-resource.js";

const emptyState: EnvironmentPreviewResourcesState = {
  previewResources: [],
  revision: 0,
  selectedPreviewResourceId: null,
};

const localResource = {
  createdAt: 10,
  id: "preview_local",
  kind: "local_browser" as const,
  label: "Local app",
  updatedAt: 10,
  url: "http://127.0.0.1:3000/dashboard",
};

describe("environment preview resources", () => {
  it("adds, selects, and removes a preview through one invariant-preserving state machine", () => {
    const added = transitionEnvironmentPreviewResources(emptyState, {
      resource: localResource,
      type: "add",
    });
    expect(added).toEqual({
      previewResources: [localResource],
      revision: 1,
      selectedPreviewResourceId: null,
    });

    const selected = transitionEnvironmentPreviewResources(added, {
      resourceId: localResource.id,
      type: "select",
    });
    expect(selected.revision).toBe(2);
    expect(selected.selectedPreviewResourceId).toBe(localResource.id);

    const removed = transitionEnvironmentPreviewResources(selected, {
      resourceId: localResource.id,
      type: "remove",
    });
    expect(removed).toEqual({
      previewResources: [],
      revision: 3,
      selectedPreviewResourceId: null,
    });
  });

  it("rejects selecting an unknown resource", () => {
    expect(() =>
      transitionEnvironmentPreviewResources(emptyState, {
        resourceId: "preview_missing",
        type: "select",
      }),
    ).toThrowError(
      expect.objectContaining<
        Partial<EnvironmentPreviewResourceTransitionError>
      >({ code: "resource_not_found" }),
    );
  });

  it("accepts only credential-free HTTP preview URLs", () => {
    expect(
      environmentPreviewResourceUrlSchema.safeParse("https://example.com"),
    ).toMatchObject({ success: true });
    expect(
      environmentPreviewResourceUrlSchema.safeParse("file:///tmp/app.html"),
    ).toMatchObject({ success: false });
    expect(
      environmentPreviewResourceUrlSchema.safeParse(
        "https://user:secret@example.com",
      ),
    ).toMatchObject({ success: false });
  });
});
