# GLQuake II Display

This is an open-source Quake II-compatible engine/demo for Meta Ray-Ban Display. It is designed around a Qwasm2/Yamagi Quake II engine build, a user-supplied `baseq2/pak0.pak`, Meta Neural Band gesture input, and W3C `DeviceOrientationEvent` head turning.

This repo does not include Quake II game data. To play, users must own Quake II and provide their own `baseq2/pak0.pak`.

## Play URL

URL:

```text
https://phdev.github.io/glquake2-rayban-display/?pak=
```

Add the URL for your legally obtained `baseq2/pak0.pak` after `?pak=`. The PAK URL should be URL-encoded:

```text
https://phdev.github.io/glquake2-rayban-display/?pak=https%3A%2F%2Fexample.com%2Fbaseq2%2Fpak0.pak
```

The PAK must be served over HTTP(S) with browser fetch access enabled. A local filesystem path such as `/Users/.../pak0.pak` cannot be fetched by the hosted app. After the first successful URL load, the app caches the PAK in browser storage for later launches with the same URL.

## Optimize Your PAK

For the smallest download size that works well on Meta Ray-Ban Display, build a reduced single-level package from your own legally obtained Quake II data.

Recommended target:

- Start with your owned `baseq2/pak0.pak`.
- Keep one playable map, usually `maps/demo1.bsp`.
- Keep all textures, skybox files, models, animations, HUD/status assets, weapons, enemies, pickups, decorative map entities, sprite effects, and audio referenced by that map.
- Remove unused maps, cinematics, music, demos, multiplayer-only files, and assets never referenced by the target map.
- Convert retained WAV audio to lower-rate PCM to reduce size while preserving first-level sounds.
- Gzip the final PAK for transfer; the app can load a compressed PAK source when the browser supports decompression.

Do not delete by folder or filename alone. Quake II asset dependencies are connected, so run a dependency pass first: launch the target map with the full local data set, capture loaded and missing asset paths from the engine log, then remove only files that are not referenced. Restore required files or add tiny valid placeholders when missing sounds create repeated log noise.

Use this example prompt with a local LLM or coding agent that can run commands on your machine. Do not paste or upload copyrighted PAK contents into a third-party chat service.

```text
I own Quake II and have a legally obtained PAK at:

INPUT_PAK=/absolute/path/to/baseq2/pak0.pak

Optimize this PAK for the GLQuake II Meta Ray-Ban Display web app.

Goal:
- Create a reduced first-level PAK for maps/demo1.bsp.
- Minimize download size while preserving everything needed for a correct first-level experience.
- Output:
  - /absolute/path/to/output/baseq2/pak0.pak
  - /absolute/path/to/output/baseq2/pak0.pak.gz
  - a short report with original size, reduced size, gzip size, retained file count, removed file count, and any missing-file fixes.

Rules:
- Do not include Quake II data in source control.
- Do not remove weapons, enemies, pickups, decorative map entities, sprite effects, HUD/status assets, player assets, or audio that are used in the first level.
- Do not delete assets only by folder or filename.
- Preserve all textures, skybox files, models, animations, sounds, sprites, images, and config files referenced by maps/demo1.bsp or by entities/classes used in that map.
- If a missing sound causes runtime spam, restore the real retained sound when it belongs to the first level. Use tiny valid placeholders only for non-gameplay paths that are required but not meaningfully used.
- Convert retained WAV audio to 10 kHz 8-bit mono PCM where possible, but keep it valid WAV audio.
- Gzip the final PAK for transfer.

Suggested steps:
1. Work in a temporary directory and leave INPUT_PAK unchanged.
2. Use this repository's PAK tools where possible.
3. Inventory INPUT_PAK and parse maps/demo1.bsp for referenced textures, sky, entity classes, target sounds, and speaker sounds.
4. Build a dependency keep-list for first-level monsters, items, weapons, effects, HUD/status assets, player assets, and all referenced audio.
5. Create a reduced PAK containing only the keep-list.
6. Convert retained WAVs to lower-rate PCM and repack.
7. Run a validation pass that checks:
   - the output starts with the PACK magic,
   - maps/demo1.bsp exists,
   - pics/colormap.pcx and required HUD/status images exist,
   - no referenced first-level asset is missing.
8. If the engine can be launched locally, boot the app with the reduced PAK and inspect logs for missing files. Restore any first-level asset that is missing.
9. Write pak0.pak.gz and report final sizes.

Prefer commands that can be rerun, and show the exact commands used.
```

## Controls

Meta Neural Band gestures are translated through platform input events into Quake II actions:

- Pinch tap -> toggle perpetual forward
- Swipe up -> jump
- Swipe down -> recenter IMU
- Swipe left/right -> large turn burst

Auto-fire engages when a valid enemy target is centered in view. When auto-fire starts, sticky forward is toggled off and IMU yaw sensitivity is halved while firing.

The app intercepts platform navigation-style input in the capture phase so the WebView layer has less opportunity to consume it first. The primary camera path is the exported C function, not browser-generated mouse movement.

## Game-Module Changes

Gameplay changes live in the Quake II C game module:

- Auto-fire traces forward from the player view and injects attack when a valid hostile target is centered.
- Wearable comfort defaults slow the forward movement feel and avoid rapid continuous turning.

The client input patch exports:

```c
EMSCRIPTEN_KEEPALIVE
void Q2_AddViewAngles(float dyaw, float dpitch);
```

JavaScript reads head orientation, calculates a yaw step, and calls the engine directly.
