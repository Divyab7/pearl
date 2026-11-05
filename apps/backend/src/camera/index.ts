/**
 * Camera source (prompt §8.2).
 *  - none: no image; the model gets the sim scene as JSON and the record says frameHash:null.
 *  - http: GET CAMERA_URL (a phone IP-camera app on the same hotspot returning one JPEG), 2 s timeout.
 *  - file: fixtures/frames/<checkpoint>.jpg (tests and the sim demo with real table photos).
 * A configured camera that gives no frame throws; the orchestrator turns that into a failsafe decision.
 * Never an old frame: every capture is a fresh request or a fresh file read, and the bytes are hashed per decision.
 * No image libraries (prompt §4): set the phone app to 640×480 instead of resizing here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../shared/env.js";

export interface Frame {
  dataUrl: string;
  bytes: Uint8Array;
}

export interface CameraSource {
  readonly kind: "none" | "http" | "file";
  capture(checkpoint: string): Promise<Frame | null>;
}

const MAX_JPEG_BYTES = 2_000_000;

function toFrame(bytes: Uint8Array, where: string): Frame {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`${where}: not a JPEG`);
  if (bytes.length > MAX_JPEG_BYTES) throw new Error(`${where}: ${bytes.length} bytes, over ${MAX_JPEG_BYTES} (set the phone app to 640×480)`);
  return { bytes, dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` };
}

export function httpCamera(url: string, timeoutMs = 2000, fetchImpl: typeof fetch = fetch): CameraSource {
  return {
    kind: "http",
    async capture() {
      // cache-busting query so a proxy or the phone app cannot hand back a stale frame
      const u = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (!r.ok) throw new Error(`camera HTTP ${r.status}`);
      return toFrame(new Uint8Array(await r.arrayBuffer()), "camera");
    },
  };
}

export function fileCamera(dir = resolve(REPO_ROOT, "fixtures", "frames")): CameraSource {
  return {
    kind: "file",
    async capture(checkpoint) {
      const p = resolve(dir, `${checkpoint.toLowerCase()}.jpg`);
      return toFrame(new Uint8Array(readFileSync(p)), p);
    },
  };
}

export function cameraFromEnv(): CameraSource {
  const kind = process.env.CAMERA_SOURCE ?? "none";
  if (kind === "none") return { kind: "none", capture: async () => null };
  if (kind === "http") {
    const url = process.env.CAMERA_URL;
    if (!url) throw new Error("CAMERA_SOURCE=http needs CAMERA_URL");
    return httpCamera(url);
  }
  if (kind === "file") return fileCamera();
  throw new Error(`CAMERA_SOURCE must be none, http or file, got ${kind}`);
}
