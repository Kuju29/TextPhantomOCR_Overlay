"""Plain-marker AI validation and the single bounded repair pass."""

from __future__ import annotations

from typing import Any

import time, re

from backend.ai import markers, wire_trace
from backend.ai.errors import ModelOutputContractError, WrongLanguageOutput
from backend.ai.translation.contracts import AiConfig
from backend.ai.translation.invocation import translate as ai_translate
from backend.lens.languages import normalize as normalize_lang
# from backend.lens.tree import iter_paragraphs
from backend.log import dbg, event

# def _restore_unanswered_paragraphs(
#     out: dict[str, Any],
#     original_tree: dict | None,
#     source_img: "Image.Image | None",
#     base_img: "Image.Image | None",
#     *,
#     client_background: bool,
#     stages: dict[str, Any],
# ) -> int:
#     """Undo the erase for paragraphs the model did not answer.

#     The page is erased before the AI replies, so a partial answer leaves the
#     unanswered bubbles blank — the reader loses text that was there before the
#     translation ran. The extension already refuses to erase what it cannot
#     replace; this is the same rule on the server. Returns how many paragraphs
#     were restored.
#     """
#     meta = ((out.get("Ai") or {}).get("meta") or {})
#     indices = meta.get("missing_paragraph_indices") or []
#     if not indices:
#         return 0
#     tokens = spans_for_paragraphs(original_tree, indices)
#     if not tokens:
#         return 0

#     if client_background:
#         # The client paints the boxes: simply do not send the ones whose text
#         # is staying on screen.
#         keep = spans_for_paragraphs(
#             original_tree,
#             [i for i, _ in iter_paragraphs(original_tree) if i not in set(indices)],
#         )
#         out["eraseBoxes"] = erase_boxes_mod.build(keep)
#     elif base_img is not None and source_img is not None:
#         _t = time.perf_counter()
#         restore_token_regions(base_img, source_img, tokens)
#         if settings.lens_direct_png:
#             out["imageDataUri"] = _encode_bg_data_uri(base_img)
#         stages["ai_partial_restore_ms"] = round((time.perf_counter() - _t) * 1000, 1)
#     else:
#         return 0

#     stages["ai_partial_restored_paragraphs"] = len(indices)
#     dbg("ai.partial.restored", {"paragraphs": indices})
#     return len(indices)

