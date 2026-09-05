#!/bin/bash

set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
umask 077

readonly DEPLOY_USER="pierback-updates"
readonly STAGING_ROOT="/srv/bb-pwa/.incoming"
readonly ACTIVATION_CORE="/usr/local/libexec/bb-mesh/activate-gateway-config.sh"
readonly CANDIDATE_READER="/usr/local/libexec/bb-mesh/read-gateway-candidate.py"
readonly TARGET_CONFIG="/etc/caddy/Caddyfile"
readonly CADDY_BIN="/usr/local/bin/caddy"
readonly PYTHON3_BIN="/usr/bin/python3"
readonly SYSTEMCTL_BIN="/usr/bin/systemctl"
readonly SERVICE_NAME="caddy.service"
readonly CADDY_SERVICE_USER="caddy"

usage() {
  echo "Usage: bb-mesh-activate-gateway <staged-config> <sha256>" >&2
}

if [[ "$#" -ne 2 ]]; then
  usage
  exit 64
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "bb-mesh-activate-gateway must run as root." >&2
  exit 77
fi

readonly staged_config="$1"
readonly expected_sha256="$2"
readonly staging_pattern='^/srv/bb-pwa/\.incoming/gateway-config-[0-9]+-[0-9]+/Caddyfile$'

if [[ ! "$staged_config" =~ $staging_pattern ]]; then
  echo "Gateway candidate is outside the permitted staging path." >&2
  exit 64
fi
if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid gateway candidate checksum." >&2
  exit 64
fi
if ! /usr/bin/id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "Missing gateway deployment account: $DEPLOY_USER" >&2
  exit 67
fi
deploy_uid="$(/usr/bin/id -u "$DEPLOY_USER")"
readonly deploy_uid
deploy_gid="$(/usr/bin/id -g "$DEPLOY_USER")"
readonly deploy_gid
if ! /usr/bin/id -u "$CADDY_SERVICE_USER" >/dev/null 2>&1; then
  echo "Missing Caddy service account: $CADDY_SERVICE_USER" >&2
  exit 67
fi
caddy_gid="$(/usr/bin/id -g "$CADDY_SERVICE_USER")"
readonly caddy_gid
if [[ ! -d "$STAGING_ROOT" || -L "$STAGING_ROOT" ]]; then
  echo "Gateway staging root must be a regular directory." >&2
  exit 66
fi
if [[ "$(/usr/bin/realpath -e -- "$STAGING_ROOT")" != "$STAGING_ROOT" ]]; then
  echo "Gateway staging root must not traverse symbolic links." >&2
  exit 66
fi

readonly staging_directory="${staged_config%/*}"
if [[ ! -d "$staging_directory" || -L "$staging_directory" ]]; then
  echo "Gateway staging directory must be a regular directory." >&2
  exit 66
fi
if [[ "$(/usr/bin/realpath -e -- "$staging_directory")" != "$staging_directory" ]]; then
  echo "Gateway staging directory must not traverse symbolic links." >&2
  exit 66
fi
if [[ "$(/usr/bin/stat -c '%u:%g:%a' -- "$staging_directory")" != "$deploy_uid:$deploy_gid:700" ]]; then
  echo "Gateway staging directory has unsafe ownership or permissions." >&2
  exit 77
fi
if [[ ! -f "$staged_config" || -L "$staged_config" ]]; then
  echo "Gateway candidate must be a regular file." >&2
  exit 66
fi
if [[ "$(/usr/bin/realpath -e -- "$staged_config")" != "$staged_config" ]]; then
  echo "Gateway candidate must not traverse symbolic links." >&2
  exit 66
fi
if [[ "$(/usr/bin/stat -c '%u:%g:%a' -- "$staged_config")" != "$deploy_uid:$deploy_gid:600" ]]; then
  echo "Gateway candidate has unsafe ownership or permissions." >&2
  exit 77
fi
if [[ ! -f "$ACTIVATION_CORE" || -L "$ACTIVATION_CORE" || ! -x "$ACTIVATION_CORE" ]]; then
  echo "Missing trusted gateway activation core." >&2
  exit 66
fi
if [[ "$(/usr/bin/stat -c '%U:%G:%a' -- "$ACTIVATION_CORE")" != "root:root:755" ]]; then
  echo "Gateway activation core has unsafe ownership or permissions." >&2
  exit 77
fi
if [[ ! -f "$CANDIDATE_READER" || -L "$CANDIDATE_READER" ]]; then
  echo "Missing trusted gateway candidate reader." >&2
  exit 66
fi
if [[ "$(/usr/bin/stat -c '%U:%G:%a' -- "$CANDIDATE_READER")" != "root:root:644" ]]; then
  echo "Gateway candidate reader has unsafe ownership or permissions." >&2
  exit 77
fi
if [[ ! -f "$PYTHON3_BIN" || ! -x "$PYTHON3_BIN" ]]; then
  echo "Missing trusted Python interpreter." >&2
  exit 66
fi
python3_resolved="$(/usr/bin/realpath -e -- "$PYTHON3_BIN")"
readonly python3_resolved
if [[ ! "$python3_resolved" =~ ^/usr/bin/python3([.][0-9]+)*$ ]]; then
  echo "Python interpreter resolves outside the trusted system path." >&2
  exit 77
fi
python3_mode="$(/usr/bin/stat -c '%a' -- "$python3_resolved")"
readonly python3_mode
if [[ "$(/usr/bin/stat -c '%U:%G' -- "$python3_resolved")" != "root:root" ]] || \
  (( (8#$python3_mode & 0022) != 0 )); then
  echo "Python interpreter has unsafe ownership or permissions." >&2
  exit 77
fi

trusted_stage="$(/usr/bin/mktemp -d /run/bb-mesh-gateway-config.XXXXXX)"
if [[ ! "$trusted_stage" =~ ^/run/bb-mesh-gateway-config\.[A-Za-z0-9]+$ ]]; then
  echo "Could not create a trusted gateway staging directory." >&2
  exit 70
fi
readonly trusted_stage
readonly trusted_config="$trusted_stage/Caddyfile"
/usr/bin/chown "root:$caddy_gid" "$trusted_stage"
/usr/bin/chmod 0750 "$trusted_stage"

cleanup() {
  local exit_code="$?"
  /usr/bin/rm -rf -- "$trusted_stage"
  return "$exit_code"
}
trap cleanup EXIT

if ! /usr/sbin/runuser -u "$DEPLOY_USER" -- /usr/bin/env -i \
  HOME=/nonexistent \
  LANG=C \
  PATH=/usr/bin:/bin \
  "$python3_resolved" -I -S "$CANDIDATE_READER" "$staged_config" "$expected_sha256" \
  > "$trusted_config"; then
  echo "Could not safely stage the gateway candidate." >&2
  exit 1
fi
if [[ "$(/usr/bin/stat -c '%U:%G:%a' -- "$trusted_config")" != "root:root:600" ]]; then
  echo "Trusted gateway candidate has unsafe ownership or permissions." >&2
  exit 77
fi
/usr/bin/chown "root:$caddy_gid" "$trusted_config"
/usr/bin/chmod 0640 "$trusted_config"

"$ACTIVATION_CORE" \
  "$trusted_config" \
  "$expected_sha256" \
  "$TARGET_CONFIG" \
  "$CADDY_BIN" \
  "$SYSTEMCTL_BIN" \
  "$SERVICE_NAME"
