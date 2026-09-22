#!/bin/sh
set -eu

DSH_DATA_DIR="${DSH_HOME:-/data/.dsh}"
DSH_WORKSPACE_DIR="${WORKSPACE_DIR:-/data/workspace}"

mkdir -p "$DSH_DATA_DIR" "$DSH_WORKSPACE_DIR"
chown -R dsh:dsh /data

exec gosu dsh:dsh node /app/gateway.mjs
