// The exact code the robot and the tests use, shared with the browser (no Node APIs inside): locking, key handover
// and the checks that need an unlocked log. Imported from the backend package so there is one implementation.
export * from "../../../backend/src/shared/seal.js";
export { contentChecks, framesOf, tamperedCopy } from "../../../backend/src/verify/content.js";
export { sha256HexPure } from "../../../backend/src/shared/sha256.js";
