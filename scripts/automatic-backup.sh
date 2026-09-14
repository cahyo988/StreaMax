#!/bin/sh
set -eu
umask 077
: "${STREAMAX_PROJECT_DIR:?Set the absolute StreaMax project directory}"
: "${BACKUP_PATH:?Set the absolute protected backup directory}"
case "$STREAMAX_PROJECT_DIR:$BACKUP_PATH" in /*:/*) ;; *) printf '%s\n' 'Project and backup paths must be absolute' >&2; exit 2 ;; esac
cd "$STREAMAX_PROJECT_DIR"
test -f compose.yaml
mkdir -p "$BACKUP_PATH"
export BACKUP_PATH
exec 9>"$BACKUP_PATH/.automatic-backup.lock"
flock -n 9 || exit 0
was_running=false
if docker compose ps --status running --services | grep -qx streamax; then was_running=true; fi
resume() { if [ "$was_running" = true ]; then docker compose start streamax; fi; }
trap resume EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
docker compose stop streamax
docker compose --profile maintenance run --rm -e "BACKUP_KEEP=${BACKUP_KEEP:-7}" streamax-maintenance scripts/backup.sh
resume
trap - EXIT INT TERM HUP
if [ -n "${BACKUP_REMOTE:-}" ]; then
  newest=$(find "$BACKUP_PATH" -maxdepth 1 -type f -name 'streamax-????????T??????Z-*.tar.gz' -printf '%f\n' | sort -r | head -n 1)
  test -n "$newest"
  rclone copyto "$BACKUP_PATH/$newest" "$BACKUP_REMOTE/$newest" --immutable
  rclone check "$BACKUP_PATH" "$BACKUP_REMOTE" --include "$newest" --one-way --download
fi
