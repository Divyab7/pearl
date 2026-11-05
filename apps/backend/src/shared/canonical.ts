/**
 * Canonical JSON: keys sorted recursively, no whitespace, UTF-8 when hashed.
 * Every hash in the episode log (recordHash, headHash) is computed over this form, so the same logical record always
 * produces the same bytes no matter which program wrote it or in which key order.
 *
 * Rules (enforced, not assumed):
 * - Object keys are sorted with the default JS string comparison (UTF-16 code units), recursively.
 * - Object properties whose value is `undefined` are omitted, exactly as JSON.stringify does, so a record that went
 *   through a JSON file round-trips to the same canonical form.
 * - `undefined` inside an array, non-finite numbers, bigint, functions and symbols are rejected: they have no
 *   unambiguous JSON form.
 * - Only plain objects and arrays are accepted as containers (no Date, Map, class instances).
 */
export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || "<root>"}`);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalize(value: unknown): string {
  return encode(value, "");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite number", path);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof value}`, path);
  }

  if (Array.isArray(value)) {
    const parts = value.map((item, i) => {
      if (item === undefined) throw new CanonicalJsonError("undefined in array", `${path}[${i}]`);
      return encode(item, `${path}[${i}]`);
    });
    return `[${parts.join(",")}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError("only plain objects are allowed", path);
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encode(v, path ? `${path}.${key}` : key)}`);
  }
  return `{${parts.join(",")}}`;
}
