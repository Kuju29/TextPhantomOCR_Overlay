/**
 * Minimal protobuf wire-format reader for Google Lens responses: a byte-for-byte
 * port of `api/backend/lens/proto.py`, pinned to a shared fixture
 * (`scripts/test-lens-tree.mjs`, `api/tests/test_lens_tree.py`) so the two
 * readers cannot drift. Lens embeds unschematised protobuf in its JSON, so the
 * wire format (varint 0, 64-bit 1, length-delimited 2, 32-bit 5) is walked
 * directly and "item" messages are recognised by shape (geometry + spans).
 *
 * On failure this throws rather than returning a partial parse: partial fields
 * would put some text in the wrong place and look like a renderer bug.
 */

/** Thrown when the wire format is not what this reader speaks. */
class LensProtoError extends Error {}

/** A decoded field: `{ field, wire, value }`. */

/**
 * Read a base-128 varint starting at `buf[i]`; return `[value, nextI]`.
 *
 * Uses a float accumulator past 2^31 the same way Python's arbitrary-precision
 * ints do for the values Lens actually sends (string offsets and small enums,
 * never anything near 2^53). A varint wider than 70 bits is refused rather
 * than truncated to whatever fits — a silently truncated offset would slice
 * the wrong substring out of the page text.
 */
function readVarint(buf, i) {
  let shift = 0;
  let result = 0;
  for (;;) {
    if (i >= buf.length) throw new LensProtoError("eof varint");
    const b = buf[i];
    i += 1;
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) {
      if (!Number.isSafeInteger(result)) {
        throw new LensProtoError(
          `varint ${result} exceeds the safe integer range`,
        );
      }
      return [result, i];
    }
    shift += 7;
    if (shift > 70) throw new LensProtoError("varint too long");
  }
}

