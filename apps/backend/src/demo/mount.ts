/**
 * DEMO WORKSPACE: a second, isolated dashboard app over the sample world (world.ts), mounted on the main server at
 * /demo-api. Same API surface as /api (the demo app's own routes are /api/…; /demo-api/x is rewritten to /api/x), plus
 *   POST /demo-api/demo/enter {role: "owner"|"insurer"} → signs the sample person in (cookie, Path=/demo-api) and
 *        returns their unlock key in the browser's storage format;
 *   POST /demo-api/demo/exit → ends the demo sessions and clears the demo cookies;
 *   GET  /demo-api/demo/info → {available, label, resetsOn}.
 * Demo cookies have their own names and Path=/demo-api, so they never reach (or mix with) the real /api sessions.
 * Robot actions answer 409; nothing here calls a real network. State lives in memory + a temp dir: restart resets it.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createDashboard } from "../dashboard/server.js";
import { errMsg } from "../shared/util.js";
import { buildDemoWorld, DEMO_ACTIONS_OFF, DEMO_LABEL, type DemoWorld } from "./world.js";

export const DEMO_BASE = "/demo-api";

export interface DemoInstance {
  world: DemoWorld;
  dashboard: ReturnType<typeof createDashboard>;
}

export async function createDemo(): Promise<DemoInstance> {
  const world = await buildDemoWorld();
  const dashboard = createDashboard(world.options);
  world.attachDesk(dashboard.desk);
  return { world, dashboard };
}

// robot actions and relays: answered here so the message is the same whoever asks
const ACTION = /^\/api\/(episode\/start|control(\/|$)|sim(\/|$)|zerobot\/dispatch|episodes\/[^/]+\/relay$|relay\/bundle$)/;

/** A router serving the demo workspace (mount it at /demo-api). The sample world is built in the background. */
export function demoRouter(ready: Promise<DemoInstance> = createDemo()): express.Router {
  ready.catch((e) => console.warn("demo workspace failed to build:", e));
  const r = express.Router();
  r.use(express.json({ limit: "64kb" }));
  const withDemo = (fn: (d: DemoInstance, req: Request, res: Response, next: NextFunction) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    ready.then(
      (d) => fn(d, req, res, next),
      (e) => res.status(503).json({ error: `demo workspace unavailable: ${errMsg(e)}` }),
    );
  };
  const cookieOpts = (d: DemoInstance, maxAge: number) => ({ httpOnly: true, sameSite: "lax" as const, path: d.dashboard.auth.cookies.path, maxAge });

  r.get("/demo/info", (_req, res) => {
    res.json({ available: true, label: DEMO_LABEL, resetsOn: "server restart" });
  });
  r.post("/demo/enter", withDemo((d, req, res) => {
    const role = (req.body as { role?: unknown } | undefined)?.role;
    const { auth } = d.dashboard;
    if (role === "owner") {
      res.cookie(auth.cookies.owner, auth.ownerSession(d.world.accountId), cookieOpts(d, 12 * 3600_000));
      res.json({ role, label: DEMO_LABEL, owner: { accountId: d.world.accountId, keyRecord: d.world.ownerKeyRecord } });
      return;
    }
    if (role === "insurer") {
      const token = auth.insurerSession();
      if (!token) {
        res.status(503).json({ error: "demo insurer wallet missing" });
        return;
      }
      res.cookie(auth.cookies.insurer, token, cookieOpts(d, 8 * 3600_000));
      res.json({ role, label: DEMO_LABEL, insurer: { address: d.world.insurerWallet.address, keyRecord: d.world.insurerKeyRecord } });
      return;
    }
    res.status(400).json({ error: 'role must be "owner" or "insurer"' });
  }));
  r.post("/demo/exit", withDemo((d, req, res) => {
    const { auth } = d.dashboard;
    auth.end(req.headers.cookie);
    res.clearCookie(auth.cookies.owner, { path: auth.cookies.path });
    res.clearCookie(auth.cookies.insurer, { path: auth.cookies.path });
    res.json({ ok: true });
  }));

  // everything else: the demo dashboard app, at its own /api/… paths
  r.use(withDemo((d, req, res, next) => {
    const saved = { url: req.url, originalUrl: req.originalUrl };
    const url = `/api${req.url === "/" ? "" : req.url}`;
    if (req.method !== "GET" && req.method !== "HEAD" && ACTION.test(url.split("?")[0]!)) {
      res.status(409).json({ error: DEMO_ACTIONS_OFF });
      return;
    }
    req.url = url;
    req.originalUrl = url; // the dashboard forwards req.originalUrl to the (simulated) robot
    const proto = { req: Object.getPrototypeOf(req), res: Object.getPrototypeOf(res) };
    (d.dashboard.app as unknown as (q: Request, s: Response, n: NextFunction) => void)(req, res, (err?: unknown) => {
      Object.setPrototypeOf(req, proto.req);
      Object.setPrototypeOf(res, proto.res);
      req.url = saved.url;
      req.originalUrl = saved.originalUrl;
      next(err);
    });
  }));
  return r;
}

/** Mounts the demo workspace on the main server at /demo-api. */
export function mountDemo(app: Express, ready?: Promise<DemoInstance>): Promise<DemoInstance> {
  const p = ready ?? createDemo();
  app.use(DEMO_BASE, demoRouter(p));
  return p;
}
