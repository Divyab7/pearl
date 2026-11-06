/**
 * Shared types for the episode log. Shapes follow docs/pearl-agent-prompt.md §8.4–8.5, extended with the
 * 0G Router fields confirmed in docs/TRACK-DOCS.md §2.B (provider identity, reasoning trace, ZG-Res-Key).
 */
import type { z } from "zod";
import type {
  CheckpointSchema,
  DeviceMsgSchema,
  HostCmdSchema,
  JointsSchema,
} from "./schemas.js";

export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type Joints = z.infer<typeof JointsSchema>;
export type HostCmd = z.infer<typeof HostCmdSchema>;
export type DeviceMsg = z.infer<typeof DeviceMsgSchema>;

export type DecisionSource = "0g" | "failsafe";

export interface TelemetrySnapshot {
  state: string;
  joints: number[];
  tofMm: number;
  accG: number;
}

/** One checkpoint decision. A failsafe record has model, requestId, raw and parsed all null and an error string. */
export interface DecisionRecord {
  v: 2;
  kind: "decision";
  episodeId: string;
  idx: number;
  checkpoint: Checkpoint;
  ts: string; // ISO 8601
  source: DecisionSource;
  model: string | null;
  requestId: string | null; // x_0g_trace.request_id (canonical id)
  httpRequestId: string | null; // X-Request-ID response header
  clientRequestId: string; // what we sent as X-Client-Request-Id
  clientRequestIdEchoed: boolean | null;
  provider: string | null;
  providerIdentity: string | null;
  teeVerified: boolean | null;
  cost: string | null; // billing.total_cost in neuron, when present
  zgResKey: string | null; // ZG-Res-Key header, for independent TEE verification
  reasoning: string | null; // reasoning_content, truncated
  promptHash: string;
  frameHash: string | null;
  frameRoot: string | null;
  telemetry: TelemetrySnapshot;
  raw: string | null;
  parsed: unknown | null;
  error: string | null;
  policy: string;
  override: string | null;
  commandsSent: string[];
  latencyMs: number;
  /**
   * Present only when more than one 0G model was asked (the primary failed on the provider side and a fallback was
   * tried): every call in order, the last one being the answer (or the last failure). Absent on single-call records,
   * so those keep exactly the shape and hash they had before fallbacks existed.
   */
  attempts?: ModelAttempt[];
}

/** One call to one 0G model inside a decision. */
export interface ModelAttempt {
  model: string; // the model we asked for
  status: number | null; // HTTP status, null = no response
  requestId: string | null;
  error: string | null; // null = this call returned an answer (which the decision then checked)
  latencyMs: number;
}

/** A device or host event recorded in the log (hand_in_zone, trip_bump, nack, parse_error, reset_done, ...). */
export interface EventRecord {
  v: 2;
  kind: "event";
  episodeId: string;
  idx: number;
  ts: string;
  ev: string;
  data: Record<string, unknown>;
}

export type LogRecordBody = DecisionRecord | EventRecord;

/** A record once it is in the chain. recordHash = sha256(canonical(record without recordHash)). */
export type ChainedRecord = LogRecordBody & { prevHash: string; recordHash: string };

export type EpisodeOutcome = "DONE" | "ABORTED" | "FAILSAFE" | "TRIPPED";

export interface TaskSpec {
  task: "pick";
  color: string;
  from: "A1" | "A2" | "A3";
  to: "BIN";
}

export interface EpisodeLog {
  v: 2;
  episodeId: string;
  deviceId: string;
  armId: string;
  task: TaskSpec;
  outcome: EpisodeOutcome;
  startedAt: string;
  endedAt: string;
  records: ChainedRecord[];
  headHash: string;
  /** The device's signature over headMessage(episodeId, headHash) (rev 5). Not part of the hash chain. */
  device?: { address: string; signature: string };
}

/** Device events that interrupt an episode. */
export const SAFETY_EVENTS = ["hand_in_zone", "trip_bump", "trip_watchdog", "sensor_fault"] as const;
export type SafetyEventName = (typeof SAFETY_EVENTS)[number];
/** The subset that latches TRIPPED until an operator reset (a hand in the zone only freezes). */
export const HARD_TRIP_EVENTS = ["trip_bump", "trip_watchdog", "sensor_fault"] as const;
export const isSafetyEventName = (ev: string): ev is SafetyEventName => (SAFETY_EVENTS as readonly string[]).includes(ev);
export const isHardTrip = (ev: string): boolean => (HARD_TRIP_EVENTS as readonly string[]).includes(ev);
