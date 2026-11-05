import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInsurerApp } from "./insurer.js";

let base = "";
let server: ReturnType<ReturnType<typeof createInsurerApp>["listen"]>;
beforeAll(async () => {
  server = createInsurerApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const post = (body: unknown) =>
  fetch(`${base}/assess`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("mock insurer", () => {
  const claim = { claimId: "cl_1", episodeId: "ep_1", severity: 2, outcome: "TRIPPED", verified: true };

  it("approves a verified severity-2 claim", async () => {
    expect(await (await post(claim)).json()).toMatchObject({ status: "APPROVED", amount: 10000 });
  });
  it("is idempotent by claimId and refuses changed details", async () => {
    expect(await (await post(claim)).json()).toMatchObject({ status: "APPROVED", idempotent: true });
    expect((await post({ ...claim, severity: 3 })).status).toBe(409);
  });
  it("denies unverified or low-severity claims", async () => {
    expect(await (await post({ ...claim, claimId: "cl_2", verified: false })).json()).toMatchObject({ status: "DENIED" });
    expect(await (await post({ ...claim, claimId: "cl_3", severity: 1 })).json()).toMatchObject({ status: "DENIED" });
  });
  it("rejects malformed bodies", async () => {
    expect((await post({ ...claim, claimId: "cl_4", extra: 1 })).status).toBe(400);
  });
});
