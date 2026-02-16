/* global chrome, WebSocket */

const DEFAULT_WS_URL = "ws://localhost:8766";
const DEFAULT_STATUS = {
  connected: false,
  wsUrl: DEFAULT_WS_URL,
  lastError: "Waiting for WebSocket connection.",
  lastChangeAt: null
};
let currentStatus = { ...DEFAULT_STATUS };

function lastErrorMessage() {
  return chrome?.runtime?.lastError?.message || null;
}

function log(...args) {
  console.log('[offscreen]', ...args);
}

function pStorageGet(keys) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome?.storage?.local || typeof chrome.storage.local.get !== 'function') {
      reject(new Error('Chrome storage API not available. Ensure extension is loaded.'));
      return;
    }
    
    try {
      chrome.storage.local.get(keys, (items) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(items);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pRuntimeSendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const errMsg = lastErrorMessage();
        if (errMsg) reject(new Error(errMsg));
        else resolve(res);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadConfigFromBackground() {
  try {
    const res = await pRuntimeSendMessage({ type: "getConfig" });
    if (res?.ok && res?.result) return res.result;
  } catch {}
  return null;
}

async function publishStatus(patch) {
  const next = {
    ...currentStatus,
    ...patch,
    lastChangeAt: Date.now()
  };
  const changed =
    next.connected !== currentStatus.connected ||
    next.wsUrl !== currentStatus.wsUrl ||
    next.lastError !== currentStatus.lastError;

  currentStatus = next;
  if (!changed) return;

  try {
    await pRuntimeSendMessage({ type: "wsStatus", status: next });
  } catch {
    // ignore
  }
}

async function loadConfig() {
  log("Loading config...");
  let fromStorage = null;
  let fromBackground = null;

  if (typeof chrome !== 'undefined' && chrome?.storage?.local && typeof chrome.storage.local.get === 'function') {
    try {
      fromStorage = await pStorageGet(["wsUrl"]);
      log("Got from storage:", fromStorage);
    } catch (e) {
      log("Storage error:", e.message);
    }
  }

  if (!fromStorage?.wsUrl) {
    fromBackground = await loadConfigFromBackground();
    log("Got from background:", fromBackground);
  }

  const wsUrl =
    typeof fromStorage?.wsUrl === "string" && fromStorage.wsUrl.length > 0
      ? fromStorage.wsUrl
      : typeof fromBackground?.wsUrl === "string" && fromBackground.wsUrl.length > 0
        ? fromBackground.wsUrl
        : DEFAULT_WS_URL;

  log("Config:", { wsUrl });
  return { wsUrl };
}

async function sendToBackground(cmdMsg) {
  return await pRuntimeSendMessage(cmdMsg);
}

async function connectLoop() {
  let backoffMs = 500;
  for (;;) {
    log("Connect loop iteration");
    const { wsUrl } = await loadConfig();

    log("Attempting WS connection to:", wsUrl);
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      await publishStatus({
        connected: false,
        wsUrl,
        lastError: e?.message ?? "WebSocket creation failed."
      });
      log("WebSocket creation error:", e.message);
      await sleep(backoffMs);
      backoffMs = Math.min(10_000, backoffMs * 2);
      continue;
    }

    const clientId = cryptoRandomId();
    const extensionVersion = "0.1.0";
    let openError = "Unable to open WebSocket connection.";

    const opened = await new Promise((resolve) => {
      ws.onopen = () => {
        log("WS opened, sending hello...");
        resolve(true);
      };
      ws.onerror = (e) => {
        openError = "Unable to open WebSocket connection.";
        log("WS error before open:", e);
        resolve(false);
      };
    });

    if (!opened) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      await publishStatus({
        connected: false,
        wsUrl,
        lastError: openError
      });
      await sleep(backoffMs);
      backoffMs = Math.min(10_000, backoffMs * 2);
      continue;
    }

    backoffMs = 500;

    ws.send(
      JSON.stringify({
        type: "hello",
        clientId,
        extensionVersion
      })
    );
    await publishStatus({ connected: true, wsUrl, lastError: null });

    let queue = Promise.resolve();

    const handleMessage = async (evt) => {
      log("Received message:", evt.data);
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }

      if (msg?.type === "cmd" && typeof msg?.id === "string") {
        log("Processing cmd:", msg.cmd, "id:", msg.id);
        const { id, cmd, params } = msg;
        try {
          const res = await sendToBackground({ type: "cmd", id, cmd, params });
          ws.send(JSON.stringify(res));
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "res",
              id,
              ok: false,
              error: { message: err?.message ?? String(err) }
            })
          );
        }
      }

      // Respond to ping to keep connection alive
      if (msg?.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      }
    };

    ws.onmessage = (evt) => {
      // Ensure commands are processed sequentially to avoid overlapping tab focus/capture.
      queue = queue.then(() => handleMessage(evt)).catch(() => {});
    };

    const closed = await new Promise((resolve) => {
      ws.onclose = (evt) => {
        const reason = evt?.reason
          ? `WebSocket closed: ${evt.reason}`
          : `WebSocket closed (code ${evt?.code ?? "unknown"}).`;
        void publishStatus({
          connected: false,
          wsUrl,
          lastError: reason
        });
        log("WebSocket closed, code:", evt.code, "reason:", evt.reason);
        resolve(true);
      };
      ws.onerror = (evt) => {
        void publishStatus({
          connected: false,
          wsUrl,
          lastError: "WebSocket error."
        });
        log("WebSocket error:", evt);
        resolve(true);
      };
    });

    log("Connection closed, waiting before reconnect...");
    if (closed) {
      await sleep(backoffMs);
      backoffMs = Math.min(10_000, backoffMs * 2);
    }
  }
}

function cryptoRandomId() {
  // No WebCrypto guaranteed in all contexts; use a simple fallback.
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Listen for config changes
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes || !("wsUrl" in changes)) return;
    // Offscreen doc will reconnect on its own after close; for simplicity we just
    // force a reload to apply new config immediately.
    chrome.runtime.reload();
  });
}

void connectLoop();
