#!/bin/sh
set -eu
DATUM_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DATUM_ROOT"
if [ "${1:-}" != "--worker" ]; then
  exec systemd-run --user --wait --pipe --collect \
    --unit="datum-build-$(date +%s)" \
    -p MemoryMax=650M -p MemorySwapMax=0 -p CPUQuota=60% \
    -p OOMPolicy=kill -p Nice=10 \
    /bin/sh "$DATUM_ROOT/deploy/build-limited.sh" --worker
fi
export PATH="$DATUM_ROOT/.tools/js/node_modules/node-linux-x64/bin:$DATUM_ROOT/.tools/root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu:$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu/libproxy"
export NODE_OPTIONS=--max-old-space-size=320
cmake -S . -B build/upload-release -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS_RELEASE='-O1 -DNDEBUG' \
  -DCMAKE_PREFIX_PATH="$DATUM_ROOT/.tools/root/usr" \
  -DOPENSSL_ROOT_DIR="$DATUM_ROOT/.tools/root/usr" \
  -DOPENSSL_CRYPTO_LIBRARY=/usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  -DCMAKE_CXX_FLAGS="-I$DATUM_ROOT/.tools/root/usr/include/x86_64-linux-gnu --param=ggc-min-expand=10 --param=ggc-min-heapsize=16384" \
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,-rpath-link,$DATUM_ROOT/.tools/root/usr/lib/x86_64-linux-gnu/libproxy"
cmake --build build/upload-release --parallel 1
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build --outDir build/upload-web
