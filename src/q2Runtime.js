import { readPakBytes } from "./storage.js";

const ENGINE_BASE = `${import.meta.env.BASE_URL}wasm/`;
const BUNDLED_PAK_PATH = "baseq2/pak0.pak";
const BUNDLED_PAK_URL = `${ENGINE_BASE}${BUNDLED_PAK_PATH}`;
const BUNDLED_PAK_GZIP_URL = `${BUNDLED_PAK_URL}.gz`;
const TIMEOUTS = {
  probe: 15000,
  script: 20000,
  runtime: 30000,
  pak: 90000
};
const REQUIRED_ENGINE_FILES = [
  "quake2.js",
  "quake2.wasm",
  "quake2.data",
  "game_baseq2.wasm",
  "ref_gles3.wasm"
];

const GENERATED_FILE_MAP = new Map([
  ["index.wasm", "quake2.wasm"],
  ["index.data", "quake2.data"]
]);

export function createRuntimeConfig() {
  var glassesDetected =
    /Android.*wv/.test(navigator.userAgent)
    || screen.width <= 640;

  return glassesDetected
    ? {
        width: 600,
        height: 600,
        inputMode: "wearable",
        lowLatencyControls: true,
        audioEnabled: false,
        yawSensitivity: 2.4,
        turnBurstDegrees: 14,
        headTickMs: 50
      }
    : {
        width: 600,
        height: 600,
        inputMode: "desktop",
        lowLatencyControls: false,
        audioEnabled: false,
        yawSensitivity: 1.8,
        turnBurstDegrees: 10,
        headTickMs: 50
      };
}

export async function probeEngineArtifacts() {
  const checks = await Promise.all(
    REQUIRED_ENGINE_FILES.map(async (file) => {
      try {
        const response = await fetch(`${ENGINE_BASE}${file}`, {
          method: "HEAD",
          cache: "no-store"
        });
        return [file, response.ok];
      } catch {
        return [file, false];
      }
    })
  );

  return checks
    .filter(([, ok]) => !ok)
    .map(([file]) => file);
}

export async function probeBundledPak() {
  try {
    const gzipResponse = await fetch(BUNDLED_PAK_GZIP_URL, {
      method: "HEAD",
      cache: "no-store"
    });

    if (gzipResponse.ok) {
      return {
        name: "Compressed Quake II demo pak0.pak",
        size: Number(gzipResponse.headers.get("content-length") || 0),
        url: BUNDLED_PAK_GZIP_URL
      };
    }

    const response = await fetch(BUNDLED_PAK_URL, {
      method: "HEAD",
      cache: "no-store"
    });

    if (!response.ok) {
      return null;
    }

    return {
      name: "Quake II demo pak0.pak",
      size: Number(response.headers.get("content-length") || 0),
      url: BUNDLED_PAK_URL
    };
  } catch {
    return null;
  }
}

