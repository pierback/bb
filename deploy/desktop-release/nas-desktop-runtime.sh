#!/usr/bin/env bash

# Stop a packaged desktop's supervised bb runtime through bb-app's own
# identity-verified runtime record. The launcher and its managed children can
# change their process titles, so executable-path matching alone cannot fence
# every generation safely.

bb_mesh_stop_desktop_runtime() {
  local app_bundle="$1"
  local data_directory="$2"
  local bridge
  local executable

  if [[ "$app_bundle" != /*.app || "$app_bundle" == "/.app" ]]; then
    echo "Desktop application path must be a specific absolute .app bundle." >&2
    return 64
  fi
  if [[ "$data_directory" != /* || "$data_directory" == "/" ]]; then
    echo "Desktop runtime data directory must be a specific absolute directory." >&2
    return 64
  fi
  if [[ ! -e "$app_bundle" ]]; then
    return 0
  fi
  if [[ ! -d "$app_bundle" || -L "$app_bundle" ]]; then
    echo "Desktop application is not a regular app bundle: $app_bundle" >&2
    return 66
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

  /usr/bin/env \
    -u BB_CLI \
    -u BB_DATA_DIR \
    -u BB_DESKTOP_APP_URL \
    -u BB_DESKTOP_NODE_EXEC_PATH \
    -u ELECTRON_RUN_AS_NODE \
    -u RUNNER_TRACKING_ID \
    ELECTRON_RUN_AS_NODE=1 \
    "$executable" \
    "$bridge" \
    --data-dir "$data_directory" \
    stop
}
