/* global chrome */

const DEFAULT_WS_URL = "ws://localhost:8766";
const DEFAULT_URL = "http://localhost:5173/";
const bridgeStatus = {
  connected: false,
  wsUrl: DEFAULT_WS_URL,
  connectedEndpoints: [],
  disconnectedEndpoints: [],
  lastError: "Waiting for offscreen connection.",
  lastChangeAt: null
};
let alarmListenerRegistered = false;
let commandLock = Promise.resolve();

async function withCommandLock(fn) {
  const prev = commandLock;
  let release;
  commandLock = new Promise((resolve) => {
    release = resolve;
  });

  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function updateBridgeStatus(next) {
  if (!next || typeof next !== "object") return;
  if (typeof next.connected === "boolean") {
    bridgeStatus.connected = next.connected;
  }
  if (typeof next.wsUrl === "string" && next.wsUrl.length > 0) {
    bridgeStatus.wsUrl = next.wsUrl;
  }
  if (Array.isArray(next.connectedEndpoints)) {
    bridgeStatus.connectedEndpoints = next.connectedEndpoints
      .filter((value) => typeof value === "string" && value.length > 0);
  }
  if (Array.isArray(next.disconnectedEndpoints)) {
    bridgeStatus.disconnectedEndpoints = next.disconnectedEndpoints
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        wsUrl: typeof entry.wsUrl === "string" ? entry.wsUrl : "",
        lastError: typeof entry.lastError === "string" || entry.lastError === null
          ? entry.lastError
          : null
      }))
      .filter((entry) => entry.wsUrl.length > 0);
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
    throw new Error(`Invalid URL format: ${url}`);
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

/**
 * Resolves a tab for a given URL, either by finding an existing matching tab or creating a new one.
 * @param {Object} params - Parameters for resolving the tab.
 * @param {string} params.url - The URL to match or open.
 * @param {"prefix"|"exact"} params.match - How to match the URL against existing tabs.
 * @param {boolean} [params.reuseIfExists=true] - Whether to reuse an existing matching tab.
 * @param {boolean} [params.openIfMissing=true] - Whether to open a new tab if no match is found.
 * @param {boolean} [params.waitForComplete=true] - Whether to wait for the tab to finish loading.
 * @param {number} [params.timeoutMs=15000] - Max time to wait for tab load.
 * @returns {Promise<{tab?: chrome.tabs.Tab, action?: string, error?: {message: string, reason: string}}>}
 *   Resolves with tab and action, or error if unable to resolve.
 */
async function resolveTabForUrl({
  url,
  match,
  reuseIfExists,
  openIfMissing,
  waitForComplete = true,
  timeoutMs
}) {
  // Validate URL before attempting to create/lookup tab
  if (!url || typeof url !== "string" || url.trim().length === 0) {
    return { error: { message: "Invalid URL: must be a non-empty string", reason: "invalid_url" } };
  }

  let targetNorm;
  try {
    targetNorm = normalizeUrl(url);
  } catch {
    return { error: { message: `Invalid URL format: ${url}`, reason: "invalid_url_format" } };
  }

  if (reuseIfExists) {
    const tabs = await pTabsQuery({});
    const candidates = [];
    for (const tab of tabs) {
      if (!tab?.id || !tab?.url) continue;
      // Skip non-http(s) URLs to prevent normalizeUrl from throwing
      if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
        continue;
      }
      const tabNorm = normalizeUrl(tab.url);
      const ok =
        match === "exact" ? tabNorm === targetNorm : tabNorm.startsWith(targetNorm);
      if (ok) candidates.push({ tab, tabNorm });
    }

    const lastFocusedWindowId = await getLastFocusedWindowId();
    const chosen = pickBestTab(candidates, lastFocusedWindowId);
    if (chosen) {
      return { tab: chosen, action: "reused_existing_tab" };
    }
  }

  if (!openIfMissing) {
    return { error: { message: "No matching tab found and openIfMissing is false", reason: "open_if_missing_disabled" } };
  }

  const created = await pTabsCreate({ url });
  if (!created || !created.id) return { error: { message: "Failed to create new tab", reason: "tab_creation_failed" } };

  if (waitForComplete) {
    await waitForTabComplete(created.id, timeoutMs);
    const refreshed = await pTabsGet(created.id);
    return { tab: refreshed ?? created, action: "opened_new_tab" };
  }
  return { tab: created, action: "opened_new_tab" };
}

