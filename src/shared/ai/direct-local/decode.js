import { extractDirectParagraphs } from "../../ai-markers.js";
import { LocalAiError } from "./error.js";

function unwrapKnownResponse(raw) {
  const original = String(raw || "");
  const text = original.trim();
  const fenced = /^```(?:[A-Za-z0-9_-]+)?[ \t]*\n?([\s\S]*?)\n?```$/i.exec(
    text,
  );
  if (fenced) return fenced[1].trim();
  const tagged = /^<AiTextFull>([\s\S]*)<\/AiTextFull>$/i.exec(text);
  return tagged ? tagged[1].trim() : original;
}

// JSON.parse silently keeps the last duplicate object key. Walk the bounded
// response with a real JSON grammar first so duplicates at any nesting depth
// remain observable. Strings/escapes are parsed as strings, never regex-scanned.
export function assertNoDuplicateJsonKeys(raw) {
  const source = String(raw || "");
  let at = 0;
  const ws = () => {
    while (/\s/.test(source[at] || "")) at += 1;
  };
  const stringToken = () => {
    if (source[at] !== '"') throw new SyntaxError("expected JSON string");
    const start = at++;
    while (at < source.length) {
      const ch = source[at++];
      if (ch === '"') return JSON.parse(source.slice(start, at));
      if (ch === "\\") {
        if (at >= source.length)
          throw new SyntaxError("incomplete JSON escape");
        if (source[at] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(at + 1, at + 5)))
            throw new SyntaxError("invalid Unicode escape");
          at += 5;
        } else {
          if (!/["\\/bfnrt]/.test(source[at]))
            throw new SyntaxError("invalid JSON escape");
          at += 1;
        }
      } else if (ch.charCodeAt(0) < 0x20)
        throw new SyntaxError("control character in JSON string");
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const value = (depth = 0) => {
    if (depth > 128) throw new SyntaxError("JSON nesting is too deep");
    ws();
    const ch = source[at];
    if (ch === '"') {
      stringToken();
      return;
    }
    if (ch === "{") {
      at += 1;
      ws();
      const keys = new Set();
      if (source[at] === "}") {
        at += 1;
        return;
      }
      while (true) {
        ws();
        const key = stringToken();
        ws();
        if (keys.has(key))
          throw new LocalAiError(
            `Local AI JSON contains duplicate key: ${key}`,
            { code: "invalid_model_output" },
          );
        keys.add(key);
        if (source[at++] !== ":") throw new SyntaxError("expected colon");
        value(depth + 1);
        ws();
        if (source[at] === "}") {
          at += 1;
          return;
        }
        if (source[at++] !== ",") throw new SyntaxError("expected comma");
      }
    }
    if (ch === "[") {
      at += 1;
      ws();
      if (source[at] === "]") {
        at += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        ws();
        if (source[at] === "]") {
          at += 1;
          return;
        }
        if (source[at++] !== ",") throw new SyntaxError("expected comma");
      }
    }
    const tail = source.slice(at);
    const literal = /^(?:true|false|null)(?=\s|[,}\]]|$)/.exec(tail);
    if (literal) {
      at += literal[0].length;
      return;
    }
    const number =
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=\s|[,}\]]|$)/.exec(tail);
    if (number) {
      at += number[0].length;
      return;
    }
    throw new SyntaxError("invalid JSON value");
  };
  value();
  ws();
  if (at !== source.length) throw new SyntaxError("trailing JSON content");
}

export const MARKER_CONTRACT_VERSION = "tp.translation.compact-records/1";
export const SELECTED_MARKER_CONTRACT = "plain_records_v1";
export const SCHEMA_OBJECT_CONTRACT_VERSION = "tp.translation.schema-object/1";
const CONTRACT_MISMATCH = "AI_OUTPUT_CONTRACT_MISMATCH";
function markerError(
  message,
  diagnostics,
  partialTranslations,
  code = "invalid_model_output",
) {
  const error = new LocalAiError(message, { code, diagnostics });
  error.partialTranslations = partialTranslations;
  return error;
}

