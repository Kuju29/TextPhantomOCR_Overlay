// Function-level tracing for the page context, relayed to the service worker's trace file.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const MAX_STR = 200;
  const MAX_ITEMS = 12;
  const SECRET_HINTS = [
    "api_key",
    "apikey",
    "key",
    "token",
    "secret",
    "password",
    "cookie",
    "auth",
    "source",
    "translation",
    "prompt",
    "text",
    "image",
    "url",
    "original",
    "authorization",
  ];
  const SAFE_STRING_FIELDS = new Set([
    "event",
    "ev",
    "type",
    "outcome",
    "mode",
    "state",
    "stage",
    "errorType",
    "code",
    "route",
    "provider",
    "model",
    "fn",
    "file",
  ]);

  let enabled = false;
  let detail = "off";
  let currentTrace = "";
  let lineNo = 0;
  let visibilityEpoch = 0;
  const producerId = (() => {
    try {
      return String(
        globalThis.crypto?.randomUUID?.() ||
          `page-${Date.now()}-${Math.random()}`,
      );
    } catch {
      return `page-${Date.now()}-${Math.random()}`;
    }
  })();

  const isSecret = (name) => {
    const low = String(name).toLowerCase();
    if (["sourcefingerprint", "imageid", "imagekey"].includes(low))
      return false;
    return SECRET_HINTS.some((h) => low.includes(h));
  };

  // Reduces a value to a small, redacted form safe to write into a trace line.
  function shorten(value, depth = 0, fieldName = "") {
    if (value?.schema === "tp.audit/1" && globalThis.TPAuditSchema) return globalThis.TPAuditSchema.sanitize(value);
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === "boolean") return value;
    if (t === "number")
      return Number.isFinite(value)
        ? Math.round(value * 1e4) / 1e4
        : String(value);
    if (t === "string") {
      if (!SAFE_STRING_FIELDS.has(String(fieldName)))
        return `<redacted-string:${value.length}>`;
      const safe = value.replace(
        /\b(https?:\/\/[^/?#\s]+)[^\s]*/gi,
        "$1/<redacted>",
      );
      return safe.length <= MAX_STR
        ? safe
        : `${safe.slice(0, MAX_STR)}…(+${safe.length - MAX_STR})`;
    }
    if (t === "function") return `<fn ${value.name || "anon"}>`;
    if (depth >= 3) return `<${t}>`;
    if (value instanceof Element) {
      return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>`;
    }
    if (Array.isArray(value)) {
      const head = value
        .slice(0, MAX_ITEMS)
        .map((v) => shorten(v, depth + 1, fieldName));
      if (value.length > MAX_ITEMS)
        head.push(`…+${value.length - MAX_ITEMS} more`);
      return head;
    }
    if (t === "object") {
      const out = {};
      let n = 0;
      for (const [k, v] of Object.entries(value)) {
        if (n >= MAX_ITEMS) {
          out["…"] = `+${Object.keys(value).length - MAX_ITEMS} more keys`;
          break;
        }
        out[k] = isSecret(k) ? "<redacted>" : shorten(v, depth + 1, k);
        n++;
      }
      return out;
    }
    return String(value);
  }

  // Hands one trace line to the service worker, which writes it to the trace file.
  function relay(record) {
    try {
      chrome.runtime.sendMessage(
        { type: "TP_TRACE", record },
        () => void chrome.runtime.lastError,
      );
    } catch {}
  }

  // Emits one trace line for the current trace id.
  function line(file, fn, ev, data, traceOverride = undefined) {
    if (!enabled) return;
    try {
      relay({
        t: Date.now(),
        n: ++lineNo,
        trace: traceOverride === undefined ? currentTrace : String(traceOverride || ""),
        side: "page",
        producerId,
        file,
        fn,
        ev,
        ...(data === undefined ? {} : { d: shorten(data) }),
      });
    } catch {}
  }

  // Returns a wrapper that traces a function's arguments, result and duration.
  function wrapFn(fn, file, name) {
    if (typeof fn !== "function" || fn.__tpTraced) return fn;

    let params = [];
    try {
      const src = Function.prototype.toString.call(fn);
      const open = src.indexOf("(");
      const close = src.indexOf(")", open);
      if (open >= 0 && close > open) {
        params = src
          .slice(open + 1, close)
          .split(",")
          .map((p) => p.trim().split(/[=\s]/)[0])
          .filter((p) => p && /^[A-Za-z_$][\w$]*$/.test(p));
      }
    } catch {
      params = [];
    }

    const label = name || fn.name || "anon";

    function traced(...args) {
      if (!enabled) return fn.apply(this, args);
      const given = {};
      args.forEach((v, i) => {
        given[params[i] || `arg${i}`] = v;
      });
      line(file, label, "->", given);
      const t0 = Date.now();
      let out;
      try {
        out = fn.apply(this, args);
      } catch (e) {
        line(file, label, "!!", {
          error: e?.message || String(e),
          ms: Date.now() - t0,
        });
        throw e;
      }
      if (out && typeof out.then === "function") {
        return out.then(
          (v) => {
            line(file, label, "<-", {
              ret: v,
              ms: Date.now() - t0,
              async: true,
            });
            return v;
          },
          (e) => {
            line(file, label, "!!", {
              error: e?.message || String(e),
              ms: Date.now() - t0,
              async: true,
            });
            throw e;
          },
        );
      }
      line(file, label, "<-", { ret: out, ms: Date.now() - t0 });
      return out;
    }
    traced.__tpTraced = true;
    return traced;
  }

  const SKIP = new Set([
    "readerCurrent", "findReaderTarget", "readerOriginalFor", "readerImageForKey",
    "readerOwnsRun", "noteReaderAppliedSource",
    "updateImageStatus",
    "clearImageStatuses",
    "targetInstanceFor",
    "noteAppliedImageSource",
    "imageStatusHeight",
    "repositionImageError",
    "log",
    "traceNote",
    "traceNoteFor",
    "setTrace",
    "getTrace",
    "getVisibilityEpoch",
    "installTrace",
    "setTracingEnabled",
    "isTracing",
    "normUrl",
    "truncate",
    "isTop",
    "emitViewerEvent",
    "scheduleMangaDexOverlayUpdate",
    "updateMangaDexOverlays",
    "getBestImgUrl",
    "mdKeyFromUrl",
    "generationFor",
    "buildPositionFromElement",
    "buildPipelineEvent",
  ]);

  // Wraps every function on TP for tracing and returns how many were wrapped.
  function installTrace() {
    let count = 0;
    for (const key of Object.keys(TP)) {
      if (SKIP.has(key)) continue;
      const value = TP[key];
      if (typeof value !== "function" || value.__tpTraced) continue;
      try {
        TP[key] = wrapFn(value, "content/*", key);
        count++;
      } catch {}
    }
    return count;
  }

  TP.installTrace = installTrace;
  TP.traceNote = (file, fn, data) => line(file, fn, "..", data);
  // Async overlay inserts can run concurrently; bind diagnostics to the message
  // trace explicitly instead of whichever insert most recently touched the
  // page-global currentTrace.
  TP.traceNoteFor = (traceId, file, fn, data) => line(file, fn, "..", data, traceId);
  TP.setTrace = (id) => {
    const previous = currentTrace;
    currentTrace = String(id || "");
    return previous;
  };
  TP.getTrace = () => currentTrace;
  function recordVisibility(reason = "changed") {
    if (!enabled || typeof document === "undefined") return;
    if (reason === "changed") visibilityEpoch++;
    // Page producer + sender tab/frame identify this document without logging a URL.
    line("content/trace.js", "pageVisibility", "..", {
      schema: "tp.audit/1", event: "page_visibility", reason,
      hidden: document.visibilityState === "hidden", observedAt: Date.now(),
      visibilityChanges: visibilityEpoch,
    }, "");
  }
  const onVisibilityChange = () => recordVisibility();
  TP.getVisibilityEpoch = () => visibilityEpoch;
  TP.setTracingEnabled = (on, traceDetail = "compact") => {
    const wasEnabled = enabled;
    enabled = Boolean(on);
    if (enabled !== wasEnabled && typeof document !== "undefined") {
      if (enabled) {
        document.addEventListener?.("visibilitychange", onVisibilityChange);
        recordVisibility("initial");
      } else document.removeEventListener?.("visibilitychange", onVisibilityChange);
    }
    detail =
      enabled && traceDetail === "full" ? "full" : enabled ? "compact" : "off";
  };
  TP.isTracing = () => enabled;
  TP.getTraceDetail = () => detail;
})();
