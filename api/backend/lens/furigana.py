"""Source-only furigana removal, paired with shared/lens-furigana.js.

Geometry plus Japanese evidence identifies ruby. Target paragraphs are not
positional copies of source paragraphs and are never removed by source index.
"""
from __future__ import annotations
import math
import re
from typing import Any

_KANJI = re.compile(r"[\u3400-\u9fff]")
_READING = re.compile(r"^[\u3040-\u30ff\s]+$")


def _bounds(node, w, h):
    raw = node.get("bounds_px")
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        box = node.get("box") or {}
        if not box or not (w > 0 and h > 0):
            return None
        try:
            bw, bh = float(box["width"]) * w, float(box["height"]) * h
            center = box.get("center") or {}
            cx = float(center.get("x", float(box.get("left", 0)) + float(box["width"]) / 2)) * w
            cy = float(center.get("y", float(box.get("top", 0)) + float(box["height"]) / 2)) * h
            a = math.radians(float(box.get("rotation_deg") or 0))
            dx = (abs(math.cos(a)) * bw + abs(math.sin(a)) * bh) / 2
            dy = (abs(math.sin(a)) * bw + abs(math.cos(a)) * bh) / 2
            if bw <= 0 or bh <= 0:
                return None
            raw = [cx-dx, cy-dy, cx+dx, cy+dy]
        except (TypeError, ValueError, KeyError):
            return None
    try:
        b = [float(v) for v in raw]
    except (TypeError, ValueError):
        return None
    return b if all(math.isfinite(v) for v in b) and b[2]>b[0] and b[3]>b[1] else None


def _axis(node, b):
    try:
        r = float((node.get("box") or {}).get("rotation_deg") or 0)
    except (TypeError, ValueError):
        return "tilted"
    a = r % 180
    if not math.isfinite(r) or 12<a<78 or 102<a<168:
        return "tilted"
    ratio = (b[3]-b[1])/(b[2]-b[0])
    return "v" if ratio>=1.35 else "h" if ratio<=1/1.35 else None


def _span_bases(entries):
    """One reading may annotate several adjacent kanji spans in the same line."""
    groups={}
    for b in entries:
        if b["si"]>=0 and _KANJI.search(b["text"]) and b["axis"] in ("h","v"):
            groups.setdefault((b["pi"],b["ii"],b["axis"]),[]).append(b)
    result=[]
    for nodes in groups.values():
        v=nodes[0]["axis"]=="v"; along=1 if v else 0; cross=0 if v else 1
        nodes=sorted(nodes,key=lambda n:n["b"][along])
        if len(nodes)<2:
            continue
        sizes=[n["b"][cross+2]-n["b"][cross] for n in nodes];scale=min(sizes)
        centres=[(n["b"][cross]+n["b"][cross+2])/2 for n in nodes]
        if max(sizes)>scale*1.35 or max(centres)-min(centres)>scale*.35:
            continue
        if any(b["b"][along]-a["b"][along+2]>scale*.75 for a,b in zip(nodes,nodes[1:])):
            continue
        result.append({**nodes[0],"si":-2,"text":"".join(n["text"] for n in nodes),
            "b":[min(n["b"][0] for n in nodes),min(n["b"][1] for n in nodes),
                 max(n["b"][2] for n in nodes),max(n["b"][3] for n in nodes)]})
    return result


def _beside(c, base):
    x,y,X,Y = c["b"]; bx,by,bX,bY = base["b"]
    v = base["axis"] == "v"
    if not base["axis"] or (c["axis"] and c["axis"] != base["axis"]):
        return False
    small,large = (X-x,bX-bx) if v else (Y-y,bY-by)
    if large < small*1.6:
        return False
    extent,base_extent = (Y-y,bY-by) if v else (X-x,bX-bx)
    overlap = min(Y,bY)-max(y,by) if v else min(X,bX)-max(x,bx)
    gap = x-bX if v else by-Y
    return extent<=base_extent*1.2 and overlap>=extent*.6 and -small*.25<=gap<=min(small,large*.35)


