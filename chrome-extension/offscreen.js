/* global chrome, WebSocket */

const DEFAULT_WS_URL = "ws://localhost:8766";
const BASE_PORT = 8766;
const MAX_PORT_EXCLUSIVE = BASE_PORT + 10;
const DEFAULT_HOST_CANDIDATES = ["localhost", "127.0.0.1", "wsl.localhost"];
const CONNECT_TIMEOUT_MS = 4000;
const BASE_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 10_000;
const STICKY_ENDPOINT_KEY = "lastConnectedWsUrl";
const MAX_GLOBAL_QUEUE_SIZE = 200;
const QUEUE_WAIT_TIMEOUT_MS = 20_000;
const COMPLETED_ID_TTL_MS = 2 * 60 * 1000;
const COMPLETED_ID_MAX = 2000;

const DEFAULT_STATUS = {
  connected: false,
  wsUrl: DEFAULT_WS_URL,
  connectedEndpoints: [],
  disconnectedEndpoints: [],
  lastError: "Waiting for WebSocket connection.",
  lastChangeAt: null
};

let currentStatus = { ...DEFAULT_STATUS };
const endpointStates = new Map();
const socketStates = new Map();
const pendingQueue = [];
const pendingBySocketKey = new Map();
const activeRequestIds = new Set();
const recentlyCompletedIds = new Map();
let queueRunning = false;
let configuredEndpoints = [];
let stickyEndpoint = null;

function lastErrorMessage() {
  return chrome?.runtime?.lastError?.message || null;
}

function log(...args) {
  console.log('[offscreen]', ...args);
}

