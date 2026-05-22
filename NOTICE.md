# Notices

This repository is a web app shell, source patch, and packaging workflow for a GLQuake II-style WebAssembly build.

Engine baseline:

- Qwasm2: <https://github.com/GMH-Code/Qwasm2>
- Yamagi Quake II: <https://www.yamagi.org/quake2/>
- Emscripten: <https://emscripten.org/>

The Quake II engine code used by Qwasm2/Yamagi is GPL-licensed. This repository keeps generated WebAssembly artifacts and game data out of git by default.

Quake II game data is not included. Provide your own legally usable data and reduce it locally before importing it into the browser app or embedding it in a private build.