export async function bootQuake2({
  canvas,
  output,
  status,
  config,
  onEnemyIndicators,
  onProgress,
  onStatus,
  onLog
}) {
  const log = (text) => bootLog(output, text, onLog);
  const progress = (percent, label) => onProgress?.({ percent, label });

  try {
    progress(2, "Checking files");
    log("Checking engine artifacts...");
    const missing = await withTimeout(
      probeEngineArtifacts(),
      TIMEOUTS.probe,
      "engine artifact check"
    );

    if (missing.length > 0) {
      throw new Error(`Missing engine artifact: ${missing.join(", ")}`);
    }

    canvas.width = config.width;
    canvas.height = config.height;
    canvas.style.aspectRatio = `${config.width} / ${config.height}`;
    log(`Canvas configured at ${config.width}x${config.height} for ${config.inputMode}`);

    progress(16, "Loading engine");
    const module = createModule({
      canvas,
      output,
      status,
      config,
      progress,
      onEnemyIndicators,
      onStatus,
      onLog
    });
    const runtimeReady = new Promise((resolve, reject) => {
      module.onRuntimeInitialized = () => resolve();
      module.onAbort = (reason) => reject(new Error(String(reason || "Quake II aborted")));
    });
    window.Module = module;

    log("Loading engine script...");
    await withTimeout(loadScript(`${ENGINE_BASE}quake2.js`), TIMEOUTS.script, "engine script load");

    progress(28, "Preparing runtime");
    log("Waiting for WebAssembly runtime...");
    await withTimeout(runtimeReady, TIMEOUTS.runtime, "WebAssembly runtime initialization");
    progress(42, "Runtime ready");
    log("Runtime initialized");

    progress(48, "Loading data");
    log("Installing PAK data...");
    await withTimeout(
      installPakData(module.FS, onStatus, {
        writablePath: false,
        progress,
        log
      }),
      TIMEOUTS.pak,
      "PAK install"
    );

    progress(72, "Configuring");
    installRuntimeConfig(module.FS, config, log);

    if (typeof module.callMain !== "function") {
      throw new Error("Quake II runtime did not expose callMain");
    }

    progress(78, "Starting engine");
    log("Starting Quake II main...");
    module.callMain([...module.arguments]);
    progress(82, "Starting Quake II");
    log("Quake II main started");

    return {
      module,
      callAddViewAngles(dyaw, dpitch) {
        if (typeof module._Q2_AddViewAngles === "function") {
          module._Q2_AddViewAngles(dyaw, dpitch);
        }
      },
      setWearableAction(action, down) {
        if (typeof module._Q2_SetWearableAction === "function") {
          module._Q2_SetWearableAction(action, down ? 1 : 0);
        }
      },
      readEnemyIndicators() {
        if (typeof module._Q2_GetEnemyIndicators === "function") {
          const mask = module._Q2_GetEnemyIndicators();
          return {
            left: Boolean(mask & 1),
            right: Boolean(mask & 2)
          };
        }

        return {
          left: Boolean(module.q2EnemyIndicators?.left),
          right: Boolean(module.q2EnemyIndicators?.right)
        };
      },
      requestEnemyTurn(direction) {
        const normalized = direction < 0 ? -1 : direction > 0 ? 1 : 0;
        if (typeof module._Q2_RequestEnemyTurn === "function") {
          module._Q2_RequestEnemyTurn(normalized);
          return;
        }

        module.q2EnemyTurnRequest = normalized;
      }
    };
  } catch (error) {
    log(`Error: ${formatError(error)}`);
    throw error;
  }
}

function createModule({
  canvas,
  output,
  status,
  config,
  progress,
  onEnemyIndicators,
  onStatus,
  onLog
}) {
  return {
    _canLockPointer: false,
    canvas,
    q2EnemyTurnRequest: 0,
    q2EnemyIndicators: { left: false, right: false },
    q2ConsumeEnemyTurn() {
      const direction = this.q2EnemyTurnRequest;
      this.q2EnemyTurnRequest = 0;
      return direction;
    },
    q2SetEnemyIndicators(left, right) {
      this.q2EnemyIndicators = {
        left: Boolean(left),
        right: Boolean(right)
      };
      onEnemyIndicators?.({
        left: Boolean(left),
        right: Boolean(right)
      });
    },
    q2TurnToEnemyYaw(yaw) {
      if (typeof this._Q2_SetViewYaw === "function") {
        this._Q2_SetViewYaw(yaw);
      }
    },
    print(text) {
      appendOutput(output, text);
      onLog?.(text);
    },
    printErr(text) {
      appendOutput(output, text);
      onLog?.(text);
    },
    locateFile(path) {
      return `${ENGINE_BASE}${GENERATED_FILE_MAP.get(path) ?? path}`;
    },
    setStatus(text) {
      if (status) {
        status.textContent = text || "Running";
      }
      onStatus?.(text || "Running");
    },
    hideConsole() {
      canvas.classList.add("is-running");
    },
    showConsole() {
      canvas.classList.remove("is-running");
    },
    winResized() {},
    setGamma(value) {
      const gamma = Number(Number(value).toFixed(2));
      canvas.style.filter = gamma < 0 ? "" : `brightness(${gamma * 2})`;
    },
    captureMouse() {},
    q2InstallPendingData: async (FS) => {
      const log = (text) => bootLog(output, text, onLog);
      progress?.(48, "Loading data");
      await installPakData(FS, onStatus, { progress, log });
      progress?.(72, "Configuring");
      installRuntimeConfig(FS, config, log, { writablePath: true });
    },
    noInitialRun: true,
    totalDependencies: 0,
    monitorRunDependencies(left) {
      this.totalDependencies = Math.max(this.totalDependencies, left);
      this.setStatus(
        left
          ? `Preparing ${this.totalDependencies - left}/${this.totalDependencies}`
          : "Ready"
      );
    },
    arguments: buildArguments(config)
  };
}