function logDiag(event, details = {}) {
  log("diag", JSON.stringify({ event, ts: Date.now(), ...details }));
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

function pStorageSet(items) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local || typeof chrome.storage.local.set !== "function") {
      reject(new Error("Chrome storage API not available. Ensure extension is loaded."));
      return;
    }

    try {
      chrome.storage.local.set(items, () => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(true);
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

function cryptoRandomId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeWsUrl(input) {
  if (typeof input !== "string") return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    if (!url.port) return null;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseWsUrl(input) {
  const normalized = normalizeWsUrl(input);
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
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
  const currentConnected = Array.isArray(currentStatus.connectedEndpoints)
    ? currentStatus.connectedEndpoints
    : [];
  const nextConnected = Array.isArray(next.connectedEndpoints)
    ? next.connectedEndpoints
    : [];
  const currentDisconnected = Array.isArray(currentStatus.disconnectedEndpoints)
    ? currentStatus.disconnectedEndpoints
    : [];
  const nextDisconnected = Array.isArray(next.disconnectedEndpoints)
    ? next.disconnectedEndpoints
    : [];

  const connectedEndpointsChanged =
    currentConnected.length !== nextConnected.length ||
    currentConnected.some((value, idx) => value !== nextConnected[idx]);
  const disconnectedEndpointsChanged =
    currentDisconnected.length !== nextDisconnected.length ||
    currentDisconnected.some((entry, idx) => {
      const other = nextDisconnected[idx];
      return entry?.wsUrl !== other?.wsUrl || entry?.lastError !== other?.lastError;
    });
  const changed =
    next.connected !== currentStatus.connected ||
    next.wsUrl !== currentStatus.wsUrl ||
    next.lastError !== currentStatus.lastError ||
    connectedEndpointsChanged ||
    disconnectedEndpointsChanged;

  currentStatus = next;
  if (!changed) return;

  try {
    await pRuntimeSendMessage({ type: "wsStatus", status: next });
  } catch {
    // ignore
  }
}

function collectStatus() {
  const connectedEndpoints = [];
  const disconnectedEndpoints = [];

  for (const state of endpointStates.values()) {
    if (state.connected) {
      connectedEndpoints.push(state.wsUrl);
    } else {
      disconnectedEndpoints.push({
        wsUrl: state.wsUrl,
        lastError: state.lastError ?? null
      });
    }
  }

  const primaryUrl = connectedEndpoints[0] ?? configuredEndpoints[0] ?? DEFAULT_WS_URL;
  const error =
    connectedEndpoints.length > 0
      ? null
      : disconnectedEndpoints[0]?.lastError ??
        "Could not connect to any MCP endpoint.";

  return {
    connected: connectedEndpoints.length > 0,
    wsUrl: connectedEndpoints.length > 0 ? connectedEndpoints.join(",") : primaryUrl,
    connectedEndpoints,
    disconnectedEndpoints,
    lastError: error
  };
}

async function publishAggregateStatus() {
  await publishStatus(collectStatus());
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

  const hasExplicitStorageWsUrl =
    typeof fromStorage?.wsUrl === "string" && fromStorage.wsUrl.length > 0;
  const wsUrl =
    hasExplicitStorageWsUrl
      ? fromStorage.wsUrl
      : typeof fromBackground?.wsUrl === "string" && fromBackground.wsUrl.length > 0
        ? fromBackground.wsUrl
        : DEFAULT_WS_URL;

  log("Config:", { wsUrl, hasExplicitStorageWsUrl });
  return { wsUrl, hasExplicitStorageWsUrl };
}

function buildDefaultEndpoints() {
  const out = [];
  for (let port = BASE_PORT; port < MAX_PORT_EXCLUSIVE; port += 1) {
    for (const host of DEFAULT_HOST_CANDIDATES) {
      out.push(`ws://${host}:${port}`);
    }
  }
  return [...new Set(out)];
}

function endpointCandidatesForUrl(urlObj) {
  const protocol = urlObj.protocol === "wss:" ? "wss" : "ws";
  const port = urlObj.port;
  const host = urlObj.hostname;

  const out = [`${protocol}://${host}:${port}`];
  if (host === "0.0.0.0") {
    for (const candidate of DEFAULT_HOST_CANDIDATES) {
      out.push(`${protocol}://${candidate}:${port}`);
    }
  }
  if (host === "localhost") {
    out.push(`${protocol}://127.0.0.1:${port}`);
    out.push(`${protocol}://wsl.localhost:${port}`);
  }
  if (host === "127.0.0.1") {
    out.push(`${protocol}://localhost:${port}`);
    out.push(`${protocol}://wsl.localhost:${port}`);
  }
  return [...new Set(out)];
}

function parseSeedEndpoints(configWsUrl, hasExplicitStorageWsUrl = false) {
  const seeds = [];

  if (typeof configWsUrl === "string" && configWsUrl.includes(",")) {
    const values = configWsUrl
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    for (const value of values) {
      const normalized = normalizeWsUrl(value);
      if (!normalized) continue;
      seeds.push(normalized);
    }
    return [...new Set(seeds)];
  }

  const normalized = normalizeWsUrl(configWsUrl);
  if (!normalized) return [];
  if (normalized === DEFAULT_WS_URL && !hasExplicitStorageWsUrl) return [];

  seeds.push(normalized);
  return [...new Set(seeds)];
}

function resolveEndpoints(configWsUrl, hasExplicitStorageWsUrl = false) {
  const defaults = buildDefaultEndpoints();
  const seeds = parseSeedEndpoints(configWsUrl, hasExplicitStorageWsUrl);

  if (seeds.length === 0) {
    return defaults;
  }

  const prioritized = [];
  for (const seed of seeds) {
    prioritized.push(seed);
    const parsed = parseWsUrl(seed);
    if (!parsed) continue;
    for (const candidate of endpointCandidatesForUrl(parsed)) {
      prioritized.push(candidate);
    }
  }

  return [...new Set([...prioritized, ...defaults])];
}

function reorderEndpointsWithSticky(endpoints) {
  if (!stickyEndpoint) return endpoints;
  if (!endpoints.includes(stickyEndpoint)) return endpoints;
  return [stickyEndpoint, ...endpoints.filter((value) => value !== stickyEndpoint)];
}

async function loadStickyEndpoint() {
  try {
    const data = await pStorageGet([STICKY_ENDPOINT_KEY]);
    stickyEndpoint = normalizeWsUrl(data?.[STICKY_ENDPOINT_KEY]);
  } catch {
    stickyEndpoint = null;
  }
}

async function persistStickyEndpoint(wsUrl) {
  const normalized = normalizeWsUrl(wsUrl);
  if (!normalized) return;
  if (stickyEndpoint === normalized) return;
  stickyEndpoint = normalized;
  try {
    await pStorageSet({ [STICKY_ENDPOINT_KEY]: normalized });
  } catch {
    // ignore
  }
}

async function sendToBackground(cmdMsg) {
  return await pRuntimeSendMessage(cmdMsg);
}

function pruneCompletedRequestIds(now) {
  for (const [id, ts] of recentlyCompletedIds.entries()) {
    if (now - ts > COMPLETED_ID_TTL_MS) {
      recentlyCompletedIds.delete(id);
    }
  }
  while (recentlyCompletedIds.size > COMPLETED_ID_MAX) {
    const first = recentlyCompletedIds.keys().next().value;
    if (!first) break;
    recentlyCompletedIds.delete(first);
  }
}

function socketIsOpen(state) {
  return !!state && !!state.ws && state.ws.readyState === WebSocket.OPEN;
}

function sendErrorToSocket(state, id, message, reason, code, retryable) {
  if (!socketIsOpen(state)) return;
  try {
    state.ws.send(
      JSON.stringify({
        type: "res",
        id,
        ok: false,
        error: { message, reason, code, retryable }
      })
    );
  } catch {
    // ignore
  }
}

function markRequestComplete(id) {
  activeRequestIds.delete(id);
  recentlyCompletedIds.set(id, Date.now());
}

function registerSocketPending(socketKey, id) {
  const existing = pendingBySocketKey.get(socketKey);
  if (existing) {
    existing.add(id);
    return;
  }
  pendingBySocketKey.set(socketKey, new Set([id]));
}

function unregisterSocketPending(socketKey, id) {
  const set = pendingBySocketKey.get(socketKey);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) pendingBySocketKey.delete(socketKey);
}

function finalizeSocket(state, closeMessage) {
  state.connected = false;
  state.lastError = closeMessage;
  socketStates.delete(state.socketKey);

  const socketPending = pendingBySocketKey.get(state.socketKey);
  if (socketPending) {
    for (const id of socketPending) {
      activeRequestIds.delete(id);
      recentlyCompletedIds.set(id, Date.now());
    }
    pendingBySocketKey.delete(state.socketKey);
  }

  for (let i = pendingQueue.length - 1; i >= 0; i -= 1) {
    const item = pendingQueue[i];
    if (item.socketKey !== state.socketKey) continue;
    pendingQueue.splice(i, 1);
    activeRequestIds.delete(item.id);
    recentlyCompletedIds.set(item.id, Date.now());
    sendErrorToSocket(
      state,
      item.id,
      "Socket closed before request could be processed.",
      "socket_closed",
      "SOCKET_CLOSED",
      true
    );
  }

  pruneCompletedRequestIds(Date.now());
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift();
      if (!item) continue;
      const state = socketStates.get(item.socketKey);
      if (!state || !socketIsOpen(state)) {
        activeRequestIds.delete(item.id);
        recentlyCompletedIds.set(item.id, Date.now());
        continue;
      }
      if (Date.now() > item.deadlineAt) {
        logDiag("queue_wait_timeout", {
          endpoint: state.wsUrl,
          id: item.id,
          waitedMs: Date.now() - item.enqueuedAt,
          timeoutMs: QUEUE_WAIT_TIMEOUT_MS
        });
        sendErrorToSocket(
          state,
          item.id,
          "Command timed out while waiting in global queue.",
          "queue_wait_timeout",
          "QUEUE_WAIT_TIMEOUT",
          true
        );
        unregisterSocketPending(item.socketKey, item.id);
        markRequestComplete(item.id);
        pruneCompletedRequestIds(Date.now());
        continue;
      }
      try {
        const res = await sendToBackground({
          type: "cmd",
          id: item.id,
          cmd: item.cmd,
          params: item.params
        });
        if (socketIsOpen(state)) {
          state.ws.send(JSON.stringify(res));
        }
      } catch (err) {
        sendErrorToSocket(
          state,
          item.id,
          err?.message ?? String(err),
          err?.reason,
          err?.code,
          typeof err?.retryable === "boolean" ? err.retryable : false
        );
      } finally {
        unregisterSocketPending(item.socketKey, item.id);
        markRequestComplete(item.id);
        pruneCompletedRequestIds(Date.now());
      }
    }
  } finally {
    queueRunning = false;
  }
}