export function decodeSchemaObject(raw, units, wireUnits) {
  const source = String(raw || "").trim();
  const expected = (wireUnits || []).map((unit) => String(unit?.id || ""));
  const fail = (subtype, details = {}) => {
    throw new LocalAiError("Local AI output does not match the selected JSON schema contract", {
      code: "AI_OUTPUT_CONTRACT_MISMATCH",
      diagnostics: {
        expectedContract: SCHEMA_OBJECT_CONTRACT_VERSION,
        validatorSubtype: subtype,
        missingIds: expected,
        ...details,
      },
    });
  };
  if (!source) fail("empty_output");
  let object;
  try {
    assertNoDuplicateJsonKeys(source);
    object = JSON.parse(source);
  } catch (error) {
    if (error instanceof LocalAiError) throw error;
    fail("invalid_json");
  }
  if (!object || typeof object !== "object" || Array.isArray(object))
    fail("root_not_object");
  const received = Object.keys(object);
  const missingIds = expected.filter((id) => !received.includes(id));
  const extraIds = received.filter((id) => !expected.includes(id));
  const emptyIds = expected.filter((id) => typeof object[id] !== "string" || !object[id].trim());
  if (missingIds.length || extraIds.length || emptyIds.length)
    fail(missingIds.length ? "missing_ids" : extraIds.length ? "extra_ids" : "empty_ids", {
      missingIds, extraIds, emptyIds, receivedIds: received,
    });
  return {
    translations: expected.map((id, index) => ({ id: units[index].id, text: object[id].trim() })),
    responseShape: "schema-object-v1",
    diagnostics: {
      contractVersion: SCHEMA_OBJECT_CONTRACT_VERSION,
      validatorSubtype: "complete",
      receivedIds: received,
      missingIds: [], emptyIds: [], duplicateIds: [], extraIds: [],
    },
  };
}

function observedShape(raw) {
  const text = String(raw || "").trim();
  if (!text) return "empty";
  if (text.startsWith("```")) return "markdown_fence";
  if (text.startsWith("{") || text.startsWith("[")) return "json";
  if (text.includes("<<TP_DONE>>")) return "tp_done_marker";
  if (/<<TP_(?:P\d+|END)>>/u.test(text)) return "legacy_open_end_markers";
  if (/<<TP_P\d+:/u.test(text)) return "compact_records_malformed";
  if (text.startsWith("<")) return "xml_or_tagged";
  return "unmarked_text";
}

// Synchronous and deterministic because decoding is synchronous. This is a
// diagnostic fingerprint only; it never identifies or logs response content.
function observedHash(raw) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(String(raw || ""))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function grammarDiagnostics(raw, expectedIds = []) {
  const source = String(raw || "");
  const claims = [...source.matchAll(/<<TP_(P\d+)(?::|>>)/gu)];
  const receivedIds = claims.map((match) => match[1]);
  const expected = new Set(expectedIds);
  const first = claims[0];
  const lastClose = source.lastIndexOf(">>");
  return {
    responseGrammar: MARKER_CONTRACT_VERSION,
    markerCount: claims.length,
    receivedIds,
    missingIds: expectedIds.filter((id) => !receivedIds.includes(id)),
    extraIds: [...new Set(receivedIds.filter((id) => !expected.has(id)))],
    prefixProse: first ? Boolean(source.slice(0, first.index).trim()) : Boolean(source.trim()),
    suffixProse: lastClose >= 0 ? Boolean(source.slice(lastClose + 2).trim()) : false,
    firstMarkerOffset: first?.index ?? -1,
    firstMarkerTokenHash: first ? observedHash(first[0]) : null,
    contentHash: observedHash(source),
  };
}

