/**
 * pnpm og:smoke [--image path/to.jpg | --text] [--models a,b,c] [--runs 3]
 * Calls the real 0G Router once per run per candidate model with a PLAN prompt and prints: source, request id,
 * X-Request-ID, echo, tee_verified, latency, and whether the answer is correct. Nothing is mocked.
 * Owner decision (4 Nov 2026): the decision model reads the camera image, so the candidates are image-capable models
 * from https://pc.0g.ai/models (all marked Verified there). The default image is fixtures/frames/plan.jpg (red cube on
 * A2, blue on A3), so "correct" means the model saw the picture and chose slot A2 without being told the scene.
 * --text sends the scene as JSON instead (the CAMERA_SOURCE=none path). Use the table to choose OG_MODEL and OG_TIMEOUT_MS.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../shared/env.js";
import { decide } from "../orchestrator/decision.js";
import { routerConfigFromEnv } from "../og/config.js";
import { systemPrompt } from "../og/prompts.js";

// image-capable, Verified tier, cheapest first by listed price (pc.0g.ai/models, checked 4 Nov 2026)
const DEFAULT_MODELS = ["minimax-m3.1-flash", "qwen3.8-flash", "mimo-v2.6-flash", "glm-5.3-flashx"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const base = routerConfigFromEnv();
  if (!base.apiKey || base.apiKey.startsWith("sk-...")) {
    console.error("OG_API_KEY is not set in .env (create one at pc.0g.ai and deposit 0G first).");
    process.exit(2);
  }
  const models = (arg("models") ?? DEFAULT_MODELS.join(",")).split(",");
  const runs = Number(arg("runs") ?? 1);
  const imagePath = process.argv.includes("--text") ? undefined : (arg("image") ?? resolve(REPO_ROOT, "fixtures", "frames", "plan.jpg"));
  const imageDataUrl = imagePath
    ? `data:image/jpeg;base64,${readFileSync(imagePath).toString("base64")}`
    : null;
  const sp = systemPrompt("PLAN");
  const context = {
    task: { task: "pick", color: "red", from: "A2", to: "BIN" },
    telemetry: { state: "WAITING", joints: [90, 90, 90, 10], tofMm: 812, accG: 1.0 },
    scene: imageDataUrl ? undefined : { slots: { A1: null, A2: "red", A3: "blue" }, claw: "open", holding: null },
  };

  const rows: string[][] = [];
  for (const model of models) {
    for (let i = 0; i < runs; i++) {
      const d = await decide(
        { ...base, model },
        {
          checkpoint: "PLAN",
          systemPrompt: sp.text,
          context,
          imageDataUrl,
          clientRequestId: `smoke:${model}:${Date.now()}:${i}`,
        },
      );
      rows.push([
        model,
        d.source,
        d.requestId ?? "-",
        d.httpRequestId ?? "-",
        String(d.clientRequestIdEchoed),
        String(d.teeVerified),
        `${d.latencyMs}`,
        d.parsed ? String((d.parsed as { action?: string; slot?: string | null }).action === "PICK" && (d.parsed as { slot?: string | null }).slot === "A2") : "-",
        d.error ? d.error.slice(0, 70) : JSON.stringify(d.parsed).slice(0, 70),
      ]);
      console.log(rows.at(-1)!.join(" | "));
    }
  }
  console.log(`\ninput: ${imagePath ? `image ${imagePath}` : "scene JSON (--text)"}`);
  console.log("model | source | x_0g_trace.request_id | X-Request-ID | echo | tee_verified | ms | correct (PICK A2) | result");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