function enqueueCommand(state, msg) {
  const now = Date.now();
  pruneCompletedRequestIds(now);

  const id = msg.id;
  if (activeRequestIds.has(id) || recentlyCompletedIds.has(id)) {
    sendErrorToSocket(
      state,
      id,
      "Duplicate request id.",
      "duplicate_request_id",
      "DUPLICATE_REQUEST_ID",
      false
    );
    return;
  }

  if (pendingQueue.length >= MAX_GLOBAL_QUEUE_SIZE) {
    sendErrorToSocket(
      state,
      id,
      "Global command queue overflow.",
      "queue_overflow",
      "QUEUE_OVERFLOW",
      true
    );
    return;
  }

  activeRequestIds.add(id);
  registerSocketPending(state.socketKey, id);
  const deadlineAt = now + QUEUE_WAIT_TIMEOUT_MS;
  pendingQueue.push({
    socketKey: state.socketKey,
    id,
    cmd: msg.cmd,
    params: msg.params,
    enqueuedAt: now,
    deadlineAt
  });
  void processQueue();
}

function initEndpointState(wsUrl) {
  const existing = endpointStates.get(wsUrl);
  if (existing) return existing;
  const state = {
    wsUrl,
    socketKey: `${wsUrl}#${cryptoRandomId()}`,
    ws: null,
    connected: false,
    backoffMs: BASE_RECONNECT_MS,
    lastError: "Waiting for connection.",
    reconnectTimer: null,
    shouldRun: true,
    clientId: cryptoRandomId(),
    connectAttemptNo: 0,
    connecting: false,
    openTimerFired: false,
    selfTimeoutClosePending: false,
    consecutiveFailures: 0
  };
  endpointStates.set(wsUrl, state);
  return state;
}

