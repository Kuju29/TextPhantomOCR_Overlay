"""Translated-only display grouping. Mirrors translated-groups.js on LensDocument geometry.

Membership never reads source paragraphs, raw-graph groups, bubble IDs or ONNX.
The source translated tree is immutable; this projection is presentation data.
"""
from __future__ import annotations
import math
import re
from backend.lens.document import _items
from backend.render.components.typography import fit_item_font_size, MIN_FONT_PX, fit_paragraph_font_size_horizontal, glyph_width_ratio


def item_axis(angle):
    folded = float(angle) % 180
    return "v" if abs(folded-90) <= 12 else "h" if min(folded,180-folded) <= 12 else "tilted"


def translated_item_axis(item, w, h):
    axis = item_axis(item["rotation"])
    if axis != "h":
        return axis
    (x1,y1),(x2,y2) = item["baseline"]
    length = math.hypot((x2-x1)*w,(y2-y1)*h)
    return "v" if length > 0 and item["height"]*h >= 1.35*length else "h"


def presentation_size(item, w, h):
    (x1,y1),(x2,y2) = item["baseline"]
    length = math.hypot((x2-x1)*w,(y2-y1)*h)
    thickness = item["height"]*h
    if translated_item_axis(item,w,h)=="v" and item_axis(item["rotation"])!="v":
        return thickness, length
    return length, thickness


def fit_translated_block_font(bounds, text):
    left,top,right,bottom=bounds
    width,height=right-left,bottom-top
    font=fit_paragraph_font_size_horizontal(width,height,text)
    ratio=glyph_width_ratio(text)
    tokens=[t for t in re.split(r"(\s+)",text) if t]
    while font>MIN_FONT_PX:
        available=width-.2*font
        if available<=0:
            font-=1
            continue
        rows,used,space=1,0,0
        for token in tokens:
            if token.isspace():
                breaks=token.count("\n")
                if breaks:
                    rows+=breaks
                    used=0
                space=0 if breaks else .33*font
                continue
            length=len(token)*ratio*font
            if used and used+space+length>available:
                rows+=1
                used=space=0
            if length>available:
                parts=math.ceil(length/available)
                rows+=parts-1
                length-=available*(parts-1)
            used+=(space if used else 0)+length
            space=0
        if rows*round(font*1.05)+.4*font<=height:
            break
        font-=1
    return font


def _median(values):
    return sorted(values)[len(values)//2] if values else 0


def _geometry(item, w, h):
    (x1,y1),(x2,y2) = item["baseline"]
    length = math.hypot((x2-x1)*w,(y2-y1)*h)
    thickness = item["height"]*h
    if length <= 0 or thickness <= 0:
        return None
    cx,cy=(x1+x2)*w/2,(y1+y2)*h/2
    rad=math.radians(item["rotation"])
    aw=abs(length*math.cos(rad))+abs(thickness*math.sin(rad))
    ah=abs(length*math.sin(rad))+abs(thickness*math.cos(rad))
    pw,ph=presentation_size(item,w,h)
    font=fit_item_font_size(pw/w*100,ph/h*100,item["text"],w,h)
    if translated_item_axis(item,w,h)=="v":
        font=max(MIN_FONT_PX,min(font,math.floor(ph/1.35)))
    return {"bounds":[cx-aw/2,cy-ah/2,cx+aw/2,cy+ah/2], "glyph":min(length,thickness), "font":font}


def _aligned(a,b):
    if a["direction"] != b["direction"] or a["direction"] == "tilted":
        return False
    glyph=max(a["glyph"],b["glyph"])
    if glyph > 1.6*min(a["glyph"],b["glyph"]):
        return False
    offset=1 if a["direction"] == "v" else 0
    low1,high1=a["bounds"][offset],a["bounds"][offset+2]
    low2,high2=b["bounds"][offset],b["bounds"][offset+2]
    shorter=min(high1-low1,high2-low2)
    overlap=max(0,min(high1,high2)-max(low1,low2))
    return overlap >= .5*shorter and abs(low1-low2) <= max(1.5*glyph,.25*shorter)


def _gap(a,b):
    i=0 if a["direction"] == "v" else 1
    return max(0,a["bounds"][i]-b["bounds"][i+2],b["bounds"][i]-a["bounds"][i+2])


def _union(bounds):
    return [min(b[0] for b in bounds),min(b[1] for b in bounds),
            max(b[2] for b in bounds),max(b[3] for b in bounds)]


def translated_document(tree):
    """Independent translated paragraphs, including target-only paragraphs."""
    out=[]
    for index,p in enumerate((tree or {}).get("paragraphs") or []):
        if not isinstance(p,dict):
            continue
        items,_=_items(f"p{index}",p.get("items"),layer="t")
        out.append({"id":f"p{index}","index":index,"lensText":str(p.get("text") or ""),
                    "lensItems":items,"textLight":bool(p.get("text_light"))})
    return out


def translated_layout_groups(paragraphs, w, h):
    if w <= 0 or h <= 0:
        return []
    entries=[]
    for index,p in enumerate(paragraphs):
        items=[it for it in p.get("lensItems",[]) if str(it.get("text") or "").strip()]
        geometries=[g for it in items if (g:=_geometry(it,w,h))]
        if not geometries:
            continue
        axes=[translated_item_axis(it,w,h) for it in items]
        direction="v" if all(x=="v" for x in axes) else "h" if all(x=="h" for x in axes) else "tilted"
        entries.append({"index":index,"id":p["id"],"paragraph":p,"items":items,
                        "geometries":geometries,"direction":direction,
                        "glyph":_median([g["glyph"] for g in geometries]),
                        "bounds":_union([g["bounds"] for g in geometries])})
    clusters=[[i] for i in range(len(entries))]; owner=list(range(len(entries))); edges=[]
    for i,a in enumerate(entries):
        for j in range(i+1,len(entries)):
            b=entries[j]; distance=_gap(a,b)
            if _aligned(a,b) and distance <= 1.5*max(a["glyph"],b["glyph"]):
                edges.append((distance,i,j))
    for _,i,j in sorted(edges):
        a,b=owner[i],owner[j]
        if a==b or not all(_aligned(entries[x],entries[y]) for x in clusters[a] for y in clusters[b]):
            continue
        clusters[a].extend(clusters[b])
        for k in clusters[b]: owner[k]=a
        clusters[b]=[]
    result=[]
    for cluster in clusters:
        if not cluster: continue
        members=[entries[i] for i in cluster]
        members.sort(key=lambda x: (-x["bounds"][0],x["bounds"][1],x["index"]) if x["direction"]=="v" else
                     (x["bounds"][1],x["bounds"][0],x["index"]))
        result.append({"id":f'tr:{min(m["index"] for m in members)}',
                       "paragraphIds":[m["id"] for m in members],"direction":members[0]["direction"],
                       "boundsPx":_union([m["bounds"] for m in members]),
                       "sharedFontPx":max(MIN_FONT_PX,min(g["font"] for m in members for g in m["geometries"])),
                       "text":" ".join(m["paragraph"]["lensText"].strip() or
                           " ".join(it["text"] for it in m["items"]) for m in members)})
    return result