/** Decode every top-level field in `buf[start:end]`. */
function parse(buf, start = 0, end = null) {
  const stop = end === null ? buf.length : end;
  let i = start;
  const out = [];
  while (i < stop) {
    let key;
    [key, i] = readVarint(buf, i);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      let val;
      [val, i] = readVarint(buf, i);
      out.push({ field, wire, value: val });
    } else if (wire === 1) {
      out.push({ field, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      let length;
      [length, i] = readVarint(buf, i);
      out.push({ field, wire, value: buf.subarray(i, i + length) });
      i += length;
    } else if (wire === 5) {
      out.push({ field, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      throw new LensProtoError(`wiretype ${wire}`);
    }
  }
  return out;
}

/**
 * Decode a little-endian 32-bit float.
 *
 * A short slice is refused. `struct.unpack` raises on one, and returning 0.0
 * instead would put a baseline at the top-left corner of the page and look
 * like a layout bug.
 */
export function f32(b4) {
  if (!b4 || b4.length !== 4) {
    throw new LensProtoError(
      `expected 4 bytes for a float32, got ${b4 ? b4.length : "none"}`,
    );
  }
  return new DataView(b4.buffer, b4.byteOffset, 4).getFloat32(0, true);
}

/** The value of the first 32-bit float field numbered `fieldNum`, or null. */
function getFloatField(fields, fieldNum) {
  for (const { field, wire, value } of fields) {
    if (field === fieldNum && wire === 5) return f32(value);
  }
  return null;
}

// Shape heuristics

/**
 * Extract `{ p1, p2, height }` (normalised 0..1) from a geometry sub-message.
 * Lens encodes free-angle text as a baseline polyline of up to 6 points and the
 * renderer draws its chord, so p1/p2 are the polyline's ENDPOINTS (the first two
 * points would make span boxes far too narrow). Nulls when not a geometry block.
 */
export function getPointsFromGeom(geomBytes) {
  const { points, height } = getPolylineFromGeom(geomBytes);
  if (points.length >= 2 && height !== null) {
    return { p1: points[0], p2: points[points.length - 1], height };
  }
  return { p1: null, p2: null, height: null };
}

/**
 * The *full* polyline + height from a geometry sub-message.
 *
 * Used when an exact curve trace is needed. Returns `{ points: [], height:
 * null }` when the message isn't a geometry block — an honest empty, not a
 * substitute: the caller checks the length and skips.
 */
function getPolylineFromGeom(geomBytes) {
  const points = [];
  let height = null;
  for (const { field, wire, value } of parse(geomBytes)) {
    if (field === 1 && wire === 2) {
      const pFields = parse(value);
      const x = getFloatField(pFields, 1);
      const y = getFloatField(pFields, 2);
      if (x !== null && y !== null) points.push([x, y]);
    } else if (field === 3 && wire === 5) {
      height = f32(value);
    }
  }
  return { points, height };
}

/** True if `geomBytes` has >=2 points and a height field. */
function looksLikeGeom(geomBytes) {
  let points = 0;
  let hasHeight = false;
  for (const { field, wire, value } of parse(geomBytes)) {
    if (field === 1 && wire === 2) {
      const pFields = parse(value);
      if (
        getFloatField(pFields, 1) !== null &&
        getFloatField(pFields, 2) !== null
      )
        points += 1;
    } else if (field === 3 && wire === 5) {
      hasHeight = true;
    }
  }
  return points >= 2 && hasHeight;
}

/** True if `spanBytes` has both a t0/t1 float pair and a start/end range. */
function looksLikeSpan(spanBytes) {
  let hasT = false;
  let hasRange = false;
  for (const { field, wire } of parse(spanBytes)) {
    if ((field === 3 || field === 4) && wire === 5) hasT = true;
    else if ((field === 1 || field === 2) && wire === 0) hasRange = true;
  }
  return hasT && hasRange;
}

/** True if `msgBytes` is an OCR "item" (geometry + >=1 span). */
function isItemMessage(msgBytes) {
  let geomOk = false;
  let spanOk = 0;
  for (const { field, wire, value } of parse(msgBytes)) {
    if (field === 1 && wire === 2 && !geomOk) geomOk = looksLikeGeom(value);
    else if (field === 2 && wire === 2 && looksLikeSpan(value)) spanOk += 1;
  }
  return geomOk && spanOk > 0;
}

/** A stable identity for a byte slice, so the deep walk can de-duplicate. */
function bytesKey(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1)
    out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Find every item sub-message inside a paragraph message. The deep walk covers
 * an older Lens nesting (bounded at depth 4 and 20,000 nodes); `deep` in the
 * result says which pass answered, so a nesting change is visible.
 */
export function extractItemsFromParagraph(parBytes) {
  const shallow = [];
  for (const { wire, value } of parse(parBytes)) {
    if (wire === 2 && isItemMessage(value)) shallow.push(value);
  }
  if (shallow.length) return { items: shallow, deep: false, exhausted: false };

  const found = [];
  const seen = new Set();
  let nodes = 0;
  let exhausted = false;

  const walk = (buf, depth) => {
    if (depth >= 4 || nodes > 20000) {
      if (nodes > 20000) exhausted = true;
      return;
    }
    for (const { wire, value } of parse(buf)) {
      if (wire !== 2) continue;
      nodes += 1;
      if (nodes > 20000) {
        exhausted = true;
        return;
      }
      if (isItemMessage(value)) {
        const key = bytesKey(value);
        if (!seen.has(key)) {
          seen.add(key);
          found.push(value);
        }
      } else {
        walk(value, depth + 1);
      }
    }
  };

  walk(parBytes, 0);
  return { items: found, deep: true, exhausted };
}

/** Split an item message into `{ geom, spans }`. `geom` is null when absent. */
export function extractItemGeomSpans(itemBytes) {
  let geom = null;
  const spans = [];
  for (const { field, wire, value } of parse(itemBytes)) {
    if (field === 1 && wire === 2) geom = value;
    else if (field === 2 && wire === 2) spans.push(value);
  }
  return { geom, spans };
}

/**
 * Decode a span message into `{ start, end, t0, t1 }`, nulls where absent.
 *
 * `start`/`end` index into the paragraph's full text; `t0`/`t1` are the span's
 * normalised position along the item baseline (0..1). Absent fields stay null
 * so the caller can tell "Lens did not send this" from "Lens sent zero".
 */
export function extractSpan(spanBytes) {
  let start = null;
  let end = null;
  let t0 = null;
  let t1 = null;
  for (const { field, wire, value } of parse(spanBytes)) {
    if (field === 1 && wire === 0) start = value;
    else if (field === 2 && wire === 0) end = value;
    else if (field === 3 && wire === 5) t0 = f32(value);
    else if (field === 4 && wire === 5) t1 = f32(value);
  }
  return { start, end, t0, t1 };
}

/**
 * Base64 -> bytes, refusing anything that is not base64.
 *
 * `atob` throws on bad input in both a service worker and Node 18+, which is
 * what we want: a paragraph that silently decoded to zero bytes would drop a
 * whole speech bubble off the page with no error anywhere.
 */
export function base64ToBytes(b64) {
  let binary;
  try {
    binary = atob(String(b64));
  } catch (cause) {
    throw new LensProtoError(`paragraph is not base64: ${cause.message}`, {
      cause,
    });
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
