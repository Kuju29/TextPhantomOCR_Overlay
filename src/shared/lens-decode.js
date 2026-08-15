/**
 * One raw Lens response in, one document + erase boxes out.
 * This is `POST /v1/lens/decode`, moved into the browser.
 * The extension already holds the Lens response, so decoding locally avoids
 * an extra round trip. The API keeps `_decode` in
 * `api/backend/api/routes/lens_v1.py` for `/v1/lens/fallback`, where the
 * server did the Lens call itself.
 *
 * It lives in `shared/` rather than inside the service worker because the
 * COMPOSITION is the part worth pinning. Each piece can match Python while the
 * assembly does not — a layer passed in the wrong order, a warning prefix
 * dropped — and the result is a document that looks right and is not what the
 * server would have sent. `scripts/test-lens-tree.mjs` asserts this function
 * against the same fixture `api/tests/test_lens_tree.py` holds `_decode` to.
 *
 * Nothing here touches the network, `chrome.*`, or the DOM, which is what
 * makes that test possible.
 */

import { buildEraseBoxes } from "./erase-boxes.js";
import { pageNeedsGroups } from "./lens-axis.js";
import { buildLensDocument, documentWarnings } from "./lens-document.js";
import { decodeTree, flattenSpans, LensTreeError, treeWarnings } from "./lens-tree.js";

const RUBY_STRIP = new Set(Array.from(
  "。､、･・…！!？?ー―〜~（）()「」『』 \u3000\t\r\n",
));

function isJapaneseLanguage(value) {
  return /^ja(?:[-_]|$)/i.test(String(value || "").trim());
}

function isKanaReading(text, maxLength = 8) {
  const core = Array.from(String(text || "")).filter((ch) => !RUBY_STRIP.has(ch));
  return core.length >= 1 && core.length <= maxLength && core.every((ch) => {
    const cp = ch.codePointAt(0);
    return cp >= 0x3040 && cp <= 0x30ff;
  });
}

function hasKanji(text) {
  return Array.from(String(text || "")).some((ch) => {
    const cp = ch.codePointAt(0);
    return cp >= 0x3400 && cp <= 0x9fff;
  });
}

function boundsOf(node) {
  const raw = node?.bounds_px;
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const out = raw.map(Number);
  if (!out.every(Number.isFinite) || out[2] <= out[0] || out[3] <= out[1]) return null;
  return out;
}

function itemRotation(item) {
  return Number(item?.box?.rotation_deg) || 0;
}

function isVerticalItem(item) {
  const folded = Math.abs(itemRotation(item)) % 180;
  return Math.abs(folded - 90) <= 12;
}

function isVerticalParagraph(para) {
  const items = (para?.items || []).filter((item) => String(item?.text || "").trim());
  if (!items.length) return false;
  return items.filter(isVerticalItem).length * 2 >= items.length;
}

function glyphPx(node, imgH) {
  if (Array.isArray(node?.items)) {
    const sizes = node.items.map((item) => glyphPx(item, imgH)).filter((n) => n > 0);
    if (!sizes.length) return 0;
    sizes.sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)];
  }
  return Math.max(0, Number(node?.height_raw) * imgH || 0);
}

/** A ruby candidate must hug the right side of a larger parallel kanji run. */
function isRubyBesideBase(candidate, base, imgH) {
  const a = boundsOf(candidate);
  const b = boundsOf(base);
  if (!a || !b) return false;
  const candidateFont = glyphPx(candidate, imgH);
  const baseFont = glyphPx(base, imgH);
  if (!(candidateFont > 0) || baseFont < 1.6 * candidateFont) return false;

  const candidateHeight = a[3] - a[1];
  const overlap = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  if (overlap < 0.4 * candidateHeight) return false;

  const candidateWidth = Math.max(1, a[2] - a[0]);
  const gapToRight = a[0] - b[2];
  return gapToRight >= -0.25 * candidateWidth && gapToRight <= 1.6 * candidateWidth;
}

