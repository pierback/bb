import { z } from "zod";
import { workspaceGitOperationSchema } from "./git-checkout.js";

export const environmentSourceFreshnessStateValues = [
  "up_to_date",
  "ahead",
  "behind",
  "diverged",
] as const;

export const environmentSourceFreshnessStateSchema = z.enum(
  environmentSourceFreshnessStateValues,
);
export type EnvironmentSourceFreshnessState = z.infer<
  typeof environmentSourceFreshnessStateSchema
>;

const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);

/**
 * Host-observed relationship between an environment checkout and the branch
 * it was created from. Counts follow git's `source...HEAD` convention:
 * `behindCount` belongs only to source and `aheadCount` belongs only to HEAD.
 */
export const environmentSourceFreshnessSchema = z
  .object({
    sourceBranch: z.string().min(1),
    currentBranch: z.string().min(1),
    sourceSha: gitObjectIdSchema,
    headSha: gitObjectIdSchema,
    state: environmentSourceFreshnessStateSchema,
    aheadCount: z.number().int().nonnegative(),
    behindCount: z.number().int().nonnegative(),
    hasUncommittedChanges: z.boolean(),
    gitOperation: workspaceGitOperationSchema,
  })
  .strict();
export type EnvironmentSourceFreshness = z.infer<
  typeof environmentSourceFreshnessSchema
>;

export const environmentSourceUpdateModeSchema = z.enum([
  "automatic",
  "manual",
]);
export type EnvironmentSourceUpdateMode = z.infer<
  typeof environmentSourceUpdateModeSchema
>;

export const environmentSourceUpdateStrategySchema = z.enum([
  "none",
  "fast_forward",
  "rebase",
]);
export type EnvironmentSourceUpdateStrategy = z.infer<
  typeof environmentSourceUpdateStrategySchema
>;

export const environmentSourceUpdateResultSchema = z
  .object({
    updated: z.boolean(),
    strategy: environmentSourceUpdateStrategySchema,
    before: environmentSourceFreshnessSchema,
    after: environmentSourceFreshnessSchema,
  })
  .strict();
export type EnvironmentSourceUpdateResult = z.infer<
  typeof environmentSourceUpdateResultSchema
>;

export function resolveEnvironmentSourceFreshnessState(args: {
  aheadCount: number;
  behindCount: number;
}): EnvironmentSourceFreshnessState {
  if (args.aheadCount > 0 && args.behindCount > 0) {
    return "diverged";
  }
  if (args.behindCount > 0) {
    return "behind";
  }
  if (args.aheadCount > 0) {
    return "ahead";
  }
  return "up_to_date";
}
