/**
 * mDNS / DNS-SD for the laptop relay (spec §3): the dashboard server advertises `_pearl-relay._tcp` (port 8080,
 * TXT path=/api/relay, v=1); a robot on the same Wi-Fi without internet browses for it.
 * Library: bonjour-service (maintained TypeScript fork of bonjour; multicast-dns underneath).
 * RELAY_URL (e.g. http://192.168.1.20:8080/api/relay) overrides discovery on the robot.
 */
import { Bonjour, type Service } from "bonjour-service";
import { hostname } from "node:os";

export const RELAY_SERVICE_TYPE = "pearl-relay"; // → _pearl-relay._tcp
export const RELAY_PATH = "/api/relay";

/** Starts advertising; returns a stop function. */
export function advertiseRelay(port: number): () => void {
  const b = new Bonjour();
  b.publish({ name: `Pearl relay ${hostname()}`.slice(0, 63), type: RELAY_SERVICE_TYPE, protocol: "tcp", port, txt: { path: RELAY_PATH, v: "1" } });
  return () => {
    b.unpublishAll(() => b.destroy());
  };
}

/** Base URL of the relay API from a resolved service (prefers an IPv4 address). */
export function relayUrlOf(s: Pick<Service, "addresses" | "host" | "port" | "txt">): string {
  const v4 = (s.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const host = v4 ?? s.host;
  const path = typeof s.txt?.path === "string" && s.txt.path.startsWith("/") ? s.txt.path : RELAY_PATH;
  return `http://${host}:${s.port}${path}`;
}

/** RELAY_URL if set, else the first `_pearl-relay._tcp` service seen within timeoutMs; null when none. */
export async function discoverRelay(timeoutMs = 3000): Promise<string | null> {
  const env = process.env.RELAY_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  return new Promise((resolveUrl) => {
    const b = new Bonjour();
    let done = false;
    const finish = (url: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      browser.stop();
      b.destroy();
      resolveUrl(url);
    };
    const browser = b.find({ type: RELAY_SERVICE_TYPE, protocol: "tcp" }, (s) => finish(relayUrlOf(s)));
    const t = setTimeout(() => finish(null), timeoutMs);
  });
}
