/** Source-only ruby removal. Text alone never proves an annotation. */
const KANJI = /[\u3400-\u9fff]/u;
const READING = /^[\u3040-\u30ff\s]+$/u;
function bounds(node, w, h) {
  let b = node?.bounds_px;
  if (!Array.isArray(b) || b.length !== 4) {
    const box = node?.box;
    if (!box || !(w > 0 && h > 0)) return null;
    const bw = Number(box.width) * w, bh = Number(box.height) * h;
    const cx = Number(box.center?.x ?? (Number(box.left) + Number(box.width) / 2)) * w;
    const cy = Number(box.center?.y ?? (Number(box.top) + Number(box.height) / 2)) * h;
    const a = Number(box.rotation_deg ?? 0) * Math.PI / 180;
    const dx = (Math.abs(Math.cos(a)) * bw + Math.abs(Math.sin(a)) * bh) / 2;
    const dy = (Math.abs(Math.sin(a)) * bw + Math.abs(Math.cos(a)) * bh) / 2;
    if (!(bw > 0 && bh > 0)) return null;
    b = [cx - dx, cy - dy, cx + dx, cy + dy];
  }
  return b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1] ? [...b] : null;
}
function axis(node, b) {
  const r = Number(node?.box?.rotation_deg ?? 0);
  const a = Math.abs((r + 180) % 180);
  if (!Number.isFinite(r) || (a > 12 && a < 78) || (a > 102 && a < 168)) return 'tilted';
  const ratio = (b[3] - b[1]) / (b[2] - b[0]);
  if (ratio >= 1.35) return 'v';
  if (ratio <= 1 / 1.35) return 'h';
  return null; // A square kana glyph can attach to either proven base axis.
}
/** A reading can cover adjacent kanji spans, but not a gap between lines. */
function spanBases(entries) {
  const groups=new Map();
  for(const b of entries) {
    if(b.si<0 || !KANJI.test(b.text) || !['h','v'].includes(b.axis)) continue;
    const key=`${b.pi}:${b.ii}:${b.axis}`;
    if(!groups.has(key)) groups.set(key,[]);groups.get(key).push(b);
  }
  const result=[];
  for(const ns of groups.values()) {
    if(ns.length<2) continue;
    const v=ns[0].axis==='v',along=v?1:0,cross=v?0:1;
    const nodes=[...ns].sort((a,b)=>a.b[along]-b.b[along]);
    const sizes=nodes.map(n=>n.b[cross+2]-n.b[cross]),scale=Math.min(...sizes);
    const centres=nodes.map(n=>(n.b[cross]+n.b[cross+2])/2);
    if(Math.max(...sizes)>scale*1.35 || Math.max(...centres)-Math.min(...centres)>scale*.35) continue;
    if(nodes.slice(1).some((b,i)=>b.b[along]-nodes[i].b[along+2]>scale*.75)) continue;
    result.push({...nodes[0],si:-2,text:nodes.map(n=>n.text).join(''),b:[
      Math.min(...nodes.map(n=>n.b[0])),Math.min(...nodes.map(n=>n.b[1])),
      Math.max(...nodes.map(n=>n.b[2])),Math.max(...nodes.map(n=>n.b[3]))]});
  }
  return result;
}
function beside(c, base) {
  const [x,y,X,Y] = c.b, [bx,by,bX,bY] = base.b;
  const v = base.axis === 'v';
  if (!base.axis || (c.axis && c.axis !== base.axis)) return false;
  const small = v ? X-x : Y-y, large = v ? bX-bx : bY-by;
  if (!(large >= small * 1.6)) return false;
  const extent = v ? Y-y : X-x, baseExtent = v ? bY-by : bX-bx;
  const overlap = v ? Math.min(Y,bY)-Math.max(y,by) : Math.min(X,bX)-Math.max(x,bx);
  const gap = v ? x-bX : by-Y;
  return extent <= baseExtent * 1.2 && overlap >= extent * .6 &&
    gap >= -small * .25 && gap <= Math.min(small, large * .35);
}
function union(nodes, w, h) {
  const bs = nodes.map(n => bounds(n,w,h)).filter(Boolean);
  return bs.length ? [Math.min(...bs.map(b=>b[0])),Math.min(...bs.map(b=>b[1])),
    Math.max(...bs.map(b=>b[2])),Math.max(...bs.map(b=>b[3]))] : null;
}
/** Rebuild a dirty line from remaining main spans, not the old ruby envelope. */
function reframe(node, spans, w, h) {
  if (spans.length === 1) {
    for (const key of ['box','baseline_p1','baseline_p2','height_raw'])
      if (spans[0][key] != null) node[key] = structuredClone(spans[0][key]);
    return node;
  }
  const b = node.bounds_px;
  if (!b || !(w > 0 && h > 0)) return node;
  const [x,y,X,Y] = b, cx=(x+X)/2, cy=(y+Y)/2;
  const main = spans.reduce((a,c)=>{
    const ba=bounds(a,w,h),bc=bounds(c,w,h);
    return !ba || (bc && (bc[2]-bc[0])*(bc[3]-bc[1]) > (ba[2]-ba[0])*(ba[3]-ba[1])) ? c : a;
  });
  const angle=Number(main.box?.rotation_deg || 0);
  const sideways=Y-y > X-x && Math.abs(angle)>=78 && Math.abs(angle)<=102;
  const length=sideways?Y-y:X-x, glyph=sideways?X-x:Y-y, rotation=sideways?(angle<0?-90:90):0;
  node.box={left:(cx-length/2)/w,top:(cy-glyph/2)/h,width:length/w,height:glyph/h,
    rotation_deg:rotation,rotation_deg_css:rotation,center:{x:cx/w,y:cy/h}};
  node.height_raw=glyph/h;
  node.baseline_p1=sideways?{x:cx/w,y:(rotation<0?Y:y)/h}:{x:x/w,y:cy/h};
  node.baseline_p2=sideways?{x:cx/w,y:(rotation<0?y:Y)/h}:{x:X/w,y:cy/h};
  node.spans=spans.map(sp=>{
    const sb=bounds(sp,w,h);if(!sb)return sp;
    const start=sideways?(rotation<0?Y-sb[3]:sb[1]-y):sb[0]-x;
    const end=sideways?(rotation<0?Y-sb[1]:sb[3]-y):sb[2]-x;
    return {...sp,t0_raw:Math.max(0,start/length),t1_raw:Math.min(1,end/length)};
  });
  return node;
}
/** Remove only aligned source occurrences; never global-replace a kana word. */
function removeText(text, nodes, drops) {
  let at = 0, out = '';
  for (let i=0;i<nodes.length;i++) {
    const value = String(nodes[i]?.text || '');
    if (!value) continue;
    const pos = text.indexOf(value, at);
    if (pos < 0) return null;
    out += text.slice(at,pos) + (drops.has(i) ? '' : value);
    at = pos + value.length;
  }
  return out + text.slice(at);
}
export function filterJapaneseFuriganaTrees(original, translated, {sourceLang='', imgW=0, imgH=0}={}) {
  const ps = original?.paragraphs || [];
  const texts = ps.map(p=>String(p?.text || ''));
  const japanese = /^ja(?:[-_]|$)/i.test(sourceLang) ||
    (texts.some(t=>/[\u3040-\u30ff]/u.test(t)) && texts.filter(t=>KANJI.test(t)).length>=2);
  const report = {paragraphsDropped:0,itemsDropped:0,spansDropped:0,
    rawToFiltered:ps.map((_,i)=>i),rubyOwnerRaw:{},annotations:[],ambiguousCandidates:0};
  if (!japanese || !(imgH>0)) return {original,translated,report};
  const entries=[];
  ps.forEach((p,pi)=>(p?.items || []).forEach((it,ii)=>{
    const add=(node,si)=>{const b=bounds(node,imgW,imgH); if(b) entries.push({pi,ii,si,b,
      text:String(node?.text || ''),axis:axis(node,b),container:p.container_id});};
    add(it,-1);
    if ((it?.spans || []).length>1) it.spans.forEach((sp,si)=>add(sp,si));
  }));
  const bases=[...entries.filter(e=>KANJI.test(e.text) && ['h','v'].includes(e.axis)),...spanBases(entries)];
  const itemDrops=new Map(),spanDrops=new Map();
  for (const c of entries) {
    const text=c.text.trim();
    if (!READING.test(text) || !/[\u3041-\u3096\u30a1-\u30fa]/u.test(text) || Array.from(text).length>32) continue;
    const owners=new Map();
    for (const b of bases) {
      if (c.pi===b.pi && c.ii===b.ii && (c.si<0 || b.si===-1 || c.si===b.si)) continue;
      if (c.container!=null && b.container!=null && c.container!==b.container) continue;
      if (beside(c,b)) owners.set(`${b.pi}:${b.ii}`,b);
    }
    if (owners.size!==1) {if(owners.size>1) report.ambiguousCandidates++;continue;}
    const owner=[...owners.values()][0];
    if (c.si<0) {
      if(!itemDrops.has(c.pi)) itemDrops.set(c.pi,new Set());
      itemDrops.get(c.pi).add(c.ii);
    } else {
      const k=`${c.pi}:${c.ii}`;
      if(!spanDrops.has(k)) spanDrops.set(k,new Set());
      spanDrops.get(k).add(c.si);
    }
    report.annotations.push({paragraph:c.pi,item:c.ii,span:c.si,
      ownerParagraph:owner.pi,ownerItem:owner.ii,axis:owner.axis});
  }
  report.annotations=report.annotations.filter(a => a.span<0 || !itemDrops.get(a.paragraph)?.has(a.item));
  if(!itemDrops.size && !spanDrops.size) return {original,translated,report};
  const out=[];report.rawToFiltered=ps.map(()=>null);
  ps.forEach((p,pi)=>{
    const items=p.items || [], drops=itemDrops.get(pi)||new Set();
    let text=String(p.text || '');
    const retained=[];
    items.forEach((it,ii)=>{
      if(drops.has(ii)) return;
      let node=it;
      const sd=spanDrops.get(`${pi}:${ii}`);
      if(sd?.size && sd.size<(it.spans||[]).length) {
        const changed=removeText(String(it.text||''),it.spans,sd);
        if(changed!=null) {
          const spans=it.spans.filter((_,j)=>!sd.has(j));
          node={...it,text:changed,spans,bounds_px:union(spans,imgW,imgH)||it.bounds_px};
          reframe(node,spans,imgW,imgH);
          report.spansDropped+=sd.size;
        }
      }
      retained.push([ii,node]);
    });
    if(!retained.length && drops.size) {
      report.paragraphsDropped++;report.itemsDropped+=drops.size;
      const a=report.annotations.find(a=>a.paragraph===pi);
      if(a) report.rubyOwnerRaw[pi]=a.ownerParagraph;
      return;
    }
    if(drops.size || retained.some(([ii,n])=>n!==items[ii])) {
      // Rebuild from the ordered original occurrences, preserving separators.
      let at=0, changed='', valid=true;
      for(let ii=0;ii<items.length;ii++) {
        const t=String(items[ii]?.text||'');if(!t) continue;
        const pos=text.indexOf(t,at);if(pos<0){valid=false;break;}
        const n=retained.find(([j])=>j===ii)?.[1];
        changed+=text.slice(at,pos)+(n?String(n.text||''):'');at=pos+t.length;
      }
      text=valid ? changed+text.slice(at) : retained.map(([,n])=>String(n.text||'')).join('');
    }
    const index=out.length;report.rawToFiltered[pi]=index;report.itemsDropped+=drops.size;
    const updated=retained.map(([,n],ii)=>({...n,para_index:index,item_index:ii,
      spans:(n.spans||[]).map((sp,si)=>({...sp,para_index:index,item_index:ii,span_index:si}))}));
    const changed=drops.size || retained.some(([ii,n])=>n!==items[ii]);
    const rebuilt={...p,para_index:index,text,items:updated};
    if(changed) {
      rebuilt.bounds_px=union(updated,imgW,imgH);
      // Derived pre-filter envelopes/groups cannot survive removal.
      delete rebuilt.bubble_bounds_px; delete rebuilt._tb_block;
    }
    out.push(rebuilt);
  });
  if(!report.itemsDropped && !report.spansDropped) return {original,translated,report};
  const cleaned={...original,paragraphs:out,furigana_filter:report};
  delete cleaned.bubble_groups;delete cleaned.text_blocks_px;
  // Target paragraphs are not 1:1 with source paragraphs. Never delete target
  // dialogue merely because its array index matched a removed source reading.
  return {original:cleaned,translated,report};
}