def _union(nodes, w, h):
    bs = [b for n in nodes if (b := _bounds(n,w,h))]
    return [min(b[0] for b in bs),min(b[1] for b in bs),max(b[2] for b in bs),max(b[3] for b in bs)] if bs else None


def _reframe(node, spans, w, h):
    if len(spans)==1:
        for key in ("box","baseline_p1","baseline_p2","height_raw"):
            if spans[0].get(key) is not None:
                node[key]=spans[0][key]
        return node
    b=node.get("bounds_px")
    if not b or not (w>0 and h>0):
        return node
    x,y,X,Y=b;cx=(x+X)/2;cy=(y+Y)/2
    def area(sp):
        sb=_bounds(sp,w,h)
        return (sb[2]-sb[0])*(sb[3]-sb[1]) if sb else 0
    main=max(spans,key=area);angle=float((main.get("box") or {}).get("rotation_deg") or 0)
    sideways=Y-y>X-x and 78<=abs(angle)<=102
    length,glyph=(Y-y,X-x) if sideways else (X-x,Y-y)
    rotation=(-90 if angle<0 else 90) if sideways else 0
    node["box"]=dict(left=(cx-length/2)/w,top=(cy-glyph/2)/h,width=length/w,height=glyph/h,
                     rotation_deg=rotation,rotation_deg_css=rotation,center=dict(x=cx/w,y=cy/h))
    node["height_raw"]=glyph/h
    node["baseline_p1"]=dict(x=cx/w,y=(Y if rotation<0 else y)/h) if sideways else dict(x=x/w,y=cy/h)
    node["baseline_p2"]=dict(x=cx/w,y=(y if rotation<0 else Y)/h) if sideways else dict(x=X/w,y=cy/h)
    updated=[]
    for sp in spans:
        sb=_bounds(sp,w,h)
        if sb:
            start=(Y-sb[3] if rotation<0 else sb[1]-y) if sideways else sb[0]-x
            end=(Y-sb[1] if rotation<0 else sb[3]-y) if sideways else sb[2]-x
            sp={**sp,"t0_raw":max(0,start/length),"t1_raw":min(1,end/length)}
        updated.append(sp)
    node["spans"]=updated
    return node


def _remove_text(text, nodes, drops):
    at=0; out=""
    for i,n in enumerate(nodes):
        value=str(n.get("text") or "")
        if not value:
            continue
        pos=text.find(value,at)
        if pos<0:
            return None
        out+=text[at:pos]+("" if i in drops else value)
        at=pos+len(value)
    return out+text[at:]


