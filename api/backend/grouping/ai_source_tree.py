"""Build the sole source-text tree consumed by AI translation.

The decoded Lens tree is immutable evidence for fingerprints, erasure and
render geometry.  Grouping produces this separate, versioned logical tree so
AI consumers never have to reinterpret ``bubble_groups`` or rebuild ordering.
"""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

from .adapter import raw_tree_fingerprint
from .detector_free_helpers import paragraph_id, paragraph_text


CANONICAL_ORIGINAL_TREE_SCHEMA = "tp.canonical-original-tree/1"


class AiSourceTreeError(RuntimeError):
    def __init__(self, code: str, details: dict[str, Any] | None = None):
        self.code = str(code)
        self.details = dict(details or {})
        super().__init__(self.code)


def _stable_id(fingerprint: str, raw_ids: list[str]) -> str:
    material = json.dumps(
        [fingerprint, raw_ids], ensure_ascii=True, separators=(",", ":")
    ).encode("ascii")
    return "as_" + hashlib.sha256(material).hexdigest()[:20]


def build_ai_source_tree(
    raw_tree: dict[str, Any], grouping_result: dict[str, Any]
) -> dict[str, Any]:
    """Create a deterministic logical paragraph tree from one proved partition."""
    if not isinstance(raw_tree, dict):
        raise AiSourceTreeError("ai_source_raw_tree_invalid")
    if not isinstance(grouping_result, dict):
        raise AiSourceTreeError("ai_source_grouping_result_invalid")
    fingerprint = raw_tree_fingerprint(raw_tree)
    if grouping_result.get("treeFingerprint") != fingerprint:
        raise AiSourceTreeError("ai_source_tree_fingerprint_mismatch")
    if grouping_result.get("status") != "usable":
        raise AiSourceTreeError("ai_source_grouping_not_usable")

    raw_paragraphs = list(raw_tree.get("paragraphs") or [])
    expected = {
        paragraph_id(paragraph, index)
        for index, paragraph in enumerate(raw_paragraphs)
        if isinstance(paragraph, dict) and paragraph_text(paragraph).strip()
    }
    owners: dict[str, str] = {}
    paragraphs: list[dict[str, Any]] = []
    raw_to_ai: dict[str, str | None] = {}

    for position, group in enumerate(grouping_result.get("groups") or []):
        if not isinstance(group, dict):
            raise AiSourceTreeError("ai_source_group_invalid", {"position": position})
        contract = group.get("sourceContract")
        if not isinstance(contract, dict) or contract.get("version") != "tp.group-source/2":
            raise AiSourceTreeError("ai_source_contract_invalid", {"position": position})
        members = contract.get("members")
        if not isinstance(members, list) or not members:
            raise AiSourceTreeError("ai_source_members_missing", {"position": position})

        raw_ids: list[str] = []
        raw_indices: list[int] = []
        document_ids: list[str] = []
        source_items: list[dict[str, Any]] = []
        omitted: list[dict[str, Any]] = []
        for member in members:
            if not isinstance(member, dict):
                raise AiSourceTreeError("ai_source_member_invalid", {"position": position})
            raw_id = str(member.get("rawId") or "")
            raw_index = member.get("rawParagraphIndex")
            if (not raw_id or not isinstance(raw_index, int) or isinstance(raw_index, bool)
                    or raw_index < 0 or raw_index >= len(raw_paragraphs)):
                raise AiSourceTreeError("ai_source_member_identity_invalid", {"position": position})
            if raw_id in owners:
                raise AiSourceTreeError(
                    "ai_source_member_duplicate",
                    {"rawId": raw_id, "first": owners[raw_id], "second": position},
                )
            if paragraph_id(raw_paragraphs[raw_index], raw_index) != raw_id:
                raise AiSourceTreeError("ai_source_member_position_mismatch", {"rawId": raw_id})
            raw_ids.append(raw_id)
            raw_indices.append(raw_index)
            owners[raw_id] = str(position)
            document_id = member.get("documentParagraphId")
            if document_id is None:
                raw_to_ai[raw_id] = None
                omitted.append({"rawId": raw_id, "reason": str(member.get("omission") or "")})
                continue
            document_ids.append(str(document_id))
            if member.get("omission"):
                omitted.append({"rawId": raw_id, "reason": str(member["omission"])})
            source_items.extend(copy.deepcopy(raw_paragraphs[raw_index].get("items") or []))

        canonical_id = raw_ids[0] if len(raw_ids) == 1 else _stable_id(fingerprint, raw_ids)
        for raw_id in raw_ids:
            if raw_id not in raw_to_ai:
                raw_to_ai[raw_id] = canonical_id
        separator = str(contract.get("separator") or "")
        text = separator.join(
            str(value) for value in contract.get("translationParts") or [] if str(value)
        ).strip()
        if document_ids and not text:
            raise AiSourceTreeError("ai_source_text_missing", {"id": canonical_id})
        canonical_paragraph = copy.deepcopy(raw_paragraphs[raw_indices[0]])
        raw_members = [raw_paragraphs[index] for index in raw_indices]
        starts = [member.get("start_raw") for member in raw_members
                  if isinstance(member.get("start_raw"), int)]
        ends = [member.get("end_raw") for member in raw_members
                if isinstance(member.get("end_raw"), int)]
        canonical_paragraph.update({
            "id": canonical_id,
            "para_index": canonical_paragraph.get("para_index", raw_indices[0]),
            "direction": str(group.get("direction") or ""),
            "rotation_deg": float(group.get("rotation") or 0.0),
            "text": text,
            "bounds_px": copy.deepcopy(group.get("boundsPx")),
            "font_size_px": float(group.get("fontPx") or 0.0),
            "para_font_size_px": float(group.get("fontPx") or
                                       canonical_paragraph.get("para_font_size_px") or 0.0),
            "items": source_items,
            "ai_eligible": bool(document_ids),
            "source": {
                "contract": "tp.ai-source-members/1",
                "rawParagraphIds": raw_ids,
                "rawParagraphIndices": raw_indices,
                "documentParagraphIds": document_ids,
            "separator": separator,
                "fullParts": [str(value) for value in contract.get("fullParts") or []],
                "translationParts": [str(value) for value in contract.get("translationParts") or []],
                "omittedParagraphs": omitted,
                "rubyItemsDropped": int(group.get("rubyItemsDropped") or 0),
            },
        })
        if starts:
            canonical_paragraph["start_raw"] = min(starts)
        if ends:
            canonical_paragraph["end_raw"] = max(ends)
        paragraphs.append(canonical_paragraph)

    actual = set(owners)
    if actual != expected:
        raise AiSourceTreeError(
            "ai_source_coverage_mismatch",
            {"missing": sorted(expected - actual), "unknown": sorted(actual - expected)},
        )
    return {
        "schema": CANONICAL_ORIGINAL_TREE_SCHEMA,
        "side": "OriginalCanonical",
        "sourceTreeFingerprint": fingerprint,
        "paragraphs": paragraphs,
        "rawToAiSource": raw_to_ai,
        "coverage": {
            "rawParagraphs": len(expected),
            "ownedParagraphs": len(actual),
            "canonicalParagraphs": len(paragraphs),
            "complete": True,
        },
    }


def require_ai_source_tree(tree: Any) -> dict[str, Any]:
    if (not isinstance(tree, dict)
            or tree.get("schema") != CANONICAL_ORIGINAL_TREE_SCHEMA):
        raise AiSourceTreeError("ai_source_tree_required")
    paragraphs = tree.get("paragraphs")
    if not isinstance(paragraphs, list):
        raise AiSourceTreeError("ai_source_paragraphs_invalid")
    if not isinstance(tree.get("coverage"), dict) or tree["coverage"].get("complete") is not True:
        raise AiSourceTreeError("ai_source_coverage_incomplete")
    return tree
