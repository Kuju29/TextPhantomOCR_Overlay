// Serialize Errors before both JSON/extension messaging and console flattening.
// Loaded as a classic content script and as a side-effect import by logger.js.
(function () {
  // Match complete field names: inputTokens and tokenCount are measurements,
  // whereas key and token fields can contain credentials or signed image IDs.
  const sensitive = /^(?:authorization|proxy-authorization|(?:x[-_])?api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|secret|client[_-]?secret|cookie|set-cookie|signature|sig|policy|x-amz-(?:security-token|credential|signature)|x-goog-(?:credential|signature))$/i;
  function redactExternalUrl(raw) {
    const punctuation = raw.match(/[)\],;.!?]+$/)?.[0] || '';
    const address = raw.slice(0, raw.length - punctuation.length);
    try {
      const url = new URL(address);
      if (/^(?:https?:|wss?:)$/.test(url.protocol) && url.hostname)
        return `${url.origin}/<redacted-path>${punctuation}`;
    } catch {} // An unparseable URL must still not expose its path or userinfo.
    return `<redacted-url>${punctuation}`; // file:// has no safe origin.
  }
  function clean(text) {
    return text
      // Handle URLs before named query assignments: arbitrary paths and query
      // names can carry secrets, including in copied Error stacks.
      .replace(/(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, redactExternalUrl)
      // Redact named assignments outside URLs while retaining surrounding
      // diagnostic text (for example an error code or stack location).
      .replace(/(^|[?&\s{,;])(["']?(?:(?:x[-_])?api[_-]?key|access[_-]?token|refresh[_-]?token|key|token|password|passwd|pwd|secret|client[_-]?secret|authorization|proxy-authorization|signature|sig|policy|x-amz-(?:security-token|credential|signature)|x-goog-(?:credential|signature))["']?\s*[=:]\s*)(?:(?:Bearer|Basic|Token)\s+)?(?:"[^"]*"|'[^']*'|[^\s&,"'<>;})]+)/gi, '$1$2<redacted>')
      .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1<redacted>')
      .replace(/\b(?:sk-[\w-]{8,}|AIza[\w-]{12,}|hf_[\w-]{12,})/g, '<redacted>');
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
