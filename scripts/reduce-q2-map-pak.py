#!/usr/bin/env python3
import argparse
import array
import fnmatch
import io
import re
import struct
import sys
import wave
from collections import Counter
from pathlib import Path

from paktool import PakError, normalize_name, read_pak, write_pak

BSP_HEADER = struct.Struct("<4sI")
BSP_LUMP = struct.Struct("<II")
BSP_LUMP_COUNT = 19
BSP_LUMP_ENTITIES = 0
BSP_LUMP_TEXINFO = 5
TEXINFO_SIZE = 76
TEXINFO_TEXTURE_OFFSET = 40
TEXINFO_TEXTURE_SIZE = 32

ENTITY_BLOCK_RE = re.compile(r"\{([^{}]*)\}", re.S)
ENTITY_PAIR_RE = re.compile(r'"((?:\\.|[^"\\])*)"\s*"((?:\\.|[^"\\])*)"')

SKY_SUFFIXES = ("bk", "dn", "ft", "lf", "rt", "up")

COMMON_PATTERNS = (
    "pics/*",
    "sprites/*",
    "models/objects/*",
    "sound/items/*",
    "sound/misc/*",
    "sound/player/*",
)

DEFAULT_WEAPON_PATTERNS = (
    "models/weapons/g_blast/*",
    "models/weapons/v_blast/*",
    "pics/w_blaster.pcx",
    "sound/weapons/blastf1a.wav",
    "sound/weapons/noammo.wav",
)

CLASS_PATTERNS = (
    ("monster_soldier", ("models/monsters/soldier/*", "sound/soldier/*")),
    ("monster_infantry", ("models/monsters/infantry/*", "sound/infantry/*")),
    ("misc_deadsoldier", ("models/deadbods/dude/*",)),
    ("misc_explobox", ("models/objects/barrels/*", "sound/world/explod1.wav", "sound/world/explod2.wav")),
    ("misc_banner", ("models/objects/banner/*",)),
    ("misc_gib_head", ("models/objects/gibs/head/*", "models/objects/gibs/head2/*")),
    ("misc_strogg_ship", ("models/ships/strogg1/*",)),
)

ITEM_PATTERNS = {
    "ammo_bullets": ("models/items/ammo/bullets/medium/*", "pics/a_bullets.pcx"),
    "ammo_grenades": (
        "models/items/ammo/grenades/medium/*",
        "models/weapons/v_handgr/*",
        "pics/a_grenades.pcx",
        "pics/w_hgrenade.pcx",
    ),
    "ammo_rockets": ("models/items/ammo/rockets/medium/*", "pics/a_rockets.pcx"),
    "ammo_shells": ("models/items/ammo/shells/medium/*", "pics/a_shells.pcx"),
    "item_adrenaline": ("models/items/adrenal/*", "pics/p_adrenaline.pcx"),
    "item_armor_combat": ("models/items/armor/combat/*", "models/items/armor/effect/*", "pics/i_combatarmor.pcx"),
    "item_armor_jacket": ("models/items/armor/jacket/*", "models/items/armor/effect/*", "pics/i_jacketarmor.pcx"),
    "item_armor_shard": ("models/items/armor/shard/*", "models/items/armor/effect/*", "pics/i_jacketarmor.pcx"),
    "item_health": ("models/items/healing/medium/*", "pics/i_health.pcx"),
    "item_health_large": ("models/items/healing/large/*", "pics/i_health.pcx"),
    "item_health_small": ("models/items/healing/stimpack/*", "pics/i_health.pcx"),
    "item_quad": ("models/items/quaddama/*", "pics/p_quad.pcx"),
    "item_silencer": ("models/items/silencer/*", "pics/p_silencer.pcx"),
    "weapon_grenadelauncher": ("models/weapons/g_launch/*", "models/weapons/v_launch/*", "pics/w_glauncher.pcx"),
    "weapon_machinegun": ("models/weapons/g_machn/*", "models/weapons/v_machn/*", "pics/w_machinegun.pcx"),
    "weapon_rocketlauncher": ("models/weapons/g_rocket/*", "models/weapons/v_rocket/*", "pics/w_rlauncher.pcx"),
    "weapon_shotgun": ("models/weapons/g_shotg/*", "models/weapons/v_shotg/*", "pics/w_shotgun.pcx"),
    "weapon_supershotgun": ("models/weapons/g_shotg2/*", "models/weapons/v_shotg2/*", "pics/w_sshotgun.pcx"),
}

WEAPON_SOUND_PATTERNS = {
    "weapon_grenadelauncher": ("sound/weapons/grenl*.wav", "sound/weapons/hgren*.wav"),
    "weapon_machinegun": ("sound/weapons/machg*.wav",),
    "weapon_rocketlauncher": ("sound/weapons/rock*.wav",),
    "weapon_shotgun": ("sound/weapons/shotg*.wav",),
    "weapon_supershotgun": ("sound/weapons/sshot*.wav", "sound/weapons/shotg*.wav"),
}

