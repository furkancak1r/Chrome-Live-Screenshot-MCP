/* global chrome */

const statusEl = document.getElementById('status');
let refreshTimer = null;

function setDisconnected(message) {
  statusEl.textContent = `Not connected: ${message}`;
  statusEl.className = 'status disconnected';
}

function updateStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (chrome.runtime.lastError) {
      setDisconnected(chrome.runtime.lastError.message);
      return;
    }
    if (res?.connected) {
      const wsUrl = typeof res.wsUrl === 'string' && res.wsUrl.length > 0
        ? res.wsUrl
        : 'ws://localhost:8766';
      statusEl.textContent = `Connected: ${wsUrl}`;
      statusEl.className = 'status connected';
    } else {
      const reason = typeof res?.lastError === 'string' && res.lastError.length > 0
        ? res.lastError
        : 'Bridge is not connected.';
      setDisconnected(reason);
    }
  });
}

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

updateStatus();
refreshTimer = setInterval(updateStatus, 2000);
window.addEventListener('unload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
