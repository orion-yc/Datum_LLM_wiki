#!/bin/sh
set -eu
DATUM_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DATUM_ROOT"
if [ "${1:-}" != "--worker" ]; then
  exec systemd-run --user --wait --pipe --collect \
    --unit="datum-test-$(date +%s)" \
    -p MemoryMax=650M -p MemorySwapMax=0 -p CPUQuota=60% \
    -p OOMPolicy=kill -p Nice=10 \
    /bin/sh "$DATUM_ROOT/deploy/test-limited.sh" --worker "${1:-}"
fi
export PATH="$DATUM_ROOT/.tools/js/node_modules/node-linux-x64/bin:$DATUM_ROOT/.tools/root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu:$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu/libproxy"
export QT_PLUGIN_PATH="$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu/qt6/plugins"
export PDFTOTEXT="$DATUM_ROOT/.tools/root/usr/bin/pdftotext"
export DATUM_SERVER="$DATUM_ROOT/build/upload-release/datum-server"
export STATIC_DIR="$DATUM_ROOT/build/upload-web"
export NODE_OPTIONS=--max-old-space-size=256
if [ "${2:-}" = "--projects" ]; then
  node --test tests/projects.test.mjs
  node scripts/projects-e2e.mjs
  exec node --test --test-concurrency=1 tests/*.test.mjs
fi
if [ "${2:-}" = "--upload-speed-only" ]; then
  node --test --test-concurrency=1 tests/uploads.test.mjs
  node scripts/upload-retry-e2e.mjs
  exec node scripts/upload-e2e.mjs
fi
if [ "${2:-}" = "--upload-check" ]; then
  node --test --test-concurrency=1 tests/*.test.mjs
  exec node scripts/upload-e2e.mjs
fi
if [ "${2:-}" = "--upload-retry-only" ]; then
  node --test --test-concurrency=1 tests/uploads.test.mjs
  exec node scripts/upload-retry-e2e.mjs
fi
if [ "${2:-}" = "--incremental-only" ]; then
  node --test --test-concurrency=1 tests/pdf-long.test.mjs tests/pdf-parsing.test.mjs
  exec node scripts/pdf-review-e2e.mjs
fi
if [ "${2:-}" = "--long-only" ]; then
  exec node --test tests/pdf-long.test.mjs
fi
if [ "${2:-}" != "--browser-only" ]; then
  node --test --test-concurrency=1 tests/*.test.mjs
fi
node scripts/upload-e2e.mjs
node scripts/upload-retry-e2e.mjs
node scripts/pdf-e2e.mjs
node scripts/pdf-review-e2e.mjs
node scripts/library-e2e.mjs
node scripts/projects-e2e.mjs
