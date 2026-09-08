(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const API_BASE = "https://api.mangadex.org";
  const MANIFEST_TTL_MS = 180000;
  let manifest = null;

  const isMangaDexHost = () =>
    /(^|\.)mangadex\.org$/i.test(String(location.hostname || ""));
  const getMangaDexChapterId = () =>
    (String(location.pathname || "").match(/\/chapter\/([a-f0-9-]{8,})/i) ||
      [])[1] || "";

  function mdKeyFromUrl(value) {
    const url = TP.normUrl(value);
    if (!url) return "";
    try {
      const parts = new URL(url, location.href).pathname
        .split("/")
        .filter(Boolean);
      for (let i = parts.length - 3; i >= 0; i--) {
        if (
          (parts[i] === "data" || parts[i] === "data-saver") &&
          parts[i + 1] &&
          parts[i + 2]
        ) {
          return `md:${parts[i]}/${parts[i + 1]}/${parts[i + 2]}`;
        }
      }
    } catch {}
    return "";
  }

  function getMangaDexPageIndexFromUrl() {
    const parts = String(location.pathname || "")
      .split("/")
      .filter(Boolean);
    const chapter = parts.indexOf("chapter");
    if (chapter >= 0 && /^\d+$/.test(parts[chapter + 2] || "")) {
      return Math.max(0, Number(parts[chapter + 2]) - 1);
    }
    try {
      const query = new URLSearchParams(String(location.search || ""));
      const page = query.get("page") || query.get("p");
      if (/^\d+$/.test(page || "")) return Math.max(0, Number(page) - 1);
    } catch {}
    const match = String(location.hash || "").match(/(?:^|[?#&])page=(\d+)/i);
    return match ? Math.max(0, Number(match[1]) - 1) : null;
  }

  async function getMangaDexManifest(force = false) {
    if (!isMangaDexHost()) return null;
    const chapterId = getMangaDexChapterId();
    if (!chapterId) return null;
    const now = Date.now();
    if (
      !force &&
      manifest?.chapterId === chapterId &&
      now - manifest.ts < MANIFEST_TTL_MS
    ) {
      return manifest;
    }
    try {
      const response = await fetch(`${API_BASE}/at-home/server/${chapterId}`, {
        credentials: "omit",
      });
      if (!response.ok) throw new Error(`at-home ${response.status}`);
      const json = await response.json();
      const baseUrl = json?.baseUrl;
      const hash = json?.chapter?.hash;
      const data = Array.isArray(json?.chapter?.data) ? json.chapter.data : [];
      const dataSaver = Array.isArray(json?.chapter?.dataSaver)
        ? json.chapter.dataSaver
        : [];
      if (!baseUrl || !hash || (!data.length && !dataSaver.length))
        throw new Error("unexpected at-home shape");

      const files = [];
      const byName = new Map();
      const add = (path, names) =>
        names.forEach((file, index) => {
          const record = {
            path,
            file,
            index,
            url: `${baseUrl}/${path}/${hash}/${file}`,
            key: `md:${path}/${hash}/${file}`,
          };
          files.push(record);
          byName.set(file, record);
        });
      add("data", data);
      add("data-saver", dataSaver);
      const path = data.length ? "data" : "data-saver";
      const primary = files.filter((file) => file.path === path);
      manifest = {
        chapterId,
        ts: now,
        path,
        files,
        byName,
        primary,
        urls: primary.map((file) => file.url),
      };
      TP.log.info("MangaDex manifest", {
        chapter: chapterId,
        data: data.length,
        dataSaver: dataSaver.length,
      });
      return manifest;
    } catch (error) {
      TP.log.warn("MangaDex manifest failed", error?.message || error);
      manifest = null;
      return null;
    }
  }

  function invalidateMangaDexManifest() {
    manifest = null;
  }

  function mdUrlFromKey(key) {
    const record = manifest?.files?.find(
      (file) => file.key === String(key || ""),
    );
    return record?.url || "";
  }

  const pageImages = () =>
    Array.from(document.querySelectorAll(".md--page img"));

  async function mapMangaDexDom() {
    const current = await getMangaDexManifest();
    if (!current) return 0;
    let mapped = 0;
    for (const image of pageImages()) {
      const record = current.byName.get(
        String(image.getAttribute("alt") || "").trim(),
      );
      if (!record) continue;
      image.dataset.tpOriginal = record.url;
      image.dataset.tpOriginalKey = record.key;
      image.dataset.tpMdPage = String(record.index + 1);
      mapped++;
    }
    return mapped;
  }

  Object.assign(TP, {
    isMangaDexHost,
    getMangaDexChapterId,
    getMangaDexPageIndexFromUrl,
    mdKeyFromUrl,
    getMangaDexManifest,
    invalidateMangaDexManifest,
    mdUrlFromKey,
    mapMangaDexDom,
  });
})();