function strictMismatch(raw, validatorSubtype, details = {}, expectedIds = []) {
  throw markerError(
    "AI output does not match the selected translation contract",
    {
      expectedContract: MARKER_CONTRACT_VERSION,
      observedShape: observedShape(raw),
      observedHash: observedHash(raw),
      ...grammarDiagnostics(raw, expectedIds),
      validatorSubtype,
      ...details,
    },
    [],
    CONTRACT_MISMATCH,
  );
}

function decodeStrictRecords(raw, units, wireUnits) {
  const source = String(raw || "");
  const expected = wireUnits.map((unit) => unit.id);
  if (!source) strictMismatch(source, "empty_output", { missingIds: expected }, expected);
  // Parse balanced marker islands with a stack. A nested marker is a sibling
  // record semantically: its complete subtree is excluded from its parent's
  // value. Records are committed only when their outermost island closes, so
  // a closed child inside an unclosed parent is never salvaged ambiguously.
  const parsed = [];
  const malformedClaims = [];
  const allClaims = [];
  const stack = [];
  let pending = [];
  let islandInvalid = false;
  let islandInvalidIds = new Set();
  const poisonIsland = () => {
    islandInvalid = true;
    for (const frame of stack) islandInvalidIds.add(frame.id);
    for (const [id] of pending) islandInvalidIds.add(id);
  };
  let at = 0;
  while (at < source.length) {
    if (source.startsWith("<<>>", at) && stack.length) {
      const bridge = /^<<>>TP_(P\d+)(?::|\s)/u.exec(source.slice(at));
      if (bridge) {
        const frame = stack.pop();
        pending.push([frame.id, frame.value]);
        allClaims.push(bridge[1]);
        stack.push({ id: bridge[1], value: "" });
        at += bridge[0].length;
        continue;
      }
      poisonIsland();
      at += 4;
      continue;
    }
    if (source.startsWith("<<TP_P", at)) {
      const numeric = /^<<TP_(P\d+)/u.exec(source.slice(at));
      if (numeric) allClaims.push(numeric[1]);
      const header = /^<<TP_(P\d+)(?::|\s)/u.exec(source.slice(at));
      if (header) {
        if (!stack.length) {
          pending = [];
          islandInvalid = false;
          islandInvalidIds = new Set();
        }
        stack.push({ id: header[1], value: "" });
        at += header[0].length;
        continue;
      }
      if (numeric) malformedClaims.push(numeric[1]);
      if (stack.length) poisonIsland();
      const malformedClose = source.indexOf(">>", at + 6);
      at = malformedClose < 0 ? source.length : malformedClose + 2;
      continue;
    }
    if (source.startsWith("<<", at) && stack.length) {
      poisonIsland();
      const invalidClose = source.indexOf(">>", at + 2);
      if (invalidClose < 0) {
        at = source.length;
        continue;
      }
      const barePeer = /^TP_(P\d+)(?::|\s)/u.exec(source.slice(invalidClose + 2));
      if (barePeer) {
        allClaims.push(barePeer[1]);
        malformedClaims.push(barePeer[1]);
        islandInvalidIds.add(barePeer[1]);
      }
      at = invalidClose + 2;
      continue;
    }
    if (source.startsWith(">>", at) && stack.length) {
      const frame = stack.pop();
      pending.push([frame.id, frame.value]);
      at += 2;
      if (!stack.length) {
        if (islandInvalid) malformedClaims.push(...islandInvalidIds, ...pending.map(([id]) => id));
        else parsed.push(...pending);
        pending = [];
        islandInvalid = false;
        islandInvalidIds = new Set();
      }
      continue;
    }
    if (stack.length) stack.at(-1).value += source[at];
    at += 1;
  }
  // Any open outer island invalidates every record in that island, including
  // children that happened to close before EOF.
  if (stack.length) malformedClaims.push(...stack.map((frame) => frame.id), ...pending.map(([id]) => id), ...islandInvalidIds);
  const receivedIds = parsed.map(([id]) => id);
  const duplicateIds = [...new Set(allClaims.filter((id, index) => allClaims.indexOf(id) !== index))];
  const extraIds = [...new Set(allClaims.filter((id) => !expected.includes(id)))];
  const invalidIds = new Set([...duplicateIds, ...malformedClaims]);
  const missingIds = expected.filter((id) => !receivedIds.includes(id) || invalidIds.has(id));
  const emptyIds = parsed.filter(([, value]) => !value.trim()).map(([id]) => id);
  const byId = new Map(parsed.filter(([id]) =>
    expected.includes(id) && !invalidIds.has(id)));
  const ignoredProseChars = source.length - parsed.reduce((total, [id, value]) =>
    total + `<<TP_${id}:${value}>>`.length, 0);
  return {
    translations: wireUnits.map((wire, index) => ({ id: units[index].id, text: byId.get(wire.id) || "" })),
    missing: [...new Set([...missingIds, ...emptyIds])].map((wireId) => {
      const index = wireUnits.findIndex((wire) => wire.id === wireId);
      return index >= 0 ? units[index].id : wireId;
    }),
    responseShape: "plain-records-v1",
    acceptedLosslessly: true,
    contentModified: false,
    diagnostics: {
      contractVersion: MARKER_CONTRACT_VERSION,
      responseGrammar: MARKER_CONTRACT_VERSION,
      markerCount: parsed.length,
      validatorSubtype: missingIds.length || emptyIds.length ? "repairable_ids" : "complete_closed_records",
      receivedIds, missingIds, emptyIds, duplicateIds, extraIds,
      malformedMarkerIds: malformedClaims,
      ignoredUnknownIds: extraIds,
      ignoredProse: ignoredProseChars > 0,
      ignoredProseChars: Math.max(0, ignoredProseChars),
    },
  };
}

