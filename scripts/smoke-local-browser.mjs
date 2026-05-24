import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 4175);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9334);
const APP_URL = process.env.SMOKE_URL || `http://127.0.0.1:${APP_PORT}/`;
const CHROME_BIN =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOOT_TIMEOUT_MS = Number(process.env.SMOKE_BOOT_TIMEOUT_MS || 90000);
const IGNORED_CHROME_STDERR = [
  /DevTools listening/,
  /Trying to load the allocator multiple times/,
  /Created TensorFlow Lite XNNPACK delegate/,
  /google_apis\/gcm\/engine\/registration_request/,
  /chrome\/updater/,
  /GoogleUpdater/,
  /Crashpad\/settings\.dat/,
  /task_policy_set TASK_/,
  /SharedImageManager::ProduceSkia/
];

const processes = [];
let userDataDir = null;
let client = null;

try {
  if (!existsSync(CHROME_BIN)) {
    throw new Error(`Chrome not found at ${CHROME_BIN}. Set CHROME_BIN to a Chromium-compatible browser.`);
  }

  await startPreviewServer();
  userDataDir = await mkdtemp(join(tmpdir(), "glquake2-smoke-chrome-"));
  await startChrome(userDataDir);

  const target = await openTarget(APP_URL);
  client = await connectCdp(target.webSocketDebuggerUrl);

  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Log.enable");
  await waitForAppReady(client);

  console.log(`Loaded ${APP_URL}`);
  await assertAutoStartEnabled(client);

  const terminal = await waitForBootSuccess(client);
  const webgl = await evaluate(
    client,
    `(() => {
      const canvas = document.querySelector('#gameCanvas');
      if (!canvas) return null;
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return null;
      return {
        width: canvas.width,
        height: canvas.height,
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER)
      };
    })()`
  );

  console.log("Smoke test passed.");
  console.log(`Terminal lines: ${terminal.trim().split("\n").length}`);
  if (webgl) {
    console.log(`WebGL context: ${webgl.width}x${webgl.height} ${webgl.vendor} / ${webgl.renderer}`);
  }
} finally {
  client?.close();
  await cleanup();
}

process.exit(0);

async function startPreviewServer() {
  const viteBin = join(ROOT, "node_modules", ".bin", "vite");
  const server = spawn(
    viteBin,
    ["preview", "--host", "127.0.0.1", "--port", String(APP_PORT), "--strictPort"],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  processes.push(server);
  pipeOutput(server, "vite");
  await waitForHttp(APP_URL, "Vite preview server");
}

async function startChrome(profileDir) {
  const chrome = spawn(
    CHROME_BIN,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "about:blank"
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  processes.push(chrome);
  pipeOutput(chrome, "chrome");
  await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, "Chrome DevTools");
}

async function openTarget(url) {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Unable to open Chrome target: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const callbacks = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      return;
    }

    const callback = callbacks.get(message.id);
    if (!callback) {
      return;
    }

    callbacks.delete(message.id);
    if (message.error) {
      callback.reject(new Error(`${message.error.message}: ${message.error.data || ""}`.trim()));
    } else {
      callback.resolve(message.result);
    }
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));

      return new Promise((resolve, reject) => {
        callbacks.set(id, { resolve, reject });
      });
    },
    close() {
      ws.close();
    }
  };
}

async function waitForAppReady(client) {
  await waitFor(async () => {
    return evaluate(client, "Boolean(document.querySelector('#consoleOutput'))");
  }, "app terminal");
}

async function assertAutoStartEnabled(client) {
  const state = await evaluate(
    client,
    `({
      autoStart: Boolean(window.__q2AutoStart),
      hasStartButton: Boolean(document.querySelector('#startButton'))
    })`
  );

  if (!state?.autoStart || state?.hasStartButton) {
    throw new Error("App is not configured for click-free auto-start");
  }
}

async function waitForBootSuccess(client) {
  let latest = "";
  let playableMapSeenAt = 0;
  const startedAt = Date.now();

  while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
    latest = await evaluate(client, "document.querySelector('#consoleOutput')?.value || ''");

    if (
      /\\[boot\\] Error:|recursive shutdown|ERROR: Couldn't open|GetPCXPalette: Couldn't load|Server does not have this file/i.test(latest)
    ) {
      throw new Error(`Quake boot failed:\n${tail(latest)}`);
    }

    const playableMapLoaded =
      latest.includes("Yamagi Quake II") &&
      latest.includes("Refresh: Yamagi Quake II OpenGL ES3 Refresher") &&
      latest.includes("==== Yamagi Quake II Initialized ====") &&
      /Outer Base|SpawnServer:\s*demo1|maps\/demo1\.bsp/i.test(latest);

    if (playableMapLoaded && !playableMapSeenAt) {
      playableMapSeenAt = Date.now();
    } else if (!playableMapLoaded) {
      playableMapSeenAt = 0;
    }

    if (playableMapSeenAt && Date.now() - playableMapSeenAt >= 3000) {
      return latest;
    }

    await delay(500);
  }

  throw new Error(`Quake II GLES startup timed out after ${Math.round(BOOT_TIMEOUT_MS / 1000)}s:\n${tail(latest)}`);
}

async function evaluate(client, expression, options = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...options
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  }

  return result.result?.value;
}

async function waitForHttp(url, label, timeoutMs = 30000) {
  await waitFor(async () => {
    try {
      const response = await fetch(url, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }, label, timeoutMs);
}

async function waitFor(check, label, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
      if (!/timed out|not ready/i.test(String(error.message || error))) {
        throw error;
      }
    }

    await delay(250);
  }

  throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s${lastError ? `: ${lastError.message}` : ""}`);
}

function pipeOutput(child, label) {
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.log(`[${label}] ${text}`);
    }
  });

  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text && !shouldIgnoreStderr(label, text)) {
      console.error(`[${label}] ${text}`);
    }
  });
}

function shouldIgnoreStderr(label, text) {
  return label === "chrome" && IGNORED_CHROME_STDERR.some((pattern) => pattern.test(text));
}

function tail(text, lines = 40) {
  return text.trim().split("\n").slice(-lines).join("\n");
}

async function cleanup() {
  for (const child of processes.reverse()) {
    await stopProcess(child);
  }

  if (userDataDir) {
    try {
      await rm(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      });
    } catch (error) {
      console.warn(`Unable to remove temporary Chrome profile: ${error.message}`);
    }
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = once(child, "exit");
  const forced = delay(3000).then(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });

  await Promise.race([exited, forced]);
}
