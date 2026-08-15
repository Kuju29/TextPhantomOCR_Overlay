// Erases page text on a canvas copy of an image and samples paragraph contrast.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  // Matches PADDING_PX in api/backend/render/erase.py.
  const PADDING_PX = 2;
  const SAMPLE_MARGIN_PX = 6;
  const MAX_RING_SAMPLES = 96;
  const MAX_REGION_SAMPLES = 576;

  const readablePixels = new Map();

  // Returns true when this image's pixels can be read and the canvas exported.
  function canReadImagePixels(img) {
    const key = TP.normUrl(TP.getBestImgUrl(img)) || "";
    if (!key) return false;
    if (readablePixels.has(key)) return readablePixels.get(key);

    let ok = false;
    try {
      const w = Number(img?.naturalWidth) || 0;
      const h = Number(img?.naturalHeight) || 0;
      if (w > 0 && h > 0) {
        const probe = document.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
        const ctx = probe.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 1, 1);
        ctx.getImageData(0, 0, 1, 1);
        ok = true;
      }
    } catch {
      ok = false;
    }
    readablePixels.set(key, ok);
    return ok;
  }

  // Returns a box's rotated pixel quad; must stay identical to token_box_quad_px in api/backend/render/geometry.py.
  function boxQuadPx(box, W, H, pad = 0) {
    const w = Number(box.w) * W;
    const h = Number(box.h) * H;
    if (!(w > 0) || !(h > 0)) return null;

    const cx = Number(box.l) * W + w / 2;
    const cy = Number(box.t) * H + h / 2;
    const hw = w / 2 + pad;
    const hh = h / 2 + pad;

    const rad = ((Number(box.r) || 0) * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);

    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => [cx + (x * c - y * s), cy + (x * s + y * c)]);
  }

  // Returns the integer bounding box of a quad, clamped to the image.
  function quadBBox(quad, W, H) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const [x, y] of quad) {
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
    x1 = Math.max(0, Math.floor(x1));
    y1 = Math.max(0, Math.floor(y1));
    x2 = Math.min(W, Math.ceil(x2));
    y2 = Math.min(H, Math.ceil(y2));
    if (x2 <= x1 || y2 <= y1) return null;
    return [x1, y1, x2, y2];
  }

  function medianOf(values) {
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[values.length >> 1];
  }

  // Returns the median RGB of the ring just outside a box, or null when the ring is empty.
  function sampleRingColor(data, W, H, rect) {
    const [x1, y1, x2, y2] = rect;
    const m = SAMPLE_MARGIN_PX;
    const ox1 = Math.max(0, x1 - m);
    const oy1 = Math.max(0, y1 - m);
    const ox2 = Math.min(W, x2 + m);
    const oy2 = Math.min(H, y2 + m);

    const pts = [];
    const band = (bx1, by1, bx2, by2) => {
      for (let y = by1; y < by2; y++) {
        const row = y * W;
        for (let x = bx1; x < bx2; x++) pts.push((row + x) * 4);
      }
    };
    band(ox1, oy1, ox2, y1);
    band(ox1, y2, ox2, oy2);
    band(ox1, y1, x1, y2);
    band(x2, y1, ox2, y2);
    if (!pts.length) return null;

    const stride = Math.max(1, Math.ceil(pts.length / MAX_RING_SAMPLES));
    const rs = [];
    const gs = [];
    const bs = [];
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      rs.push(data[p]);
      gs.push(data[p + 1]);
      bs.push(data[p + 2]);
    }
    return [medianOf(rs), medianOf(gs), medianOf(bs)];
  }

  // Returns the median RGB in a rectangular area, sampled on a bounded grid.
  function sampleRectColor(data, W, H, rect) {
    const [x1, y1, x2, y2] = rect;
    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);
    if (!w || !h) return null;
    const stride = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_REGION_SAMPLES)));
    const rs = [];
    const gs = [];
    const bs = [];
    for (let y = y1; y < y2; y += stride) {
      const row = y * W;
      for (let x = x1; x < x2; x += stride) {
        const p = (row + x) * 4;
        rs.push(data[p]);
        gs.push(data[p + 1]);
        bs.push(data[p + 2]);
      }
    }
    return rs.length ? [medianOf(rs), medianOf(gs), medianOf(bs)] : null;
  }

  // Returns the median RGB of the inside perimeter of a paragraph rectangle.
  function sampleInsidePerimeter(data, W, H, rect) {
    const [x1, y1, x2, y2] = rect;
    const edge = Math.max(1, Math.floor(Math.min(x2 - x1, y2 - y1) / 5));
    const bands = [
      [x1, y1, x2, Math.min(y2, y1 + edge)],
      [x1, Math.max(y1, y2 - edge), x2, y2],
      [x1, Math.min(y2, y1 + edge), Math.min(x2, x1 + edge), Math.max(y1, y2 - edge)],
      [Math.max(x1, x2 - edge), Math.min(y2, y1 + edge), x2, Math.max(y1, y2 - edge)],
    ];
    const colours = bands.map((band) => sampleRectColor(data, W, H, band)).filter(Boolean);
    if (!colours.length) return null;
    return [
      medianOf(colours.map((rgb) => rgb[0])),
      medianOf(colours.map((rgb) => rgb[1])),
      medianOf(colours.map((rgb) => rgb[2])),
    ];
  }

  function relativeLuminance(rgb) {
    const lin = (channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return (0.2126 * lin(rgb[0])) + (0.7152 * lin(rgb[1])) + (0.0722 * lin(rgb[2]));
  }

  // Returns true when text on this colour must be light; mirrors api/backend/render/colors.py.
  function colourNeedsLightText(rgb) {
    const lum = relativeLuminance(rgb);
    return ((1.0 + 0.05) / (lum + 0.05)) >= ((lum + 0.05) / 0.05);
  }

  // Returns the pixel bounding box of a LensDocument paragraph.
  function paragraphRectPx(para, W, H) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const item of para?.items || []) {
      const p1 = item?.baseline?.[0];
      const p2 = item?.baseline?.[1];
      const glyphH = Number(item?.height) * H;
      if (!Array.isArray(p1) || !Array.isArray(p2) || !(glyphH > 0)) continue;
      const x1 = Number(p1[0]) * W;
      const y1 = Number(p1[1]) * H;
      const x2 = Number(p2[0]) * W;
      const y2 = Number(p2[1]) * H;
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      const pad = glyphH / 2;
      left = Math.min(left, x1, x2) - pad;
      top = Math.min(top, y1, y2) - pad;
      right = Math.max(right, x1, x2) + pad;
      bottom = Math.max(bottom, y1, y2) + pad;
    }
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    const rect = [
      Math.max(0, Math.floor(left)),
      Math.max(0, Math.floor(top)),
      Math.min(W, Math.ceil(right)),
      Math.min(H, Math.ceil(bottom)),
    ];
    return rect[2] - rect[0] >= 2 && rect[3] - rect[1] >= 2 ? rect : null;
  }

  // Sets textLight on each paragraph from an already-decoded pixel buffer.
  function annotateDocumentTextLightPixels(lensDocument, data, W, H) {
    let annotated = 0;
    let light = 0;
    for (const para of lensDocument?.paragraphs || []) {
      const rect = paragraphRectPx(para, W, H);
      if (!rect) continue;
      const readings = [
        sampleRectColor(data, W, H, rect),
        sampleInsidePerimeter(data, W, H, rect),
        sampleRingColor(data, W, H, rect),
      ].filter(Boolean);
      if (!readings.length) continue;
      const darkVotes = readings.filter(colourNeedsLightText).length;
      para.textLight = darkVotes * 2 >= readings.length;
      annotated++;
      if (para.textLight) light++;
    }
    return { annotated, light };
  }

  // Fills LensDocument.textLight by sampling the image itself.
  async function annotateDocumentTextLight(img, lensDocument, sourceImageDataUri = "") {
    if (!lensDocument?.paragraphs?.length) return { annotated: 0, light: 0 };
    const readableSource = canReadImagePixels(img)
      ? img
      : await loadReadableImage(sourceImageDataUri);
    const W = Number(readableSource?.naturalWidth || readableSource?.width) || 0;
    const H = Number(readableSource?.naturalHeight || readableSource?.height) || 0;
    if (!(W > 0) || !(H > 0)) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(readableSource, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      const stats = annotateDocumentTextLightPixels(lensDocument, data, W, H);
      TP.log.debug("contrast: document annotated locally", stats);
      return stats;
    } catch (e) {
      TP.log.warn("contrast: canvas is not readable", { error: e?.message || String(e) });
      return null;
    }
  }

  // Decodes a data URI into an Image whose pixels can be read.
  async function loadReadableImage(dataUri) {
    if (!String(dataUri || "").startsWith("data:image/")) return null;
    return new Promise((resolve) => {
      const source = new Image();
      source.onload = () => resolve(source);
      source.onerror = () => resolve(null);
      source.src = dataUri;
    });
  }

  // Paints the erase boxes out of an image and returns an object URL, or null when it cannot.
  async function buildErasedBackground(
    img,
    eraseBoxes,
    sourceImageDataUri = "",
    lensDocument = null,
  ) {
    const boxes = Array.isArray(eraseBoxes?.boxes) ? eraseBoxes.boxes : null;
    if (!boxes) {
      TP.log.warn("erase: result carried no eraseBoxes", { schema: eraseBoxes?.schema });
      return null;
    }

    const readableSource = canReadImagePixels(img)
      ? img
      : await loadReadableImage(sourceImageDataUri);
    const W = Number(readableSource?.naturalWidth || readableSource?.width) || 0;
    const H = Number(readableSource?.naturalHeight || readableSource?.height) || 0;
    if (!(W > 0) || !(H > 0)) {
      TP.log.warn("erase: image has no natural size yet");
      return null;
    }

    const t0 = performance.now();
    let canvas;
    let ctx;
    let data;
    try {
      canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(readableSource, 0, 0, W, H);
      data = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
      TP.log.warn("erase: canvas is not readable", { error: e?.message || String(e) });
      return null;
    }

    const contrast = lensDocument?.paragraphs?.length
      ? annotateDocumentTextLightPixels(lensDocument, data, W, H)
      : { annotated: 0, light: 0 };

    let painted = 0;
    let skipped = 0;
    for (const box of boxes) {
      const quad = boxQuadPx(box, W, H, PADDING_PX);
      if (!quad) {
        skipped++;
        continue;
      }
      const rect = quadBBox(quad, W, H);
      if (!rect) {
        skipped++;
        continue;
      }
      const rgb = sampleRingColor(data, W, H, rect);
      if (!rgb) {
        skipped++;
        continue;
      }
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.beginPath();
      ctx.moveTo(quad[0][0], quad[0][1]);
      for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i][0], quad[i][1]);
      ctx.closePath();
      ctx.fill();
      painted++;
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.92));
    if (!blob) {
      TP.log.warn("erase: canvas could not be exported");
      return null;
    }

    const out = {
      url: URL.createObjectURL(blob),
      painted,
      skipped,
      contrast,
      ms: Math.round(performance.now() - t0),
    };
    TP.log.debug("erase: background built locally", {
      painted,
      skipped,
      contrastAnnotated: contrast.annotated,
      contrastLight: contrast.light,
      ms: out.ms,
      kb: Math.round(blob.size / 1024),
    });
    return out;
  }

  TP.canReadImagePixels = canReadImagePixels;
  TP.annotateDocumentTextLight = annotateDocumentTextLight;
  TP.buildErasedBackground = buildErasedBackground;
  // Exported for the geometry parity test against the Python implementation.
  TP.__eraseBoxQuadPx = boxQuadPx;
  TP.__annotateDocumentTextLightPixels = annotateDocumentTextLightPixels;
})();
