// Logical identity comes from chapter + manifest page number, never CSS classes.
(function () {
  const TP=window.__TP;if(!TP||TP.bail)return;
  const route=()=>/(^|\.)kagane\.to$/i.test(location.hostname) ?
    location.pathname.match(/\/series\/([a-f0-9-]{36})\/reader\/([a-f0-9-]{36})(?:\/|$)/i) : null;
  function request(action,chapter,detail={},signal) {
    if(signal?.aborted)return Promise.reject(new DOMException('Reader cancelled','AbortError'));
    return new Promise((resolve,reject)=>{
      const id=crypto.randomUUID();
      const send=action=>document.dispatchEvent(new CustomEvent('TP_KAGANE_REQUEST_V1',{
        detail:JSON.stringify({id,chapter,action,...detail})}));
      const cleanup=()=>{clearTimeout(timer);document.removeEventListener('TP_KAGANE_REPLY_V1',receive);signal?.removeEventListener('abort',abort);};
      const abort=()=>{send('cancel');cleanup();reject(new DOMException('Reader cancelled','AbortError'));};
      const receive=event=>{
        if(typeof event.detail!=='string'||event.detail.length>36*1024*1024)return;
        let data;try{data=JSON.parse(event.detail);}catch{return;}
        if(data.id!==id)return;cleanup();
        if(action==='manifest' && data.diagnostics)TP.scanDiag?.emit('kagane.discovery',data.diagnostics);
        if(!data.ok)reject(Object.assign(new Error(data.error||'KAGANE_READ_FAILED'),{code:String(data.error||'KAGANE_READ_FAILED').split(':')[0]}));
        else resolve(data);
      };
      const timer=setTimeout(()=>{send('cancel');cleanup();reject(Object.assign(new Error('KAGANE_BRIDGE_TIMEOUT: Reload this reader page, then try again.'),{code:'KAGANE_BRIDGE_TIMEOUT'}));},action==='manifest'?4000:23000);
      document.addEventListener('TP_KAGANE_REPLY_V1',receive);signal?.addEventListener('abort',abort,{once:true});send(action);
    });
  }
  function detect() {
    const path=route();if(!path)return null;
    const slots=new Map();
    for(const el of document.querySelectorAll('[data-page]')){
      if(TP.readerClassification?.own(el)||!/^[1-9]\d*$/.test(el.getAttribute('data-page')||''))continue;
      const id=el.getAttribute('data-page');
      if(slots.has(id))return null;slots.set(id,el);
    }
    if(!slots.size)return null;
    const ids=[...slots.keys()].sort((a,b)=>Number(a)-Number(b));
    if(ids.some((id,i)=>Number(id)!==i+1))return null;
    let root=slots.get(ids[0]).parentElement;
    while(root && ![...slots.values()].every(el=>root.contains(el)))root=root.parentElement;
    if(!root)return null;
    return {type:'DYNAMIC',adapter:'kagane',profile:'kagane-manifest',chapterId:path[2],seriesId:path[1],origin:location.origin,
      selector:'[data-page]',attr:'data-page',root,ids,slots};
  }
  function validSource(row,plan){
    try{
      const url=new URL(row.source);
      return url.protocol==='https:' && !url.search && !url.hash && !url.username && !url.password &&
        /(^|\.)(kstatic|kagane)\.to$/i.test(url.hostname) &&
        /^[a-f0-9-]{36}$/i.test(row.key) && /^[a-z0-9]{1,8}$/i.test(row.ext) &&
        url.pathname.endsWith('/'+plan.chapterId+'/'+row.key+'.'+row.ext);
    }catch{return false;}
  }
  async function sources(plan,signal) {
    const result=await request('manifest',plan.chapterId,{},signal);
    if(!isCurrent(plan)||result.chapter!==plan.chapterId)throw Error('KAGANE_CHAPTER_CHANGED');
    if(!Array.isArray(result.rows)||result.rows.length!==plan.ids.length||
      result.rows.some((row,i)=>row.id!==plan.ids[i] || !validSource(row,plan)))throw Error('KAGANE_PAGE_MAPPING_MISMATCH');
    plan.kagane={lease:result.lease,rows:new Map(result.rows.map(row=>[row.id,row]))};
    plan.sourceDiagnostics={inline:'kagane_manifest',bridge:'matched'};
    TP.scanDiag?.emit('kagane.manifest',{chapterPages:result.rows.length,mapped:plan.ids.length,credentials:'page_owned'});
    return new Map(result.rows.map(row=>[row.id,row.source]));
  }
  function isCurrent(plan){const path=route();return !!path && path[1]===plan.seriesId && path[2]===plan.chapterId && location.origin===plan.origin;}
  function ownsSource(plan,id,source) {
    return plan.adapter==='kagane' && isCurrent(plan) &&
      plan.kagane?.rows.get(String(id))?.source===source;
  }
  async function read(plan,id,signal){
    if(!plan.kagane||!isCurrent(plan))throw Error('KAGANE_SOURCE_STALE');
    return request('read',plan.chapterId,{lease:plan.kagane.lease,pageId:String(id)},signal);
  }
  TP.kagane={detect,sources,ownsSource,read,isCurrent};
})();
