import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import WebSocket from "ws";

import { WsBridge } from "../src/ws-bridge.ts";

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      server.close(() => resolve(port));
    });
  });
}

async function waitForWsOpen(ws, timeoutMs = 1000) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for websocket open.")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(t);
      resolve(true);
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

async function waitForWsClose(ws, timeoutMs = 1000) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for websocket close.")), timeoutMs);
    ws.once("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

async function waitForWsMessage(ws, predicate, timeoutMs = 1000) {
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("Timeout waiting for websocket message."));
    }, timeoutMs);

    const onMsg = (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (predicate(msg)) {
          clearTimeout(t);
          ws.off("message", onMsg);
          resolve(msg);
        }
      } catch {
        // ignore
      }
    };

    ws.on("message", onMsg);
  });
}

test("WsBridge: call fails when no client connected and includes endpoint", async () => {
  const port = await getFreePort();
  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });
  await bridge.start();

  try {
    await assert.rejects(() => bridge.call("listTabs", {}, 200), new RegExp(`ws://127\\.0\\.0\\.1:${port}`));
  } finally {
    await bridge.stop();
  }
});

test("WsBridge: non-hello first message is rejected", async () => {
  const port = await getFreePort();
  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "ping" }));
    const err = await waitForWsMessage(ws, (m) => m?.type === "error", 1000);
    assert.match(err?.message ?? "", /Expected hello first/i);
    await waitForWsClose(ws, 1000);
    await assert.rejects(() => bridge.call("listTabs", {}, 200), /not connected/i);
  } finally {
    ws.close();
    await bridge.stop();
  }
});

test("WsBridge: call/response roundtrip", async () => {
  const port = await getFreePort();

  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "hello", clientId: "t", extensionVersion: "0" }));
    await waitForWsMessage(ws, (m) => m?.type === "hello_ack", 1000);

    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "cmd") {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result: { ok: 1 } }));
      }
    });

    const res = await bridge.call("listTabs", {}, 1000);
    assert.deepEqual(res, { ok: 1 });
  } finally {
    ws.close();
    await bridge.stop();
  }
});

test("WsBridge: times out if client doesn't respond", async () => {
  const port = await getFreePort();

  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "hello", clientId: "t", extensionVersion: "0" }));
    await waitForWsMessage(ws, (m) => m?.type === "hello_ack", 1000);

    await assert.rejects(() => bridge.call("listTabs", {}, 100), /timeout/i);
  } finally {
    ws.close();
    await bridge.stop();
  }
});

test("WsBridge: stop rejects pending calls", async () => {
  const port = await getFreePort();

  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "hello", clientId: "c1", extensionVersion: "0" }));
    await waitForWsMessage(ws, (m) => m?.type === "hello_ack", 1000);

    const cmdPromise = waitForWsMessage(ws, (m) => m?.type === "cmd", 1000);
    const callPromise = bridge.call("listTabs", {}, 5000);
    const callOutcome = callPromise.then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, err })
    );
    await cmdPromise;

    await bridge.stop();
    const outcome = await callOutcome;
    assert.equal(outcome.ok, false);
    assert.match(outcome.err?.message ?? "", /WS server stopped/i);
  } finally {
    ws.close();
    await bridge.stop();
  }
});

test("WsBridge: start rejects when port is in use", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : null;
  assert.ok(typeof port === "number" && port > 0);

  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });

  try {
    await assert.rejects(() => bridge.start());
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await bridge.stop();
  }
});

test("WsBridge: reconnect fails pending calls", async () => {
  const port = await getFreePort();

  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });
  await bridge.start();

  const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
  let ws2 = null;

  try {
    await waitForWsOpen(ws1);
    ws1.send(JSON.stringify({ type: "hello", clientId: "c1", extensionVersion: "0" }));
    await waitForWsMessage(ws1, (m) => m?.type === "hello_ack", 1000);

    const gotCmd = new Promise((resolve) => {
      ws1.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "cmd") resolve(msg);
      });
    });

    const callPromise = bridge.call("listTabs", {}, 2000);
    const callOutcome = callPromise.then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, err })
    );
    await gotCmd;

    ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForWsOpen(ws2);
    ws2.send(JSON.stringify({ type: "hello", clientId: "c2", extensionVersion: "0" }));
    await waitForWsMessage(ws2, (m) => m?.type === "hello_ack", 1000);

    const outcome = await callOutcome;
    assert.equal(outcome.ok, false);
    assert.match(outcome.err?.message ?? "", /reconnected/i);
  } finally {
    ws1.close();
    ws2?.close();
    await bridge.stop();
  }
});
