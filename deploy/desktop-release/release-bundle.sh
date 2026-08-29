#!/usr/bin/env bash

# Shared, fail-closed validation for every consumer of a BB Mesh desktop
# release. Callers must enable their own shell strict mode before sourcing.

bb_mesh_release_is_file_name() {
  local name="$1"
  case "$name" in
    SHA256SUMS | canary-mac.yml | stable-mac.yml | canary-desktop-version.json | stable-desktop-version.json | release-manifest.json)
      return 0
      ;;
    bb-mesh-*.dmg | bb-mesh-*.zip | bb-mesh-*.blockmap)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

bb_mesh_release_manifest_contains() {
  local expected_name="$1"
  local candidate
  for candidate in "${BB_MESH_RELEASE_MANIFEST_NAMES[@]-}"; do
    if [[ "$candidate" == "$expected_name" ]]; then
      return 0
    fi
  done
  return 1
}

bb_mesh_release_validate_directory() {
  local directory="$1"
  local entry
  local name
  local line
  local artifact_count=0
  local dmg_count=0
  local zip_count=0
  BB_MESH_RELEASE_MANIFEST_NAMES=()

  if [[ ! -d "$directory" || -L "$directory" ]]; then
    echo "Missing regular release directory: $directory" >&2
    return 1
  fi
  for name in \
    SHA256SUMS \
    canary-mac.yml \
    stable-mac.yml \
    canary-desktop-version.json \
    stable-desktop-version.json \
    release-manifest.json; do
    if [[ ! -f "$directory/$name" || -L "$directory/$name" ]]; then
      echo "Release bundle is missing regular file $name." >&2
      return 1
    fi
  done

  while IFS= read -r entry; do
    if [[ ! -f "$entry" || -L "$entry" ]]; then
      echo "Release bundle contains a non-regular entry: $entry" >&2
      return 1
    fi
    name="${entry##*/}"
    if ! bb_mesh_release_is_file_name "$name"; then
      echo "Release bundle contains an unexpected file: $name" >&2
      return 1
    fi
    case "$name" in
      bb-mesh-*.dmg)
        ((dmg_count += 1))
        ;;
      bb-mesh-*.zip)
        ((zip_count += 1))
        ;;
    esac
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -print | sort)

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ ! "$line" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]([A-Za-z0-9._-]+)$ ]]; then
      echo "SHA256SUMS contains an unsafe or malformed line." >&2
      return 1
    fi
    name="${BASH_REMATCH[1]}"
    if [[ "$name" == "SHA256SUMS" ]] || ! bb_mesh_release_is_file_name "$name"; then
      echo "SHA256SUMS names an unexpected file: $name" >&2
      return 1
    fi
    if bb_mesh_release_manifest_contains "$name"; then
      echo "SHA256SUMS names $name more than once." >&2
      return 1
    fi
    if [[ ! -f "$directory/$name" || -L "$directory/$name" ]]; then
      echo "SHA256SUMS names a missing regular file: $name" >&2
      return 1
    fi
    BB_MESH_RELEASE_MANIFEST_NAMES+=("$name")
    ((artifact_count += 1))
  done < "$directory/SHA256SUMS"

  if [[ "$artifact_count" -eq 0 || "$dmg_count" -eq 0 || "$zip_count" -eq 0 ]]; then
    echo "Release bundle must contain checksummed DMG and ZIP artifacts." >&2
    return 1
  fi

  while IFS= read -r entry; do
    name="${entry##*/}"
    if [[ "$name" != "SHA256SUMS" ]] && ! bb_mesh_release_manifest_contains "$name"; then
      echo "Release bundle contains unchecksummed file $name." >&2
      return 1
    fi
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -type f -print | sort)

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$directory" && sha256sum -c SHA256SUMS)
  else
    (cd "$directory" && shasum -a 256 -c SHA256SUMS)
  fi
}
