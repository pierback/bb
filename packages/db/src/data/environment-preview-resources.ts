import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { environmentPreviewResources } from "../schema.js";

export interface StoredEnvironmentPreviewResources {
  previewResourcesJson: string;
  revision: number;
  selectedPreviewResourceId: string | null;
}

export type ReplaceEnvironmentPreviewResourcesResult =
  | { outcome: "updated"; revision: number }
  | { outcome: "conflict"; revision: number };

export function getStoredEnvironmentPreviewResources(
  db: DbConnection,
  environmentId: string,
): StoredEnvironmentPreviewResources | null {
  return (
    db
      .select({
        previewResourcesJson:
          environmentPreviewResources.previewResourcesJson,
        revision: environmentPreviewResources.revision,
        selectedPreviewResourceId:
          environmentPreviewResources.selectedPreviewResourceId,
      })
      .from(environmentPreviewResources)
      .where(eq(environmentPreviewResources.environmentId, environmentId))
      .get() ?? null
  );
}

/** Atomically replaces the aggregate only when the caller observed its head. */
export function replaceStoredEnvironmentPreviewResources(
  db: DbConnection,
  args: {
    environmentId: string;
    expectedRevision: number;
    previewResourcesJson: string;
    selectedPreviewResourceId: string | null;
  },
): ReplaceEnvironmentPreviewResourcesResult {
  return db.transaction((tx) => {
    const current = tx
      .select({ revision: environmentPreviewResources.revision })
      .from(environmentPreviewResources)
      .where(eq(environmentPreviewResources.environmentId, args.environmentId))
      .get();
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      return { outcome: "conflict", revision: currentRevision };
    }

    const revision = currentRevision + 1;
    const updatedAt = Date.now();
    tx.insert(environmentPreviewResources)
      .values({
        environmentId: args.environmentId,
        previewResourcesJson: args.previewResourcesJson,
        revision,
        selectedPreviewResourceId: args.selectedPreviewResourceId,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: environmentPreviewResources.environmentId,
        set: {
          previewResourcesJson: args.previewResourcesJson,
          revision,
          selectedPreviewResourceId: args.selectedPreviewResourceId,
          updatedAt,
        },
      })
      .run();
    return { outcome: "updated", revision };
  });
}
