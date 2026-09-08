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

import { geometryDiagnostics, rubyDiagnostics } from "./geometry-diagnostics.js";
import { buildOwnedEraseBoxes } from "./erase-boxes.js";
import { pageNeedsGroups } from "./lens-axis.js";
import { buildLensDocument, buildTranslatedLensDocument, documentWarnings } from "./lens-document.js";
import {
  decodeTree,
  LensTreeError,
  treeWarnings,
} from "./lens-tree.js";

import { filterJapaneseFuriganaTrees } from "./lens-furigana.js";
export { filterJapaneseFuriganaTrees } from "./lens-furigana.js";

/** The uploaded image dimensions returned by `/v1/lens/raw` are authoritative. */
export function authoritativeLensImageSize(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0
  ) {
    throw new LensTreeError(
      "/v1/lens/raw returned invalid authoritative image dimensions",
    );
  }
  return { width, height };
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
export function decodeLensResponse(lens, { width, height, targetLang = "", source = "ai", diagnostic = null }) {
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

  // Furigana is not a display, erase, grouping, or AI input layer in V3.
  // Remove proven ruby immediately after Lens decode so its text AND geometry
  // cannot contaminate paragraph bounds, head-line grouping, font metrics, or units.
  const filtered = filterJapaneseFuriganaTrees(
    rawOriginalTree, rawTranslatedTree, {
      sourceLang: String(lens?.originalContentLanguage || ""), imgW: width, imgH: height,
    },
  );
  const originalTree = filtered.original;
  const translatedTree = filtered.translated;
  // Only requested diagnostic captures build geometry views. Reporting can
  // never turn a successfully decoded page into a processing failure.
  if (typeof diagnostic === "function") {
    try {
      diagnostic(rubyDiagnostics(filtered.report));
      if (filtered.report.itemsDropped || filtered.report.spansDropped || filtered.report.ambiguousCandidates) {
        for (const event of geometryDiagnostics(rawOriginalTree, {width, height})) diagnostic(event);
        for (const event of geometryDiagnostics(originalTree, {width, height, reason:"clean_geometry"})) diagnostic(event);
      }
    } catch {}
  }

  const options = { width, height,
    sourceLang: String(lens?.originalContentLanguage || ""), targetLang: String(targetLang || "") };
  const document = source === "translated"
    ? buildTranslatedLensDocument(translatedTree, options)
    : buildLensDocument(originalTree, translatedTree, options);

  // Erase geometry follows the same furigana-free tree. Proven ruby boxes are
  // intentionally absent, matching the user's "remove text and box" contract.
  const eraseBoxes = buildOwnedEraseBoxes(originalTree);

  // What the DECODE threw away, carried ON the document — the same place
  // `/v1/lens/decode` puts it, so a consumer cannot tell which route built the
  // thing it is holding. Returning them only as a side channel would mean the
  // renderer stopped seeing them the day this route went live.
  const decodeWarnings = [
    ...treeWarnings(originalTree).map((line) => `original: ${line}`),
    ...treeWarnings(translatedTree).map((line) => `translated: ${line}`),
  ];
  if (filtered.report.paragraphsDropped || filtered.report.itemsDropped || filtered.report.spansDropped) {
    decodeWarnings.push(
      `original: removed Japanese furigana before translation ` +
        `(paragraphs=${filtered.report.paragraphsDropped}, items=${filtered.report.itemsDropped}, spans=${filtered.report.spansDropped})`,
    );
  }
  if (decodeWarnings.length) {
    document.warnings = [...documentWarnings(document), ...decodeWarnings];
  }

  return {
    document,
    eraseBoxes,
    warnings: documentWarnings(document),
    // Canonical Lens graph grouping takes a tree. Returning only the document would require
    // rebuilding this shape from a lossier one at the call site.
    trees: {
      original: originalTree,
      translated: translatedTree,
      // Grouping consumes the same furigana-free geometry that becomes
      // original_tree.json/original_tree_raw.json. Ruby cannot create or split lines.
      grouping: originalTree,
    },
    groupingRawToDocument: originalTree.paragraphs.map((_p, i) => i),
    // Does this page need Lens graph grouping? Decided from the ORIGINAL
    // layer: the two trees carry the same geometry and differ only in script,
    // and it is the source typesetting that Lens split into columns.
    groups: pageNeedsGroups(originalTree),
  };
}
