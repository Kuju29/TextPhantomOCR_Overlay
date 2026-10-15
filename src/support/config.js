import { getStorage, setStorage } from '../shared/storage.js';
import { configuredAccountBase } from '../paid/client.js';
import { diagnosticFetch } from '../shared/diagnostics.js';

// Only the selected API's operator configuration controls the entry point.
// Retain a successful answer during a temporary outage, scoped to that API.
// No 60 s re-read. An answer stays valid for this worker until the API
// address changes (invalidate) or a caller forces a check (popup open).
export function createSupportConfiguration({ read = getStorage, write = setStorage, fetchFn = diagnosticFetch } = {}) {
  let pending = null, checkedBase = '';
  const observed = new Map();
  async function check({ force = false } = {}) {
    const saved = await read(['customApiUrl', 'apiUrlDefault', 'supportConfiguration']);
    const base = configuredAccountBase(saved);
    const cached = saved.supportConfiguration?.base === base ? saved.supportConfiguration : null;
    if (!base) return { configured: false };
    if (!force && base === checkedBase) return { configured: observed.get(base) === true };
    if (pending?.base === base) return pending.promise;
    const promise = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetchFn(base + '/meta', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Metadata unavailable');
        const meta = await response.json();
        if (!meta || Array.isArray(meta) || meta.ok !== true) throw new Error('Metadata unavailable');
        const configured = meta?.paid?.configured === true;
        const latest = await read(['customApiUrl', 'apiUrlDefault']);
        if (configuredAccountBase(latest) !== base) return { configured: false };
        observed.set(base, configured);
        if (observed.size > 8) observed.delete(observed.keys().next().value);
        checkedBase = base;
        if (!cached || cached.configured !== configured) {
          try { await write({ supportConfiguration: { base, configured } }); } catch (_) { /* The observed server answer remains authoritative. */ }
        }
        const current = await read(['customApiUrl', 'apiUrlDefault']);
        return { configured: configuredAccountBase(current) === base && configured };
      } catch (_) {
        const latest = await read(['customApiUrl', 'apiUrlDefault']);
        return { configured: configuredAccountBase(latest) === base && (observed.has(base) ? observed.get(base) === true : cached?.configured === true) };
      }
      finally { clearTimeout(timer); if (pending?.base === base) pending = null; }
    })();
    pending = { base, promise };
    return promise;
  }
  return { check, invalidate() { checkedBase = ''; } };
}