function buildArguments(config) {
  const args = [
    "+set", "vid_renderer", "gles3",
    "+set", "r_mode", "-1",
    "+set", "r_customwidth", String(config.width),
    "+set", "r_customheight", String(config.height),
    "+set", "vid_width", String(config.width),
    "+set", "vid_height", String(config.height),
    "+set", "gl_msaa_samples", "0",
    "+set", "s_initsound", config.audioEnabled ? "1" : "0",
    "+set", "cl_run", "0",
    "+set", "cl_forwardspeed", config.inputMode === "wearable" ? "120" : "200",
    "+set", "cl_sidespeed", "120"
  ];

  const queryArgs = new URLSearchParams(window.location.search).get("args");
  const extraArgs = queryArgs ? queryArgs.trim().split(/\s+/).filter(Boolean) : [];

  args.push(...extraArgs);

  if (!hasStartupCommand(extraArgs)) {
    args.push("+map", "demo1");
  }

  return args;
}

function hasStartupCommand(args) {
  const commands = new Set(["+map", "+demomap", "+connect", "+load"]);
  return args.some((arg) => commands.has(arg.toLowerCase()));
}

function installRuntimeConfig(FS, config, log, options = {}) {
  const runtimeConfig = buildWasmConfig(config);
  const autoexecConfig = buildAutoexecConfig(config);

  mkdirTree(FS, "/baseq2");
  FS.writeFile("/baseq2/wasm.cfg", runtimeConfig);
  FS.writeFile("/baseq2/autoexec.cfg", autoexecConfig);

  if (options.writablePath) {
    mkdirTree(FS, "/qwasm2/baseq2");
    FS.writeFile("/qwasm2/baseq2/wasm.cfg", runtimeConfig);
    FS.writeFile("/qwasm2/baseq2/autoexec.cfg", autoexecConfig);
  }

  log(`Installed runtime config (${config.width}x${config.height})`);
}

function buildWasmConfig(config) {
  return [
    "// GLQuake II Display runtime configuration",
    "set name \"WASM Player\"",
    "set sensitivity \"6\"",
    "set cl_run \"0\"",
    "set vid_fullscreen \"0\"",
    `set r_customwidth "${config.width}"`,
    `set r_customheight "${config.height}"`,
    `set vid_width "${config.width}"`,
    `set vid_height "${config.height}"`,
    "set r_mode \"-1\"",
    "set r_vsync \"0\"",
    "set gl_texturemode \"GL_LINEAR_MIPMAP_LINEAR\"",
    "set gl1_intensity \"1.5\"",
    "set gl1_overbrightbits \"1\"",
    "set gl3_intensity \"2\"",
    "set r_consolescale \"1\"",
    "set r_hudscale \"1\"",
    "set r_menuscale \"1\"",
    "set crosshair_scale \"1\"",
    "bind w \"+forward\"",
    "bind s \"+back\"",
    "bind a \"+moveleft\"",
    "bind d \"+moveright\"",
    "bind MOUSE1 \"+attack\"",
    "bind MOUSE2 \"+forward\"",
    "bind MOUSE3 \"+moveup\"",
    "bind MWHEELDOWN \"weapnext\"",
    "bind MWHEELUP \"weapprev\"",
    "bind z \"use silencer\"",
    "bind f \"+lookup\"",
    "bind v \"+lookdown\"",
    "echo \"Display runtime config loaded\"",
    ""
  ].join("\n");
}

function buildAutoexecConfig(config) {
  return [
    "set vid_fullscreen \"0\"",
    `set r_customwidth "${config.width}"`,
    `set r_customheight "${config.height}"`,
    `set vid_width "${config.width}"`,
    `set vid_height "${config.height}"`,
    "set r_mode \"-1\"",
    "alias d1 \"map demo1\"",
    "set nextserver \"\"",
    ""
  ].join("\n");
}

