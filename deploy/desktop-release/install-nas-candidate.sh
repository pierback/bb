#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/release-bundle.sh"

usage() {
  echo "Usage: install-nas-candidate.sh <release-directory> [applications-directory] [loopback-origin]" >&2
}

if [[ "$#" -lt 1 || "$#" -gt 3 ]]; then
  usage
  exit 64
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The NAS candidate installer only runs on macOS." >&2
  exit 69
fi

release_directory="$1"
applications_directory="${2:-/Applications}"
loopback_origin="${3:-http://127.0.0.1:38886}"

if [[ "$applications_directory" != /* || "$applications_directory" == "/" ]]; then
  echo "Applications directory must be a specific absolute directory." >&2
  exit 64
fi
if [[ ! "$loopback_origin" =~ ^http://127\.0\.0\.1:[0-9]{2,5}$ ]]; then
  echo "Coordinator smoke origin must be an explicit IPv4 loopback HTTP origin." >&2
  exit 64
fi

pierback_release_validate_directory "$release_directory"
manifest_path="$release_directory/release-manifest.json"
desktop_version="$(node "$script_directory/release-manifest.mjs" "$manifest_path" desktopVersion)"
protocol_version="$(node "$script_directory/release-manifest.mjs" "$manifest_path" hostDaemonProtocolVersion)"
primary_zip="$(node "$script_directory/release-manifest.mjs" "$manifest_path" primaryZip)"
if [[ ! -f "$release_directory/$primary_zip" || -L "$release_directory/$primary_zip" ]]; then
  echo "Release manifest primary ZIP is missing: $primary_zip" >&2
  exit 66
fi

extract_directory="$(mktemp -d /private/tmp/pierback-nas-candidate.XXXXXX)"
candidate_destination="$applications_directory/.Pierback.candidate.$$"
destination="$applications_directory/Pierback.app"
legacy_destination="$applications_directory/bb.app"
backup_root="$applications_directory/Pierback Backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous_destination=""
legacy_backup=""
candidate_installed="false"
cutover_started="false"
cutover_complete="false"
rollback_in_progress="false"

cleanup() {
  local exit_code="$?"
  local rollback_exit_code=0
  trap - EXIT
  set +e
  if [[ "$exit_code" -ne 0 && "$cutover_started" == "true" && "$cutover_complete" != "true" ]]; then
    rollback
    rollback_exit_code="$?"
  fi
  if [[ -d "$extract_directory" ]]; then
    rm -rf -- "$extract_directory"
  fi
  if [[ -d "$candidate_destination" ]]; then
    rm -rf -- "$candidate_destination"
  fi
  if [[ "$rollback_exit_code" -ne 0 ]]; then
    echo "Automatic NAS rollback encountered an error; inspect $backup_root before retrying." >&2
  fi
  exit "$exit_code"
}
trap cleanup EXIT

wait_for_coordinator_to_stop() {
  local attempt
  for attempt in {1..30}; do
    if pgrep -f "$destination/Contents/MacOS/Pierback" >/dev/null 2>&1 ||
      pgrep -f "$legacy_destination/Contents/MacOS/bb" >/dev/null 2>&1; then
      sleep 1
      continue
    fi
    if ! curl --fail --silent --show-error --max-time 1 "$loopback_origin/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "The existing desktop process or coordinator did not stop within 30 seconds." >&2
  return 1
}

stop_desktop_apps() {
  osascript -e 'tell application id "de.staufingers.pierback.desktop" to quit' >/dev/null 2>&1 || true
  osascript -e 'tell application id "dev.bb.desktop" to quit' >/dev/null 2>&1 || true
  wait_for_coordinator_to_stop
}

wait_for_candidate() {
  local response
  local attempt
  for attempt in {1..90}; do
    if response="$(curl --fail --silent --show-error --max-time 2 "$loopback_origin/install/version" 2>/dev/null)"; then
      if printf '%s' "$response" | node "$script_directory/verify-coordinator-response.mjs" "$desktop_version" "$protocol_version"; then
        if pgrep -f "$destination/Contents/MacOS/Pierback" >/dev/null 2>&1; then
          return 0
        fi
      fi
    fi
    sleep 1
  done
  echo "Pierback did not expose the expected version and protocol within 90 seconds." >&2
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
  local failed_destination="$backup_root/Pierback-$desktop_version-failed-$timestamp-$$.app"
  if [[ "$rollback_in_progress" == "true" ]]; then
    return 0
  fi
  rollback_in_progress="true"
  echo "Pierback NAS smoke failed; rolling back the application swap." >&2
  osascript -e 'tell application id "de.staufingers.pierback.desktop" to quit' >/dev/null 2>&1 || true
  wait_for_coordinator_to_stop || true
  if [[ "$candidate_installed" == "true" && -d "$destination" ]]; then
    if ! mv -- "$destination" "$failed_destination"; then
      echo "Could not move the failed Pierback candidate to $failed_destination." >&2
      rollback_exit_code=1
    fi
  fi
  if [[ -n "$previous_destination" && -d "$previous_destination" ]]; then
    if [[ -e "$destination" ]] || ! mv -- "$previous_destination" "$destination"; then
      echo "Could not restore the previous Pierback app from $previous_destination." >&2
      rollback_exit_code=1
    fi
  fi
  if [[ -n "$legacy_backup" && -d "$legacy_backup" ]]; then
    if [[ -e "$legacy_destination" ]] || ! mv -- "$legacy_backup" "$legacy_destination"; then
      echo "Could not restore the previous bb app from $legacy_backup." >&2
      rollback_exit_code=1
    fi
  fi
  if [[ -d "$destination" ]]; then
    open "$destination" || rollback_exit_code=1
  elif [[ -d "$legacy_destination" ]]; then
    open "$legacy_destination" || rollback_exit_code=1
  fi
  return "$rollback_exit_code"
}

ditto -x -k "$release_directory/$primary_zip" "$extract_directory"
extracted_app="$extract_directory/Pierback.app"
if [[ ! -d "$extracted_app" || -L "$extracted_app" ]]; then
  echo "Candidate ZIP did not contain Pierback.app at its root." >&2
  exit 65
fi
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$extracted_app/Contents/Info.plist")"
if [[ "$bundle_id" != "de.staufingers.pierback.desktop" ]]; then
  echo "Candidate application bundle ID was $bundle_id, not Pierback." >&2
  exit 65
fi
codesign --verify --deep --strict --verbose=2 "$extracted_app"
spctl --assess --type execute --verbose=2 "$extracted_app"
xcrun stapler validate "$extracted_app"

mkdir -p "$applications_directory" "$backup_root"
ditto "$extracted_app" "$candidate_destination"
codesign --verify --deep --strict --verbose=2 "$candidate_destination"

stop_desktop_apps
cutover_started="true"
if [[ -d "$destination" ]]; then
  previous_destination="$backup_root/Pierback-before-$desktop_version-$timestamp.app"
  mv -- "$destination" "$previous_destination"
fi
if [[ -d "$legacy_destination" ]]; then
  legacy_backup="$backup_root/bb-before-pierback-$desktop_version-$timestamp.app"
  mv -- "$legacy_destination" "$legacy_backup"
fi
mv -- "$candidate_destination" "$destination"
candidate_installed="true"

if ! open "$destination" || ! wait_for_candidate || ! verify_candidate_bootstrap; then
  exit 1
fi
cutover_complete="true"

echo "Installed Pierback $desktop_version on the NAS; coordinator protocol $protocol_version and the machine bootstrap are healthy."