function unionItemBounds(items) {
  const bounds = items.map(boundsOf).filter(Boolean);
  if (!bounds.length) return null;
  return [
    Math.min(...bounds.map((b) => b[0])),
    Math.min(...bounds.map((b) => b[1])),
    Math.max(...bounds.map((b) => b[2])),
    Math.max(...bounds.map((b) => b[3])),
  ];
}

function rebuildParagraph(raw, paraIndex, dropItems = new Set(), rebuildText = true) {
  const items = [];
  (raw?.items || []).forEach((item, oldItemIndex) => {
    if (dropItems.has(oldItemIndex)) return;
    const itemIndex = items.length;
    const spans = (item?.spans || []).map((span, spanIndex) => ({
      ...span,
      para_index: paraIndex,
      item_index: itemIndex,
      span_index: spanIndex,
    }));
    items.push({ ...item, para_index: paraIndex, item_index: itemIndex, spans });
  });
  const starts = items.map((item) => item.start_raw).filter(Number.isFinite);
  const ends = items.map((item) => item.end_raw).filter(Number.isFinite);
  const joined = items.map((item) => String(item?.text || "").trim()).filter(Boolean).join("");
  const text = rebuildText ? joined : String(raw?.text || "");
  return {
    ...raw,
    para_index: paraIndex,
    start_raw: starts.length ? Math.min(...starts) : null,
    end_raw: ends.length ? Math.max(...ends) : null,
    text,
    valid_text: Boolean(text.trim()),
    bounds_px: unionItemBounds(items),
    items,
  };
}

/**
 * Remove Japanese vertical ruby from freshly decoded Lens trees.
 *
 * This deliberately runs before document/group/AI construction.  The caller
 * must build erase geometry from the unfiltered original spans first: ruby is
 * not translated or rendered, but its ink still needs to be erased.
 */
