"""Page/unit ownership and automatic replay branching; never edits old answers."""
from __future__ import annotations
import hashlib
import json
import re


MAX_ORIGINAL_ID_CHARS = 160
CONVERSATION_ID_RE = re.compile(r"I([1-9][0-9]{0,6})_P([0-9]{1,6})")
LEGACY_WIRE_ID_RE = re.compile(r"P[0-9]{1,6}")


class OriginValidationError(ValueError):
    """Typed mapping error; diagnostics describe structure, never source values."""
    code = "ai_conversation_origin_invalid"
    stage = "conversation_mapping"
    requestDispatched = False
    providerAttempts = 0
    generationAttempts = 0

    def __init__(self, field, reason):
        self.validation = {"field": field, "reason": reason}
        super().__init__("Conversation source mapping is invalid")


def _original_id(value):
    # Original IDs belong to the OCR/document, not to the model's Pn protocol.
    # Keep them opaque and case-sensitive (g0, p0, UUID, etc.), without coercion.
    return (isinstance(value, str) and 0 < len(value) <= MAX_ORIGINAL_ID_CHARS
            and value == value.strip()
            and not re.search(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]", value))


def checked_origins(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 128:
        raise OriginValidationError("conversation.origins", "invalid_page_list")
    result, seen, pages = [], set(), set()
    for index, item in enumerate(value):
        field = f"conversation.origins.{index}"
        if not isinstance(item, dict):
            raise OriginValidationError(field, "invalid_page_origin")
        ids, originals = item.get("unitIds"), item.get("originalIds")
        if (not isinstance(ids, list) or not ids or len(ids) > 2000
                or not isinstance(originals, list) or len(ids) != len(originals)):
            raise OriginValidationError(field, "incomplete_mapping")
        local = set()
        for position, uid in enumerate(ids):
            if not isinstance(uid, str) or not (CONVERSATION_ID_RE.fullmatch(uid) or LEGACY_WIRE_ID_RE.fullmatch(uid)):
                raise OriginValidationError(f"{field}.unitIds.{position}", "invalid_wire_id")
            match = CONVERSATION_ID_RE.fullmatch(uid)
            if match and isinstance(item.get("pageOrder"), int) and int(match.group(1)) != item["pageOrder"]:
                raise OriginValidationError(f"{field}.unitIds.{position}", "image_id_mismatch")
            if uid in seen or uid in local:
                raise OriginValidationError(f"{field}.unitIds.{position}", "duplicate_wire_id")
            local.add(uid)
        original_seen = set()
        for position, uid in enumerate(originals):
            if not _original_id(uid):
                raise OriginValidationError(f"{field}.originalIds.{position}", "invalid_source_id")
            if uid in original_seen:
                raise OriginValidationError(f"{field}.originalIds.{position}", "duplicate_source_id")
            original_seen.add(uid)
        seen.update(local)
        if len(seen) > 2000:
            raise OriginValidationError("conversation.origins", "too_many_wire_ids")
        page = item.get("pageId")
        if not _original_id(page):
            raise OriginValidationError(f"{field}.pageId", "invalid_page_id")
        if page in pages:
            raise OriginValidationError(f"{field}.pageId", "duplicate_page_id")
        pages.add(page)
        row = {"pageId": page, "unitIds": list(ids), "originalIds": list(originals)}
        for key in ("pageIndex", "pageOrder"):
            v = item.get(key)
            if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 10_000_000:
                row[key] = v
        fingerprint = item.get("sourceFingerprint", "")
        if not isinstance(fingerprint, str) or (fingerprint and not re.fullmatch(r"[a-f0-9]{64}", fingerprint)):
            raise OriginValidationError(f"{field}.sourceFingerprint", "invalid_fingerprint")
        row["sourceFingerprint"] = fingerprint
        result.append(row)
    return result


def validate_source_order(rows, source_ids):
    """At the API batch ingress IDs already name the current Pn wire sequence."""
    if rows and [uid for row in rows for uid in row["unitIds"]] != list(source_ids):
        raise OriginValidationError("conversation.origins", "source_order_mismatch")
    return rows


def current_origins(description, source_texts):
    rows = checked_origins(description.get("origins"))
    if rows:
        return rows
    if not description.get("pageId"):
        return []
    return [{**{k:description[k] for k in ("pageId", "pageIndex", "pageOrder") if k in description},
        "unitIds":[f"P{i}" for i in range(len(source_texts))],
        "originalIds":[f"P{i}" for i in range(len(source_texts))],
        "sourceFingerprint":hashlib.sha256(json.dumps(source_texts,ensure_ascii=False).encode()).hexdigest()}]


def branch_history(history, origins, order_policy="request_arrival"):
    def page_key(p):
        return ("index",p["pageIndex"]) if p.get("pageIndex") is not None else ("id",p.get("pageId"))
    for index, turn in enumerate(history):
        for old in turn.get("pages", []):
            for new in origins:
                if page_key(old) == page_key(new):
                    changed = old.get("sourceFingerprint") and new.get("sourceFingerprint") and old["sourceFingerprint"] != new["sourceFingerprint"]
                    if changed or set(old.get("originalIds", [])) & set(new.get("originalIds", [])):
                        return history[:index], "source_changed" if changed else "source_replayed"
                elif order_policy == "document_enqueue" and old.get("pageIndex") is not None and new.get("pageIndex") is not None and old["pageIndex"] > new["pageIndex"]:
                    return history[:index], "source_order_rewound"
    return history, "none"


def boundaries(origins, locale):
    # Stable image/unit IDs make repeated page-boundary prose unnecessary.
    if origins and all(CONVERSATION_ID_RE.fullmatch(uid) for row in origins for uid in row.get("unitIds", [])):
        return ""
    if len(origins) < 2:
        return ""
    title = {"th":"ขอบเขตภาพ — ID แต่ละกลุ่มเป็นคนละภาพ ไม่ได้ระบุผู้พูด", "ja":"ページ境界 — IDの組は別の画像です。話者を表しません。"}.get(locale,
        "Page boundaries — each ID group belongs to a separate image, not a speaker")
    return title + "\n" + "\n".join(f"{i+1}: " + ", ".join(row["unitIds"]) for i,row in enumerate(origins)) + "\n\n"
