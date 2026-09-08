"""Presentation-only Translated HTML using the target tree's own layout groups."""
from __future__ import annotations
import math
from backend.render.components.typography import escape_attr, escape_text, fit_paragraph_font_size_horizontal
from backend.render.html.lens import _render_item_horizontal
from backend.render.relayout import target_orientation_for_lang
from backend.render.translated_groups import translated_item_axis, presentation_size, fit_translated_block_font, translated_document, translated_layout_groups


def render_translated_overlay(tree, w, h, *, rotate=False, target_lang="", paragraphs=None, groups=None):
    paragraphs=translated_document(tree) if paragraphs is None else paragraphs
    groups=translated_layout_groups(paragraphs,w,h) if groups is None else groups
    by_id={p["id"]:p for p in paragraphs}
    parts=['<div class="tp-draw-root"><div class="tp-draw-scope">']
    horizontal=target_orientation_for_lang(target_lang)=="h"
    for group in groups:
        gid=escape_attr(group["id"])
        members=[by_id[pid] for pid in group["paragraphIds"]]
        if rotate and horizontal and group["direction"]=="v":
            left,top,right,bottom=group["boundsPx"]
            fs=fit_translated_block_font(group['boundsPx'],group['text'])
            dark=' tp-on-dark' if any(p["textLight"] for p in members) else ''
            parts.append(f'<div class="tp-line tp-bubble{dark}" data-tp-group="{gid}" '
                         f'style="left:{left/w*100:.4f}%;top:{top/h*100:.4f}%;width:{(right-left)/w*100:.4f}%;'
                         f'height:{(bottom-top)/h*100:.4f}%;transform:rotate(0deg);white-space:normal;'
                         f'overflow-wrap:anywhere;word-break:break-word;text-align:center;'
                         f'font-size:calc(var(--tp-font-scale,1) * {fs}px);line-height:calc(var(--tp-font-scale,1) * {round(fs*1.05)}px);">{escape_text(group["text"])}</div>')
            continue
        for p in members:
            for item in p["lensItems"]:
                text=str(item.get("text") or "").strip()
                if not text: continue
                (x1,y1),(x2,y2)=item["baseline"]
                width=math.hypot((x2-x1)*w,(y2-y1)*h)/w; height=item["height"]
                rotation=item["rotation"]
                sideways=not rotate and translated_item_axis(item,w,h)=="v"
                if sideways:
                    rotation=-90.0
                    pw,ph=presentation_size(item,w,h)
                    width,height=pw/w,ph/h
                # Build a temporary baseline rectangle exactly as the JS renderer.
                presentation={"text":text,"item_index":item["id"].rsplit('i',1)[-1],
                              "presentation_sideways":sideways,
                              "box":{"left":(x1+x2-width)/2,"top":(y1+y2-height)/2,
                                     "width":width,"height":height,"rotation_deg":rotation}}
                fs=group["sharedFontPx"] if not rotate and group["direction"]=="v" else None
                line=_render_item_horizontal(presentation,text,{"para_index":p["index"]},w,h,override_fs=fs)
                if line:
                    dark=' class="tp-on-dark"' if p["textLight"] else ''
                    parts.append(f'<div data-tp-group="{gid}"{dark}>{line}</div>')
    parts.append('</div></div>')
    return ''.join(parts) if len(parts)>2 else ''
