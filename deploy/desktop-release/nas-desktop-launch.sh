#!/usr/bin/env bash

# Launch the packaged bb-app bridge directly through the signed Electron
# executable. The NAS is a headless coordinator appliance, not a desktop
# client: starting the GUI would select BB Mesh's private desktop runtime and
# ports instead of the coordinator data and ports being promoted here.

bb_mesh_validate_runtime_data_directory() {
  local data_directory="$1"
  local launch_script_directory

  launch_script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return
  node "$launch_script_directory/verify-nas-runtime-data-directory.mjs" \
    "$data_directory"
}

bb_mesh_start_coordinator_runtime() {
  local app_bundle="$1"
  local data_directory="$2"
  local server_port="$3"
  local host_daemon_port="$4"
  local bridge
  local executable
  local -a launch_environment

  if [[ "$app_bundle" != /*.app || "$app_bundle" == "/.app" ]]; then
    echo "Desktop application path must be a specific absolute .app bundle." >&2
    return 64
  fi
  if [[ ! -d "$app_bundle" || -L "$app_bundle" ]]; then
    echo "Desktop application must be a real app bundle: $app_bundle" >&2
    return 66
  fi
  bb_mesh_validate_runtime_data_directory "$data_directory" || return
  if [[ ! "$server_port" =~ ^[1-9][0-9]{0,4}$ ]] ||
    ((server_port > 65535)) ||
    [[ ! "$host_daemon_port" =~ ^[1-9][0-9]{0,4}$ ]] ||
    ((host_daemon_port > 65535)) ||
    [[ "$server_port" == "$host_daemon_port" ]]; then
    echo "NAS coordinator and host-daemon ports must be valid distinct ports." >&2
    return 64
  fi

  case "${app_bundle##*/}" in
    "BB Mesh.app")
      executable="$app_bundle/Contents/MacOS/BB Mesh"
      ;;
    "Pierback.app")
      # One-time hard-cutover rollback support. New releases never install or
      # launch this identity.
      executable="$app_bundle/Contents/MacOS/Pierback"
      ;;
    *)
      echo "Desktop application has an unsupported product identity: $app_bundle" >&2
      return 66
      ;;
  esac
  if [[ ! -x "$executable" || -L "$executable" ]]; then
    echo "Desktop application has no supported regular executable: $app_bundle" >&2
    return 66
  fi

  bridge="$app_bundle/Contents/Resources/app.asar.unpacked/dist/bb-app-bridge.mjs"
  if [[ ! -f "$bridge" || -L "$bridge" ]]; then
    echo "Desktop application has no trusted bb-app bridge: $app_bundle" >&2
    return 66
  fi

  # This function runs inside GitHub Actions during NAS promotion, but the app
  # survives the job. Start from an empty environment so CI/release variables
  # cannot alter future terminals, package managers, or provider processes.
  # Reintroduce only stable user-session inputs needed by a native macOS app;
  # bb's managed env and login-shell resolver provide all product/tool config.
  launch_environment=(
    "HOME=${HOME:?}"
    "USER=${USER:?}"
    "LOGNAME=${LOGNAME:-$USER}"
    "SHELL=${SHELL:-/bin/zsh}"
    "PATH=${HOME:?}/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    "TMPDIR=${TMPDIR:-/private/tmp}"
    "ELECTRON_RUN_AS_NODE=1"
  )
  if [[ -n "${LANG:-}" ]]; then
    launch_environment+=("LANG=$LANG")
  fi
  if [[ -n "${LC_ALL:-}" ]]; then
    launch_environment+=("LC_ALL=$LC_ALL")
  fi
  if [[ -n "${LC_CTYPE:-}" ]]; then
    launch_environment+=("LC_CTYPE=$LC_CTYPE")
  fi
  if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
    launch_environment+=("SSH_AUTH_SOCK=$SSH_AUTH_SOCK")
  fi

  (
    cd "${HOME:?}" || exit
    /usr/bin/env -i \
      "${launch_environment[@]}" \
      "$executable" \
      "$bridge" \
      --data-dir "$data_directory" \
      --server-bind-host 127.0.0.1 \
      --server-port "$server_port" \
      --host-daemon-port "$host_daemon_port" \
      start \
      </dev/null \
      >/dev/null \
      2>&1 &
  )
}
