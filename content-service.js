(function () {
  if (globalThis.__TextPhantomContentLoaded) return;
  globalThis.__TextPhantomContentLoaded = true;

  const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  const CURRENT_LEVEL_NAME = "debug";
  const CURRENT_LEVEL = LEVELS[CURRENT_LEVEL_NAME] ?? 0;

  function formatTimestamp() {
    return new Date().toISOString();
  }

  function createLogger(namespace) {
    function _log(level, ...args) {
      if (LEVELS[level] >= CURRENT_LEVEL) {
        const prefix = `[${formatTimestamp()}][${namespace}][${level.toUpperCase()}]`;
        if (level === "debug") console.debug(prefix, ...args);
        else if (level === "info") console.info(prefix, ...args);
        else if (level === "warn") console.warn(prefix, ...args);
        else if (level === "error") console.error(prefix, ...args);
        else console.log(prefix, ...args);
      }
    }
    const logger = (...a) => _log("info", ...a);
    logger.debug = (...a) => _log("debug", ...a);
    logger.info = (...a) => _log("info", ...a);
    logger.warn = (...a) => _log("warn", ...a);
    logger.error = (...a) => _log("error", ...a);
    return logger;
  }

  window.createLogger = window.createLogger || createLogger;

  const log = window.createLogger
    ? window.createLogger("content_bootstrap")
    : console;

  const __tpVer = (() => {
    try {
      return (chrome?.runtime?.getManifest?.() || {}).version || "";
    } catch {
      return "";
    }
  })();
  const __tpIsTop = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  try {
    chrome.runtime.sendMessage(
      {
        type: "TP_CONTENT_READY",
        href: location.href,
        ver: __tpVer,
        top: __tpIsTop,
      },
      () => void chrome.runtime.lastError,
    );
  } catch {}

  try {
    console.info("[TextPhantom][content] loaded", {
      href: location.href,
      ver: __tpVer,
      top: __tpIsTop,
    });
  } catch {}

  function truncate(s, len = 180) {
    if (!s) return s;
    try {
      s = String(s);
    } catch {}
    return s.length > len ? s.slice(0, len) + "…" : s;
  }

  const replaceStateByOriginal = new Map();

  function noteReplaceState(original, state) {
    const key = _normUrl(original);
    if (!key) return;
    replaceStateByOriginal.set(key, { state, ts: Date.now() });
  }

  function shouldShowReplaceError(original) {
    const key = _normUrl(original);
    if (!key) return true;
    const s = replaceStateByOriginal.get(key);
    if (!s) return true;
    if (s.state === "ok") return false;
    if (s.state === "pending" && Date.now() - s.ts < 12000) return false;
    return true;
  }

  function markImageError(original, msg) {
    if (!shouldShowReplaceError(original)) {
      log.debug("markImageError skipped (replace ok/pending)", {
        original: truncate(original),
      });
      return;
    }
    const img = findTargetImage(original);
    if (!img || img.dataset.lensError) {
      log.info("markImageError", {
        count: 0,
        original: truncate(original),
        message: msg,
      });
      return;
    }

    const alreadyReplaced =
      !!img.dataset.tpBlobUrl ||
      (img.currentSrc || img.src || "").startsWith("blob:") ||
      (img.currentSrc || img.src || "").startsWith("data:");
    if (alreadyReplaced) {
      log.debug("markImageError skipped (image replaced)", {
        original: truncate(original),
      });
      return;
    }

    img.style.outline = "3px solid red";

    const badge = document.createElement("div");
    badge.textContent = "⚠️";
    badge.title = msg || "OCR error";

    const r = img.getBoundingClientRect();
    badge.style.position = "absolute";
    badge.style.left = `${r.left + window.scrollX + 4}px`;
    badge.style.top = `${r.top + window.scrollY + 4}px`;
    badge.style.background = "rgba(255,255,255,0.9)";
    badge.style.padding = "2px 4px";
    badge.style.borderRadius = "4px";
    badge.style.zIndex = 9999;

    document.body.appendChild(badge);
    img.dataset.lensError = "1";
    log.info("markImageError", {
      count: 1,
      original: truncate(original),
      message: msg,
    });
  }

  async function getSettings() {
    return new Promise((res) => {
      chrome.storage.local.get(
        ["mode", "lang", "sources", "aiKey"],
        (items) => {
          res({
            mode: typeof items.mode === "string" ? items.mode : "lens_images",
            lang: typeof items.lang === "string" ? items.lang : "th",
            sources:
              typeof items.sources === "string" ? items.sources : "translated",
            aiKey: typeof items.aiKey === "string" ? items.aiKey : "",
          });
        },
      );
    });
  }

  function removeLazyScriptsAndForceSrc() {
    const lazyScripts = document.querySelectorAll('script[src*="lazy"]');
    lazyScripts.forEach((script) => script.remove());

    const lazyImgs = document.querySelectorAll("img[data-src]");
    lazyImgs.forEach((img) => {
      img.removeAttribute("loading");
      img.classList.remove("lazyload", "lazy", "lazyloaded");
      if (img.dataset.src) {
        img.src = img.dataset.src;
      }
    });

    log.info("lazy removed + src forced from data-src", {
      lazyScripts: lazyScripts.length,
      lazyImgs: lazyImgs.length,
    });
  }

  function buildPipelineEvent(stage) {
    return { stage, at: new Date().toISOString() };
  }

  function buildPositionFromElement(img) {
    const rect = img.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      scroll_x: window.scrollX,
      scroll_y: window.scrollY,
    };
  }

  function getBestImgUrl(img) {
    return (
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      ""
    );
  }

  function _normUrl(u) {
    if (!u) return "";
    try {
      u = String(u);
    } catch {
      return "";
    }
    u = u.trim();
    if (!u) return "";
    try {
      const x = new URL(u, location.href);
      x.hash = "";
      return x.toString();
    } catch {
      return u.split("#")[0].split("?")[0];
    }
  }

  let __tp_lastRightClick = { img: null, ts: 0, urls: [] };
  document.addEventListener(
    "contextmenu",
    (e) => {
      const img = e?.target?.closest ? e.target.closest("img") : null;
      if (!img) return;
      __tp_lastRightClick = {
        img,
        ts: Date.now(),
        urls: [img.currentSrc, img.src].filter(Boolean).map(_normUrl),
      };
    },
    true,
  );

  function findTargetImage(original) {
    const o = _normUrl(original);

    const mdKey = mdKeyFromUrl(original);
    if (mdKey) {
      const byKey = Array.from(document.images || []).find(
        (img) => String(img.dataset.tpOriginalKey || "") === mdKey,
      );
      if (byKey) return byKey;
    }

    if (o) {
      const byData = Array.from(document.images || []).find(
        (img) => _normUrl(img.dataset.tpOriginal) === o,
      );
      if (byData) return byData;
    }

    const now = Date.now();
    if (__tp_lastRightClick.img && now - __tp_lastRightClick.ts < 8000) {
      const urls = __tp_lastRightClick.urls || [];
      if (
        !o ||
        urls.includes(o) ||
        urls.some((u) => u && o && (u.includes(o) || o.includes(u)))
      )
        return __tp_lastRightClick.img;
    }

    const imgs = Array.from(document.images || []);
    for (const img of imgs) {
      const a = _normUrl(img.currentSrc);
      const b = _normUrl(img.src);
      if (o && (a === o || b === o)) return img;
    }
    for (const img of imgs) {
      const a = _normUrl(img.currentSrc);
      const b = _normUrl(img.src);
      if (
        o &&
        (a.includes(o) || b.includes(o) || o.includes(a) || o.includes(b))
      )
        return img;
    }
    return null;
  }
  function isHttpish(u) {
    return typeof u === "string" && /^https?:/i.test(u);
  }
  function normalizeLazyImages() {
    document.querySelectorAll("img").forEach((img) => {
      const candSet =
        img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
      if (candSet && !img.srcset) img.srcset = candSet;

      const candSrc =
        img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
      if (candSrc && !img.src) img.src = candSrc;

      img.loading = "eager";
      img.decoding = "sync";
    });
  }
  function collectImagesForScan(mode, lang, sourceTag) {
    return Array.from(document.images)
      .map((img) => ({
        original_image_url: getBestImgUrl(img),
        position: buildPositionFromElement(img),
      }))
      .filter((x) => isHttpish(x.original_image_url))
      .map((base) => buildPayload(base, mode, lang, sourceTag));
  }

  const OVERLAY_STYLE_ID = "textphantom_overlay_css";
  const overlayStateByImg = new WeakMap();

  function ensureOverlayStyle(cssText) {
    if (!cssText) cssText = "";
    let styleEl = document.getElementById(OVERLAY_STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = OVERLAY_STYLE_ID;
      styleEl.type = "text/css";
      document.head.appendChild(styleEl);
    }

    const harden =
      `\n/* TextPhantom harden */\n` +
      `.tp-ol-root{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;z-index:2147483647!important;` +
      `display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;transform-origin:0 0!important;}` +
      `.tp-ol-scope{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;` +
      `display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;}` +
      `.tp-ol-scope *{box-sizing:border-box!important;pointer-events:none!important;}` +
      `.tp-ol-container{position:relative!important;display:inline-block!important;line-height:0!important;overflow:visible!important;}`;

    const next = String(cssText) + harden;
    if (styleEl.textContent !== next) styleEl.textContent = next;
  }

  function ensureImageContainer(imgElement) {
    const existing = overlayStateByImg.get(imgElement);
    if (existing?.container && existing.container.isConnected) return existing;

    const container = document.createElement("div");
    container.className = "tp-ol-container";
    container.style.position = "relative";
    container.style.display = "inline-block";
    container.style.lineHeight = "0";
    container.style.fontSize = "0";
    container.style.verticalAlign = "top";
    container.style.overflow = "visible";

    try {
      container.style.setProperty(
        "--lens-font-family",
        '"Noto Sans Thai","Noto Sans Thai UI","Noto Sans",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
      );
    } catch {}

    const parent = imgElement.parentNode;
    if (!parent) return null;
    parent.insertBefore(container, imgElement);
    container.appendChild(imgElement);

    try {
      imgElement.style.display = "block";
      imgElement.style.verticalAlign = "top";
      imgElement.style.margin = "0";
      imgElement.style.padding = "0";
    } catch {}

    const host = document.createElement("div");
    host.className = "tp-ol-root";
    host.style.position = "absolute";
    host.style.left = "0";
    host.style.top = "0";
    host.style.pointerEvents = "none";
    host.style.overflow = "visible";
    container.appendChild(host);

    const scope = document.createElement("div");
    scope.className = "tp-ol-scope";
    host.appendChild(scope);

    const state = { container, host, scope, ro: null };
    overlayStateByImg.set(imgElement, state);
    return state;
  }

  function computeScale(imgElement, baseW, baseH, preferRect = false) {
    const rect = imgElement.getBoundingClientRect();
    const cw = preferRect
      ? rect.width || 1
      : imgElement.offsetWidth ||
        imgElement.clientWidth ||
        imgElement.width ||
        rect.width ||
        1;
    const ch = preferRect
      ? rect.height || 1
      : imgElement.offsetHeight ||
        imgElement.clientHeight ||
        imgElement.height ||
        rect.height ||
        1;
    const nw =
      (Number.isFinite(baseW) && baseW > 0 ? baseW : imgElement.naturalWidth) ||
      cw ||
      1;
    const nh =
      (Number.isFinite(baseH) && baseH > 0
        ? baseH
        : imgElement.naturalHeight) ||
      ch ||
      1;
    const cs = getComputedStyle(imgElement);
    const fit = cs.objectFit || "fill";
    const transform = cs.transform || "none";
    const transformOrigin = cs.transformOrigin || "0 0";

    const parsePos = (v, pad) => {
      if (!pad) return 0;
      if (!v) return pad * 0.5;
      const s = String(v).trim();
      if (s.endsWith("%")) return (pad * parseFloat(s)) / 100;
      if (s.endsWith("px")) return Math.min(pad, Math.max(0, parseFloat(s)));
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.min(pad, Math.max(0, n)) : pad * 0.5;
    };

    const posParts = (cs.objectPosition || "50% 50%").trim().split(/\s+/);
    const posX = posParts[0];
    const posY = posParts[1] || posParts[0];

    let sx = cw / nw;
    let sy = ch / nh;
    let offX = 0;
    let offY = 0;

    if (fit !== "fill") {
      let scale = 1;
      if (fit === "contain") scale = Math.min(sx, sy);
      else if (fit === "cover") scale = Math.max(sx, sy);
      else if (fit === "scale-down") scale = Math.min(1, Math.min(sx, sy));
      else if (fit === "none") scale = 1;
      sx = scale;
      sy = scale;
      const drawnW = nw * scale;
      const drawnH = nh * scale;
      const padX = Math.max(0, cw - drawnW);
      const padY = Math.max(0, ch - drawnH);
      offX = parsePos(posX, padX);
      offY = parsePos(posY, padY);
    }

    return {
      rect,
      cw,
      ch,
      nw,
      nh,
      sx: isFinite(sx) && sx > 0 ? sx : 1,
      sy: isFinite(sy) && sy > 0 ? sy : 1,
      offX,
      offY,
      transform,
      transformOrigin,
    };
  }

  function renderAiOnlyPending(imgElement, state, label) {
    if (!state) return;
    state.scope.textContent = "";
    const badge = document.createElement("div");
    badge.textContent = label || "AI…";
    badge.style.position = "absolute";
    badge.style.left = "6px";
    badge.style.top = "6px";
    badge.style.padding = "4px 6px";
    badge.style.borderRadius = "6px";
    badge.style.background = "rgba(255,255,255,.75)";
    badge.style.color = "rgba(20,20,20,.95)";
    badge.style.fontFamily = "var(--tp-font,system-ui)";
    badge.style.fontSize = "12px";
    badge.style.lineHeight = "1.2";
    badge.style.textShadow =
      "0 0 2px rgba(255,255,255,.90),0 1px 1px rgba(0,0,0,.25)";
    state.scope.appendChild(badge);

    const update = () => {
      const { cw, ch, transform, transformOrigin } = computeScale(imgElement);
      state.host.style.width = `${cw}px`;
      state.host.style.height = `${ch}px`;
      state.scope.style.width = `${cw}px`;
      state.scope.style.height = `${ch}px`;
      state.scope.style.transform = "";
      state.scope.style.transformOrigin = "0 0";

      if (transform && transform !== "none") {
        state.host.style.transform = transform;
        state.host.style.transformOrigin = transformOrigin || "0 0";
      } else {
        state.host.style.transform = "";
        state.host.style.transformOrigin = "";
      }
    };

    update();

    if (!imgElement.complete) {
      imgElement.addEventListener("load", update, {
        once: true,
        passive: true,
      });
    }
    setTimeout(update, 50);
    setTimeout(update, 500);
    if (state.ro) {
      try {
        state.ro.disconnect();
      } catch {}
    }
    state.ro = new ResizeObserver(() => update());
    state.ro.observe(imgElement);
  }

  function applyHtmlOverlay(imgElement, result, source, isTextMode) {
    const aiHtml = result?.Ai?.aihtml || result?.ai?.aihtml || "";
    const translatedHtml =
      result?.translated?.translatedhtml || result?.translatedhtml || "";
    const originalHtml =
      result?.original?.originalhtml || result?.originalhtml || "";

    const req =
      String(source || "")
        .trim()
        .toLowerCase() || "translated";
    let chosen = "";
    if (req === "ai") {
      chosen = aiHtml ? "ai" : "";
    } else if (req === "original") {
      chosen = originalHtml
        ? "original"
        : translatedHtml
          ? "translated"
          : aiHtml
            ? "ai"
            : "";
    } else {
      chosen = translatedHtml
        ? "translated"
        : originalHtml
          ? "original"
          : aiHtml
            ? "ai"
            : "";
    }

    const html =
      chosen === "ai"
        ? aiHtml
        : chosen === "translated"
          ? translatedHtml
          : chosen === "original"
            ? originalHtml
            : "";

    const cssParts = [String(result?.htmlCss || "")];
    if (chosen === "ai")
      cssParts.push(
        String(result?.Ai?.aihtmlCss || result?.ai?.aihtmlCss || ""),
      );
    const cssText = Array.from(
      new Set(cssParts.map((s) => String(s || "").trim()).filter(Boolean)),
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

    log.debug("OVERLAY_HTML", {
      source: req,
      chosen,
      aiHtmlLen: aiHtml ? String(aiHtml).length : 0,
      translatedHtmlLen: translatedHtml ? String(translatedHtml).length : 0,
      originalHtmlLen: originalHtml ? String(originalHtml).length : 0,
      baseW,
      baseH,
    });

    ensureOverlayStyle(cssText);

    const mdKey = isMangaDexHost() ? mdGetKeyForImg(imgElement) : "";
    if (mdKey) {
      if (isTextMode && req === "ai" && !aiHtml) {
        const rec = upsertMangaDexHtmlOverlay(mdKey, imgElement, baseW, baseH, "badge");
        rec.scope.textContent = "";
        const badge = document.createElement("div");
        badge.textContent = "AI…";
        badge.style.position = "absolute";
        badge.style.left = "6px";
        badge.style.top = "6px";
        badge.style.padding = "4px 6px";
        badge.style.borderRadius = "6px";
        badge.style.background = "rgba(255,255,255,.75)";
        badge.style.color = "rgba(20,20,20,.95)";
        badge.style.fontFamily = "var(--tp-font,system-ui)";
        badge.style.fontSize = "12px";
        badge.style.lineHeight = "1.2";
        badge.style.textShadow =
          "0 0 2px rgba(255,255,255,.90),0 1px 1px rgba(0,0,0,.25)";
        rec.scope.appendChild(badge);
        scheduleMangaDexOverlayUpdate();
        if (!imgElement.complete) {
          imgElement.addEventListener("load", scheduleMangaDexOverlayUpdate, {
            once: true,
            passive: true,
          });
        }
        setTimeout(scheduleMangaDexOverlayUpdate, 50);
        return;
      }

      if (!html) {
        hideMangaDexHtmlOverlay(mdKey);
        return;
      }

      const rec = upsertMangaDexHtmlOverlay(mdKey, imgElement, baseW, baseH, "html");
      rec.scope.textContent = "";
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      while (tmp.firstChild) rec.scope.appendChild(tmp.firstChild);
      scheduleMangaDexOverlayUpdate();
      if (!imgElement.complete) {
        imgElement.addEventListener("load", scheduleMangaDexOverlayUpdate, {
          once: true,
          passive: true,
        });
      }
      setTimeout(scheduleMangaDexOverlayUpdate, 50);
      return;
    }

    const state = ensureImageContainer(imgElement);
    if (!state) return;

    if (isTextMode && req === "ai" && !aiHtml) {
      renderAiOnlyPending(imgElement, state, "AI…");
      return;
    }
    if (!html) return;

    state.scope.textContent = "";
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    while (tmp.firstChild) state.scope.appendChild(tmp.firstChild);

    const update = () => {
      const { cw, ch, nw, nh, sx, sy, offX, offY, transform, transformOrigin } =
        computeScale(imgElement, baseW, baseH);

      state.host.style.width = `${cw}px`;
      state.host.style.height = `${ch}px`;
      state.scope.style.width = `${nw}px`;
      state.scope.style.height = `${nh}px`;
      state.scope.style.transform = `translate(${offX}px, ${offY}px) scale(${sx}, ${sy})`;
      state.scope.style.transformOrigin = "0 0";

      if (transform && transform !== "none") {
        state.host.style.transform = transform;
        state.host.style.transformOrigin = transformOrigin || "0 0";
      } else {
        state.host.style.transform = "";
        state.host.style.transformOrigin = "";
      }
    };

    update();

    if (!imgElement.complete) {
      imgElement.addEventListener("load", update, {
        once: true,
        passive: true,
      });
    }
    setTimeout(update, 50);
    setTimeout(update, 500);
    if (state.ro) {
      try {
        state.ro.disconnect();
      } catch {}
    }
    state.ro = new ResizeObserver(() => update());
    state.ro.observe(imgElement);
  }

  function buildPayload(
    { original_image_url, position },
    mode,
    lang,
    menuSource = "page_scan",
    customStage,
  ) {
    const pipeline = customStage
      ? [buildPipelineEvent(customStage)]
      : [buildPipelineEvent("collected")];

    const payload = {
      mode,
      lang,
      type: "image",
      src: original_image_url || null,
      menu: menuSource,
      context: {
        page_url: location.href,
        timestamp: new Date().toISOString(),
      },
      metadata: {
        image_id: crypto.randomUUID(),
        original_image_url: original_image_url || null,
        position,
        pipeline,
        ocr_image: null,
        extra: null,
      },
    };
    log.info("Built payload", {
      src: truncate(original_image_url),
      menu: menuSource,
      mode,
      lang,
    });
    return payload;
  }

  
    function mdKeyFromUrl(u) {
    const s = _normUrl(u);
    if (!s) return "";
    try {
      const x = new URL(s, location.href);
      const parts = String(x.pathname || "").split("/").filter(Boolean);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p === "data" || p === "data-saver") {
          if (parts.length >= i + 3)
            return `md:${parts[i]}/${parts[i + 1]}/${parts[i + 2]}`;
          break;
        }
      }
      return "";
    } catch {
      return "";
    }
  }

