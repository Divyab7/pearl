/**
 * Minimal JSON-RPC 2.0 over HTTP (POST {jsonrpc,method,params,id}), with an injectable fetch so the relay, the bundle
 * builder and the tests never need a live node. Errors keep the node's own message (relayers match on it, e.g.
 * "already known" / "nonce too low").
 */
import { errMsg } from "../shared/util.js";

export type JsonRpc = (url: string, method: string, params?: unknown[]) => Promise<unknown>;

export class RpcError extends Error {
  constructor(readonly method: string, message: string, readonly code?: number) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
  }
}

export function httpJsonRpc(fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): JsonRpc {
  let id = 0;
  return async (url, method, params = []) => {
    let r: Response;
    try {
      r = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: ++id }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RpcError(method, `no response from ${url.replace(/\/[^/]{20,}$/, "/…")}: ${errMsg(e)}`);
    }
    const text = await r.text();
    let body: { result?: unknown; error?: { message?: string; code?: number; data?: unknown } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new RpcError(method, `HTTP ${r.status} ${text.slice(0, 120)}`);
    }
    if (body.error) {
      const data = typeof body.error.data === "string" ? ` (${body.error.data})` : "";
      throw new RpcError(method, `${body.error.message ?? "error"}${data}`, body.error.code);
    }
    return body.result ?? null;
  };
}

export const hexQty = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;
export const qtyBig = (v: unknown): bigint => (typeof v === "string" && v.startsWith("0x") ? BigInt(v) : BigInt(String(v ?? 0)));
