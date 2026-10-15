// Accepted summaries are scoped by verified series/target in the caller.
export function chapterKey(value) {
  try {const url=new URL(String(value||""));if(!['http:','https:'].includes(url.protocol))return '';url.hash='';return url.href;}catch{return '';}
}
export function mergeChapterSummaries(state={},chapterURL,entries=[]) {
  const key=chapterKey(chapterURL);if(!key)return state;
  let old=state.seriesMemoV1||{};
  // Bound provenance too. Reset semantic history rather than treating an
  // evicted chapter's summaries as older than an unknown chapter.
  if(!Object.hasOwn(old.firstSeen||{},key)&&Object.keys(old.firstSeen||{}).length>=256)old={};
  const firstSeen={...(old.firstSeen||{})};let next=Number(old.nextChapterOrder)||0;
  if(!Object.hasOwn(firstSeen,key))firstSeen[key]=next++;
  // A single-image translation has no page index; it is numbered after the
  // chapter's last stored page so single translations accumulate in order.
  const existing=(Array.isArray(old.chapters)?old.chapters:[]).find(c=>c.key===key);
  let nextSingle=Math.max(-1,...(existing?.snippets||[]).map(s=>s.pageIndex))+1;
  const valid=entries.flatMap((entry,part)=>{const text=String(entry?.text||'').trim();
    const pageIndex=Number.isInteger(entry?.pageIndex)&&entry.pageIndex>=0?entry.pageIndex:nextSingle++,ids=[...new Set((entry.sourceIds||[]).map(String))].sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
    if(!text||[...text].length>800||/[\r\n\u2028\u2029]/u.test(text)||text.includes('<<')||text.includes('>>')||!Number.isInteger(pageIndex)||pageIndex<0||!ids.length)return [];
    const order=Number.isInteger(entry.requestOrder)?entry.requestOrder:Math.min(...ids.map(id=>Number(/(?:^|_)P(\d+)$/u.exec(id)?.[1]??0)));
    return [{key:JSON.stringify([pageIndex,ids]),pageIndex,requestOrder:order,part,text}];});
  let chapters=(Array.isArray(old.chapters)?old.chapters:[]).map(c=>({...c,snippets:[...(c.snippets||[])]})),tick=Number(old.tick)||0;
  if(valid.length){tick++;let chapter=chapters.find(c=>c.key===key);if(!chapter){chapter={key,firstSeen:firstSeen[key],lastTouched:tick,snippets:[]};chapters.push(chapter);}
    const byKey=new Map(chapter.snippets.map(s=>[s.key,s]));const texts=new Set(chapter.snippets.map(s=>s.text));for(const entry of valid){if(texts.has(entry.text))continue;texts.add(entry.text);const prior=byKey.get(entry.key);byKey.set(entry.key,{...entry,requestOrder:prior?Math.min(prior.requestOrder,entry.requestOrder):entry.requestOrder});}
    chapter.snippets=[...byKey.values()];chapter.lastTouched=tick;chapters.sort((a,b)=>b.lastTouched-a.lastTouched);chapters=chapters.slice(0,4);
    let remaining=24;for(const c of chapters){c.snippets.sort((a,b)=>a.pageIndex-b.pageIndex||a.requestOrder-b.requestOrder||a.part-b.part);c.snippets=remaining?c.snippets.slice(-remaining):[];remaining-=c.snippets.length;}
    chapters=chapters.filter(c=>c.snippets.length).sort((a,b)=>a.firstSeen-b.firstSeen);
  }
  return {...state,seriesMemoV1:{firstSeen,nextChapterOrder:next,tick,chapters}};
}
// includeCurrent: Local Independent cannot see earlier requests, so its
// summary also carries this chapter's accepted summaries so far (newest kept).
// Budget (Economy): the whole memory block of one request is at most
// SERIES_MEMORY_BUDGET characters. Conversation sends it once (previous
// chapters only); Independent and single translations also carry this
// chapter's earlier memos. When memos do not fit, the first, the last and
// evenly spaced ones are kept (never only the newest pages), in story order.
export const SERIES_MEMORY_BUDGET = 900;
const length = text => [...text].length;
export function sampleSnippets(texts, budget) {
  const rows = texts.filter(Boolean);
  if (!rows.length || budget <= 0) return [];
  const total = rows.reduce((sum, text, i) => sum + length(text) + (i ? 1 : 0), 0);
  if (total <= budget) return rows;
  const order = [rows.length - 1, 0];
  for (let parts = 2; order.length < rows.length; parts *= 2)
    for (let k = 1; k < parts; k += 2) {
      const index = Math.round((k * (rows.length - 1)) / parts);
      if (!order.includes(index)) order.push(index);
    }
  const chosen = new Set(); let used = 0;
  for (const index of order) {
    const extra = length(rows[index]) + (chosen.size ? 1 : 0);
    if (used + extra > budget) continue;
    chosen.add(index); used += extra;
  }
  return rows.filter((_, i) => chosen.has(i));
}
export function priorChapterState(state={},url,{includeCurrent=false,budget=SERIES_MEMORY_BUDGET}={}) {
  const key=chapterKey(url);if(!key)return {state,summary:''};
  const prepared=mergeChapterSummaries(state,key,[]),memo=prepared.seriesMemoV1,current=memo.firstSeen[key];
  const ordered=c=>[...c.snippets].sort((a,b)=>a.pageIndex-b.pageIndex||a.requestOrder-b.requestOrder||a.part-b.part).map(s=>s.text);
  const earlier=memo.chapters.filter(c=>c.key!==key&&c.firstSeen<current).sort((a,b)=>a.firstSeen-b.firstSeen);
  const own=includeCurrent?memo.chapters.find(c=>c.key===key):null;
  const ownTexts=own?ordered(own):[];
  // Half for this chapter when it has memos; earlier chapters use the rest,
  // the latest earlier chapter first.
  const ownPart=sampleSnippets(ownTexts, earlier.length ? Math.floor(budget/2) : budget);
  let left=budget-(ownPart.length?ownPart.reduce((n,t,i)=>n+length(t)+(i?1:0),0)+1:0);
  const earlierParts=[];
  for(const chapter of [...earlier].reverse()){
    if(left<=0)break;
    const part=sampleSnippets(ordered(chapter),left);
    if(!part.length)break;
    earlierParts.unshift(part);
    left-=part.reduce((n,t,i)=>n+length(t)+(i?1:0),0)+1;
  }
  return {state:prepared,summary:[...earlierParts.flat(),...ownPart].join('\n')};
}
