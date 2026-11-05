/** Server-Sent Events hub: https://html.spec.whatwg.org/multipage/server-sent-events.html */
import type { Request, Response } from "express";

export class SseHub {
  private clients = new Set<Response>();

  handler = (req: Request, res: Response): void => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(": connected\n\n");
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  };

  send(type: string, data: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  get size(): number {
    return this.clients.size;
  }
}
