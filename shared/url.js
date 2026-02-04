export function normalizeUrl(raw) {
  let url = (raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;

  try {
    const cleaned = url.replace(/\/+$/, "");
    const u = new URL(cleaned);
    if (u.hostname === "0.0.0.0" || u.hostname === "127.0.0.1") {
      u.hostname = "localhost";
    } else if (u.hostname === "[::1]") {
      u.hostname = "localhost";
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

export function toWs(httpBase) {
  const base = normalizeUrl(httpBase);
  if (!base) return "";
  return base.replace(/^http/i, "ws") + "/ws";
}
