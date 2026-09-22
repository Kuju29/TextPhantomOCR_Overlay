// Comix source discovery only. Reader identity, processing and placement remain
// in the generic pipeline. Prefer actual chapter data over the v14 URL pattern.
(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const REQUEST = 'TP_COMIX_READER_SOURCES_V1', RESPONSE = 'TP_COMIX_READER_SOURCES_REPLY_V1';
  const chapterId = () => location.pathname.match(/\/(\d+)-chapter(?:-|\/|$)/)?.[1] || '';
  const http = raw => {
    if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw) || raw.length > 8192) return '';
    try {
      const url = new URL(raw); url.hash = '';
      return !url.username && !url.password && !/\.svg$/i.test(url.pathname) ? url.href : '';
    } catch { return ''; }
  };
  const sameImage = (a,b) => {
    try { const x=new URL(a), y=new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch { return false; }
  };
  function inlineManifests(doc) {
    const raw = doc?.querySelector?.('script#initial-data')?.textContent;
    if (!raw || raw.length > 8 * 1024 * 1024) return [];
    let data;
    try { data=JSON.parse(raw); } catch { return []; }
    const out=[], seen=new WeakSet(), queue=[[data,0,'']];
    for(let i=0;i<queue.length && i<4000;i++) {
      const [obj,depth,hint]=queue[i];
      if(!obj || typeof obj!=='object' || seen.has(obj))continue;
      seen.add(obj);
      const pages=obj.pages, items=Array.isArray(pages) ? pages : pages?.items;
      if(Array.isArray(items)) out.push({chapterId:String(obj.id || obj.chapterId || obj.chapter_id || hint || ''),
        baseUrl:pages?.baseUrl || obj.baseUrl || '',items});
      if(depth>=10)continue;
      if(Array.isArray(obj)){for(const item of obj.slice(0,2000))queue.push([item,depth+1,hint]);}
      else for(const [key,item] of Object.entries(obj)) {
        // Query keys can carry the chapter id even when the result omits it.
        const expected=chapterId();
        const keyHint=expected && /chapter/i.test(key) && new RegExp(`(?:^|[^0-9])${expected}(?:[^0-9]|$)`).test(key) ? expected : hint;
        if(item && typeof item==='object')queue.push([item,depth+1,keyHint]);
      }
    }
    return out;
  }
  function validatedManifest(candidate, ids, known) {
    if(!candidate || !Array.isArray(candidate.items) || candidate.items.length!==ids.length ||
      ids.some((id,i)=>Number(id)!==i+1))return null;
    const expected=chapterId(), claimed=String(candidate.chapterId || '');
    if(expected && claimed && claimed!==expected)return null;
    let base=String(candidate.baseUrl || ''), matches=0;
    if(base){try{base=new URL(base,location.href).href.replace(/\/$/,'')+'/';}catch{return null;}}
    const urls=new Map();
    for(let i=0;i<ids.length;i++){
      const item=candidate.items[i], raw=typeof item==='string' ? item : item?.url || item?.src;
      if(typeof raw!=='string' || !raw || raw.length>8192)return null;
      // Relative items in a Comix pages list are relative to pages.baseUrl.
      let url;
      try { url=http(/^https?:\/\//i.test(raw) ? raw : base ? new URL(raw.replace(/^\//,''),base).href : ''); } catch { return null; }
      if(!url)return null;
      const mounted=http(known.get(ids[i]));
      if(mounted){if(!sameImage(mounted,url))return null;matches++;}
      urls.set(ids[i],known.get(ids[i]) || url);
    }
    // Never bind a stale SPA manifest to this chapter using count alone.
    return matches || (expected && claimed===expected) ? urls : null;
  }
  function readPageWorld(ids, signal) {
    if(signal?.aborted)return Promise.reject(signal.reason || new DOMException('Reader cancelled','AbortError'));
    return new Promise((resolve,reject)=>{
      const id=crypto.randomUUID(), href=location.href;
      const cleanup=()=>{clearTimeout(timer);document.removeEventListener(RESPONSE,reply);signal?.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();reject(signal.reason || new DOMException('Reader cancelled','AbortError'));};
      const reply=event=>{
        if(typeof event.detail!=='string' || event.detail.length>4*1024*1024)return;
        let data;try{data=JSON.parse(event.detail);}catch{return;}
        if(data?.id!==id || data.href!==href)return;
        cleanup();resolve(data);
      };
      // An installed bridge replies synchronously. The timeout only protects a
      // pre-update tab or unsupported MAIN world, not a polling/waiting loop.
      const timer=setTimeout(()=>{cleanup();resolve({rows:[],manifests:[],reason:'bridge_unavailable'});},250);
      document.addEventListener(RESPONSE,reply);signal?.addEventListener('abort',abort,{once:true});
      document.dispatchEvent(new CustomEvent(REQUEST,{detail:JSON.stringify({id,href,pages:ids})}));
    });
  }
  function legacyUrls(ids, known, detail) {
    const code=page=>btoa(String.fromCharCode(((Math.floor(page/100)%10)<<4)|2,
      (((Math.floor(page/10)%10)^2)<<4)|5,(((page%10)^5)<<4)|12));
    const mounted=[...known].map(([id,url])=>({id:Number(id),url:http(url)})).filter(p=>p.url && p.id>=1 && p.id<=999);
    if(!mounted.length){detail.legacy='no_seed';return null;}
    const seed=mounted[0], sample=new URL(seed.url),offset=sample.pathname.lastIndexOf(code(seed.id));
    if(offset<0){detail.legacy='seed_token_missing';return null;}
    const derive=id=>{const url=new URL(seed.url);url.pathname=url.pathname.slice(0,offset)+code(id)+url.pathname.slice(offset+4);
      url.search=id%4===0 && id%20!==0?'?8':'';url.hash='';return url.href;};
    if(mounted.some(p=>derive(p.id)!==p.url)){detail.legacy='mounted_url_mismatch';return null;}
    if(ids.some(id=>Number(id)<1 || Number(id)>999)){detail.legacy='page_range';return null;}
    detail.legacy='matched';return new Map(ids.map(id=>[id,derive(Number(id))]));
  }
  TP.comixReaderSources = async (slots, sourceFor, options={}) => {
    if(!/(^|\.)comix\.to$/i.test(location.hostname) || !slots.length ||
      !slots.every(el=>el.matches('.rpage-page[data-page]')))return null;
    const ids=slots.map(el=>String(Number(el.dataset.page))).sort((a,b)=>Number(a)-Number(b));
    const known=new Map(options.knownSources || []);
    for(const slot of slots){const url=sourceFor(slot);if(url)known.set(String(Number(slot.dataset.page)),url);}
    const detail={inline:'not_found',bridge:'not_needed',legacy:'not_needed'};
    const finish=(profile,urls)=>({profile,urls,detail});
    const accept=candidates=>{
      if(!Array.isArray(candidates))return null;
      const valid=candidates.map(c=>validatedManifest(c,ids,known)).filter(Boolean);
      if(!valid.length)return null;
      // More than one manifest is fine only when all point to identical pages.
      const first=valid[0];
      return valid.every(map=>ids.every(id=>map.get(id)===first.get(id))) ? first : null;
    };
    const inline=inlineManifests(options.document || document);
    const initial=accept(inline);
    if(initial){detail.inline='matched';return finish('comix-manifest',initial);}
    if(inline.length)detail.inline='rejected';
    if(known.size===ids.length)return finish('comix-dom',known);
    if(options.pageWorld!==false){
      const response=await readPageWorld(ids,options.signal);
      detail.bridge=response.reason || 'no_manifest';
      detail.propsFound=Number(response.propsFound)||0;
      const actual=accept(response.manifests);
      if(actual){detail.bridge='manifest_matched';return finish('comix-page-data',actual);}
      if(Array.isArray(response.rows) && response.rows.length<=ids.length){
        const wanted=new Set(ids), rows=new Map(), conflicts=new Set();
        for(const row of response.rows){
          const id=String(row?.id),url=http(row?.url);
          if(!wanted.has(id)||!url)continue;
          if(rows.has(id)&&rows.get(id)!==url)conflicts.add(id);
          rows.set(id,url);
        }
        for(const [id,url] of rows)if(!conflicts.has(id)&&!known.has(id))known.set(id,url);
        detail.propsResolved=rows.size-conflicts.size;
        if(known.size===ids.length){detail.bridge='slots_matched';return finish('comix-page-props',known);}
      }
    }
    // Retain the proven v14 layout only as a validated compatibility fallback.
    const legacy=legacyUrls(ids,known,detail);
    return finish(legacy?'comix-source-v14':'comix-source-unresolved',legacy || known);
  };
})();
