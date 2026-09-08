(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  let rendererPromise = null;

  // Imports the overlay renderer module on demand from an extension URL.
  function loadRenderer() {
    if (rendererPromise) return rendererPromise;
    rendererPromise = import(
      chrome.runtime.getURL("processors/render/renderer.js")
    ).catch((e) => {
      rendererPromise = null;
      throw e;
    });
    return rendererPromise;
  }

  // Returns true when the result carries the geometry needed to render locally.
  function wantsLocalRender(result) {
    return Boolean(result?.lensDocument?.paragraphs);
  }

  // Builds the overlay DOM from the result's LensDocument geometry.
  async function buildLocalRender(result, source) {
    const renderer = await loadRenderer();
    TP.ensureOverlayStyle(renderer.OVERLAY_CSS);
    const { root, report } = renderer.renderOverlay(result.lensDocument, {
      source,
      relayoutTranslated: result?.layout?.relayout_translated,
    });
    if (report.error) {
      TP.log.warn(
        `overlay: local render refused the document — ${report.error}`,
        {
          error: report.error,
          source,
        },
      );
      return { root: null, report };
    }
    const unanswered = report.aiUnanswered || [];
    const structural = report.missingLayer.filter(
      (id) => !unanswered.includes(id),
    );
    if (unanswered.length) {
      // Not "no text": the text is still on screen. The model answered some
      // units and not others, and this build leaves the source pixels of the
      // unanswered ones alone rather than erasing them into a blank bubble.
      //
      // Two different counts, both needed. The model is asked per UNIT (one
      // bubble = one unit, however many Lens paragraphs it spans), so the unit
      // count is what it actually got wrong. The paragraph count is what the
      // reader sees still in the source language. Reporting only paragraphs
      // reads as a much worse failure than it is: 5 unanswered units across
      // two-column bubbles print as "10".
      const partial = result?.aiPartial || null;
      const unitsMissing = Array.isArray(partial?.missing)
        ? partial.missing.length
        : null;
      TP.traceNote?.(
        "content/overlay/local-render.js",
        "aiPartial",
        {
          event: "overlay: AI partial — kept the original text where the model did not answer",
          source,
          units:
            unitsMissing === null
              ? "unknown"
              : `${unitsMissing} of ${unitsMissing + Number(partial?.translated || 0)} unanswered`,
          paragraphs: unanswered.length,
          unitIds: Array.isArray(partial?.missing)
            ? partial.missing
            : undefined,
          // Which of the two ways the model failed to answer. They look
          // identical on the page and need different fixes: an empty entry is
          // the output contract's escape hatch being over-used (a prompt
          // problem), a missing entry is the contract breaking (a provider
          // problem).
          returnedEmpty:
            Array.isArray(partial?.declined) && partial.declined.length
              ? partial.declined
              : undefined,
          notReturned:
            Array.isArray(partial?.omitted) && partial.omitted.length
              ? partial.omitted
              : undefined,
          ids: unanswered,
        },
      );
    }
    if (report.aiBlocksOverlapping) {
      const rows = report.aiBlockOverlapGeometry || [];
      const chunks = Math.max(1, Math.ceil(rows.length / 12));
      for (let chunk=0; chunk<chunks; chunk++) TP.traceNote?.(
        "content/overlay/local-render.js", "aiBlockOverlap",
        {schema:"tp.audit/1",event:"geometry_overlap",reason:"overlap_detected",sourceKind:source,
          totalRows:report.aiBlocksOverlapping,capturedRows:rows.length,complete:rows.length===report.aiBlocksOverlapping,
          chunk,chunks,rows:rows.slice(chunk*12,chunk*12+12)});
    }
    if (structural.length) {
      // A different failure: the grouping names a paragraph this document does
      // not have, so the sentence has nowhere honest to go.
      TP.traceNote?.(
        "content/overlay/local-render.js", "groupingDocumentMismatch",
        {
          event: "overlay: grouping and document disagree; these paragraphs were not drawn",
          source,
          ids: structural,
        },
      );
    }
    TP.log.debug("overlay: rendered locally", report);
    return { root, report };
  }

  // Converts a data URI to a blob: URL.

  // Mounts the overlay host as the previous sibling of its image.
  TP.overlayLocalRender = { build: buildLocalRender, wants: wantsLocalRender };
})();