function decodeIdMarkers(
  raw,
  units,
  wireUnits,
  { allowCompleteWithoutEnd = false } = {},
) {
  // TP_DONE was emitted by some intermediate/custom clients. It is a
  // decode-only alias: normalize it before tokenization so it has exactly the
  // same stripping, trailing-text and duplicate checks as TP_END.
  const source = String(raw || "").replace(/<<TP_DONE>>/g, "<<TP_END>>");
  const tokens = [
    ...source.matchAll(/(?:^|\n)[ \t]*<<TP_(P\d+|END)>>[ \t]*(?=\r?\n|$)/g),
  ].map((match) => ({
    id: match[1],
    index: match.index,
    end: match.index + match[0].length,
  }));
  const unitTokens = tokens.filter((token) => token.id !== "END");
  if (!unitTokens.length) return null;
  const expected = new Map(
    wireUnits.map((unit, index) => [unit.id, units[index]]),
  );
  const received = new Map();
  const duplicateIds = [];
  const extraIds = [];
  const endTokens = tokens.filter((token) => token.id === "END");
  const terminal = endTokens[0];
  const endMarkerPresent =
    endTokens.length === 1 &&
    tokens.at(-1)?.id === "END" &&
    !source.slice(terminal?.end || 0).trim();
  const badEnvelope =
    tokens[0]?.id === "END" ||
    Boolean(source.slice(0, tokens[0]?.index || 0).trim()) ||
    endTokens.length > 1 ||
    (endTokens.length === 1 && !endMarkerPresent);
  for (let index = 0; index < unitTokens.length; index += 1) {
    const id = unitTokens[index].id;
    const start = unitTokens[index].end;
    const next = tokens[tokens.indexOf(unitTokens[index]) + 1];
    const end = next?.index ?? source.length;
    const value = source.slice(start, end).trim();
    if (!expected.has(id)) extraIds.push(id);
    else if (received.has(id)) duplicateIds.push(id);
    else received.set(id, value);
  }
  const missingIds = [...expected.keys()].filter((id) => !received.has(id));
  const emptyIds = [...received]
    .filter(([, value]) => !value)
    .map(([id]) => id);
  const diagnostics = {
    contractVersion: MARKER_CONTRACT_VERSION,
    endMarkerPresent,
    missingIds,
    emptyIds,
    duplicateIds: [...new Set(duplicateIds)],
    extraIds: [...new Set(extraIds)],
    validatorSubtype: badEnvelope
      ? "invalid_envelope"
      : duplicateIds.length
        ? "duplicate_ids"
        : extraIds.length
          ? "extra_ids"
          : missingIds.length
            ? "missing_ids"
            : emptyIds.length
              ? "empty_ids"
              : !endMarkerPresent
                ? allowCompleteWithoutEnd
                  ? "accepted_without_end_marker"
                  : "missing_end_marker"
                : "complete",
  };
  const partialTranslations = wireUnits.flatMap((wire, index) =>
    received.has(wire.id)
      ? [{ id: units[index].id, text: received.get(wire.id) }]
      : [],
  );
  if (
    badEnvelope ||
    duplicateIds.length ||
    extraIds.length ||
    emptyIds.length ||
    missingIds.length
  ) {
    throw markerError(
      "Local AI returned incomplete or invalid translation markers",
      diagnostics,
      partialTranslations,
    );
  }
  if (!endMarkerPresent && !allowCompleteWithoutEnd) {
    throw markerError(
      "Local AI response did not include the required end marker",
      diagnostics,
      partialTranslations,
    );
  }
  return {
    translations: wireUnits.map((wire, index) => ({
      id: units[index].id,
      text: received.get(wire.id) || "",
    })),
    responseShape: endMarkerPresent ? "id-markers-v1" : "id-markers-v1-no-end",
    diagnostics,
  };
}

