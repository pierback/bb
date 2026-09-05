#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: activate-gateway-config.sh <staged-config> <sha256> <target-config> <caddy-bin> <systemctl-bin> <service>" >&2
}

if [[ "$#" -ne 6 ]]; then
  usage
  exit 64
fi

staged_config="$1"
expected_sha256="$2"
target_config="$3"
caddy_bin="$4"
systemctl_bin="$5"
service_name="$6"
sudo_bin="${BB_MESH_SUDO_BIN:-/usr/bin/sudo}"
readonly caddy_service_user="caddy"
readonly runuser_bin="/usr/sbin/runuser"

if [[ ! -f "$staged_config" || -L "$staged_config" ]]; then
  echo "Missing regular staged Caddy config: $staged_config" >&2
  exit 66
fi
if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid Caddy config checksum." >&2
  exit 64
fi
if [[ "$target_config" != /* || "$target_config" == "/" || "${target_config##*/}" != "Caddyfile" ]]; then
  echo "Caddy target must be a specific absolute Caddyfile path." >&2
  exit 64
fi
target_directory="${target_config%/*}"
if [[ ! -d "$target_directory" || -L "$target_directory" ]]; then
  echo "Caddy target directory must be a regular directory." >&2
  exit 66
fi
if [[ ! -f "$target_config" || -L "$target_config" ]]; then
  echo "Refusing to replace a missing, non-regular, or linked Caddy config." >&2
  exit 66
fi
trusted_executables=("$caddy_bin" "$systemctl_bin")
if [[ "$EUID" -eq 0 ]]; then
  trusted_executables+=("$runuser_bin" /usr/bin/env)
  if ! /usr/bin/id -u "$caddy_service_user" >/dev/null 2>&1; then
    echo "Missing Caddy service account: $caddy_service_user" >&2
    exit 67
  fi
else
  trusted_executables+=("$sudo_bin")
fi
for executable_path in "${trusted_executables[@]}"; do
  if [[ "$executable_path" != /* || ! -f "$executable_path" || -L "$executable_path" || ! -x "$executable_path" ]]; then
    echo "Missing trusted executable: $executable_path" >&2
    exit 66
  fi
done
if [[ "$service_name" != "caddy.service" ]]; then
  echo "Gateway config may reload only caddy.service." >&2
  exit 64
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$staged_config" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$staged_config" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "Staged Caddy config checksum mismatch." >&2
  exit 1
fi

run_privileged() {
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  else
    "$sudo_bin" -n "$@"
  fi
}

validate_as_caddy() {
  local config_path="$1"
  if [[ "$EUID" -eq 0 ]]; then
    "$runuser_bin" -u "$caddy_service_user" -- /usr/bin/env -i \
      HOME=/var/lib/caddy \
      LOGNAME="$caddy_service_user" \
      PATH=/usr/local/bin:/usr/bin:/bin \
      USER="$caddy_service_user" \
      XDG_CONFIG_HOME=/var/lib/caddy/config \
      XDG_DATA_HOME=/var/lib/caddy \
      "$caddy_bin" validate --config "$config_path" --adapter caddyfile
  else
    "$caddy_bin" validate --config "$config_path" --adapter caddyfile
  fi
}

if [[ "$EUID" -eq 0 ]]; then
  service_user="$($systemctl_bin show --property=User --value "$service_name")"
  service_group="$($systemctl_bin show --property=Group --value "$service_name")"
  if [[ "$service_user" != "$caddy_service_user" || "$service_group" != "$caddy_service_user" ]]; then
    echo "Refusing to load deploy-controlled configuration into a privileged Caddy service." >&2
    exit 77
  fi
fi

next_config="$target_config.bb-mesh.$$.next"
backup_config="${staged_config%/*}/Caddyfile.previous.$$"

cleanup() {
  local exit_code="$?"
  run_privileged rm -f -- "$next_config" "$backup_config" >/dev/null 2>&1 || true
  return "$exit_code"
}
trap cleanup EXIT

validate_as_caddy "$staged_config"
run_privileged cp -p -- "$target_config" "$backup_config"
run_privileged install -m 0644 -- "$staged_config" "$next_config"
validate_as_caddy "$next_config"
run_privileged mv -f -- "$next_config" "$target_config"

if ! run_privileged "$systemctl_bin" reload "$service_name"; then
  run_privileged install -m 0644 -- "$backup_config" "$next_config"
  run_privileged mv -f -- "$next_config" "$target_config"
  if run_privileged "$systemctl_bin" reload "$service_name"; then
    echo "Caddy reload failed; restored the previous config." >&2
  else
    echo "Caddy reload failed and the previous config could not be reloaded." >&2
  fi
  exit 1
fi

echo "Activated and reloaded the BB Mesh gateway configuration."
