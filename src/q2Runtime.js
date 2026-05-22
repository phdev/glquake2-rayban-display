import { readPakBytes } from "./storage.js";

const ENGINE_BASE = `${import.meta.env.BASE_URL}wasm/`;
const REQUIRED_ENGINE_FILES = [
  "quake2.js",
  "quake2.wasm",
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

export async function bootQuake2({
  canvas,
  output,
  status,
  config,
  onStatus,
  onLog
}) {
  const missing = await probeEngineArtifacts();

  if (missing.length > 0) {
    throw new Error(`Missing engine artifact: ${missing.join(", ")}`);
  }

  canvas.width = config.width;
  canvas.height = config.height;
  canvas.style.aspectRatio = `${config.width} / ${config.height}`;

  const module = createModule({ canvas, output, status, config, onStatus, onLog });
  window.Module = module;

  await loadScript(`${ENGINE_BASE}quake2.js`);

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
    q2InstallPendingData: installStoredPak,
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

async function installStoredPak(FS) {
  const pakBytes = await readPakBytes();

  if (!pakBytes) {
    return;
  }

  mkdirTree(FS, "/qwasm2/baseq2");
  FS.writeFile("/qwasm2/baseq2/pak0.pak", pakBytes);
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
