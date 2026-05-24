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
        width: 800,
        height: 600,
        inputMode: "wearable",
        lowLatencyControls: true,
        audioEnabled: false,
        yawSensitivity: 2.4,
        turnBurstDegrees: 14,
        headTickMs: 50
      }
    : {
        width: 960,
        height: 720,
        inputMode: "desktop",
        lowLatencyControls: false,
        audioEnabled: true,
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
  onStatus,
  onLog
}) {
  const log = (text) => bootLog(output, text, onLog);

  try {
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

    const module = createModule({ canvas, output, status, config, onStatus, onLog });
    const runtimeReady = new Promise((resolve, reject) => {
      module.onRuntimeInitialized = () => resolve();
      module.onAbort = (reason) => reject(new Error(String(reason || "Quake II aborted")));
    });
    window.Module = module;

    log("Loading engine script...");
    await withTimeout(loadScript(`${ENGINE_BASE}quake2.js`), TIMEOUTS.script, "engine script load");

    log("Waiting for WebAssembly runtime...");
    await withTimeout(runtimeReady, TIMEOUTS.runtime, "WebAssembly runtime initialization");
    log("Runtime initialized");

    log("Installing PAK data...");
    await withTimeout(
      installPakData(module.FS, onStatus, {
        writablePath: false,
        log
      }),
      TIMEOUTS.pak,
      "PAK install"
    );

    if (typeof module.callMain !== "function") {
      throw new Error("Quake II runtime did not expose callMain");
    }

    log("Starting Quake II main...");
    module.callMain([...module.arguments]);
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
      }
    };
  } catch (error) {
    log(`Error: ${error.message || error}`);
    throw error;
  }
}

function createModule({ canvas, output, status, config, onStatus, onLog }) {
  return {
    _canLockPointer: false,
    canvas,
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
    q2InstallPendingData: (FS) => installPakData(FS, onStatus, {
      log: (text) => bootLog(output, text, onLog)
    }),
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
    "+set", "vid_width", String(config.width),
    "+set", "vid_height", String(config.height),
    "+set", "gl_msaa_samples", "0",
    "+set", "s_initsound", config.audioEnabled ? "1" : "0",
    "+set", "cl_run", "0",
    "+set", "cl_forwardspeed", config.inputMode === "wearable" ? "120" : "200",
    "+set", "cl_sidespeed", "120"
  ];

  const queryArgs = new URLSearchParams(window.location.search).get("args");
  if (queryArgs) {
    args.push(...queryArgs.trim().split(/\s+/));
  }

  return args;
}

async function installPakData(FS, onStatus, options = {}) {
  const settings = {
    writablePath: true,
    log: null,
    ...options
  };
  settings.log?.("Reading imported PAK storage...");
  const storedBytes = await readPakBytes();

  if (storedBytes) {
    onStatus?.("Installing imported PAK...");
    settings.log?.(`Installing imported PAK (${formatByteCount(storedBytes.byteLength)})...`);
    writePak(FS, storedBytes, "imported", settings);
    return;
  }

  if (fileExists(FS, "/baseq2/pak0.pak")) {
    onStatus?.("Bundled demo PAK ready");
    settings.log?.("Bundled demo PAK is already mounted");
    console.info("Bundled demo PAK is embedded at /baseq2/pak0.pak");
    return;
  }

  const bundledBytes = await readBundledPakBytes(onStatus, settings.log);
  if (bundledBytes) {
    settings.log?.(`Installing bundled PAK (${formatByteCount(bundledBytes.byteLength)})...`);
    writePak(FS, bundledBytes, "bundled", settings);
  }
}

async function readBundledPakBytes(onStatus, log) {
  if ("DecompressionStream" in globalThis) {
    onStatus?.("Loading compressed demo PAK...");
    log?.("Fetching compressed demo PAK...");
    const compressed = await fetchBytes(BUNDLED_PAK_GZIP_URL);
    if (compressed) {
      onStatus?.("Decompressing demo PAK...");
      log?.(`Decompressing demo PAK (${formatByteCount(compressed.byteLength)} compressed)...`);
      return decompressGzip(compressed);
    }
    log?.("Compressed demo PAK was not found; trying raw PAK...");
  }

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
    try {
      FS.mkdir(current);
    } catch (error) {
      if (!String(error).includes("File exists")) {
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
