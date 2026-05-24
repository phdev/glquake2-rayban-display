#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${Q2_DEMO_BUILD_DIR:-$ROOT_DIR/.build/q2-demo}"
DEMO_URL="${Q2_DEMO_URL:-https://deponie.yamagi.org/quake2/idstuff/q2-314-demo-x86.exe}"
DEMO_MD5="${Q2_DEMO_MD5:-4d1cd4618e80a38db59304132ea0856c}"
PAK_MD5="${Q2_DEMO_PAK_MD5:-27d77240466ec4f3253256832b54db8a}"
PUBLIC_BASEQ2="$ROOT_DIR/public/wasm/baseq2"
DEMO_EXE="$BUILD_DIR/q2-314-demo-x86.exe"
EXTRACTED="$BUILD_DIR/extracted"
PAK_PATH="$EXTRACTED/Install/Data/baseq2/pak0.pak"
LICENSE_PATH="$EXTRACTED/Install/Data/DOCS/license.txt"

md5_file() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | awk '{print $1}'
  else
    md5 -q "$1"
  fi
}

mkdir -p "$BUILD_DIR" "$PUBLIC_BASEQ2"

if [[ ! -f "$DEMO_EXE" ]]; then
  curl -fL --retry 3 -o "$DEMO_EXE" "$DEMO_URL"
fi

ACTUAL_DEMO_MD5="$(md5_file "$DEMO_EXE")"
if [[ "$ACTUAL_DEMO_MD5" != "$DEMO_MD5" ]]; then
  echo "Unexpected demo package MD5: $ACTUAL_DEMO_MD5" >&2
  exit 1
fi

rm -rf "$EXTRACTED"
unzip -q "$DEMO_EXE" -d "$EXTRACTED"

ACTUAL_PAK_MD5="$(md5_file "$PAK_PATH")"
if [[ "$ACTUAL_PAK_MD5" != "$PAK_MD5" ]]; then
  echo "Unexpected demo PAK MD5: $ACTUAL_PAK_MD5" >&2
  exit 1
fi

install -m 0644 "$PAK_PATH" "$PUBLIC_BASEQ2/pak0.pak"
install -m 0644 "$LICENSE_PATH" "$PUBLIC_BASEQ2/license.txt"

echo "Installed Quake II demo PAK into $PUBLIC_BASEQ2"
