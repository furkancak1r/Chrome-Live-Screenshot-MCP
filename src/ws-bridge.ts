import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

type Logger = (...args: unknown[]) => void;

type WsBridgeArgs = {
  host: string;
  port: number;
  endpointHost?: string;
  log: Logger;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  retryJitterMaxMs?: number;
  retryWaitForClientMs?: number;
};

type Pending = {
  id: string;
  cmd: string;
  params: unknown;
  clientKey: string;
  timeoutMs: number;
  attempt: number;
  maxAttempts: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

type BridgeErrorShape = {
  message: string;
  reason?: string;
  code?: string;
  retryable?: boolean;
};

type AuthedClient = {
  key: string;
  ws: WebSocket;
  clientId?: string;
  extensionVersion?: string;
  lastPongAt: number;
  alive: boolean;
};

const BASE_RETRY_BACKOFF_MS = 150;
const MAX_RETRY_BACKOFF_MS = 2_000;
const MAX_ATTEMPTS = 3;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 25_000;
const RETRY_JITTER_MAX_MS = 100;
const RETRY_WAIT_FOR_CLIENT_MS = 1_200;

class BridgeError extends Error {
  reason?: string;
  code?: string;
  retryable?: boolean;

  constructor(shape: BridgeErrorShape) {
    super(shape.message);
    this.reason = shape.reason;
    this.code = shape.code;
    this.retryable = shape.retryable;
  }
}

export class WsBridge {
  private host: string;
  private endpointHost: string;
  private port: number;
  private log: Logger;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, AuthedClient>();
  private rrClientKeys: string[] = [];
  private rrCursor = 0;
  private pending = new Map<string, Pending>();
  private pendingByClient = new Map<string, Set<string>>();
  private pingInterval: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs: number;
  private pongTimeoutMs: number;
  private retryJitterMaxMs: number;
  private retryWaitForClientMs: number;

  constructor(args: WsBridgeArgs) {
    this.host = args.host;
    this.endpointHost = args.endpointHost ?? args.host;
    this.port = args.port;
    this.log = args.log;
    this.heartbeatIntervalMs = args.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.pongTimeoutMs = args.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.retryJitterMaxMs = args.retryJitterMaxMs ?? RETRY_JITTER_MAX_MS;
    this.retryWaitForClientMs = args.retryWaitForClientMs ?? RETRY_WAIT_FOR_CLIENT_MS;
  }

  start(): Promise<void> {
    if (this.wss) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let started = false;

      const wss = new WebSocketServer(
        { host: this.host, port: this.port },
        () => {
          started = true;
          this.log("ws server listening");
          resolve();
        }
      );
      this.wss = wss;

      wss.on("connection", (ws) => this.onConnection(ws));
      wss.on("error", (err) => {
        this.log("ws server error", String(err));
        this.failAllPending(new Error("WS server error."));
        if (!started) {
          try {
            wss.close();
          } catch {
            // ignore
          }
          this.wss = null;
          reject(err as Error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.rrClientKeys = [];
    this.rrCursor = 0;
    this.stopPing();
    this.failAllPending(new Error("WS server stopped."));

    if (!wss) return;
    for (const client of clients) {
      try {
        client.ws.close();
      } catch {
        // ignore
      }
    }
    try {
      for (const c of wss.clients) {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      try {
        wss.close(() => resolve(true));
      } catch {
        resolve(true);
      }
    });
  }

  private onConnection(ws: WebSocket) {
    const key = crypto.randomUUID();
    let authed = false;

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        this.log("ws message parse error", String(e));
        return;
      }

      if (!authed) {
        if (msg?.type !== "hello") {
          ws.send(
            JSON.stringify({ type: "error", message: "Expected hello first." })
          );
          ws.close();
          return;
        }

        authed = true;
        const client: AuthedClient = {
          key,
          ws,
          clientId: msg?.clientId,
          extensionVersion: msg?.extensionVersion,
          lastPongAt: Date.now(),
          alive: true,
        };
        this.clients.set(key, client);
        this.rrClientKeys.push(key);

        this.startPing();

        ws.send(JSON.stringify({ type: "hello_ack" }));
        this.log(
          `extension connected key=${key} clientId=${client.clientId ?? "?"} version=${
            client.extensionVersion ?? "?"
          }`
        );
        return;
      }

        if (msg?.type === "res" && typeof msg?.id === "string") {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        if (pending.clientKey !== key) return;

        clearTimeout(pending.timeout);
        this.pending.delete(msg.id);
        this.removePendingFromClient(pending.clientKey, pending.id);

        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          const bridgeErr = this.toBridgeError(msg?.error);
          if (bridgeErr.retryable === true && pending.attempt < pending.maxAttempts) {
            void this.retryPending(pending, bridgeErr);
          } else {
            pending.reject(bridgeErr);
          }
        }
        return;
      }

        if (msg?.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
          return;
        }

        if (msg?.type === "pong") {
          const client = this.clients.get(key);
          if (client) {
            client.lastPongAt = Date.now();
            client.alive = true;
          }
          return;
        }

        // ignore unknown messages
      });

    ws.on("close", (code, reasonBuf) => {
      const reasonText = reasonBuf?.toString() || "";
      this.log(
        `ws close key=${key} code=${code} reason=${reasonText || "-"} abnormal=${code === 1006}`
      );
      this.removeClient(
        key,
        new Error(`Extension disconnected (code=${code}, reason=${reasonText || "n/a"}).`)
      );
    });

    ws.on("error", (err) => {
      this.log(`ws error key=${key} err=${String(err)}`);
      this.removeClient(key, new Error(`Extension websocket error: ${String(err)}`));
    });
  }

  private toBridgeError(input: unknown): BridgeError {
    const fallback = new BridgeError({ message: "Unknown error" });
    if (!input || typeof input !== "object") return fallback;
    const maybe = input as Record<string, unknown>;
    return new BridgeError({
      message: typeof maybe.message === "string" ? maybe.message : "Unknown error",
      reason: typeof maybe.reason === "string" ? maybe.reason : undefined,
      code: typeof maybe.code === "string" ? maybe.code : undefined,
      retryable: typeof maybe.retryable === "boolean" ? maybe.retryable : undefined,
    });
  }

  private removePendingFromClient(clientKey: string, pendingId: string) {
    const ids = this.pendingByClient.get(clientKey);
    if (!ids) return;
    ids.delete(pendingId);
    if (ids.size === 0) this.pendingByClient.delete(clientKey);
  }

  private removeClient(clientKey: string, reason: Error) {
    const client = this.clients.get(clientKey);
    if (!client) return;

    this.clients.delete(clientKey);
    this.rrClientKeys = this.rrClientKeys.filter((k) => k !== clientKey);
    if (this.rrCursor >= this.rrClientKeys.length) this.rrCursor = 0;

    const pendingIds = this.pendingByClient.get(clientKey);
    if (pendingIds) {
      for (const pendingId of pendingIds) {
        const p = this.pending.get(pendingId);
        if (!p) continue;
        clearTimeout(p.timeout);
        this.pending.delete(pendingId);
        if (p.attempt < p.maxAttempts) {
          void this.retryPending(p, reason);
        } else {
          p.reject(reason);
        }
      }
      this.pendingByClient.delete(clientKey);
    }

    this.log(
      `extension disconnected key=${clientKey} pending=${pendingIds?.size ?? 0} reason=${reason.message}`
    );
    if (this.clients.size === 0) {
      this.stopPing();
    }
  }

  private failAllPending(err: Error) {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timeout);
      p.reject(err);
      this.pending.delete(id);
      this.removePendingFromClient(p.clientKey, id);
    }
  }

  private startPing() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      for (const client of this.clients.values()) {
        const ws = client.ws;
        if (ws.readyState !== ws.OPEN) {
          this.log(`heartbeat skip key=${client.key} reason=not_open readyState=${ws.readyState}`);
          continue;
        }

        const sincePongMs = now - client.lastPongAt;
        if (sincePongMs > this.pongTimeoutMs) {
          this.log(
            `heartbeat timeout key=${client.key} sincePongMs=${sincePongMs} timeoutMs=${this.pongTimeoutMs}`
          );
          try {
            ws.close(4002, "pong_timeout");
          } catch {
            // ignore
          }
          this.removeClient(
            client.key,
            new Error(`Heartbeat timeout (no pong for ${sincePongMs}ms).`)
          );
          continue;
        }

        try {
          ws.send(JSON.stringify({ type: "ping" }));
          this.log(
            `heartbeat ping key=${client.key} sincePongMs=${sincePongMs} timeoutMs=${this.pongTimeoutMs}`
          );
        } catch {
          // ignore
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  setPort(port: number): void {
    this.port = port;
  }

  setHost(host: string): void {
    this.host = host;
  }

  setEndpointHost(host: string): void {
    this.endpointHost = host;
  }

  getPort(): number {
    return this.port;
  }

  private getConnectedClientKey(): string | null {
    if (this.rrClientKeys.length === 0) return null;

    const count = this.rrClientKeys.length;
    for (let i = 0; i < count; i += 1) {
      const idx = (this.rrCursor + i) % count;
      const key = this.rrClientKeys[idx];
      const client = this.clients.get(key);
      if (!client) continue;
      if (client.ws.readyState !== client.ws.OPEN) continue;
      this.rrCursor = (idx + 1) % count;
      return key;
    }
    return null;
  }

  private async retryDelay(attempt: number, reason: Error): Promise<void> {
    const backoff = Math.min(
      MAX_RETRY_BACKOFF_MS,
      BASE_RETRY_BACKOFF_MS * 2 ** Math.max(0, attempt - 1)
    );
    const jitter = Math.floor(Math.random() * this.retryJitterMaxMs);
    this.log(
      `retry schedule attempt=${attempt + 1} baseAttempt=${attempt} delayMs=${backoff + jitter} backoffMs=${backoff} jitterMs=${jitter} reason=${reason.message}`
    );
    await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
  }

  private isRetryableError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const maybe = err as { retryable?: unknown };
    return maybe.retryable === true;
  }

  private connectionError(): Error {
    return new Error(
      `Chrome extension is not connected on ws://${this.endpointHost}:${this.port}. Ensure the extension is enabled and reachable.`
    );
  }

  private async waitForConnectedClient(maxWaitMs: number): Promise<string | null> {
    const immediate = this.getConnectedClientKey();
    if (immediate) return immediate;

    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const key = this.getConnectedClientKey();
      if (key) return key;
    }
    return null;
  }

  private async retryPending(pending: Pending, fallbackError: Error): Promise<void> {
    if (pending.attempt >= pending.maxAttempts) {
      this.log(
        `retry abort id=${pending.id} cmd=${pending.cmd} attempt=${pending.attempt} maxAttempts=${pending.maxAttempts} reason=${fallbackError.message}`
      );
      pending.reject(fallbackError);
      return;
    }

    await this.retryDelay(pending.attempt, fallbackError);

    const nextClientKey = await this.waitForConnectedClient(this.retryWaitForClientMs);
    if (!nextClientKey) {
      this.log(
        `retry no_client id=${pending.id} cmd=${pending.cmd} attempt=${pending.attempt + 1} reason=${fallbackError.message}`
      );
      pending.reject(this.connectionError());
      return;
    }

    this.log(
      `retry dispatch id=${pending.id} cmd=${pending.cmd} fromClient=${pending.clientKey} toClient=${nextClientKey} attempt=${pending.attempt + 1}`
    );

    const next: Pending = {
      ...pending,
      clientKey: nextClientKey,
      attempt: pending.attempt + 1,
      timeout: setTimeout(() => {}, 0),
    };
    clearTimeout(next.timeout);
    await this.dispatchPending(next);
  }

  private async dispatchPending(pending: Pending): Promise<void> {
    const id = pending.id;
    const clientKey = pending.clientKey;
    const ws = this.clients.get(clientKey)?.ws;

    if (!ws || ws.readyState !== ws.OPEN) {
      this.log(
        `dispatch unavailable id=${id} cmd=${pending.cmd} clientKey=${clientKey} readyState=${ws?.readyState ?? "missing"} attempt=${pending.attempt}`
      );
      await this.retryPending(pending, this.connectionError());
      return;
    }

    const timeout = setTimeout(() => {
      const current = this.pending.get(id);
      if (!current) return;
      if (current.clientKey !== clientKey || current.attempt !== pending.attempt) return;

      this.pending.delete(id);
      this.removePendingFromClient(clientKey, id);
      this.log(
        `dispatch timeout id=${id} cmd=${pending.cmd} clientKey=${clientKey} attempt=${pending.attempt} timeoutMs=${pending.timeoutMs}`
      );
      void this.retryPending(
        current,
        new Error(`Timeout waiting for extension response (cmd=${pending.cmd}).`)
      );
    }, pending.timeoutMs);

    const currentPending: Pending = {
      ...pending,
      timeout,
    };
    this.pending.set(id, currentPending);
    const ids = this.pendingByClient.get(clientKey) ?? new Set<string>();
    ids.add(id);
    this.pendingByClient.set(clientKey, ids);

    try {
      ws.send(JSON.stringify({ type: "cmd", id, cmd: pending.cmd, params: pending.params }));
      this.log(
        `dispatch sent id=${id} cmd=${pending.cmd} clientKey=${clientKey} attempt=${pending.attempt}`
      );
    } catch (err) {
      clearTimeout(timeout);
      this.pending.delete(id);
      this.removePendingFromClient(clientKey, id);
      this.log(
        `dispatch send_error id=${id} cmd=${pending.cmd} clientKey=${clientKey} attempt=${pending.attempt} err=${String(err)}`
      );
      await this.retryPending(currentPending, new Error(String(err)));
    }
  }

  async call(cmd: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const clientKey = this.getConnectedClientKey();
    if (!clientKey) {
      throw new Error(
        `Chrome extension is not connected on ws://${this.endpointHost}:${this.port}. Ensure the extension is enabled and reachable.`
      );
    }

    const id = crypto.randomUUID();

    return await new Promise((resolve, reject) => {
      const pending: Pending = {
        id,
        cmd,
        params,
        clientKey,
        timeoutMs,
        attempt: 1,
        maxAttempts: MAX_ATTEMPTS,
        resolve,
        reject,
        timeout: setTimeout(() => {}, 0),
      };
      clearTimeout(pending.timeout);
      void this.dispatchPending(pending);
    });
  }
}
