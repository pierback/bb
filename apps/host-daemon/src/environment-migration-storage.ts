import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ENVIRONMENT_MIGRATION_DIRECTORY = "environment-migrations-v2";

const LEGACY_ENVIRONMENT_MIGRATION_DIRECTORY = "environment-migrations";
const OBSOLETE_ENVIRONMENT_MIGRATION_DIRECTORY_PREFIX =
  "environment-migrations-obsolete-v1-";

export function environmentMigrationSourceFenceDirectory(
  dataDir: string,
): string {
  return path.join(dataDir, ENVIRONMENT_MIGRATION_DIRECTORY, "source-fences");
}

/**
 * Hard-cut the pre-v2 durable format without deleting user data. Moving the
 * entire legacy tree out of the active namespace makes retries start cleanly,
 * while retaining receipts and artifacts for inspection or manual recovery.
 */
export async function quarantineLegacyEnvironmentMigrationStages(
  dataDir: string,
): Promise<string | null> {
  const legacyRoot = path.join(dataDir, LEGACY_ENVIRONMENT_MIGRATION_DIRECTORY);
  try {
    await fs.access(legacyRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const quarantinePath = path.join(
    dataDir,
    `${OBSOLETE_ENVIRONMENT_MIGRATION_DIRECTORY_PREFIX}${randomUUID()}`,
  );
  await fs.rename(legacyRoot, quarantinePath);
  return quarantinePath;
}
