"""Conservative item-level ruby evidence; returns indices, never mutates OCR.

Only a short right-side kana annotation with one geometrically compatible
kanji base is excluded from main-column measurements. Ties stay as source.
"""
from __future__ import annotations
import math


def _bounds(item):
    value=item.get("bounds_px")
    if not isinstance(value,(list,tuple)) or len(value)!=4:
        return None
    try:
        b=tuple(float(v) for v in value)
    except (TypeError,ValueError):
        return None
    return b if all(math.isfinite(v) for v in b) and b[2]>b[0] and b[3]>b[1] else None


def infer_item_ruby(tree):
    entries=[]
    mixed=set()
    for position,p in enumerate(tree.get("paragraphs") or []):
        if not isinstance(p,dict):
            continue
        pid=str(p.get("id") or f"p{position}")
        items=[(i,it) for i,it in enumerate(p.get("items") or [])
               if isinstance(it,dict) and str(it.get("text") or "").strip()]
        if len(items)>1:
            mixed.add(pid)
        for index,it in items:
            b=_bounds(it)
            if b is not None:
                entries.append((pid,index,str(it.get("text") or "").strip(),b,p.get("container_id")))
    found={}
    for pid,index,text,(x1,y1,x2,y2),container in entries:
        if pid not in mixed or not 1<=len(text)<=8 or not all(0x3040<=ord(ch)<=0x30ff for ch in text):
            continue
        width=x2-x1; height=y2-y1
        bases=[]
        for bp,bi,base,(bx1,by1,bx2,by2),bc in entries:
            if (bp==pid and bi==index) or not any(0x3400<=ord(ch)<=0x9fff for ch in base):
                continue
            if container is not None and bc is not None and container!=bc:
                continue
            bw,bh=bx2-bx1,by2-by1
            overlap=max(0.,min(y2,by2)-max(y1,by1))
            if (bh>=1.35*bw and bw>=1.75*width and height<=.7*bh and
                    overlap>=.8*height and bx2-.5*width<=x1<=bx2+.5*width):
                bases.append((bp,bi))
        if len(bases)==1:
            found.setdefault(pid,[]).append(index)
    return {pid:tuple(indices) for pid,indices in found.items()}