COMMON_WORLD_SOUNDS = (
    "sound/world/flesh1.wav",
    "sound/world/flesh2.wav",
    "sound/world/ric1.wav",
    "sound/world/ric2.wav",
    "sound/world/ric3.wav",
    "sound/world/spark1.wav",
    "sound/world/spark2.wav",
    "sound/world/spark3.wav",
    "sound/world/spark5.wav",
    "sound/world/spark6.wav",
    "sound/world/spark7.wav",
    "sound/world/water1.wav",
)


def format_size(size):
    for unit in ("B", "KiB", "MiB", "GiB"):
        if size < 1024 or unit == "GiB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{size} {unit}"
        size /= 1024


def read_wav_samples(payload):
    with wave.open(io.BytesIO(payload), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    if channels != 1 or sample_width != 2:
        raise PakError("Only mono 16-bit PCM WAV conversion is supported")

    samples = array.array("h")
    samples.frombytes(frames)
    if sys.byteorder != "little":
        samples.byteswap()

    return sample_rate, samples


def resample_linear(samples, source_rate, target_rate):
    if source_rate == target_rate:
        return samples

    output_len = max(1, int(round(len(samples) * target_rate / source_rate)))
    output = array.array("h")
    scale = source_rate / target_rate
    max_index = len(samples) - 1

    for index in range(output_len):
        position = index * scale
        left = int(position)
        if left >= max_index:
            output.append(samples[max_index])
            continue

        fraction = position - left
        value = int(samples[left] * (1 - fraction) + samples[left + 1] * fraction)
        output.append(max(-32768, min(32767, value)))

    return output


def convert_wav(payload, target_rate, target_width):
    source_rate, samples = read_wav_samples(payload)
    samples = resample_linear(samples, source_rate, target_rate)

    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setframerate(target_rate)

        if target_width == 1:
            wav.setsampwidth(1)
            wav.writeframes(bytes(max(0, min(255, (sample + 32768) >> 8)) for sample in samples))
        elif target_width == 2:
            wav.setsampwidth(2)
            if sys.byteorder != "little":
                samples = samples[:]
                samples.byteswap()
            wav.writeframes(samples.tobytes())
        else:
            raise PakError("Audio sample width must be 1 or 2 bytes")

    return output.getvalue()


def q2_unescape(value):
    return value.replace(r"\"", '"').replace(r"\\", "\\")


def lump_bounds(payload, lump_index):
    lump_offset = BSP_HEADER.size + lump_index * BSP_LUMP.size
    offset, length = BSP_LUMP.unpack_from(payload, lump_offset)
    if offset < 0 or length < 0 or offset + length > len(payload):
        raise PakError(f"BSP lump {lump_index} points outside the map")
    return offset, offset + length


def parse_bsp(payload):
    if len(payload) < BSP_HEADER.size + BSP_LUMP_COUNT * BSP_LUMP.size:
        raise PakError("BSP is too small")

    magic, version = BSP_HEADER.unpack_from(payload, 0)
    if magic != b"IBSP" or version != 38:
        raise PakError("Expected a Quake II IBSP version 38 map")

    entity_start, entity_end = lump_bounds(payload, BSP_LUMP_ENTITIES)
    entity_text = payload[entity_start:entity_end].split(b"\0", 1)[0].decode("latin1", "ignore")
    entities = []
    for block in ENTITY_BLOCK_RE.findall(entity_text):
        entity = {}
        for key, value in ENTITY_PAIR_RE.findall(block):
            entity[q2_unescape(key).lower()] = q2_unescape(value)
        if entity:
            entities.append(entity)

    texinfo_start, texinfo_end = lump_bounds(payload, BSP_LUMP_TEXINFO)
    texinfo_len = texinfo_end - texinfo_start
    if texinfo_len % TEXINFO_SIZE != 0:
        raise PakError("BSP texinfo lump has an unexpected size")

    textures = set()
    for offset in range(texinfo_start, texinfo_end, TEXINFO_SIZE):
        raw_name = payload[offset + TEXINFO_TEXTURE_OFFSET : offset + TEXINFO_TEXTURE_OFFSET + TEXINFO_TEXTURE_SIZE]
        texture = raw_name.split(b"\0", 1)[0].decode("ascii", "ignore").strip().lower()
        if texture:
            textures.add(texture)

    return entities, textures


def source_glob(source, pattern):
    normalized_pattern = normalize_name(pattern)
    return sorted(name for name in source if fnmatch.fnmatch(name, normalized_pattern))


def add_file(source, kept, missing, name, strict=False):
    normalized = normalize_name(name)
    if normalized in source:
        kept.add(normalized)
        return
    if strict:
        missing.append(normalized)


def add_pattern(source, kept, pattern):
    for name in source_glob(source, pattern):
        kept.add(name)


def add_texture(source, kept, missing, texture):
    texture_name = texture[:-4] if texture.endswith(".wal") else texture
    path = f"textures/{texture_name}.wal"
    add_file(source, kept, missing, path, strict=True)

    basename = texture_name.rsplit("/", 1)[-1]
    directory = texture_name.rsplit("/", 1)[0] if "/" in texture_name else ""
    if basename.startswith("+") and len(basename) > 2:
        animated_pattern = f"textures/{directory}/+?{basename[2:]}.wal" if directory else f"textures/+?{basename[2:]}.wal"
        add_pattern(source, kept, animated_pattern)


def add_sky(source, kept, sky_name):
    if not sky_name:
        return

    sky = sky_name.lower()
    separator = "" if sky.endswith("_") else "_"
    for suffix in SKY_SUFFIXES:
        add_pattern(source, kept, f"env/{sky}{separator}{suffix}.*")


def sound_path_from_noise(noise):
    sound = noise.lower().strip().replace("\\", "/")
    if not sound:
        return None
    if not sound.startswith("sound/"):
        sound = f"sound/{sound}"
    if "." not in Path(sound).name:
        sound = f"{sound}.wav"
    return sound


def map_asset_set(source, map_path, extra_globs):
    normalized_map = normalize_name(map_path)
    if normalized_map not in source:
        raise PakError(f"Map not found in source PAK: {normalized_map}")

    entities, textures = parse_bsp(source[normalized_map])
    kept = set()
    missing = []
    class_counts = Counter(entity.get("classname", "<unknown>") for entity in entities)
    classnames = set(class_counts)
    worldspawn = next((entity for entity in entities if entity.get("classname") == "worldspawn"), {})

    add_file(source, kept, missing, normalized_map, strict=True)
    add_file(source, kept, missing, "default.cfg")
    add_file(source, kept, missing, "maps.lst")

    for pattern in COMMON_PATTERNS:
        add_pattern(source, kept, pattern)

    for pattern in DEFAULT_WEAPON_PATTERNS:
        add_pattern(source, kept, pattern)

    for texture in sorted(textures):
        add_texture(source, kept, missing, texture)

    add_sky(source, kept, worldspawn.get("sky", ""))

    for sound in COMMON_WORLD_SOUNDS:
        add_pattern(source, kept, sound)

    for entity in entities:
        noise = entity.get("noise")
        if noise:
            sound = sound_path_from_noise(noise)
            if sound:
                add_file(source, kept, missing, sound, strict=True)

    for classname in classnames:
        for prefix, patterns in CLASS_PATTERNS:
            if classname.startswith(prefix):
                for pattern in patterns:
                    add_pattern(source, kept, pattern)

        for pattern in ITEM_PATTERNS.get(classname, ()):
            add_pattern(source, kept, pattern)

        for pattern in WEAPON_SOUND_PATTERNS.get(classname, ()):
            add_pattern(source, kept, pattern)

    for pattern in extra_globs:
        add_pattern(source, kept, pattern)

    if missing:
        raise PakError("Missing required map assets:\n  " + "\n  ".join(sorted(set(missing))))

    return kept, entities, textures, class_counts


def reduce_map_pak(args):
    source = read_pak(args.input)
    kept, entities, textures, class_counts = map_asset_set(source, args.map, args.extra_glob)
    output_files = {}

    for name in sorted(kept):
        payload = source[name]
        if args.audio_rate and name.startswith("sound/") and name.endswith(".wav"):
            payload = convert_wav(payload, args.audio_rate, args.audio_width)
        output_files[name] = payload

    write_pak(args.output, output_files)

    source_size = sum(len(payload) for payload in source.values())
    output_size = sum(len(payload) for payload in output_files.values())
    worldspawn = next((entity for entity in entities if entity.get("classname") == "worldspawn"), {})
    message = worldspawn.get("message", args.map)
    sky = worldspawn.get("sky", "<none>")

    print(f"Map: {args.map} ({message})")
    print(f"Sky: {sky}")
    print(f"Entities: {len(entities)} entities, {len(class_counts)} class names")
    print(f"Textures: {len(textures)} BSP texture references")
    if args.audio_rate:
        print(f"Audio: converted retained WAVs to {args.audio_rate}Hz {args.audio_width * 8}-bit mono")
    print(f"Source: {len(source)} files, {format_size(source_size)}")
    print(f"Reduced: {len(output_files)} files, {format_size(output_size)}")
    print(f"Wrote: {args.output}")


def main():
    parser = argparse.ArgumentParser(
        description="Build a conservative single-map Quake II PAK from a full or demo PAK."
    )
    parser.add_argument("--input", required=True, help="Input pak0.pak")
    parser.add_argument("--output", required=True, help="Output reduced PAK")
    parser.add_argument("--map", default="maps/demo1.bsp", help="Map BSP to keep")
    parser.add_argument(
        "--extra-glob",
        action="append",
        default=[],
        help="Additional PAK glob to keep; can be provided more than once",
    )
    parser.add_argument(
        "--audio-rate",
        type=int,
        default=0,
        help="Convert retained WAVs to this sample rate; 0 keeps original audio",
    )
    parser.add_argument(
        "--audio-width",
        type=int,
        choices=(1, 2),
        default=1,
        help="Converted WAV sample width in bytes",
    )

    args = parser.parse_args()
    try:
        reduce_map_pak(args)
        return 0
    except (OSError, PakError, UnicodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
