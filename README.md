# GLQuake II Display

Meta Ray-Ban Display Developer Preview web app shell for a GLQuake II-style WebAssembly build. The app is designed around a Qwasm2/Yamagi Quake II engine build, a reduced user-supplied `baseq2/pak0.pak`, Meta Neural Band gesture input, and W3C `DeviceOrientationEvent` head turning.

GLQuake II is heavier than Quake 1. Treat renderer choice, asset size, memory use, frame pacing, and wearable usability as first-order constraints.

## What Is Included

- Vite single-page app shell for GitHub Pages.
- Emscripten `Module` setup for `quake2.js`, `quake2.wasm`, `quake2.data`, and Qwasm2 side modules.
- Generic glasses-like runtime detection:

```js
var glassesDetected =
  /Android.*wv/.test(navigator.userAgent)
  || screen.width <= 640;
```

- 800x600 wearable profile and 960x720 desktop profile.
- Capture-phase gesture input normalization.
- Sticky forward movement, fire, jump plus fire, recenter, and turn burst actions.
- IMU yaw joystick model with a 50ms tick, 7.5 degree deadzone, and 30 degree max angle.
- Yaw meter overlay with grey, orange, and blue states.
- Qwasm2 patch for direct `Q2_AddViewAngles`, wearable action state, C game-module auto-fire, and 3 second auto-respawn.
- Automatic fallback to the Quake II demo PAK when no user PAK is imported.
- PAK read/write/reduction helper with silent WAV stub generation.
- GitHub Pages workflow.

## Controls

Meta Neural Band gestures are translated through platform input events into Quake II actions:

- Pinch tap -> toggle perpetual forward
- Swipe up -> fire
- Double swipe up -> jump + fire
- Swipe down -> recenter IMU
- Swipe left/right -> turn burst

The app intercepts platform navigation-style input in the capture phase so the WebView layer has less opportunity to consume it first. The primary camera path is the exported C function, not browser-generated mouse movement.

## Engine Build

This repo uses Qwasm2 as the practical WebAssembly baseline because it already has a browser-oriented OpenGL ES/WebGL path and separate game/renderer modules.

Install and activate the Emscripten SDK, build GL4ES for Emscripten, then run:

```bash
GL4ES_PATH=/absolute/path/to/gl4es_pic npm run build:qwasm2
```

Outputs copied into `public/wasm/`:

- `quake2.js`
- `quake2.wasm`
- `quake2.data`
- `game_baseq2.wasm`
- `ref_gles3.wasm`
- `ref_gl1.wasm`
- `ref_soft.wasm`

The default runtime starts with the GLES/WebGL renderer:

```text
+set vid_renderer gles3
```

SDL is the open-source Simple DirectMedia Layer. In this build it handles browser canvas, input, audio, and platform events through Emscripten compatibility layers.

## Game Data

Quake II data is not committed to this repository. The Pages workflow downloads the Quake II 3.14 demo package from the Yamagi mirror, verifies the package and `baseq2/pak0.pak`, reduces it to the first demo map, embeds that reduced PAK in the Emscripten data package, then publishes the reduced demo PAK and its accompanying license text as generated Pages artifacts. The app uses that embedded demo PAK when no user PAK has been imported.

You can still use your own legally usable `baseq2/pak0.pak`. A manually imported PAK takes precedence over the bundled demo PAK.

For a wearable build, create a reduced single-level package. Keep one playable map, required textures, required models and animations, HUD/status assets, one default weapon, and a minimal sound set. Remove unused maps, enemies, weapons, cinematics, music, multiplayer extras, and demos.

The included first-map reducer parses the target BSP, keeps its referenced textures, skybox, and speaker sounds, then adds the class-based Quake II assets needed by the monsters, items, weapons, effects, HUD, and player sounds used by that map:

```bash
npm run reduce:first-map
```

The Pages workflow uses the same reducer through `npm run install:demo-pak`. The default target is `maps/demo1.bsp`; override it with `Q2_DEMO_MAP=maps/demo2.bsp` for local experiments. Set `Q2_DEMO_REDUCE=no` to publish the verified full demo PAK instead.

Quake II asset dependencies are connected. Do a dependency pass first: launch the target map with a full local data set, capture loaded and missing asset paths from the engine log, then reduce only files that are not referenced. Restore required files or add tiny valid placeholders when missing sounds create repeated log noise.

Example reduction command:

```bash
python3 scripts/paktool.py reduce scripts/reduced-pak.example.json
```

The hosted app lets you import a reduced PAK into browser storage. The patched Qwasm2 filesystem bridge installs that package at startup; if there is no imported PAK, it installs the bundled demo PAK instead.

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

## GitHub Pages

The included workflow installs Emscripten, builds GL4ES, builds the patched Qwasm2 engine, installs the verified demo PAK, then deploys `dist/` on pushes to `main`. The public page hosts the shell, open-source engine artifacts, and the free electronically distributable demo data with its license.
