// Copyable, click-scoped image discovery evidence in the WEB PAGE console.
// Never print image bytes, complete URLs, signed queries, keys or OCR/AI text.
(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const sessions = new Map();
  let current = '';
  const PREFIX = '[TP_IMAGE_SCAN] ';
  const MAX_PAGES = 250;
  const blockedKeys = new Set(['url', 'src', 'href', 'payload', 'headers', 'cookie',
    'authorization', 'token', 'apiKey', 'imageDataUri', 'dataUri', 'original_image_url']);

  function clean(value, depth = 0) {
    if (depth > 5) return '[depth-limit]';
    if (typeof value === 'string') return value
      .replace(/\b(?:https?:|blob:|data:|file:)\S+/gi, '[redacted-url]')
      .replace(/\b(?:bearer|api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
        '$1=[redacted]')
      .slice(0, 500);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, MAX_PAGES).map(item => clean(item, depth + 1));
    if (!value || typeof value !== 'object') return undefined;
    return Object.fromEntries(Object.entries(value).slice(0, 70)
      .filter(([key]) => !blockedKeys.has(key))
      .map(([key, item]) => [key, clean(item, depth + 1)]));
  }
  function sourceKind(raw) {
    const value = String(raw || '');
    if (!value) return 'none';
    if (/^blob:/i.test(value)) return 'blob';
    if (/^https?:/i.test(value)) return 'http';
    if (/^data:/i.test(value)) return 'data';
    if (/^file:/i.test(value)) return 'file';
    return 'other';
  }
  function begin(id, trigger = 'context_menu') {
    if (!/^[a-f0-9-]{36}$/i.test(String(id || ''))) return false;
    if (!sessions.has(id)) {
      if (sessions.size >= 3) sessions.delete(sessions.keys().next().value);
      sessions.set(id, {seq: 0, sources: new Map(), started: Date.now()});
      setTimeout(() => {sessions.delete(id);if(current===id)current='';},10*60*1000);
      current = id;
      emit('click', {trigger, host: location.hostname, frame: window.top === window ? 'top' : 'child'}, id);
    } else current = id;
    return true;
  }
  function active() { return sessions.has(current); }
  function has(id) { return sessions.has(id); }
  function deactivate() {current='';}
  function emit(phase, detail = {}, id = current) {
    const session = sessions.get(id);
    if (!session) return;
    try {
      const row = {scanId:id, seq:++session.seq, at:new Date().toISOString(), phase, ...clean(detail)};
      console.log(PREFIX + JSON.stringify(row));
    } catch {} // Diagnostic output must not change the translation path.
  }
  function describeSource(raw, id = current) {
    const kind = sourceKind(raw), session = sessions.get(id);
    if (!session || kind === 'none') return {kind};
    const value = String(raw);
    let ref = session.sources.get(value);
    if (!ref) {ref = `S${session.sources.size + 1}`;session.sources.set(value,ref);}
    const out = {kind, ref};
    if (kind === 'http') {
      try {const url = new URL(value);out.host = url.hostname;out.hasQuery = Boolean(url.search);} catch {}
    }
    return out;
  }
  function error(error) {
    return {code:String(error?.code || error?.name || 'ERROR'), message:clean(String(error?.message || error || 'unknown'))};
  }
  function snapshot(label, id = current) {
    if (!sessions.has(id)) return;
    try {
    const plan = TP.readerClassification?.detect?.();
    if (plan) {
      const rows = plan.ids.slice(0, MAX_PAGES).map(pageId => {
        const slot = plan.slots.get(pageId);
        const img = TP.readerClassification.image(slot);
        const surface = TP.readerClassification.surface(slot);
        return {pageId,slotConnected:slot?.isConnected === true,
          target:surface?.tagName || 'NONE',mountedImage:img?.isConnected === true,
          complete:img?.complete === true,naturalWidth:img?.naturalWidth || 0,
          naturalHeight:img?.naturalHeight || 0,
          source:describeSource(TP.readerClassification.source(slot),id)};
      });
      emit('dom.snapshot', {label,route:'DYNAMIC',profile:plan.profile,selector:plan.selector,
        total:plan.ids.length,reported:rows.length,rows},id);
    } else {
      const imgs = Array.from(document.images || []);
      const kinds = {};
      for (const img of imgs) {
        const kind = sourceKind(TP.getBestImgUrl?.(img) || img.currentSrc || img.src);
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
      emit('dom.snapshot', {label,route:TP.isMangaDexHost?.() ? 'MANGADEX' : 'NORMAL',
        imageElements:imgs.length,sourceKinds:kinds},id);
    }
    } catch (cause) {emit('diagnostic_failure',{stage:'dom.snapshot',error:error(cause)},id);}
  }
  function followup(id = current) {
    if (!sessions.has(id)) return;
    const href = location.href;
    for (const delay of [3000, 10000, 30000]) setTimeout(() => {
      if (sessions.has(id) && location.href === href) snapshot(`${delay / 1000}s_after_scan`,id);
    },delay);
  }
  TP.scanDiag = {begin,active,has,deactivate,emit,snapshot,followup,sourceKind,describeSource,error};
})();
