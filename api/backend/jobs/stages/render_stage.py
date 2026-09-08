"""Image sampling and overlay annotations shared by render paths."""

from __future__ import annotations

from PIL import Image

import io, base64

from backend.render.colors import region_is_dark

def paragraph_rect(para: dict) -> tuple[int, int, int, int] | None:
    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        return tuple(int(round(float(value))) for value in bp)
    boxes = [item.get("bounds_px") for item in para.get("items") or []]
    boxes = [box for box in boxes if isinstance(box, (list, tuple)) and len(box) == 4]
    if not boxes:
        return None
    return int(min(b[0] for b in boxes)), int(min(b[1] for b in boxes)), int(max(b[2] for b in boxes)), int(max(b[3] for b in boxes))

def annotate_text_light(tree: dict | None, base_img: Image.Image | None) -> None:
    if not isinstance(tree, dict) or base_img is None:
        return
    for para in tree.get("paragraphs") or []:
        rect = paragraph_rect(para)
        if rect is not None:
            try:
                para["text_light"] = region_is_dark(base_img, rect)
            except Exception:
                para["text_light"] = False

def encode_vision_image(img: Image.Image) -> tuple[str, str]:
    source = img
    width, height = source.size
    scale = 1024 / float(max(width, height))
    if scale < 1.0:
        source = source.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.LANCZOS)
    if source.mode != "RGB":
        source = source.convert("RGB")
    buffer = io.BytesIO()
    source.save(buffer, format="JPEG", quality=72)
    return base64.b64encode(buffer.getvalue()).decode("ascii"), "image/jpeg"
