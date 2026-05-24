import "./styles.css";
import { createHeadTracking } from "./headTracking.js";
import { createRuntimeConfig, bootQuake2 } from "./q2Runtime.js";
import { createWearableInput } from "./wearableInput.js";

const app = document.querySelector("#app");
const runtimeConfig = createRuntimeConfig();

let engine = null;
let booting = false;
let headTracking = null;
let wearableInput = null;
let loadingProgress = 0;
let loadingHideTimer = 0;
let enemyIndicatorTimer = 0;
const enemyPresence = {
  left: false,
  right: false
};

app.innerHTML = `
  <main class="game-shell" aria-label="GLQuake II runtime">
    <canvas id="gameCanvas" class="game-canvas" tabindex="-1"></canvas>
    <div id="renderStatus" class="render-status" data-mode="unknown" aria-label="Renderer status">Renderer</div>
    <div id="enemyLeftIndicator" class="enemy-indicator enemy-indicator-left" aria-hidden="true"></div>
    <div id="enemyRightIndicator" class="enemy-indicator enemy-indicator-right" aria-hidden="true"></div>
    <section id="loadingPanel" class="loading-panel" role="status" aria-live="polite">
      <div id="loadingLabel" class="loading-label">Loading</div>
      <div
        id="loadingProgress"
        class="loading-track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="0"
      >
        <div id="loadingBar" class="loading-bar"></div>
      </div>
    </section>
    <div id="yawMeter" class="yaw-meter" data-zone="deadzone" aria-hidden="true"></div>
    <span id="statusText" class="runtime-hidden" aria-hidden="true"></span>
    <span id="imuStatus" class="runtime-hidden" aria-hidden="true"></span>
    <button id="consoleToggleButton" class="console-toggle" type="button" aria-expanded="false">Console</button>
    <section id="consolePanel" class="console-panel" hidden>
      <textarea id="consoleOutput" class="terminal-output" readonly spellcheck="false" aria-label="Terminal"></textarea>
    </section>
  </main>
`;

const refs = {
  canvas: document.querySelector("#gameCanvas"),
  renderStatus: document.querySelector("#renderStatus"),
  enemyLeftIndicator: document.querySelector("#enemyLeftIndicator"),
  enemyRightIndicator: document.querySelector("#enemyRightIndicator"),
  loadingPanel: document.querySelector("#loadingPanel"),
  loadingLabel: document.querySelector("#loadingLabel"),
  loadingProgress: document.querySelector("#loadingProgress"),
  loadingBar: document.querySelector("#loadingBar"),
  yawMeter: document.querySelector("#yawMeter"),
  statusText: document.querySelector("#statusText"),
  imuStatus: document.querySelector("#imuStatus"),
  consolePanel: document.querySelector("#consolePanel"),
  consoleToggleButton: document.querySelector("#consoleToggleButton"),
  consoleOutput: document.querySelector("#consoleOutput")
};

refs.canvas.width = runtimeConfig.width;
refs.canvas.height = runtimeConfig.height;
refs.canvas.style.aspectRatio = `${runtimeConfig.width} / ${runtimeConfig.height}`;
refs.consoleToggleButton.addEventListener("click", toggleConsole);
refs.canvas.focus({ preventScroll: true });

window.__q2AutoStart = true;
queueMicrotask(() => {
  start();
});

async function start() {
  if (booting || engine) {
    await headTracking?.start();
    return;
  }

  booting = true;
  setLoadingVisible(true);
  setLoadingProgress(4, "Starting");
  refs.statusText.textContent = "Starting engine...";

  try {
    engine = await bootQuake2({
      canvas: refs.canvas,
      output: refs.consoleOutput,
      status: refs.statusText,
      config: runtimeConfig,
      onProgress: ({ percent, label }) => {
        setLoadingProgress(percent, label);
      },
      onStatus: (text) => {
        refs.statusText.textContent = text;
      },
      onEnemyIndicators: setEnemyIndicators,
      onLog: handleRuntimeLog
    });

    headTracking = createHeadTracking({
      getEngine: () => engine,
      meter: refs.yawMeter,
      status: refs.imuStatus,
      tickMs: runtimeConfig.headTickMs,
      sensitivity: runtimeConfig.yawSensitivity,
      turnBurstDegrees: runtimeConfig.turnBurstDegrees
    });

    wearableInput = createWearableInput({
      getEngine: () => engine,
      onRecenter: () => headTracking.recenter(),
      onTurnBurst: (direction) => headTracking.addTurnBurst(direction),
      hasEnemySide: (side) => Boolean(enemyPresence[side]),
      onEnemyTurnRequest: (direction) => engine.requestEnemyTurn(direction)
    });

    wearableInput.install();
    startEnemyIndicatorPolling();
    await startHeadTracking();
    refs.statusText.textContent = "Running";
    setLoadingProgress(92, "Starting map");
    scheduleLoadingHide(8000);
  } catch (error) {
    refs.statusText.textContent = error.message || String(error);
    appendTerminal(`[app] ${refs.statusText.textContent}`);
    setLoadingProgress(100, "Error");
    setLoadingVisible(false);
    setConsoleVisible(true);
  } finally {
    booting = false;
  }
}

