#!/usr/bin/env python3
import argparse
import io
import json
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path

HEADER = struct.Struct("<4sII")
ENTRY = struct.Struct("<56sII")
ENTRY_SIZE = 64


class PakError(Exception):
    pass


def normalize_name(name):
    normalized = name.replace("\\", "/").strip("/")
    parts = [part for part in normalized.split("/") if part and part != "."]

    if any(part == ".." for part in parts):
        raise PakError(f"Unsafe PAK path: {name}")

    return "/".join(parts).lower()


def read_pak(path):
    data = Path(path).read_bytes()

    if len(data) < HEADER.size:
        raise PakError("PAK is too small")

    magic, dir_offset, dir_size = HEADER.unpack_from(data, 0)
    if magic != b"PACK":
        raise PakError("PAK header is not PACK")

    if dir_size % ENTRY_SIZE != 0:
        raise PakError("PAK directory has an invalid size")

    if dir_offset + dir_size > len(data):
        raise PakError("PAK directory points outside the file")

    files = {}
    for offset in range(dir_offset, dir_offset + dir_size, ENTRY_SIZE):
        raw_name, file_offset, file_size = ENTRY.unpack_from(data, offset)
        name = raw_name.split(b"\0", 1)[0].decode("ascii", "strict")
        normalized = normalize_name(name)

        if file_offset + file_size > len(data):
            raise PakError(f"File points outside the PAK: {name}")

        files[normalized] = data[file_offset : file_offset + file_size]

    return files


def write_pak(path, files):
    output = io.BytesIO()
    output.write(b"\0" * HEADER.size)

    directory = []
    for name, payload in files.items():
        normalized = normalize_name(name)
        encoded = normalized.encode("ascii")
        if len(encoded) >= 56:
            raise PakError(f"PAK path is too long: {normalized}")

        file_offset = output.tell()
        output.write(payload)
        directory.append((encoded, file_offset, len(payload)))

    dir_offset = output.tell()
    for encoded, file_offset, file_size in directory:
        output.write(ENTRY.pack(encoded.ljust(56, b"\0"), file_offset, file_size))

    dir_size = len(directory) * ENTRY_SIZE
    output.seek(0)
    output.write(HEADER.pack(b"PACK", dir_offset, dir_size))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(output.getvalue())


def silent_wav(duration_ms=60, sample_rate=11025):
    frame_count = max(1, int(sample_rate * duration_ms / 1000))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(1)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes([128]) * frame_count)
    return buffer.getvalue()


def list_files(args):
    files = read_pak(args.input)
    for name in sorted(files):
        print(name)


def extract_files(args):
    files = read_pak(args.input)
    output = Path(args.output)
    for name, payload in files.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)


def create_pak(args):
    root = Path(args.input)
    files = {}

    for path in sorted(root.rglob("*")):
        if path.is_file():
            name = normalize_name(str(path.relative_to(root)))
            files[name] = path.read_bytes()

    write_pak(args.output, files)


def reduce_pak(args):
    manifest = json.loads(Path(args.manifest).read_text())
    input_pak = manifest.get("inputPak") or args.input
    output_pak = manifest.get("outputPak") or args.output

    if not input_pak or not output_pak:
        raise PakError("Manifest or command arguments must provide input and output PAK paths")

    source = read_pak(input_pak)
    output = {}
    missing = []

    for name in manifest.get("keep", []):
        normalized = normalize_name(name)
        if normalized in source:
            output[normalized] = source[normalized]
        else:
            missing.append(normalized)

    for name in manifest.get("silentSoundStubs", []):
        normalized = normalize_name(name)
        output.setdefault(normalized, silent_wav())

    write_pak(output_pak, output)

    print(f"Wrote {len(output)} files to {output_pak}")
    if missing:
        print("Missing requested files:", file=sys.stderr)
        for name in missing:
            print(f"  {name}", file=sys.stderr)
        return 2

    return 0


def self_test():
    with tempfile.TemporaryDirectory() as temp:
      temp_dir = Path(temp)
      source = temp_dir / "source.pak"
      reduced = temp_dir / "reduced.pak"
      manifest = temp_dir / "manifest.json"

      write_pak(source, {
          "maps/base1.bsp": b"map",
          "textures/e1/wall.wal": b"wall",
          "sound/world/drip.wav": b"sound"
      })

      manifest.write_text(json.dumps({
          "inputPak": str(source),
          "outputPak": str(reduced),
          "keep": ["maps/base1.bsp", "textures/e1/wall.wal"],
          "silentSoundStubs": ["sound/player/missing.wav"]
      }))

      exit_code = reduce_pak(argparse.Namespace(manifest=str(manifest), input=None, output=None))
      if exit_code != 0:
          raise PakError("Unexpected reduce failure")

      files = read_pak(reduced)
      assert files["maps/base1.bsp"] == b"map"
      assert files["textures/e1/wall.wal"] == b"wall"
      assert files["sound/player/missing.wav"].startswith(b"RIFF")

    print("paktool self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Read, write, and reduce Quake II PAK files.")
    parser.add_argument("--self-test", action="store_true")
    subparsers = parser.add_subparsers(dest="command")

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("input")
    list_parser.set_defaults(func=list_files)

    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("input")
    extract_parser.add_argument("output")
    extract_parser.set_defaults(func=extract_files)

    create_parser = subparsers.add_parser("create")
    create_parser.add_argument("input")
    create_parser.add_argument("output")
    create_parser.set_defaults(func=create_pak)

    reduce_parser = subparsers.add_parser("reduce")
    reduce_parser.add_argument("manifest")
    reduce_parser.add_argument("--input")
    reduce_parser.add_argument("--output")
    reduce_parser.set_defaults(func=reduce_pak)

    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0

    if not hasattr(args, "func"):
        parser.print_help()
        return 2

    try:
        result = args.func(args)
        return result or 0
    except (OSError, PakError, UnicodeError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
