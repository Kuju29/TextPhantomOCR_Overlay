(function () {
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
    logger.info  = (...a) => _log("info",  ...a);
    logger.warn  = (...a) => _log("warn",  ...a);
    logger.error = (...a) => _log("error", ...a);
    return logger;
  }

  window.createLogger = window.createLogger || createLogger;

  window._modeRegistry = window._modeRegistry || {};
  window.registerMode = function (name, impl) {
    window._modeRegistry[name] = impl;
    console.info(`[modeRegistry][content] Registered mode: ${name}`);
  };
  window.getMode = function (name) {
    return window._modeRegistry ? window._modeRegistry[name] : undefined;
  };

  const log = window.createLogger ? window.createLogger("content_bootstrap") : console;

  function truncate(s, len=180){
    if (!s) return s;
    try { s = String(s); } catch {}
    return s.length > len ? s.slice(0,len) + "…" : s;
  }

  function markImageError(original, msg) {
    let count = 0;
    document.querySelectorAll("img").forEach((img) => {
      if (img.dataset.lensError) return;
      if (img.src === original || (original && img.src.includes(original))) {
        img.style.outline = "3px solid red";

        const badge = document.createElement("div");
        badge.textContent = "⚠️";
        badge.title = msg || "OCR error";

        const r = img.getBoundingClientRect();
        badge.style.position   = "absolute";
        badge.style.left       = `${r.left + window.scrollX + 4}px`;
        badge.style.top        = `${r.top  + window.scrollY + 4}px`;
        badge.style.background = "rgba(255,255,255,0.9)";
        badge.style.padding    = "2px 4px";
        badge.style.borderRadius = "4px";
        badge.style.zIndex       = 9999;

        document.body.appendChild(badge);
        img.dataset.lensError = "1";
        count++;
      }
    });
    log.info("markImageError", { count, original: truncate(original), message: msg });
  }

  async function getSettings() {
    return new Promise((res) => {
      chrome.storage.sync.get(["mode", "lang"], (items) => {
        res({
          mode: typeof items.mode === "string" ? items.mode : "lens_images",
          lang: typeof items.lang === "string" ? items.lang : "th"
        });
      });
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

    log.info("lazy removed + src forced from data-src", { lazyScripts: lazyScripts.length, lazyImgs: lazyImgs.length });
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
      scroll_y: window.scrollY
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
  function isHttpish(u) {
    return typeof u === "string" && /^https?:/i.test(u);
  }
  function normalizeLazyImages() {
    document.querySelectorAll("img").forEach((img) => {
      const candSet = img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
      if (candSet && !img.srcset) img.srcset = candSet;

      const candSrc = img.getAttribute("data-original") || img.getAttribute("data-lazy-src");
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

  async function fetchImageBlobViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "fetchImageBlob", url, pageUrl: location.href }, (resp) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        if (resp && resp.success) {
          const bin = atob(resp.blobData);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          resolve(new Blob([bytes], { type: resp.mimeType }));
        } else {
          reject(new Error(resp && resp.error ? resp.error : "Image blob fetch failed"));
        }
      });
    });
  }

  // ===== Image editing/overlay (unchanged) =====
  async function updateImageRemoveText(imgEl, textAnnots, blob) {
    const safe = URL.createObjectURL(blob);
    const originImg = new Image();
    originImg.crossOrigin = "anonymous";
    originImg.src = safe;
    await originImg.decode();

    const w = originImg.naturalWidth, h = originImg.naturalHeight;
    const cvs = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = cvs.getContext("2d");
    ctx.drawImage(originImg, 0, 0, w, h);

    for (const a of textAnnots) {
      const v = a.boundingPoly?.vertices;
      if (v?.length === 4) {
        const xs = v.map((p) => p.x);
        const ys = v.map((p) => p.y);

        const x0 = Math.min(...xs);
        const y0 = Math.min(...ys);
        const x1 = Math.max(...xs);
        const y1 = Math.max(...ys);
        await removeTextWithCanvas(ctx, x0, y0, x1, y1);
      }
    }

    URL.revokeObjectURL(safe);
    return cvs.toDataURL("image/png");
  }

  function removeTextWithCanvas(ctx, x0, y0, x1, y1) {
    const pad = 2;
    const left = Math.max(0, x0 - pad);
    const top  = Math.max(0, y0 - pad);
    const w    = x1 - x0 + pad * 2;
    const h    = y1 - y0 + pad * 2;
    ctx.save();
    ctx.filter = "blur(10px)";
    ctx.drawImage(ctx.canvas, left, top, w, h, left, top, w, h);
    ctx.restore();
  }

  function overlayTextOnImage(imgElement, annotationsData) {
    const isMangaDex = window.location.hostname.includes("mangadex.org");
    const annotations = annotationsData.textAnnotations || annotationsData;

    const container = document.createElement("div");
    container.classList.add("ocr-overlay-container", "ocr-visible");
    container.style.position = "relative";

    if (isMangaDex) {
      const w = imgElement.clientWidth + "px";
      container.style.display = "block";
      container.style.width = w;
      container.style.margin = "0 auto";
    } else {
      container.style.display = "inline-block";
      container.style.width = imgElement.clientWidth + "px";
      container.style.height = imgElement.clientHeight + "px";
    }

    imgElement.parentNode.insertBefore(container, imgElement);
    container.appendChild(imgElement);
    imgElement.style.display = isMangaDex ? "" : "block";

    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.pointerEvents = "none";
    container.appendChild(overlay);

    const rect = imgElement.getBoundingClientRect();
    const scaleX = rect.width / imgElement.naturalWidth;
    const scaleY = rect.height / imgElement.naturalHeight;

    (annotations || []).forEach((annotation) => {
      const textDiv = document.createElement("div");
      textDiv.style.position = "absolute";
      textDiv.style.pointerEvents = "none";
      textDiv.style.display = "table";
      textDiv.style.zIndex = "9999";

      (annotation.style || "").split(";").forEach((rule) => {
        if (!rule.trim()) return;
        const [prop, val] = rule.split(":").map((s) => s.trim());
        if (!prop || !val) return;
        switch (prop) {
          case "top":
            textDiv.style.top = parseFloat(val) * scaleY + "px";
            break;
          case "left":
            textDiv.style.left = parseFloat(val) * scaleX + "px";
            break;
          case "width":
            textDiv.style.width = parseFloat(val) * scaleX + "px";
            break;
          case "height":
            textDiv.style.height = parseFloat(val) * scaleY + "px";
            break;
          case "transform":
            textDiv.style.transform = val;
            break;
        }
      });

      const span = document.createElement("span");
      span.textContent = annotation.description;
      span.style.display = "table-cell";
      span.style.width = "100%";
      span.style.height = "100%";
      span.style.backgroundColor = "rgba(255,255,255,0.5)";
      span.style.color = "red";
      span.style.textAlign = "center";
      span.style.verticalAlign = "middle";
      span.style.whiteSpace = "pre-line";
      span.style.lineHeight = "normal";

      textDiv.appendChild(span);
      overlay.appendChild(textDiv);
    });
  }

  function buildPayload({ original_image_url, position }, mode, lang, menuSource = "page_scan", customStage) {
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
        timestamp: new Date().toISOString()
      },
      metadata: {
        image_id: crypto.randomUUID(),
        original_image_url: original_image_url || null,
        position,
        pipeline,
        ocr_image: null,
        extra: null
      }
    };
    log.info("Built payload", { src: truncate(original_image_url), menu: menuSource, mode, lang });
    return payload;
  }

  let cachedMangaDexImages = null;
  async function fetchMangaDexImages() {
    if (!location.hostname.includes("mangadex.org")) return [];
    const chapterMatch = location.pathname.match(/\/chapter\/([a-f0-9-]+)/);
    if (!chapterMatch) return [];
    if (cachedMangaDexImages) return cachedMangaDexImages;

    const chapterId = chapterMatch[1];
    const apiUrl = `https://api.mangadex.org/at-home/server/${chapterId}`;

    try {
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error(`MangaDex API ${res.status}`);
      const baseInfo = await res.json();

      const baseUrl = baseInfo.baseUrl;
      const chapter = baseInfo.chapter;
      if (!baseUrl || !chapter) throw new Error("Unexpected MangaDex API shape");

      const hash = chapter.hash;
      const images = chapter.data;
      const domImgs = Array.from(document.images);

      const imageInfos = images.map((filename, idx) => {
        const src = `${baseUrl}/data/${hash}/${filename}`;
        const imgTag = domImgs[idx];
        const position = imgTag?.getBoundingClientRect
          ? buildPositionFromElement(imgTag)
          : {
              top: 0,
              left: 0,
              width: 0,
              height: 0,
              viewport_width: window.innerWidth,
              viewport_height: window.innerHeight,
              scroll_x: window.scrollX,
              scroll_y: window.scrollY
            };
        return {
          original_image_url: src,
          position,
          pipelineStage: "collected_mangadex_api"
        };
      });

      cachedMangaDexImages = imageInfos;
      log.info("MangaDex images", { count: imageInfos.length });
      return imageInfos;
    } catch (e) {
      console.warn("[LensOCR content] MangaDex API error:", e);
      return [];
    }
  }

  async function applyMangaDexRealURLsToDOM() {
    if (!location.hostname.includes("mangadex.org")) return;
    const apiImages = await fetchMangaDexImages();
    if (!apiImages.length) return;
    const blobImgs = Array.from(document.images).filter(i => i.src.startsWith("blob:"));
    if (!blobImgs.length) return;

    blobImgs.forEach((blobImg, idx) => {
      if (idx >= apiImages.length) return;
      const realUrl = apiImages[idx].original_image_url;
      if (blobImg.src !== realUrl) {
        blobImg.src = realUrl;
        if (blobImg.srcset) blobImg.srcset = "";
        log.info("Replaced blob with real MangaDex URL", { idx, url: truncate(realUrl) });
      }
    });
  }

  async function resolveAndReplaceSingleMangaDexBlob(blobUrl) {
    if (!location.hostname.includes("mangadex.org")) return null;
    if (!blobUrl?.startsWith("blob:")) return null;

    const apiImages = await fetchMangaDexImages();
    if (!apiImages.length) return null;

    const blobImg = Array.from(document.images).find(i => i.src === blobUrl);
    if (!blobImg) return null;

    const blobImgs = Array.from(document.images).filter(i => i.src.startsWith("blob:"));
    const index = blobImgs.indexOf(blobImg);
    if (index === -1 || index >= apiImages.length) return null;

    const realUrl = apiImages[index].original_image_url;
    if (blobImg.src !== realUrl) {
      blobImg.src = realUrl;
      if (blobImg.srcset) blobImg.srcset = "";
      log.info("Resolved single MangaDex blob", { index, url: truncate(realUrl) });
    }
    return realUrl;
  }

  function replaceImageInDOM(original, newSrc) {
    let replaced = 0;
    document.querySelectorAll("img").forEach((img) => {
      if (img.src === original || (original && img.src.includes(original) && img.src !== newSrc)) {
        img.src = newSrc;
        if (img.srcset) img.srcset = "";
        replaced++;
      }
    });
    log.info("REPLACE_IMAGE done", { replaced, original: truncate(original) });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResp) => {
    (async () => {
      const { mode, lang } = await getSettings();

      if (msg.type === "GET_IMAGES") {
        removeLazyScriptsAndForceSrc();
        normalizeLazyImages();
        let infos = [];
        const isMangaDex = location.hostname.includes("mangadex.org");

        if (isMangaDex) {
          await applyMangaDexRealURLsToDOM();
          const apiImages = await fetchMangaDexImages();
          if (apiImages.length) {
            infos = apiImages.map(i => {
              const base = {
                original_image_url: i.original_image_url,
                position: i.position
              };
              return buildPayload(base, mode, lang, "page_scan", i.pipelineStage);
            });
          } else {
            infos = collectImagesForScan(mode, lang, "page_scan");
          }
        } else {
          infos = collectImagesForScan(mode, lang, "page_scan");
        }

        log.info("GET_IMAGES", { returned: infos.length, host: location.host, href: location.href });
        sendResp(infos);
        return;
      }

      if (msg.type === "REPLACE_IMAGE") {
        const { original, newSrc } = msg;
        log.info("REPLACE_IMAGE request", { original: truncate(original) });
        replaceImageInDOM(original, newSrc);
        return;
      }

      if (msg.type === "RESOLVE_MANGADEX_BLOB") {
        const real = await resolveAndReplaceSingleMangaDexBlob(msg.blobUrl);
        sendResp({ resolved: real });
        return;
      }

      if (msg.type === "RESOLVE_AND_REPLACE_MANGADEX_BLOB") {
        const real = await resolveAndReplaceSingleMangaDexBlob(msg.blobUrl);
        sendResp({ resolved: real });
        return;
      }

      if (msg.type === "IMAGE_ERROR") {
        markImageError(msg.original, msg.message);
        return;
      }

      if (msg.type === "OVERLAY_TEXT") {
        try {
          const img = Array.from(document.images)
            .find(i => i.src === msg.original || i.currentSrc === msg.original);

          const blob = await fetchImageBlobViaBackground(img.src);
          const cleaned = await updateImageRemoveText(
            img,
            msg.annotations.textAnnotations ?? msg.annotations,
            blob
          );
          img.src = cleaned;

          overlayTextOnImage(img, msg.annotations);
          log.info("OVERLAY_TEXT applied", { original: truncate(msg.original) });
        } catch (e) {
          console.warn("[LensOCR content] Failed to clean image", e);
        }
      }
    })();
    return true;
  });
})();
