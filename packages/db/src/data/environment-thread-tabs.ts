import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { environmentThreadTabs, threads } from "../schema.js";

export interface StoredEnvironmentThreadTabs {
  revision: number;
  threadIdsJson: string;
}

export type ReplaceEnvironmentThreadTabsResult =
  | { outcome: "updated"; revision: number }
  | { outcome: "conflict"; revision: number };

export function getStoredEnvironmentThreadTabs(
  db: DbConnection,
  environmentId: string,
): StoredEnvironmentThreadTabs | null {
  return (
    db
      .select({
        revision: environmentThreadTabs.revision,
        threadIdsJson: environmentThreadTabs.threadIdsJson,
      })
      .from(environmentThreadTabs)
      .where(eq(environmentThreadTabs.environmentId, environmentId))
      .get() ?? null
  );
}

/**
 * Returns the requested ids that still identify visible, non-deleted threads
 * owned by this environment. One targeted query lets the server validate a
 * whole ordered tab set without per-thread lookups.
 */
export function listEnvironmentThreadTabEligibleIds(
  db: DbConnection,
  args: { environmentId: string; threadIds: readonly string[] },
): string[] {
  if (args.threadIds.length === 0) return [];
  return db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        inArray(threads.id, [...args.threadIds]),
        eq(threads.environmentId, args.environmentId),
        eq(threads.visibility, "visible"),
        isNull(threads.deletedAt),
      ),
    )
    .all()
    .map((row) => row.id);
}

export function replaceStoredEnvironmentThreadTabs(
  db: DbConnection,
  args: {
    environmentId: string;
    expectedRevision: number;
    threadIdsJson: string;
  },
): ReplaceEnvironmentThreadTabsResult {
  return db.transaction((tx) => {
    const current = tx
      .select({ revision: environmentThreadTabs.revision })
      .from(environmentThreadTabs)
      .where(eq(environmentThreadTabs.environmentId, args.environmentId))
      .get();
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== args.expectedRevision) {
      return { outcome: "conflict", revision: currentRevision };
    }

    const revision = currentRevision + 1;
    const updatedAt = Date.now();
    tx.insert(environmentThreadTabs)
      .values({
        environmentId: args.environmentId,
        revision,
        threadIdsJson: args.threadIdsJson,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: environmentThreadTabs.environmentId,
        set: {
          revision,
          threadIdsJson: args.threadIdsJson,
          updatedAt,
        },
      })
      .run();
    return { outcome: "updated", revision };
  });
}

