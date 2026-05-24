#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${QWASM2_BUILD_DIR:-$ROOT_DIR/.build/qwasm2}"
UPSTREAM_REPO="${QWASM2_REPO:-https://github.com/GMH-Code/Qwasm2.git}"
PATCH_FILE="$ROOT_DIR/patches/qwasm2-meta-rayban-display.patch"
PUBLIC_WASM="$ROOT_DIR/public/wasm"

if ! command -v emmake >/dev/null 2>&1; then
  echo "emmake was not found. Install and activate the Emscripten SDK first." >&2
  exit 1
fi

if [[ -z "${GL4ES_PATH:-}" || ! -d "$GL4ES_PATH" ]]; then
  echo "Set GL4ES_PATH to a GL4ES build directory compiled with Emscripten." >&2
  exit 1
fi

if [[ ! -d "$BUILD_DIR/.git" ]]; then
  mkdir -p "$(dirname "$BUILD_DIR")"
  git clone --depth 1 "$UPSTREAM_REPO" "$BUILD_DIR"
fi

cd "$BUILD_DIR"

if git apply --check "$PATCH_FILE" >/dev/null 2>&1; then
  git apply "$PATCH_FILE"
else
  echo "Qwasm2 patch is already applied or does not match this checkout; continuing." >&2
fi

if [[ -n "${Q2_REDUCED_PAK:-}" ]]; then
  install -d wasm/baseq2
  install -m 0644 "$Q2_REDUCED_PAK" wasm/baseq2/pak0.pak
else
  rm -f wasm/baseq2/pak0.pak
fi

install -d wasm/baseq2
printf '\n' > wasm/baseq2/yq2.cfg
cat > wasm/baseq2/autoexec.cfg <<'CFG'
alias d1 "map demo1"
set nextserver ""
CFG

emmake make EMSCRIPTEN=1 GL4ES_PATH="$GL4ES_PATH" -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

install -d "$PUBLIC_WASM"
install -m 0644 release/index.js "$PUBLIC_WASM/quake2.js"
install -m 0644 release/index.wasm "$PUBLIC_WASM/quake2.wasm"
install -m 0644 release/index.data "$PUBLIC_WASM/quake2.data"
install -m 0644 release/game_baseq2.wasm "$PUBLIC_WASM/game_baseq2.wasm"
install -m 0644 release/ref_gles3.wasm "$PUBLIC_WASM/ref_gles3.wasm"
install -m 0644 release/ref_gl1.wasm "$PUBLIC_WASM/ref_gl1.wasm"
install -m 0644 release/ref_soft.wasm "$PUBLIC_WASM/ref_soft.wasm"

echo "Installed WebAssembly engine artifacts into $PUBLIC_WASM"
