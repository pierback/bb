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

  (
    cd "${HOME:?}" || exit
    /usr/bin/env \
      -u BB_CLI \
      -u BB_DATA_DIR \
      -u BB_DESKTOP_APP_URL \
      -u BB_DESKTOP_NODE_EXEC_PATH \
      -u ELECTRON_RUN_AS_NODE \
      -u RUNNER_TRACKING_ID \
      BB_DATA_DIR="$data_directory" \
      "$executable" \
      </dev/null \
      >/dev/null \
      2>&1 &
  )
}
