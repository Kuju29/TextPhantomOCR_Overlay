// Publisher pages receive only an extension-origin frame and public geometry.
(() => {
  // XML/SVG/PDF documents cannot host the HTML chat frame. Read Chrome APIs only inside a guarded context.
  if (window.top !== window || !['text/html','application/xhtml+xml'].includes(document.contentType)) return;
  let runtimeId, version;
  try {
    if (!globalThis.chrome?.runtime?.getURL) return;
    runtimeId = chrome.runtime.id; version = chrome.runtime.getManifest().version;
  } catch { return; }
  if (!runtimeId) return;
  if (globalThis.__tpSupportDock?.alive?.()) return;
  window.dispatchEvent(new Event('textphantom:support-dispose'));
  try { globalThis.__tpSupportDock?.dispose?.(); } catch {}
  document.getElementById('tp-support-dock')?.remove();
  const events = new AbortController();
  let disposed = false;
  const timers = [];
  let host = null, frame = null, visible = 'hidden', configured = false, hidden = false, activated = false, checkId = 0, frameReady = false, requestedView = 'minimized';
  let channel = '', layoutSent = '';
  const readyWaiters = new Set();
  function dispose() {
    if (disposed) return;
    disposed = true; checkId++; events.abort(); timers.forEach(clearInterval);
    for (const finish of readyWaiters) finish(false);
    host?.remove(); host = frame = null; channel = ''; frameReady = false;
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
  }
  function alive() {
    if (disposed) return false;
    try { if (chrome.runtime.id === runtimeId) return true; } catch {}
    dispose(); return false;
  }
  globalThis.__tpSupportDock = { alive, dispose };
  window.addEventListener('textphantom:support-dispose', dispose, { signal: events.signal });
  function request(message) {
    return new Promise(resolve => {
      if (!alive()) { resolve(); return; }
      try { chrome.runtime.sendMessage(message, result => {
        try {
          const error = chrome.runtime.lastError;
          if (!alive()) { resolve(); return; }
          if (error) { resolve(); return; }
          resolve(result);
        } catch { dispose(); resolve(); }
      }); } catch { dispose(); resolve(); }
    });
  }
  function ready() {
    if (frameReady) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timeout); readyWaiters.delete(finish); resolve(value); };
      const timeout = setTimeout(() => finish(false), 5000);
      readyWaiters.add(finish);
    });
  }
  async function command(data) {
    // A command capability is obtained inside the extension, never in a URL
    // or a publisher-visible parent event. Refresh also handles worker restart.
    const result = await request({ type: 'TP_SUPPORT_CHANNEL' });
    if (!alive()) return;
    channel = result?.channel || '';
    if ((hidden || !configured || adminPage()) && data.view !== 'hidden') return;
    if (channel && frameReady && frame?.contentWindow) {
      try { frame.contentWindow.postMessage({ ...data, channel }, origin); } catch {}
    }
  }
  let extensionUrl;
  try { extensionUrl = new URL(chrome.runtime.getURL('support/chat.html')); } catch { dispose(); return; }
  const origin = extensionUrl.protocol + '//' + extensionUrl.host;
  const adminPage = () => Boolean(document.querySelector('meta[name="textphantom-surface"][content="control-center"]'));
  // The chat opens anchored to the launcher's corner, in place of the bubble (like a
  // messenger web chat), not floating above it. Phone-sized pages get a full-screen sheet.
  // 'viewer' lets the private frame cover the page while an image is open.
  const SHEET_WIDTH = 480;
  function panelGeometry(view, downloadRoot, downloadOpen) {
    const right = downloadOpen && innerWidth >= 900 ? 420 : downloadRoot ? 84 : 18, bottom = 18;
    if (view === 'expanded' && innerWidth <= SHEET_WIDTH) return { layout: 'sheet', right: 0, bottom: 0, width: innerWidth, height: innerHeight };
    if (view === 'expanded') {
      const width = Math.max(260, Math.min(390, innerWidth - right - 12));
      return { layout: 'panel', right: Math.min(right, Math.max(0, innerWidth - width - 12)), bottom, width, height: Math.max(60, Math.min(640, innerHeight - bottom - 12)) };
    }
    if (view === 'preview') return { layout: 'panel', right, bottom, width: Math.min(320, innerWidth - right - 12), height: 140 };
    return { layout: 'panel', right, bottom, width: 60, height: 60 };
  }
  function layout(view, passive = false) {
    if (!host || !['expanded', 'minimized', 'hidden', 'preview', 'viewer'].includes(view)) return;
    if (!configured || hidden || adminPage()) view = 'hidden';
    if (view === 'viewer' && visible !== 'expanded' && visible !== 'viewer') view = visible;
    const downloadRoot = document.getElementById('tp-download-control')?.shadowRoot;
    const downloadOpen = downloadRoot?.querySelector('.download-panel:not([hidden])');
    if (view === 'expanded' && downloadOpen && innerWidth < 900) {
      if (passive) { void command({ type: 'TP_SUPPORT_VIEW', view: 'minimized' }); layout('minimized'); return; }
      downloadRoot.querySelector('.fab[aria-expanded="true"]')?.click();
    }
    visible = view;
    // The viewer keeps the expanded panel's geometry for the panel drawn inside the frame.
    const panel = panelGeometry(view === 'viewer' ? 'expanded' : view, downloadRoot, downloadOpen);
    const cover = view === 'viewer' || panel.layout === 'sheet';
    for (const [key, value] of Object.entries({ position: 'fixed', display: view === 'hidden' ? 'none' : 'block',
      top: cover ? '0' : 'auto', left: cover ? '0' : 'auto', right: cover ? '0' : panel.right + 'px', bottom: cover ? '0' : panel.bottom + 'px',
      width: cover ? '100%' : panel.width + 'px', height: cover ? '100%' : panel.height + 'px', 'max-width': '100vw', 'max-height': '100vh',
      'z-index': '2147483647', border: '0', margin: '0', padding: '0', background: 'transparent', 'pointer-events': 'auto' })) host.style.setProperty(key, value, 'important');
    // A round clip for the launcher keeps its shadow soft instead of a grey square.
    if (frame) frame.style.borderRadius = cover ? '0' : view === 'minimized' ? '50%' : '14px';
    if (view === 'expanded' || view === 'viewer') {
      const signature = JSON.stringify(panel);
      if (signature !== layoutSent && frameReady) { layoutSent = signature; void command({ type: 'TP_SUPPORT_LAYOUT', layout: panel.layout, panel }); }
    }
  }
  function mount(view = 'minimized') {
    if (!alive() || !configured || hidden || adminPage()) { if (host) layout('hidden'); return false; }
    if (!document.documentElement) return false;
    requestedView = view;
    if (!host) {
      host = document.createElement('div'); host.id = 'tp-support-dock';
      const shadow = host.attachShadow({ mode: 'closed' });
      frame = document.createElement('iframe'); frame.src = extensionUrl.href + '?dock=1';
      frame.title = 'TextPhantom · Contact admin'; frame.setAttribute('allow', '');
      frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent;border-radius:14px';
      shadow.append(frame); document.documentElement.append(host);
      frame.addEventListener('load', () => { if (frameReady) void command({ type: 'TP_SUPPORT_VIEW', view: hidden || !configured ? 'hidden' : requestedView }); }, { signal: events.signal });
    } else if (frameReady) void command({ type: 'TP_SUPPORT_VIEW', view });
    if (!host.isConnected) document.documentElement.append(host);
    layout(view); return true;
  }
  // The script start, DOMContentLoaded and its activity() re-check fire together
  // on every page load; they share one sign-in read (10493). An account/API or
  // configuration change starts a fresh one.
  let checking = null;
  function check({ fresh = false } = {}) {
    if (checking && !fresh) return checking;
    const run = checkOnce().finally(() => { if (checking === run) checking = null; });
    checking = run;
    return run;
  }
  async function checkOnce() {
    const id = ++checkId;
    const result = await request({ type: 'TP_SUPPORT_AUTH' });
    if (!alive() || id !== checkId) return;
    configured = result?.authenticated === true;
    if (!configured || adminPage() || hidden) { if (host) layout('hidden'); }
    else if (activated && visible === 'hidden') {
      const saved = await request({ type: 'TP_SUPPORT_TAB_VIEW' });
      if (id === checkId && !hidden) mount(saved?.view === 'expanded' ? 'expanded' : 'minimized');
    }
  }
  window.addEventListener('message', event => {
    if (!event.isTrusted || !frame || event.source !== frame.contentWindow || event.origin !== origin) return;
    if (event.data?.type === 'TP_SUPPORT_READY') {
      frameReady = true; layoutSent = ''; for (const finish of readyWaiters) finish(true);
      void command({ type: 'TP_SUPPORT_VIEW', view: hidden || !configured ? 'hidden' : requestedView }); return;
    }
    if (!frameReady || event.data?.type !== 'TP_SUPPORT_GEOMETRY') return;
    layout(event.data.view);
  }, { signal: events.signal });
  function onMessage(message, sender, reply) {
    if (!alive()) return false;
    if (message?.type === 'TP_SUPPORT_PING') { reply({ ready: true, version }); return false; }
    if (message?.type === 'TP_SUPPORT_OPEN') {
      (async () => { await check(); if (!alive() || !configured || adminPage()) { reply?.({ ok: false }); return; } hidden = false; activated = true; const mounted = mount('expanded'); reply?.({ ok: mounted && await ready() && alive() }); })().catch(() => reply?.({ ok: false }));
      return true;
    }
    if (message?.type === 'TP_SUPPORT_NOTICE') {
      // The private frame checks read/muted state before deciding to open.
      reply?.({ ok: !hidden && mount(visible === 'expanded' ? 'expanded' : 'minimized') });
      if (frameReady) void command({ type: 'TP_SUPPORT_REPLY' });
    }
    return false;
  }
  function onStorage(changes, area) {
    if (!alive()) return;
    if (area !== 'local') return;
    if (['paidSessionToken', 'paidApiBase', 'customApiUrl', 'apiUrlDefault'].some(key => changes[key])) {
      checkId++; configured = false; requestedView = 'minimized';
      if (host) layout('hidden');
      void check({ fresh: true });
    }
    if (changes.supportDockHidden) { hidden = changes.supportDockHidden.newValue === true; if (hidden && host) { requestedView = 'minimized'; layout('hidden'); } else if (!hidden) void check(); }
    if (changes.supportActivated) activated = changes.supportActivated.newValue === true;
    // Expansion follows this tab across navigation, without opening unrelated tabs.
    if (changes.supportConfiguration) void check({ fresh: true });
  }
  try {
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage.onChanged.addListener(onStorage);
    chrome.storage.local.get(['supportActivated', 'supportDockHidden'], saved => {
      try {
        void chrome.runtime.lastError;
        if (!alive()) return;
        activated = saved?.supportActivated === true; hidden = saved?.supportDockHidden === true; void check();
      } catch { dispose(); }
    });
  } catch { dispose(); return; }
  // Layout follows events instead of a 1 s timer -- window/visual viewport
  // resizes, and the TP download control appearing, opening or closing (it shares
  // the corner with the launcher).
  const relayout = () => { if (alive() && host && visible !== 'hidden') layout(visible, true); };
  window.addEventListener('resize', () => { if (alive()) layout(visible, true); }, { signal: events.signal });
  window.visualViewport?.addEventListener?.('resize', relayout, { signal: events.signal });
  let downloadHost = null, downloadWatch = null, downloadSize = null;
  function watchDownload() {
    const current = document.getElementById('tp-download-control');
    if (current === downloadHost) return;
    downloadWatch?.disconnect(); downloadSize?.disconnect();
    downloadHost = current; downloadWatch = downloadSize = null;
    if (!current) return;
    if (current.shadowRoot && typeof MutationObserver === 'function') {
      downloadWatch = new MutationObserver(relayout);
      downloadWatch.observe(current.shadowRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-expanded'] });
    }
    if (typeof ResizeObserver === 'function') { downloadSize = new ResizeObserver(relayout); downloadSize.observe(current); }
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    // Direct children of <html> only (where the download control mounts): cheap on busy pages.
    const pageWatch = new MutationObserver(() => { watchDownload(); relayout(); });
    pageWatch.observe(document.documentElement, { childList: true });
    events.signal.addEventListener('abort', () => { pageWatch.disconnect(); downloadWatch?.disconnect(); downloadSize?.disconnect(); });
  }
  watchDownload();
  // Focus/visibility re-check only while this page has not confirmed chat yet (e.g.
  // the first check failed offline); a confirmed dock follows storage changes.
  // Presence is the chat frame's job (expanded only).
  function activity() {
    if (alive() && activated && !configured && !hidden && !adminPage() && !document.hidden && document.hasFocus()) void check();
  }
  window.addEventListener('focus', activity, { signal: events.signal });
  document.addEventListener('visibilitychange', activity, { signal: events.signal });
  document.addEventListener('DOMContentLoaded', () => { void check(); activity(); }, { signal: events.signal });
})();
