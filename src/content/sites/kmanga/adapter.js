// A K Manga viewer may embed the authenticated viewer response. Pair its
// page_list with its chapter seed in-memory; do not fetch another episode.
(function () {
  const TP=window.__TP;
  if(!TP||TP.bail||location.hostname!=='kmanga.kodansha.com')return;
  let signature='',keyed=new Map();
  const urlOf=raw=>{try{const u=new URL(raw,location.href);if(!/^https?:$/.test(u.protocol)||u.username||u.password)return '';
    u.hash='';return u.href;}catch{return '';}};
  const scan=scripts=>{
    const entries=new Map(),queue=[],seen=new WeakSet();let bytes=0;
    for(const script of scripts){
      const content=script.textContent||'';bytes+=content.length;
      if(content.length>2*1024*1024||bytes>4*1024*1024)break;
      try{queue.push(JSON.parse(content));}catch{}
    }
    for(let i=0;i<queue.length&&i<3000;i++){
      const obj=queue[i];if(!obj||typeof obj!=='object'||seen.has(obj))continue;
      seen.add(obj);
      const pages=obj.page_list,seed=obj.scramble_seed,title=Number(obj.title_id),episode=Number(obj.episode_id);
      if(Array.isArray(pages)&&pages.length>0&&pages.length<=400&&
          Number.isSafeInteger(title)&&Number.isSafeInteger(episode)&&title>=0&&episode>=0&&
          typeof seed==='string'&&seed.length>=1&&seed.length<=100&&
          [...seed].every(char=>(title%2===0?'we7ru3ty8i':'h4xm9bqz1p').includes(char))){
        for(const item of pages){
          const source=urlOf(item),keyedUrl=source+`#${seed}:${title}:${episode}`;
          if(!source)continue;
          if(entries.has(source)&&entries.get(source)!==keyedUrl){entries.delete(source);continue;}
          entries.set(source,keyedUrl);
        }
      }
      if(Array.isArray(obj)){for(const child of obj.slice(0,500))queue.push(child);}
      else for(const child of Object.values(obj).slice(0,40))
        if(child&&typeof child==='object')queue.push(child);
    }
    return entries;
  };
  TP.kManga={keyedUrl(raw){
    const source=urlOf(raw);if(!source)return raw;
    const scripts=[...document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script#initial-data')].slice(0,24);
    const current=`${location.href}|${scripts.map(node=>`${node.textContent?.length||0}:${node.id}`).join(',')}`;
    if(current!==signature){signature=current;keyed=scan(scripts);
      if(keyed.size)TP.log.info('K Manga image keys mapped',{pages:keyed.size});}
    return keyed.get(source)||raw;
  }};
})();
