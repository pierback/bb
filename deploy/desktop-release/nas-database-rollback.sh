#!/usr/bin/env bash

# SQLite persistence adapter for the NAS candidate cutover. The desktop
# installer owns orchestration; this module owns consistent snapshots and the
# exact-file compensation needed before an older coordinator is reopened.

bb_mesh_prepare_database_backup_directory() {
  local backup_directory="$1"
  local database_directory

  if [[ "$backup_directory" != /*/bb-mesh-release-backups || "$backup_directory" == "/bb-mesh-release-backups" ]]; then
    echo "BB Mesh database backup directory must be a specific absolute bb-mesh-release-backups directory." >&2
    return 64
  fi
  if ! database_directory="$(dirname -- "$backup_directory")"; then
    echo "BB Mesh database directory could not be resolved." >&2
    return 66
  fi
  if [[ ! -d "$database_directory" || -L "$database_directory" ]]; then
    echo "BB Mesh database directory must be a real existing directory: $database_directory" >&2
    return 66
  fi
  if [[ -L "$backup_directory" || ( -e "$backup_directory" && ! -d "$backup_directory" ) ]]; then
    echo "BB Mesh database backup path is not a real directory: $backup_directory" >&2
    return 66
  fi
  if ! mkdir -p -- "$backup_directory"; then
    echo "BB Mesh database backup directory could not be created: $backup_directory" >&2
    return 73
  fi
  if [[ ! -d "$backup_directory" || -L "$backup_directory" ]]; then
    echo "BB Mesh database backup directory could not be prepared safely: $backup_directory" >&2
    return 66
  fi
  if ! chmod 0700 "$backup_directory"; then
    echo "BB Mesh database backup directory permissions could not be secured: $backup_directory" >&2
    return 73
  fi
}

bb_mesh_validate_database_path() {
  local database_path="$1"
  local database_directory

  if [[ "$database_path" != /*/bb.db || "$database_path" == "/bb.db" ]]; then
    echo "BB Mesh database path must be a specific absolute bb.db file." >&2
    return 64
  fi
  if [[ "$database_path" == *$'\n'* || "$database_path" == *$'\r'* || "$database_path" == *"'"* ]]; then
    echo "BB Mesh database path contains unsupported characters." >&2
    return 64
  fi
  if ! database_directory="$(dirname -- "$database_path")"; then
    echo "BB Mesh database directory could not be resolved." >&2
    return 66
  fi
  if [[ ! -d "$database_directory" || -L "$database_directory" ]]; then
    echo "BB Mesh database directory must be a real existing directory: $database_directory" >&2
    return 66
  fi
}

