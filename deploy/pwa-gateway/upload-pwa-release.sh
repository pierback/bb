#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: upload-pwa-release.sh <release-directory> <source-commit> <user@host> <ssh-key> <known-hosts>" >&2
}

if [[ "$#" -ne 5 ]]; then
  usage
  exit 64
fi

release_directory="$1"
source_commit="$2"
ssh_destination="$3"
ssh_key="$4"
known_hosts="$5"

if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid PWA source commit." >&2
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

node "$script_directory/release-package.mjs" verify "$release_directory" "$source_commit"

release_id="pierback-pwa-$source_commit"
run_token="${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
if [[ ! "$run_token" =~ ^[0-9]+-[0-9]+$ ]]; then
  echo "Unsafe PWA upload run token." >&2
  exit 64
fi

local_archive="$(mktemp "${RUNNER_TEMP:-/tmp}/$release_id.XXXXXX")"
remote_root="/srv/bb-pwa"
remote_archive="$remote_root/.incoming/$release_id-$run_token.tgz"
remote_tools="/tmp/pierback-pwa-tools-$run_token"
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
  rm -f -- "$local_archive"
  if [[ "$remote_prepared" == "true" ]]; then
    ssh "${ssh_options[@]}" "$ssh_destination" \
      "rm -rf -- '$remote_tools'; rm -f -- '$remote_archive'" >/dev/null 2>&1 || true
  fi
  return "$exit_code"
}
trap cleanup EXIT

tar -czf "$local_archive" -C "$release_directory" .
if command -v sha256sum >/dev/null 2>&1; then
  archive_sha256="$(sha256sum "$local_archive" | awk '{print $1}')"
else
  archive_sha256="$(shasum -a 256 "$local_archive" | awk '{print $1}')"
fi

ssh "${ssh_options[@]}" "$ssh_destination" \
  "mkdir -p '$remote_root/.incoming' '$remote_tools'"
remote_prepared="true"
scp "${ssh_options[@]}" "$local_archive" "$ssh_destination:$remote_archive"
scp "${ssh_options[@]}" "$script_directory/activate-pwa-release.sh" \
  "$ssh_destination:$remote_tools/"
ssh "${ssh_options[@]}" "$ssh_destination" \
  "chmod 0700 '$remote_tools/activate-pwa-release.sh' && bash '$remote_tools/activate-pwa-release.sh' '$remote_archive' '$remote_root' '$release_id' '$source_commit' '$archive_sha256'"

echo "Uploaded and activated $release_id on the public PWA host."
