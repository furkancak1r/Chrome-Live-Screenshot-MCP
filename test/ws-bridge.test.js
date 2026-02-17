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

async function waitForWsCloseInfo(ws, timeoutMs = 1000) {
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout waiting for websocket close info.")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(t);
      resolve({ code, reason: reason?.toString?.() ?? "" });
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

test("WsBridge: multiple clients can stay connected and serve calls", async () => {
  const port = await getFreePort();

  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: () => {}
  });
  await bridge.start();

  const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);

  try {
    await waitForWsOpen(ws1);
    await waitForWsOpen(ws2);
    ws1.send(JSON.stringify({ type: "hello", clientId: "c1", extensionVersion: "0" }));
    ws2.send(JSON.stringify({ type: "hello", clientId: "c2", extensionVersion: "0" }));
    await waitForWsMessage(ws1, (m) => m?.type === "hello_ack", 1000);
    await waitForWsMessage(ws2, (m) => m?.type === "hello_ack", 1000);

    const hits = { c1: 0, c2: 0 };
    for (const [name, ws] of [["c1", ws1], ["c2", ws2]]) {
      ws.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "cmd") {
          hits[name] += 1;
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result: { from: name } }));
        }
      });
    }

    const results = await Promise.all([
      bridge.call("listTabs", { n: 1 }, 1000),
      bridge.call("listTabs", { n: 2 }, 1000),
      bridge.call("listTabs", { n: 3 }, 1000),
      bridge.call("listTabs", { n: 4 }, 1000)
    ]);

    assert.equal(results.length, 4);
    assert.ok(hits.c1 > 0);
    assert.ok(hits.c2 > 0);
  } finally {
    ws1.close();
    ws2.close();
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

test("WsBridge: pending call is retried to another client after disconnect", async () => {
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

    let pendingCmdId = null;
    const gotCmd = new Promise((resolve) => {
      ws1.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "cmd") {
          pendingCmdId = msg.id;
          resolve(msg);
        }
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

    ws1.close();
    const resent = await waitForWsMessage(ws2, (m) => m?.type === "cmd" && m?.id === pendingCmdId, 2000);
    ws2.send(JSON.stringify({ type: "res", id: resent.id, ok: true, result: { recovered: true } }));

    const outcome = await callOutcome;
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.value, { recovered: true });
  } finally {
    ws1.close();
    ws2?.close();
    await bridge.stop();
  }
});

test("WsBridge: retryable error is retried and non-retryable keeps reason/code", async () => {
  const port = await getFreePort();
  const bridge = new WsBridge({ host: "127.0.0.1", port, log: () => {} });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "hello", clientId: "c", extensionVersion: "0" }));
    await waitForWsMessage(ws, (m) => m?.type === "hello_ack", 1000);

    const seen = new Map();
    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type !== "cmd") return;
      const count = (seen.get(msg.id) ?? 0) + 1;
      seen.set(msg.id, count);

      if (msg.cmd === "retryable_cmd") {
        if (count === 1) {
          ws.send(JSON.stringify({
            type: "res",
            id: msg.id,
            ok: false,
            error: { message: "temp", reason: "temp_fail", code: "TEMP", retryable: true }
          }));
          return;
        }
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result: { ok: true } }));
        return;
      }

      if (msg.cmd === "fatal_cmd") {
        ws.send(JSON.stringify({
          type: "res",
          id: msg.id,
          ok: false,
          error: { message: "fatal", reason: "bad_input", code: "INVALID", retryable: false }
        }));
      }
    });

    const retryResult = await bridge.call("retryable_cmd", {}, 1000);
    assert.deepEqual(retryResult, { ok: true });

    await assert.rejects(
      () => bridge.call("fatal_cmd", {}, 1000),
      (err) => {
        assert.equal(err?.message, "fatal");
        assert.equal(err?.reason, "bad_input");
        assert.equal(err?.code, "INVALID");
        assert.equal(err?.retryable, false);
        return true;
      }
    );
  } finally {
    ws.close();
    await bridge.stop();
  }
});

