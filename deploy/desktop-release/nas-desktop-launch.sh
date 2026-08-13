#!/usr/bin/env bash

# Launching a packaged Electron app from a self-hosted Actions runner must not
# leak Node-mode or runner lifecycle controls into the GUI process. In
# particular, ELECTRON_RUN_AS_NODE makes the Electron executable exit cleanly
# before app initialization, while RUNNER_TRACKING_ID lets job cleanup reap an
# otherwise healthy coordinator.

pierback_open_desktop_app() {
  local app_bundle="$1"

  if [[ "$app_bundle" != /*.app || "$app_bundle" == "/.app" ]]; then
    echo "Desktop application path must be a specific absolute .app bundle." >&2
    return 64
  fi

  /usr/bin/env \
    -u BB_DESKTOP_APP_URL \
    -u BB_DESKTOP_NODE_EXEC_PATH \
    -u ELECTRON_RUN_AS_NODE \
    -u RUNNER_TRACKING_ID \
    open "$app_bundle"
}
