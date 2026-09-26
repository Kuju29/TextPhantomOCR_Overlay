// MangaGo's per-image key is only usable when the image URL already carries
// the site-specific #desckey=...&cols=... metadata. Do not guess the key.
import { remapCells } from './tile-maps.js';
export function mangagoKey(url,pageUrl) {
  try {
    const page=new URL(pageUrl),source=new URL(url);
    if(!/^(?:www\.)?mangago\.(?:me|zone)$/i.test(page.hostname)||!/^https?:$/.test(source.protocol))return null;
    const fragment=new URLSearchParams(source.hash.slice(1));
    const cols=Number(fragment.get('cols'));
    if(!Number.isInteger(cols)||cols<2||cols>20)return null;
    const key=fragment.get('desckey');
    if(!key||key.length>2400)return null;
    const values=key.split('a');
    const size=cols*cols;
    if(values.length!==size||values.some(v=>!/^\d{1,3}$/.test(v)))return null;
    const destinations=values.map(Number);
    if(new Set(destinations).size!==size||destinations.some(n=>n>=size))return null;
    const order=new Array(size);
    for(let src=0;src<size;src++)order[destinations[src]]=src;
    return {cols,order};
  } catch{return null;}
}
export function decodeMangago(blob,url,pageUrl,options={}) {
  const key=mangagoKey(url,pageUrl);
  return key ? remapCells(blob,{cols:key.cols,rows:key.cols,order:key.order,kind:'mangago-grid',...options}) : blob;
}