def _target_script_diagnostic(text: str, target_lang: str, source_text: str = "", unit_id: str = "") -> dict[str, Any]:
    """Mirror the extension's source-aware per-unit Thai/Korean verdict."""
    raw_target = str(target_lang or "").strip().lower()
    target = normalize_lang(raw_target)
    if raw_target.startswith(("th-", "th_", "tha-", "tha_")) or "thai" in raw_target or "ภาษาไทย" in raw_target:
        target = "th"
    elif raw_target.startswith(("ko-", "ko_", "kor-", "kor_")) or "korean" in raw_target or "한국어" in raw_target:
        target = "ko"
    if target not in {"th", "ko"}:
        return {"id": unit_id, "targetScript": "unsupported", "detectedScripts": {},
                "targetChars": 0, "foreignChars": 0, "decision": "not_checked",
                "reason": "validator_not_enabled_for_target"}
    value = str(text or "")
    source_value = str(source_text or "")
    trimmed = value.strip()
    source_trimmed = source_value.strip()
    is_preserved_identifier = (
        re.match(r"^(?:https?://|www\.)\S+$", trimmed, re.I) is not None
        or re.match(r"^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$", trimmed, re.I) is not None
        or re.match(r"^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2}|com|net|org|edu|gov|mil|int|info|biz|name|mobi|app|dev|xyz|online|site|store|tech|cloud|space)(?::\d+)?(?:/\S*)?$", trimmed, re.I) is not None
        or re.match(r"^(?:[a-z]:[\\/]|\\\\|/)(?:[^\\/\s]+[\\/])*[^\\/\s]*$", trimmed, re.I) is not None
        or re.match(r"^(?:\.{1,2}[\\/])?(?:[^\\/\s]+[\\/])+[^\\/\s]+\.[a-z0-9]{1,10}$", trimmed, re.I) is not None
        or re.match(r"^(?=[a-z0-9_.-]*\d)(?=(?:[^_.-]*[_.-]){2})[a-z0-9]+(?:[_.-][a-z0-9]+)+$", trimmed, re.I) is not None
        or re.match(r"^(?=[a-z0-9_.:-]*\d)[a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.:-]*$", trimmed, re.I) is not None
        or re.match(r"^(?:v?\d+)(?:\.\d+)+(?:[-_][a-z0-9]+)?$", trimmed, re.I) is not None
    )
    preserved_identifier = (
        bool(trimmed) and trimmed == source_trimmed
        and all(0x21 <= ord(ch) <= 0x7E for ch in trimmed)
        and is_preserved_identifier
    )
    if preserved_identifier:
        return {"id": unit_id, "targetScript": "thai" if target == "th" else "hangul",
                "detectedScripts": {}, "targetChars": 0, "foreignChars": 0,
                "decision": "accept", "reason": "preserved_identifier"}
    script_letters = [ch for ch in value if ch.isalpha()]
    def wanted_script(ch: str) -> bool:
        if target == "th":
            return "\u0e00" <= ch <= "\u0e7f"
        code = ord(ch)
        return (0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F
                or 0xA960 <= code <= 0xA97F or 0xAC00 <= code <= 0xD7AF
                or 0xD7B0 <= code <= 0xD7FF)
    wanted = sum(1 for ch in script_letters if wanted_script(ch))
    def foreign_script(ch: str) -> str:
        code = ord(ch)
        if 0x0E80 <= code <= 0x0EFF:
            return "lao"
        if 0x3040 <= code <= 0x30FF:
            return "kana"
        if 0x3400 <= code <= 0x9FFF:
            return "han"
        if (0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F
                or 0xA960 <= code <= 0xA97F or 0xAC00 <= code <= 0xD7AF
                or 0xD7B0 <= code <= 0xD7FF):
            return "hangul"
        return ""
    foreign_names = ("lao", "kana", "han", "hangul") if target == "th" else ("lao", "kana", "han", "thai")
    def classified_script(ch: str) -> str:
        if "\u0e00" <= ch <= "\u0e7f":
            return "thai"
        return foreign_script(ch)
    output_scripts = {name: sum(1 for ch in value if classified_script(ch) == name)
                      for name in foreign_names}
    source_scripts = {name: sum(1 for ch in source_value if classified_script(ch) == name)
                      for name in output_scripts}
    hard = sum(output_scripts.values())
    invented = sum(count for name, count in output_scripts.items() if source_scripts[name] == 0)
    # Permit only one source-native glyph beside substantial Thai (for a
    # compact name/SFX such as `王`).  Source Japanese/Han must not exempt a
    # longer untranslated fragment or a model language switch.
    lao_count = output_scripts["lao"]
    bounded_lao_confusable = target == "th" and lao_count == hard and lao_count <= 2 and wanted >= 3
    standalone_source_glyph = len(trimmed) == 1 and trimmed in source_value
    bounded_source_glyph = hard == 1 and invented == 0 and (wanted >= 3 or standalone_source_glyph)
    bounded_foreign_fragment = bounded_lao_confusable or bounded_source_glyph
    foreign_leak = hard > 0 and not bounded_foreign_fragment and (
        wanted == 0 or invented > 0 or hard >= 2
    )
    other_letters = max(0, len(script_letters) - wanted)
    latin_chars = sum(1 for ch in value if ch.isascii() and ch.isalpha())
    single_hyphen_prose = trimmed == source_trimmed and re.match(r"^[A-Z]{3,}-\d+$", trimmed) is not None
    untranslated_long = len(script_letters) >= 8 and wanted == 0 and other_letters / len(script_letters) >= 0.75
    rejected = foreign_leak or single_hyphen_prose or untranslated_long
    reason = (
        "foreign_script_leak" if foreign_leak else
        "untranslated_identifier_like_prose" if single_hyphen_prose else
        "untranslated_long_prose" if untranslated_long else
        "proper_name_or_sfx_exemption" if bounded_foreign_fragment and standalone_source_glyph else
        "small_foreign_fragment_exemption" if bounded_foreign_fragment else
        "target_script_present" if wanted > 0 else "insufficient_evidence"
    )
    detected = {"thai" if target == "th" else "hangul": wanted}
    detected.update({name: count for name, count in output_scripts.items() if count > 0})
    if latin_chars > 0:
        detected["latin"] = latin_chars
    if other_letters > hard + latin_chars:
        detected["otherLetters"] = other_letters - hard - latin_chars
    return {"id": unit_id, "targetScript": "thai" if target == "th" else "hangul",
            "detectedScripts": detected, "targetChars": wanted, "foreignChars": hard + latin_chars,
            "decision": "reject" if rejected else "accept", "reason": reason}

