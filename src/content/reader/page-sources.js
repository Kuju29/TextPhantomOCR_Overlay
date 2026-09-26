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
  const imageUrl = (raw, metric) => {
    if (typeof raw !== 'string' || !raw || raw.length > 8192) return '';
    try {
      const url = new URL(raw, location.href);
      if(metric) {
        const kind=url.protocol==='blob:'?'blob':/^https?:$/.test(url.protocol)?'http':
          url.protocol==='data:'?'data':'other';
        metric.fieldKinds[kind]=(metric.fieldKinds[kind]||0)+1;
      }
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
    const diagnostics=request.diagnostics===true ? {pages:[],manifestArrays:0,
      fullLengthArrays:0,fullLengthWithoutUrls:0,visited:0} : null;
    const hintedKeys=['page_no','page_number','page_id','pageId','pageNumber',
      'getPageBlobUrl','peekPageBlobUrl','blobUrl','src','url','imageUrl','manifest','pages'];
    function root(obj) {
      if (obj && typeof obj === 'object' && !seenRoots.has(obj)) { seenRoots.add(obj); roots.push(obj); }
    }
    // A slot's own component props retain its page even when the IMG child is
    // unmounted. Do not walk into sibling slots or arbitrary window objects.
    function pageSources(props, metric) {
      const urls = new Set(), flags = new Set(), seen = new WeakSet(), queue = [[props, 0, false]];
      for (let i = 0; i < queue.length && i < 100; i++) {
        const [obj, depth, imageData] = queue[i];
        if (!obj || typeof obj !== 'object' || seen.has(obj) || obj instanceof Node) continue;
        seen.add(obj);
        const imageObject = imageUrl(value(obj,'url')) || imageUrl(value(obj,'src')) ||
          imageUrl(value(obj,'imageUrl'));
        const marker = value(obj, 'scramble') ?? (imageObject ? value(obj, 's') : null);
        if (marker === true || marker === 1) flags.add('scrambled');
        if (marker === false || marker === 0) flags.add('plain');
        if(metric)for(const key of hintedKeys)if(value(obj,key)!==undefined)
          metric.hints[key]=(metric.hints[key]||0)+1;
        for (const key of imageData ? ['src', 'url', 'imageUrl', 'image_url'] : ['src', 'imageUrl', 'image_url']) {
          const url = imageUrl(value(obj, key),metric); if (url) urls.add(url);
        }
        if (depth >= 4) continue;
        for (const key of ['page', 'image', 'data', 'props', 'children']) {
          const child = value(obj, key);
          if (Array.isArray(child)) { for (const item of child.slice(0, 12)) queue.push([item, depth + 1, key === 'page' || key === 'image']); }
          else if (child && typeof child === 'object') queue.push([child, depth + 1, key === 'page' || key === 'image']);
        }
      }
      return {urls, flag: flags.size === 1 ? flags.values().next().value : null};
    }
    for (const slot of scope.querySelectorAll(`[${request.attr}]`)) {
      if (own(slot)) continue;
      const raw = slot.getAttribute(request.attr);
      const digits = request.attr === 'aria-label' ? raw?.match(/^\s*(?:page|หน้า)\s*(\d+)\s*$/i)?.[1] : raw;
      if (!/^\d+$/.test(digits || '')) continue;
      const id = String(Number(digits));
      if (!wanted.has(id)) continue;
      const candidates = new Set(), flags = new Set();
      const metric=diagnostics ? {pageId:id,props:0,fibers:0,
        fieldKinds:{},hints:{},httpCandidates:0} : null;
      for (const key of Object.getOwnPropertyNames(slot)) {
        if (key.startsWith('__reactProps$')) {
          const props = value(slot, key); root(props); propsFound++;
          if(metric)metric.props++;
          const found = pageSources(props,metric);
          for (const url of found.urls) candidates.add(url);
          if (found.flag) flags.add(found.flag);
        }
        if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactInternalInstance$')) continue;
        let fiber = value(slot, key), local = true;
        if(metric)metric.fibers++;
        for (let depth = 0; fiber && depth < 24; depth++, fiber = value(fiber, 'return')) {
          const node = value(fiber, 'stateNode');
          if (node instanceof Element && node !== slot && !slot.contains(node)) local = false;
          for (const field of ['memoizedProps', 'pendingProps', 'memoizedState']) {
            const props = value(fiber, field); root(props);
            if (local && field === 'memoizedProps') {
              propsFound++;
              if(metric)metric.props++;
              const found = pageSources(props,metric);
              for (const url of found.urls) candidates.add(url);
              if (found.flag) flags.add(found.flag);
            }
          }
        }
      }
      if(metric){metric.httpCandidates=candidates.size;diagnostics.pages.push(metric);}
      if (candidates.size === 1) rows.push({id, url: candidates.values().next().value,
        ...(flags.size === 1 ? {compositionHint:flags.values().next().value} : {})});
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
      if(diagnostics && Array.isArray(items)){
        diagnostics.manifestArrays++;
        if(items.length===request.pages.length)diagnostics.fullLengthArrays++;
      }
      if (Array.isArray(items) && items.length === request.pages.length) {
        const copied = items.map(item => {
          const url = typeof item === 'string' ? item : value(item, 'url') || value(item, 'src');
          const flag = typeof item === 'string' ? null : value(item, 'scramble') ?? value(item, 's');
          return typeof url === 'string' && url.length <= 8192 ? {url,
            ...(flag === 1 || flag === true ? {compositionHint:'scrambled'} :
              flag === 0 || flag === false ? {compositionHint:'plain'} : {})} : null;
        });
        if(diagnostics && !copied.every(Boolean))diagnostics.fullLengthWithoutUrls++;
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
    if(diagnostics)diagnostics.visited=visited;
    const reply = {id:request.id, href:location.href, rows, manifests, propsFound, visited,
      ...(diagnostics ? {diagnostics:{...diagnostics,pages:diagnostics.pages.slice(0,250)}} : {})};
    const json = JSON.stringify(reply);
    if (json.length <= 4 * 1024 * 1024) document.dispatchEvent(new CustomEvent(RESPONSE, {detail:json}));
  });
})();