bb_mesh_validate_database_backup_path() {
  local database_path="$1"
  local backup_path="$2"
  local backup_directory
  local database_directory
  local expected_backup_directory

  bb_mesh_validate_database_path "$database_path" || return
  if [[ "$backup_path" != /*.sqlite3 || "$backup_path" == "/.sqlite3" || "$backup_path" == "$database_path" ]]; then
    echo "BB Mesh database backup path must be a distinct absolute .sqlite3 file." >&2
    return 64
  fi
  if [[ "$backup_path" == *$'\n'* || "$backup_path" == *$'\r'* || "$backup_path" == *"'"* ]]; then
    echo "BB Mesh database backup path contains unsupported characters." >&2
    return 64
  fi

  if ! database_directory="$(dirname -- "$database_path")" ||
    ! backup_directory="$(dirname -- "$backup_path")"; then
    echo "BB Mesh database backup directory could not be resolved." >&2
    return 66
  fi
  expected_backup_directory="$database_directory/bb-mesh-release-backups"
  if [[ "$backup_directory" != "$expected_backup_directory" ]]; then
    echo "BB Mesh database recovery snapshot must live in $expected_backup_directory." >&2
    return 64
  fi
  if [[ ! -d "$backup_directory" || -L "$backup_directory" ]]; then
    echo "BB Mesh database backup directory must be a real existing directory: $backup_directory" >&2
    return 66
  fi
}

bb_mesh_database_quick_check() {
  local database_path="$1"
  local quick_check

  if ! quick_check="$(/usr/bin/sqlite3 -batch -noheader "$database_path" "PRAGMA quick_check;")"; then
    return 1
  fi
  [[ "$quick_check" == "ok" ]]
}

bb_mesh_snapshot_database() {
  local database_path="$1"
  local backup_path="$2"

  bb_mesh_validate_database_backup_path "$database_path" "$backup_path" || return
  if [[ ! -f "$database_path" || -L "$database_path" ]]; then
    echo "BB Mesh database snapshot source must be a regular file: $database_path" >&2
    return 66
  fi
  if [[ -e "$backup_path" || -L "$backup_path" ]]; then
    echo "BB Mesh database snapshot refuses to overwrite: $backup_path" >&2
    return 73
  fi

  if ! /usr/bin/sqlite3 "$database_path" ".backup '$backup_path'"; then
    rm -f -- "$backup_path" "$backup_path-wal" "$backup_path-shm" || true
    echo "Could not create the BB Mesh database snapshot: $backup_path" >&2
    return 74
  fi
  if ! chmod 0600 "$backup_path"; then
    rm -f -- "$backup_path" "$backup_path-wal" "$backup_path-shm" || true
    echo "Could not secure the BB Mesh database snapshot: $backup_path" >&2
    return 74
  fi
  if ! bb_mesh_database_quick_check "$backup_path"; then
    rm -f -- "$backup_path" "$backup_path-wal" "$backup_path-shm" || true
    echo "BB Mesh database snapshot failed its integrity check: $backup_path" >&2
    return 74
  fi
  if ! rm -f -- "$backup_path-wal" "$backup_path-shm"; then
    rm -f -- "$backup_path" || true
    echo "Could not finalize the BB Mesh database snapshot: $backup_path" >&2
    return 74
  fi
}

bb_mesh_restore_database() {
  local database_path="$1"
  local backup_path="$2"

  bb_mesh_validate_database_backup_path "$database_path" "$backup_path" || return
  if [[ ! -f "$backup_path" || -L "$backup_path" ]]; then
    echo "BB Mesh database recovery snapshot is unavailable: $backup_path" >&2
    return 66
  fi
  if [[ -L "$database_path" ]]; then
    echo "BB Mesh database recovery refuses to replace a symbolic link: $database_path" >&2
    return 66
  fi
  if ! bb_mesh_database_quick_check "$backup_path"; then
    echo "BB Mesh database recovery snapshot failed its integrity check: $backup_path" >&2
    return 74
  fi
  if ! rm -f -- "$backup_path-wal" "$backup_path-shm"; then
    echo "Could not prepare the BB Mesh database recovery snapshot." >&2
    return 74
  fi
  if ! chmod 0600 "$backup_path"; then
    echo "Could not secure the BB Mesh database recovery snapshot." >&2
    return 74
  fi

  # The candidate is already stopped. The snapshot lives beside bb.db on the
  # same filesystem, so consuming it with rename needs no second DB-sized
  # staging allocation and still atomically replaces the failed candidate.
  if ! rm -f -- "$database_path-wal" "$database_path-shm"; then
    echo "Could not remove the failed candidate's SQLite sidecars; refusing to replace the current database." >&2
    return 74
  fi
  if ! mv -f -- "$backup_path" "$database_path"; then
    echo "Could not atomically restore the BB Mesh database." >&2
    return 74
  fi
  if ! chmod 0600 "$database_path"; then
    echo "Could not secure the restored BB Mesh database; keep the coordinator stopped and inspect $database_path." >&2
    return 74
  fi
  if ! rm -f -- "$database_path-wal" "$database_path-shm"; then
    echo "Could not remove SQLite sidecars after recovery; keep the coordinator stopped and inspect $database_path." >&2
    return 74
  fi
  if ! bb_mesh_database_quick_check "$database_path"; then
    rm -f -- "$database_path-wal" "$database_path-shm" || true
    echo "Restored BB Mesh database failed its integrity check; keep the coordinator stopped and inspect $database_path." >&2
    return 74
  fi
  if ! rm -f -- "$database_path-wal" "$database_path-shm"; then
    echo "Could not finalize the restored BB Mesh database; keep the coordinator stopped and inspect $database_path." >&2
    return 74
  fi
}

bb_mesh_remove_candidate_database() {
  local database_path="$1"
  local candidate_path

  bb_mesh_validate_database_path "$database_path" || return
  for candidate_path in "$database_path" "$database_path-wal" "$database_path-shm"; do
    if [[ -d "$candidate_path" && ! -L "$candidate_path" ]]; then
      echo "BB Mesh database rollback refuses to remove a directory: $candidate_path" >&2
      return 66
    fi
  done
  if ! rm -f -- "$database_path" "$database_path-wal" "$database_path-shm"; then
    echo "Could not remove the failed candidate database files." >&2
    return 74
  fi
}
