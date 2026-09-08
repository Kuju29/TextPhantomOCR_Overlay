(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const urls = new WeakMap();

  function release(record) {
    const url = urls.get(record);
    if (!url) return;
    urls.delete(record);
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }

  function layer(record) {
    if (record?.cleanImg?.isConnected) return record.cleanImg;
    if (!record?.host) return null;
    const image = document.createElement("img");
    image.className = "tp-ol-clean-img";
    image.decoding = "sync";
    image.loading = "eager";
    Object.assign(image.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      maxWidth: "none",
      maxHeight: "none",
      objectFit: "contain",
      objectPosition: "center center",
      display: "none",
    });
    record.host.insertBefore(image, record.host.firstChild);
    record.cleanImg = image;
    return image;
  }

  function update(record, sourceImage, source) {
    const image = layer(record);
    if (!image || !sourceImage) return;
    if (!source) {
      image.style.display = "none";
      return;
    }
    try {
      const style = getComputedStyle(sourceImage);
      if (style?.objectFit) image.style.objectFit = style.objectFit;
      if (style?.objectPosition)
        image.style.objectPosition = style.objectPosition;
    } catch {}
    if (image.src !== source) image.src = source;
    image.style.display = "block";
  }

  async function prepare(image, result) {
    if (!TP.buildErasedBackground)
      throw new Error("local background builder is unavailable");
    const built = await TP.buildErasedBackground(
      image,
      result?.eraseBoxes,
      result?.sourceImageDataUri,
      result?.lensDocument,
    );
    if (built) return built;
    TP.markImageError?.(
      TP.getBestImgUrl(image),
      "Could not erase the original text — showing the translation over it",
    );
    throw new Error("could not erase the original text");
  }

  async function apply(record, image, result, prepared = null, canApply = () => true) {
    const built = prepared || (await prepare(image, result));
    if (!record?.host?.isConnected || !canApply()) {
      try {
        URL.revokeObjectURL(built.url);
      } catch {}
      return false;
    }
    release(record);
    urls.set(record, built.url);
    update(record, image, built.url);
    return true;
  }

  TP.overlayBackground = {
    apply,
    layer,
    prepare,
    release,
    update,
    wants: (result) =>
      String(result?.backgroundMode || "") === "boxes" &&
      Boolean(result?.eraseBoxes),
  };
  TP.dataUriToBlobUrl = async (dataUri) => {
    try {
      const blob = await (await fetch(dataUri)).blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  };
})();
