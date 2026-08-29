#!/usr/bin/env bash

# Process-control seam for the NAS desktop cutover. The installer supplies the
# two exact executable patterns and loopback origin; tests replace the three
# observation/signal adapters below to exercise generation races without
# touching real processes.

bb_mesh_desktop_processes_are_running() {
  pgrep -f "$BB_MESH_DESKTOP_DESTINATION_PROCESS_PATTERN" >/dev/null 2>&1 ||
    pgrep -f "$BB_MESH_DESKTOP_PREVIOUS_PRODUCT_PROCESS_PATTERN" >/dev/null 2>&1
}

bb_mesh_desktop_process_ids() {
  pgrep -f "$BB_MESH_DESKTOP_DESTINATION_PROCESS_PATTERN" 2>/dev/null || true
  pgrep -f "$BB_MESH_DESKTOP_PREVIOUS_PRODUCT_PROCESS_PATTERN" 2>/dev/null || true
}

bb_mesh_desktop_coordinator_is_healthy() {
  curl \
    --fail \
    --silent \
    --show-error \
    --max-time 1 \
    "$BB_MESH_DESKTOP_LOOPBACK_ORIGIN/health" \
    >/dev/null 2>&1
}

bb_mesh_signal_desktop_processes() {
  local signal_name="$1"
  local process_id
  while IFS= read -r process_id; do
    if [[ "$process_id" =~ ^[0-9]+$ ]]; then
      kill "-$signal_name" "$process_id" >/dev/null 2>&1 || true
    fi
  done < <(bb_mesh_desktop_process_ids)
}

bb_mesh_validate_desktop_quiescence_arguments() {
  local maximum_attempts="$1"
  local signal_name="${2:-}"
  local required_quiet_polls="${3:-3}"

  if [[ ! "$maximum_attempts" =~ ^[1-9][0-9]*$ ]]; then
    echo "Desktop quiescence attempts must be a positive integer." >&2
    return 64
  fi
  if [[ ! "$required_quiet_polls" =~ ^[1-9][0-9]*$ ]] ||
    ((required_quiet_polls > maximum_attempts)); then
    echo "Desktop quiescence quiet polls must fit inside the attempt budget." >&2
    return 64
  fi
  if [[ -n "$signal_name" && "$signal_name" != "TERM" && "$signal_name" != "KILL" ]]; then
    echo "Desktop quiescence accepts only TERM or KILL escalation." >&2
    return 64
  fi
}

bb_mesh_wait_for_desktop_process_quiescence() {
  local maximum_attempts="$1"
  local signal_name="${2:-}"
  local required_quiet_polls="${3:-3}"
  local attempt
  local quiet_polls=0

  bb_mesh_validate_desktop_quiescence_arguments \
    "$maximum_attempts" \
    "$signal_name" \
    "$required_quiet_polls" || return

  for ((attempt = 1; attempt <= maximum_attempts; attempt += 1)); do
    if bb_mesh_desktop_processes_are_running; then
      quiet_polls=0
      if [[ -n "$signal_name" ]]; then
        # Resolve PIDs again on every poll. A terminating GUI can still create
        # one final detached runtime generation before it exits.
        bb_mesh_signal_desktop_processes "$signal_name"
      fi
    else
      quiet_polls=$((quiet_polls + 1))
      if ((quiet_polls >= required_quiet_polls)); then
        return 0
      fi
    fi
    sleep 1
  done

  return 1
}

# The installer supplies these two runtime adapters. Keeping runtime-record
# inspection out of the process module lets the cutover policy be exercised
# without reading or signalling real host state.
bb_mesh_wait_for_desktop_cutover_quiescence() {
  local maximum_attempts="$1"
  local required_quiet_polls="${2:-3}"
  local attempt
  local quiet_polls=0

  bb_mesh_validate_desktop_quiescence_arguments \
    "$maximum_attempts" \
    TERM \
    "$required_quiet_polls" || return

  if ! declare -F bb_mesh_desktop_runtime_is_recorded >/dev/null 2>&1 ||
    ! declare -F bb_mesh_stop_desktop_runtimes >/dev/null 2>&1; then
    echo "Desktop runtime fence adapters are unavailable." >&2
    return 70
  fi

  for ((attempt = 1; attempt <= maximum_attempts; attempt += 1)); do
    if bb_mesh_desktop_processes_are_running; then
      quiet_polls=0
      bb_mesh_signal_desktop_processes TERM
    elif bb_mesh_desktop_runtime_is_recorded; then
      # A GUI can launch its detached runtime immediately before exiting. Its
      # identity record may therefore appear after the first stop attempt.
      quiet_polls=0
      bb_mesh_stop_desktop_runtimes || return
    elif bb_mesh_desktop_coordinator_is_healthy; then
      # No verified runtime record means the listener has an unknown owner.
      # Fail closed without signalling it.
      quiet_polls=0
    else
      quiet_polls=$((quiet_polls + 1))
      if ((quiet_polls >= required_quiet_polls)); then
        return 0
      fi
    fi
    sleep 1
  done

  return 1
}

# Fence the desktop generation in lifecycle order: first make every installed
# GUI generation durably absent, then stop the identity-verified detached
# runtime it may have created, then require both the GUI paths and coordinator
# port to remain quiet. The final phase keeps watching for a delayed verified
# runtime record instead of relying on a one-time snapshot.
bb_mesh_fence_desktop_cutover() {
  if ! bb_mesh_wait_for_desktop_process_quiescence 30 TERM 5; then
    bb_mesh_wait_for_desktop_process_quiescence 15 KILL 5 || return
  fi

  bb_mesh_wait_for_desktop_cutover_quiescence 30 5
}
