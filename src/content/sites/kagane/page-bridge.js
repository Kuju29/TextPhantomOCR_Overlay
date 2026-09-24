// Kagane's own manifest + observed image route. Credentials stay in MAIN world.
// No token API calls, React internals, scrolling or guessed page identifiers.
(function () {
  if (!/(^|\.)kagane\.to$/i.test(location.hostname)) return;
  const REQUEST='TP_KAGANE_REQUEST_V1', RESPONSE='TP_KAGANE_REPLY_V1';
  const UUID='[a-f0-9-]{36}';
  const seriesOf=()=>location.pathname.match(new RegExp(`/series/(${UUID})/reader/(${UUID})(?:/|$)`,'i'))?.[1] || '';
  const chapterOf=()=>location.pathname.match(new RegExp(`/series/(${UUID})/reader/(${UUID})(?:/|$)`,'i'))?.[2] || '';
  const manifestPath=new RegExp(`^/api/v2/books/(${UUID})$`,'i');
  const imagePath=new RegExp(`^(/api/v2/books/page(?:/datasaver)?/(${UUID})/)(${UUID})\\.([a-z0-9]{1,8})$`,'i');
  const allowedHost=host=>host==='kstatic.to'||host.endsWith('.kstatic.to')||host==='kagane.to'||host.endsWith('.kagane.to');
  const nativeFetch=window.fetch;
  let chapter='', identity='', state=null, observations=[], cacheStatus='not_checked';
  const leases=new Map(), pending=new Map(), waiters=new Set();
  function sync() {
    const next=chapterOf();
    const nextIdentity=seriesOf()+':'+next;
    if(nextIdentity!==identity){identity=nextIdentity;chapter=next;state=null;observations=[];cacheStatus='not_checked';leases.clear();
      for(const controller of pending.values())controller.abort();pending.clear();}
    return next;
  }
  function matching(candidate){
    return observations.find(o=>o.chapter===chapter && o.token===candidate.token &&
      o.origin===candidate.origin && candidate.pages.some(p=>p.key===o.key && p.ext===o.ext));
  }
  function normalize(data,capturedChapter,source,expires=0){
    const raw=data?.manifest?.pages || data?.pages;
    if(!Array.isArray(raw)||!raw.length||raw.length>2000||typeof data.access_token!=='string'||!data.access_token)return null;
    const base=new URL(data.cache_url || location.origin);
    if(base.protocol!=='https:'||base.username||base.password||!allowedHost(base.hostname))return null;
    const pages=raw.map(p=>({id:String(p.page_no??p.page_number),key:p.page_id??p.page_uuid,
      ext:p.ext??p.format,width:Number(p.width)||0,height:Number(p.height)||0}));
    if(pages.some(p=>!/^\d{1,6}$/.test(p.id)||!new RegExp(`^${UUID}$`,'i').test(p.key)||!/^[a-z0-9]{1,8}$/i.test(p.ext)) ||
      new Set(pages.map(p=>p.id)).size!==pages.length || new Set(pages.map(p=>p.key)).size!==pages.length)return null;
    pages.sort((a,b)=>Number(a.id)-Number(b.id));
    if(pages.some((p,i)=>Number(p.id)!==i+1))return null;
    return {chapter:capturedChapter,pages,token:data.access_token,origin:base.origin,source,expires};
  }
  function imageObservation(url,credentials='same-origin'){
    const match=url.pathname.match(imagePath);
    return chapter && match && match[2]===chapter && url.protocol==='https:' && allowedHost(url.hostname) && url.searchParams.get('token') ?
      {chapter,origin:url.origin,prefix:match[1],key:match[3],ext:match[4],token:url.searchParams.get('token'),credentials} : null;
  }
  function recoverObservedRoutes(){
    // Handles late injection/BFCache without inventing an image endpoint.
    try{for(const entry of performance.getEntriesByType('resource').slice(-512)){
      if(!['fetch','xmlhttprequest'].includes(entry.initiatorType))continue;
      const o=imageObservation(new URL(entry.name));
      if(o && !observations.some(p=>p.origin===o.origin&&p.prefix===o.prefix&&p.key===o.key&&p.token===o.token))observations.push(o);
    }}catch{}
    if(observations.length>128)observations.splice(0,observations.length-128);
  }
  function recoverSessionManifest(){
    try{
      // Exact website-owned key and exact series/chapter only. Never scan storage.
      const raw=sessionStorage.getItem('kagane_drm_tokens');
      if(!raw){cacheStatus='missing';return;}
      if(raw.length>1024*1024){cacheStatus='too_large';return;}
      const cache=JSON.parse(raw),key=seriesOf()+':'+chapter;
      cacheStatus='no_matching_entry';
      for(const name of [key,key+'_ds']){
        const row=cache?.[name];if(!row)continue;
        if(!(Number(row.expires)>Date.now())){cacheStatus='expired';continue;}
        const candidate=normalize({access_token:row.token,cache_url:row.cacheUrl,pages:row.pages},chapter,'session_cache',Number(row.expires));
        if(!candidate){cacheStatus='invalid';continue;}
        cacheStatus='route_unmatched';
        if(matching(candidate)){state=candidate;cacheStatus='matched';return;}
      }
    }catch{cacheStatus='unreadable';}
  }
  function ready(){
    if(state?.expires && state.expires<=Date.now())state=null;
    let observed=state && matching(state);
    if(!observed){recoverObservedRoutes();recoverSessionManifest();observed=state && matching(state);}
    if(!observed)return false;
    state.prefix=observed.origin+observed.prefix;state.credentials=observed.credentials;return true;
  }
  function diagnostics(){return {manifestSource:state?.source || 'none',manifestPages:state?.pages.length || 0,
    observedImageRoutes:observations.length,sessionCache:cacheStatus};}
  function wake(){for(const notify of waiters)notify();}
  function inspectRequest(input,init) {
    try {
      const url=new URL(typeof input==='string'||input instanceof URL ? String(input) : input.url,location.href);
      const active=sync(), observed=imageObservation(url,init?.credentials || input?.credentials || 'same-origin');
      if(observed){observations.push(observed);if(observations.length>128)observations.shift();wake();}
      const manifest=url.pathname.match(manifestPath);
      return url.origin===location.origin && manifest?.[1]===active &&
        String(init?.method || input?.method || 'GET').toUpperCase()==='POST' ? active : '';
    } catch{return '';}
  }
  async function capture(response, capturedChapter) {
    try {
      if(!response.ok || Number(response.headers.get('content-length'))>1024*1024)return;
      const text=await response.clone().text();if(text.length>1024*1024)return;
      const json=JSON.parse(text), data=json.access_token?json:json.data;
      const candidate=normalize(data,capturedChapter,'network');
      if(!candidate||sync()!==capturedChapter)return;
      state=candidate;wake();
    }catch{} // Observing a response cannot break the website's request.
  }
  window.fetch=function(input,init) {
    const capturedChapter=inspectRequest(input,init);
    const promise=Reflect.apply(nativeFetch,this,arguments);
    if(capturedChapter)void promise.then(response=>capture(response,capturedChapter)).catch(()=>{});
    return promise;
  };
  function waitForSources() {
    if(ready())return Promise.resolve();
    return new Promise(resolve=>{
      const done=()=>{if(ready()){clearTimeout(timer);waiters.delete(done);resolve();}};
      const timer=setTimeout(()=>{waiters.delete(done);resolve();},2500);
      waiters.add(done);done();
    });
  }
  const sourceFor=p=>state.prefix+p.key+'.'+p.ext;
  function reply(id,body){document.dispatchEvent(new CustomEvent(RESPONSE,{detail:JSON.stringify({id,...body})}));}
  function imageMime(bytes) {
    if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
    if(bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71)return 'image/png';
    if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
    if(String.fromCharCode(...bytes.slice(0,3))==='GIF')return 'image/gif';
    return '';
  }
  document.addEventListener(REQUEST,event=>{
    let msg;try{if(typeof event.detail!=='string'||event.detail.length>8192)return;msg=JSON.parse(event.detail);}catch{return;}
    if(!new RegExp(`^${UUID}$`,'i').test(msg?.id)||!sync()||msg.chapter!==chapter)return;
    if(msg.action==='cancel'){pending.get(msg.id)?.abort();return;}
    void (async()=>{
      if(msg.action==='manifest'){
        await waitForSources();
        if(sync()!==msg.chapter)throw Error('KAGANE_CHAPTER_CHANGED');
        if(!ready())throw Error('KAGANE_MANIFEST_UNAVAILABLE: Reload this reader page, then try again.');
        const rows=state.pages.map(p=>({...p,source:sourceFor(p)}));
        const lease=crypto.randomUUID();
        if(leases.size>=8)leases.delete(leases.keys().next().value);
        leases.set(lease,{chapter,rows});
        reply(msg.id,{ok:true,chapter,lease,rows,diagnostics:diagnostics()});return;
      }
      if(msg.action!=='read')return;
      const lease=leases.get(msg.lease), row=lease?.rows.find(p=>p.id===String(msg.pageId));
      if(!row||lease.chapter!==chapter||!ready())throw Error('KAGANE_SOURCE_STALE');
      const current=state.pages.find(p=>p.id===row.id);
      if(!current||sourceFor(current)!==row.source)throw Error('KAGANE_SOURCE_CHANGED');
      const url=new URL(row.source);url.searchParams.set('token',state.token);
      const controller=new AbortController();pending.set(msg.id,controller);
      const timer=setTimeout(()=>controller.abort(),20000);
      try {
        const response=await Reflect.apply(nativeFetch,window,[url.href,{credentials:state.credentials,
          signal:controller.signal,cache:'default'}]);
        if(!response.ok)throw Error(`KAGANE_IMAGE_HTTP_${response.status}`);
        if(Number(response.headers.get('content-length'))>25*1024*1024)throw Error('KAGANE_IMAGE_TOO_LARGE');
        const bytes=new Uint8Array(await response.arrayBuffer());
        if(bytes.length<64||bytes.length>25*1024*1024)throw Error('KAGANE_IMAGE_SIZE_INVALID');
        const mime=imageMime(bytes);if(!mime)throw Error('KAGANE_IMAGE_FORMAT_UNSUPPORTED');
        if(controller.signal.aborted||sync()!==lease.chapter)throw Error('KAGANE_CHAPTER_CHANGED');
        const dataUri=await new Promise((resolve,reject)=>{const reader=new FileReader();
          reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('KAGANE_IMAGE_READ_FAILED'));
          reader.readAsDataURL(new Blob([bytes],{type:mime}));});
        if(controller.signal.aborted||sync()!==lease.chapter)throw Error('KAGANE_CHAPTER_CHANGED');
        reply(msg.id,{ok:true,dataUri});
      }finally{clearTimeout(timer);pending.delete(msg.id);}
    })().catch(error=>reply(msg.id,{ok:false,...(msg.action==='manifest'?{diagnostics:diagnostics()}:{}),error:/^KAGANE_[A-Z_0-9]+(?:: Reload this reader page, then try again\.)?$/.test(error.message)
      ? error.message : error.name==='AbortError'?'KAGANE_READ_CANCELLED':'KAGANE_READ_FAILED'}));
  });
  window.addEventListener('pagehide',()=>{for(const controller of pending.values())controller.abort();pending.clear();state=null;leases.clear();});
})();
