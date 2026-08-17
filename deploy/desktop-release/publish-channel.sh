#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_directory/release-bundle.sh"

usage() {
  echo "Usage: publish-channel.sh <staging-directory> <update-root> <release-tag> <canary|stable>" >&2
}

if [[ "$#" -ne 4 ]]; then
  usage
  exit 64
fi

staging_directory="$1"
update_root="$2"
release_tag="$3"
channel="$4"

if [[ "$channel" != "canary" && "$channel" != "stable" ]]; then
  echo "Update channel must be canary or stable." >&2
  exit 64
fi
if [[ ! "$release_tag" =~ ^pierback-desktop-v[0-9][0-9A-Za-z.+-]*$ ]]; then
  echo "Unsafe Pierback release tag: $release_tag" >&2
  exit 64
fi
if [[ "$update_root" != /* || "$update_root" == "/" ]]; then
  echo "Update root must be a specific absolute directory." >&2
  exit 64
fi
staging_parent="$update_root/.incoming"
if [[ "$(dirname "$staging_directory")" != "$staging_parent" ]]; then
  echo "Staging directory must be one direct child of $staging_parent/." >&2
  exit 64
fi
if [[ ! -d "$staging_directory" || -L "$staging_directory" ]]; then
  echo "Missing regular staging directory: $staging_directory" >&2
  exit 66
fi

release_directory="$update_root/releases/$release_tag"
views_directory="$update_root/views"
view_directory="$views_directory/$release_tag-$channel"
view_staging_directory=""
channel_link_staging=""

cleanup() {
  local exit_code="$?"
  if [[ -n "$view_staging_directory" && -d "$view_staging_directory" ]]; then
    rm -rf -- "$view_staging_directory"
  fi
  if [[ -n "$channel_link_staging" && -L "$channel_link_staging" ]]; then
    rm -- "$channel_link_staging"
  fi
  return "$exit_code"
}
trap cleanup EXIT

replace_symlink() {
  local source="$1"
  local target="$2"

  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "Refusing to replace non-symlink channel path: $target" >&2
    return 1
  fi
  channel_link_staging="$update_root/.${channel}.${release_tag}.$$.link"
  ln -s "$source" "$channel_link_staging"
  if mv --help 2>/dev/null | grep -q -- "--no-target-directory"; then
    mv -Tf -- "$channel_link_staging" "$target"
  else
    mv -fh -- "$channel_link_staging" "$target"
  fi
  channel_link_staging=""
}

make_public_view_readable() {
  local directory="$1"

  # mktemp creates directories with mode 0700. Caddy serves only these
  # allowlisted views, so make the directory traversable and its files
  # world-readable before the channel symlink can point at it.
  chmod 0755 "$directory"
  chmod 0644 "$directory"/*
}

mkdir -p "$update_root/.incoming" "$update_root/releases" "$views_directory"
pierback_release_validate_directory "$staging_directory"

if [[ -e "$release_directory" ]]; then
  if [[ ! -d "$release_directory" || -L "$release_directory" ]]; then
    echo "Immutable release path is not a regular directory: $release_directory" >&2
    exit 1
  fi
  if ! cmp -s "$staging_directory/SHA256SUMS" "$release_directory/SHA256SUMS"; then
    echo "Immutable release $release_tag already exists with different checksums." >&2
    exit 1
  fi
  pierback_release_validate_directory "$release_directory"
  rm -rf -- "$staging_directory"
else
  mv -- "$staging_directory" "$release_directory"
fi

view_staging_directory="$(mktemp -d "$views_directory/.${release_tag}-${channel}.XXXXXX")"
for name in "${PIERBACK_RELEASE_MANIFEST_NAMES[@]}"; do
  cp -p -- "$release_directory/$name" "$view_staging_directory/$name"
done
cp -p -- "$release_directory/$channel-desktop-version.json" "$view_staging_directory/desktop-version.json"
cp -p -- "$release_directory/$channel-desktop-version-linux.json" "$view_staging_directory/desktop-version-linux.json"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$view_staging_directory"
    while IFS= read -r entry; do
      sha256sum "$entry" | sed 's#  \./#  #'
    done < <(find . -mindepth 1 -maxdepth 1 -type f ! -name SHA256SUMS -print | LC_ALL=C sort)
  ) > "$view_staging_directory/SHA256SUMS"
else
  (
    cd "$view_staging_directory"
    while IFS= read -r entry; do
      shasum -a 256 "$entry" | sed 's#  \./#  #'
    done < <(find . -mindepth 1 -maxdepth 1 -type f ! -name SHA256SUMS -print | LC_ALL=C sort)
  ) > "$view_staging_directory/SHA256SUMS"
fi

if [[ -e "$view_directory" ]]; then
  if [[ ! -d "$view_directory" || -L "$view_directory" ]]; then
    echo "Immutable channel view path is not a regular directory: $view_directory" >&2
    exit 1
  fi
  if ! diff -qr "$view_staging_directory" "$view_directory" >/dev/null; then
    echo "Immutable channel view $release_tag-$channel already differs." >&2
    exit 1
  fi
  rm -rf -- "$view_staging_directory"
  view_staging_directory=""
else
  mv -- "$view_staging_directory" "$view_directory"
  view_staging_directory=""
fi

make_public_view_readable "$view_directory"
replace_symlink "views/$release_tag-$channel" "$update_root/$channel"
echo "Published $release_tag to $channel from immutable checksummed artifacts."
