"""Validated, data-only selection and private conversation ownership."""
from __future__ import annotations
import hashlib
import json
from collections.abc import Mapping

MODES = ("independent", "conversation")
POLICY = "conversation-bootstrap-once-2026.10.4.36"


def mode(value=None, *, default="conversation") -> str:
    if value is None or value == "":
        return default
    if not isinstance(value, str) or value not in MODES:
        raise ValueError("translation mode must be conversation or independent")
    return value


def descriptor(value=None, *, context=None, metadata=None, caller="") -> dict:
    """Never accept client-supplied assistant history or a raw provider key here."""
    if value is not None and not isinstance(value, Mapping):
        raise ValueError("conversation must be an object")
    value = value if isinstance(value, Mapping) else {}
    if any(k in value for k in ("history", "messages", "api_key", "apiKey", "assistant")):
        raise ValueError("Conversation history is owned by the translation path, not the request")
    context = context if isinstance(context, Mapping) else {}
    metadata = metadata if isinstance(metadata, Mapping) else {}
    doc = value.get("documentId") or context.get("page_url") or ""
    owner = context.get("tp_tab_session") or caller or ""
    out = {"documentId": hashlib.sha256(str(doc).encode()).hexdigest() if doc else "",
           "owner": hashlib.sha256(str(owner).encode()).hexdigest() if owner else "",
           "reset": "automatic",
           "branch": "repair" if value.get("branch") == "repair" else "initial",
           "pageId": str(value.get("pageId") or metadata.get("image_id") or "")[:160],
           "orderPolicy": "request_arrival"}
    run = value.get("webchatRunId")
    if run is not None:
        import re
        if not isinstance(run, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", run):
            raise ValueError("conversation.webchatRunId is invalid")
        out["webchatRunId"] = run
    if value.get("orderPolicy") == "document_enqueue":
        out["orderPolicy"] = "document_enqueue"
    for key in ("pageIndex", "pageOrder"):
        n = value.get(key, metadata.get("page_index"))
        if isinstance(n, int) and not isinstance(n, bool) and 0 <= n < 10_000_000:
            out[key] = n
    from .origins import checked_origins
    if value.get("origins") is not None:
        out["origins"] = checked_origins(value["origins"])
    return out


def scope_material(ai, target_lang: str) -> str | None:
    """Privacy scope is caller + document + credential, never Provider+language."""
    d = ai.conversation or {}
    if not d.get("documentId") or not d.get("owner"):
        return None  # unscoped tools get a fresh, explicitly reported conversation
    return json.dumps({"owner": d["owner"], "document": d["documentId"], "reset": d.get("reset", "0"),
        **({"webchatRunId":d["webchatRunId"]} if d.get("webchatRunId") else {}),
        "provider": ai.provider, "model": ai.model, "endpoint": ai.base_url,
        # OCR detection can differ between a single page and a multi-page batch.
        # The same document/run still owns one thread; prompt compatibility below
        # separates any actual change to the instruction bytes.
        "key": ai.api_key, "target": target_lang,
        "prompt": ai.prompt_editable, "promptMode": ai.prompt_mode,
        "examples": "human20" if getattr(ai, "style_examples", False) is True else "none",
        "memoryMode": ai.memory_mode,
        "thinking": ai.thinking, "image": bool(ai.send_image or ai.image_b64),
        "contract": ai.output_contract, "policy": POLICY}, sort_keys=True, ensure_ascii=False)
