// Serialize Errors before both JSON/extension messaging and console flattening.
// Loaded as a classic content script and as a side-effect import by logger.js.
(function () {
  const sensitive = /^(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i;
  function clean(text) {
    return text.replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1<redacted>')
      .replace(/\b(?:sk-[\w-]{8,}|AIza[\w-]{12,}|hf_[\w-]{12,})/g, '<redacted>')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)=)[^&\s"']+/gi, '$1<redacted>');
  }
  function normalize(value, ancestors = new Set(), depth = 0) {
    if (typeof value === 'string') return clean(value);
    if (typeof value === 'bigint') return String(value);
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) return '[Circular]';
    if (depth > 12) return '[Max depth]';
    ancestors.add(value);
    try {
      const tag = Object.prototype.toString.call(value);
      const error = value instanceof Error || /Error\]$/.test(tag) || tag === '[object DOMException]';
      if (tag === '[object Date]') return value.toISOString();
      const out = Array.isArray(value) ? [] : {};
      const keys = error
        ? [...new Set(['name', 'message', 'code', 'stack', 'cause', 'errors', ...Object.keys(value)])]
        : Object.keys(value);
      for (const key of keys) {
        if (sensitive.test(key)) {out[key] = '<redacted>'; continue;}
        try {
          const entry = value[key];
          if (entry !== undefined) Object.defineProperty(out, key, {value:normalize(entry, ancestors, depth + 1), enumerable:true, writable:true});
        } catch {out[key] = '[Unreadable]';}
      }
      return out;
    } catch {return '[Unserialisable value]';}
    finally {ancestors.delete(value);}
  }
  globalThis.__TPLogSerialization = {normalize};
})();
