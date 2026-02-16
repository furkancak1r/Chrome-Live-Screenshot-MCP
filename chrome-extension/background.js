/* global chrome */

const DEFAULT_WS_URL = "ws://localhost:8766";
const bridgeStatus = {
  connected: false,
  wsUrl: DEFAULT_WS_URL,
  lastError: "Waiting for offscreen connection.",
  lastChangeAt: null
};
let alarmListenerRegistered = false;

function updateBridgeStatus(next) {
  if (!next || typeof next !== "object") return;
  if (typeof next.connected === "boolean") {
    bridgeStatus.connected = next.connected;
  }
  if (typeof next.wsUrl === "string" && next.wsUrl.length > 0) {
    bridgeStatus.wsUrl = next.wsUrl;
  }
  if (typeof next.lastError === "string" || next.lastError === null) {
    bridgeStatus.lastError = next.lastError;
  }
  bridgeStatus.lastChangeAt =
    typeof next.lastChangeAt === "number" ? next.lastChangeAt : Date.now();
}

function lastErrorMessage() {
  return chrome?.runtime?.lastError?.message || null;
}

async function pOffscreenHasDocument() {
  // Some Chrome APIs are promise-based only. Prefer promises, fall back to callbacks.
  try {
    const maybe = chrome.offscreen.hasDocument();
    if (maybe && typeof maybe.then === "function") return await maybe;
  } catch {
    // fall through
  }

  return await new Promise((resolve, reject) => {
    try {
      chrome.offscreen.hasDocument((has) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(has);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function pOffscreenCreateDocument(args) {
  try {
    const maybe = chrome.offscreen.createDocument(args);
    if (maybe && typeof maybe.then === "function") {
      await maybe;
      return true;
    }
  } catch {
    // fall through
  }

  return await new Promise((resolve, reject) => {
    try {
      chrome.offscreen.createDocument(args, () => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(true);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pStorageGet(keys) {
  return new Promise((resolve, reject) => {
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

function pTabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(tabs);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pTabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create(createProperties, (tab) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(tab);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pTabsGet(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(tab);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pTabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(tab);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pWindowsGetLastFocused() {
  return new Promise((resolve, reject) => {
    try {
      chrome.windows.getLastFocused((win) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(win);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pWindowsUpdate(windowId, updateInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.windows.update(windowId, updateInfo, (win) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(win);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function pCaptureVisibleTab(windowId, options) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
        const msg = lastErrorMessage();
        if (msg) reject(new Error(msg));
        else resolve(dataUrl);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function ensureOffscreen() {
  if (
    !chrome.offscreen ||
    typeof chrome.offscreen.hasDocument !== "function" ||
    typeof chrome.offscreen.createDocument !== "function"
  ) {
    updateBridgeStatus({
      connected: false,
      lastError: "Offscreen API unavailable in this browser/session."
    });
    return;
  }

  try {
    const has = await pOffscreenHasDocument();
    if (has) return;

    await pOffscreenCreateDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Maintain a WebSocket connection to a local MCP server."
    });
  } catch (err) {
    updateBridgeStatus({
      connected: false,
      lastError: `Offscreen init failed: ${err?.message ?? String(err)}`
    });
    throw err;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen().catch(() => {});
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen().catch(() => {});
  setupAlarm();
});

// Best-effort: keep the offscreen doc around when the SW wakes for any reason.
ensureOffscreen().catch(() => {});
setupAlarm();

function setupAlarm() {
  // Use alarm to periodically ensure offscreen document exists
  if (chrome.alarms) {
    chrome.alarms.create("keep-alive", { periodInMinutes: 0.5 });
    if (!alarmListenerRegistered) {
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "keep-alive") {
          ensureOffscreen().catch(() => {});
        }
      });
      alarmListenerRegistered = true;
    }
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    const host = u.hostname;
    if (host === "127.0.0.1" || host === "::1") u.hostname = "localhost";
    // Trim trailing slash for non-root paths
    if (u.pathname.endsWith("/") && u.pathname.length > 1) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function getLastFocusedWindowId() {
  try {
    const w = await pWindowsGetLastFocused();
    return w?.id ?? null;
  } catch {
    return null;
  }
}

function pickBestTab(candidates, lastFocusedWindowId) {
  // candidates: Array<{tab, normUrl, scoreParts...}>
  candidates.sort((a, b) => {
    const aInFocused = a.tab.windowId === lastFocusedWindowId ? 1 : 0;
    const bInFocused = b.tab.windowId === lastFocusedWindowId ? 1 : 0;
    if (aInFocused !== bInFocused) return bInFocused - aInFocused;

    const aActive = a.tab.active ? 1 : 0;
    const bActive = b.tab.active ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;

    const aAccessed = typeof a.tab.lastAccessed === "number" ? a.tab.lastAccessed : 0;
    const bAccessed = typeof b.tab.lastAccessed === "number" ? b.tab.lastAccessed : 0;
    if (aAccessed !== bAccessed) return bAccessed - aAccessed;

    return 0;
  });
  return candidates[0]?.tab ?? null;
}

async function findOrOpenTab({
  url,
  match,
  openIfMissing,
  timeoutMs
}) {
  const targetNorm = normalizeUrl(url);
  const tabs = await pTabsQuery({});

  const candidates = [];
  for (const tab of tabs) {
    if (!tab?.id || !tab?.url) continue;
    const tabNorm = normalizeUrl(tab.url);
    const ok =
      match === "exact" ? tabNorm === targetNorm : tabNorm.startsWith(targetNorm);
    if (ok) candidates.push({ tab, tabNorm });
  }

  const lastFocusedWindowId = await getLastFocusedWindowId();
  const chosen = pickBestTab(candidates, lastFocusedWindowId);
  if (chosen) return chosen;

  if (!openIfMissing) return null;

  const created = await pTabsCreate({ url });
  if (!created?.id) return null;

  await waitForTabComplete(created.id, timeoutMs);
  const refreshed = await pTabsGet(created.id);
  return refreshed;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timeout waiting for tab to complete."));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    // In case it's already complete
    pTabsGet(tabId)
      .then((tab) => {
        if (tab?.status === "complete") {
          clearTimeout(t);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      })
      .catch(() => {
        // ignore: we'll rely on the onUpdated listener/timeout
      });
  });
}

async function captureScreenshot(params) {
  const {
    url,
    match = "prefix",
    openIfMissing = true,
    focusWindow = true,
    activateTab = true,
    waitForComplete = true,
    timeoutMs = 15000,
    extraWaitMs = 250,
    format = "png",
    jpegQuality = 80
  } = params || {};

  const tab = await findOrOpenTab({
    url,
    match,
    openIfMissing,
    timeoutMs
  });

  if (!tab?.id || !tab?.windowId) {
    throw new Error("No matching tab found and could not open a new one.");
  }

  if (focusWindow) {
    try {
      await pWindowsUpdate(tab.windowId, { focused: true });
    } catch {
      // ignore
    }
  }

  if (activateTab) {
    try {
      await pTabsUpdate(tab.id, { active: true });
    } catch {
      // ignore
    }
  }

  if (waitForComplete) {
    await waitForTabComplete(tab.id, timeoutMs);
  }

  if (extraWaitMs > 0) {
    await new Promise((r) => setTimeout(r, extraWaitMs));
  }

  const dataUrl = await pCaptureVisibleTab(tab.windowId, {
    format,
    quality: format === "jpeg" ? Math.max(0, Math.min(100, jpegQuality)) : undefined
  });

  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

  return { mimeType, data: base64 };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "wsStatus") {
    updateBridgeStatus(msg.status);
    sendResponse({ ok: true });
    return true;
  }

  // Handle getConfig request from offscreen.js
  if (msg && msg.type === "getConfig") {
    (async () => {
      try {
        const { wsUrl } = await pStorageGet(["wsUrl"]);
        return {
          wsUrl: typeof wsUrl === "string" && wsUrl.length > 0 ? wsUrl : DEFAULT_WS_URL
        };
      } catch (err) {
        return { wsUrl: DEFAULT_WS_URL };
      }
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message }));
    return true;
  }

  // Handle getStatus request from popup
  if (msg && msg.type === "getStatus") {
    sendResponse({ ...bridgeStatus });
    return true;
  }

  // Messages from offscreen.js
  if (!msg || msg.type !== "cmd" || typeof msg.id !== "string") return;

  const { id, cmd, params } = msg;

  console.log('[background] Received cmd:', cmd, 'id:', id, 'params:', params);

  (async () => {
    if (cmd === "listTabs") {
      const tabs = await pTabsQuery({});
      const mapped = tabs
        .filter((t) => t?.id && t?.windowId)
        .map((t) => ({
          tabId: t.id,
          windowId: t.windowId,
          title: t.title ?? "",
          url: t.url ?? "",
          active: !!t.active,
          lastAccessed: typeof t.lastAccessed === "number" ? t.lastAccessed : null
        }));
      return mapped;
    }

    if (cmd === "screenshot") {
      const url = (params && typeof params.url === "string" && params.url) || "http://localhost:5173/";
      return await captureScreenshot({ ...params, url });
    }

    throw new Error(`Unknown cmd: ${cmd}`);
  })()
    .then((result) => {
      console.log('[background] Sending success response for cmd:', cmd, 'id:', id);
      sendResponse({ type: "res", id, ok: true, result });
    })
    .catch((err) => {
      console.log('[background] Sending error response for cmd:', cmd, 'id:', id, 'error:', err?.message);
      sendResponse({
        type: "res",
        id,
        ok: false,
        error: { message: err?.message ?? String(err) }
      });
    });

  return true; // keep message channel open
});