def strip_furigana_trees(original: dict[str, Any], translated: dict[str, Any], *, source_lang="", img_w=0, img_h=0):
    ps=original.get("paragraphs") or []
    texts=[str(p.get("text") or "") for p in ps]
    japanese=bool(re.match(r"^ja(?:[-_]|$)",str(source_lang),re.I)) or (
        any(re.search(r"[\u3040-\u30ff]",t) for t in texts) and sum(bool(_KANJI.search(t)) for t in texts)>=2)
    report={"paragraphsDropped":0,"itemsDropped":0,"spansDropped":0,
            "rawToFiltered":list(range(len(ps))),"rubyOwnerRaw":{},"annotations":[],"ambiguousCandidates":0}
    if not japanese or img_h<=0:
        return original,translated,report
    entries=[]
    for pi,p in enumerate(ps):
        for ii,it in enumerate(p.get("items") or []):
            nodes=[(-1,it)] + list(enumerate(it.get("spans") or [])) if len(it.get("spans") or [])>1 else [(-1,it)]
            for si,node in nodes:
                b=_bounds(node,img_w,img_h)
                if b:
                    entries.append(dict(pi=pi,ii=ii,si=si,b=b,text=str(node.get("text") or ""),axis=_axis(node,b),container=p.get("container_id")))
    bases=[e for e in entries if _KANJI.search(e["text"]) and e["axis"] in ("h", "v")] + _span_bases(entries)
    item_drops={};span_drops={}
    for c in entries:
        text=c["text"].strip()
        if not _READING.fullmatch(text) or not re.search(r"[ぁ-ゖァ-ヺ]",text) or len(text)>32:
            continue
        owners={}
        for b in bases:
            if c["pi"]==b["pi"] and c["ii"]==b["ii"] and (c["si"]<0 or b["si"]==-1 or c["si"]==b["si"]):
                continue
            if c["container"] is not None and b["container"] is not None and c["container"]!=b["container"]:
                continue
            if _beside(c,b):
                owners[(b["pi"],b["ii"])]=b
        if len(owners)!=1:
            report["ambiguousCandidates"]+=int(len(owners)>1)
            continue
        owner=next(iter(owners.values()))
        if c["si"]<0:
            item_drops.setdefault(c["pi"],set()).add(c["ii"])
        else:
            span_drops.setdefault((c["pi"],c["ii"]),set()).add(c["si"])
        report["annotations"].append(dict(paragraph=c["pi"],item=c["ii"],span=c["si"],
                                           ownerParagraph=owner["pi"],ownerItem=owner["ii"],axis=owner["axis"]))
    report["annotations"]=[a for a in report["annotations"] if a["span"]<0 or a["item"] not in item_drops.get(a["paragraph"],set())]
    if not item_drops and not span_drops:
        return original,translated,report
    out=[];report["rawToFiltered"]=[None]*len(ps)
    for pi,p in enumerate(ps):
        items=p.get("items") or [];drops=item_drops.get(pi,set());retained=[]
        for ii,it in enumerate(items):
            if ii in drops:
                continue
            node=it;sd=span_drops.get((pi,ii),set());spans=it.get("spans") or []
            if sd and len(sd)<len(spans):
                changed=_remove_text(str(it.get("text") or ""),spans,sd)
                if changed is not None:
                    spans=[s for j,s in enumerate(spans) if j not in sd]
                    node={**it,"text":changed,"spans":spans,"bounds_px":_union(spans,img_w,img_h) or it.get("bounds_px")}
                    _reframe(node,spans,img_w,img_h)
                    report["spansDropped"]+=len(sd)
            retained.append((ii,node))
        if not retained and drops:
            report["paragraphsDropped"]+=1;report["itemsDropped"]+=len(drops)
            a=next((a for a in report["annotations"] if a["paragraph"]==pi),None)
            if a:
                report["rubyOwnerRaw"][str(pi)]=a["ownerParagraph"]
            continue
        changed=bool(drops) or any(n is not items[ii] for ii,n in retained)
        text=str(p.get("text") or "")
        if changed:
            at=0;value="";valid=True;kept=dict(retained)
            for ii,it in enumerate(items):
                t=str(it.get("text") or "")
                if not t:
                    continue
                pos=text.find(t,at)
                if pos<0:
                    valid=False;break
                value+=text[at:pos]+str(kept.get(ii,{}).get("text") or "");at=pos+len(t)
            text=value+text[at:] if valid else "".join(str(n.get("text") or "") for _,n in retained)
        index=len(out);report["rawToFiltered"][pi]=index;report["itemsDropped"]+=len(drops)
        updated=[]
        for ii,(_,n) in enumerate(retained):
            updated.append({**n,"para_index":index,"item_index":ii,"spans":[{**sp,"para_index":index,"item_index":ii,"span_index":si} for si,sp in enumerate(n.get("spans") or [])]})
        rebuilt={**p,"para_index":index,"text":text,"items":updated}
        if changed:
            rebuilt["bounds_px"]=_union(updated,img_w,img_h)
            rebuilt.pop("bubble_bounds_px",None);rebuilt.pop("_tb_block",None)
        out.append(rebuilt)
    if not report["itemsDropped"] and not report["spansDropped"]:
        return original,translated,report
    cleaned={**original,"paragraphs":out,"furigana_filter":report}
    cleaned.pop("bubble_groups",None);cleaned.pop("text_blocks_px",None)
    return cleaned,translated,report
