// Read existing DOM/overlay records only. No translation collector, lazy-loader
// mutation, remount, OCR, AI, erase call or chapter fetch belongs in this module.
(function () {
  'use strict';
  const TP=window.__TP;
  if (!TP || TP.bail || window.top!==window) return;
  const api=TP.downloads ||= {};
  const srcOf=el=>String(el?.currentSrc || el?.src || '');
  const ownerOf=el=>el?.closest?.('[data-page],[data-tp-md-page]') || null;
  function pageOf(el) {
    const owner=ownerOf(el);
    const raw=owner?.getAttribute('data-page') ?? owner?.getAttribute('data-tp-md-page');
    return typeof raw==='string' && /^\d+$/.test(raw.trim()) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  }
  function safeUrl(value) {
    if (!value || typeof value!=='string' || !value.trim()) return '';
    try {
      const url=new URL(value,document.baseURI);
      return /^(https?:|blob:|data:|file:)$/.test(url.protocol) && !url.username && !url.password &&
        (url.protocol!=='data:' || /^data:image\//i.test(value)) ? url.href : '';
    } catch { return ''; }
  }
  function originalOf(img) {
    // Read ownership, not just a stale data-* flag on a publisher-reused IMG.
    const info=TP.downloadReplacementInfo?.(img), current=srcOf(img);
    if(info && (current===info.source || img.src===info.source))
      return info.current ? safeUrl(info.original) : '';
    if(typeof TP.downloadReplacementInfo!=='function' && img?.dataset?.tpReplaceTracked==='1')
      return safeUrl(img.dataset.tpOriginal);
    if(img?.classList?.contains('tp-md-image-overlay')) return '';
    // Preserve the already selected responsive source. Prefer a declared lazy
    // source only while src is absent/a placeholder; never force it into DOM.
    const lazy=['data-src','data-original','data-lazy-src'].map(k=>safeUrl(img?.getAttribute(k))).find(Boolean);
    if (lazy && (!current || /^data:image\//i.test(current) || img?.naturalWidth<=2)) return lazy;
    if (safeUrl(current)) return safeUrl(current);
    if (lazy) return lazy;
    const candidates=String(img?.getAttribute('data-srcset') || img?.getAttribute('srcset') || '').split(',');
    return candidates.map(s=>safeUrl(s.trim().split(/\s+/)[0])).filter(Boolean).at(-1) || '';
  }
  function visibleLines(scope) {
    return [...(scope?.querySelectorAll('.tp-line') || [])].filter(line=>{
      if (!String(line.textContent || '').replace(/\u200b/g,'').trim()) return false;
      // Ignore only intentionally hidden text layers, not viewport clipping.
      // A mounted page below the fold still has a valid exportable overlay.
      for (let node=line;node && node!==scope.parentElement;node=node.parentElement) {
        const cs=getComputedStyle(node);
        if (node.hidden || cs.display==='none' || cs.visibility==='hidden' || cs.visibility==='collapse' || Number(cs.opacity || 1)<=.001) return false;
        if (node===scope) break;
      }
      return true;
    });
  }
  function nearImage(root) {
    const imgs=[...(ownerOf(root)?.querySelectorAll('img') || [])];
    const first=imgs.find(img=>!img.closest('.tp-ol-root') && !img.matches('.tp-md-image-overlay,.tp-ol-clean-img'));
    if (first) return first;
    if (root?.nextElementSibling?.tagName==='IMG') return root.nextElementSibling;
    return null;
  }
  const compareDom=(a,b)=>{
    if (!a || !b || a===b) return 0;
    const p=a.compareDocumentPosition(b);
    if (p & Node.DOCUMENT_POSITION_DISCONNECTED) return 0;
    return p & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : p & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  };
  function scan() {
    const rows=[], byImage=new Map(), handledRoots=new Set();
    const records=[...(TP.overlayMount?.downloadSnapshot?.() || []),...(TP.downloadMangaDexSnapshot?.() || [])];
    // Snapshot API ties portalled overlays to their actual publisher element.
    const addRecord=r=>{
      if (!r.img?.isConnected) return;
      if (r.root) handledRoots.add(r.root);
      const prev=byImage.get(r.img);
      const raster=r.raster && srcOf(r.raster) && getComputedStyle(r.raster).display!=='none' ? r.raster : null;
      const text=!raster && r.kind!=='badge' && visibleLines(r.scope).length>0;
      const clean=text && r.clean && srcOf(r.clean) && getComputedStyle(r.clean).display!=='none' ? r.clean : null;
      // A raster replaces (not supplements) an old hidden text record for
      // the same publisher IMG. Never advertise raster pixels as "Text removed".
      const next=raster ? {img:r.img,root:r.root,scope:null,raster,clean:null,text:false}
        : prev?.raster ? prev : {img:r.img,root:r.root || prev?.root,scope:r.scope || prev?.scope,
          raster:null,clean:clean || prev?.clean,text:text || prev?.text || false};
      byImage.set(r.img,next);
    };
    records.forEach(addRecord);
    // Compatibility for already mounted legacy/standalone TextPhantom markup.
    // Do not resurrect records explicitly retired by the live overlay owner.
    const hasRegistry=typeof TP.overlayMount?.downloadSnapshot==='function';
    if (!hasRegistry) for (const root of document.querySelectorAll('.tp-ol-root')) {
      if (handledRoots.has(root)) continue;
      const clean=root.querySelector('.tp-ol-clean-img');
      addRecord({root,img:nearImage(root),scope:root.querySelector('.tp-ol-scope'),clean,
        raster:clean?.dataset.tpReplaceTracked==='1'?clean:null,kind:'html'});
    }
    const surfaces=new Set([...document.images,...byImage.keys()]);
    for (const img of surfaces) {
      if (img.closest('.tp-ol-root,#tp-download-control,#tp-toast,#tp-img-btn-layer') ||
          img.matches('.tp-md-image-overlay,.tp-ol-clean-img')) continue;
      const r=byImage.get(img) || {img,text:false};
      const owned=TP.downloadReplacementInfo?.(img);
      const direct=typeof TP.downloadReplacementInfo==='function'
        ? owned?.current && srcOf(img)===owned.source : img.dataset.tpReplaceTracked==='1';
      if (!r.raster && direct && srcOf(img)) {
        r.raster=img;r.text=false;r.clean=null;r.scope=null;r.root=null;
      }
      const originalCanvas=img.tagName==='CANVAS' && img.width>0 && img.height>0 ? img : null;
      const original=originalOf(img),raster=srcOf(r.raster),clean=srcOf(r.clean);
      rows.push({...r,original,originalCanvas,canvasWidth:originalCanvas?.width,canvasHeight:originalCanvas?.height,rasterUrl:raster,cleanUrl:clean,page:pageOf(img),owner:ownerOf(img),
        pageHref:location.href,pageInstanceId:TP.pageInstanceId,imageSource:srcOf(img),
        imageOriginal:img.dataset.tpOriginal || '',available:{translated:!!(raster || r.text),clean:!!(r.text&&clean),original:!!(original || originalCanvas)}});
    }
    // Numeric logical order within a reader, DOM order otherwise. Never merge
    // unrelated images merely because two owners use the same page number.
    rows.sort((a,b)=>a.page!==null && b.page!==null && a.page!==b.page ? a.page-b.page : compareDom(a.img,b.img));
    const names=new Map();
    rows.forEach((r,index)=>{
      r.index=index+1;r.number=r.page ?? r.index;
      const n=String(r.number).padStart(3,'0'),occurrence=(names.get(n)||0)+1;names.set(n,occurrence);
      r.fileNumber=n+(occurrence>1?`-${occurrence}`:'');
    });
    return rows;
  }
  function assertCurrent(row) {
    if (location.href!==row.pageHref || TP.pageInstanceId!==row.pageInstanceId) throw new Error('Page changed; refresh the image list');
    if (!row.img?.isConnected || srcOf(row.img)!==row.imageSource || (row.img.dataset.tpOriginal||'')!==row.imageOriginal || pageOf(row.img)!==row.page)
      throw new Error('Image was changed or unmounted; refresh the image list');
    if(row.originalCanvas && (row.originalCanvas.width!==row.canvasWidth || row.originalCanvas.height!==row.canvasHeight))throw new Error('Canvas dimensions changed; refresh the image list');
    if (row.root && !row.root.isConnected) throw new Error('Overlay was removed; refresh the image list');
  }
  Object.assign(api,{srcOf,safeUrl,originalOf,visibleLines,scan,assertCurrent});
})();
