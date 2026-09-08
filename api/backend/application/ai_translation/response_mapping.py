"""Map canonical AI marker output to the public API result."""

import time

from backend.ai import markers, prompts, wire_trace
from backend.ai.rategate import rate_gate
from backend.application import ai_request

RESULT_SCHEMA = "tp.ai.result/1"

def map_result(*, result: dict, units: list[dict], payload: dict, target_lang: str,
               started: float, parse_started: float, rate_wait_ms: float,
               admission_wait_ms: float, provider_ms: float, route_identity: dict,
               rate: dict, unlimited: bool, resolved_provider: str, config,
               prompt_meta: dict) -> tuple[dict, list[str], list[str], list[str]]:
    text_full = str(result.get("aiTextFull") or "")
    extracted_pair = markers.extract_paragraphs(text_full, len(units))
    extracted = list(extracted_pair[0]) if extracted_pair else []
    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    omitted = {str(item) for item in (meta.get("omitted_ids") or [])}
    translations, missing, declined, passthrough = [], [], [], []
    for index, unit in enumerate(units):
        translated = markers.normalize_unit_text(
            extracted[index] if index < len(extracted) else ""
        )
        if ai_request.language_neutral_unit(unit["text"]):
            translated = markers.normalize_unit_text(unit["text"])
            passthrough.append(unit["id"])
        if translated:
            translations.append({"id": unit["id"], "text": translated,
                                 "hash": ai_request.unit_hash(unit["text"])})
        else:
            missing.append(unit["id"])
            if f"P{index}" not in omitted:
                declined.append(unit["id"])
    glossary = []
    for unit, translated in zip(units, extracted):
        src, tgt = str(unit.get("text") or "").strip(), markers.normalize_unit_text(translated)
        if prompts.looks_like_term(src, tgt):
            glossary.append({"src": src, "tgt": tgt})
        if len(glossary) >= 12:
            break
    generations = max(1, int(meta.get("generationAttempts") or 1))
    providers = max(generations, int(meta.get("providerAttempts") or generations))
    rate_state = ({"gated": False, "adaptive": False, "unlimited": True,
                   "rpm": 0, "burst": 0} if unlimited else
                  ({"gated": False, "adaptive": False, "pinned": False,
                    "rpm": 0, "burst": 0, "waiting": 0} if not rate["enabled"] else
                   rate_gate.snapshot(resolved_provider, config.model, config.api_key)))
    body = {
        "schema": RESULT_SCHEMA, "operationId": str(payload.get("operationId") or ""),
        "translations": translations, "missing": missing,
        "memoryDelta": {"characters": meta.get("characters") or [], "glossary": glossary},
        "meta": {
            "provider": meta.get("provider", ""), "model": meta.get("model", ""),
            "usage": meta.get("usage") if isinstance(meta.get("usage"), dict) else {
                "inputTokens": None, "outputTokens": None, "totalTokens": None, "source": None},
            "modelLimits": meta.get("model_limits") or {},
            "thinkingApplied": meta.get("thinking_applied"),
            "terminalCompleted": meta.get("terminal_completed"),
            "selectedContract": meta.get("selected_contract"),
            "requestedOutputTokens": meta.get("requested_output_tokens"),
            "upstreamProvider": meta.get("upstream_provider") or "",
            "contractDiagnostics": {"duplicateIds": meta.get("duplicate_output_ids") or [],
                "ignoredUnknownIds": meta.get("ignored_output_ids") or [],
                "malformedMarkerIds": ["unknown"] if meta.get("malformed_output_record_count") else []},
            "finishReason": meta.get("finish_reason"), "timeoutPolicy": meta.get("timeout_policy", ""),
            "targetLang": meta.get("target_lang", target_lang), "units": len(units),
            "dt_ms": round((time.perf_counter() - started) * 1000, 1),
            "rateWaitMs": rate_wait_ms, "admissionWaitMs": admission_wait_ms,
            "providerMs": meta.get("provider_ms") if meta.get("provider_ms") is not None else provider_ms,
            "parseMs": round((time.perf_counter() - parse_started) * 1000, 1),
            **route_identity, "rateMode": rate["mode"], "markersFound": bool(extracted_pair),
            "vision": bool(config.image_b64), "passthroughUnits": len(passthrough),
            "outputContract": meta.get("output_contract", ""),
            "responseShape": meta.get("response_shape", ""),
            "acceptedLosslessly": bool(meta.get("accepted_losslessly", False)),
            "contentModified": bool(meta.get("content_modified", False)),
            "omittedIds": list(meta.get("omitted_ids") or []), "declinedIds": declined,
            "rate": rate_state, "providerAttempts": providers, "generationAttempts": generations,
            "httpAttempts": 1, "providerHttpStatuses": [200],
            "automaticContentRetry": False, "automaticTransportRetry": False,
            "modelFallback": False, "schemaFallback": False,
            "aiFlow": meta.get("ai_flow", ""), **(meta.get("prompt_audit") or prompt_meta),
        },
    }
    wire_trace.write_json("07_validation.json", {
        "expectedIds": [unit["id"] for unit in units],
        "acceptedIds": [item["id"] for item in translations],
        "missingIds": missing, "declinedIds": declined,
        "passthroughIds": passthrough, "markersFound": bool(extracted_pair),
    })
    wire_trace.write_json("08_apply_result.json", {"translations": translations})
    return body, missing, declined, passthrough
