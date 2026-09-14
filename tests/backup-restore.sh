#!/bin/sh
set -eu

test_dir=$(mktemp -d /tmp/streamax-backup-test.XXXXXX)
cleanup() {
  case "$test_dir" in
    /tmp/streamax-backup-test.*) rm -rf -- "$test_dir" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$test_dir/data"
printf 'test-media' > "$test_dir/data/sample.mp4"
if DATA_DIR="$test_dir/data" BACKUP_DIR="$test_dir/data/invalid-backups" \
  sh scripts/backup.sh; then
  printf '%s\n' "Backup unexpectedly allowed a nested destination" >&2
  exit 1
fi
test ! -e "$test_dir/data/invalid-backups"
DATA_DIR="$test_dir/data" BACKUP_DIR="$test_dir/backups" BACKUP_KEEP=1 \
  sh scripts/backup.sh
DATA_DIR="$test_dir/data" BACKUP_DIR="$test_dir/backups" BACKUP_KEEP=1 \
  sh scripts/backup.sh

count=$(
  find "$test_dir/backups" -maxdepth 1 -type f \
    -name 'streamax-????????T??????Z-*.tar.gz' | wc -l
)
test "$count" -eq 1
archive=$(find "$test_dir/backups" -maxdepth 1 -type f \
  -name 'streamax-????????T??????Z-*.tar.gz')
ARCHIVE="$archive" RESTORE_DIR="$test_dir/restored" sh scripts/restore.sh
cmp "$test_dir/data/sample.mp4" "$test_dir/restored/sample.mp4"
mkdir "$test_dir/empty-volume"
ARCHIVE="$archive" RESTORE_DIR="$test_dir/empty-volume" sh scripts/restore.sh
cmp "$test_dir/data/sample.mp4" "$test_dir/empty-volume/sample.mp4"

if ARCHIVE="$archive" RESTORE_DIR="$test_dir/restored" sh scripts/restore.sh; then
  printf '%s\n' "Restore unexpectedly replaced an existing directory" >&2
  exit 1
fi
printf '%s\n' "Backup, retention, and restore round trip passed"
