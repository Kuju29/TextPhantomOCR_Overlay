// Bounded, on-demand extraction from the current chapter viewer. Paperback
// stores one key per image in the viewer's placeholder PNG after its IHDR.
(function () {
  const TP=window.__TP;
  if(!TP||TP.bail||!/^(?:www\.)?alpha-manga\.com$/i.test(location.hostname))return;
  let previousViewer=null,previousPages='',previousPlaceholder='',keyed=new Map();
  const safeUrl=raw=>{
    try {const url=new URL(raw,location.href);if(!/^https?:$/.test(url.protocol)||url.username||url.password)return '';
      url.hash='';return url.href;
    }catch{return '';}
  };
  const build=(pagesText,placeholder)=>{
    const output=new Map();
    if(!pagesText||pagesText.length>256*1024||!/^data:image\/png;base64,/i.test(placeholder)||
        placeholder.length>2*1024*1024)return output;
    let pages,raw;
    try {
      pages=JSON.parse(pagesText);
      if(!Array.isArray(pages))return output;
      pages=pages.filter(item=>typeof item==='string'&&item!=='first'&&item!=='last');
      if(!pages.length||pages.length>400)return output;
      const binary=atob(placeholder.slice(placeholder.indexOf(',')+1));
      raw=Uint8Array.from(binary,char=>char.charCodeAt(0));
    }catch{return output;}
    if(raw.length<35||raw[0]!==137||raw[1]!==80||raw[2]!==78||raw[3]!==71||
       String.fromCharCode(...raw.subarray(12,16))!=='IHDR')return output;
    const fragments=[];let position=33;
    for(let i=0;i<pages.length;i++){
      if(position+2>raw.length)return new Map();
      const tiles=raw[position]|raw[position+1]<<8;
      if(tiles<1||tiles>400||position+2+tiles*8>raw.length)return new Map();
      const key=raw.subarray(position+2,position+2+tiles*8);
      let hex='';for(const byte of key)hex+=byte.toString(16).padStart(2,'0');
      fragments.push(`#key=${hex}`);position+=2+tiles*8;
    }
    for(let i=0;i<pages.length;i++){
      const url=safeUrl(pages[i]);
      if(!url||output.has(url))return new Map();
      output.set(url,url+fragments[i]);
    }
    return output;
  };
  TP.alphaManga={keyedUrl(raw){
    const source=safeUrl(raw);if(!source)return raw;
    const viewer=document.querySelector('viewer-manga-vertical');
    if(!viewer)return raw;
    const pages=viewer.getAttribute('v-bind:pages')||'';
    const placeholder=viewer.getAttribute('placeholder')||'';
    if(viewer!==previousViewer||pages!==previousPages||placeholder!==previousPlaceholder){
      previousViewer=viewer;previousPages=pages;previousPlaceholder=placeholder;
      keyed=build(pages,placeholder);
      if(keyed.size)TP.log.info('Alpha Manga image keys mapped',{pages:keyed.size});
    }
    return keyed.get(source)||raw;
  }};
})();
