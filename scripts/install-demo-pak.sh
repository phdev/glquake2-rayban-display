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
REDUCED_PAK="$BUILD_DIR/baseq2-demo1.pak"
LICENSE_PATH="$EXTRACTED/Install/Data/DOCS/license.txt"
Q2_DEMO_REDUCE="${Q2_DEMO_REDUCE:-yes}"
Q2_DEMO_MAP="${Q2_DEMO_MAP:-maps/demo1.bsp}"
Q2_DEMO_AUDIO_RATE="${Q2_DEMO_AUDIO_RATE:-10000}"
Q2_DEMO_AUDIO_WIDTH="${Q2_DEMO_AUDIO_WIDTH:-1}"
Q2_DEMO_WRITE_GZIP="${Q2_DEMO_WRITE_GZIP:-yes}"

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

if [[ "$Q2_DEMO_REDUCE" == "yes" ]]; then
  REDUCE_ARGS=(--input "$PAK_PATH" --map "$Q2_DEMO_MAP" --output "$REDUCED_PAK")

  if [[ "$Q2_DEMO_AUDIO_RATE" != "0" ]]; then
    REDUCE_ARGS+=(--audio-rate "$Q2_DEMO_AUDIO_RATE" --audio-width "$Q2_DEMO_AUDIO_WIDTH")
  fi

  python3 "$ROOT_DIR/scripts/reduce-q2-map-pak.py" "${REDUCE_ARGS[@]}"
  install -m 0644 "$REDUCED_PAK" "$PUBLIC_BASEQ2/pak0.pak"
else
  install -m 0644 "$PAK_PATH" "$PUBLIC_BASEQ2/pak0.pak"
fi

if [[ "$Q2_DEMO_WRITE_GZIP" == "yes" ]]; then
  gzip -c -9 "$PUBLIC_BASEQ2/pak0.pak" > "$PUBLIC_BASEQ2/pak0.pak.gz"
fi

install -m 0644 "$LICENSE_PATH" "$PUBLIC_BASEQ2/license.txt"

echo "Installed Quake II demo PAK into $PUBLIC_BASEQ2"
