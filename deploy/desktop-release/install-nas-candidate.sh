#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/release-bundle.sh"
source "$script_directory/nas-database-rollback.sh"
source "$script_directory/nas-desktop-launch.sh"
source "$script_directory/nas-desktop-processes.sh"
source "$script_directory/nas-desktop-runtime.sh"

usage() {
  echo "Usage: install-nas-candidate.sh <release-directory> <promotion-state-path> [applications-directory] [loopback-origin]" >&2
}

if [[ "$#" -lt 2 || "$#" -gt 4 ]]; then
  usage
  exit 64
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The NAS candidate installer only runs on macOS." >&2
  exit 69
fi

release_directory="$1"
promotion_state_path="$2"
applications_directory="${3:-/Applications}"
loopback_origin="${4:-http://127.0.0.1:38886}"

if [[ "$applications_directory" != /* || "$applications_directory" == "/" ]]; then
  echo "Applications directory must be a specific absolute directory." >&2
  exit 64
fi
if [[ ! "$loopback_origin" =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}$ ]]; then
  echo "Coordinator smoke origin must be an explicit IPv4 loopback HTTP origin." >&2
  exit 64
fi
server_port="${loopback_origin##*:}"
if ((server_port > 65534)); then
  echo "Coordinator smoke port must leave room for the adjacent host-daemon port." >&2
  exit 64
fi
host_daemon_port="$((server_port + 1))"

bb_mesh_release_validate_directory "$release_directory"
manifest_path="$release_directory/release-manifest.json"
desktop_version="$(node "$script_directory/release-manifest.mjs" "$manifest_path" desktopVersion)"
protocol_version="$(node "$script_directory/release-manifest.mjs" "$manifest_path" hostDaemonProtocolVersion)"
primary_zip="$(node "$script_directory/release-manifest.mjs" "$manifest_path" primaryZip)"
source_commit="$(node "$script_directory/release-manifest.mjs" "$manifest_path" sourceCommit)"
release_tag="bb-mesh-desktop-v$desktop_version"
if [[ ! -f "$release_directory/$primary_zip" || -L "$release_directory/$primary_zip" ]]; then
  echo "Release manifest primary ZIP is missing: $primary_zip" >&2
  exit 66
fi

extract_directory=""
candidate_destination="$applications_directory/.BB-Mesh.candidate.$$"
destination="$applications_directory/BB Mesh.app"
previous_product_destination="$applications_directory/Pierback.app"
runtime_data_directory="${HOME%/}/.bb"
backup_root="$applications_directory/BB Mesh Backups"
database_path="$runtime_data_directory/bb.db"
database_backup_root="$runtime_data_directory/bb-mesh-release-backups"
destination_process_pattern="^$(printf '%s\n' "$destination/Contents/MacOS/BB Mesh" | sed 's/[][\\.^$*+?(){}|]/\\&/g')( |$)"
previous_product_process_pattern="^$(printf '%s\n' "$previous_product_destination/Contents/MacOS/Pierback" | sed 's/[][\\.^$*+?(){}|]/\\&/g')( |$)"
BB_MESH_DESKTOP_DESTINATION_PROCESS_PATTERN="$destination_process_pattern"
BB_MESH_DESKTOP_PREVIOUS_PRODUCT_PROCESS_PATTERN="$previous_product_process_pattern"
BB_MESH_DESKTOP_LOOPBACK_ORIGIN="$loopback_origin"
export BB_MESH_DESKTOP_DESTINATION_PROCESS_PATTERN
export BB_MESH_DESKTOP_PREVIOUS_PRODUCT_PROCESS_PATTERN
export BB_MESH_DESKTOP_LOOPBACK_ORIGIN
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous_destination=""
previous_product_backup=""
candidate_installed="false"
cutover_started="false"
cutover_complete="false"
rollback_in_progress="false"
database_existed_before_cutover="false"
database_snapshot_path=""
database_snapshot_ready="false"
database_recovery_required="false"

promotion_phase="$(
  node "$script_directory/promotion-state.mjs" initialize \
    "$promotion_state_path" \
    "$release_tag" \
    "$desktop_version" \
    "$source_commit"
)"
if [[ "$promotion_phase" != "nas-installing" ]]; then
  echo "NAS candidate installation requires the durable nas-installing phase, not $promotion_phase." >&2
  exit 65
fi

mark_promotion_rollback_complete() {
  node "$script_directory/promotion-state.mjs" rollback-complete \
    "$promotion_state_path" \
    "$release_tag" \
    "$desktop_version" \
    "$source_commit" \
    >/dev/null
}

mark_promotion_recovery_required() {
  node "$script_directory/promotion-state.mjs" recovery-required \
    "$promotion_state_path" \
    "$release_tag" \
    "$desktop_version" \
    "$source_commit" \
    >/dev/null
}

cleanup() {
  local exit_code="$?"
  local durable_phase=""
  local rollback_exit_code=0
  trap - EXIT
  set +e
  if [[ "$exit_code" -ne 0 && "$cutover_complete" != "true" ]]; then
    durable_phase="$(
      node "$script_directory/promotion-state.mjs" initialize \
        "$promotion_state_path" \
        "$release_tag" \
        "$desktop_version" \
        "$source_commit" \
        2>/dev/null
    )"
    if [[ "$durable_phase" == "nas-installed" ]]; then
      cutover_complete="true"
    fi
  fi
  if [[ "$exit_code" -ne 0 && "$cutover_started" == "true" && "$cutover_complete" != "true" ]]; then
    rollback
    rollback_exit_code="$?"
  fi
  if [[ "$exit_code" -ne 0 && "$cutover_complete" != "true" ]]; then
    if [[ "$rollback_exit_code" -eq 0 ]]; then
      if ! mark_promotion_rollback_complete; then
        echo "Could not record the completed NAS rollback; the durable installing phase will block an unsafe retry." >&2
        rollback_exit_code=1
      fi
    elif ! mark_promotion_recovery_required; then
      echo "Could not record the required NAS recovery; the durable installing phase will still block an unsafe retry." >&2
    fi
  fi
  if [[ -d "$extract_directory" ]]; then
    rm -rf -- "$extract_directory"
  fi
  if [[ -d "$candidate_destination" ]]; then
    rm -rf -- "$candidate_destination"
  fi
  if [[ "$rollback_exit_code" -ne 0 ]]; then
    echo "Automatic NAS rollback encountered an error. Manual recovery is required; keep the coordinator stopped and do not retry the promotion." >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT
extract_directory="$(mktemp -d /private/tmp/bb-mesh-nas-candidate.XXXXXX)"

bb_mesh_stop_desktop_runtimes() {
  local found_product="false"
  if [[ -d "$destination" ]]; then
    found_product="true"
    bb_mesh_stop_desktop_runtime "$destination" "$runtime_data_directory" || return
  fi
  if [[ -d "$previous_product_destination" ]]; then
    found_product="true"
    bb_mesh_stop_desktop_runtime "$previous_product_destination" "$runtime_data_directory" || return
  fi
  if [[ "$found_product" == "true" ]]; then
    return 0
  fi
  echo "No installed BB Mesh or previous Pierback bridge is available to stop the recorded runtime." >&2
  return 66
}

bb_mesh_desktop_runtime_is_recorded() {
  [[ -f "$runtime_data_directory/bb-app-runtime.json" ]]
}

stop_desktop_apps() {
  echo "Stopping installed BB Mesh and previous Pierback GUI generations before their identity-verified supervised runtime." >&2
  if bb_mesh_fence_desktop_cutover; then
    return 0
  fi

  if bb_mesh_desktop_processes_are_running; then
    echo "Installed BB Mesh or previous Pierback processes remained alive after targeted SIGKILL; refusing the cutover." >&2
  elif bb_mesh_desktop_coordinator_is_healthy; then
    echo "The coordinator port is still healthy but is not owned by an installed BB Mesh or previous Pierback process; refusing the cutover." >&2
  else
    echo "The installed desktop lifecycle fence failed before a durable quiet window; refusing the cutover." >&2
  fi
  return 1
}

wait_for_candidate() {
  local response
  local _
  for _ in {1..90}; do
    if response="$(curl --fail --silent --show-error --max-time 2 "$loopback_origin/install/version" 2>/dev/null)"; then
      if printf '%s' "$response" | node "$script_directory/verify-coordinator-response.mjs" "$desktop_version" "$protocol_version"; then
        if pgrep -f "$destination/Contents/MacOS/BB Mesh" >/dev/null 2>&1; then
          return 0
        fi
      fi
    fi
    sleep 1
  done
  echo "BB Mesh did not expose the expected version and protocol within 90 seconds." >&2
  return 1
}

verify_candidate_bootstrap() {
  local bootstrap_tarball="$extract_directory/coordinator-bb-app.tgz"
  curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --max-time 180 \
    "$loopback_origin/install/bb-app.tgz" \
    --output "$bootstrap_tarball"
  node "$script_directory/verify-bb-app-tarball.mjs" \
    "$bootstrap_tarball" \
    "$desktop_version"
}

rollback() {
  local rollback_exit_code=0
  local database_recovery_exit_code=0
  local failed_destination="$backup_root/BB Mesh-$desktop_version-failed-$timestamp-$$.app"
  if [[ "$rollback_in_progress" == "true" ]]; then
    return 0
  fi
  rollback_in_progress="true"
  echo "BB Mesh NAS smoke failed; rolling back the application swap." >&2
  if ! stop_desktop_apps; then
    echo "Could not fence the failed BB Mesh candidate. Refusing to move applications or restore the database while a coordinator may still be writing." >&2
    return 1
  fi
  if [[ "$candidate_installed" == "true" && -d "$destination" ]]; then
    if ! mv -- "$destination" "$failed_destination"; then
      echo "Could not move the failed BB Mesh candidate to $failed_destination." >&2
      rollback_exit_code=1
    fi
  fi
  if [[ -n "$previous_destination" && -d "$previous_destination" ]]; then
    if [[ -e "$destination" ]] || ! mv -- "$previous_destination" "$destination"; then
      echo "Could not restore the previous BB Mesh app from $previous_destination." >&2
      rollback_exit_code=1
    fi
  fi
  if [[ -n "$previous_product_backup" && -d "$previous_product_backup" ]]; then
    if [[ -e "$previous_product_destination" ]] || ! mv -- "$previous_product_backup" "$previous_product_destination"; then
      echo "Could not restore the previous Pierback app from $previous_product_backup." >&2
      rollback_exit_code=1
    fi
  fi
  if [[ "$database_recovery_required" == "true" ]]; then
    if [[ "$database_existed_before_cutover" == "true" ]]; then
      if [[ "$database_snapshot_ready" != "true" || -z "$database_snapshot_path" ]] ||
        ! bb_mesh_restore_database "$database_path" "$database_snapshot_path"; then
        echo "Could not verify restoration of the pre-cutover BB Mesh database. Keep the coordinator stopped and inspect $database_path plus any remaining snapshot at $database_snapshot_path." >&2
        database_recovery_exit_code=1
      fi
    elif ! bb_mesh_remove_candidate_database "$database_path"; then
      echo "Could not remove the database created by the failed BB Mesh candidate." >&2
      database_recovery_exit_code=1
    fi
  fi
  if [[ "$database_recovery_exit_code" -ne 0 ]]; then
    rollback_exit_code=1
  fi
  if [[ "$rollback_exit_code" -eq 0 && -d "$destination" ]]; then
    bb_mesh_start_coordinator_runtime \
      "$destination" \
      "$runtime_data_directory" \
      "$server_port" \
      "$host_daemon_port" || rollback_exit_code=1
  elif [[ "$rollback_exit_code" -eq 0 && -d "$previous_product_destination" ]]; then
    bb_mesh_start_coordinator_runtime \
      "$previous_product_destination" \
      "$runtime_data_directory" \
      "$server_port" \
      "$host_daemon_port" || rollback_exit_code=1
  elif [[ "$rollback_exit_code" -ne 0 ]]; then
    echo "BB Mesh rollback kept the previous coordinator closed because recovery was incomplete." >&2
  fi
  return "$rollback_exit_code"
}

ditto -x -k "$release_directory/$primary_zip" "$extract_directory"
extracted_app="$extract_directory/BB Mesh.app"
if [[ ! -d "$extracted_app" || -L "$extracted_app" ]]; then
  echo "Candidate ZIP did not contain BB Mesh.app at its root." >&2
  exit 65
fi
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$extracted_app/Contents/Info.plist")"
if [[ "$bundle_id" != "de.staufingers.bb-mesh.desktop" ]]; then
  echo "Candidate application bundle ID was $bundle_id, not BB Mesh." >&2
  exit 65
fi
codesign --verify --deep --strict --verbose=2 "$extracted_app"
spctl --assess --type execute --verbose=2 "$extracted_app"
xcrun stapler validate "$extracted_app"

mkdir -p "$applications_directory" "$backup_root"
ditto "$extracted_app" "$candidate_destination"
codesign --verify --deep --strict --verbose=2 "$candidate_destination"

bb_mesh_validate_runtime_data_directory "$runtime_data_directory"
stop_desktop_apps
cutover_started="true"
bb_mesh_prepare_database_backup_directory "$database_backup_root"
if [[ -e "$database_path" || -L "$database_path" ]]; then
  database_existed_before_cutover="true"
  database_snapshot_path="$database_backup_root/bb-before-$desktop_version-$timestamp-$$.sqlite3"
  bb_mesh_snapshot_database "$database_path" "$database_snapshot_path"
  database_snapshot_ready="true"
fi
database_recovery_required="true"
if [[ -d "$destination" ]]; then
  previous_destination="$backup_root/BB Mesh-before-$desktop_version-$timestamp.app"
  mv -- "$destination" "$previous_destination"
fi
if [[ -d "$previous_product_destination" ]]; then
  previous_product_backup="$backup_root/Pierback-before-BB-Mesh-$desktop_version-$timestamp.app"
  mv -- "$previous_product_destination" "$previous_product_backup"
fi
mv -- "$candidate_destination" "$destination"
candidate_installed="true"

if ! bb_mesh_start_coordinator_runtime \
  "$destination" \
  "$runtime_data_directory" \
  "$server_port" \
  "$host_daemon_port" ||
  ! wait_for_candidate ||
  ! verify_candidate_bootstrap; then
  exit 1
fi
node "$script_directory/promotion-state.mjs" advance \
  "$promotion_state_path" \
  "$release_tag" \
  "$desktop_version" \
  "$source_commit" \
  nas-installing \
  nas-installed \
  >/dev/null
cutover_complete="true"

echo "Installed BB Mesh $desktop_version on the NAS; coordinator protocol $protocol_version and the machine bootstrap are healthy."
if [[ "$database_snapshot_ready" == "true" ]]; then
  echo "Retained the pre-cutover database snapshot at $database_snapshot_path."
fi
