#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: activate-pwa-release.sh <staged-archive> <pwa-root> <release-id> <source-commit> <archive-sha256>" >&2
}

if [[ "$#" -ne 5 ]]; then
  usage
  exit 64
fi

staged_archive="$1"
pwa_root="$2"
release_id="$3"
source_commit="$4"
expected_archive_sha256="$5"

if [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid PWA source commit." >&2
  exit 64
fi
if [[ "$release_id" != "bb-mesh-pwa-$source_commit" ]]; then
  echo "PWA release identity must match its source commit." >&2
  exit 64
fi
if [[ ! "$expected_archive_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid PWA archive checksum." >&2
  exit 64
fi
if [[ "$pwa_root" != /* || "$pwa_root" == "/" ]]; then
  echo "PWA root must be a specific absolute directory." >&2
  exit 64
fi
if [[ "$(dirname "$staged_archive")" != "$pwa_root/.incoming" ]]; then
  echo "Staged archive must be one direct child of $pwa_root/.incoming/." >&2
  exit 64
fi
if [[ ! -f "$staged_archive" || -L "$staged_archive" ]]; then
  echo "Missing regular PWA archive: $staged_archive" >&2
  exit 66
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_archive_sha256="$(sha256sum "$staged_archive" | awk '{print $1}')"
else
  actual_archive_sha256="$(shasum -a 256 "$staged_archive" | awk '{print $1}')"
fi
if [[ "$actual_archive_sha256" != "$expected_archive_sha256" ]]; then
  echo "PWA archive checksum mismatch." >&2
  exit 1
fi

mkdir -p "$pwa_root/.incoming" "$pwa_root/releases"
if [[ -e "$pwa_root/current" && ! -L "$pwa_root/current" ]]; then
  echo "Refusing to replace non-symlink PWA current path." >&2
  exit 1
fi
release_directory="$pwa_root/releases/$release_id"
release_staging_directory="$(mktemp -d "$pwa_root/releases/.$release_id.XXXXXX")"
link_staging=""

cleanup() {
  local exit_code="$?"
  if [[ -n "$release_staging_directory" && -d "$release_staging_directory" ]]; then
    rm -rf -- "$release_staging_directory"
  fi
  if [[ -n "$link_staging" && -L "$link_staging" ]]; then
    rm -- "$link_staging"
  fi
  rm -f -- "$staged_archive"
  return "$exit_code"
}
trap cleanup EXIT

while IFS= read -r archive_path; do
  normalized_path="${archive_path#./}"
  normalized_path="${normalized_path%/}"
  if [[ -z "$normalized_path" ]]; then
    continue
  fi
  case "/$normalized_path/" in
    *"/../"* | *"//"*)
      echo "Unsafe path in PWA archive: $archive_path" >&2
      exit 1
      ;;
  esac
  if [[ "$archive_path" == /* ]]; then
    echo "Absolute path in PWA archive: $archive_path" >&2
    exit 1
  fi
done < <(tar -tzf "$staged_archive")

if ! tar -tvzf "$staged_archive" | awk '{ type = substr($1, 1, 1); if (type != "-" && type != "d") exit 1 }'; then
  echo "PWA archive may contain only regular files and directories." >&2
  exit 1
fi
tar --no-same-owner --no-same-permissions -xzf "$staged_archive" -C "$release_staging_directory"

if [[ ! -f "$release_staging_directory/index.html" || -L "$release_staging_directory/index.html" ]]; then
  echo "PWA archive is missing a regular index.html." >&2
  exit 1
fi
if [[ ! -f "$release_staging_directory/bb-mesh-pwa-release.json" || -L "$release_staging_directory/bb-mesh-pwa-release.json" ]]; then
  echo "PWA archive is missing its release manifest." >&2
  exit 1
fi
if ! grep -Eq "\"sourceCommit\"[[:space:]]*:[[:space:]]*\"$source_commit\"" "$release_staging_directory/bb-mesh-pwa-release.json"; then
  echo "PWA release manifest does not match its source commit." >&2
  exit 1
fi
if [[ ! -f "$release_staging_directory/SHA256SUMS" || -L "$release_staging_directory/SHA256SUMS" ]]; then
  echo "PWA archive is missing SHA256SUMS." >&2
  exit 1
fi
if [[ -n "$(find "$release_staging_directory" -type l -print -quit)" ]]; then
  echo "PWA archive must not contain symlinks." >&2
  exit 1
fi

while IFS= read -r checksum_line; do
  checksum="${checksum_line%%  *}"
  checksum_path="${checksum_line#*  }"
  if [[ ! "$checksum" =~ ^[0-9a-f]{64}$ || ! "$checksum_path" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "Unsafe entry in PWA SHA256SUMS." >&2
    exit 1
  fi
  case "/$checksum_path/" in
    *"/../"* | *"//"*)
      echo "Unsafe checksum path in PWA release." >&2
      exit 1
      ;;
  esac
done < "$release_staging_directory/SHA256SUMS"

(
  cd "$release_staging_directory"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check --strict SHA256SUMS
  else
    shasum -a 256 --check SHA256SUMS
  fi
)

contains_pairing_route="false"
contains_approval_view="false"
while IFS= read -r -d '' javascript_path; do
  if [[ "$contains_pairing_route" == "false" ]] && grep -qF -- '/pair-device' "$javascript_path"; then
    contains_pairing_route="true"
  fi
  if [[ "$contains_approval_view" == "false" ]] && grep -qF -- 'Approve this Mac?' "$javascript_path"; then
    contains_approval_view="true"
  fi
done < <(find "$release_staging_directory" -type f -name '*.js' -print0)

if [[ "$contains_pairing_route" != "true" ]]; then
  echo "PWA release does not contain the native pairing route." >&2
  exit 1
fi
if [[ "$contains_approval_view" != "true" ]]; then
  echo "PWA release does not contain the native pairing approval view." >&2
  exit 1
fi

if [[ -e "$release_directory" ]]; then
  if [[ ! -d "$release_directory" || -L "$release_directory" ]]; then
    echo "Immutable PWA release path is not a regular directory: $release_directory" >&2
    exit 1
  fi
  if ! cmp -s "$release_staging_directory/SHA256SUMS" "$release_directory/SHA256SUMS"; then
    echo "Immutable PWA release $release_id already exists with different content." >&2
    exit 1
  fi
  rm -rf -- "$release_staging_directory"
  release_staging_directory=""
else
  find "$release_staging_directory" -type d -exec chmod 0755 {} +
  find "$release_staging_directory" -type f -exec chmod 0644 {} +
  mv -- "$release_staging_directory" "$release_directory"
  release_staging_directory=""
fi

link_staging="$pwa_root/.current.$release_id.$$.link"
ln -s "releases/$release_id" "$link_staging"
if mv --help 2>/dev/null | grep -q -- "--no-target-directory"; then
  mv -Tf -- "$link_staging" "$pwa_root/current"
else
  mv -fh -- "$link_staging" "$pwa_root/current"
fi
link_staging=""

echo "Activated immutable PWA release $release_id."
