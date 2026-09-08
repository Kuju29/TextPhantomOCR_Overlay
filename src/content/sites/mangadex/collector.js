(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const MAX_INLINE_BYTES = 48 * 1024 * 1024;
  const pageImages = () =>
    Array.from(document.querySelectorAll(".md--page img"));

  async function imageDataUri(record, image) {
    try {
      const response = await fetch(record.url, {
        credentials: "omit",
        cache: "force-cache",
      });
      if (response.ok) {
        const blob = await response.blob();
        if (blob.size >= 64) return (await TP.blobToDataUri(blob)) || "";
      }
    } catch {}
    return image ? TP.getImageDataUriFromElement(image).catch(() => "") : "";
  }

  async function collectMangaDexPages(mode, lang) {
    const manifest = await TP.getMangaDexManifest();
    if (!manifest) return [];
    await TP.mapMangaDexDom();
    const domByKey = new Map();
    for (const image of pageImages()) {
      const key = String(image.dataset.tpOriginalKey || "");
      if (key && !domByKey.has(key)) domByKey.set(key, image);
    }
    const paths = new Set(
      [...domByKey.keys()].map((key) => key.replace(/^md:/, "").split("/")[0]),
    );
    const records =
      paths.size === 1
        ? manifest.files.filter((file) => file.path === [...paths][0])
        : manifest.primary;
    const output = [];
    let bytes = 0;
    for (const record of records) {
      const image = domByKey.get(record.key) || null;
      const dataUri =
        bytes < MAX_INLINE_BYTES ? await imageDataUri(record, image) : "";
      bytes += dataUri.length;
      const payload = TP.buildPayload(
        {
          original_image_url: record.url,
          position: image ? TP.buildPositionFromElement(image) : null,
          imageDataUri: dataUri || null,
          naturalSize: image
            ? {
                width: Number(image.naturalWidth) || 0,
                height: Number(image.naturalHeight) || 0,
              }
            : null,
          generation:
            image && TP.generationFor ? TP.generationFor(image) : null,
        },
        mode,
        lang,
        "page_scan",
        "collected_mangadex_adapter",
      );
      if (payload) output.push(payload);
    }
    TP.log.info("MangaDex collect", {
      pages: output.length,
      withBytes: output.filter((item) => item.imageDataUri).length,
    });
    return output;
  }

  TP.collectMangaDexPages = collectMangaDexPages;
})();
