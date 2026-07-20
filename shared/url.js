/**
 * URL helpers for the API base address.
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 */

/**
 * Normalise a user-typed API URL:
 * - prepends `http://` when no scheme is present,
 * - strips trailing slashes,
 * - rewrites loopback hosts (`0.0.0.0`, `127.0.0.1`, `[::1]`) to `localhost`.
 * @param {string} raw
 * @returns {string} normalised URL, or "" when input is empty
 */
export function normalizeUrl(raw) {
  let url = (raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;

  try {
    const u = new URL(url.replace(/\/+$/, ""));
    if (u.hostname === "0.0.0.0" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") {
      u.hostname = "localhost";
    }
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/**
 * Turn an HTTP(S) base into the matching WebSocket `/ws` endpoint.
 * @param {string} httpBase
 * @returns {string}
 */
export function toWebSocketUrl(httpBase) {
  const base = normalizeUrl(httpBase);
  if (!base) return "";
  return base.replace(/^http/i, "ws") + "/ws";
}

/** Join an API base with a path (base must already be normalised). */
export function apiUrl(base, path) {
  return String(base || "").replace(/\/+$/, "") + path;
}
