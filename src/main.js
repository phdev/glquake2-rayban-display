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

app.innerHTML = `
  <main class="game-shell" aria-label="GLQuake II runtime">
    <canvas id="gameCanvas" class="game-canvas" tabindex="-1"></canvas>
    <div id="yawMeter" class="runtime-hidden" data-zone="deadzone" aria-hidden="true"></div>
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
      onRecenter: () => headTracking.recenter(),
      onTurnBurst: (direction) => headTracking.addTurnBurst(direction)
    });

    wearableInput.install();
    await startHeadTracking();
    refs.statusText.textContent = "Running";
  } catch (error) {
    refs.statusText.textContent = error.message || String(error);
    appendTerminal(`[app] ${refs.statusText.textContent}`);
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
