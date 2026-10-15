/**
 * Paragraph-marker protocol, client side. One model call carries many
 * paragraphs; the markers make the answer separable again:
 *
 *     <<TP_P0>>
 *     paragraph zero
 *     <<TP_P1>>
 *     paragraph one
 *
 * A port of `api/backend/ai/markers.py`, pinned to the same fixture
 * (`scripts/test-ai-markers.mjs`, `api/tests/test_markers_parity.py`): a split
 * difference between extension and server would silently mis-align one page
 * of a chapter against its bubbles.
 */

const MARKER_PREFIX = "<<TP_P";
const MARKER_SUFFIX = ">>";

const MARKER_RE = /<<TP_P(\d+)>>/g;
export const MEMO_MARKER = "<<TP_MEMO>>";

// Thai prose normally has no ASCII spaces between words. The provider's text is
// kept intact in the LensDocument (it is semantic data) and these gaps are
// collapsed only at the layout boundary, as the server renderer does.
const THAI_WORD_GAP_RE =
  /([\u0E01-\u0E2E\u0E30-\u0E3A\u0E40-\u0E45\u0E47-\u0E4E])\s+(?=[\u0E01-\u0E2E\u0E30-\u0E3A\u0E40-\u0E45\u0E47-\u0E4E])/gu;

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

/**
 * Split a marked answer back into paragraphs: `{ paragraphs, cleanText }` with
 * `paragraphs.length === expected` (missing slots are ""), or `null` when there
 * are no markers at all. `null` means the protocol broke; all-empty means the
 * model had nothing to say. Do not conflate them.
 */
function extractParagraphs(text, expected) {
  const source = String(text || "");
  if (!source || !(expected > 0) || !source.includes(MARKER_PREFIX))
    return null;

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
 * Parse a browser-direct answer while keeping an unexpected memory block out of
 * the last bubble. Direct requests ask for `want_memo=false`, but providers may
 * ignore it: a well-formed trailing memo is stripped, and a memo before the last
 * expected paragraph (or followed by a marker) is refused rather than guessed
 * around, so character notes are never attributed to text.
 */
export function extractDirectParagraphs(text, expected) {
  const source = String(text || "");
  const memoAt = source.indexOf(MEMO_MARKER);
  if (memoAt < 0) {
    return { parsed: extractParagraphs(source, expected), memo: "none" };
  }

  const lastExpected =
    expected > 0
      ? source.lastIndexOf(`${MARKER_PREFIX}${expected - 1}${MARKER_SUFFIX}`)
      : -1;
  const markerAfterMemo = source.indexOf(
    MARKER_PREFIX,
    memoAt + MEMO_MARKER.length,
  );
  if (lastExpected < 0 || memoAt < lastExpected || markerAfterMemo >= 0) {
    return { parsed: null, memo: "rejected" };
  }
  return {
    parsed: extractParagraphs(source.slice(0, memoAt).trimEnd(), expected),
    memo: "stripped",
  };
}

