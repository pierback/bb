import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import {
  getStoredEnvironmentPreviewResources,
  replaceStoredEnvironmentPreviewResources,
} from "../../src/data/environment-preview-resources.js";
import { createEnvironment } from "../../src/data/environments.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "preview-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "preview-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/preview" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    hostId: host.id,
    isGitRepo: true,
    isWorktree: true,
    managed: true,
    path: "/tmp/preview-worktree",
    projectId: project.id,
    status: "ready",
    workspaceProvisionType: "managed-worktree",
  });
  return { db, environment };
}

describe("environment preview resources", () => {
  it("stores resource list and selection with compare-and-swap revisions", () => {
    const { db, environment } = setup();
    expect(
      getStoredEnvironmentPreviewResources(db, environment.id),
    ).toBeNull();

    expect(
      replaceStoredEnvironmentPreviewResources(db, {
        environmentId: environment.id,
        expectedRevision: 0,
        previewResourcesJson: '[{"id":"epr_one"}]',
        selectedPreviewResourceId: "epr_one",
      }),
    ).toEqual({ outcome: "updated", revision: 1 });
    expect(getStoredEnvironmentPreviewResources(db, environment.id)).toEqual({
      previewResourcesJson: '[{"id":"epr_one"}]',
      revision: 1,
      selectedPreviewResourceId: "epr_one",
    });

    expect(
      replaceStoredEnvironmentPreviewResources(db, {
        environmentId: environment.id,
        expectedRevision: 0,
        previewResourcesJson: "[]",
        selectedPreviewResourceId: null,
      }),
    ).toEqual({ outcome: "conflict", revision: 1 });
  });
});
