"""Payload image resolution and temporary-file lifecycle helpers."""

from __future__ import annotations

from collections.abc import Iterator

import os, contextlib, tempfile

import binascii

from backend.utils.images import data_uri_to_bytes, download


class InvalidImageInput(ValueError):
    """The request's OWN image bytes (data URL / upload) are empty or not an image.

    Answered 422 ``invalid_image``: resending the same bytes cannot succeed.
    """

    code = "invalid_image"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.tp_stage = "image_decode"
        self.requestDispatched = False


class ImageFetchFailed(RuntimeError):
    """A SERVER-SIDE download returned no usable image (empty body, HTML page,
    undecodable bytes).

    Stamped ``image_fetch`` so the answer is 502 ``image_fetch_failed``; clients
    then fetch the image in the browser (with the page's cookies) and resend it
    inline (old 2026.9.27.26 background/pipeline/server-translation.js:283).
    """

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.tp_stage = "image_fetch"
        self.requestDispatched = False


def image_source_kind(payload: dict) -> str:
    """``inline`` (data URL in the request), ``download`` (server fetches src) or ``none``."""
    if payload.get("imageDataUri"):
        return "inline"
    src = str(payload.get("src") or "").strip()
    if src.startswith("data:"):
        return "inline"
    return "download" if src else "none"


def _inline_bytes(data_uri: str) -> tuple[bytes, str]:
    try:
        blob, mime = data_uri_to_bytes(data_uri)
    except (binascii.Error, ValueError) as exc:
        raise InvalidImageInput("the image data URL is not valid base64") from exc
    if not blob:
        raise InvalidImageInput("the image data URL is empty")
    return blob, mime


def extract_image_bytes(payload: dict) -> tuple[bytes, str]:
    """Resolve a payload's image into ``(bytes, mime)``.

    Source priority: explicit ``imageDataUri`` -> ``src`` data URI ->
    download ``src`` (with the page URL as referer).
    """
    src = (payload.get("src") or "").strip()
    if payload.get("imageDataUri"):
        return _inline_bytes(payload["imageDataUri"])
    if src.startswith("data:"):
        return _inline_bytes(src)
    if not src:
        raise InvalidImageInput("No image data: the request has neither imageDataUri nor src")

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    page_url = str((context or {}).get("page_url") or "").strip()
    return download(src, page_url)


def fetch_and_check(payload: dict) -> tuple[bytes, str]:
    """Server-side download plus a header-only image check (image-fetch lane).

    Runs before the request waits for Lens, so an HTML/empty/undecodable
    "image" fails in milliseconds with ``image_fetch_failed`` instead of after
    a Lens queue turn. Transport/HTTP errors keep their own stage stamp.
    """
    try:
        blob, mime = extract_image_bytes(payload)
    except BaseException as exc:
        if getattr(exc, "tp_stage", None) is None:
            try:
                exc.tp_stage = "image_fetch"  # type: ignore[attr-defined]
            except Exception:
                pass
        raise
    check_downloaded_image(blob)
    return blob, mime


def check_downloaded_image(blob: bytes) -> None:
    if not blob:
        raise ImageFetchFailed("the image URL returned an empty body")
    import io
    from PIL import Image
    try:
        with Image.open(io.BytesIO(blob)) as img:
            img.size  # header parse only; full decode happens in the pipeline
    except Exception as exc:  # noqa: BLE001 - any parse failure means "not an image"
        head = blob[:64].lstrip().lower()
        kind = "an HTML page" if head.startswith((b"<!doctype", b"<html", b"<head", b"<body", b"<h1")) else "bytes that are not a readable image"
        raise ImageFetchFailed(f"the image URL returned {kind}") from exc

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
