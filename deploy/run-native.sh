#!/bin/sh
set -eu
DATUM_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DATUM_ROOT"
export LD_LIBRARY_PATH="$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu:$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu/libproxy${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export QT_PLUGIN_PATH="$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu/qt6/plugins"
export HOST=127.0.0.1 PORT=3001 TRUST_PROXY=1 APP_TIMEZONE=Asia/Shanghai
export DATA_DIR="$DATUM_ROOT/data" STATIC_DIR="$DATUM_ROOT/dist"
export PDFTOTEXT="$DATUM_ROOT/.tools/root/usr/bin/pdftotext"
export XDG_DATA_DIRS="$DATUM_ROOT/.tools/root/usr/share:/usr/local/share:/usr/share"
exec "$DATUM_ROOT/build/backend/datum-server" "$@"
