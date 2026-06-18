// VENDORED from BenchAGI_Mono_Repo apps/web/src/lib/forge/benchpack — keep byte-identical to the server verifier (#2144).
//
// Forge Contribution Rail — RFC 8785 (JCS) canonical JSON serializer.
//
// Why our own: the `.benchpack` manifest is signed, so the bytes that get
// hashed & signed MUST be reproducible BIT-for-BIT on both the contributor's
// machine and the Bench verifier — independent of object key insertion order
// or whitespace. JSON.stringify is NOT canonical (it preserves insertion
// order). The repo carries NO canonicalize dependency, and we add none
// (guardrail: no new npm deps), so this is a small, pure, dependency-free
// implementation of the JSON Canonicalization Scheme (RFC 8785).
//
// JCS rules implemented:
//   - Object members are serialized in ASCENDING order of their UTF-16 code
//     units (the spec sorts by the UTF-16 representation; for the manifest's
//     ASCII-ish path/field keys this is the same as a plain code-unit sort,
//     which is exactly what String.prototype.localeCompare-free `<` gives us).
//   - No insignificant whitespace (compact).
//   - Strings use the JSON escaping in RFC 8785 §3.2.2.2 (the minimal escape
//     set; control chars < 0x20 via \uXXXX, lowercase hex). Lone UTF-16
//     surrogates are rejected because JCS operates on valid Unicode strings;
//     letting node encode them would collapse distinct invalid values to the
//     same U+FFFD byte sequence.
//   - Numbers: integers and the safe-integer / finite doubles the manifest
//     uses serialize via the ECMAScript Number-to-String (RFC 8785 §3.2.2.3
//     defers to ES `Number.prototype.toString`), which JSON.stringify already
//     produces for finite numbers. Non-finite numbers are rejected (invalid
//     JSON, fail-closed).
//   - `null`, `true`, `false` as literals.
//
// Scope note: the manifest payload is plain JSON (strings, finite numbers,
// booleans, null, arrays, objects). This serializer fully covers that surface.
// It rejects values JSON cannot represent (functions, undefined as a value,
// BigInt, non-finite numbers, symbols) by throwing — callers in this pure lib
// only ever feed it validated manifest data.

/**
 * Serialize `value` to its RFC 8785 (JCS) canonical UTF-8 string form.
 *
 * Deterministic: equal logical values always produce byte-identical output,
 * regardless of object key insertion order.
 *
 * @throws if `value` contains a non-finite number, a function/undefined/symbol
 *   member value, or a BigInt — none of which are valid canonical JSON.
 */
export function canonicalize(value) {
  return serialize(value);
}

/**
 * The canonical UTF-8 bytes of `value` (what gets hashed & signed). Equivalent
 * to `Buffer.from(canonicalize(value), 'utf8')`.
 */
export function canonicalizeToBytes(value) {
  return Buffer.from(canonicalize(value), "utf8");
}

function serialize(value) {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value;
    if (!Number.isFinite(n)) {
      throw new Error("canonicalize: non-finite numbers are not valid JSON");
    }
    // RFC 8785 §3.2.2.3 defers number formatting to ECMAScript's
    // Number-to-String, which is exactly what JSON.stringify emits for a
    // finite number (e.g. 1, -0 → "0", 1.5, 1e21 → "1e+21"). We normalize
    // -0 to 0 per the JCS reference (it serializes -0 as "0").
    if (Object.is(n, -0)) return "0";
    return JSON.stringify(n);
  }

  if (t === "string") {
    return serializeString(value);
  }

  if (Array.isArray(value)) {
    const parts = value.map((item) => serialize(item));
    return `[${parts.join(",")}]`;
  }

  if (t === "object") {
    const obj = value;
    // RFC 8785: members sorted by their key's UTF-16 code-unit sequence. A
    // plain lexicographic compare over the JS string (`<`) compares UTF-16
    // code units, which is the JCS sort. We do NOT use localeCompare (locale
    // sensitive) or Intl.
    const keys = Object.keys(obj).sort(compareCodeUnits);
    const parts = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) {
        // An explicit `undefined` member value has no JSON representation.
        throw new Error(
          `canonicalize: member "${key}" is undefined (no JSON form)`,
        );
      }
      parts.push(`${serializeString(key)}:${serialize(v)}`);
    }
    return `{${parts.join(",")}}`;
  }

  // function | undefined (as a top-level/array value) | bigint | symbol
  throw new Error(`canonicalize: unsupported value of type "${t}"`);
}

/**
 * Compare two strings by UTF-16 code unit (the JCS member-ordering rule).
 * Plain `<`/`>` on JS strings already compares code units; this wrapper makes
 * the intent explicit and avoids any locale-aware default.
 */
function compareCodeUnits(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Serialize a JSON string per RFC 8785 §3.2.2.2: the minimal escape set
 * (`"`, `\`, and the named short escapes \b \f \n \r \t), and any remaining
 * control character < 0x20 as `\u00xx` with LOWERCASE hex. All other code
 * points (including non-ASCII) are emitted literally as UTF-8 — JCS does NOT
 * \u-escape non-ASCII.
 */
function serializeString(s) {
  assertNoLoneSurrogates(s);

  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x08: // \b
        out += "\\b";
        break;
      case 0x09: // \t
        out += "\\t";
        break;
      case 0x0a: // \n
        out += "\\n";
        break;
      case 0x0c: // \f
        out += "\\f";
        break;
      case 0x0d: // \r
        out += "\\r";
        break;
      case 0x22: // "
        out += '\\"';
        break;
      case 0x5c: // backslash
        out += "\\\\";
        break;
      default:
        if (code < 0x20) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += s[i];
        }
    }
  }
  out += '"';
  return out;
}

function assertNoLoneSurrogates(s) {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("canonicalize: string contains an unpaired high surrogate");
      }
      i++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("canonicalize: string contains an unpaired low surrogate");
    }
  }
}
