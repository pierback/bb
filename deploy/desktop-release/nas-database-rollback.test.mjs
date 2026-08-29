import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const rollbackModulePath = fileURLToPath(
  new URL("./nas-database-rollback.sh", import.meta.url),
);

async function runBash(script, ...args) {
  return execFileAsync(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail; source "$1"; ${script}`,
      "test",
      rollbackModulePath,
      ...args,
    ],
    { maxBuffer: 1024 * 1024 },
  );
}

async function sqlite(databasePath, statement) {
  return execFileAsync("/usr/bin/sqlite3", [databasePath, statement]);
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("snapshots a live database and atomically restores its prior contents", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-rollback-"));
  const dataDirectory = join(fixtureRoot, ".bb");
  const backupDirectory = join(dataDirectory, "bb-mesh-release-backups");
  const databasePath = join(dataDirectory, "bb.db");
  const backupPath = join(backupDirectory, "before-candidate.sqlite3");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  try {
    await sqlite(
      databasePath,
      "CREATE TABLE durable_chat (value TEXT NOT NULL); INSERT INTO durable_chat VALUES ('before');",
    );
    await runBash(
      'bb_mesh_snapshot_database "$2" "$3"',
      databasePath,
      backupPath,
    );
    await sqlite(
      databasePath,
      "UPDATE durable_chat SET value = 'candidate'; CREATE TABLE candidate_only (value TEXT);",
    );
    await writeFile(`${databasePath}-wal`, "candidate wal", "utf8");
    await writeFile(`${databasePath}-shm`, "candidate shm", "utf8");

    await runBash(
      'bb_mesh_restore_database "$2" "$3"',
      databasePath,
      backupPath,
    );

    const { stdout: value } = await sqlite(
      databasePath,
      "SELECT value FROM durable_chat;",
    );
    const { stdout: candidateTableCount } = await sqlite(
      databasePath,
      "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'candidate_only';",
    );
    assert.equal(value.trim(), "before");
    assert.equal(candidateTableCount.trim(), "0");
    assert.equal(await pathExists(`${databasePath}-wal`), false);
    assert.equal(await pathExists(`${databasePath}-shm`), false);
    assert.equal(
      await pathExists(backupPath),
      false,
      "successful recovery atomically consumes the adjacent snapshot",
    );
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("rejects a corrupt recovery snapshot before touching the current database", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-corrupt-"));
  const dataDirectory = join(fixtureRoot, ".bb");
  const backupDirectory = join(dataDirectory, "bb-mesh-release-backups");
  const databasePath = join(dataDirectory, "bb.db");
  const backupPath = join(backupDirectory, "corrupt.sqlite3");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  try {
    await sqlite(
      databasePath,
      "CREATE TABLE durable_chat (value TEXT NOT NULL); INSERT INTO durable_chat VALUES ('candidate');",
    );
    await writeFile(backupPath, "not sqlite", { mode: 0o600 });

    await assert.rejects(
      runBash('bb_mesh_restore_database "$2" "$3"', databasePath, backupPath),
      (error) => {
        assert.equal(error.code, 74);
        assert.match(error.stderr, /snapshot failed its integrity check/u);
        return true;
      },
    );
    const { stdout } = await sqlite(
      databasePath,
      "SELECT value FROM durable_chat;",
    );
    assert.equal(stdout.trim(), "candidate");
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("fails closed when candidate SQLite sidecars cannot be removed", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-sidecars-"));
  const dataDirectory = join(fixtureRoot, ".bb");
  const backupDirectory = join(dataDirectory, "bb-mesh-release-backups");
  const databasePath = join(dataDirectory, "bb.db");
  const backupPath = join(backupDirectory, "before-candidate.sqlite3");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  try {
    await sqlite(
      databasePath,
      "CREATE TABLE durable_chat (value TEXT NOT NULL); INSERT INTO durable_chat VALUES ('before');",
    );
    await runBash(
      'bb_mesh_snapshot_database "$2" "$3"',
      databasePath,
      backupPath,
    );
    await sqlite(databasePath, "UPDATE durable_chat SET value = 'candidate';");
    await writeFile(`${databasePath}-wal`, "candidate wal", "utf8");
    await writeFile(`${databasePath}-shm`, "candidate shm", "utf8");

    const { stderr, stdout } = await runBash(
      [
        'failure_database="$2"',
        "rm() {",
        "  local candidate_path",
        '  for candidate_path in "$@"; do',
        '    if [[ "$candidate_path" == "$failure_database-wal" || "$candidate_path" == "$failure_database-shm" ]]; then',
        "      return 1",
        "    fi",
        "  done",
        '  /bin/rm "$@"',
        "}",
        'if ! bb_mesh_restore_database "$2" "$3"; then',
        "  printf 'restore-refused\\n'",
        "else",
        "  exit 99",
        "fi",
      ].join("\n"),
      databasePath,
      backupPath,
    );

    assert.equal(stdout, "restore-refused\n");
    assert.match(stderr, /refusing to replace the current database/u);
    assert.equal(await pathExists(`${databasePath}-wal`), true);
    assert.equal(await pathExists(`${databasePath}-shm`), true);
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    const { stdout: value } = await sqlite(
      databasePath,
      "SELECT value FROM durable_chat;",
    );
    assert.equal(value.trim(), "candidate");
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("an initially absent database rollback removes only the exact SQLite files", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-absent-"));
  const dataDirectory = join(fixtureRoot, ".bb");
  const databasePath = join(dataDirectory, "bb.db");
  const siblingPath = join(dataDirectory, "keep-me");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(databasePath, "candidate database", "utf8");
  await writeFile(`${databasePath}-wal`, "candidate wal", "utf8");
  await writeFile(`${databasePath}-shm`, "candidate shm", "utf8");
  await writeFile(siblingPath, "durable", "utf8");

  try {
    await runBash('bb_mesh_remove_candidate_database "$2"', databasePath);
    assert.equal(await pathExists(databasePath), false);
    assert.equal(await pathExists(`${databasePath}-wal`), false);
    assert.equal(await pathExists(`${databasePath}-shm`), false);
    assert.equal(await readFile(siblingPath, "utf8"), "durable");
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("snapshot creation refuses to overwrite an existing recovery artifact", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-existing-"));
  const dataDirectory = join(fixtureRoot, ".bb");
  const backupDirectory = join(dataDirectory, "bb-mesh-release-backups");
  const databasePath = join(dataDirectory, "bb.db");
  const backupPath = join(backupDirectory, "existing.sqlite3");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });

  try {
    await sqlite(databasePath, "CREATE TABLE durable_chat (value TEXT);");
    await writeFile(backupPath, "do not replace", "utf8");
    await chmod(backupPath, 0o600);

    await assert.rejects(
      runBash('bb_mesh_snapshot_database "$2" "$3"', databasePath, backupPath),
      (error) => {
        assert.equal(error.code, 73);
        assert.match(error.stderr, /refuses to overwrite/u);
        return true;
      },
    );
    assert.equal(await readFile(backupPath, "utf8"), "do not replace");
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("backup directory preparation rejects a symbolic-link destination", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-directory-"));
  const targetDirectory = join(fixtureRoot, "target");
  const backupDirectory = join(fixtureRoot, ".bb", "bb-mesh-release-backups");
  await mkdir(join(fixtureRoot, ".bb"), { recursive: true });
  await mkdir(targetDirectory);
  await symlink(targetDirectory, backupDirectory);

  try {
    await assert.rejects(
      runBash(
        'bb_mesh_prepare_database_backup_directory "$2"',
        backupDirectory,
      ),
      (error) => {
        assert.equal(error.code, 66);
        assert.match(error.stderr, /not a real directory/u);
        return true;
      },
    );
    assert.equal((await stat(targetDirectory)).mode & 0o777, 0o755);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("backup preparation rejects a symbolic-link data root", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-root-"));
  const targetDirectory = join(fixtureRoot, "actual-bb");
  const dataDirectory = join(fixtureRoot, ".bb");
  const backupDirectory = join(dataDirectory, "bb-mesh-release-backups");
  await mkdir(targetDirectory);
  await symlink(targetDirectory, dataDirectory);

  try {
    await assert.rejects(
      runBash(
        'bb_mesh_prepare_database_backup_directory "$2"',
        backupDirectory,
      ),
      (error) => {
        assert.equal(error.code, 66);
        assert.match(error.stderr, /database directory must be a real/u);
        return true;
      },
    );
    assert.equal(
      await pathExists(join(targetDirectory, "bb-mesh-release-backups")),
      false,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("recovery snapshot must be adjacent to the protected database", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-mesh-db-adjacent-"));
  const dataDirectory = join(fixtureRoot, ".bb");
  const otherDirectory = join(fixtureRoot, "other-backups");
  const databasePath = join(dataDirectory, "bb.db");
  const backupPath = join(otherDirectory, "before-candidate.sqlite3");
  await mkdir(dataDirectory);
  await mkdir(otherDirectory);

  try {
    await sqlite(databasePath, "CREATE TABLE durable_chat (value TEXT);");
    await assert.rejects(
      runBash('bb_mesh_snapshot_database "$2" "$3"', databasePath, backupPath),
      (error) => {
        assert.equal(error.code, 64);
        assert.match(error.stderr, /must live in/u);
        return true;
      },
    );
    assert.equal(await pathExists(backupPath), false);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
