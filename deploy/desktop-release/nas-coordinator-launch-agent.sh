#!/usr/bin/env bash

bb_mesh_launch_agent_script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bb_mesh_validate_runtime_data_directory() {
  local data_directory="$1"

  node "$bb_mesh_launch_agent_script_directory/verify-nas-runtime-data-directory.mjs" \
    "$data_directory"
}

bb_mesh_verify_coordinator_launch_agent() {
  local launch_agent_path="$1"
  local app_bundle="$2"
  local data_directory="$3"
  local server_port="$4"
  local host_daemon_port="$5"

  node \
    "$bb_mesh_launch_agent_script_directory/verify-nas-coordinator-launch-agent.mjs" \
    "$launch_agent_path" \
    "$app_bundle" \
    "$data_directory" \
    "$server_port" \
    "$host_daemon_port"
}

bb_mesh_find_coordinator_launch_agent() {
  local app_bundle="$1"
  local data_directory="$2"
  local server_port="$3"
  local host_daemon_port="$4"
  local launch_agent_directory="${HOME:?}/Library/LaunchAgents"
  local candidate_path
  local found_path=""

  if [[ ! -d "$launch_agent_directory" || -L "$launch_agent_directory" ]]; then
    echo "NAS coordinator LaunchAgent directory must be a real directory: $launch_agent_directory" >&2
    return 66
  fi

  for candidate_path in "$launch_agent_directory"/de.staufingers.bb-coordinator-*.plist; do
    if [[ ! -e "$candidate_path" && ! -L "$candidate_path" ]]; then
      continue
    fi
    if [[ ! -f "$candidate_path" || -L "$candidate_path" ]]; then
      echo "NAS coordinator LaunchAgent must be a regular file: $candidate_path" >&2
      return 66
    fi
    bb_mesh_verify_coordinator_launch_agent \
      "$candidate_path" \
      "$app_bundle" \
      "$data_directory" \
      "$server_port" \
      "$host_daemon_port" \
      >/dev/null || return
    if [[ -n "$found_path" ]]; then
      echo "Multiple trusted NAS coordinator LaunchAgents were found; refusing ambiguous lifecycle control." >&2
      return 65
    fi
    found_path="$candidate_path"
  done

  if [[ -z "$found_path" ]]; then
    echo "No trusted NAS coordinator LaunchAgent was found in $launch_agent_directory." >&2
    return 66
  fi
  printf '%s\n' "$found_path"
}

bb_mesh_coordinator_launch_agent_target() {
  local launch_agent_path="$1"
  local app_bundle="$2"
  local data_directory="$3"
  local server_port="$4"
  local host_daemon_port="$5"
  local label

  label="$(
    bb_mesh_verify_coordinator_launch_agent \
      "$launch_agent_path" \
      "$app_bundle" \
      "$data_directory" \
      "$server_port" \
      "$host_daemon_port"
  )" || return
  printf 'gui/%s/%s\n' "$(/usr/bin/id -u)" "$label"
}

bb_mesh_stop_coordinator_launch_agent() {
  local launch_agent_path="$1"
  local app_bundle="$2"
  local data_directory="$3"
  local server_port="$4"
  local host_daemon_port="$5"
  local launchctl_command="${BB_MESH_LAUNCHCTL_COMMAND:-/bin/launchctl}"
  local target
  local attempt

  target="$(
    bb_mesh_coordinator_launch_agent_target \
      "$launch_agent_path" \
      "$app_bundle" \
      "$data_directory" \
      "$server_port" \
      "$host_daemon_port"
  )" || return
  "$launchctl_command" disable "$target" || return
  if ! "$launchctl_command" print "$target" >/dev/null 2>&1; then
    return 0
  fi
  "$launchctl_command" bootout "$target" || return
  for ((attempt = 1; attempt <= 20; attempt += 1)); do
    if ! "$launchctl_command" print "$target" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "NAS coordinator LaunchAgent remained loaded after bootout: $target" >&2
  return 1
}

bb_mesh_start_coordinator_launch_agent() {
  local launch_agent_path="$1"
  local app_bundle="$2"
  local data_directory="$3"
  local server_port="$4"
  local host_daemon_port="$5"
  local launchctl_command="${BB_MESH_LAUNCHCTL_COMMAND:-/bin/launchctl}"
  local target
  local domain
  local attempt

  target="$(
    bb_mesh_coordinator_launch_agent_target \
      "$launch_agent_path" \
      "$app_bundle" \
      "$data_directory" \
      "$server_port" \
      "$host_daemon_port"
  )" || return
  domain="${target%/*}"
  if "$launchctl_command" print "$target" >/dev/null 2>&1; then
    echo "NAS coordinator LaunchAgent is already loaded: $target" >&2
    return 1
  fi
  "$launchctl_command" enable "$target" || return
  if ! "$launchctl_command" bootstrap "$domain" "$launch_agent_path"; then
    "$launchctl_command" disable "$target" >/dev/null 2>&1 || true
    return 1
  fi
  for ((attempt = 1; attempt <= 20; attempt += 1)); do
    if "$launchctl_command" print "$target" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  "$launchctl_command" disable "$target" >/dev/null 2>&1 || true
  echo "NAS coordinator LaunchAgent did not load after bootstrap: $target" >&2
  return 1
}
