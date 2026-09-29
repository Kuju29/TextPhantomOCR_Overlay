import {decodeTranslations} from '../../../shared/ai/direct-local/decode.js';

// Consume only closed marker islands. The terminal decoder remains authoritative.
// Keep partial delimiters across chunks; each byte is scanned once.
export function createStreamRecords(units) {
  const accepted=new Map(), invalid=new Set(), seen=new Set();
  let pending='', island='', depth=0, nested=false,revision=0;
  function close() {
    const claims=[...island.matchAll(/<<(?:TP_(P\d+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6}))(?=:|\s|>)/gu)].map(m=>m[1]||m[2]);
    for(const id of claims){if(seen.has(id)||nested)invalid.add(id);seen.add(id);}
    const decoded=decodeTranslations(island,units,{compactMarkers:true,wireUnits:units});
    for(const id of decoded.diagnostics?.malformedMarkerIds||[])invalid.add(id);
    for(const t of decoded.translations)if(t.text?.trim()&&!invalid.has(t.id))accepted.set(t.id,t.text);
    for(const id of invalid)accepted.delete(id);
    island='';nested=false;revision++;
  }
  return {
    accepted,invalid,get revision(){return revision;},
    finish(){
      // EOF cannot turn an unfinished duplicate into an accepted earlier value.
      const claims=[...(island+pending).matchAll(/<<(?:TP_(P\d+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6}))(?=:|\s|>|$)/gu)];
      for(const claim of claims){const id=claim[1]||claim[2];invalid.add(id);accepted.delete(id);}
      if(claims.length)revision++;
    },
    push(delta){
      pending+=String(delta||'');let at=0;
      while(at<pending.length){
        const ch=pending[at];
        if(at===pending.length-1&&(ch==='<'||ch==='>'))break;
        const token=pending.slice(at,at+2);
        if(token==='<<'){
          // The terminal grammar recovers at a valid marker on a new physical
          // line. Match it here: one missing >> must not poison every later
          // page and override an otherwise valid terminal response.
          if(depth && /[\r\n]$/u.test(island)){
            const tail=pending.slice(at);
            const header=/^<<(?:TP_P\d+|I[1-9][0-9]{0,6}_P[0-9]{1,6})(?::|\s)/u.test(tail);
            if(!header && tail.length<40 && !/[\s:>]/u.test(tail.slice(2)))break;
            if(header){
              const claims=[...island.matchAll(/<<(?:TP_(P\d+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6}))(?=:|\s|>|$)/gu)].map(m=>m[1]||m[2]);
              for(const id of claims){invalid.add(id);seen.add(id);accepted.delete(id);}
              island='';depth=0;nested=false;revision++;
            }
          }
          if(depth)nested=true;depth++;island+=token;at+=2;
        }
        else if(token==='>>'&&depth){island+=token;at+=2;if(--depth===0)close();}
        else {if(depth)island+=ch;at++;}
      }
      pending=pending.slice(at);
      return accepted;
    }
  };
}
