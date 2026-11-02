import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  bodyBytes: Buffer;
  body: string;
}

export interface MockReply {
  status?: number;
  body?: string;
  delayMs?: number;
  stall?: boolean;
  drop?: boolean;
}

export type Responder = (
  request: CapturedRequest,
  index: number,
) => MockReply | Promise<MockReply>;

export class FakeHttpServer {
  readonly requests: CapturedRequest[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private baseUrl = "";
  private closed = false;
  private garbageResponse = "";

  constructor(private readonly responder: Responder) {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  static fromReplies(...replies: MockReply[]): FakeHttpServer {
    return new FakeHttpServer((_request, index) => {
      const reply = replies[Math.min(index, replies.length - 1)];
      if (!reply) {
        throw new Error("fake service has no scripted reply");
      }
      return reply;
    });
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
      throw new Error("fake service has no address");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  get url(): string {
    return this.baseUrl;
  }

  get port(): number {
    const address = this.server.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  setGarbageResponse(bytes: string): void {
    this.garbageResponse = bytes;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.garbageResponse.length > 0) {
      response.socket?.write(this.garbageResponse);
      response.socket?.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyBytes = Buffer.concat(chunks);
    const captured: CapturedRequest = {
      method: request.method,
      path: request.url,
      headers: request.headers,
      bodyBytes,
      body: bodyBytes.toString("utf8"),
    };
    this.requests.push(captured);
    try {
      const reply = await this.responder(captured, this.requests.length - 1);
      if (reply.delayMs && reply.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, reply.delayMs));
      }
      if (reply.stall) {
        return;
      }
      if (reply.drop) {
        response.destroy();
        return;
      }
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(reply.body ?? "");
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