export function filterJapaneseFuriganaTrees(
  originalTree,
  translatedTree,
  { sourceLang = "", imgH = 0 } = {},
) {
  const originalParas = Array.isArray(originalTree?.paragraphs) ? originalTree.paragraphs : [];
  const translatedParas = Array.isArray(translatedTree?.paragraphs) ? translatedTree.paragraphs : [];
  if (!isJapaneseLanguage(sourceLang) || !(Number(imgH) > 0)) {
    return {
      original: originalTree,
      translated: translatedTree,
      report: {
        paragraphsDropped: 0,
        itemsDropped: 0,
        rawToFiltered: originalParas.map((_para, index) => index),
        rubyOwnerRaw: {},
      },
    };
  }

  const paragraphDrops = new Set();
  const rubyOwnerRaw = new Map();
  for (let i = 0; i < originalParas.length; i++) {
    const candidate = originalParas[i];
    if (!isVerticalParagraph(candidate) || !isKanaReading(candidate?.text)) continue;
    for (let j = 0; j < originalParas.length; j++) {
      if (i === j) continue;
      const base = originalParas[j];
      const candidateBounds = boundsOf(candidate);
      const baseBounds = boundsOf(base);
      const paragraphWidthRatio = candidateBounds && baseBounds
        ? (baseBounds[2] - baseBounds[0]) / Math.max(1, candidateBounds[2] - candidateBounds[0])
        : 0;
      if (
        isVerticalParagraph(base) &&
        hasKanji(base?.text) &&
        // Whole-paragraph ruby is much narrower than its base column.  This
        // stronger gate protects a small kana caption beside a large title;
        // item-level ruby below uses the established 1.6 glyph-size rule.
        paragraphWidthRatio >= 2.3 &&
        isRubyBesideBase(candidate, base, Number(imgH))
      ) {
        paragraphDrops.add(i);
        rubyOwnerRaw.set(i, j);
        break;
      }
    }
  }

  const itemDrops = new Map();
  originalParas.forEach((para, paraIndex) => {
    if (paragraphDrops.has(paraIndex) || !isVerticalParagraph(para)) return;
    const items = Array.isArray(para?.items) ? para.items : [];
    const drop = new Set();
    items.forEach((candidate, itemIndex) => {
      if (!isVerticalItem(candidate) || !isKanaReading(candidate?.text)) return;
      if (items.some((base, baseIndex) => (
        baseIndex !== itemIndex &&
        isVerticalItem(base) &&
        hasKanji(base?.text) &&
        isRubyBesideBase(candidate, base, Number(imgH))
      ))) drop.add(itemIndex);
    });
    if (drop.size) itemDrops.set(paraIndex, drop);
  });

  // The overwhelmingly common page has no ruby.  Preserve the decoder's
  // object and exact paragraph text in that case; rebuilding unchanged text
  // from items would lose meaningful spaces between mixed Japanese/Latin
  // runs and would make this filter alter pages it did not filter.
  if (!paragraphDrops.size && !itemDrops.size) {
    return {
      original: originalTree,
      translated: translatedTree,
      report: {
        paragraphsDropped: 0,
        itemsDropped: 0,
        rawToFiltered: originalParas.map((_para, index) => index),
        rubyOwnerRaw: {},
      },
    };
  }

  const originalOut = [];
  const translatedOut = [];
  const rawToFiltered = originalParas.map(() => null);
  originalParas.forEach((para, oldParaIndex) => {
    if (paragraphDrops.has(oldParaIndex)) return;
    const newParaIndex = originalOut.length;
    rawToFiltered[oldParaIndex] = newParaIndex;
    const drops = itemDrops.get(oldParaIndex) || new Set();
    originalOut.push(rebuildParagraph(para, newParaIndex, drops, true));

    const translated = translatedParas[oldParaIndex];
    if (!translated) return;
    // Never mirror an original item index into the translated layer.  Equal
    // item counts do not mean equal segmentation: Lens can wrap the Thai into
    // two target lines while the Japanese happens to be base+ruby (also two).
    // The original semantic layer is what AI/groups consume; preserving all
    // translated items is the only non-destructive answer without a proven
    // geometric correspondence.
    translatedOut.push(rebuildParagraph(
      translated,
      newParaIndex,
      new Set(),
      false,
    ));
  });

  // Preserve any trailing translated paragraphs only when no original
  // paragraph was removed.  A count mismatch is already a warning; after a
  // removal there is no trustworthy positional owner for a trailing layer.
  if (!paragraphDrops.size) {
    for (let i = originalParas.length; i < translatedParas.length; i++) {
      translatedOut.push(rebuildParagraph(translatedParas[i], translatedOut.length, new Set(), false));
    }
  }

  const itemsDropped = [...itemDrops.values()].reduce((sum, set) => sum + set.size, 0);
  return {
    original: { ...originalTree, paragraphs: originalOut },
    translated: { ...translatedTree, paragraphs: translatedOut },
    report: {
      paragraphsDropped: paragraphDrops.size,
      itemsDropped,
      rawToFiltered,
      rubyOwnerRaw: Object.fromEntries(rubyOwnerRaw),
    },
  };
}

/** The uploaded image dimensions returned by `/v1/lens/raw` are authoritative. */
export function authoritativeLensImageSize(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new LensTreeError("/v1/lens/raw returned invalid authoritative image dimensions");
  }
  return { width, height };
}

/** Map raw-tree group membership back onto the furigana-filtered document. */
export function remapRawBubbleGroups(bubbleGroups, rawToFiltered) {
  if (!Array.isArray(bubbleGroups) || !Array.isArray(rawToFiltered)) return bubbleGroups;
  return bubbleGroups.flatMap((group) => {
    const mapped = [...new Set((group?.para_indices || [])
      .map((rawIndex) => rawToFiltered[Number(rawIndex)])
      .filter((index) => Number.isInteger(index) && index >= 0))];
    return mapped.length ? [{ ...group, para_indices: mapped }] : [];
  });
}

