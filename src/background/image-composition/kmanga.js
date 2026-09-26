// K Manga's page fragment (if available) contains seed:title:episode.
import { remapCells } from './tile-maps.js';
const EVEN='we7ru3ty8i',ODD='h4xm9bqz1p';
export function kmangaKey(url,pageUrl) {
  try {
    const page=new URL(pageUrl),source=new URL(url);
    if(page.hostname!=='kmanga.kodansha.com'||!/^https?:$/.test(source.protocol))return null;
    const match=source.hash.match(/^#([^:]{1,100}):(\d{1,12}):(\d{1,12})$/);
    if(!match)return null;
    const title=Number(match[2]),episode=Number(match[3]);
    if(!Number.isSafeInteger(title)||!Number.isSafeInteger(episode))return null;
    const charset=title%2===0?EVEN:ODD;
    if([...match[1]].some(char=>!charset.includes(char)))return null;
    let seed=0;
    for(const char of match[1])seed=(seed*10+charset.indexOf(char))>>>0;
    seed=(seed^(title+episode))>>>0;
    const values=[];
    for(let i=0;i<16;i++){
      seed=(seed^(seed<<13))>>>0;
      seed=(seed^(seed>>>17))>>>0;
      seed=(seed^(seed<<5))>>>0;
      values.push({value:seed,index:i});
    }
    return values.sort((a,b)=>a.value-b.value).map(row=>row.index);
  }catch{return null;}
}
export function decodeKManga(blob,url,pageUrl,options={}) {
  const order=kmangaKey(url,pageUrl);
  return order ? remapCells(blob,{cols:4,rows:4,order,
    geometry:(width,height)=>[Math.floor(width/8)*2,Math.floor(height/8)*2],
    kind:'kmanga-cells',...options}) : blob;
}