async function installPakData(FS, onStatus, options = {}) {
  const settings = {
    writablePath: true,
    progress: null,
    log: null,
    ...options
  };
  settings.progress?.(50, "Reading data");
  settings.log?.("Reading imported PAK storage...");
  const storedBytes = await readPakBytes();

  if (storedBytes) {
    settings.progress?.(58, "Installing PAK");
    onStatus?.("Installing imported PAK...");
    settings.log?.(`Installing imported PAK (${formatByteCount(storedBytes.byteLength)})...`);
    writePak(FS, storedBytes, "imported", settings);
    settings.progress?.(68, "PAK ready");
    return;
  }

  if (fileExists(FS, "/baseq2/pak0.pak")) {
    settings.progress?.(68, "PAK ready");
    onStatus?.("Bundled demo PAK ready");
    settings.log?.("Bundled demo PAK is already mounted");
    console.info("Bundled demo PAK is embedded at /baseq2/pak0.pak");
    return;
  }

  const bundledBytes = await readBundledPakBytes(onStatus, settings.log, settings.progress);
  if (bundledBytes) {
    settings.progress?.(64, "Installing PAK");
    settings.log?.(`Installing bundled PAK (${formatByteCount(bundledBytes.byteLength)})...`);
    writePak(FS, bundledBytes, "bundled", settings);
    settings.progress?.(68, "PAK ready");
  }
}

async function readBundledPakBytes(onStatus, log, progress) {
  if ("DecompressionStream" in globalThis) {
    progress?.(54, "Fetching PAK");
    onStatus?.("Loading compressed demo PAK...");
    log?.("Fetching compressed demo PAK...");
    const compressed = await fetchBytes(BUNDLED_PAK_GZIP_URL);
    if (compressed) {
      if (isGzipPayload(compressed)) {
        progress?.(60, "Decompressing PAK");
        onStatus?.("Decompressing demo PAK...");
        log?.(`Decompressing demo PAK (${formatByteCount(compressed.byteLength)} compressed)...`);
        return decompressGzip(compressed);
      }

      progress?.(60, "Loading PAK");
      log?.(`Using browser-decoded demo PAK (${formatByteCount(compressed.byteLength)})...`);
      return compressed;
    }
    log?.("Compressed demo PAK was not found; trying raw PAK...");
  }

  progress?.(54, "Fetching PAK");
  onStatus?.("Loading demo PAK...");
  log?.("Fetching raw demo PAK...");
  const bytes = await fetchBytes(BUNDLED_PAK_URL);
  if (!bytes) {
    onStatus?.("No PAK available");
    log?.("No bundled PAK was available");
  }

  return bytes;
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "force-cache" });

  if (!response.ok) {
    return null;
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function decompressGzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function writePak(FS, pakBytes, source, options) {
  if (!isPakPayload(pakBytes)) {
    throw new Error(`${source} data is not a valid Quake II PAK`);
  }

  mkdirTree(FS, "/baseq2");
  FS.writeFile("/baseq2/pak0.pak", pakBytes);

  if (options.writablePath) {
    mkdirTree(FS, "/qwasm2/baseq2");
    FS.writeFile("/qwasm2/baseq2/pak0.pak", pakBytes);
    console.info(`Installed ${source} PAK at /baseq2/pak0.pak and /qwasm2/baseq2/pak0.pak`);
  } else {
    console.info(`Installed ${source} PAK at /baseq2/pak0.pak`);
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timer);
  });
}

function bootLog(output, text, onLog) {
  const line = `[boot] ${text}`;
  appendOutput(output, line);
  onLog?.(line);
  console.info(line);
}

function formatByteCount(value) {
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;

  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }

  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatError(error) {
  if (error?.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isGzipPayload(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isPakPayload(bytes) {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x41 &&
    bytes[2] === 0x43 &&
    bytes[3] === 0x4b
  );
}

function fileExists(FS, path) {
  try {
    return FS.analyzePath(path).exists;
  } catch {
    return false;
  }
}

function mkdirTree(FS, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;
    if (fileExists(FS, current)) {
      continue;
    }

    try {
      FS.mkdir(current);
    } catch (error) {
      if (!fileExists(FS, current)) {
        throw error;
      }
    }
  }
}

function appendOutput(output, text) {
  if (!output) {
    return;
  }

  output.value += `${text}\n`;
  output.scrollTop = output.scrollHeight;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}