/**
 * Decode a raw Lens response.
 *
 * Throws rather than returning a partial result. Every step is pure
 * computation on bytes the caller already has — there is no transient failure
 * mode here, so anything that goes wrong means the decoder no longer matches
 * what Google sends, and that is permanent until this code is updated. A
 * caller that swallowed it would show an empty overlay and send the next
 * person looking at the renderer.
 *
 * @param {object} lens raw Lens response
 * @param {{width: number, height: number, targetLang?: string}} options
 * @returns {{document: object, eraseBoxes: object, warnings: string[],
 *   trees: {original: object, translated: object}, groups: object}}
 */
export function decodeLensResponse(lens, { width, height, targetLang = "" }) {
  const rawOriginalTree = decodeTree(
    lens?.originalParagraphs || [],
    String(lens?.originalTextFull || ""),
    "original",
    width,
    height,
  );
  const rawTranslatedTree = decodeTree(
    lens?.translatedParagraphs || [],
    String(lens?.translatedTextFull || ""),
    "translated",
    width,
    height,
  );

  const filtered = filterJapaneseFuriganaTrees(rawOriginalTree, rawTranslatedTree, {
    sourceLang: String(lens?.originalContentLanguage || ""),
    imgH: height,
  });
  const originalTree = filtered.original;
  const translatedTree = filtered.translated;

  const document = buildLensDocument(originalTree, translatedTree, {
    width,
    height,
    sourceLang: String(lens?.originalContentLanguage || ""),
    targetLang: String(targetLang || ""),
  });

  // Capture raw ruby ink too, but assign every box to the semantic paragraph
  // whose replacement owns it. Whole-paragraph ruby is assigned only to the
  // base paragraph that passed the ruby geometry proof above.
  const eraseBoxes = buildEraseBoxes(flattenSpans(rawOriginalTree), {
    ownerForToken: (token) => {
      const rawIndex = Number(token?.para_index);
      let filteredIndex = filtered.report.rawToFiltered[rawIndex];
      if (!Number.isInteger(filteredIndex)) {
        const baseRaw = Number(filtered.report.rubyOwnerRaw?.[rawIndex]);
        filteredIndex = filtered.report.rawToFiltered[baseRaw];
      }
      return Number.isInteger(filteredIndex) ? `p${filteredIndex}` : "";
    },
  });

  // What the DECODE threw away, carried ON the document — the same place
  // `/v1/lens/decode` puts it, so a consumer cannot tell which route built the
  // thing it is holding. Returning them only as a side channel would mean the
  // renderer stopped seeing them the day this route went live.
  const decodeWarnings = [
    ...treeWarnings(originalTree).map((line) => `original: ${line}`),
    ...treeWarnings(translatedTree).map((line) => `translated: ${line}`),
  ];
  if (filtered.report.paragraphsDropped || filtered.report.itemsDropped) {
    decodeWarnings.push(
      `original: removed Japanese furigana before translation ` +
        `(paragraphs=${filtered.report.paragraphsDropped}, items=${filtered.report.itemsDropped})`,
    );
  }
  if (decodeWarnings.length) {
    document.warnings = [...documentWarnings(document), ...decodeWarnings];
  }

  return {
    document,
    eraseBoxes,
    warnings: documentWarnings(document),
    // `/v1/groups` takes a tree. Returning only the document would require
    // rebuilding this shape from a lossier one at the call site.
    trees: {
      original: originalTree,
      translated: translatedTree,
      // ONNX must see exactly the raw Lens geometry, before semantic ruby
      // removal changes its paragraph set and ROI plan.
      grouping: rawOriginalTree,
    },
    groupingRawToDocument: filtered.report.rawToFiltered,
    // Does this page need the ONNX + merge pass? Decided from the ORIGINAL
    // layer: the two trees carry the same geometry and differ only in script,
    // and it is the source typesetting that Lens split into columns.
    groups: pageNeedsGroups(originalTree),
  };
}