async function startHeadTracking() {
  try {
    await headTracking.start();
  } catch (error) {
    const message = error.message || String(error);
    refs.imuStatus.textContent = message;
    appendTerminal(`[imu] ${message}`);
  }
}

function appendTerminal(text) {
  refs.consoleOutput.value += `${text}\n`;
  refs.consoleOutput.scrollTop = refs.consoleOutput.scrollHeight;
}

function handleRuntimeLog(text) {
  if (/Loading library: ref_gles3/i.test(text)) {
    setLoadingProgress(82, "Loading renderer");
    setRenderStatus("gpu", "OpenGL ES/WebGL renderer loading");
  } else if (/Successfully loaded ref_gles3/i.test(text)) {
    setLoadingProgress(88, "Loading game");
    setRenderStatus("gpu", "OpenGL ES/WebGL renderer active");
  } else if (/Loading library: ref_soft/i.test(text)) {
    setRenderStatus("software", "Software renderer loading");
  } else if (/GL_RENDERER:\s*(.+)$/i.test(text)) {
    const [, renderer] = text.match(/GL_RENDERER:\s*(.+)$/i);
    setRenderStatus(classifyRenderer(renderer), renderer);
  } else if (/Loading library: game_baseq2/i.test(text)) {
    setLoadingProgress(90, "Loading game");
  } else if (/==== Yamagi Quake II Initialized ====/i.test(text)) {
    setLoadingProgress(96, "Starting map");
  } else if (/Outer Base|SpawnServer:\s*demo1|maps\/demo1\.bsp/i.test(text)) {
    setLoadingProgress(100, "Ready");
    scheduleLoadingHide(350);
  }
}

function startEnemyIndicatorPolling() {
  window.clearInterval(enemyIndicatorTimer);
  enemyIndicatorTimer = window.setInterval(() => {
    setEnemyIndicators(engine?.readEnemyIndicators?.() ?? { left: false, right: false });
  }, 90);
}

function setEnemyIndicators({ left, right }) {
  enemyPresence.left = Boolean(left);
  enemyPresence.right = Boolean(right);
  refs.enemyLeftIndicator.classList.toggle("is-visible", enemyPresence.left);
  refs.enemyRightIndicator.classList.toggle("is-visible", enemyPresence.right);
}

function setRenderStatus(mode, detail) {
  refs.renderStatus.dataset.mode = mode;
  refs.renderStatus.textContent = mode === "software" ? "Software" : mode === "gpu" ? "GPU" : "Renderer";
  refs.renderStatus.title = detail ? `Renderer: ${detail}` : "Renderer status";
}

function classifyRenderer(renderer) {
  return /swiftshader|software|llvmpipe|softpipe|warp|mesa offscreen|cpu/i.test(renderer)
    ? "software"
    : "gpu";
}

function setLoadingProgress(percent, label) {
  if (typeof percent === "number") {
    loadingProgress = Math.max(loadingProgress, Math.min(100, Math.max(0, percent)));
    refs.loadingBar.style.width = `${loadingProgress}%`;
    refs.loadingProgress.setAttribute("aria-valuenow", String(Math.round(loadingProgress)));
  }

  if (label) {
    refs.loadingLabel.textContent = label;
  }
}

function setLoadingVisible(visible) {
  window.clearTimeout(loadingHideTimer);

  if (visible) {
    loadingProgress = 0;
    refs.loadingPanel.hidden = false;
    refs.loadingPanel.classList.remove("is-hidden");
    setLoadingProgress(0, "Loading");
    return;
  }

  refs.loadingPanel.classList.add("is-hidden");
}

function scheduleLoadingHide(delayMs) {
  window.clearTimeout(loadingHideTimer);
  loadingHideTimer = window.setTimeout(() => {
    setLoadingVisible(false);
  }, delayMs);
}

function toggleConsole() {
  setConsoleVisible(refs.consolePanel.hidden);
}

function setConsoleVisible(visible) {
  refs.consolePanel.hidden = !visible;
  refs.consoleToggleButton.textContent = visible ? "Hide" : "Console";
  refs.consoleToggleButton.setAttribute("aria-expanded", String(visible));

  if (visible) {
    refs.consoleOutput.scrollTop = refs.consoleOutput.scrollHeight;
    refs.consoleOutput.focus();
  } else {
    refs.canvas.focus();
  }
}
