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
      const connectedEndpoints = Array.isArray(res.connectedEndpoints)
        ? res.connectedEndpoints.filter((value) => typeof value === 'string' && value.length > 0)
        : [];
      const wsUrl = connectedEndpoints[0] || (
        typeof res.wsUrl === 'string' && res.wsUrl.length > 0
          ? res.wsUrl.split(',')[0].trim()
          : 'ws://localhost:8766'
      );
      const count = connectedEndpoints.length > 0 ? connectedEndpoints.length : 1;
      statusEl.textContent = `Connected (${count}): ${wsUrl}`;
      statusEl.className = 'status connected';
    } else {
      const disconnectedEndpoints = Array.isArray(res?.disconnectedEndpoints)
        ? res.disconnectedEndpoints
        : [];
      const endpointMessage = disconnectedEndpoints.length > 0 &&
        typeof disconnectedEndpoints[0]?.wsUrl === 'string' &&
        disconnectedEndpoints[0].wsUrl.length > 0
        ? `${disconnectedEndpoints[0].wsUrl}: ${disconnectedEndpoints[0]?.lastError || 'disconnected'}`
        : null;
      const reason = endpointMessage || (
        typeof res?.lastError === 'string' && res.lastError.length > 0
          ? res.lastError
          : 'Bridge is not connected.'
      );
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
