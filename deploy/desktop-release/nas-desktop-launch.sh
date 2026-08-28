#!/usr/bin/env bash

# Launch a packaged Electron executable directly so the caller's sanitized
# environment is authoritative. LaunchServices independently reapplies the
# user's launchctl environment, which can otherwise redirect or disable the
# candidate after this script has already protected a different database.

pierback_validate_runtime_data_directory() {
  local data_directory="$1"
  local launch_script_directory

  launch_script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return
  node "$launch_script_directory/verify-nas-runtime-data-directory.mjs" \
    "$data_directory"
}

pierback_open_desktop_app() {
  local app_bundle="$1"
  local data_directory="$2"
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
  pierback_validate_runtime_data_directory "$data_directory" || return

  if [[ -x "$app_bundle/Contents/MacOS/Pierback" && ! -L "$app_bundle/Contents/MacOS/Pierback" ]]; then
    executable="$app_bundle/Contents/MacOS/Pierback"
  elif [[ -x "$app_bundle/Contents/MacOS/bb" && ! -L "$app_bundle/Contents/MacOS/bb" ]]; then
    executable="$app_bundle/Contents/MacOS/bb"
  else
    echo "Desktop application has no supported regular executable: $app_bundle" >&2
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
    "BB_DATA_DIR=$data_directory"
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
      </dev/null \
      >/dev/null \
      2>&1 &
  )
}
