import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

type Logger = (...args: unknown[]) => void;

type WsBridgeArgs = {
  host: string;
  port: number;
  log: Logger;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

type AuthedClient = {
  ws: WebSocket;
  clientId?: string;
  extensionVersion?: string;
};

export class WsBridge {
  private host: string;
  private port: number;
  private log: Logger;
  private wss: WebSocketServer | null = null;
  private client: AuthedClient | null = null;
  private pending = new Map<string, Pending>();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(args: WsBridgeArgs) {
    this.host = args.host;
    this.port = args.port;
    this.log = args.log;
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
        // Fail fast: without the WS server, tools can't reach Chrome anyway.
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
    const clientWs = this.client?.ws ?? null;
    this.wss = null;
    this.client = null;
    this.stopPing();
    this.failAllPending(new Error("WS server stopped."));

    if (!wss) return;
    // Close any active extension connection(s) to avoid dangling handles.
    try {
      clientWs?.close();
    } catch {
      // ignore
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
    let authed = false;

    ws.on("open", () => {
      this.log("ws client connected");
    });

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
        // If a previous extension connection exists, replace it.
        if (this.client?.ws && this.client.ws !== ws) {
          try {
            this.client.ws.close();
          } catch {
            // ignore
          }
          this.failAllPending(new Error("Extension reconnected."));
          this.stopPing();
        }
        this.client = {
          ws,
          clientId: msg?.clientId,
          extensionVersion: msg?.extensionVersion,
        };

        // Start sending pings to keep the connection alive
        this.startPing();

        ws.send(JSON.stringify({ type: "hello_ack" }));
        this.log(
          `extension connected clientId=${this.client.clientId ?? "?"} version=${
            this.client.extensionVersion ?? "?"
          }`
        );
        return;
      }

      if (msg?.type === "res" && typeof msg?.id === "string") {
        const pending = this.pending.get(msg.id);
        if (!pending) return;

        clearTimeout(pending.timeout);
        this.pending.delete(msg.id);

        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg?.error?.message ?? "Unknown error"));
        return;
      }

      if (msg?.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
        return;
      }

      // ignore unknown messages
    });

    ws.on("close", () => {
      if (this.client?.ws === ws) {
        this.log("extension disconnected");
        this.client = null;
        this.stopPing();
        this.failAllPending(new Error("Extension disconnected."));
      }
    });

    ws.on("error", (err) => {
      this.log("ws error", String(err));
      if (this.client?.ws === ws) {
        this.client = null;
        this.stopPing();
        this.failAllPending(new Error("Extension websocket error."));
      }
    });
  }

  private failAllPending(err: Error) {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timeout);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private startPing() {
    if (this.pingInterval) return;
    // Send ping every 10 seconds to keep the connection alive
    this.pingInterval = setInterval(() => {
      const ws = this.client?.ws;
      if (ws && ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // ignore
        }
      }
    }, 10000);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  async call(cmd: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const ws = this.client?.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error(
        `Chrome extension is not connected on ws://${this.host}:${this.port}. Ensure the extension is enabled and reachable.`
      );
    }

    const id = crypto.randomUUID();
    const payload = { type: "cmd", id, cmd, params };

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for extension response (cmd=${cmd}).`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(String(err)));
      }
    });
  }
}
