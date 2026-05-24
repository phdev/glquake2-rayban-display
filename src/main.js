import "./styles.css";
import { createHeadTracking } from "./headTracking.js";
import {
  createRuntimeConfig,
  bootQuake2,
  probeBundledPak,
  probeEngineArtifacts
} from "./q2Runtime.js";
import { createWearableInput } from "./wearableInput.js";
import { clearPakFile, formatBytes, getPakInfo, savePakFile } from "./storage.js";

const app = document.querySelector("#app");
const runtimeConfig = createRuntimeConfig();

let engine = null;
let booting = false;
let headTracking = null;
let wearableInput = null;

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"></span>
        <div>
          <h1>GLQuake II Display</h1>
          <p id="runtimeLabel"></p>
        </div>
      </div>
      <div class="topbar-actions">
        <button class="secondary" id="importPakButton" type="button">Import PAK</button>
        <button class="secondary" id="clearPakButton" type="button">Clear PAK</button>
        <button class="primary" id="startButton" type="button">Start</button>
      </div>
      <input id="pakInput" type="file" accept=".pak,application/octet-stream" hidden />
    </header>

    <main class="stage">
      <canvas id="gameCanvas" class="game-canvas" tabindex="-1"></canvas>

      <div id="yawMeter" class="yaw-meter" data-zone="deadzone" aria-hidden="true">
        <div class="yaw-track">
          <span class="yaw-center"></span>
          <span class="yaw-needle"></span>
        </div>
      </div>

      <section class="status-panel" id="statusPanel">
        <div>
          <span class="eyebrow">Status</span>
          <p id="statusText">Checking engine package...</p>
        </div>
        <div>
          <span class="eyebrow">Data</span>
          <p id="pakStatus">Checking PAK...</p>
        </div>
        <div>
          <span class="eyebrow">IMU</span>
          <p id="imuStatus">Waiting</p>
        </div>
      </section>

      <nav class="control-strip" aria-label="Wearable controls">
        <button id="forwardButton" type="button">Forward</button>
        <button id="fireButton" type="button">Fire</button>
        <button id="jumpFireButton" type="button">Jump Fire</button>
        <button id="recenterButton" type="button">Recenter</button>
        <button id="turnLeftButton" type="button">Left</button>
        <button id="turnRightButton" type="button">Right</button>
      </nav>
    </main>

    <section class="console-panel" aria-label="Engine log">
      <div class="console-bar">
        <span>Terminal</span>
        <div class="console-actions">
          <span id="copyConsoleStatus" class="copy-status" aria-live="polite"></span>
          <button class="secondary compact" id="copyConsoleButton" type="button">Copy</button>
        </div>
      </div>
      <textarea id="consoleOutput" class="console-output" readonly aria-label="Engine log"></textarea>
    </section>
  </div>