const mdPendingByOriginal = new Map();

  function mdPendingTrim(maxSize = 80) {
    if (mdPendingByOriginal.size <= maxSize) return;
    const items = Array.from(mdPendingByOriginal.entries()).sort(
      (a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0),
    );
    const drop = Math.max(0, items.length - maxSize);
    for (let i = 0; i < drop; i++) mdPendingByOriginal.delete(items[i][0]);
  }

  function mdRememberPending(original, patch) {
    const key = mdKeyFromUrl(original) || _normUrl(original);
    if (!key) return;
    const prev = mdPendingByOriginal.get(key) || {};
    mdPendingByOriginal.set(key, { ...prev, ...(patch || {}), ts: Date.now() });
    mdPendingTrim();
  }

  function mdTakePending(key) {
    const v = mdPendingByOriginal.get(key);
    if (v) mdPendingByOriginal.delete(key);
    return v || null;
  }

  function isMangaDexHost() {
    return /(^|\.)mangadex\.org$/i.test(String(location.hostname || ""));
  }

  function getMangaDexChapterId() {
    const m = String(location.pathname || "").match(/\/chapter\/([a-f0-9-]{8,})/i);
    return m ? m[1] : "";
  }

  function getMangaDexPageIndexFromUrl() {
    const parts = String(location.pathname || "")
      .split("/")
      .filter(Boolean);
    const ci = parts.indexOf("chapter");
    if (ci >= 0 && parts.length >= ci + 3) {
      const p = parts[ci + 2];
      if (/^\d+$/.test(p)) return Math.max(0, Number(p) - 1);
    }
    try {
      const qs = new URLSearchParams(String(location.search || ""));
      const q = qs.get("page") || qs.get("p");
      if (q && /^\d+$/.test(q)) return Math.max(0, Number(q) - 1);
    } catch {}
    const hm = String(location.hash || "").match(/(?:^|[?#&])page=(\d+)/i);
    if (hm) return Math.max(0, Number(hm[1]) - 1);
    return null;
  }

  const MD_CACHE_TTL_MS = 180000;
  let mdCache = null;

  async function fetchMangaDexChapterUrls() {
    if (!isMangaDexHost()) return null;

    const chapterId = getMangaDexChapterId();
    if (!chapterId) return null;

    const now = Date.now();
    if (
      mdCache &&
      mdCache.chapterId === chapterId &&
      now - (mdCache.ts || 0) < MD_CACHE_TTL_MS &&
      Array.isArray(mdCache.urls) &&
      mdCache.urls.length
    )
      return mdCache;

    const apiUrl = `https://api.mangadex.org/at-home/server/${chapterId}`;

    try {
      const res = await fetch(apiUrl, { credentials: "omit" });
      if (!res.ok) throw new Error(`MangaDex API ${res.status}`);
      const baseInfo = await res.json();

      const baseUrl = baseInfo?.baseUrl;
      const chapter = baseInfo?.chapter;
      const hash = chapter?.hash;

      const data = Array.isArray(chapter?.data) ? chapter.data : [];
      const dataSaver = Array.isArray(chapter?.dataSaver) ? chapter.dataSaver : [];

      let path = "data";
      let files = data;
      if (!files.length && dataSaver.length) {
        path = "data-saver";
        files = dataSaver;
      }

      if (!baseUrl || !hash || !files.length)
        throw new Error("Unexpected MangaDex API shape");

      const urls = files.map((filename) => `${baseUrl}/${path}/${hash}/${filename}`);

      mdCache = { chapterId, ts: now, urls, path };
      return mdCache;
    } catch (e) {
      console.warn("[TextPhantom][content] MangaDex API error", e?.message || e);
      mdCache = { chapterId, ts: now, urls: [], path: "data" };
      return null;
    }
  }

  async function hydrateMangaDexFromCache() {
    if (!isMangaDexHost() || !__tpIsTop) return;

    const info = await fetchMangaDexChapterUrls();
    const urls = info?.urls;
    if (!Array.isArray(urls) || !urls.length) return;

    const pairs = urls
      .map((u) => ({ url: u, key: mdKeyFromUrl(u) }))
      .filter((p) => !!p.key);
    const keys = Array.from(new Set(pairs.map((p) => p.key))).slice(0, 600);
    if (!keys.length) return;

    const resp = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "TP_MD_CACHE_GET", keys },
          (r) => resolve(r || null),
        );
      } catch {
        resolve(null);
      }
    });

    const items = resp?.items || null;
    if (!items) return;

    const st = await getSettings();
    const isText = String(st.mode || "lens_text") === "lens_text";
    const source = isText ? String(st.sources || "translated") : "translated";

    for (const p of pairs) {
      const rec = items[p.key];
      if (!rec) continue;

      if (rec.newImg) {
        const applied = await replaceImageInDOM(p.url, rec.newImg);
        if (!applied) mdRememberPending(p.url, { newSrc: rec.newImg });
      }

      if (rec.result) {
        const img = findTargetImage(p.url);
        if (img) applyHtmlOverlay(img, rec.result, source, isText);
        else {
          mdRememberPending(p.url, {
            overlay: { result: rec.result, source, isTextMode: isText },
          });
        }
      }
    }
  }

  function isProbableMangaDexPageImage(img) {
    if (!img || !img.getBoundingClientRect) return false;
    const u = String(getBestImgUrl(img) || "");
    if (!u) return false;
    const rect = img.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area < 65000 && (rect.width < 260 || rect.height < 260)) return false;
    if (u.startsWith("blob:") || u.startsWith("data:")) return true;
    if (/mangadex\.network|uploads\.mangadex\.org/i.test(u)) return true;
    return false;
  }

  function getMangaDexPageImagesInDOM() {
    const imgs = Array.from(document.images || []).filter(isProbableMangaDexPageImage);
    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (ra.top !== rb.top) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    return imgs;
  }

  function inferMangaDexPageIndexForImg(img) {
    const direct =
      img?.getAttribute?.("data-page") ||
      img?.dataset?.page ||
      img?.dataset?.pageIndex ||
      "";
    if (direct && /^\d+$/.test(String(direct))) return Math.max(0, Number(direct) - 1);

    const near = img?.closest?.("[data-page]")?.getAttribute?.("data-page") || "";
    if (near && /^\d+$/.test(String(near))) return Math.max(0, Number(near) - 1);

    const alt = String(img?.getAttribute?.("alt") || img?.getAttribute?.("aria-label") || "");
    const m1 = alt.match(/(?:^|\D)(\d+)\s*\/\s*(\d+)/);
    if (m1) return Math.max(0, Number(m1[1]) - 1);
    const m2 = alt.match(/page\s*(\d+)/i);
    if (m2) return Math.max(0, Number(m2[1]) - 1);

    return null;
  }

  function mdApplyOriginalToImg(img, idx, urls) {
    if (!img || !Array.isArray(urls) || idx == null) return;
    if (idx < 0 || idx >= urls.length) return;
        const url = _normUrl(urls[idx]);
    if (!url) return;
    const key = mdKeyFromUrl(url) || url;
    if (img.dataset.tpOriginalKey !== key) img.dataset.tpOriginalKey = key;
    if (_normUrl(img.dataset.tpOriginal) !== url) img.dataset.tpOriginal = url;
    img.dataset.tpMdPage = String(idx + 1);
    const pending = mdTakePending(key);
    if (pending) {
      if (pending.newSrc) replaceImageInDOM(url, pending.newSrc).catch(() => {});
      if (pending.overlay) {
        try {
          applyHtmlOverlay(img, pending.overlay.result, pending.overlay.source, pending.overlay.isTextMode);
        } catch {}
      }
    }
  }

  async function ensureMangaDexDomMapping() {
    if (!isMangaDexHost()) return;
    const info = await fetchMangaDexChapterUrls();
    const urls = info?.urls || [];
    if (!urls.length) return;

    const imgs = getMangaDexPageImagesInDOM();
    if (!imgs.length) return;

    const explicit = new Map();
    imgs.forEach((img, pos) => {
      const idx = inferMangaDexPageIndexForImg(img);
      if (idx != null) explicit.set(img, idx);
    });

    let offset = null;
    if (explicit.size) {
      const counts = new Map();
      imgs.forEach((img, pos) => {
        const idx = explicit.get(img);
        if (idx == null) return;
        const d = idx - pos;
        counts.set(d, (counts.get(d) || 0) + 1);
      });
      let best = null;
      let bestC = 0;
      for (const [d, c] of counts.entries()) {
        if (c > bestC) {
          bestC = c;
          best = d;
        }
      }
      if (best != null) offset = best;
    } else if (imgs.length === 1) {
      offset = getMangaDexPageIndexFromUrl() || 0;
    }

    imgs.forEach((img, pos) => {
      const idx = explicit.get(img);
      if (idx != null) mdApplyOriginalToImg(img, idx, urls);
    });

    imgs.forEach((img, pos) => {
      if (explicit.has(img)) return;
      const idx = (offset != null ? pos + offset : pos);
      mdApplyOriginalToImg(img, idx, urls);
    });
  }

  let mdMappingScheduled = false;
  function scheduleMangaDexMapping() {
    if (!isMangaDexHost()) return;
    if (mdMappingScheduled) return;
    mdMappingScheduled = true;
    setTimeout(() => {
      mdMappingScheduled = false;
      ensureMangaDexDomMapping()
        .then(() => {
          if (mdOverlaysByKey.size) scheduleMangaDexOverlayUpdate();
        })
        .catch(() => {});
    }, 60);
  }

  async function resolveMangaDexOriginalForBlob(blobUrl) {
    if (!isMangaDexHost()) return null;
    if (!blobUrl?.startsWith("blob:")) return null;

    scheduleMangaDexMapping();
    const info = await fetchMangaDexChapterUrls();
    const urls = info?.urls || [];
    if (!urls.length) return null;

    const img = Array.from(document.images || []).find(
      (i) => (i.currentSrc || i.src) === blobUrl,
    );
    if (!img) return null;

    if (img.dataset.tpOriginal) return _normUrl(img.dataset.tpOriginal);

    const byAlt = inferMangaDexPageIndexForImg(img);
    if (byAlt != null) {
      mdApplyOriginalToImg(img, byAlt, urls);
      return _normUrl(img.dataset.tpOriginal);
    }

    const byUrl = getMangaDexPageIndexFromUrl();
    if (byUrl != null) {
      mdApplyOriginalToImg(img, byUrl, urls);
      return _normUrl(img.dataset.tpOriginal);
    }

    const pageImgs = getMangaDexPageImagesInDOM();
    const pos = pageImgs.indexOf(img);
    if (pos >= 0) {
      mdApplyOriginalToImg(img, pos, urls);
      return _normUrl(img.dataset.tpOriginal);
    }

    return null;
  }

  let toastEl = null;
  let toastTimer = 0;
  function showToast(text, ms = 2000) {
    if (!text) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.position = "fixed";
      toastEl.style.right = "10px";
      toastEl.style.bottom = "10px";
      toastEl.style.zIndex = 2147483647;
      toastEl.style.padding = "8px 10px";
      toastEl.style.borderRadius = "10px";
      toastEl.style.background = "rgba(0,0,0,.75)";
      toastEl.style.color = "#fff";
      toastEl.style.fontSize = "12px";
      toastEl.style.lineHeight = "1.2";
      toastEl.style.maxWidth = "68vw";
      toastEl.style.pointerEvents = "none";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = String(text);
    toastEl.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.display = "none";
    }, Math.max(800, Number(ms) || 0));
  }

  if (isMangaDexHost() && __tpIsTop) {
    scheduleMangaDexMapping();
    hydrateMangaDexFromCache().catch(() => {});
    try {
      const mo = new MutationObserver(() => scheduleMangaDexMapping());
      mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "alt", "aria-label"],
      });
      window.addEventListener("popstate", () => {
        mdCache = null;
        scheduleMangaDexMapping();
      });
      window.addEventListener("hashchange", () => {
        mdCache = null;
        scheduleMangaDexMapping();
      });

      if (!history.__tpMdPatched) {
        history.__tpMdPatched = true;
        const ps = history.pushState;
        history.pushState = function (...args) {
          const r = ps.apply(this, args);
          scheduleMangaDexMapping();
          return r;
        };
        const rs = history.replaceState;
        history.replaceState = function (...args) {
          const r = rs.apply(this, args);
          scheduleMangaDexMapping();
          return r;
        };
      }
    } catch {}
  }

  async function dataUriToBlobUrl(dataUri) {
    try {
      const res = await fetch(dataUri);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  const mdOverlaysByKey = new Map();
  const mdHtmlOverlaysByKey = new Map();
  let mdOverlayRaf = 0;

  function findMangaDexImgByKey(key) {
    if (!key) return null;
    return Array.from(document.images || []).find(
      (img) => String(img.dataset.tpOriginalKey || "") === key,
    );
  }

  function updateMangaDexOverlays() {
    if (!mdOverlaysByKey.size && !mdHtmlOverlaysByKey.size) return;
    for (const [key, rec] of mdOverlaysByKey.entries()) {
      const el = rec?.el;
      if (!el) {
        mdOverlaysByKey.delete(key);
        continue;
      }

      let img = rec.img;
      if (!img || !img.isConnected) img = findMangaDexImgByKey(key);
      if (!img) {
        el.style.display = "none";
        rec.img = null;
        continue;
      }

      const r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) {
        el.style.display = "none";
        rec.img = img;
        continue;
      }

      rec.img = img;
      el.style.display = "block";
      el.style.left = `${r.left + window.scrollX}px`;
      el.style.top = `${r.top + window.scrollY}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    }

    for (const [key, rec] of mdHtmlOverlaysByKey.entries()) {
      const host = rec?.host;
      const scope = rec?.scope;
      if (!host || !scope) {
        mdHtmlOverlaysByKey.delete(key);
        continue;
      }

      let img = rec.img;
      if (!img || !img.isConnected) img = findMangaDexImgByKey(key);
      if (!img) {
        host.style.display = "none";
        rec.img = null;
        continue;
      }

      const r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) {
        host.style.display = "none";
        rec.img = img;
        continue;
      }

      rec.img = img;
      host.style.display = "block";
      host.style.setProperty("left", `${r.left + window.scrollX}px`, "important");
      host.style.setProperty("top", `${r.top + window.scrollY}px`, "important");
      host.style.setProperty("width", `${r.width}px`, "important");
      host.style.setProperty("height", `${r.height}px`, "important");

      if (rec.kind === "badge") {
        scope.style.width = `${r.width}px`;
        scope.style.height = `${r.height}px`;
        scope.style.transform = "";
        scope.style.transformOrigin = "0 0";
        host.style.transform = "";
        host.style.transformOrigin = "";
        continue;
      }

      const { nw, nh, sx, sy, offX, offY, transform, transformOrigin } =
        computeScale(img, rec.baseW, rec.baseH, true);

      scope.style.width = `${nw}px`;
      scope.style.height = `${nh}px`;
      scope.style.transform = `translate(${offX}px, ${offY}px) scale(${sx}, ${sy})`;
      scope.style.transformOrigin = "0 0";

      if (transform && transform !== "none") {
        host.style.transform = transform;
        host.style.transformOrigin = transformOrigin || "0 0";
      } else {
        host.style.transform = "";
        host.style.transformOrigin = "";
      }
    }
  }

  function scheduleMangaDexOverlayUpdate() {
    if (mdOverlayRaf) return;
    mdOverlayRaf = requestAnimationFrame(() => {
      mdOverlayRaf = 0;
      updateMangaDexOverlays();
    });
  }

  function ensureMangaDexOverlayListeners() {
    if (window.__tpMdOverlayListeners) return;
    window.__tpMdOverlayListeners = true;
    window.addEventListener("scroll", scheduleMangaDexOverlayUpdate, {
      passive: true,
    });
    window.addEventListener("resize", scheduleMangaDexOverlayUpdate, {
      passive: true,
    });
  }

  function mdGetKeyForImg(img) {
    const k = String(img?.dataset?.tpOriginalKey || "");
    if (k) return k;
    const u = String(img?.dataset?.tpOriginal || "");
    return mdKeyFromUrl(u);
  }

  function upsertMangaDexHtmlOverlay(mdKey, img, baseW, baseH, kind) {
    let rec = mdHtmlOverlaysByKey.get(mdKey);
    if (!rec) {
      const host = document.createElement("div");
      host.className = "tp-ol-root";
      host.style.zIndex = 2147483647;
      host.style.pointerEvents = "none";
      host.style.display = "none";
      const scope = document.createElement("div");
      scope.className = "tp-ol-scope";
      host.appendChild(scope);
      document.documentElement.appendChild(host);
      rec = { host, scope, img: null, baseW: 1, baseH: 1, kind: "html" };
      mdHtmlOverlaysByKey.set(mdKey, rec);
      ensureMangaDexOverlayListeners();
    }

    rec.img = img;
    rec.baseW = Number.isFinite(baseW) && baseW > 0 ? baseW : 1;
    rec.baseH = Number.isFinite(baseH) && baseH > 0 ? baseH : 1;
    rec.kind = kind || "html";
    return rec;
  }

  function hideMangaDexHtmlOverlay(mdKey) {
    const rec = mdHtmlOverlaysByKey.get(mdKey);
    if (rec?.host) rec.host.style.display = "none";
  }

  async function replaceMangaDexImageWithOverlay(original, newSrc) {
    const mdKey = mdKeyFromUrl(original);
    if (!mdKey) return 0;

    let img = findMangaDexImgByKey(mdKey);
    if (!img) img = findTargetImage(original);
    if (!img) {
      log.warn("REPLACE_IMAGE target not found", {
        original: truncate(original),
      });
      return 0;
    }

    img.dataset.tpOriginalKey = mdKey;
    const key = _normUrl(original);
    if (key) img.dataset.tpOriginal = key;
    noteReplaceState(original, "pending");

    let rec = mdOverlaysByKey.get(mdKey);
    if (!rec) {
      const el = document.createElement("img");
      el.decoding = "sync";
      el.loading = "eager";
      el.style.position = "absolute";
      el.style.zIndex = 2147483647;
      el.style.pointerEvents = "none";
      el.style.objectFit = "contain";
      el.style.maxWidth = "none";
      el.style.maxHeight = "none";
      el.style.display = "none";
      document.documentElement.appendChild(el);
      rec = { el, img: null, blobUrl: "", original: "" };
      mdOverlaysByKey.set(mdKey, rec);
      ensureMangaDexOverlayListeners();
      el.addEventListener(
        "load",
        () => {
          const okKey = rec.original;
          if (okKey) replaceStateByOriginal.set(okKey, { state: "ok", ts: Date.now() });
        },
        { passive: true },
      );
      el.addEventListener(
        "error",
        () => {
          const errKey = rec.original;
          if (errKey) {
            replaceStateByOriginal.set(errKey, { state: "fail", ts: Date.now() });
            markImageError(errKey, "Failed to load replaced image");
          }
        },
        { passive: true },
      );
    }

    rec.img = img;
    rec.original = _normUrl(original);

    let nextSrc = newSrc;
    if (typeof newSrc === "string" && newSrc.startsWith("data:")) {
      const blobUrl = await dataUriToBlobUrl(newSrc);
      if (blobUrl) nextSrc = blobUrl;
    }

    if (rec.blobUrl && rec.blobUrl.startsWith("blob:") && rec.blobUrl !== nextSrc) {
      try {
        URL.revokeObjectURL(rec.blobUrl);
      } catch {}
    }
    rec.blobUrl =
      typeof nextSrc === "string" && nextSrc.startsWith("blob:") ? nextSrc : "";
    rec.el.src = nextSrc;

    scheduleMangaDexOverlayUpdate();
    return 1;
  }

  async function replaceImageInDOM(original, newSrc) {
    if (isMangaDexHost() && mdKeyFromUrl(original))
      return replaceMangaDexImageWithOverlay(original, newSrc);

    const img = findTargetImage(original);
    if (!img) {
      log.warn("REPLACE_IMAGE target not found", {
        original: truncate(original),
      });
      return 0;
    }

    const mdKey = mdKeyFromUrl(original);
    if (mdKey) img.dataset.tpOriginalKey = mdKey;
    const key = _normUrl(original);
    if (key) img.dataset.tpOriginal = key;
    noteReplaceState(original, "pending");

    if (!img.dataset.tpReplaceTracked) {
      img.dataset.tpReplaceTracked = "1";
      img.addEventListener(
        "load",
        () => {
          const k = _normUrl(img.dataset.tpOriginal);
          if (k) replaceStateByOriginal.set(k, { state: "ok", ts: Date.now() });
        },
        { passive: true },
      );
      img.addEventListener(
        "error",
        () => {
          const k = _normUrl(img.dataset.tpOriginal);
          if (k) {
            replaceStateByOriginal.set(k, { state: "fail", ts: Date.now() });
            markImageError(k, "Failed to load replaced image");
          }
        },
        { passive: true },
      );
    }
    const before = img.currentSrc || img.src;

    let nextSrc = newSrc;
    if (typeof newSrc === "string" && newSrc.startsWith("data:")) {
      const blobUrl = await dataUriToBlobUrl(newSrc);
      if (blobUrl) nextSrc = blobUrl;
    }

    const prevBlob = img.dataset.tpBlobUrl;
    if (prevBlob && prevBlob.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(prevBlob);
      } catch {}
      delete img.dataset.tpBlobUrl;
    }
    if (typeof nextSrc === "string" && nextSrc.startsWith("blob:")) {
      img.dataset.tpBlobUrl = nextSrc;
    }

    img.src = nextSrc;
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("data-src");
    img.removeAttribute("data-srcset");
    img.removeAttribute("loading");
    img.decoding = "sync";
    img.loading = "eager";
    log.info("REPLACE_IMAGE done", {
      before: truncate(before),
      original: truncate(original),
    });
    return 1;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResp) => {
    (async () => {
      if (msg?.type === "TP_PING") {
        sendResp({ ok: true });
        return;
      }
      if (msg?.type === "TP_TOAST") {
        showToast(msg?.text || msg?.message || "", msg?.ms || 1600);
        sendResp({ ok: true });
        return;
      }
      const { mode, lang } = await getSettings();
      try {
        log.debug("MSG", {
          type: msg?.type,
          original: truncate(msg?.original),
        });
      } catch {}
      if (
        msg?.type === "WS_STATUS_UPDATE" ||
        msg?.type === "API_STATUS_UPDATE"
      ) {
        sendResp({ ok: true });
        return;
      }

      if (msg.type === "GET_IMAGES") {
        removeLazyScriptsAndForceSrc();
        normalizeLazyImages();
        let infos = [];
        const isMangaDex = isMangaDexHost();

        if (isMangaDex) {
          showToast("TextPhantom: loading MangaDex pages…", 2600);
          scheduleMangaDexMapping();
          await ensureMangaDexDomMapping();
          const md = await fetchMangaDexChapterUrls();
          const urls = md?.urls || [];
          if (urls.length) {
            infos = urls.map((src) =>
              buildPayload(
                { original_image_url: src, position: null },
                mode,
                lang,
                "page_scan",
                "collected_mangadex_api",
              ),
            );
          } else {
            infos = collectImagesForScan(mode, lang, "page_scan");
          }
        } else {
          infos = collectImagesForScan(mode, lang, "page_scan");
        }

        log.info("GET_IMAGES", {
          returned: infos.length,
          host: location.host,
          href: location.href,
        });
        sendResp(infos);
        return;
      }

      if (msg.type === "REPLACE_IMAGE") {
        const { original, newSrc } = msg;
        log.info("REPLACE_IMAGE request", { original: truncate(original) });
        const applied = await replaceImageInDOM(original, newSrc);
        if (!applied && isMangaDexHost()) mdRememberPending(original, { newSrc });
        sendResp({ ok: true, applied: !!applied });
        return;
      }

      if (msg.type === "RESOLVE_AND_REPLACE_MANGADEX_BLOB") {
        const real = await resolveMangaDexOriginalForBlob(msg.blobUrl);
        sendResp({ resolved: real });
        return;
      }

      if (msg.type === "IMAGE_ERROR") {
        const original = msg.original;
        const message = msg.message;
        const isNoOverlay = /no overlay data/i.test(String(message || ""));
        setTimeout(() => {
          if (isNoOverlay) {
            log.warn("overlay.noData", { original: truncate(original) });
            return;
          }
          if (shouldShowReplaceError(original)) {
            markImageError(original, message);
          } else {
            log.debug("IMAGE_ERROR skipped (image replaced)", {
              original: truncate(original),
            });
          }
        }, 1200);
        sendResp({ ok: true });
        return;
      }

      if (msg.type === "OVERLAY_HTML") {
        try {
          const settings = await getSettings();
          const isText = settings.mode === "lens_text";
          const source = isText
            ? settings.sources || "translated"
            : "translated";
          const img = findTargetImage(msg.original);

          if (img) {
            applyHtmlOverlay(img, msg.result, source, isText);
            log.info("OVERLAY_HTML applied", {
              original: truncate(msg.original),
            });
          } else if (isMangaDexHost()) {
            mdRememberPending(msg.original, {
              overlay: { result: msg.result, source, isTextMode: isText },
            });
          }
        } catch (e) {
          console.warn("[LensOCR content] OVERLAY_HTML failed", e);
        }
        sendResp({ ok: true });
        return;
      }
      sendResp({ ok: true, ignored: true });
    })();
    return true;
  });
})();