def _high_confidence_wrong_target_script(text: str, target_lang: str, source_text: str = "") -> bool:
    """Mirror verdict; diagnostics are observational and do not change policy."""
    return _target_script_diagnostic(text, target_lang, source_text)["decision"] == "reject"

def _ai_answer_state(result: dict, expected: int, target_lang: str, source_units: list[str] | None = None) -> dict[str, Any]:
    text = markers.clamp_output_repeats(str(result.get("aiTextFull") or ""))
    extracted = markers.extract_paragraphs(text, expected)
    if extracted is None or not markers.has_complete_sequence(text, expected):
        return {"valid": False, "reason": "malformed", "text": text, "units": []}
    units, clean = extracted
    missing = [i for i, value in enumerate(units) if not str(value or "").strip()]
    # Judge each attributable unit independently. Combining a short foreign
    # name/SFX with neighbouring Thai dialogue can manufacture a false page-
    # level ratio and spend the repair on a valid answer.
    sources = list(source_units or [])
    language_diagnostics = [_target_script_diagnostic(
        value, target_lang, sources[index] if index < len(sources) else "", f"P{index}"
    ) for index, value in enumerate(units)]
    wrong_script = any(row["decision"] == "reject" for row in language_diagnostics)
    return {
        "valid": not missing and not wrong_script,
        "reason": "missing_or_empty" if missing else "wrong_target_script" if wrong_script else "",
        "text": text,
        "clean": clean,
        "units": units,
        "missing": missing,
        "languageDiagnostics": language_diagnostics,
    }