function decodeOneLineMarkers(raw, units, wireUnits) {
  const source = String(raw || "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.length) return null;
  const parsed = lines.map((line) =>
    /^\s*<<TP_(P\d+)>>[ \t]+(.+?)\s*$/.exec(line),
  );
  if (parsed.some((match) => !match)) return null;
  const expected = wireUnits.map((unit) => unit.id);
  const received = parsed.map((match) => match[1]);
  const duplicateIds = [
    ...new Set(received.filter((id, index) => received.indexOf(id) !== index)),
  ];
  const extraIds = [
    ...new Set(received.filter((id) => !expected.includes(id))),
  ];
  const missingIds = expected.filter((id) => !received.includes(id));
  const emptyIds = parsed
    .filter((match) => !String(match?.[2] || "").trim())
    .map((match) => match[1]);
  const outOfOrder = received.join("\0") !== expected.join("\0");
  const diagnostics = {
    contractVersion: MARKER_CONTRACT_VERSION,
    missingIds,
    emptyIds,
    duplicateIds,
    extraIds,
    endMarkerPresent: false,
    validatorSubtype: duplicateIds.length
      ? "duplicate_ids"
      : extraIds.length
        ? "extra_ids"
        : missingIds.length
          ? "missing_ids"
          : emptyIds.length
            ? "empty_ids"
            : outOfOrder
              ? "out_of_order_ids"
              : "complete_lines",
  };
  if (
    duplicateIds.length ||
    extraIds.length ||
    missingIds.length ||
    emptyIds.length ||
    outOfOrder
  ) {
    throw markerError(
      "Local AI returned invalid one-line translation markers",
      diagnostics,
      [],
    );
  }
  const byId = new Map(parsed.map((match) => [match[1], match[2].trim()]));
  return {
    translations: wireUnits.map((wire, index) => ({
      id: units[index].id,
      text: byId.get(wire.id),
    })),
    responseShape: "id-lines-v1",
    diagnostics,
  };
}

function decodeClosedRecords(raw, units, wireUnits) {
  const source = String(raw || "").replace(/\r\n?/g, "\n");
  if (!source || !/<<TP_P\d+:/u.test(source)) return null;
  // ECMAScript's dot accepts NEL (U+0085), unlike U+2028/U+2029. Treat all
  // Unicode line separators identically so one record cannot hide two
  // physical lines from either the JS or Python validator.
  if (/[\u0085\u2028\u2029]/u.test(source)) {
    throw markerError(
      "Local AI returned a Unicode line separator inside a translation record",
      {
        contractVersion: MARKER_CONTRACT_VERSION,
        validatorSubtype: "unicode_line_separator",
      },
      [],
    );
  }
  const lines = source.split("\n");
  const parsed = lines.map((line) =>
    /^[ \t]*<<TP_(P\d+):(.*)>>[ \t]*$/u.exec(line),
  );
  const valid = parsed.filter(Boolean);
  const receivedSoFar = valid.map((match) => match[1]);
  // A malformed line is not allowed to poison independently valid records.
  // Keep the latter as a partial result so the bounded repair pass requests
  // only the defective IDs. Marker ambiguity remains a hard error: an ID
  // mentioned twice (even once in malformed syntax) cannot be trusted.
  // Match Python's numeric-ID boundary exactly. `P1 ` is attributable, while
  // `P1abc` and `P1_x` are ambiguous marker-looking tokens (underscore is a
  // word character, so neither form has a boundary after the numeric ID).
  const markerClaimsByLine = lines.map((line) =>
    [...line.matchAll(/<<TP_(P\d+)\b/gu)].map((match) => match[1]),
  );
  const markerClaims = markerClaimsByLine.flat();
  const claimCounts = new Map();
  for (const id of markerClaims)
    claimCounts.set(id, (claimCounts.get(id) || 0) + 1);
  const ambiguousIds = [...claimCounts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  const expected = wireUnits.map((unit) => unit.id);
  const claimedExtraIds = [
    ...new Set(markerClaims.filter((id) => !expected.includes(id))),
  ];
  if (
    valid.some((match) => /<<TP_P\d+:/u.test(match[2])) ||
    lines.some((line) => (line.match(/<<TP_P\d+:/gu) || []).length > 1)
  ) {
    throw markerError(
      "Local AI returned nested or concatenated translation records",
      {
        contractVersion: MARKER_CONTRACT_VERSION,
        validatorSubtype: "nested_record",
        receivedIds: receivedSoFar,
      },
      [],
    );
  }
  if (
    lines.some(
      (line, index) =>
        !parsed[index] &&
        line.includes("<<TP_P") &&
        markerClaimsByLine[index].length === 0,
    )
  ) {
    throw markerError(
      "Local AI returned an ambiguous translation record ID",
      {
        contractVersion: MARKER_CONTRACT_VERSION,
        validatorSubtype: "ambiguous_id",
        receivedIds: receivedSoFar,
        malformedLineCount: parsed.filter((match) => !match).length,
      },
      [],
    );
  }
  if (ambiguousIds.length || claimedExtraIds.length) {
    throw markerError(
      "Local AI returned ambiguous or unexpected translation records",
      {
        contractVersion: MARKER_CONTRACT_VERSION,
        validatorSubtype: ambiguousIds.length ? "ambiguous_ids" : "extra_ids",
        receivedIds: receivedSoFar,
        duplicateIds: ambiguousIds,
        extraIds: claimedExtraIds,
        malformedLineCount: parsed.filter((match) => !match).length,
      },
      [],
    );
  }
  const received = valid.map((match) => match[1]);
  const duplicateIds = [
    ...new Set(received.filter((id, index) => received.indexOf(id) !== index)),
  ];
  const extraIds = [
    ...new Set(received.filter((id) => !expected.includes(id))),
  ];
  const omittedIds = expected.filter((id) => !received.includes(id));
  const emptyIds = valid
    .filter((match) => !match[2].trim())
    .map((match) => match[1]);
  const malformedMarkerIds = [
    ...new Set(
      markerClaimsByLine
        .flatMap((ids, index) => (parsed[index] ? [] : ids))
        .filter((id) => expected.includes(id)),
    ),
  ];
  const missingIds = [
    ...new Set([...omittedIds, ...emptyIds, ...malformedMarkerIds]),
  ];
  const byId = new Map(valid.map((match) => [match[1], match[2].trim()]));
  const partialTranslations = wireUnits.flatMap((wire, index) =>
    byId.get(wire.id) ? [{ id: units[index].id, text: byId.get(wire.id) }] : [],
  );
  const diagnostics = {
    contractVersion: MARKER_CONTRACT_VERSION,
    missingIds,
    emptyIds,
    duplicateIds,
    extraIds,
    endMarkerPresent: false,
    receivedIds: receivedSoFar,
    malformedLineCount: parsed.filter((match) => !match).length,
    malformedMarkerIds,
    validatorSubtype: duplicateIds.length
      ? "duplicate_ids"
      : extraIds.length
        ? "extra_ids"
        : parsed.some((match) => !match)
          ? "partial_malformed_records"
          : missingIds.length
            ? "missing_ids"
            : "complete_closed_records",
  };
  if (duplicateIds.length || extraIds.length) {
    throw markerError(
      "Local AI returned duplicate or unexpected translation records",
      diagnostics,
      partialTranslations,
    );
  }
  // Prose/malformed lines with no identifiable missing ID must never turn a
  // complete-looking envelope into success. There is no safe subset to ask
  // repair for, so retain the strict contract error with valid partials.
  if (parsed.some((match) => !match) && !missingIds.length) {
    throw markerError(
      "Local AI returned prose or a malformed translation record",
      diagnostics,
      partialTranslations,
    );
  }
  return {
    translations: wireUnits.map((wire, index) => ({
      id: units[index].id,
      text: byId.get(wire.id) || "",
    })),
    responseShape: "plain-records-v1",
    diagnostics,
  };
}

export function decodeLegacyTranslations(
  text,
  units,
  {
    structured = false,
    wireUnits = null,
    compactMarkers = false,
    allowCompleteMarkersWithoutEnd = false,
  } = {},
) {
  // Custom/local servers may honour either TextPhantom's historical marker
  // contract or the newer JSON shape. Accept both losslessly; never guess.
  const unwrapped = unwrapKnownResponse(text);
  try {
    assertNoDuplicateJsonKeys(unwrapped);
    const obj = JSON.parse(unwrapped);
    if (Array.isArray(obj?.translations)) {
      if (Array.isArray(wireUnits)) {
        const expected = new Map(wireUnits.map((unit) => [unit.id, unit]));
        const receivedIds = obj.translations
          .map((item) => String(item?.id || ""))
          .filter(Boolean);
        const counts = new Map();
        for (const id of receivedIds) counts.set(id, (counts.get(id) || 0) + 1);
        const duplicateIds = [...counts]
          .filter(([, count]) => count > 1)
          .map(([id]) => id);
        const extraIds = [
          ...new Set(receivedIds.filter((id) => !expected.has(id))),
        ];
        const missingIds = [...expected.keys()].filter((id) => !counts.has(id));
        const emptyIds = [
          ...new Set(
            obj.translations
              .filter(
                (item) =>
                  expected.has(String(item?.id || "")) &&
                  typeof item?.text === "string" &&
                  !item.text.trim(),
              )
              .map((item) => String(item.id)),
          ),
        ];
        const diagnostics = {
          contractVersion: "tp.translation.units/1",
          missingIds,
          emptyIds,
          duplicateIds,
          extraIds,
          validatorSubtype: duplicateIds.length
            ? "duplicate_ids"
            : extraIds.length
              ? "extra_ids"
              : missingIds.length
                ? "missing_ids"
                : emptyIds.length
                  ? "empty_ids"
                  : "schema_mismatch",
        };
        if (
          obj.translations.length !== expected.size ||
          typeof obj.memo !== "string" ||
          Object.keys(obj).some(
            (key) => !["memo", "translations"].includes(key),
          )
        ) {
          throw new LocalAiError(
            "Local AI JSON does not match the translation schema",
            { code: "invalid_model_output", diagnostics },
          );
        }
        const received = new Map();
        for (const item of obj.translations) {
          if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            Object.keys(item).sort().join(",") !== "id,text" ||
            typeof item.id !== "string" ||
            typeof item.text !== "string" ||
            received.has(item.id) ||
            !expected.has(item.id)
          ) {
            throw new LocalAiError(
              "Local AI returned duplicate, missing, extra or invalid translation entries",
              { code: "invalid_model_output", diagnostics },
            );
          }
          received.set(item.id, item.text.trim());
        }
        if (received.size !== expected.size) {
          throw new LocalAiError("Local AI omitted translation entries", {
            code: "invalid_model_output",
            diagnostics,
          });
        }
        return {
          translations: wireUnits.map((wire, index) => ({
            id: units[index].id,
            text: received.get(wire.id) || "",
          })),
          responseShape: "json-units-v1",
          memo: obj.memo,
        };
      }
      const topKeys = Object.keys(obj).sort();
      if (
        topKeys.some((key) => !["memo", "translations"].includes(key)) ||
        typeof obj.memo !== "string" ||
        obj.translations.length !== units.length
      ) {
        throw new LocalAiError(
          "Local AI returned JSON that does not match the translation schema",
          {
            code: "invalid_model_output",
          },
        );
      }
      const translations = obj.translations.map((item, index) => {
        if (
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          Object.keys(item).some((key) => !["id", "text"].includes(key)) ||
          item.id !== `P${index}` ||
          typeof item.text !== "string"
        ) {
          throw new LocalAiError(
            "Local AI returned duplicate, missing, reordered or invalid translation entries",
            {
              code: "invalid_model_output",
            },
          );
        }
        return { id: units[index].id, text: item.text.trim() };
      });
      return { translations, responseShape: "json", memo: obj.memo };
    }
  } catch (error) {
    if (error instanceof LocalAiError) throw error;
  }
  if (compactMarkers && Array.isArray(wireUnits)) {
    const closed = decodeClosedRecords(unwrapped, units, wireUnits);
    if (closed) return closed;
    const oneLine = decodeOneLineMarkers(unwrapped, units, wireUnits);
    if (oneLine) return oneLine;
    const marked = decodeIdMarkers(unwrapped, units, wireUnits, {
      allowCompleteWithoutEnd: allowCompleteMarkersWithoutEnd,
    });
    if (marked) return marked;
    throw new LocalAiError(
      "Local AI returned text without the required unit ID markers",
      {
        code: "invalid_model_output",
        diagnostics: {
          contractVersion: MARKER_CONTRACT_VERSION,
          validatorSubtype: "missing_markers",
        },
      },
    );
  }
  if (structured) {
    throw new LocalAiError(
      "Local AI returned text instead of the required translation JSON",
      {
        code: "invalid_model_output",
        diagnostics: { validatorSubtype: "non_json_output" },
      },
    );
  }
  const direct = extractDirectParagraphs(unwrapped, units.length);
  if (!direct.parsed) {
    throw new LocalAiError(
      "Local AI returned text without the required paragraph markers",
      {
        code: "invalid_model_output",
      },
    );
  }
  return {
    translations: units.map((unit, index) => ({
      id: unit.id,
      text: direct.parsed.paragraphs[index] || "",
    })),
    responseShape: "markers",
  };
}

export function decodeTranslations(text, units, options = {}) {
  const { compactMarkers = false, wireUnits = null, structured = false } = options;
  if (structured && Array.isArray(wireUnits))
    return decodeSchemaObject(text, units, wireUnits);
  if (compactMarkers && Array.isArray(wireUnits))
    return decodeStrictRecords(text, units, wireUnits);
  return decodeLegacyTranslations(text, units, options);
}