async function findOrOpenTab({
  url,
  match,
  openIfMissing,
  timeoutMs
}) {
  const result = await resolveTabForUrl({
    url,
    match,
    reuseIfExists: true,
    openIfMissing,
    timeoutMs
  });
  // Handle error case - re-throw with context
  // Note: The 'reason' property is a custom extension property used for programmatic error categorization.
  // It is not part of the standard Error interface but is added here to help callers distinguish between
  // different error types (e.g., invalid_url, tab_creation_failed, etc.).
  if (result?.error) {
    const err = new Error(result.error.message);
    err.reason = result.error.reason;
    throw err;
  }
  return result?.tab ?? null;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const resolveOnce = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timeout waiting for tab to complete."));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") {
        resolveOnce();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    // In case it's already complete
    pTabsGet(tabId)
      .then((tab) => {
        if (tab?.status === "complete") {
          resolveOnce();
        }
      })
      .catch(() => {
        // ignore: we'll rely on the onUpdated listener/timeout
      });
  });
}

async function captureScreenshot(params) {
  return await withCommandLock(async () => {
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
      } catch (err) {
        console.warn("Failed to focus window:", err?.message);
      }
    }

    if (activateTab) {
      try {
        await pTabsUpdate(tab.id, { active: true });
      } catch (err) {
        console.warn("Failed to activate tab:", err?.message);
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
  });
}

/**
 * Opens a URL in Chrome, either by focusing an existing tab or creating a new one.
 * @param {Object} params - Parameters for opening the URL.
 * @param {string} params.url - The URL to open.
 * @param {"prefix"|"exact"} [params.match="prefix"] - How to match existing tabs.
 * @param {boolean} [params.reuseIfExists=true] - Whether to reuse an existing matching tab.
 * @param {boolean} [params.openIfMissing=true] - Whether to open a new tab if no match is found.
 * @param {boolean} [params.focusWindow=true] - Whether to focus the window containing the tab.
 * @param {boolean} [params.activateTab=true] - Whether to activate the tab.
 * @param {boolean} [params.waitForComplete=true] - Whether to wait for the tab to finish loading.
 * @param {number} [params.timeoutMs=15000] - Max time to wait for tab load.
 * @returns {Promise<{success: boolean, action: string, tabId: number, windowId: number, title: string, url: string, status: string|null}>}
 *   Resolves with success details including the tab info.
 * @throws {Error} If the URL cannot be resolved or tab operations fail.
 */
async function openUrl(params) {
  return await withCommandLock(async () => {
    const {
      url,
      match = "prefix",
      reuseIfExists = true,
      openIfMissing = true,
      focusWindow = true,
      activateTab = true,
      waitForComplete = true,
      timeoutMs = 15000
    } = params || {};

    const resolved = await resolveTabForUrl({
      url,
      match,
      reuseIfExists,
      openIfMissing,
      waitForComplete,
      timeoutMs
    });

    // Handle error case
    if (resolved?.error) {
      const err = new Error(resolved.error.message);
      err.reason = resolved.error.reason;
      throw err;
    }

    const tab = resolved?.tab;
    if (!tab) {
      throw new Error("Failed to resolve tab: unexpected response from resolveTabForUrl");
    }
    if (!tab.id || !tab.windowId) {
      throw new Error("No matching tab found and could not open a new one.");
    }

    if (focusWindow) {
      try {
        await pWindowsUpdate(tab.windowId, { focused: true });
      } catch (err) {
        console.warn("Failed to focus window:", err?.message);
      }
    }

    if (activateTab) {
      try {
        await pTabsUpdate(tab.id, { active: true });
      } catch (err) {
        console.warn("Failed to activate tab:", err?.message);
      }
    }

    // New tabs are waited in resolveTabForUrl when waitForComplete=true.
    // Wait here only for reused tabs.
    if (waitForComplete && resolved.action === "reused_existing_tab") {
      await waitForTabComplete(tab.id, timeoutMs);
    }

    let refreshedTab = tab;
    try {
      refreshedTab = (await pTabsGet(tab.id)) ?? tab;
    } catch (err) {
      console.warn("Failed to refresh tab:", err?.message);
    }

    return {
      success: true,
      action: resolved.action,
      tabId: refreshedTab.id,
      windowId: refreshedTab.windowId,
      title: refreshedTab.title ?? "",
      url: refreshedTab.url ?? url,
      status: refreshedTab.status ?? null
    };
  });
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
      const url = (params && typeof params.url === "string" && params.url) || DEFAULT_URL;
      return await captureScreenshot({ ...params, url });
    }

    if (cmd === "openUrl") {
      const url = (params && typeof params.url === "string" && params.url) || DEFAULT_URL;
      return await openUrl({ ...params, url });
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
        error: { message: err?.message ?? String(err), reason: err?.reason }
      });
    });

  return true; // keep message channel open
});
