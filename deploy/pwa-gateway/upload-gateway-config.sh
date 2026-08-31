#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: upload-gateway-config.sh <caddy-config> <user@host> <ssh-key> <known-hosts>" >&2
}

if [[ "$#" -ne 4 ]]; then
  usage
  exit 64
fi

caddy_config="$1"
ssh_destination="$2"
ssh_key="$3"
known_hosts="$4"

if [[ ! -f "$caddy_config" || -L "$caddy_config" ]]; then
  echo "Missing regular Caddy config: $caddy_config" >&2
  exit 66
fi
if [[ ! "$ssh_destination" =~ ^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9.-]+$ ]]; then
  echo "SSH destination must be a literal user@host value." >&2
  exit 64
fi
for credential_path in "$ssh_key" "$known_hosts"; do
  if [[ ! -f "$credential_path" || -L "$credential_path" ]]; then
    echo "Missing regular SSH credential file: $credential_path" >&2
    exit 66
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  config_sha256="$(sha256sum "$caddy_config" | awk '{print $1}')"
else
  config_sha256="$(shasum -a 256 "$caddy_config" | awk '{print $1}')"
fi

run_token="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
if [[ ! "$run_token" =~ ^[0-9]+-[0-9]+$ ]]; then
  echo "Unsafe gateway upload run token." >&2
  exit 64
fi

remote_tools="/tmp/bb-mesh-gateway-config-$run_token"
remote_prepared="false"
ssh_options=(
  -i "$ssh_key"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts"
)

cleanup() {
  local exit_code="$?"
  if [[ "$remote_prepared" == "true" ]]; then
    ssh "${ssh_options[@]}" "$ssh_destination" "rm -rf -- '$remote_tools'" >/dev/null 2>&1 || true
  fi
  return "$exit_code"
}
trap cleanup EXIT

ssh "${ssh_options[@]}" "$ssh_destination" "mkdir -m 0700 '$remote_tools'"
remote_prepared="true"
scp "${ssh_options[@]}" "$caddy_config" "$ssh_destination:$remote_tools/Caddyfile"
scp "${ssh_options[@]}" "$script_directory/activate-gateway-config.sh" \
  "$ssh_destination:$remote_tools/"
ssh "${ssh_options[@]}" "$ssh_destination" \
  "chmod 0700 '$remote_tools/activate-gateway-config.sh' && '$remote_tools/activate-gateway-config.sh' '$remote_tools/Caddyfile' '$config_sha256' /etc/caddy/Caddyfile /usr/local/bin/caddy /usr/bin/systemctl caddy.service"

echo "Uploaded, validated, and activated the BB Mesh gateway configuration."
