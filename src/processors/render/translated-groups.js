/** Translated display groups. No Original/AI tree, detector or source IDs are read. */
import { itemGeometry, rotatedItemAabbGeometry, unionGeometry, geometryReadingAxis, leftFacingGeometry } from './geometry.js';
import { MIN_FONT_PX, fitItemFontSize } from '../text-metrics.js';

const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length/2)] || 0;
export const translatedItemIsVertical = (item, w=1, h=1) => {
  const g=itemGeometry(item,w,h);
  return !!g && geometryReadingAxis(g,w,h)==='v';
};

function aligned(a,b) {
  if (a.direction !== b.direction || a.direction === 'tilted') return false;
  if (Math.max(a.glyph,b.glyph) > 1.6 * Math.min(a.glyph,b.glyph)) return false;
  const vertical = a.direction === 'v';
  const [l1,t1,r1,b1] = a.bounds, [l2,t2,r2,b2] = b.bounds;
  const low1=vertical?t1:l1, high1=vertical?b1:r1;
  const low2=vertical?t2:l2, high2=vertical?b2:r2;
  const shorter=Math.min(high1-low1,high2-low2), glyph=Math.max(a.glyph,b.glyph);
  const overlap=Math.max(0,Math.min(high1,high2)-Math.max(low1,low2));
  return overlap >= .5 * shorter && Math.abs(low1-low2) <= Math.max(1.5*glyph,.25*shorter);
}
function gap(a,b) {
  return a.direction === 'v' ? Math.max(0,a.bounds[0]-b.bounds[2],b.bounds[0]-a.bounds[2]) :
    Math.max(0,a.bounds[1]-b.bounds[3],b.bounds[1]-a.bounds[3]);
}

export function translatedLayoutGroups(doc) {
  const W=Number(doc?.image?.width), H=Number(doc?.image?.height);
  if (!(W>0 && H>0)) return [];
  const entries=[];
  for (const [index,p] of (doc?.paragraphs || []).entries()) {
    const items=(p?.lensItems || []).filter(it => String(it?.text || '').trim());
    const geometries=items.map(it => itemGeometry(it,W,H)).filter(Boolean);
    const block=unionGeometry(items.map(it=>rotatedItemAabbGeometry(it,W,H)).filter(Boolean));
    if (!block || !geometries.length) continue;
    const axes=geometries.map(g=>geometryReadingAxis(g,W,H));
    // Mixed/tilted paragraphs remain atomic; they cannot bridge unrelated groups.
    const direction=axes.every(x=>x==='v')?'v':axes.every(x=>x==='h')?'h':'tilted';
    entries.push({ index, id:String(p.id), paragraph:p, items, geometries, block, direction,
      glyph:median(geometries.map(g=>Math.min(g.widthPct*W/100,g.heightPct*H/100))),
      bounds:[block.leftPct*W/100,block.topPct*H/100,
        (block.leftPct+block.widthPct)*W/100,(block.topPct+block.heightPct)*H/100] });
  }
  const clusters=entries.map((_,i)=>[i]), owner=entries.map((_,i)=>i), edges=[];
  for(let i=0;i<entries.length;i++) for(let j=i+1;j<entries.length;j++) {
    const a=entries[i],b=entries[j],distance=gap(a,b);
    if(aligned(a,b) && distance <= 1.5*Math.max(a.glyph,b.glyph)) edges.push({i,j,distance});
  }
  edges.sort((a,b)=>a.distance-b.distance || a.i-b.i || a.j-b.j);
  for(const {i,j} of edges) {
    const a=owner[i],b=owner[j]; if(a===b) continue;
    // Gap is a neighbour condition, alignment/scale are whole-group conditions.
    // This stops staircase and small-font bridges without a total-width cap.
    if(!clusters[a].every(x=>clusters[b].every(y=>aligned(entries[x],entries[y])))) continue;
    clusters[a].push(...clusters[b]); for(const k of clusters[b]) owner[k]=a; clusters[b]=[];
  }
  return clusters.filter(c=>c.length).map(c=> {
    const members=c.map(i=>entries[i]).sort((a,b)=>a.direction==='v'
      ? b.bounds[0]-a.bounds[0] || a.bounds[1]-b.bounds[1] || a.index-b.index
      : a.bounds[1]-b.bounds[1] || a.bounds[0]-b.bounds[0] || a.index-b.index);
    const geometries=members.flatMap(x=>x.items.map(it=>leftFacingGeometry(it,W,H)).filter(Boolean));
    // Sideways glyph ink (including combining marks) can exceed a CSS line-height.
    // Bound only the line canvas; Rotate ON fits its union independently.
    const fits=geometries.map(g=>Math.max(MIN_FONT_PX,Math.min(
      fitItemFontSize(g.widthPct,g.heightPct,g.text,W,H),
      g.sideways ? Math.floor(g.heightPct*H/100/1.35) : Infinity)));
    return { id:`tr:${Math.min(...members.map(x=>x.index))}`,
      paragraphIds:members.map(x=>x.id), members:members.map(x=>x.paragraph),
      direction:members[0].direction, block:unionGeometry(members.map(x=>x.block)),
      // Use the tightest member fit, not a page-wide maximum that overflows long lines.
      sharedFontPx:Math.max(MIN_FONT_PX,Math.min(...fits)),
      text:members.map(x=>String(x.paragraph.lensText || '').trim() ||
        x.items.map(it=>String(it.text || '')).join(' ')).join(' '),
    };
  });
}
