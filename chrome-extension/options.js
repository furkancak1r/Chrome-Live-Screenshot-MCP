/* global chrome */

const DEFAULT_WS_URL = "ws://localhost:8766";

function lastErrorMessage() {
  return chrome?.runtime?.lastError?.message || null;
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

function pStorageSet(items) {
  return new Promise((resolve, reject) => {
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

const els = {
  wsUrl: document.getElementById("wsUrl"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  status: document.getElementById("status")
};

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status ${kind || ""}`.trim();
}

async function load() {
  const { wsUrl } = await pStorageGet(["wsUrl"]);
  els.wsUrl.value = typeof wsUrl === "string" && wsUrl.length > 0 ? wsUrl : DEFAULT_WS_URL;
  setStatus("Loaded. Default: ws://localhost:8766", "");
}

async function save() {
  const wsUrl = els.wsUrl.value.trim() || DEFAULT_WS_URL;
  await pStorageSet({ wsUrl });
  setStatus("Saved. Extension will reload to apply changes.", "ok");
}

async function reset() {
  await pStorageSet({ wsUrl: DEFAULT_WS_URL });
  els.wsUrl.value = DEFAULT_WS_URL;
  setStatus("Reset to defaults.", "");
}

els.save.addEventListener("click", () => void save());
els.reset.addEventListener("click", () => void reset());

void load();
