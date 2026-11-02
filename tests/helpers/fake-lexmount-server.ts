import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

type JsonObject = Record<string, unknown>;

export interface FakeHttpRecord {
  method: string;
  path: string;
  body: string;
  headers: IncomingHttpHeaders;
}

interface CdpState {
  navigatedUrl: string;
  staleLeft: number;
  navigated: boolean;
}

export class FakeLexmountServer {
  createStatus = 200;
  createDelayMs = 0;
  versionStatus = 200;
  sessionPollsBeforeActive = 1;
  staleStatePolls = 2;
  stallNavigate = false;
  pingBeforeReplies = false;
  searchScrape: JsonObject = {};
  detailScrape: JsonObject = {};
  landedPath = "";

  readonly http: FakeHttpRecord[] = [];
  readonly commands: string[] = [];
  created = 0;

  private baseUrl = "";
  private closed = false;
  private readonly polls = new Map<string, number>();
  private readonly sockets = new Set<Socket>();
  private readonly clients = new Set<WebSocket>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly websocketServer = new WebSocketServer({
    noServer: true,
  });
  private readonly server: Server = createServer((request, response) => {
    void this.handleHttp(request, response);
  });

  constructor() {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server.on("upgrade", (request, socket, head) => {
      this.websocketServer.handleUpgrade(
        request,
        socket,
        head,
        (client) => this.websocketServer.emit("connection", client),
      );
    });
    this.websocketServer.on("connection", (client) => {
      this.clients.add(client);
      const state: CdpState = {
        navigatedUrl: "",
        staleLeft: 0,
        navigated: false,
      };
      client.on("message", (data) => {
        this.handleCommand(client, state, data);
      });
      client.on("close", () => this.clients.delete(client));
    });
  }

  get url(): string {
    return this.baseUrl;
  }

  get deletes(): number {
    return this.http.filter((record) => record.method === "DELETE").length;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("fake Lexmount server has no address");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.websocketServer.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const record: FakeHttpRecord = {
      method: request.method ?? "",
      path: request.url ?? "/",
      body,
      headers: request.headers,
    };
    this.http.push(record);
    this.route(response, record);
  }

  private route(response: ServerResponse, record: FakeHttpRecord): void {
    const url = new URL(record.path, "http://127.0.0.1");
    if (record.method === "POST" && url.pathname === "/instance/v2") {
      if (this.createStatus !== 200) {
        this.reply(response, this.createStatus);
        return;
      }
      const id = `s${++this.created}`;
      this.polls.set(id, 0);
      const send = (): void => {
        if (!response.destroyed) {
          this.reply(response, 200, { session_id: id });
        }
      };
      if (this.createDelayMs > 0) {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          send();
        }, this.createDelayMs);
        this.timers.add(timer);
      } else {
        send();
      }
      return;
    }
    if (record.method === "POST" && url.pathname === "/instance/session") {
      const decoded = JSON.parse(record.body) as JsonObject;
      const id =
        typeof decoded.session_id === "string" ? decoded.session_id : "";
      const poll = (this.polls.get(id) ?? 0) + 1;
      this.polls.set(id, poll);
      this.reply(response, 200, {
        status:
          poll > this.sessionPollsBeforeActive ? "active" : "creating",
      });
      return;
    }
    if (record.method === "GET" && url.pathname.startsWith("/json/version")) {
      if (this.versionStatus !== 200) {
        this.reply(response, this.versionStatus);
        return;
      }
      const sessionId = url.searchParams.get("session_id") ?? "x";
      const wsUrl = `ws://127.0.0.1:${this.port}/devtools/browser/${sessionId}`;
      this.reply(response, 200, { webSocketDebuggerUrl: wsUrl });
      return;
    }
    if (record.method === "DELETE" && url.pathname === "/instance") {
      this.reply(response, 200);
      return;
    }
    this.reply(response, 404);
  }

  private get port(): number {
    const address = this.server.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  private reply(
    response: ServerResponse,
    status: number,
    body: JsonObject = {},
  ): void {
    if (response.headersSent || response.destroyed) {
      return;
    }
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(encoded),
      connection: "close",
    });
    response.end(encoded);
  }

  private handleCommand(
    client: WebSocket,
    state: CdpState,
    data: RawData,
  ): void {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Buffer.from(data).toString("utf8");
    const message = JSON.parse(text) as JsonObject;
    const id = typeof message.id === "number" ? message.id : 0;
    const method =
      typeof message.method === "string" ? message.method : "";
    const params =
      typeof message.params === "object" &&
      message.params !== null &&
      !Array.isArray(message.params)
        ? (message.params as JsonObject)
        : {};
    let result: JsonObject = {};
    let recorded = method;

    if (method === "Target.getTargets") {
      result = {
        targetInfos: [{ type: "page", targetId: "t1" }],
      };
    } else if (method === "Target.attachToTarget") {
      result = { sessionId: "cdp1" };
    } else if (method === "Page.navigate") {
      state.navigatedUrl =
        typeof params.url === "string" ? params.url : "";
      state.navigated = true;
      state.staleLeft = this.staleStatePolls;
      if (this.stallNavigate) {
        this.commands.push(recorded);
        return;
      }
      result = { frameId: "f1" };
    } else if (method === "Runtime.evaluate") {
      const expression =
        typeof params.expression === "string" ? params.expression : "";
      if (expression.includes("location.href")) {
        recorded += ":state";
        let value: JsonObject;
        if (!state.navigated || state.staleLeft > 0) {
          if (state.staleLeft > 0) {
            state.staleLeft -= 1;
          }
          value = {
            href: "about:blank",
            ready: "complete",
            title: "",
          };
        } else {
          const navigated = new URL(state.navigatedUrl);
          const path =
            this.landedPath.length > 0
              ? this.landedPath
              : navigated.pathname;
          value = {
            href: `https://www.xiachufang.com${path}`,
            ready: "complete",
            title: "下厨房",
          };
        }
        result = {
          result: { type: "object", value },
        };
      } else {
        recorded += ":scrape";
        const search = expression.includes("const kind = 'search'");
        result = {
          result: {
            type: "object",
            value: search ? this.searchScrape : this.detailScrape,
          },
        };
      }
    }

    this.commands.push(recorded);
    const reply: JsonObject = { id, result };
    if (typeof message.sessionId === "string") {
      reply.sessionId = message.sessionId;
    }
    this.sendJson(client, reply);
  }

  private sendJson(client: WebSocket, message: JsonObject): void {
    if (this.pingBeforeReplies) {
      client.ping(Buffer.alloc(125, "p"));
    }
    client.send(JSON.stringify(message));
  }
}
