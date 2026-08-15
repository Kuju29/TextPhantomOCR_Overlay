/**
 *
 * Paragraph-marker protocol, client side.
 *
 * One model call carries many paragraphs; the markers are what make the answer
 * separable again:
 *
 *     <<TP_P0>>
 *     paragraph zero
 *     <<TP_P1>>
 *     paragraph one
 *
 * A direct port of `api/backend/ai/markers.py`, pinned to the same fixture
 * (`scripts/test-ai-markers.mjs`, `api/tests/test_markers_parity.py`). Both
 * sides must agree exactly: when the extension calls a provider itself and the
 * server calls the same provider for another page of the same chapter, a
 * difference in how the answer is split shows up as one page silently
 * mis-aligned against its bubbles.
 */

export const MARKER_PREFIX = "<<TP_P";
export const MARKER_SUFFIX = ">>";

const MARKER_RE = /<<TP_P(\d+)>>/g;
export const MEMO_MARKER = "<<TP_MEMO>>";

// Thai prose normally does not separate words with ASCII whitespace. Keep the
// provider's text intact in LensDocument and collapse those gaps only at the
// layout boundary, matching the legacy server renderer. This matters because
// stored AI text is semantic data; changing it while parsing a provider answer
// makes later exports/debugging disagree with the answer that was received.
const THAI_WORD_GAP_RE = /([\u0E01-\u0E2E\u0E30-\u0E3A\u0E40-\u0E45\u0E47-\u0E4E])\s+(?=[\u0E01-\u0E2E\u0E30-\u0E3A\u0E40-\u0E45\u0E47-\u0E4E])/gu;

/** Layout-only equivalent of the legacy API's collapse_intra_script_spaces. */
export function collapseThaiWordGaps(text) {
  return String(text ?? "").replace(THAI_WORD_GAP_RE, "$1");
}

/** One bubble is one layout unit; the renderer, not the model, wraps its line. */
export function normalizeAiUnitText(text) {
  return String(text ?? "")
    .replace(/\\r\\n|\\n|\\r/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Encode paragraphs as `<<TP_Pn>>\n<text>` blocks. */
export function applyMarkers(paragraphs) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return "";
  return paragraphs
    .map((text, i) => `${MARKER_PREFIX}${i}${MARKER_SUFFIX}\n${String(text ?? "").trim()}`)
    .join("\n\n");
}


/**
 * Split a marked answer back into paragraphs.
 *
 * Returns `{ paragraphs, cleanText }` with `paragraphs.length === expected`
 * (missing slots are empty strings), or `null` when there are no markers at
 * all.
 *
 * `null` and "all slots empty" mean different things and must not be conflated:
 * the first says the protocol broke and the answer is unusable, the second says
 * the model had nothing to say. A caller that treats them the same reports a
 * broken integration as an empty page.
 */
export function extractParagraphs(text, expected) {
  const source = String(text || "");
  if (!source || !(expected > 0) || !source.includes(MARKER_PREFIX)) return null;

  const matches = [...source.matchAll(MARKER_RE)];
  if (!matches.length) return null;

  const out = new Array(expected).fill("");
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const index = Number(match[1]);
    if (!Number.isInteger(index)) continue;
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    // Providers freely switch between `marker text`, `marker\ntext`, and
    // several decorative blank lines. Those newlines are protocol formatting,
    // not requested line geometry. Keeping them forces visibly broken gaps in
    // the overlay; collapse them and let the bubble renderer wrap to its box.
    const segment = normalizeAiUnitText(source.slice(start, end));
    if (index >= 0 && index < expected && !out[index]) out[index] = segment;
  }

  return { paragraphs: out, cleanText: out.join("\n\n") };
}

/**
 * Parse a browser-direct answer while keeping an unexpected memory block out
 * of the last bubble.
 *
 * Direct translation deliberately requests `want_memo=false`, but providers
 * can ignore instructions or a mixed-version API can return the older prompt.
 * A well-formed trailing memo is stripped. A memo appearing before the last
 * expected paragraph (or followed by another paragraph marker) is refused:
 * guessing around a broken protocol could attribute character notes to text.
 */
export function extractDirectParagraphs(text, expected) {
  const source = String(text || "");
  const memoAt = source.indexOf(MEMO_MARKER);
  if (memoAt < 0) {
    return { parsed: extractParagraphs(source, expected), memo: "none" };
  }

  const lastExpected = expected > 0 ? source.lastIndexOf(`${MARKER_PREFIX}${expected - 1}${MARKER_SUFFIX}`) : -1;
  const markerAfterMemo = source.indexOf(MARKER_PREFIX, memoAt + MEMO_MARKER.length);
  if (lastExpected < 0 || memoAt < lastExpected || markerAfterMemo >= 0) {
    return { parsed: null, memo: "rejected" };
  }
  return {
    parsed: extractParagraphs(source.slice(0, memoAt).trimEnd(), expected),
    memo: "stripped",
  };
}

/**
 * Which expected indices the model failed to answer.
 *
 * This identifies an incomplete answer. The workflow uses it as evidence to
 * retry the complete ordered page context, never as permission to send only
 * the missing fragments.
 */
export function missingIndices(text, expected) {
  const found = extractParagraphs(text, expected);
  if (!found) return Array.from({ length: expected }, (_, i) => i);
  const missing = [];
  for (let i = 0; i < expected; i++) if (!found.paragraphs[i]) missing.push(i);
  return missing;
}
