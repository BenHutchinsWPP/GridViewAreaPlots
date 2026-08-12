#!/usr/bin/env bash
# Build the production WASM CSV parser. Freestanding wasm32, no libc, no imports.
#
# Toolchain: clang 18 is usually already present; wasm-ld is not.
#   sudo apt-get install -y lld-18
# That is the whole blocker -- no Rust, no Emscripten, no wasm-bindgen.
#
set -euo pipefail
cd "$(dirname "$0")"

CLANG=${CLANG:-clang-18}
export PATH="/usr/lib/llvm-18/bin:$PATH"   # wasm-ld lives here

# Per-worker linear memory: 12 MiB input window + a 20 MiB arena that holds one
# block's values, per-row (area, hour) pair, TOU and column plan, rounded up for
# the stack and globals.
# Sized to a BLOCK, never to a case. Keep in step with INBUF_BYTES and
# ARENA_BYTES in block.c -- the static buffers must fit or the module traps.
INITIAL_MEMORY=$((36 * 1024 * 1024))

$CLANG --target=wasm32 -O3 -flto -msimd128 -mbulk-memory \
  -nostdlib -ffreestanding -fno-builtin \
  -Wl,--no-entry \
  -Wl,--export-dynamic \
  -Wl,--initial-memory=$INITIAL_MEMORY \
  -Wl,--lto-O3 \
  -o block.wasm block.c

echo "built block.wasm ($(stat -c%s block.wasm) bytes, $(( INITIAL_MEMORY / 1024 / 1024 )) MiB linear memory per worker instance)"
