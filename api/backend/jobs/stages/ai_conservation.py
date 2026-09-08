"""Loss/duplication guard for the OCR-group-AI content boundary."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from backend.ai import markers
from backend.render.paragraphs import paragraph_text


class AiInputConservationError(RuntimeError):
    pass


def require_ai_input_conservation(
    original_tree: dict[str, Any] | None,
    bubble_groups: list[dict[str, Any]],
    unit_indices: list[list[int]],
    unit_texts: list[str],
) -> dict[str, Any]:
    """Prove exact source content and membership before provider dispatch.

    Comparisons are exact after only the existing builder operations:
    ``str``, outer ``strip`` and the declared separator.  We deliberately do
    not case-fold, Unicode-normalise or remove punctuation.
    """
    paragraphs = list((original_tree or {}).get("paragraphs") or [])
    source_parts = [str(paragraph_text(para) or "").strip() for para in paragraphs]
    eligible = {index for index, text in enumerate(source_parts) if text}
    errors: list[dict[str, Any]] = []
    contract_raw_ids: set[str] = set()
    contract_raw_indices: set[int] = set()

    for group_index, group in enumerate(bubble_groups):
        indices = [int(value) for value in (group.get("para_indices") or [])]
        contract = group.get("source_contract")
        if not isinstance(contract, dict) or contract.get("version") != "tp.group-source/2":
            errors.append({"group": group_index, "reason": "missing_source_contract"})
            continue
        full_parts = contract.get("fullParts")
        translation_parts = contract.get("translationParts")
        members = contract.get("members")
        separator = contract.get("separator")
        if not isinstance(full_parts, list) or not isinstance(translation_parts, list) or not isinstance(members, list) or separator not in ("", " "):
            errors.append({"group": group_index, "reason": "invalid_source_contract"})
            continue
        if any(index < 0 or index >= len(source_parts) for index in indices):
            errors.append({"group": group_index, "reason": "unknown_paragraph"})
            continue
        proven_full: list[str] = []
        proven_translation: list[str] = []
        proven_indices: list[int] = []
        raw_ids: set[str] = set()
        ruby_items = ruby_paragraphs = 0
        for member in members:
            if not isinstance(member, dict):
                errors.append({"group": group_index, "reason": "member_contract_invalid"})
                continue
            raw_id = str(member.get("rawId") or "")
            raw_index = member.get("rawParagraphIndex")
            source_text = str(member.get("sourceText") or "").strip()
            translation_text = str(member.get("translationText") or "").strip()
            dropped = member.get("rubyItemsDropped", 0)
            if (not raw_id or raw_id in raw_ids or raw_id in contract_raw_ids
                    or not isinstance(raw_index, int) or isinstance(raw_index, bool)
                    or raw_index < 0 or raw_index in contract_raw_indices
                    or not isinstance(dropped, int) or isinstance(dropped, bool) or dropped < 0):
                errors.append({"group": group_index, "reason": "member_contract_invalid"})
                continue
            raw_ids.add(raw_id)
            contract_raw_ids.add(raw_id)
            contract_raw_indices.add(raw_index)
            if raw_index >= len(source_parts) or source_parts[raw_index] != source_text:
                errors.append({"group": group_index, "reason": "member_source_text_mismatch"})
            proven_full.append(source_text)
            ruby_items += dropped
            omission = member.get("omission")
            if omission == "whole_ruby":
                if member.get("documentParagraphId") is not None or translation_text:
                    errors.append({"group": group_index, "reason": "ruby_omission_invalid"})
                ruby_paragraphs += 1
            elif omission is not None:
                errors.append({"group": group_index, "reason": "member_omission_unknown"})
            else:
                document_id = str(member.get("documentParagraphId") or "")
                if not document_id.startswith("p") or not document_id[1:].isdigit():
                    errors.append({"group": group_index, "reason": "member_mapping_invalid"})
                proven_translation.append(translation_text)
            # runs:API groups and translates the raw tree. Whole-ruby members
            # remain explicit geometry members even though their text is
            # intentionally absent from translationParts.
            proven_indices.append(raw_index)
        if proven_indices != indices:
            errors.append({"group": group_index, "reason": "member_mapping_mismatch"})
        if proven_full != [str(value) for value in full_parts] or proven_translation != [str(value) for value in translation_parts]:
            errors.append({"group": group_index, "reason": "member_parts_mismatch"})
        if ruby_items != int(group.get("ruby_items_dropped") or 0) or ruby_paragraphs != int(group.get("ruby_paragraphs_dropped") or 0):
            errors.append({"group": group_index, "reason": "ruby_count_mismatch"})
        expected_full = str(separator).join(value for value in proven_full if value).strip()
        expected_translation = str(separator).join(value for value in proven_translation if value).strip()
        if str(group.get("text") or "").strip() != expected_translation:
            errors.append({"group": group_index, "reason": "translation_text_mismatch"})
        if markers.has_translatable_text(expected_full) and not markers.has_translatable_text(expected_translation):
            errors.append({"group": group_index, "reason": "letters_collapsed"})

    owners: dict[int, list[int]] = {}
    if len(unit_indices) != len(unit_texts):
        errors.append({"reason": "unit_cardinality_mismatch"})
    for unit_index, (indices, text) in enumerate(zip(unit_indices, unit_texts)):
        if not str(text or "").strip() or not indices:
            errors.append({"unit": unit_index, "reason": "empty_unit"})
        for index in indices:
            owners.setdefault(int(index), []).append(unit_index)
    missing = sorted(eligible - set(owners))
    duplicate = sorted(index for index in eligible if len(owners.get(index, [])) > 1)
    unexpected = sorted(index for index in owners if index not in eligible)
    if missing:
        errors.append({"reason": "missing_paragraphs", "indices": missing})
    if duplicate:
        errors.append({"reason": "duplicate_paragraphs", "indices": duplicate})
    if unexpected:
        errors.append({"reason": "unexpected_paragraphs", "indices": unexpected})

    structural = json.dumps(unit_indices, separators=(",", ":"), ensure_ascii=True)
    report = {
        "ok": not errors,
        "paragraphCount": len(paragraphs),
        "eligibleParagraphCount": len(eligible),
        "excludedBlankParagraphCount": len(paragraphs) - len(eligible),
        "unitCount": len(unit_indices),
        "partitionHash": hashlib.sha256(structural.encode("ascii")).hexdigest(),
        "errors": errors,
    }
    if errors:
        raise AiInputConservationError(
            "OCR-to-AI content conservation failed: "
            + json.dumps(errors, separators=(",", ":"), ensure_ascii=True)
        )
    return report
