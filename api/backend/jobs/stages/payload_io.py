"""Payload image resolution and temporary-file lifecycle helpers."""

from __future__ import annotations

from collections.abc import Iterator

import os, contextlib, tempfile

from backend.utils.images import data_uri_to_bytes, download

def extract_image_bytes(payload: dict) -> tuple[bytes, str]:
    """Resolve a payload's image into ``(bytes, mime)``.

    Source priority: explicit ``imageDataUri`` -> ``src`` data URI ->
    download ``src`` (with the page URL as referer).
    """
    src = (payload.get("src") or "").strip()
    if payload.get("imageDataUri"):
        return data_uri_to_bytes(payload["imageDataUri"])
    if src.startswith("data:"):
        return data_uri_to_bytes(src)

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    page_url = str((context or {}).get("page_url") or "").strip()
    return download(src, page_url)

@contextlib.contextmanager
def temporary_image_file(image_bytes: bytes, mime: str) -> Iterator[str]:
    """Write image bytes to a temporary path and always remove it afterward."""
    suffix = ".png" if (mime or "").endswith("png") else ".jpg"
    handle = None
    path = ""
    try:
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        path = handle.name
        handle.write(image_bytes)
        handle.close()
        handle = None
        yield path
    finally:
        if handle is not None:
            try:
                handle.close()
            except Exception:
                # Cleanup of the created path must still be attempted when a
                # write or close operation is the original failure.
                pass
        try:
            if path:
                os.unlink(path)
        except OSError:
            pass