def translate_with_one_repair(
    source_text: str,
    target_lang: str,
    config: AiConfig,
    expected: int,
    *,
    capture_request: bool = False,
    translate_fn: Any = ai_translate,
    cancel_check=None,
) -> dict:
    """Validate one generation and optionally repair only defective units.

    Repair is enabled by default and billable only when actually dispatched.
    Missing/wrong-script units are renumbered for a compact repair request and
    merged into the first answer without replacing valid translations.
    """
    source_extracted = markers.extract_paragraphs(source_text, expected)
    source_units = source_extracted[0] if source_extracted is not None else []
    first: dict | None = None
    first_state: dict[str, Any] | None = None
    first_error: BaseException | None = None
    first_failure_meta: dict[str, Any] = {}

    def failure_generation_meta(exc: BaseException) -> dict[str, Any]:
        """Return provider metadata carried by a failed generated response."""
        direct = getattr(exc, "generationMeta", None)
        if isinstance(direct, dict):
            return dict(direct)
        details = getattr(exc, "structural_details", None)
        if isinstance(details, dict):
            nested = details.get("generationMeta")
            if isinstance(nested, dict):
                return dict(nested)
        return {}

    def dispatched_generation(exc: BaseException) -> bool:
        details = getattr(exc, "structural_details", None)
        attempts = getattr(exc, "generationAttempts", None)
        if attempts is None and isinstance(details, dict):
            attempts = details.get("generationAttempts")
        return bool(
            getattr(exc, "requestDispatched", False)
            or getattr(exc, "providerResponded", False)
            or (isinstance(attempts, (int, float)) and attempts > 0)
        )

    def raise_if_cancelled(phase: str) -> None:
        if cancel_check is None or not cancel_check():
            return
        event("ai.cancelled", {
            "phase": phase, "cancelRequestedAt": time.time(),
            "repairSuppressedByCancel": phase == "repair_dispatch",
        })
        raise RuntimeError("cancelled")

    def combined_generation_meta(first_meta: dict, repair_meta: dict) -> dict:
        """Combine two real provider generations exactly once."""
        a = first_meta.get("usage") if isinstance(first_meta.get("usage"), dict) else {}
        b = repair_meta.get("usage") if isinstance(repair_meta.get("usage"), dict) else {}

        def sum_nullable(*values: Any) -> float | None:
            known = [float(value) for value in values if isinstance(value, (int, float))]
            return sum(known) if known else None

        from backend.ai.usage import aggregate_usage
        usage = aggregate_usage([a, b])
        return {
            **first_meta,
            **repair_meta,
            "usage": usage,
            "provider_ms": sum_nullable(
                first_meta.get("provider_ms", first_meta.get("providerMs")),
                repair_meta.get("provider_ms", repair_meta.get("providerMs")),
            ),
            "provider_parse_ms": sum_nullable(
                first_meta.get("provider_parse_ms", first_meta.get("providerParseMs")),
                repair_meta.get("provider_parse_ms", repair_meta.get("providerParseMs")),
            ),
            "generation_usage": [a, b],
            "provider_http_statuses": [
                *list(first_meta.get("provider_http_statuses") or first_meta.get("providerHttpStatuses") or []),
                *list(repair_meta.get("provider_http_statuses") or repair_meta.get("providerHttpStatuses") or []),
            ],
            "generationAttempts": 2,
            "generation_attempts": 2,
            "providerAttempts": 2,
            "provider_attempts": 2,
        }
    try:
        raise_if_cancelled("initial_dispatch")
        first = translate_fn(
            source_text, target_lang, config,
            is_retry=False, capture_request=capture_request,
            cancel_check=cancel_check,
        )
        first_state = _ai_answer_state(first, expected, target_lang, source_units)
        first_diagnostics = list(first_state.get("languageDiagnostics") or [])
        wire_trace.write_json("07_validation.json", {
            "generationAttempt": 1,
            "expectedIds": [f"P{i}" for i in range(expected)],
            "missingIds": [f"P{i}" for i in (first_state.get("missing") or [])],
            "wrongLanguageIds": [row.get("id") for row in first_diagnostics
                                 if row.get("decision") == "reject"],
            "reason": first_state.get("reason"), "valid": bool(first_state.get("valid")),
            "languageDiagnostics": first_diagnostics,
        })
        if first_state["valid"]:
            first_meta = first.setdefault("meta", {})
            actual_attempts = max(1, int(first_meta.get("generationAttempts")
                                         or first_meta.get("generation_attempts") or 1))
            first_meta.update({"generation_attempts": actual_attempts,
                               "provider_attempts": max(actual_attempts, int(first_meta.get("providerAttempts") or actual_attempts)),
                               "repair_attempted": False})
            return first
    except ModelOutputContractError as exc:
        # Decoding failures occur after a model generation. They qualify for
        # content repair; transport/provider exceptions do not reach this block.
        first_error = exc
        first_failure_meta = (
            exc.structural_details.get("generationMeta")
            if isinstance(exc.structural_details.get("generationMeta"), dict)
            else {}
        )

    raise_if_cancelled("validation")
    reason = str((first_state or {}).get("reason") or "malformed")
    if getattr(config, "repair_enabled", True) is False:
        if first is not None and first_state is not None:
            if reason == "wrong_target_script":
                language_diagnostics = list(first_state.get("languageDiagnostics") or [])
                wrong_ids = [row["id"] for row in language_diagnostics if row.get("decision") == "reject"]
                failure = WrongLanguageOutput(
                    "AI output used the wrong target language",
                    response_shape="wrong_language_output",
                    validatorSubtype="wrong_target_script",
                    wrongLanguageIds=wrong_ids,
                    languageDiagnostics=language_diagnostics[:10],
                    resolvedProvider=first.get("meta", {}).get("provider"),
                    resolvedModel=first.get("meta", {}).get("model"),
                    generationAttempts=int(first.get("meta", {}).get("generationAttempts")
                                           or first.get("meta", {}).get("generation_attempts") or 1),
                    generationMeta=dict(first.get("meta", {})),
                )
                failure.generationMeta = dict(first.get("meta", {}))
                failure.generationAttempts = int(
                    first.get("meta", {}).get("generationAttempts")
                    or first.get("meta", {}).get("generation_attempts") or 1
                )
                failure.providerAttempts = int(
                    first.get("meta", {}).get("providerAttempts")
                    or first.get("meta", {}).get("provider_attempts")
                    or failure.generationAttempts
                )
                raise failure
            first.setdefault("meta", {}).update({
                "generation_attempts": 1,
                "repair_attempted": False,
                "repair_enabled": False,
                "repair_skipped": True,
                "repair_reason": reason,
                "missing_units": list(first_state.get("missing") or []),
                "wrong_script": reason == "wrong_target_script",
            })
            return first
        if first_error is not None:
            first_error.structural_details.update({
                "generationAttempts": int(first_error.structural_details.get("generationAttempts")
                                          or getattr(first_error, "generationAttempts", 1) or 1),
                "repairAttempted": False,
                "repairEnabled": False,
                "repairSkipped": True,
                "repairReason": reason,
            })
            raise first_error

    defective = list((first_state or {}).get("missing") or [])
    if reason == "wrong_target_script" and first_state is not None:
        defective = [
            index for index, value in enumerate(first_state.get("units") or [])
            if _high_confidence_wrong_target_script(
                value, target_lang, source_units[index] if index < len(source_units) else ""
            )
        ]
    # A malformed response has no trustworthy associations, so all units are
    # necessarily the repair subset. Decoded defects repair only their indices.
    if not defective:
        defective = list(range(expected))
    repair_source_units = [source_units[index] for index in defective if index < len(source_units)]
    repair_source = markers.apply(repair_source_units)
    event("ai.content_repair_generation", {
        "repairEnabled": True,
        "reason": reason,
        "generationAttempt": 2,
        "fullContext": len(defective) == expected,
        "unitCount": len(defective),
        "defectiveIndices": defective,
    })
    repair_generated = False
    repair_failure_meta: dict[str, Any] = {}
    try:
        raise_if_cancelled("repair_dispatch")
        from copy import copy
        repair_config = copy(config)
        repair_config.repair_reason = "wrong_target_script" if reason == "wrong_target_script" else ""
        repaired = translate_fn(
            repair_source, target_lang, repair_config,
            is_retry=True, capture_request=capture_request,
            cancel_check=cancel_check,
        )
        repair_generated = True
        raise_if_cancelled("repair_validation")
        repaired_state = _ai_answer_state(
            repaired, len(repair_source_units), target_lang, repair_source_units
        )
        repair_diagnostics = list(repaired_state.get("languageDiagnostics") or [])
        wire_trace.write_json("07_validation.json", {
            "generationAttempt": 2,
            "expectedIds": [f"P{i}" for i in range(len(repair_source_units))],
            "missingIds": [f"P{i}" for i in (repaired_state.get("missing") or [])],
            "wrongLanguageIds": [row.get("id") for row in repair_diagnostics
                                 if row.get("decision") == "reject"],
            "reason": repaired_state.get("reason"), "valid": bool(repaired_state.get("valid")),
            "languageDiagnostics": repair_diagnostics,
        })
        if repaired_state["valid"]:
            if first is not None and first_state is not None:
                raise_if_cancelled("merge")
                merged_units = list(first_state.get("units") or [])
                for offset, original_index in enumerate(defective):
                    if original_index < len(merged_units):
                        merged_units[original_index] = repaired_state["units"][offset]
                repaired = {
                    **first,
                    "aiTextFull": markers.apply(merged_units),
                    "meta": combined_generation_meta(
                        first.get("meta") or {}, repaired.get("meta") or {}
                    ),
                }
            elif first_failure_meta:
                repaired["meta"] = combined_generation_meta(
                    first_failure_meta, repaired.get("meta") or {}
                )
            repaired.setdefault("meta", {}).update({
                "generation_attempts": 2,
                "repair_attempted": True,
                "repair_accepted": True,
                "repair_reason": reason,
                "repair_full_context": len(defective) == expected,
                "repair_unit_indices": defective,
            })
            return repaired
    except ModelOutputContractError as exc:
        # This exception is the generated-response contract failure: the
        # provider returned a response, but its marker/content contract failed.
        repair_generated = True
        repair_failure_meta = failure_generation_meta(exc)
        repaired_state = {"valid": False, "reason": "malformed"}
    except RuntimeError as exc:
        if str(exc).lower() == "cancelled":
            raise
        repair_generated = dispatched_generation(exc)
        repair_failure_meta = failure_generation_meta(exc)
        repaired_state = {"valid": False, "reason": type(exc).__name__}
    except Exception as exc:  # transport/provider failure after the repair generation
        repair_generated = dispatched_generation(exc)
        repair_failure_meta = failure_generation_meta(exc)
        repaired_state = {"valid": False, "reason": type(exc).__name__}

    if first is not None and first_state is not None:
        # A failed repair must not erase translations that passed the initial
        # validation. Remove only unresolved units (including wrong-script
        # values) and expose their indexes through the existing partial result.
        preserved_units = [
            value if index not in defective else ""
            for index, value in enumerate(first_state.get("units") or [])
        ]
        if any(value.strip() for value in preserved_units):
            first["aiTextFull"] = markers.apply(preserved_units)
            first_meta = first.setdefault("meta", {})
            if repair_generated:
                first["meta"] = combined_generation_meta(first_meta, repair_failure_meta)
                first_meta = first["meta"]
            first_meta.update({
                "generation_attempts": 2 if repair_generated else 1,
                "repair_attempted": True,
                "repair_accepted": False,
                "repair_reason": reason,
                "repair_failure": str(repaired_state.get("reason") or "invalid"),
                "repair_full_context": len(defective) == expected,
                "repair_unit_indices": defective,
                "unresolved_unit_indices": defective,
            })
            return first
    if first_error is not None:
        failure_meta = (combined_generation_meta(first_failure_meta, repair_failure_meta)
                        if repair_generated else first_failure_meta)
        failure = ModelOutputContractError(
            "AI repair failed after malformed model output",
            response_shape="repair_failed", repairReason="malformed",
            generationAttempts=2 if repair_generated else 1,
            repairAttempted=True, generationMeta=failure_meta,
        )
        failure.generationMeta = failure_meta
        failure.generationAttempts = 2 if repair_generated else 1
        failure.providerAttempts = 2 if repair_generated else 1
        raise failure from first_error
    failure_meta = (combined_generation_meta(first.get("meta") or {}, repair_failure_meta)
                    if repair_generated and first is not None else repair_failure_meta)
    failure = ModelOutputContractError(
        f"AI repair failed after {reason}",
        response_shape="repair_failed", repairReason=reason,
        generationAttempts=2 if repair_generated else 1,
        repairAttempted=True, generationMeta=failure_meta,
        wrongLanguageIds=[
            row.get("id") for row in (repaired_state.get("languageDiagnostics") or [])
            if row.get("decision") == "reject"
        ][:10],
        languageDiagnostics=list(repaired_state.get("languageDiagnostics") or [])[:10],
    )
    failure.generationMeta = failure_meta
    failure.generationAttempts = 2 if repair_generated else 1
    failure.providerAttempts = 2 if repair_generated else 1
    raise failure
