"""Frozen source evidence, scoped to the failed IDs of an original request."""
import json
from .instruction_packs import instruction_pack

SOURCE_CONTEXT_HEADER = (
    "CAPTURED SOURCE — READ ONLY: Each group applies only to its listed SOURCE IDs. "
    "It contains captured source, not approved translations. The evidence field identifies an initial request or a page-only checkpoint. "
    "Separate groups may be different pages or exchanges; never combine their speakers or scenes. "
    "Neither adjacency nor an ID verifies reading order or speaker identity. "
    "Use this evidence to understand the failed lines; return only SOURCE TEXT target IDs."
)
MAX_CONTEXT_GROUPS = 2000
MAX_CONTEXT_UNITS = 2000
MAX_CONTEXT_CHARS = 60000


def normalize_source_context(groups, target_units=None, *, wire_ids=None):
    if groups is None:
        return []
    if not isinstance(groups, list) or len(groups) > MAX_CONTEXT_GROUPS:
        raise ValueError("invalid_source_context")
    # The caller supplies the IDs actually selected by its output contract.
    # Independent requests keep their established dense P0.. mapping; a
    # Conversation repair may select sparse I12_P4 / I18_P7 IDs instead.
    if wire_ids is not None and (
        not isinstance(target_units, list) or not isinstance(wire_ids, (list, tuple))
        or len(wire_ids) != len(target_units)
        or any(not isinstance(uid, str) or not uid for uid in wire_ids)
        or len(set(wire_ids)) != len(wire_ids)
    ):
        raise ValueError("invalid_source_context_mapping")
    mapping = ({str(row.get("id", "")): wire_ids[index] if wire_ids is not None else f"P{index}"
                for index, row in enumerate(target_units)}
               if isinstance(target_units, list) else None)
    result, count, chars = [], 0, 0
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get("targetIds"), list) or not isinstance(group.get("units"), list):
            raise ValueError("invalid_source_context")
        targets = []
        for value in group["targetIds"]:
            if not isinstance(value, str) or not value:
                raise ValueError("invalid_source_context_target")
            mapped = mapping.get(value) if mapping is not None else value
            if mapped and mapped not in targets:
                targets.append(mapped)
        units = []
        seen = set()
        for row in group["units"]:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"] or not isinstance(row.get("text"), str):
                raise ValueError("invalid_source_context_unit")
            text = row["text"]
            if not text.strip() or len(text) > 4000 or row["id"] in seen:
                raise ValueError("invalid_source_context_unit")
            seen.add(row["id"])
            chars += len(text)
            count += 1
            if count > MAX_CONTEXT_UNITS or chars > MAX_CONTEXT_CHARS:
                raise ValueError("source_context_budget_exceeded")
            units.append({"id": row["id"], "text": text})
        if targets and units:
            result.append({"targetIds": targets, "units": units,
                           "origin": "initial_request" if group.get("origin") == "initial_request" else "page_checkpoint"})
    return result


def build_source_context_block(groups, *, lang="en"):
    groups = normalize_source_context(groups)
    if not groups:
        return ""
    visible = [{"context": f"E{index + 1}", "appliesTo": group["targetIds"], "evidence": group["origin"],
                "units": [{"context": f"C{offset + 1}", "text": row["text"]}
                          for offset, row in enumerate(group["units"])]}
               for index, group in enumerate(groups)]
    return instruction_pack(lang)["captured"] + "\n" + json.dumps(visible, ensure_ascii=False, separators=(",", ":"))
