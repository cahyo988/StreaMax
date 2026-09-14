#!/bin/sh
set -eu

: "${ARCHIVE:?Set ARCHIVE to a verified StreaMax backup tarball}"
: "${RESTORE_DIR:?Set RESTORE_DIR to a new, non-existent data directory}"

case "$ARCHIVE" in
  /*) ;;
  *) printf '%s\n' "ARCHIVE must be an absolute path" >&2; exit 2 ;;
esac
case "$RESTORE_DIR" in
  /*) ;;
  *) printf '%s\n' "RESTORE_DIR must be an absolute path" >&2; exit 2 ;;
esac

archive_dir=$(CDPATH= cd "$(dirname "$ARCHIVE")" && pwd -P)
archive_real="$archive_dir/$(basename "$ARCHIVE")"
[ -f "$archive_real" ] || {
  printf '%s\n' "ARCHIVE does not name a regular file" >&2
  exit 2
}

target_parent=$(dirname "$RESTORE_DIR")
target_name=$(basename "$RESTORE_DIR")
case "$target_name" in
  ''|.|..) printf '%s\n' "RESTORE_DIR must name a child directory" >&2; exit 2 ;;
esac
parent_real=$(CDPATH= cd "$target_parent" && pwd -P)
target_real="$parent_real/$target_name"
target_exists=0
if [ -e "$target_real" ] || [ -L "$target_real" ]; then
  if [ -L "$target_real" ] || [ ! -d "$target_real" ]; then
    printf '%s\n' "RESTORE_DIR must be a real directory, not a link or file" >&2
    exit 2
  fi
  existing=$(find "$target_real" -mindepth 1 -maxdepth 1 -print -quit)
  if [ -n "$existing" ]; then
    printf '%s\n' "RESTORE_DIR must be empty; refusing to overwrite data" >&2
    exit 2
  fi
  target_exists=1
fi

if ! tar -tzf "$archive_real" | awk '
  /^\// || /(^|\/)\.\.(\/|$)/ || /(^|\/)\.streamax-restore\./ { invalid = 1 }
  END { exit invalid }
'; then
  printf '%s\n' "Backup contains an unsafe path" >&2
  exit 2
fi
if ! tar -tvzf "$archive_real" | awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { invalid = 1 }
  END { exit invalid }
'; then
  printf '%s\n' "Backup contains a link or unsupported file type" >&2
  exit 2
fi

if [ "$target_exists" -eq 1 ]; then
  staging=$(mktemp -d "$target_real/.streamax-restore.XXXXXX")
else
  staging=$(mktemp -d "$parent_real/.streamax-restore.XXXXXX")
fi
trap 'rm -rf "$staging"' EXIT HUP INT TERM
tar --no-same-owner --no-same-permissions -xzf "$archive_real" -C "$staging"
if [ "$target_exists" -eq 1 ]; then
  find "$staging" -mindepth 1 -maxdepth 1 -exec mv -t "$target_real" -- {} +
  rmdir "$staging"
else
  mv "$staging" "$target_real"
fi
trap - EXIT HUP INT TERM
printf 'Restore extracted to: %s\n' "$target_real"
printf '%s\n' "Restore ENCRYPTION_KEY separately before starting StreaMax."
