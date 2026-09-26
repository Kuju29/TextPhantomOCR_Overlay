// On-demand, host-independent reader source discovery. Network acquisition and
// placement are separate: never guess image URLs from an encoded page number.
(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const REQUEST = 'TP_READER_SOURCES_V1', RESPONSE = 'TP_READER_SOURCES_REPLY_V1';
  const PROBE = 'data-tp-reader-source-probe';
  const http = raw => {
    if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw) || raw.length > 8192) return '';
    try {
      const url = new URL(TP.alphaManga?.keyedUrl(raw) || TP.mangaMirai?.keyedUrl(raw) ||
        TP.kManga?.keyedUrl(raw) || raw);
      const host=location.hostname.toLowerCase();
      const mangaKey=/^(?:www\.)?mangago\.(?:me|zone)$/.test(host) &&
        /^#desckey=(?:\d{1,3}a){3,399}\d{1,3}&cols=(?:[2-9]|1\d|20)$/.test(url.hash);
      const kKey=host==='kmanga.kodansha.com' &&
        /^#[a-z0-9]{1,100}:\d{1,12}:\d{1,12}$/.test(url.hash);
      const alphaKey=/^(?:www\.)?alpha-manga\.com$/.test(host) &&
        /^#key=(?:[0-9a-f]{16}){1,400}$/i.test(url.hash);
      const miraiKey=/^(?:www\.)?mangamirai\.com$/.test(host) &&
        /^#tp-mirai=[A-Za-z0-9+/]{8,4096}={0,2}$/.test(url.hash);
      if(!mangaKey&&!kKey&&!alphaKey&&!miraiKey)url.hash = '';
      return !url.username && !url.password && !/\.svg$/i.test(url.pathname) ? url.href : '';
    } catch { return ''; }
  };
  const sameImage = (a,b) => {
    return http(a) === http(b); // Query parameters can identify different pages.
  };
  function inlineManifests(doc) {
    // Parse data, not executable JavaScript. Bounded to the user's discovery
    // request; no observers, fetch interception or background page scanning.
    const out = [], roots = [];
    let bytes = 0;
    for (const script of doc?.querySelectorAll?.('script[type="application/json"],script[type="application/ld+json"],script#__NEXT_DATA__,script#initial-data') || []) {
      const raw = script.textContent || '';
      if (!raw || raw.length > 8 * 1024 * 1024) continue;
      bytes += raw.length;
      if (bytes > 8 * 1024 * 1024 || roots.length >= 24) break;
      try { roots.push(JSON.parse(raw)); } catch {}
    }
    const seen = new WeakSet(), queue = roots.map(obj => [obj, 0]);
    for (let i = 0; i < queue.length && i < 4000; i++) {
      const [obj, depth] = queue[i];
      if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
      seen.add(obj);
      for (const key of ['pages', 'images']) {
        const pages = obj[key], items = Array.isArray(pages) ? pages : pages?.items;
        if (Array.isArray(items)) out.push({
          chapterId: String(obj.chapterId || obj.chapter_id || obj.id || ''),
          baseUrl: pages?.baseUrl || obj.baseUrl || '', items,
        });
      }
      if (depth >= 10) continue;
      const children = Array.isArray(obj) ? obj.slice(0, 2000) : Object.values(obj);
      for (const child of children) {
        if (queue.length >= 4000) break;
        if (child && typeof child === 'object') queue.push([child, depth + 1]);
      }
    }
    return out;
  }
  function validatedManifest(candidate, ids, known, plan, record = null) {
    const reject = reason => {record?.(reason);return null;};
    if(!candidate || !Array.isArray(candidate.items) || candidate.items.length!==ids.length ||
      ids.some((id,i)=>i && Number(id)!==Number(ids[i-1])+1))return reject('missing_or_wrong_page_count');
    const chapter = plan.root?.closest?.('[data-chapter-id]');
    const expected=chapter?.getAttribute('data-chapter-id') || '', claimed=String(candidate.chapterId || '');
    if(expected && claimed && claimed!==expected)return reject('chapter_identity_mismatch');
    let base=String(candidate.baseUrl || ''), matches=0;
    if(base){try{base=new URL(base,location.href).href.replace(/\/$/,'')+'/';}catch{return reject('invalid_base_url');}}
    const urls=new Map(), compositionHints=new Map();
    for(let i=0;i<ids.length;i++){
      const item=candidate.items[i], raw=typeof item==='string' ? item : item?.url || item?.src;
      if(typeof raw!=='string' || !raw || raw.length>8192)return reject('page_without_url_or_src');
      // Resolve relative paths by URL rules; preserve queries, signed URLs and // hosts.
      let url;
      try { url=http(/^https?:\/\//i.test(raw) ? raw : new URL(raw,base || location.href).href); } catch { return reject('invalid_page_url'); }
      if(!url)return reject('page_url_not_http_or_svg');
      const mounted=http(known.get(ids[i]));
      if(mounted){if(!sameImage(mounted,url))return reject('mounted_http_mismatch');matches++;}
      urls.set(ids[i],known.get(ids[i]) || url);
      const hint=item?.compositionHint ||
        (item?.s === 1 || item?.scramble === true ? 'scrambled' :
          item?.s === 0 || item?.scramble === false ? 'plain' : '');
      if(hint === 'scrambled' || hint === 'plain') compositionHints.set(ids[i],hint);
    }
    // Never bind a stale SPA manifest to this chapter using count alone.
    if (!matches && !(expected && claimed===expected)) return reject('no_http_anchor_or_chapter_identity');
    record?.('accepted');
    return {urls,compositionHints};
  }
  function readPageWorld(plan, ids, signal) {
    if(signal?.aborted)return Promise.reject(signal.reason || new DOMException('Reader cancelled','AbortError'));
    return new Promise((resolve,reject)=>{
      const startedAt=Date.now();
      const id=crypto.randomUUID(), href=location.href, root=plan.root;
      if (!root?.isConnected) return resolve({reason:'reader_scope_unavailable'});
      root.setAttribute(PROBE,id);
      const cleanup=()=>{if(root.getAttribute(PROBE)===id)root.removeAttribute(PROBE);clearTimeout(timer);document.removeEventListener(RESPONSE,reply);signal?.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();reject(signal.reason || new DOMException('Reader cancelled','AbortError'));};
      const reply=event=>{
        if(typeof event.detail!=='string' || event.detail.length>4*1024*1024)return;
        let data;try{data=JSON.parse(event.detail);}catch{return;}
        if(data?.id!==id || data.href!==href)return;
        cleanup();resolve({...data,elapsedMs:Date.now()-startedAt});
      };
      // An installed bridge replies synchronously. The timeout only protects a
      // pre-update tab or unsupported MAIN world, not a polling/waiting loop.
      const timer=setTimeout(()=>{cleanup();resolve({rows:[],manifests:[],reason:'bridge_unavailable',
        elapsedMs:Date.now()-startedAt});},250);
      document.addEventListener(RESPONSE,reply);signal?.addEventListener('abort',abort,{once:true});
      document.dispatchEvent(new CustomEvent(REQUEST,{detail:JSON.stringify({id,href,pages:ids,
        attr:plan.attr,diagnostics:TP.scanDiag?.active()===true})}));
    });
  }
  TP.readerSources = async (plan, sourceFor, options={}) => {
    const slots = [...plan.slots.values()], ids = plan.ids;
    if (!slots.length || !ids?.length) return null;
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('Reader cancelled','AbortError');
    const known = new Map([...(options.knownSources || [])].map(([id,url])=>[id,http(url)||url]));
    for (const [id, slot] of plan.slots) {
      const url = sourceFor(slot); if (url) known.set(id,http(url)||url);
    }
    if (TP.scanDiag?.active()) TP.scanDiag.emit('reader.dom_sources', {logicalPages:ids.length,known:known.size,
      sources:[...known].slice(0,250).map(([id,url])=>({pageId:id,source:TP.scanDiag.describeSource(url)}))});
    const detail={inline:'not_found',bridge:'not_needed'};
    const finish=(profile,urls,compositionHints=new Map())=>({profile,urls,compositionHints,detail});
    const mayNeedFlags=/^(?:www\.)?comix\.to$/i.test(location.hostname);
    const mergeMatchingHints=(accepted,rows)=>{
      const matching=new Map();
      for(const row of Array.isArray(rows) ? rows : []){
        const id=String(row?.id),hint=row?.compositionHint;
        if((hint!=='scrambled'&&hint!=='plain') ||
          !accepted.urls.has(id) || !sameImage(accepted.urls.get(id),row?.url))continue;
        if(!matching.has(id))matching.set(id,new Set());
        matching.get(id).add(hint);
      }
      for(const [id,hints] of matching){
        if(hints.size===1 && !accepted.compositionHints.has(id))
          accepted.compositionHints.set(id,hints.values().next().value);
      }
      return accepted;
    };
    const accept=(candidates,stage)=>{
      if(!Array.isArray(candidates))return null;
      const outcomes=[];
      const valid=candidates.map(c=>validatedManifest(c,ids,known,plan,
        TP.scanDiag?.active() ? reason=>outcomes.push(reason) : null)).filter(Boolean);
      if(TP.scanDiag?.active()) TP.scanDiag.emit('reader.manifest_check',{
        stage,candidates:candidates.length,accepted:valid.length,outcomes,
        hasChapterIdentity:Boolean(plan.root?.closest?.('[data-chapter-id]')),
        mountedHttpAnchors:[...known.values()].filter(url=>Boolean(http(url))).length,
      });
      if(!valid.length)return null;
      // More than one manifest is fine only when all point to identical pages.
      const first=valid[0];
      const consistent=valid.every(found=>ids.every(id=>found.urls.get(id)===first.urls.get(id)));
      if(!consistent)TP.scanDiag?.emit('reader.manifest_conflict',{stage,accepted:valid.length});
      if(!consistent)return null;
      const compositionHints=new Map();
      for(const id of ids){
        const hint=first.compositionHints.get(id);
        if(hint && valid.every(found=>found.compositionHints.get(id)===hint))compositionHints.set(id,hint);
      }
      return {urls:first.urls,compositionHints};
    };
    const inline=inlineManifests(options.document || document);
    const initial=accept(inline,options.pageWorld===false?'fetched_html':'inline');
    if(initial){
      detail.inline='matched';
      if(!mayNeedFlags || initial.compositionHints.size===ids.length || options.pageWorld===false)
        return finish('reader-manifest',initial.urls,initial.compositionHints);
    }else if(inline.length)detail.inline='rejected';
    if(known.size===ids.length && !mayNeedFlags)return finish('reader-dom',known);
    if(options.pageWorld!==false){
      const response=await readPageWorld(plan,ids,options.signal);
      TP.scanDiag?.emit('reader.page_world', {reason:response.reason || 'no_manifest',
        propsFound:Number(response.propsFound)||0,rows:response.rows?.length || 0,
        manifests:response.manifests?.length || 0,elapsedMs:response.elapsedMs || 0,
        diagnostics:response.diagnostics || null});
      detail.bridge=response.reason || 'no_manifest';
      detail.propsFound=Number(response.propsFound)||0;
      if(initial){
        const merged=mergeMatchingHints(initial,response.rows);
        return finish('reader-manifest',merged.urls,merged.compositionHints);
      }
      const actual=accept(response.manifests,'page_world');
      if(actual){detail.bridge='manifest_matched';
        const merged=mergeMatchingHints(actual,response.rows);
        return finish('reader-page-data',merged.urls,merged.compositionHints);}
      if(Array.isArray(response.rows) && response.rows.length<=ids.length){
        const wanted=new Set(ids), rows=new Map(), conflicts=new Set(), hints=new Map();
        for(const row of response.rows){
          const id=String(row?.id),url=http(row?.url);
          if(!wanted.has(id)||!url)continue;
          if(rows.has(id)&&rows.get(id)!==url)conflicts.add(id);
          rows.set(id,url);
          if(row.compositionHint==='scrambled'||row.compositionHint==='plain')hints.set(id,row.compositionHint);
        }
        for(const [id,url] of rows)if(!conflicts.has(id)&&!known.has(id))known.set(id,url);
        detail.propsResolved=rows.size-conflicts.size;
        if (TP.scanDiag?.active()) TP.scanDiag.emit('reader.page_world_rows',{acceptedRows:rows.size-conflicts.size,
          conflicts:[...conflicts],httpSources:[...rows].map(([id,url])=>({pageId:id,
            source:TP.scanDiag.describeSource(url)}))});
        if(known.size===ids.length){detail.bridge='slots_matched';
          for(const id of conflicts)hints.delete(id);
          return finish('reader-page-props',known,hints);}
      }
    }
    if(known.size===ids.length)return finish('reader-dom',known);
    // Missing sources remain explicit: transport fallbacks cannot invent them.
    return finish('reader-source-unresolved',known);
  };
})();