function stopEndpoint(state) {
  state.shouldRun = false;
  state.connecting = false;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      // ignore
    }
  }
}

function scheduleReconnect(state) {
  if (!state.shouldRun) return;
  if (state.reconnectTimer) return;
  const delay = state.backoffMs;
  logDiag("reconnect_schedule", {
    endpoint: state.wsUrl,
    attemptNo: state.connectAttemptNo + 1,
    delayMs: delay,
    backoffMs: state.backoffMs,
    consecutiveFailures: state.consecutiveFailures,
    connected: state.connected,
    readyState: state.ws?.readyState
  });
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.shouldRun) return;
    void connectEndpoint(state);
  }, delay);
  state.backoffMs = Math.min(MAX_RECONNECT_MS, state.backoffMs * 2);
}

async function connectEndpoint(state) {
  if (!state.shouldRun) return;
  if (socketIsOpen(state)) return;
  if (state.connecting) return;
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) return;

  state.connecting = true;
  state.connectAttemptNo += 1;
  state.openTimerFired = false;
  state.selfTimeoutClosePending = false;
  const attemptNo = state.connectAttemptNo;

  let ws;
  try {
    ws = new WebSocket(state.wsUrl);
    logDiag("connect_start", {
      endpoint: state.wsUrl,
      attemptNo,
      readyState: ws.readyState
    });
  } catch (err) {
    state.connecting = false;
    state.lastError = err?.message ?? "WebSocket creation failed.";
    logDiag("connect_create_error", {
      endpoint: state.wsUrl,
      attemptNo,
      message: state.lastError
    });
    await publishAggregateStatus();
    scheduleReconnect(state);
    return;
  }

  state.ws = ws;
  if (state.socketKey) {
    socketStates.delete(state.socketKey);
  }
  state.socketKey = `${state.wsUrl}#${cryptoRandomId()}`;
  socketStates.set(state.socketKey, state);
  let openTimer = null;

  ws.onopen = () => {
    if (state.ws !== ws) return;
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    state.connecting = false;
    state.connected = true;
    state.consecutiveFailures = 0;
    state.lastError = null;
    state.backoffMs = BASE_RECONNECT_MS;
    state.openTimerFired = false;
    state.selfTimeoutClosePending = false;
    logDiag("connect_open", {
      endpoint: state.wsUrl,
      attemptNo,
      readyState: ws.readyState
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        clientId: state.clientId,
        extensionVersion: "0.1.0"
      })
    );
    void persistStickyEndpoint(state.wsUrl);
    void publishAggregateStatus();
  };

  ws.onmessage = (evt) => {
    if (state.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }

    if (msg?.type === "cmd" && typeof msg?.id === "string") {
      enqueueCommand(state, msg);
      return;
    }

    if (msg?.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      } catch {
        // ignore
      }
    }
  };

  ws.onclose = (evt) => {
    if (state.ws !== ws) {
      logDiag("connect_close_stale", {
        endpoint: state.wsUrl,
        attemptNo,
        code: evt?.code,
        reason: evt?.reason
      });
      return;
    }
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    state.connecting = false;
    const selfTimeoutClose = state.selfTimeoutClosePending || state.openTimerFired;
    const reason = evt?.reason
      ? `WebSocket closed: ${evt.reason}`
      : `WebSocket closed (code ${evt?.code ?? "unknown"}).`;
    logDiag("connect_close", {
      endpoint: state.wsUrl,
      attemptNo,
      code: evt?.code,
      reason: evt?.reason,
      wasClean: evt?.wasClean,
      readyState: ws.readyState,
      openTimerFired: state.openTimerFired,
      selfTimeoutClose
    });
    state.selfTimeoutClosePending = false;
    state.openTimerFired = false;
    state.consecutiveFailures += 1;
    finalizeSocket(state, reason);
    void publishAggregateStatus();
    scheduleReconnect(state);
  };

  ws.onerror = () => {
    if (state.ws !== ws) return;
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    state.connecting = false;
    state.lastError = "WebSocket error.";
    logDiag("connect_error", {
      endpoint: state.wsUrl,
      attemptNo,
      readyState: ws.readyState,
      openTimerFired: state.openTimerFired
    });
    void publishAggregateStatus();
  };

  openTimer = setTimeout(() => {
    state.openTimerFired = true;
    state.selfTimeoutClosePending = true;
    logDiag("connect_open_timeout", {
      endpoint: state.wsUrl,
      attemptNo,
      timeoutMs: CONNECT_TIMEOUT_MS,
      readyState: ws.readyState
    });
    try {
      ws.close(4001, "open_timeout");
    } catch {
      // ignore
    }
  }, CONNECT_TIMEOUT_MS);
}

function stopRemovedEndpoints(allowedSet) {
  for (const [wsUrl, state] of endpointStates.entries()) {
    if (allowedSet.has(wsUrl)) continue;
    stopEndpoint(state);
    if (state.socketKey) {
      socketStates.delete(state.socketKey);
    }
    endpointStates.delete(wsUrl);
  }
}

async function connectLoop() {
  await loadStickyEndpoint();
  const { wsUrl, hasExplicitStorageWsUrl } = await loadConfig();
  const endpoints = reorderEndpointsWithSticky(resolveEndpoints(wsUrl, hasExplicitStorageWsUrl));
  const endpointSet = new Set(endpoints);

  configuredEndpoints = endpoints;
  stopRemovedEndpoints(endpointSet);
  for (const endpoint of endpoints) {
    const state = initEndpointState(endpoint);
    state.shouldRun = true;
    void connectEndpoint(state);
  }

  await publishAggregateStatus();
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
