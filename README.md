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

This repo includes reducer scripts for the first demo map:

```bash
npm run reduce:first-map:wearable
```

The wearable reduction keeps first-level weapons, enemies, pickups, decorative map entities, sprite effects, and audio. It preserves audio content by converting retained WAVs to 10 kHz 8-bit mono PCM, then relies on gzip transfer compression.

For custom experiments, use the lower-level reducer config:

```bash
python3 scripts/paktool.py reduce scripts/reduced-pak.example.json
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
- Auto-respawn waits 3 seconds after death, then triggers respawn without requiring manual menu input.
- Wearable comfort defaults slow the forward movement feel and avoid rapid continuous turning.

The client input patch exports:

```c
EMSCRIPTEN_KEEPALIVE
void Q2_AddViewAngles(float dyaw, float dpitch);
```

JavaScript reads head orientation, calculates a yaw step, and calls the engine directly.

## Web App

Install dependencies and run locally:

```bash
npm install
npm run dev
```

Build the Pages artifact:

```bash
npm run build
```

Validate the web build and PAK tooling:

```bash
npm run check
```
