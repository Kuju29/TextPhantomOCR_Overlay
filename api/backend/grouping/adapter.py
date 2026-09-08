"""Strict adapter from Lens graph core IDs to ``tp.grouping-result/2``.

The graph core decides membership and ruby retention; this adapter proves that
decision still matches the exact raw tree and document mapping.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
from typing import Any

from .contracts import (
    GROUPING_CORE_SCHEMA,
    GROUPING_RESULT_SCHEMA,
    GROUP_SOURCE_SCHEMA,
    GroupingResultError,
)

_LETTER_CATEGORIES = {"L"}


def _fail(code: str, **details: Any) -> None:
    raise GroupingResultError(code, details)


_MAX_SAFE_INTEGER = (1 << 53) - 1


def _canonical_json_value(value: Any, path: str = "$") -> str:
    """Serialize a JSON value identically in Python and ECMAScript.

    Native decimal printers are not a wire contract: for example Python emits
    ``4.5e-06`` where ``JSON.stringify`` emits ``0.0000045``.  Lens span
    timings contain exactly those small finite values.  Integral numbers use
    their safe decimal value and fractional numbers use their IEEE-754 binary64
    bits, so no rounding or exponent spelling can change the fingerprint.
    """
    if value is None:
        return "n"
    if isinstance(value, bool):
        return "t" if value else "f"
    if isinstance(value, str):
        return "s" + json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int):
        if abs(value) > _MAX_SAFE_INTEGER:
            _fail("raw_tree_not_canonical_json", path=path, valueType="unsafe_integer")
        return f"i{value};"
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail("raw_tree_not_canonical_json", path=path, valueType="nonfinite_float")
        if value.is_integer():
            integer = int(value)
            if abs(integer) > _MAX_SAFE_INTEGER:
                _fail("raw_tree_not_canonical_json", path=path, valueType="unsafe_integer")
            return f"i{integer};"
        return "d" + struct.pack(">d", value).hex() + ";"
    if isinstance(value, (list, tuple)):
        return "a[" + ",".join(
            _canonical_json_value(item, f"{path}[{index}]")
            for index, item in enumerate(value)
        ) + "]"
    if isinstance(value, dict):
        bad_key = next((key for key in value if not isinstance(key, str)), None)
        if bad_key is not None:
            _fail(
                "raw_tree_not_canonical_json", path=path,
                valueType=f"non_string_key:{type(bad_key).__name__}",
            )
        # ECMAScript Array.sort compares UTF-16 code units.  Match that order
        # even for non-BMP keys instead of relying on Python code-point order.
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", "surrogatepass"))
        return "o{" + ",".join(
            json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" +
            _canonical_json_value(value[key], f"{path}.{key}")
            for key in keys
        ) + "}"
    _fail(
        "raw_tree_not_canonical_json", path=path,
        valueType=f"{type(value).__module__}.{type(value).__qualname__}",
    )


def raw_tree_fingerprint(raw_tree: dict[str, Any]) -> str:
    """Hash the complete local raw tree; never trust caller hashes."""
    try:
        payload = _canonical_json_value(raw_tree).encode("utf-8")
    except GroupingResultError:
        raise
    except (TypeError, ValueError, RecursionError) as exc:
        raise GroupingResultError("raw_tree_not_canonical_json") from exc
    return hashlib.sha256(payload).hexdigest()


def _paragraph_id(paragraph: dict[str, Any], position: int) -> str:
    value = str(paragraph.get("id") or "").strip()
    # Lens graph nodes and the Extension document contract both use p{index}
    # for decoder trees that do not carry an explicit id.
    return value or f"p{position}"


def _paragraph_text(paragraph: dict[str, Any]) -> str:
    text = str(paragraph.get("text") or "").strip()
    if text:
        return text
    return " ".join(
        str(item.get("text") or "").strip()
        for item in (paragraph.get("items") or [])
        if isinstance(item, dict) and str(item.get("text") or "").strip()
    ).strip()


def _has_letter(text: str) -> bool:
    import unicodedata
    return any(unicodedata.category(char)[:1] in _LETTER_CATEGORIES for char in text)


def _mapping_value(raw_to_document: list[Any] | dict[str, Any], position: int, raw_id: str) -> Any:
    if isinstance(raw_to_document, list):
        return raw_to_document[position] if position < len(raw_to_document) else None
    if isinstance(raw_to_document, dict):
        if raw_id in raw_to_document:
            return raw_to_document[raw_id]
        return raw_to_document.get(str(position))
    _fail("mapping_invalid_type")


def _member_translation(
    paragraph: dict[str, Any], policy: dict[str, Any], raw_id: str,
) -> tuple[str, str | None, int]:
    source = _paragraph_text(paragraph)
    mode = str(policy.get("mode") or "full")
    if mode == "full":
        if policy.keys() - {"mode"}:
            _fail("full_policy_has_extra_fields", rawId=raw_id)
        return source, None, 0
    if mode == "whole_ruby":
        if policy.keys() - {"mode"}:
            _fail("whole_ruby_policy_has_extra_fields", rawId=raw_id)
        return "", "whole_ruby", 0
    if mode == "retained_ruby":
        if policy.keys() - {"mode"}:
            _fail("retained_ruby_policy_has_extra_fields", rawId=raw_id)
        return "", "ruby_text", 0
    if mode != "item_subset":
        _fail("member_policy_unknown", rawId=raw_id, mode=mode)

    retained = policy.get("retainedItemIndices")
    separator = policy.get("separator")
    if not isinstance(retained, list) or separator not in ("", " "):
        _fail("item_subset_policy_invalid", rawId=raw_id)
    if retained != sorted(set(retained)) or any(not isinstance(i, int) for i in retained):
        _fail("retained_item_order_invalid", rawId=raw_id)
    items = list(paragraph.get("items") or [])
    if any(index < 0 or index >= len(items) for index in retained):
        _fail("retained_item_unknown", rawId=raw_id)
    all_text_indices = [
        index for index, item in enumerate(items)
        if isinstance(item, dict) and str(item.get("text") or "").strip()
    ]
    if not retained or any(index not in all_text_indices for index in retained):
        _fail("retained_item_empty", rawId=raw_id)
    dropped = len(all_text_indices) - len(retained)
    if dropped <= 0:
        _fail("item_subset_removed_nothing", rawId=raw_id)
    translated = str(separator).join(
        str(items[index].get("text") or "").strip() for index in retained
    ).strip()
    return translated, None, dropped


def adapt_grouping_result(
    core_result: dict[str, Any],
    raw_tree: dict[str, Any],
    raw_to_document: list[Any] | dict[str, Any],
) -> dict[str, Any]:
    """Validate and adapt one core result while preserving declared order."""
    if not isinstance(core_result, dict) or core_result.get("schema") != GROUPING_CORE_SCHEMA:
        _fail("core_schema_invalid")
    actual_fingerprint = raw_tree_fingerprint(raw_tree)
    if core_result.get("treeFingerprint") != actual_fingerprint:
        _fail("tree_fingerprint_mismatch")
    status = str(core_result.get("status") or "")
    if status not in {"usable", "not_needed", "unresolved"}:
        _fail("core_status_invalid", status=status)
    unresolved = core_result.get("unresolvedIds")
    if not isinstance(unresolved, list):
        _fail("unresolved_ids_invalid")
    if status == "unresolved" or unresolved:
        _fail("grouping_unresolved", unresolvedIds=[str(value) for value in unresolved])
    groups_in = core_result.get("groups")
    if not isinstance(groups_in, list):
        _fail("core_groups_invalid")

    paragraphs = list(raw_tree.get("paragraphs") or [])
    by_id: dict[str, tuple[int, dict[str, Any]]] = {}
    for position, paragraph in enumerate(paragraphs):
        if not isinstance(paragraph, dict):
            _fail("raw_paragraph_invalid", position=position)
        raw_id = _paragraph_id(paragraph, position)
        if raw_id in by_id:
            _fail("raw_paragraph_id_duplicate", rawId=raw_id)
        by_id[raw_id] = (position, paragraph)
    eligible = {raw_id for raw_id, (_, para) in by_id.items() if _paragraph_text(para)}
    owner: dict[str, str] = {}
    mapped_owner: dict[int, str] = {}
    groups_out: list[dict[str, Any]] = []
    total_ruby_paragraphs_dropped = 0
    seen_group_ids: set[str] = set()

    for group_position, group in enumerate(groups_in):
        if not isinstance(group, dict):
            _fail("core_group_invalid", position=group_position)
        group_id = str(group.get("id") or "")
        if not group_id:
            _fail("core_group_id_missing", position=group_position)
        if group_id in seen_group_ids:
            _fail("core_group_id_duplicate", groupId=group_id)
        seen_group_ids.add(group_id)
        member_ids = group.get("memberIds")
        policies = group.get("memberPolicies")
        separator = group.get("separator")
        if not isinstance(member_ids, list) or not isinstance(policies, dict) or separator not in ("", " "):
            _fail("core_group_contract_invalid", groupId=group_id)
        members_out = []
        paragraph_ids = []
        full_parts = []
        translation_parts = []
        ruby_items_dropped = ruby_paragraphs_dropped = 0
        for raw_value in member_ids:
            raw_id = str(raw_value)
            if raw_id not in by_id:
                _fail("core_member_unknown", groupId=group_id, rawId=raw_id)
            if raw_id in owner:
                _fail("core_member_duplicate", rawId=raw_id, firstGroup=owner[raw_id], secondGroup=group_id)
            owner[raw_id] = group_id
            position, paragraph = by_id[raw_id]
            policy = policies.get(raw_id)
            if not isinstance(policy, dict):
                _fail("member_policy_missing", groupId=group_id, rawId=raw_id)
            translation, omission, dropped_items = _member_translation(paragraph, policy, raw_id)
            source = _paragraph_text(paragraph)
            mapped = _mapping_value(raw_to_document, position, raw_id)
            if omission == "whole_ruby":
                if mapped is not None:
                    _fail("whole_ruby_mapping_present", rawId=raw_id)
                ruby_paragraphs_dropped += 1
            else:
                if not isinstance(mapped, int) or isinstance(mapped, bool) or mapped < 0:
                    _fail("member_mapping_missing", rawId=raw_id)
                if mapped in mapped_owner:
                    _fail("document_mapping_duplicate", documentIndex=mapped, rawId=raw_id)
                mapped_owner[mapped] = raw_id
                paragraph_ids.append(f"p{mapped}")
                translation_parts.append(translation)
            ruby_items_dropped += dropped_items
            full_parts.append(source)
            members_out.append({
                "rawId": raw_id,
                "rawParagraphIndex": position,
                "documentParagraphId": None if omission == "whole_ruby" else f"p{mapped}",
                "sourceText": source,
                "translationText": translation,
                "omission": omission,
                "rubyItemsDropped": dropped_items,
            })
        text = str(separator).join(part for part in translation_parts if part).strip()
        full_text = str(separator).join(part for part in full_parts if part).strip()
        if _has_letter(full_text) and not _has_letter(text):
            _fail("letters_collapsed", groupId=group_id)
        if not paragraph_ids:
            _fail("group_has_no_document_members", groupId=group_id)
        out = {
            "id": group_id,
            "paragraphIds": paragraph_ids,
            "text": text,
            "rubyItemsDropped": ruby_items_dropped,
            "rubyParagraphsDropped": ruby_paragraphs_dropped,
            "sourceContract": {
                "version": GROUP_SOURCE_SCHEMA,
                "separator": separator,
                "members": members_out,
                "fullParts": full_parts,
                "translationParts": translation_parts,
            },
        }
        for source_key, target_key in (
            ("direction", "direction"), ("rotation", "rotation"),
            ("bounds", "boundsPx"), ("fontPx", "fontPx"),
            ("orientationFallback", "orientationFallback"),
        ):
            if source_key in group:
                out[target_key] = group[source_key]
        groups_out.append(out)
        total_ruby_paragraphs_dropped += ruby_paragraphs_dropped

    missing = sorted(eligible - set(owner))
    unexpected = sorted(set(owner) - eligible)
    if missing:
        _fail("eligible_members_missing", rawIds=missing)
    if unexpected:
        _fail("blank_members_grouped", rawIds=unexpected)
    partition = [[group["id"], group["paragraphIds"]] for group in groups_out]
    partition_hash = hashlib.sha256(
        json.dumps(partition, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    ).hexdigest()
    return {
        "schema": GROUPING_RESULT_SCHEMA,
        "status": status,
        "treeFingerprint": actual_fingerprint,
        "groups": groups_out,
        "coverage": {
            "eligible": len(eligible),
            "assigned": len(eligible) - total_ruby_paragraphs_dropped,
            "excludedRuby": total_ruby_paragraphs_dropped,
            "unresolved": 0,
        },
        "partitionHash": partition_hash,
    }
