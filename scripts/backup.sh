#!/bin/sh
set -eu

: "${DATA_DIR:?Set DATA_DIR to the stopped StreaMax data directory}"
: "${BACKUP_DIR:?Set BACKUP_DIR to a separate protected backup directory}"

case "$DATA_DIR" in
  /*) ;;
  *) printf '%s\n' "DATA_DIR must be an absolute path" >&2; exit 2 ;;
esac
case "$BACKUP_DIR" in
  /*) ;;
  *) printf '%s\n' "BACKUP_DIR must be an absolute path" >&2; exit 2 ;;
esac
if [ "${BACKUP_KEEP+x}" = x ]; then
  case "$BACKUP_KEEP" in
    ''|*[!0-9]*) printf '%s\n' "BACKUP_KEEP must be a positive integer" >&2; exit 2 ;;
  esac
  if [ "${#BACKUP_KEEP}" -gt 5 ]; then
    printf '%s\n' "BACKUP_KEEP must be 99999 or less" >&2
    exit 2
  fi
  if [ "$BACKUP_KEEP" -lt 1 ]; then
    printf '%s\n' "BACKUP_KEEP must be at least 1" >&2
    exit 2
  fi
fi

data_real=$(CDPATH= cd "$DATA_DIR" && pwd -P)
if [ "$data_real" = "/" ]; then
  printf '%s\n' "DATA_DIR must not be the filesystem root" >&2
  exit 2
fi
if [ -d "$BACKUP_DIR" ]; then
  backup_real=$(CDPATH= cd "$BACKUP_DIR" && pwd -P)
else
  if [ -L "$BACKUP_DIR" ]; then
    printf '%s\n' "BACKUP_DIR must not be a dangling symbolic link" >&2
    exit 2
  fi
  backup_parent=$(dirname "$BACKUP_DIR")
  backup_name=$(basename "$BACKUP_DIR")
  backup_parent_real=$(CDPATH= cd "$backup_parent" && pwd -P)
  backup_real="$backup_parent_real/$backup_name"
fi
validate_backup_dir() {
  if [ "$backup_real" = "$data_real" ]; then
    printf '%s\n' "BACKUP_DIR must not be inside DATA_DIR" >&2
    exit 2
  fi
  case "$backup_real/" in
    "$data_real/"*)
      printf '%s\n' "BACKUP_DIR must not be inside DATA_DIR" >&2
      exit 2
      ;;
  esac
}
validate_backup_dir
mkdir -p "$backup_real"
backup_real=$(CDPATH= cd "$backup_real" && pwd -P)
validate_backup_dir

stamp=$(date -u '+%Y%m%dT%H%M%SZ')
archive="$backup_real/streamax-$stamp-$$.tar.gz"
temporary="$archive.tmp.$$"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

tar -czf "$temporary" -C "$data_real" .
tar -tzf "$temporary" >/dev/null
mv "$temporary" "$archive"
trap - EXIT HUP INT TERM
printf 'Backup created: %s\n' "$archive"
printf '%s\n' "Store ENCRYPTION_KEY separately; this archive contains the database and media only."

if [ "${BACKUP_KEEP+x}" = x ]; then
  find "$backup_real" -maxdepth 1 -type f \
    -name 'streamax-????????T??????Z-*.tar.gz' -printf '%f\n' \
    | sort -r \
    | awk -v keep="$BACKUP_KEEP" 'NR > keep { print }' \
    | while IFS= read -r old; do
        rm -- "$backup_real/$old"
      done
fi
