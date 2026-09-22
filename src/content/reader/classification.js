// Detection is a per-request capability check, not a global website observer.
(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const defs = [['[data-page]', 'data-page'], ['[data-page-number]', 'data-page-number'],
    ['[data-index]', 'data-index'], ['[aria-label*="page" i]', 'aria-label']];
  const own = node => !!node?.closest?.('.tp-ol-root,.tp-md-image-overlay,#tp-toast,[data-tp-image-error]');
  function number(el, attr) {
    const raw = attr === 'aria-label' ? (el.getAttribute(attr) || '').match(/^\s*(?:page|หน้า)\s*(\d+)\s*$/i)?.[1]
      : el.getAttribute(attr);
    return /^\d+$/.test(String(raw ?? '')) && Number.isSafeInteger(Number(raw)) ? String(Number(raw)) : '';
  }
  function image(slot) {
    if (slot?.matches?.('img') && !own(slot)) return slot;
    const candidates = [...(slot?.querySelectorAll?.('img') || [])]
      .filter(img => !own(img) && !TP.isTranslationOutputImage?.(img));
    return candidates.find(img => [TP.getBestImgUrl(img), img.getAttribute('data-src'),
      img.getAttribute('data-original'), img.getAttribute('data-lazy-src')].some(readable)) || candidates[0] || null;
  }
  // Discovery still reads publisher URLs from IMG/attributes. Presentation may
  // instead be a canvas in that same numbered slot (not an arbitrary page canvas).
  function surface(slot) {
    const img = image(slot);
    const canvases = [...(slot?.matches?.('canvas') ? [slot] : slot?.querySelectorAll?.('canvas') || [])]
      .filter(el => !own(el) && el.hasAttribute('width') && el.hasAttribute('height') &&
        el.width >= 140 && el.height >= 140);
    const realImage = img && [TP.getBestImgUrl(img), img.getAttribute('data-src'),
      img.getAttribute('data-original')].some(readable);
    return realImage ? img : canvases.length === 1 ? canvases[0] : img;
  }
  function readable(value) {
    if (typeof value !== 'string' || !value.trim() || /^data:image\/svg\+xml/i.test(value)) return '';
    const url = TP.normUrl(value);
    if (!/^(?:https?:|blob:|data:image\/)/i.test(url)) return '';
    try { if (/\.svg$/i.test(new URL(url).pathname)) return ''; } catch { return ''; }
    return url;
  }
  function source(slot) {
    if (!slot) return '';
    const img = image(slot);
    // A loading SVG/currentSrc must not mask the actual lazy source on its IMG.
    for (const node of img && img !== slot ? [slot, img] : [slot]) {
      for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-image', 'data-full']) {
        const url = readable(node.getAttribute?.(attr)); if (url) return url;
      }
    }
    for (const value of img ? [TP.getBestImgUrl(img), img.currentSrc, img.src] : []) {
      const url = readable(value); if (url) return url;
    }
    return '';
  }
  function ancestor(elements) {
    let root = elements[0]?.parentElement;
    while (root && !elements.every(el => root.contains(el))) root = root.parentElement;
    return root;
  }
  function detect() {
    // Existing MangaDex ownership/mapping remains authoritative.
    if (TP.isMangaDexHost?.()) return null;
    let best = null;
    for (const [selector, attr] of defs) {
      const groups = new Map();
      for (const el of document.querySelectorAll(selector)) {
        const id = number(el, attr);
        if (!id || own(el) || el.matches('button,a,input,option')) continue;
        const scope = el.parentElement?.closest('[data-reader],.rpage-main,[class*="reader" i],[id*="reader" i],main') || el.parentElement;
        if (!groups.has(scope)) groups.set(scope, []);
        groups.get(scope).push({el, id});
      }
      for (const rows of groups.values()) {
        if (rows.length < 3) continue;
        const ids = rows.map(row => Number(row.id)).sort((a,b) => a-b);
        if (new Set(ids).size !== ids.length || ids.some((id,i) => i && id !== ids[i-1] + 1)) continue;
        const slots = rows.map(row => row.el), root = ancestor(slots);
        if (!root) continue;
        const hints = `${root.id} ${root.className} ${root.parentElement?.className || ''} ${slots[0].className}`;
        const semantic = /reader|rpage|manga|comic|chapter/i.test(hints) || !!root.closest('[data-reader]');
        const missing = slots.filter(slot => !image(slot)).length;
        const virtual = /virtual|rpage-page/i.test(hints) || root.hasAttribute('data-virtual');
        const large = slots.filter(slot => {
          const img = image(slot), rect = img?.getBoundingClientRect?.();
          return img && Math.max(img.naturalWidth || 0, rect?.width || 0) >= 140 &&
            Math.max(img.naturalHeight || 0, rect?.height || 0) >= 140;
        }).length;
        if ((!missing && !virtual) || (!semantic && (attr === 'data-index' || large < 2))) continue;
        if (!best || slots.length > best.ids.length) {
          best = {type: 'DYNAMIC', profile: 'numbered-reader', selector, attr, root,
            ids: ids.map(String), slots: new Map(rows.map(row => [row.id,row.el])),
            capabilities: {logicalIdentity:true, virtualMount:true, deferredPlacement:true,
              sourceBeforeMount: slots.every(slot => !!source(slot)), acquisition:['DEFAULT','REFERER','DOM']}};
        }
      }
    }
    return best;
  }
  async function sources(plan, signal) {
    const urls = new Map();
    for (const [id, slot] of plan.slots) { const url = source(slot); if (url) urls.set(id,url); }
    const mergeSpecific = async (doc, pageWorld) => {
      const specific = await TP.comixReaderSources?.([...plan.slots.values()], source,
        {document:doc, pageWorld, signal, knownSources:urls});
      if (specific) {
        plan.profile = specific.profile;
        const previous = plan.sourceDiagnostics;
        plan.sourceDiagnostics = !pageWorld && previous ? {...specific.detail,
          bridge:previous.bridge, propsFound:previous.propsFound, propsResolved:previous.propsResolved} : specific.detail;
        for (const [id,url] of specific.urls) if (plan.slots.has(id)) urls.set(id,url);
      }
    };
    if (urls.size !== plan.ids.length) await mergeSpecific(document, true);
    // Only fetch HTML when known logical slots lack sources. Never execute its scripts.
    if (urls.size !== plan.ids.length && /^https?:/.test(location.href)) {
      try {
        const response = await fetch(location.href, {credentials:'include', cache:'no-store', signal});
        if (response.ok) {
          const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
          for (const slot of doc.querySelectorAll(plan.selector)) {
            const id = number(slot, plan.attr), url = source(slot);
            if (plan.slots.has(id) && !urls.has(id) && url) urls.set(id,url);
          }
          if (urls.size !== plan.ids.length) await mergeSpecific(doc, false);
        }
      } catch (error) { if (signal?.aborted) throw error; TP.log.info('reader manifest HTML unavailable', {profile:plan.profile}); }
    }
    return urls;
  }
  TP.readerClassification = {detect, sources, number, image, surface, source, own};
})();