test("WsBridge: burst concurrent calls remain stable", async () => {
  const port = await getFreePort();
  const bridge = new WsBridge({ host: "127.0.0.1", port, log: () => {} });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "hello", clientId: "c", extensionVersion: "0" }));
    await waitForWsMessage(ws, (m) => m?.type === "hello_ack", 1000);

    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "cmd") {
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, result: { id: msg.id } }));
      }
    });

    const total = 40;
    const tasks = [];
    for (let i = 0; i < total; i += 1) {
      tasks.push(bridge.call("listTabs", { i }, 2000));
    }
    const results = await Promise.all(tasks);
    assert.equal(results.length, total);
    for (const item of results) {
      assert.ok(typeof item?.id === "string");
    }
  } finally {
    ws.close();
    await bridge.stop();
  }
});

test("WsBridge: heartbeat closes client when pong is missing", async () => {
  const port = await getFreePort();
  const logs = [];
  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: (...args) => logs.push(args.map(String).join(" ")),
    heartbeatIntervalMs: 20,
    pongTimeoutMs: 70,
    retryJitterMaxMs: 1,
    retryWaitForClientMs: 50,
  });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "hello", clientId: "hb", extensionVersion: "0" }));
    await waitForWsMessage(ws, (m) => m?.type === "hello_ack", 1000);

    const closed = await waitForWsCloseInfo(ws, 2000);
    assert.equal(closed.code, 4002);
    assert.match(closed.reason, /pong_timeout/i);
    assert.ok(logs.some((line) => line.includes("heartbeat timeout")));
  } finally {
    ws.close();
    await bridge.stop();
  }
});

test("WsBridge: abrupt close (1006) retries pending call to another client", async () => {
  const port = await getFreePort();
  const logs = [];
  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: (...args) => logs.push(args.map(String).join(" ")),
    retryJitterMaxMs: 1,
    retryWaitForClientMs: 300,
  });
  await bridge.start();

  const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
  let ws2 = null;
  try {
    await waitForWsOpen(ws1);
    ws1.send(JSON.stringify({ type: "hello", clientId: "a", extensionVersion: "0" }));
    await waitForWsMessage(ws1, (m) => m?.type === "hello_ack", 1000);

    let pendingCmdId = null;
    const gotCmd = new Promise((resolve) => {
      ws1.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "cmd") {
          pendingCmdId = msg.id;
          resolve(msg);
        }
      });
    });

    const callPromise = bridge.call("listTabs", {}, 1500);
    await gotCmd;

    ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForWsOpen(ws2);
    ws2.send(JSON.stringify({ type: "hello", clientId: "b", extensionVersion: "0" }));
    await waitForWsMessage(ws2, (m) => m?.type === "hello_ack", 1000);

    ws1.terminate();
    const resent = await waitForWsMessage(ws2, (m) => m?.type === "cmd" && m?.id === pendingCmdId, 2000);
    ws2.send(JSON.stringify({ type: "res", id: resent.id, ok: true, result: { recovered: "abrupt" } }));

    const result = await callPromise;
    assert.deepEqual(result, { recovered: "abrupt" });
    assert.ok(logs.some((line) => line.includes("code=1006")));
    assert.ok(logs.some((line) => line.includes("retry dispatch")));
  } finally {
    ws1.close();
    ws2?.close();
    await bridge.stop();
  }
});

test("WsBridge: retry regression - exhausted retries logs schedule and no_client", async () => {
  const port = await getFreePort();
  const logs = [];
  const bridge = new WsBridge({
    host: "127.0.0.1",
    port,
    log: (...args) => logs.push(args.map(String).join(" ")),
    retryJitterMaxMs: 1,
    retryWaitForClientMs: 40,
  });
  await bridge.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await waitForWsOpen(ws);
    ws.send(JSON.stringify({ type: "hello", clientId: "single", extensionVersion: "0" }));
    await waitForWsMessage(ws, (m) => m?.type === "hello_ack", 1000);

    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type !== "cmd") return;
      ws.send(JSON.stringify({
        type: "res",
        id: msg.id,
        ok: false,
        error: { message: "temp", reason: "transient", code: "TEMP", retryable: true },
      }));
      ws.close();
    });

    await assert.rejects(() => bridge.call("retry_until_fail", {}, 1000), /not connected/i);
    assert.ok(logs.some((line) => line.includes("retry schedule")));
    assert.ok(logs.some((line) => line.includes("retry no_client")));
  } finally {
    ws.close();
    await bridge.stop();
  }
});
