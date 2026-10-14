#!/bin/sh
set -eu
umask 077

DSH_DATA_DIR="${DSH_HOME:-/data/.dsh}"
DSH_WORKSPACE_DIR="${WORKSPACE_DIR:-/data/workspace}"

# Refuse ephemeral or escaping storage overrides, including symlink escapes.
for directory in "$DSH_DATA_DIR" "$DSH_WORKSPACE_DIR"; do
  canonical=$(realpath -m -- "$directory")
  case "$canonical" in
    /data/*) ;;
    *) echo 'Harness state and workspaces must stay beneath /data' >&2; exit 1 ;;
  esac
done

mkdir -p "$DSH_DATA_DIR" "$DSH_WORKSPACE_DIR"
# Fresh Railway mounts may be root-owned. Fix only directory roots on boot;
# existing data remains untouched. Legacy nested ownership needs a one-off repair.
for directory in /data "$DSH_DATA_DIR" "$DSH_WORKSPACE_DIR"; do
  if [ "$(stat -c '%u:%g' -- "$directory")" != '10001:10001' ]; then
    chown dsh:dsh -- "$directory"
  fi
done
chmod 0700 "$DSH_DATA_DIR" "$DSH_WORKSPACE_DIR"
if [ -L "$DSH_DATA_DIR/.credentials.yaml" ]; then
  echo 'Refusing a symlinked credential store' >&2
  exit 1
fi
if [ -f "$DSH_DATA_DIR/.credentials.yaml" ]; then
  chmod 0600 "$DSH_DATA_DIR/.credentials.yaml"
fi
gosu dsh:dsh test -w "$DSH_DATA_DIR"
gosu dsh:dsh test -w "$DSH_WORKSPACE_DIR"

exec gosu dsh:dsh node /app/gateway.mjs
