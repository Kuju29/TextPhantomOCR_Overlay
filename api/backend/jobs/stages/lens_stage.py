"""Lens acquisition and canonical tree decoding."""

from __future__ import annotations

from typing import Any

import time

from backend.config import settings
from backend import trace
from backend.geometry_diagnostics import geometry_diagnostics, ruby_diagnostics
from backend.lens import client, document
from backend.lens.tree import decode_tree
from backend.lens.furigana import strip_furigana_trees
from backend.utils.images import bytes_to_data_uri, download

def fetch(image_path: str, target_lang: str, supplied: dict[str, Any] | None) -> tuple[dict[str, Any], float]:
    if isinstance(supplied, dict):
        return supplied, 0.0
    started = time.perf_counter()
    raw = client.fetch_lens_data(image_path, target_lang, settings.firebase_url)
    return (raw if isinstance(raw, dict) else {}), round((time.perf_counter() - started) * 1000, 1)

def decode(data: dict[str, Any], width: int, height: int) -> tuple[dict, dict]:
    original = decode_tree(
        data.get("originalParagraphs") or [], data.get("originalTextFull") or "", "original", width, height
    )
    original["source_lang"] = str(data.get("originalContentLanguage") or "").strip()
    translated = decode_tree(
        data.get("translatedParagraphs") or [], data.get("translatedTextFull") or "", "translated", width, height
    )
    before_filter = original
    original, translated, report = strip_furigana_trees(
        original, translated, source_lang=original.get("source_lang") or "", img_w=width, img_h=height
    )
    if trace.enabled():
        trace.note("sourceGeometry", ruby_diagnostics(report))
        if report.get("itemsDropped") or report.get("spansDropped") or report.get("ambiguousCandidates"):
            for event in geometry_diagnostics(before_filter, width, height) + geometry_diagnostics(original, width, height, "clean_geometry"):
                trace.note("sourceGeometry", event)
    original["furigana_filter"] = report
    return original, translated

def direct_image(data: dict[str, Any], image_path: str) -> str:
    image_url = data.get("imageUrl")
    if image_url:
        decoded = client.decode_image_url_to_data_uri(str(image_url))
        if decoded:
            return decoded
        if isinstance(image_url, str) and image_url.startswith(("http://", "https://")):
            blob, mime = download(image_url)
            return bytes_to_data_uri(blob, mime or "image/jpeg")
    with open(image_path, "rb") as handle:
        return bytes_to_data_uri(handle.read(), "image/jpeg")

def build_document(original: dict, translated: dict, width: int, height: int, source_lang: str, target_lang: str) -> dict:
    return document.build(
        original, translated, width=width, height=height,
        source_lang=source_lang, target_lang=target_lang,
    )
