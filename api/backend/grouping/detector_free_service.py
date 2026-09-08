"""Conserved Lens groups; uncertain orientation is isolated, not merged."""
from __future__ import annotations

from dataclasses import asdict, is_dataclass
import hashlib
import json
import math
from typing import Any

from backend.render.lens_graph_partition import partition_vertical_lens
from backend.render.lens_graph_partition.item_roles import infer_item_ruby

from .adapter import adapt_grouping_result, raw_tree_fingerprint
from .contracts import GROUPING_CORE_SCHEMA, GroupingResultError
from .detector_free_helpers import (
    explicit_item_policy, font_px, group_orientation, group_separator,
    paragraph_id, paragraph_orientation, paragraph_text, union_bounds, rect,
)


class DetectorFreeGroupingError(RuntimeError):
    def __init__(self, code: str, details: dict[str, Any] | None = None):
        self.code = code
        self.details = dict(details or {})
        super().__init__(code)


def _debug_value(value: Any) -> Any:
    if is_dataclass(value):
        return _debug_value(asdict(value))
    if isinstance(value, dict):
        return {str(k): _debug_value(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [_debug_value(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _identity_mapping(raw_tree: dict[str, Any], ruby_ids: set[str]) -> list[int | None]:
    result = []
    for position, paragraph in enumerate(raw_tree.get("paragraphs") or []):
        if not isinstance(paragraph, dict) or not paragraph_text(paragraph).strip():
            result.append(None)
            continue
        result.append(None if paragraph_id(paragraph, position) in ruby_ids
                      else position)
    return result


def _mapped_document_index(
    mapping: list[Any] | dict[str, Any], position: int, raw_id: str,
) -> Any:
    if isinstance(mapping, list):
        return mapping[position] if position < len(mapping) else None
    if raw_id in mapping:
        return mapping[raw_id]
    return mapping.get(str(position))


def _retained_document_ids(raw_tree: dict[str, Any], mapping) -> frozenset[str]:
    """Return nonblank raw IDs the Extension retained in its document."""
    if mapping is None:
        return frozenset()
    retained = []
    for position, paragraph in enumerate(raw_tree.get("paragraphs") or []):
        if not isinstance(paragraph, dict) or not paragraph_text(paragraph).strip():
            continue
        raw_id = paragraph_id(paragraph, position)
        mapped = _mapped_document_index(mapping, position, raw_id)
        if isinstance(mapped, int) and not isinstance(mapped, bool) and mapped >= 0:
            retained.append(raw_id)
    return frozenset(retained)


def _core_groups(partition, raw_tree: dict[str, Any], retained_ids=frozenset(), item_exclusions=None, isolated_ids=frozenset()) -> list[dict[str, Any]]:
    paragraphs = list(raw_tree.get("paragraphs") or [])
    by_id = {}
    order = {}
    for position, paragraph in enumerate(paragraphs):
        if not isinstance(paragraph, dict) or not paragraph_text(paragraph).strip():
            continue
        raw_id = paragraph_id(paragraph, position)
        if raw_id in by_id:
            raise DetectorFreeGroupingError("paragraph_id_duplicate", {"rawId": raw_id})
        by_id[raw_id] = paragraph
        order[raw_id] = position

    ruby_owner = {attachment.ruby_id: attachment.base_id
                  for attachment in partition.ruby}
    groups = [list(group) for group in partition.groups]
    owner = {raw_id: index for index, group in enumerate(groups)
             for raw_id in group}
    for ruby_id, base_id in ruby_owner.items():
        if base_id not in owner:
            raise DetectorFreeGroupingError(
                "ruby_base_group_missing", {"rubyId": ruby_id, "baseId": base_id})
        target = groups[owner[base_id]]
        target.insert(target.index(base_id) + 1, ruby_id)
    for raw_id, _role in partition.excluded:
        if raw_id not in ruby_owner:
            groups.append([raw_id])
    groups.sort(key=lambda group: min(order[raw_id] for raw_id in group))

    flattened = [raw_id for group in groups for raw_id in group]
    if len(flattened) != len(set(flattened)) or set(flattened) != set(by_id):
        raise DetectorFreeGroupingError(
            "service_membership_not_conserved",
            {"expected": list(by_id), "actual": flattened})

    core_groups = []
    for group_index, raw_ids in enumerate(groups):
        source = [by_id[raw_id] for raw_id in raw_ids]
        policies = {}
        translations = []
        for raw_id, paragraph in zip(raw_ids, source):
            if raw_id in ruby_owner:
                policies[raw_id] = {"mode": "retained_ruby" if raw_id in retained_ids else "whole_ruby"}
            else:
                policy, translated, _dropped = explicit_item_policy(paragraph, (item_exclusions or {}).get(raw_id, ()))
                policies[raw_id] = policy
                translations.append(translated)
        separator = group_separator(translations)
        # Visible/raw items remain intact. Only main-column measurement ignores ruby.
        main_source = [{**p, "items": [it for i,it in enumerate(p.get("items") or [])
                        if i not in (item_exclusions or {}).get(rid, ())]}
                       for rid,p in zip(raw_ids,source)]
        isolated = len(raw_ids) == 1 and raw_ids[0] in isolated_ids
        if isolated:
            # This is a presentation default, not an inferred reading order.
            # Native items are untouched and this member cannot merge/bridge.
            bounds = union_bounds(source) or union_bounds(source[0].get("items") or [])
            direction = "v" if bounds[3] - bounds[1] > bounds[2] - bounds[0] else "h"
            rotation = 0.0
        else:
            direction, rotation = group_orientation(main_source)
        core_groups.append({
            "id": f"g{group_index}", "memberIds": raw_ids,
            "memberPolicies": policies, "separator": separator,
            "direction": direction, "rotation": rotation,
            "bounds": bounds if isolated else union_bounds(source), "fontPx": font_px(main_source),
            **({"orientationFallback": "standalone_bounds"} if isolated else {}),
        })
    return core_groups


def _raw_partition_hash(core_groups: list[dict[str, Any]]) -> str:
    raw_partition = [[group["id"], group["memberIds"]] for group in core_groups]
    payload = json.dumps(raw_partition, ensure_ascii=True,
                         separators=(",", ":")).encode("ascii")
    return hashlib.sha256(payload).hexdigest()


def bubble_groups_from_result(grouping_result: dict[str, Any], raw_tree: dict[str, Any]) -> list[dict[str, Any]]:
    paragraphs = list(raw_tree.get("paragraphs") or [])
    by_id = {paragraph_id(p, pos): p for pos, p in enumerate(paragraphs)
             if isinstance(p, dict) and paragraph_text(p).strip()}
    output = []
    for bubble_index, group in enumerate(grouping_result["groups"]):
        contract = group["sourceContract"]
        raw_ids = [member["rawId"] for member in contract["members"]]
        source = [by_id[raw_id] for raw_id in raw_ids]
        separator = contract["separator"]
        output.append({
            "bubble_index": bubble_index,
            "bubble_bounds_px": group.get("boundsPx"),
            "direction": group.get("direction", "v"),
            "rotation_deg": group.get("rotation", 90.0),
            "para_indices": [int(p.get("para_index") if
                                 p.get("para_index") is not None else
                                 member["rawParagraphIndex"])
                             for p, member in zip(source, contract["members"])],
            "paragraph_ids": list(group["paragraphIds"]),
            "text": group["text"],
            "text_full": separator.join(contract["fullParts"]).strip(),
            "ruby_items_dropped": group["rubyItemsDropped"],
            "ruby_paragraphs_dropped": group["rubyParagraphsDropped"],
            # This is the same canonical object, not a second provenance shape.
            "source_contract": contract,
            "font_size_px": group.get("fontPx", 0.0),
            "items": [item for paragraph in source
                      for item in paragraph.get("items") or []],
        })
    return output


def project_grouping_result(
    grouping_result: dict[str, Any], source_tree: dict[str, Any],
    target_tree: dict[str, Any],
) -> dict[str, Any]:
    """Project one authoritative raw partition onto a parallel Lens tree.

    Membership is never inferred from target-language text. Raw positions,
    para indices and geometry must match the source tree or projection fails.
    """
    source = list(source_tree.get("paragraphs") or [])
    target = list(target_tree.get("paragraphs") or [])
    target_groups = []
    for group in grouping_result.get("groups") or []:
        old_contract = group["sourceContract"]
        members, full_parts, translation_parts = [], [], []
        for old_member in old_contract["members"]:
            position = int(old_member["rawParagraphIndex"])
            if position >= len(source) or position >= len(target):
                raise DetectorFreeGroupingError(
                    "projection_member_missing", {"position": position})
            source_para, target_para = source[position], target[position]
            raw_id = paragraph_id(source_para, position)
            if raw_id != old_member["rawId"]:
                raise DetectorFreeGroupingError(
                    "projection_source_id_mismatch", {"position": position})
            if paragraph_id(target_para, position) != raw_id:
                raise DetectorFreeGroupingError(
                    "projection_target_id_mismatch", {"position": position})
            source_index = source_para.get("para_index", position)
            target_index = target_para.get("para_index", position)
            if int(source_index) != int(target_index):
                raise DetectorFreeGroupingError(
                    "projection_para_index_mismatch", {"position": position})
            # Lens reflows the translated layer and may emit a different item
            # count and envelope for the same paragraph.  Membership belongs
            # to the original OCR paragraph identity/position; requiring the
            # translated render geometry to be byte-identical would reject a
            # valid translation rather than prove its correspondence.
            target_text = paragraph_text(target_para)
            omission = old_member.get("omission")
            if omission in ("whole_ruby", "ruby_text"):
                translated, dropped = "", []
            else:
                _policy, translated, dropped = explicit_item_policy(target_para)
                translation_parts.append(translated)
            full_parts.append(target_text)
            members.append({
                "rawId": raw_id, "rawParagraphIndex": position,
                "documentParagraphId": old_member.get("documentParagraphId"),
                "sourceText": target_text, "translationText": translated,
                "omission": omission, "rubyItemsDropped": len(dropped),
            })
        separator = group_separator(translation_parts)
        projected = dict(group)
        projected["text"] = separator.join(translation_parts).strip()
        projected["rubyItemsDropped"] = sum(
            member["rubyItemsDropped"] for member in members)
        projected["sourceContract"] = {
            "version": old_contract["version"], "separator": separator,
            "members": members, "fullParts": full_parts,
            "translationParts": translation_parts,
        }
        target_groups.append(projected)
    projected_result = dict(grouping_result)
    projected_result["treeFingerprint"] = raw_tree_fingerprint(target_tree)
    projected_result["groups"] = target_groups
    return projected_result


def group_vertical_lens(
    raw_tree: dict[str, Any], img_w: int, img_h: int, image: Any = None,
    raw_to_document: list[Any] | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return canonical grouping_result and its Python bubble_groups view."""
    paragraphs = list(raw_tree.get("paragraphs") or [])
    item_exclusions = infer_item_ruby(raw_tree)
    vertical, horizontal, unknown = [], [], []
    for position, paragraph in enumerate(paragraphs):
        if not isinstance(paragraph, dict) or not paragraph_text(paragraph).strip():
            continue
        excluded = item_exclusions.get(paragraph_id(paragraph, position), ())
        main = {**paragraph, "items": [it for i,it in enumerate(paragraph.get("items") or [])
                                      if i not in excluded]} if excluded else paragraph
        axis, _rotation = paragraph_orientation(main)
        (vertical if axis == "v" else horizontal if axis == "h" else unknown).append(
            (position, paragraph))
    # Empty measurement after excluding ruby must not discard an otherwise
    # usable OCR paragraph. Keep it isolated and preserve its exact source.
    isolated_ids = frozenset(paragraph_id(p, pos) for pos, p in unknown)
    invalid_ids = []
    for pos, p in unknown:
        bounds = rect(p) or union_bounds(p.get("items") or [])
        if bounds is None or not all(math.isfinite(v) for v in bounds):
            invalid_ids.append(paragraph_id(p, pos))
        item_exclusions.pop(paragraph_id(p, pos), None)
    if invalid_ids:
        raise DetectorFreeGroupingError("orientation_unresolved", {
            "unresolvedIds": invalid_ids, "reason": "no_usable_standalone_geometry"})
    vertical_tree = dict(raw_tree)
    vertical_tree["paragraphs"] = [
        {**paragraph, "id": paragraph_id(paragraph, position)}
        for position, paragraph in vertical]
    partition = partition_vertical_lens(
        vertical_tree, image=image,
        retained_ids=_retained_document_ids(raw_tree, raw_to_document), item_exclusions=item_exclusions)
    debug = {"status": partition.status, "reason": partition.reason,
             "unresolvedIds": list(partition.unresolved_ids),
             "errors": list(partition.errors),
             "trace": _debug_value(partition.trace),
             "candidateTraces": _debug_value(partition.traces),
             "orientation": {"vertical": len(vertical),
                             "horizontal": len(horizontal),
                             "unknown": len(unknown)},
             "page": {"width": int(img_w), "height": int(img_h)},
             "itemRuby": {key:list(value) for key,value in item_exclusions.items()},
             "isolatedIds": sorted(isolated_ids),
             "orientationRecovery": "standalone" if isolated_ids else "none"}
    if partition.retention_conflicts:
        # IDs are structural and bounded; OCR text is deliberately absent.
        debug["rubyMappingDisagreements"] = list(
            partition.retention_conflicts[:200])
        debug["rubyMappingDisagreementCount"] = len(
            partition.retention_conflicts)
    if partition.status != "resolved" or partition.unresolved_ids:
        raise DetectorFreeGroupingError("vertical_grouping_unresolved", debug)

    # Horizontal Lens paragraphs bypass vertical ordering as conservative
    # singletons. They join the same canonical adapter/conservation path.
    if horizontal or unknown:
        from dataclasses import replace
        horizontal_groups = tuple(
            (paragraph_id(paragraph, position),)
            for position, paragraph in horizontal + unknown)
        partition = replace(partition, groups=partition.groups + horizontal_groups)

    core_groups = _core_groups(partition, raw_tree, _retained_document_ids(raw_tree, raw_to_document), item_exclusions, isolated_ids)
    ruby_ids = {attachment.ruby_id for attachment in partition.ruby}
    mapping = (raw_to_document if raw_to_document is not None
               else _identity_mapping(raw_tree, ruby_ids))
    core = {"schema": GROUPING_CORE_SCHEMA, "status": "usable",
            "treeFingerprint": raw_tree_fingerprint(raw_tree),
            "unresolvedIds": [], "groups": core_groups}
    try:
        grouping_result = adapt_grouping_result(core, raw_tree, mapping)
    except GroupingResultError as exc:
        raise DetectorFreeGroupingError(
            exc.code, {**exc.details, "debug": debug}) from exc
    grouping_result["rawPartitionHash"] = _raw_partition_hash(core_groups)
    return {"grouping_result": grouping_result,
            "bubble_groups": bubble_groups_from_result(grouping_result, raw_tree),
            "debug": debug}
