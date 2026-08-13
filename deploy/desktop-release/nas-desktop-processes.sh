#!/usr/bin/env bash

# Process-control seam for the NAS desktop cutover. The installer supplies the
# two exact executable patterns and loopback origin; tests replace the three
# observation/signal adapters below to exercise generation races without
# touching real processes.

pierback_desktop_processes_are_running() {
  pgrep -f "$PIERBACK_DESKTOP_DESTINATION_PROCESS_PATTERN" >/dev/null 2>&1 ||
    pgrep -f "$PIERBACK_DESKTOP_LEGACY_PROCESS_PATTERN" >/dev/null 2>&1
}

pierback_desktop_process_ids() {
  pgrep -f "$PIERBACK_DESKTOP_DESTINATION_PROCESS_PATTERN" 2>/dev/null || true
  pgrep -f "$PIERBACK_DESKTOP_LEGACY_PROCESS_PATTERN" 2>/dev/null || true
}

pierback_desktop_coordinator_is_healthy() {
  curl \
    --fail \
    --silent \
    --show-error \
    --max-time 1 \
    "$PIERBACK_DESKTOP_LOOPBACK_ORIGIN/health" \
    >/dev/null 2>&1
}

pierback_signal_desktop_processes() {
  local signal_name="$1"
  local process_id
  while IFS= read -r process_id; do
    if [[ "$process_id" =~ ^[0-9]+$ ]]; then
      kill "-$signal_name" "$process_id" >/dev/null 2>&1 || true
    fi
  done < <(pierback_desktop_process_ids)
}

pierback_validate_desktop_quiescence_arguments() {
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

pierback_wait_for_desktop_process_quiescence() {
  local maximum_attempts="$1"
  local signal_name="${2:-}"
  local required_quiet_polls="${3:-3}"
  local attempt
  local quiet_polls=0

  pierback_validate_desktop_quiescence_arguments \
    "$maximum_attempts" \
    "$signal_name" \
    "$required_quiet_polls" || return

  for ((attempt = 1; attempt <= maximum_attempts; attempt += 1)); do
    if pierback_desktop_processes_are_running; then
      quiet_polls=0
      if [[ -n "$signal_name" ]]; then
        # Resolve PIDs again on every poll. A terminating GUI can still create
        # one final detached runtime generation before it exits.
        pierback_signal_desktop_processes "$signal_name"
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

pierback_wait_for_desktop_quiescence() {
  local maximum_attempts="$1"
  local signal_name="${2:-}"
  local required_quiet_polls="${3:-3}"
  local attempt
  local quiet_polls=0

  pierback_validate_desktop_quiescence_arguments \
    "$maximum_attempts" \
    "$signal_name" \
    "$required_quiet_polls" || return

  for ((attempt = 1; attempt <= maximum_attempts; attempt += 1)); do
    if pierback_desktop_processes_are_running; then
      quiet_polls=0
      if [[ -n "$signal_name" ]]; then
        # Resolve PIDs again on every poll. The desktop can exit while its
        # detached bridge starts, so a one-time PID snapshot is not sufficient.
        pierback_signal_desktop_processes "$signal_name"
      fi
    elif pierback_desktop_coordinator_is_healthy; then
      # A healthy port without a matching process belongs to an unknown owner.
      # Never signal it and never treat it as safe for an application swap.
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
# port to remain quiet. The installer supplies pierback_stop_desktop_runtimes as
# the runtime adapter so this process seam remains independently testable.
pierback_fence_desktop_cutover() {
  if ! pierback_wait_for_desktop_process_quiescence 30 TERM 5; then
    pierback_wait_for_desktop_process_quiescence 15 KILL 5 || return
  fi

  if ! declare -F pierback_stop_desktop_runtimes >/dev/null 2>&1; then
    echo "Desktop runtime stop adapter is unavailable." >&2
    return 70
  fi
  pierback_stop_desktop_runtimes || return

  pierback_wait_for_desktop_quiescence 15 "" 5
}