`;

const refs = {
  runtimeLabel: document.querySelector("#runtimeLabel"),
  importPakButton: document.querySelector("#importPakButton"),
  clearPakButton: document.querySelector("#clearPakButton"),
  startButton: document.querySelector("#startButton"),
  pakInput: document.querySelector("#pakInput"),
  canvas: document.querySelector("#gameCanvas"),
  yawMeter: document.querySelector("#yawMeter"),
  statusText: document.querySelector("#statusText"),
  pakStatus: document.querySelector("#pakStatus"),
  imuStatus: document.querySelector("#imuStatus"),
  consoleOutput: document.querySelector("#consoleOutput"),
  copyConsoleButton: document.querySelector("#copyConsoleButton"),
  copyConsoleStatus: document.querySelector("#copyConsoleStatus"),
  statusPanel: document.querySelector("#statusPanel"),
  forwardButton: document.querySelector("#forwardButton"),
  fireButton: document.querySelector("#fireButton"),
  jumpFireButton: document.querySelector("#jumpFireButton"),
  recenterButton: document.querySelector("#recenterButton"),
  turnLeftButton: document.querySelector("#turnLeftButton"),
  turnRightButton: document.querySelector("#turnRightButton")
};

refs.runtimeLabel.textContent =
  runtimeConfig.inputMode === "wearable"
    ? "Meta Ray-Ban Display profile"
    : "Desktop profile";

refs.canvas.width = runtimeConfig.width;
refs.canvas.height = runtimeConfig.height;
refs.canvas.style.aspectRatio = `${runtimeConfig.width} / ${runtimeConfig.height}`;

refs.importPakButton.addEventListener("click", () => refs.pakInput.click());
refs.clearPakButton.addEventListener("click", clearPak);
refs.pakInput.addEventListener("change", importPak);
refs.startButton.addEventListener("click", start);
refs.copyConsoleButton.addEventListener("click", copyConsoleOutput);

initializeControls();
refreshPakStatus();
refreshEngineStatus();

async function start() {
  if (booting || engine) {
    await headTracking?.start();
    return;
  }

  booting = true;
  refs.startButton.disabled = true;
  refs.statusText.textContent = "Starting engine...";

  try {
    engine = await bootQuake2({
      canvas: refs.canvas,
      output: refs.consoleOutput,
      status: refs.statusText,
      config: runtimeConfig,
      onStatus: (text) => {
        refs.statusText.textContent = text;
      }
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
      onForwardChange: updateForwardButton,
      onActionChange: updateActionButton,
      onRecenter: () => headTracking.recenter(),
      onTurnBurst: (direction) => headTracking.addTurnBurst(direction)
    });

    wearableInput.install();
    wireControlButtons();
    await headTracking.start();
    refs.statusPanel.classList.add("is-compact");
    refs.statusText.textContent = "Running";
  } catch (error) {
    refs.statusText.textContent = error.message;
    refs.startButton.disabled = false;
  } finally {
    booting = false;
  }
}

function initializeControls() {
  const controls = [
    refs.forwardButton,
    refs.fireButton,
    refs.jumpFireButton,
    refs.recenterButton,
    refs.turnLeftButton,
    refs.turnRightButton
  ];

  for (const control of controls) {
    control.disabled = false;
  }
}

function wireControlButtons() {
  refs.forwardButton.onclick = () => wearableInput.toggleForward();
  refs.fireButton.onclick = () => wearableInput.fire();
  refs.jumpFireButton.onclick = () => wearableInput.jumpFire();
  refs.recenterButton.onclick = () => wearableInput.recenter();
  refs.turnLeftButton.onclick = () => wearableInput.turn(-1);
  refs.turnRightButton.onclick = () => wearableInput.turn(1);
}

async function importPak(event) {
  const file = event.target.files?.[0];
  event.target.value = "";

  if (!file) {
    return;
  }

  refs.statusText.textContent = "Importing PAK...";

  try {
    const record = await savePakFile(file);
    refs.pakStatus.textContent = `${record.name} ${formatBytes(record.size)}`;
    refs.statusText.textContent = engine ? "PAK ready for next launch" : "PAK ready";
  } catch (error) {
    refs.statusText.textContent = `PAK import failed: ${error.message || error}`;
  }
}

async function clearPak() {
  await clearPakFile();
  await refreshPakStatus();
  refs.statusText.textContent = "PAK cleared";
}

async function refreshPakStatus() {
  const pak = await getPakInfo();
  if (pak) {
    refs.pakStatus.textContent = `${pak.name} ${formatBytes(pak.size)}`;
    return;
  }

  const bundledPak = await probeBundledPak();
  refs.pakStatus.textContent = bundledPak
    ? `Auto demo PAK ${formatBytes(bundledPak.size)}`
    : "No PAK available";
}

async function refreshEngineStatus() {
  const missing = await probeEngineArtifacts();
  refs.statusText.textContent = missing.length
    ? `Missing engine artifact: ${missing.join(", ")}`
    : "Engine package ready";
}

function updateForwardButton(enabled) {
  refs.forwardButton.classList.toggle("is-active", enabled);
}

function updateActionButton(action, enabled) {
  const buttonByAction = {
    attack: refs.fireButton,
    jump: refs.jumpFireButton,
    use: refs.recenterButton
  };

  buttonByAction[action]?.classList.toggle("is-active", enabled);
}

async function copyConsoleOutput() {
  const text = refs.consoleOutput.value;

  if (!text) {
    setCopyStatus("Empty");
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }

    setCopyStatus("Copied");
  } catch {
    fallbackCopyText(text);
    setCopyStatus("Copied");
  }
}

function fallbackCopyText(text) {
  refs.consoleOutput.focus();
  refs.consoleOutput.select();
  document.execCommand("copy");
  refs.consoleOutput.setSelectionRange(text.length, text.length);
}

function setCopyStatus(text) {
  refs.copyConsoleStatus.textContent = text;
  window.clearTimeout(setCopyStatus.timer);
  setCopyStatus.timer = window.setTimeout(() => {
    refs.copyConsoleStatus.textContent = "";
  }, 1600);
}
