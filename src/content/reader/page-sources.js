// Read-only, on-demand bridge for page-owned reader component data. No network calls,
// hooks, scrolling, or extension APIs run in MAIN. Only image-source data leaves it.
(function () {
  const REQUEST = 'TP_READER_SOURCES_V1', RESPONSE = 'TP_READER_SOURCES_REPLY_V1';
  const PROBE = 'data-tp-reader-source-probe';
  const ATTRS = new Set(['data-page','data-page-number','data-index','aria-label']);
  const own = node => !!node?.closest?.('.tp-ol-root,.tp-md-image-overlay,#tp-toast,[data-tp-image-error]');
  const value = (obj, key) => {
    if (!obj || typeof obj !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(obj, key)?.value; } catch { return undefined; }
  };
  const imageUrl = raw => {
    if (typeof raw !== 'string' || !raw || raw.length > 8192) return '';
    try {
      const url = new URL(raw, location.href);
      return /^https?:$/.test(url.protocol) && !/\.svg$/i.test(url.pathname) && url.href !== location.href ? url.href : '';
    } catch { return ''; }
  };
  document.addEventListener(REQUEST, event => {
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (request?.href !== location.href || typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id) ||
        !ATTRS.has(request.attr) ||
        !Array.isArray(request.pages) || !request.pages.length || request.pages.length > 2000 ||
        request.pages.some(id => typeof id !== 'string' || !/^\d{1,6}$/.test(id))) return;
    // Resolve only the detected reader root tagged for this single request.
    const scope = document.querySelector(`[${PROBE}="${request.id}"]`);
    if (!scope || own(scope)) return;
    const wanted = new Set(request.pages), rows = [], manifests = [], roots = [], seenRoots = new WeakSet();
    let visited = 0, propsFound = 0;
    function root(obj) {
      if (obj && typeof obj === 'object' && !seenRoots.has(obj)) { seenRoots.add(obj); roots.push(obj); }
    }
    // A slot's own component props retain its page even when the IMG child is
    // unmounted. Do not walk into sibling slots or arbitrary window objects.
    function pageSources(props) {
      const urls = new Set(), seen = new WeakSet(), queue = [[props, 0, false]];
      for (let i = 0; i < queue.length && i < 100; i++) {
        const [obj, depth, imageData] = queue[i];
        if (!obj || typeof obj !== 'object' || seen.has(obj) || obj instanceof Node) continue;
        seen.add(obj);
        for (const key of imageData ? ['src', 'url', 'imageUrl', 'image_url'] : ['src', 'imageUrl', 'image_url']) {
          const url = imageUrl(value(obj, key)); if (url) urls.add(url);
        }
        if (depth >= 4) continue;
        for (const key of ['page', 'image', 'data', 'props', 'children']) {
          const child = value(obj, key);
          if (Array.isArray(child)) { for (const item of child.slice(0, 12)) queue.push([item, depth + 1, key === 'page' || key === 'image']); }
          else if (child && typeof child === 'object') queue.push([child, depth + 1, key === 'page' || key === 'image']);
        }
      }
      return urls;
    }
    for (const slot of scope.querySelectorAll(`[${request.attr}]`)) {
      if (own(slot)) continue;
      const raw = slot.getAttribute(request.attr);
      const digits = request.attr === 'aria-label' ? raw?.match(/^\s*(?:page|หน้า)\s*(\d+)\s*$/i)?.[1] : raw;
      if (!/^\d+$/.test(digits || '')) continue;
      const id = String(Number(digits));
      if (!wanted.has(id)) continue;
      const candidates = new Set();
      for (const key of Object.getOwnPropertyNames(slot)) {
        if (key.startsWith('__reactProps$')) {
          const props = value(slot, key); root(props); propsFound++;
          for (const url of pageSources(props)) candidates.add(url);
        }
        if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactInternalInstance$')) continue;
        let fiber = value(slot, key), local = true;
        for (let depth = 0; fiber && depth < 24; depth++, fiber = value(fiber, 'return')) {
          const node = value(fiber, 'stateNode');
          if (node instanceof Element && node !== slot && !slot.contains(node)) local = false;
          for (const field of ['memoizedProps', 'pendingProps', 'memoizedState']) {
            const props = value(fiber, field); root(props);
            if (local && field === 'memoizedProps') {
              propsFound++;
              for (const url of pageSources(props)) candidates.add(url);
            }
          }
        }
      }
      if (candidates.size === 1) rows.push({id, url: candidates.values().next().value});
    }
    // Read only bounded data/props branches. Full chapter manifests take priority
    // in the isolated-world validator; unrelated query/previous-chapter data is
    // never accepted just because its array happens to have the same length.
    const seen = new WeakSet(), queue = roots.map(obj => [obj, 0]);
    for (let i = 0; i < queue.length && visited < 6000 && manifests.length < 12; i++) {
      const [obj, depth] = queue[i];
      if (!obj || typeof obj !== 'object' || seen.has(obj) || obj instanceof Node) continue;
      seen.add(obj); visited++;
      const pages = value(obj, 'pages') || value(obj, 'images');
      const items = Array.isArray(pages) ? pages : value(pages, 'items');
      if (Array.isArray(items) && items.length === request.pages.length) {
        const copied = items.map(item => {
          const url = typeof item === 'string' ? item : value(item, 'url') || value(item, 'src');
          return typeof url === 'string' && url.length <= 8192 ? {url} : null;
        });
        if (copied.every(Boolean)) manifests.push({chapterId:String(value(obj, 'chapterId') || value(obj, 'chapter_id') || value(obj, 'id') || ''),
          baseUrl:String(value(pages, 'baseUrl') || value(obj, 'baseUrl') || ''), items:copied});
      }
      if (depth >= 12) continue;
      if (Array.isArray(obj)) {
        for (const item of obj.slice(0, 2000)) { if (queue.length >= 6000) break; queue.push([item, depth + 1]); }
      } else {
        for (const key of ['props', 'children', 'data', 'result', 'chapter', 'pages', 'images', 'items', 'state', 'value', 'memoizedState', 'next', 'baseState', 'dehydratedState', 'queries']) {
          const child = value(obj, key); if (child && typeof child === 'object' && queue.length < 6000) queue.push([child, depth + 1]);
        }
      }
    }
    const reply = {id:request.id, href:location.href, rows, manifests, propsFound, visited};
    const json = JSON.stringify(reply);
    if (json.length <= 4 * 1024 * 1024) document.dispatchEvent(new CustomEvent(RESPONSE, {detail:json}));
  });
})();
