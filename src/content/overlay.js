// Renders translated text as HTML overlays aligned over page images, and swaps images in place.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // Builds a small status badge element for a given label.
  function createOverlayBadge(label) {
    const badge = document.createElement("div");
    badge.textContent = label || "No AI key";
    Object.assign(badge.style, {
      position: "absolute",
      left: "6px",
      top: "6px",
      padding: "4px 6px",
      borderRadius: "6px",
      background: "rgba(255,255,255,.75)",
      color: "rgba(20,20,20,.95)",
      fontFamily: "var(--tp-font,system-ui)",
      fontSize: "12px",
      lineHeight: "1.2",
      textShadow: "0 0 2px rgba(255,255,255,.90),0 1px 1px rgba(0,0,0,.25)",
    });
    return badge;
  }

  // Returns the replacement-image URL carried by a result, or null.
  function extractNewImageSrc(result) {
    return (
      result?.imageDataUri ||
      result?.image ||
      result?.imageUrl ||
      result?.image_url ||
      result?.imageURL ||
      null
    );
  }

  function nudgeOverlay(imgElement, schedule) {
    schedule();
    if (!imgElement.complete) {
      imgElement.addEventListener("load", schedule, {
        once: true,
        passive: true,
      });
    }
    setTimeout(schedule, 50);
  }

  // Applies a translation result to an image as an HTML overlay and clean background layer.
  async function applyHtmlOverlay(
    imgElement,
    result,
    source,
    isTextMode,
    original = "",
    canApply = () => true,
  ) {
    if (!canApply()) return { stale: true };
    // A successful result or an intentional skip replaces any terminal marker
    // from an earlier retry/pass.
    TP.clearImageError?.(imgElement);
    const aiHtml = result?.Ai?.aihtml || result?.ai?.aihtml || "";
    const translatedHtml =
      result?.translated?.translatedhtml || result?.translatedhtml || "";
    const originalHtml =
      result?.original?.originalhtml || result?.originalhtml || "";

    const req = String(source || "")
      .trim()
      .toLowerCase();
    const chosen = req === "ai" || req === "original" ? req : "translated";
    const html =
      chosen === "ai"
        ? aiHtml
        : chosen === "original"
          ? originalHtml
          : translatedHtml;

    const cssParts = [String(result?.htmlCss || "")];
    if (chosen === "ai")
      cssParts.push(
        String(result?.Ai?.aihtmlCss || result?.ai?.aihtmlCss || ""),
      );
    const cssText = Array.from(
      new Set(cssParts.map((s) => s.trim()).filter(Boolean)),
    ).join("\n");

    const meta =
      chosen === "ai"
        ? result?.Ai?.aihtmlMeta || result?.ai?.aihtmlMeta || {}
        : result?.htmlMeta || {};
    const baseW =
      Number(meta.baseW || meta.sourceWidth) ||
      imgElement.naturalWidth ||
      imgElement.width ||
      1;
    const baseH =
      Number(meta.baseH || meta.sourceHeight) ||
      imgElement.naturalHeight ||
      imgElement.height ||
      1;
    const localBg = isTextMode && TP.overlayBackground.wants(result);
    const newImgSrc =
      isTextMode && !localBg ? extractNewImageSrc(result) : null;

    TP.ensureOverlayStyle(cssText);

    const mdKey = TP.isMangaDexHost?.() ? TP.mdGetKeyForImg?.(imgElement) : "";
    const useMd = Boolean(mdKey);
    const ops = useMd
      ? {
          key: mdKey,
          upsert: (kind) =>
            TP.upsertMangaDexHtmlOverlay(mdKey, imgElement, baseW, baseH, kind),
          schedule: () => TP.scheduleMangaDexOverlayUpdate(mdKey),
          hide: () => TP.hideMangaDexHtmlOverlay(mdKey),
        }
      : (() => {
          const key =
            TP.normUrl(original) || TP.normUrl(TP.getBestImgUrl(imgElement));
          return key
            ? {
                key,
                upsert: (kind) =>
                  TP.overlayMount.upsertHtmlOverlay(
                    key,
                    imgElement,
                    baseW,
                    baseH,
                    kind,
                  ),
                schedule: () => TP.overlayMount.scheduleHtmlOverlayUpdate(key),
                hide: () => TP.overlayMount.hideHtmlOverlay(key),
              }
            : null;
        })();
    if (!ops) return;

    /**
     * Tell a page that drives translation itself (the local viewer, the Auto
     * translate tab) that this image is finished.
     *
     * Every exit announces, including the ones that draw a badge or nothing at
     * all: "Lens found no text" is an answer, and a page that only hears about
     * the successes waits for a message that is never coming.
     * @param {boolean} drawn Whether translated text actually reached the page.
     */
    const announce = (drawn, note = "") => {
      if (useMd) return;
      TP.emitViewerEvent("textphantom:overlay-updated", {
        original,
        result,
        mode: isTextMode ? "lens_text" : "lens_images",
        source: req,
        drawn: Boolean(drawn),
        note: String(note || ""),
      });
    };

    const statusReason = TP.overlayStatus.reason(result);
    if (isTextMode && req === "ai" && statusReason) {
      const rec = ops.upsert("badge");
      if (localBg) {
        if (!(await TP.overlayBackground.apply(rec, imgElement, result, null, canApply)) || !canApply())
          return { stale: true };
      } else TP.overlayBackground.update(rec, imgElement, newImgSrc);
      rec.scope.textContent = "";
      rec.scope.appendChild(
        createOverlayBadge(TP.overlayStatus.label(statusReason)),
      );
      nudgeOverlay(imgElement, ops.schedule);
      announce(false, TP.overlayStatus.label(statusReason));
      return;
    }

    if (
      isTextMode &&
      req === "ai" &&
      !aiHtml &&
      !TP.overlayLocalRender.wants(result)
    ) {
      const rec = ops.upsert("badge");
      if (localBg) {
        if (!(await TP.overlayBackground.apply(rec, imgElement, result, null, canApply)) || !canApply())
          return { stale: true };
      } else TP.overlayBackground.update(rec, imgElement, newImgSrc);
      rec.scope.textContent = "";
      // No explicit skip reason means this is genuinely an absent AI layer,
      // not proof that an API key is missing.
      rec.scope.appendChild(createOverlayBadge("AI output unavailable"));
      nudgeOverlay(imgElement, ops.schedule);
      announce(false, "AI output unavailable");
      return;
    }

    if (!html && !(isTextMode && TP.overlayLocalRender.wants(result))) {
      if (isTextMode && (newImgSrc || localBg)) {
        const rec = ops.upsert("badge");
        if (localBg) {
          if (!(await TP.overlayBackground.apply(rec, imgElement, result, null, canApply)) || !canApply())
            return { stale: true };
        } else TP.overlayBackground.update(rec, imgElement, newImgSrc);
        rec.scope.textContent = "";
        nudgeOverlay(imgElement, ops.schedule);
        announce(false, "no overlay text for this image");
        return;
      }
      ops.hide();
      announce(false, "no overlay text for this image");
      return;
    }

    // The font sizes actually drawn, from whichever route drew them. Both
    // renderers emit `font-size:calc(var(--tp-font-scale,1) * Npx)`, so one
    // reader answers "how big was the text?" for the local DOM and for the
    // server's markup alike — the only way to compare the two engines on the
    // same page without a screenshot.
    const FONT_PX_RE =
      /font-size:\s*calc\(var\(--tp-font-scale,\s*1\)\s*\*\s*([\d.]+)px\)/g;
    const fontStats = (text) => {
      const sizes = [];
      let match;
      FONT_PX_RE.lastIndex = 0;
      while ((match = FONT_PX_RE.exec(String(text || ""))))
        sizes.push(Number(match[1]));
      if (!sizes.length) return null;
      sizes.sort((a, b) => a - b);
      return {
        lines: sizes.length,
        min: sizes[0],
        median: sizes[(sizes.length - 1) >> 1],
        max: sizes[sizes.length - 1],
      };
    };

    // Logs which render route ran for this image.
    const reportRoute = (outcome, reason, fonts = null) => {
      TP.log.info("tp.route", {
        stage: "render",
        outcome,
        reason,
        source: chosen,
        mode: isTextMode ? "lens_text" : "lens_images",
        serverMarkupAvailable: Boolean(html),
      });
      TP.traceNote?.("content/overlay.js", "applyHtmlOverlay", {
        ev: "route decided",
        outcome,
        reason,
        source: chosen,
        docParagraphs: (result?.lensDocument?.paragraphs || []).length,
        serverMarkupAvailable: Boolean(html),
        fonts,
      });
    };

    let builtRoot = null;
    let preparedLocalBackground = null;
    let localFailure = "";
    if (isTextMode && TP.overlayLocalRender.wants(result)) {
      try {
        if (localBg)
          preparedLocalBackground = await TP.overlayBackground.prepare(
            imgElement,
            result,
          );
        const built = await TP.overlayLocalRender.build(result, chosen);
        builtRoot = built.root;
        if (!builtRoot) localFailure = "local renderer refused the document";
      } catch (e) {
        localFailure = `local render threw: ${e?.message || String(e)}`;
      }
    }

    // Preparation can outlive navigation or a newer binding of this image.
    // Dispose the detached background before touching live DOM in that case.
    if (!canApply()) {
      if (preparedLocalBackground?.url) {
        try { URL.revokeObjectURL(preparedLocalBackground.url); } catch {}
      }
      return { stale: true };
    }
    const rec = ops.upsert("html");
    if (isTextMode && localBg) {
      const applied = await TP.overlayBackground.apply(
        rec,
        imgElement,
        result,
        preparedLocalBackground,
        canApply,
      );
      if (!applied || !canApply()) return { stale: true };
    } else TP.overlayBackground.update(rec, imgElement, newImgSrc);
    if (builtRoot) {
      rec.scope.replaceChildren(builtRoot);
      reportRoute("new", "", fontStats(builtRoot.innerHTML));
    } else {
      if (localFailure) reportRoute("fell-back", localFailure);
      // Not "old": the scope is replaced with the server's markup on the next
      // line. Calling this "old" made a working API-engine page read as a
      // page that had kept its previous overlay.
      else
        reportRoute(
          "server",
          isTextMode ? "drew the server's markup" : "image mode",
          fontStats(html),
        );
      TP.overlaySanitize.fill(rec.scope, html);
    }
    nudgeOverlay(imgElement, ops.schedule);
    announce(true);
  }
  Object.assign(TP, {
    createOverlayBadge,
    extractNewImageSrc,
    applyHtmlOverlay,
  });
})();
