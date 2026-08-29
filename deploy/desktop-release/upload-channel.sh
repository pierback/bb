#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/release-bundle.sh"

usage() {
  echo "Usage: upload-channel.sh <release-directory> <release-tag> <canary|stable> <user@host> <ssh-key> <known-hosts>" >&2
}

if [[ "$#" -ne 6 ]]; then
  usage
  exit 64
fi

release_directory="$1"
release_tag="$2"
channel="$3"
ssh_destination="$4"
ssh_key="$5"
known_hosts="$6"

if [[ ! "$release_tag" =~ ^bb-mesh-desktop-v[0-9][0-9A-Za-z.+-]*$ ]]; then
  echo "Unsafe BB Mesh release tag: $release_tag" >&2
  exit 64
fi
if [[ "$channel" != "canary" && "$channel" != "stable" ]]; then
  echo "Update channel must be canary or stable." >&2
  exit 64
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

bb_mesh_release_validate_directory "$release_directory"

run_token="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-$$}"
if [[ ! "$run_token" =~ ^[0-9]+-[0-9]+$ ]]; then
  echo "Unsafe release upload run token." >&2
  exit 64
fi
update_root="/srv/bb-updates"
remote_staging="$update_root/.incoming/$release_tag-$channel-$run_token"
remote_tools="/tmp/bb-mesh-release-tools-$run_token"
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
    ssh "${ssh_options[@]}" "$ssh_destination" \
      "rm -rf -- '$remote_tools' '$remote_staging'" >/dev/null 2>&1 || true
  fi
  return "$exit_code"
}
trap cleanup EXIT

ssh "${ssh_options[@]}" "$ssh_destination" \
  "mkdir -p '$remote_staging' '$remote_tools'"
remote_prepared="true"

release_files=("$release_directory/SHA256SUMS")
for name in "${BB_MESH_RELEASE_MANIFEST_NAMES[@]}"; do
  release_files+=("$release_directory/$name")
done
scp "${ssh_options[@]}" "${release_files[@]}" \
  "$ssh_destination:$remote_staging/"
scp "${ssh_options[@]}" \
  "$script_directory/publish-channel.sh" \
  "$script_directory/release-bundle.sh" \
  "$ssh_destination:$remote_tools/"
ssh "${ssh_options[@]}" "$ssh_destination" \
  "chmod 0700 '$remote_tools/publish-channel.sh' && bash '$remote_tools/publish-channel.sh' '$remote_staging' '$update_root' '$release_tag' '$channel'"

echo "Uploaded and activated $release_tag on the public $channel feed."
