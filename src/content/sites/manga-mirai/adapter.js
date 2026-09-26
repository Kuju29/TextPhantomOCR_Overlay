// Only reuse authenticated chapter records that the page itself embedded in
// JSON. No chapter API fetch, global request hook, observer or guessed seed.
(function () {
  const TP=window.__TP;
  if(!TP||TP.bail||!/^(?:www\.)?mangamirai\.com$/i.test(location.hostname))return;
  let lastSignature='',keyed=new Map();
  const address=raw=>{try{const u=new URL(raw,location.href);if(!/^https?:$/.test(u.protocol)||u.username||u.password)return '';
    u.hash='';return u.href;}catch{return '';}};
  const normalizedKey=value=>{
    if(typeof value!=='string'||value.length<8||value.length>4096||
       !/^[A-Za-z0-9+/]+={0,2}$/.test(value))return '';
    try {
      const ints=atob(value).match(/\d+/g)?.map(Number);
      if(!ints||ints.length<2||ints.length>400||ints.some(n=>!Number.isInteger(n)||n<0||n>=ints.length)||
          new Set(ints).size!==ints.length)return '';
      return value;
    }catch{return '';}
  };
  const scan=(scripts)=>{
    const found=new Map(),seen=new WeakSet(),queue=[];
    let budget=0;
    for(const script of scripts){
      const content=script.textContent||'';
      budget+=content.length;
      if(content.length>2*1024*1024||budget>4*1024*1024)break;
      try {queue.push(JSON.parse(content));}catch{}
    }
    for(let i=0;i<queue.length&&i<3000;i++){
      const obj=queue[i];if(!obj||typeof obj!=='object'||seen.has(obj))continue;
      seen.add(obj);
      if(Array.isArray(obj.records)&&obj.records.length<=400){
        for(const record of obj.records){
          const url=address(record?.url),key=normalizedKey(record?.scramble_key);
          if(!url||!key)continue;
          if(found.has(url)&&found.get(url)!==key){found.delete(url);continue;}
          found.set(url,key);
        }
      }
      if(Array.isArray(obj)){for(const child of obj.slice(0,500))queue.push(child);}
      else for(const child of Object.values(obj).slice(0,40))
        if(child&&typeof child==='object')queue.push(child);
    }
    return found;
  };
  TP.mangaMirai={keyedUrl(raw,img=null){
    const source=address(raw);if(!source)return raw;
    // A page image may expose its own key without an inline chapter record.
    const direct=normalizedKey(img?.getAttribute?.('data-scramble-key'));
    if(direct)return `${source}#tp-mirai=${direct}`;
    const scripts=[...document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__,script#initial-data')].slice(0,24);
    const signature=`${location.href}|${scripts.map(node=>`${node.textContent?.length||0}:${node.id}`).join(',')}`;
    if(signature!==lastSignature){
      lastSignature=signature;keyed=scan(scripts);
      if(keyed.size)TP.log.info('Manga Mirai image keys mapped',{pages:keyed.size});
    }
    const key=keyed.get(source);
    return key?`${source}#tp-mirai=${key}`:raw;
  }};
})();
