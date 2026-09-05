#!/usr/bin/env bash

set -euo pipefail

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

remote_stage="/srv/bb-pwa/.incoming/gateway-config-$run_token"
remote_prepared="false"
printf -v remote_stage_quoted "%q" "$remote_stage"
remote_cleanup_command="rm -rf -- $remote_stage_quoted"
remote_prepare_command="mkdir -p -- /srv/bb-pwa/.incoming && chmod 0700 /srv/bb-pwa/.incoming && mkdir -m 0700 $remote_stage_quoted"
remote_activate_command="chmod 0600 $remote_stage_quoted/Caddyfile && sudo -n /usr/local/sbin/bb-mesh-activate-gateway $remote_stage_quoted/Caddyfile $config_sha256"
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
    # This fixed command contains only the validated numeric run path.
    # shellcheck disable=SC2029
    ssh "${ssh_options[@]}" "$ssh_destination" "$remote_cleanup_command" >/dev/null 2>&1 || true
  fi
  return "$exit_code"
}
trap cleanup EXIT

# The remote path was shell-escaped after numeric-token validation.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "$ssh_destination" \
  "$remote_prepare_command"
remote_prepared="true"
scp "${ssh_options[@]}" "$caddy_config" "$ssh_destination:$remote_stage/Caddyfile"
# This command has fixed targets plus an escaped path and hex checksum.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "$ssh_destination" \
  "$remote_activate_command"

echo "Uploaded, validated, and activated the BB Mesh gateway configuration."
