"""Text-only AI translation (v1).


``POST /v1/ai/translate`` takes text units and returns translated text units.
It never performs Lens or rendering. An explicitly opted-in, bounded page
image may accompany the text as AI context only.

What this is for
----------------
In the target architecture the extension owns the workflow: it obtains the Lens
geometry (directly, or from ``/v1/lens/fallback``), it renders, and it patches
the translation back into the geometry it already has. The only thing it cannot
do is use the operator's AI credential — so that, and nothing else, is what
this endpoint provides.

The consequence worth stating: this endpoint never receives a page image. A
user translating a hundred manga pages with AI uploads zero of them here.

Three things this does that ``/translate`` could not
---------------------------------------------------
1. **One provider call per image.** Every text unit is submitted together once,
   preserving the page context and marker order.
2. **Incomplete results are observable.** 18 of 20 units come back as 18
   translations plus a ``missing`` list. The client stops the image visibly;
   this endpoint does not silently create another billable provider call.
3. **Idempotency.** ``Idempotency-Key`` makes a client retry free instead of
   billable. The in-process ledger does not provide cross-replica idempotency.
"""

from __future__ import annotations

import hashlib
import asyncio
import base64
import io
import math
import re
import threading
import time
import unicodedata
from collections import OrderedDict
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from backend.ai import markers, parsing
from backend.ai.errors import ModelOutputContractError
from backend.api.local_client import wants_unlimited
from backend.ai.failure_reason import classify as _ai_failure_kind
from backend.ai.failure_reason import is_rate_limited as _ai_is_rate_limited
from backend.ai.failure_reason import retry_after_sec as _ai_retry_after_sec
from backend.ai import prompts as ai_prompts
from backend.ai.rategate import rate_gate, RateGateRejected, RateGateTimeout
from backend.ai.providers import resolve_provider
from backend.ai.translate import (
    AiConfig,
    resolve_generation_model,
    translate as ai_translate,
)
from backend.config import settings
from backend.jobs.admission import AdmissionRejected, identity_of
from backend.log import event
from backend.security import SecurityError
from backend import cancellation, trace

router = APIRouter()

REQUEST_SCHEMA = "tp.ai.request/1"
RESULT_SCHEMA = "tp.ai.result/1"

# Bound the work one request may ask for. Without this a single caller can pin
# a worker for minutes with a payload no real page produces.
MAX_UNITS = 200
MAX_UNIT_CHARS = 4000
MAX_TOTAL_CHARS = 60000
MAX_IMAGE_BYTES = 12 * 1024 * 1024

# --- Idempotency ledger -----------------------------------------------------
# Deliberately small and in-process. It makes a client retry free on THIS
# replica; it does not survive a restart and does not span replicas. Anything
# stronger needs shared storage, and pretending otherwise here would be worse
# than the honest limitation.
_LEDGER_MAX = 512
_LEDGER_TTL_SEC = 3600.0
_ledger: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_ledger_lock = threading.Lock()


def _ledger_get(key: str) -> dict | None:
    with _ledger_lock:
        hit = _ledger.get(key)
        if not hit:
            return None
        at, value = hit
        if time.time() - at > _LEDGER_TTL_SEC:
            _ledger.pop(key, None)
            return None
        _ledger.move_to_end(key)
        return value


def _ledger_put(key: str, value: dict) -> None:
    with _ledger_lock:
        _ledger[key] = (time.time(), value)
        _ledger.move_to_end(key)
        while len(_ledger) > _LEDGER_MAX:
            _ledger.popitem(last=False)


def unit_hash(text: str) -> str:
    """Stable id tying every returned unit to its source text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _language_neutral_unit(text: str) -> bool:
    """Whether the API must return a unit byte-for-byte.

    Manga OCR commonly emits page numbers and punctuation as their own bubble
    groups (``10``, ``?``, ``…``). Gemini sometimes drops those markers because
    there is nothing to translate; retrying the same two characters does not
    make them more translatable. Preserve numeric / punctuation / symbol-only
    units deterministically. They still share the page's batched provider call,
    but the provider's wording for their slots is ignored and they can never
    make an otherwise complete single response fail. Letters in every script
    still use the model's answer.
    """
    visible = [ch for ch in str(text or "") if not ch.isspace()]
    return bool(visible) and all(unicodedata.category(ch)[0] in ("N", "P", "S") for ch in visible)


def _rgb_for_jpeg(src):
    """Flatten palette/alpha images onto white without Pillow's P->RGB warning."""
    from PIL import Image

    has_alpha = "A" in src.getbands() or "transparency" in src.info
    if not has_alpha:
        return src.convert("RGB")
    rgba = src.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(white, rgba).convert("RGB")


def _validate_units(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("units must be a non-empty list")
    if len(raw) > MAX_UNITS:
        raise ValueError(f"too many units ({len(raw)} > {MAX_UNITS})")

    units: list[dict[str, str]] = []
    total = 0
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"unit {index} is not an object")
        uid = str(item.get("id") or "").strip()
        text = str(item.get("text") or "")
        if not uid:
            raise ValueError(f"unit {index} has no id")
        if uid in seen:
            # Duplicate ids make the response ambiguous: the client cannot tell
            # which of the two a translation belongs to.
            raise ValueError(f"duplicate unit id {uid!r}")
        seen.add(uid)
        if not text.strip():
            raise ValueError(f"unit {uid} has no text")
        if len(text) > MAX_UNIT_CHARS:
            raise ValueError(f"unit {uid} is {len(text)} chars (max {MAX_UNIT_CHARS})")
        total += len(text)
        if total > MAX_TOTAL_CHARS:
            raise ValueError(f"request exceeds {MAX_TOTAL_CHARS} characters")
        units.append({"id": uid, "text": text})
    return units


def _build_config(payload: dict) -> AiConfig:
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    memory = payload.get("memory") if isinstance(payload.get("memory"), dict) else {}

    user_key = str(provider.get("apiKey") or "").strip()
    config = AiConfig(
        api_key=user_key or settings.ai_api_key,
        user_key=bool(user_key),
        provider=str(provider.get("id") or "auto").strip() or "auto",
        model=str(provider.get("model") or "auto").strip() or "auto",
        base_url=str(provider.get("baseUrl") or "auto").strip() or "auto",
        thinking=str(provider.get("thinking") or "default").strip().lower() or "default",
        prompt_editable=str(payload.get("prompt") or "").strip(),
        glossary=memory.get("glossary") if isinstance(memory.get("glossary"), list) else [],
        characters=memory.get("characters") if isinstance(memory.get("characters"), list) else [],
        char_memory=bool(memory.get("enabled")) or bool(memory.get("characters")),
        series_state=str(memory.get("seriesState") or "").strip(),
        prev_context=memory.get("previousContext")
        if isinstance(memory.get("previousContext"), list)
        else [],
    )
    image = payload.get("image") if isinstance(payload.get("image"), dict) else {}
    data_uri = str(image.get("dataUri") or "").strip()
    if data_uri:
        try:
            header, encoded = data_uri.split(",", 1)
            if not header.startswith("data:image/") or ";base64" not in header:
                raise ValueError("image must be a base64 image data URI")
            raw = base64.b64decode(encoded, validate=True)
            if len(raw) > MAX_IMAGE_BYTES:
                raise ValueError("page image is too large")
            from PIL import Image
            with Image.open(io.BytesIO(raw)) as src:
                src = _rgb_for_jpeg(src)
                src.thumbnail((1280, 1280))
                out = io.BytesIO()
                src.save(out, format="JPEG", quality=68, optimize=True)
            config.image_b64 = base64.b64encode(out.getvalue()).decode("ascii")
            config.image_mime = "image/jpeg"
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(f"invalid page image: {exc}") from exc
    return config


def _rate_options(payload: dict) -> dict[str, Any]:
    raw = payload.get("rate") if isinstance(payload.get("rate"), dict) else {}
    enabled = raw.get("enabled", settings.rate_gate_enabled)
    if isinstance(enabled, str):
        enabled = enabled.strip().lower() in ("1", "true", "yes", "on")
    def number(name: str) -> float:
        try:
            return max(0.0, float(raw.get(name) or 0))
        except (TypeError, ValueError):
            return 0.0
    return {"enabled": bool(enabled), "rpm": number("rpm"), "burst": int(number("burst"))}


@router.post("/v1/ai/translate")
async def ai_translate_v1(
    request: Request,
    payload: dict[str, Any],
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """Translate text units, with optional vision context; no Lens/rendering."""
    t0 = time.perf_counter()
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    trace_id = str(context.get("tp_trace") or "")

    def trace_failure(stage: str, exc: BaseException, status: int, **details: Any) -> None:
        provider_status = re.search(r"\bHTTP\s+(\d{3})\b", str(exc), re.IGNORECASE)
        provider_attempts = int(details.pop("providerAttempts", 0) or 0)
        generation_attempts = int(details.pop("generationAttempts", provider_attempts) or 0)
        trace.write(
            "api", "api/routes/ai_v1.py", "ai_translate_v1", "!!",
            {
                "stage": stage,
                "failureKind": _ai_failure_kind(exc),
                "errorType": type(exc).__name__,
                "error": str(exc),
                "httpStatus": status,
                "automaticContentRetry": False,
                "automaticTransportRetry": False,
                "providerAttempts": provider_attempts,
                "generationAttempts": generation_attempts,
                "providerHttpStatuses": (
                    [int(provider_status.group(1))] if provider_status else []
                ),
                "modelFallback": False,
                "schemaFallback": False,
                **details,
            },
            trace_id=trace_id,
        )

    if cancellation.is_cancelled(payload):
        exc = RuntimeError("batch was cancelled before AI started")
        trace_failure("cancelled", exc, 409)
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    try:
        units = _validate_units(payload.get("units"))
    except ValueError as exc:
        trace_failure("request_validation", exc, 400)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    target_lang = str(payload.get("targetLang") or "").strip()
    if not target_lang:
        exc = ValueError("targetLang is required")
        trace_failure("request_validation", exc, 400, units=len(units))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    prompt_meta = ai_prompts.prompt_metadata(
        target_lang, str(payload.get("prompt") or "").strip()
    )
    try:
        config = _build_config(payload)
    except ValueError as exc:
        trace_failure("configuration", exc, 400, units=len(units))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    resolved_provider = resolve_provider(config.provider, config.api_key)
    if not resolved_provider and config.api_key:
        exc = ValueError("AI provider must be selected explicitly for this API key")
        trace_failure("configuration", exc, 400, units=len(units))
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    resolved_model = resolve_generation_model(resolved_provider, config.model)
    rate = _rate_options(payload)
    image_bytes = (len(config.image_b64) * 3) // 4 if config.image_b64 else 0
    trace.write(
        "api", "api/routes/ai_v1.py", "ai_translate_v1", "->",
        {
            "units": len(units),
            "chars": sum(len(unit["text"]) for unit in units),
            "targetLang": target_lang,
            "pageImage": bool(config.image_b64),
            "pageImageBytes": image_bytes,
            "thinking": config.thinking,
            "requestedProvider": config.provider,
            "requestedModel": config.model,
            "resolvedProvider": resolved_provider,
            "resolvedModel": resolved_model,
            "outputContractRequested": "one_shot_envelope_v3",
            "automaticContentRetry": False,
            "automaticTransportRetry": False,
            "modelFallback": False,
            "schemaFallback": False,
            "rateEnabled": rate["enabled"],
            "rateRpm": rate["rpm"],
            "rateBurst": rate["burst"],
            "memoryEnabled": bool(config.char_memory),
            "glossaryItems": len(config.glossary),
            "characterItems": len(config.characters),
            "previousContextItems": len(config.prev_context),
            "hasSeriesState": bool(config.series_state),
            **prompt_meta,
        },
        trace_id=trace_id,
    )

    key = str(idempotency_key or "").strip()
    if key:
        cached = _ledger_get(key)
        if cached is not None:
            # Replayed verbatim, and SAID so: a client that cannot tell a
            # replay from a fresh call cannot tell whether its retry worked.
            replayed = {
                **cached,
                "meta": {
                    **(cached.get("meta") if isinstance(cached.get("meta"), dict) else {}),
                    "providerAttempts": 0,
                    "generationAttempts": 0,
                    "httpAttempts": 0,
                    "replayedFromLedger": True,
                },
                "replayed": True,
            }
            trace.write(
                "api", "api/routes/ai_v1.py", "ai_translate_v1", "<-",
                {
                    "replayed": True,
                    "providerAttempts": 0,
                    "generationAttempts": 0,
                    "httpAttempts": 0,
                    "automaticContentRetry": False,
                    "automaticTransportRetry": False,
                },
                trace_id=trace_id,
            )
            return replayed

    # Optional user-pinned RPM pacing. Auto/provider-managed requests arrive
    # with rate.enabled=false and skip this gate entirely; the real provider
    # response is then the source of truth for quota/backpressure.
    # A runtime on the caller's own machine has no quota and no other tenant to
    # be fair to. Verified server-side: the header alone is not enough.
    unlimited = wants_unlimited(request)
    rate_wait_started = time.perf_counter()
    # What this key looked like at the moment this request joined the queue.
    # The snapshot taken at the END of the call reports the state AFTER the
    # queue drained, so a page that waited 22 s behind 30 others reported
    # "waiting: 0" and the wait had to be inferred from arithmetic.
    rate_entry = (
        rate_gate.snapshot(resolved_provider, config.model, config.api_key)
        if rate["enabled"] and not unlimited
        else {}
    )
    if rate["enabled"] and not unlimited:
        try:
            await rate_gate.acquire(
                resolved_provider,
                config.model,
                config.api_key,
                session=str(context.get("tp_tab_session") or trace_id),
                job_id=str(payload.get("operationId") or idempotency_key or f"ai-v1-{time.time_ns()}"),
                deadline_sec=settings.rate_max_wait_sec,
                max_waiters=settings.rate_max_waiters_per_bucket,
                rpm_override=rate["rpm"] or None,
                burst_override=rate["burst"] or None,
            )
        except (RateGateTimeout, RateGateRejected) as exc:
            # A 429 from THIS gate is not the same event as a 429 from the
            # provider, and the client must be able to tell them apart.
            #
            # A provider 429 means "you are sending too much at once" — the
            # client should narrow its concurrency window. A gate 429 means
            # "this key's tokens are spoken for; come back when one frees" —
            # the concurrency window is not the problem and narrowing it makes
            # the batch slower without making the bucket refill faster. The
            # client used to treat both the same and halve its lane, which fed
            # back into the gate never seeing enough clean traffic to speed up.
            #
            # `Retry-After` is computed from the queue in front of this request
            # rather than a flat 5 s, so thirty rejected pages do not all come
            # back at the same moment to be rejected again.
            retry_after = rate_gate.retry_after_sec(
                resolved_provider, config.model, config.api_key
            )
            trace_failure(
                "rate_gate", exc, 429,
                units=len(units), requestedProvider=config.provider,
                requestedModel=config.model, providerAttempts=0,
                rateOnEntry=rate_entry, retryAfterSec=round(retry_after, 2),
            )
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "rate_gate_busy",
                    "message": str(exc),
                    "retryAfterMs": int(retry_after * 1000),
                    "rpm": rate_entry.get("rpm", 0),
                    "waiting": rate_entry.get("waiting", 0),
                },
                headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
            ) from exc
    rate_wait_ms = round((time.perf_counter() - rate_wait_started) * 1000, 1)
    if cancellation.is_cancelled(payload):
        exc = RuntimeError("batch was cancelled while waiting for AI pacing")
        trace_failure(
            "cancelled", exc, 409, units=len(units), rateWaitMs=rate_wait_ms,
            providerAttempts=0,
        )
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    # The marker protocol is what lets one model call carry many units and come
    # back separable. Reusing the existing one keeps this endpoint and the
    # legacy pipeline producing identical text for identical input.
    marked = markers.apply([u["text"] for u in units])

    # This endpoint is async, but every provider SDK below it is synchronous.
    # Running that call on the event-loop was an accidental global mutex: while
    # image A waited for Gemini, image B could not even enter this route. The
    # AI-specific admission gate bounds provider concurrency; a worker thread
    # keeps unrelated image pipelines and all other endpoints moving.
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    identity_payload = {
        "ai": {"api_key": str(provider.get("apiKey") or "")},
        "context": payload.get("context") if isinstance(payload.get("context"), dict) else {},
    }
    identity = identity_of(identity_payload)
    provider_timing: dict[str, float] = {}
    def _run_ai() -> dict:
        with trace.scope(trace_id):
            provider_started = time.perf_counter()
            try:
                return ai_translate(marked, target_lang, config)
            finally:
                provider_timing["provider_ms"] = round(
                    (time.perf_counter() - provider_started) * 1000, 1
                )

    admission_started = time.perf_counter()
    admission_wait_ms = 0.0
    try:
        if unlimited:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(request.app.state.ai_executor, _run_ai)
        else:
            async with request.app.state.ai_admission_gate.slot(identity):
                admission_wait_ms = round(
                    (time.perf_counter() - admission_started) * 1000, 1
                )
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(request.app.state.ai_executor, _run_ai)
        # The provider accepted this call. A streak of these raises the sustained
        # rate for THIS key only, so a paid key stops being paced at the free rate.
        if rate["enabled"] and not unlimited:
            rate_gate.report_success(resolved_provider, config.model, config.api_key)
    except AdmissionRejected as exc:
        event("v1.ai.translate.busy", {"identity": identity}, ok=False)
        trace_failure(
            "admission_gate", exc, 503,
            units=len(units), rateWaitMs=rate_wait_ms,
            admissionWaitMs=admission_wait_ms,
            requestedProvider=config.provider, requestedModel=config.model,
            providerAttempts=0,
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "server_busy",
                "message": str(exc),
                "retryAfterMs": int(exc.retry_after_sec * 1000),
                "providerAttempts": 0,
                "generationAttempts": 0,
                "automaticContentRetry": False,
                "automaticTransportRetry": False,
            },
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc
    except SecurityError as exc:
        trace_failure(
            "provider_security", exc, 400,
            units=len(units), rateWaitMs=rate_wait_ms,
            admissionWaitMs=admission_wait_ms,
            providerMs=provider_timing.get("provider_ms", 0.0),
            requestedProvider=config.provider, requestedModel=config.model,
            providerAttempts=0,
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ModelOutputContractError as exc:
        structural = dict(getattr(exc, "structural_details", {}) or {})
        trace_failure(
            "model_output_contract", exc, 502,
            units=len(units), chars=sum(len(unit["text"]) for unit in units),
            pageImage=bool(config.image_b64),
            rateWaitMs=rate_wait_ms,
            admissionWaitMs=admission_wait_ms,
            providerMs=provider_timing.get("provider_ms", 0.0),
            requestedProvider=config.provider,
            requestedModel=config.model,
            resolvedProvider=structural.get("resolvedProvider", resolved_provider),
            resolvedModel=structural.get("resolvedModel", resolved_model),
            outputContractRequested="one_shot_envelope_v3",
            structuralDetails=structural,
            providerAttempts=1,
            providerHttpStatuses=[200],
        )
        raise HTTPException(
            status_code=502,
            detail={
                "error": "invalid_model_output",
                "message": str(exc),
                "structuralDetails": structural,
                "providerAttempts": 1,
                "generationAttempts": 1,
                "automaticContentRetry": False,
                "automaticTransportRetry": False,
                "modelFallback": False,
                "schemaFallback": False,
            },
        ) from exc
    except ValueError as exc:
        trace_failure(
            "provider_validation", exc, 400,
            units=len(units), rateWaitMs=rate_wait_ms,
            admissionWaitMs=admission_wait_ms,
            providerMs=provider_timing.get("provider_ms", 0.0),
            requestedProvider=config.provider, requestedModel=config.model,
            providerAttempts=0,
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # provider/network/output-contract failures
        # A provider 429/503 is a rejected HTTP attempt, not a model generation.
        # It is therefore safe for the extension to wait and re-submit the SAME
        # idempotency key without violating the one-generation-per-image rule.
        provider_limited = _ai_is_rate_limited(exc)
        provider_retry_sec = _ai_retry_after_sec(exc) if provider_limited else 0.0
        if rate["enabled"] and not unlimited and provider_limited:
            rate_gate.report_rate_limited(
                resolved_provider, config.model, config.api_key,
                retry_after_sec=provider_retry_sec,
            )
        kind = _ai_failure_kind(exc)
        generation_attempts = 0 if provider_limited else 1
        trace_failure(
            "provider_or_output_contract", exc, 502,
            units=len(units), chars=sum(len(unit["text"]) for unit in units),
            pageImage=bool(config.image_b64),
            timing={
                "rateWaitMs": rate_wait_ms,
                "admissionWaitMs": admission_wait_ms,
                "providerMs": provider_timing.get("provider_ms", 0.0),
            },
            requested={"provider": config.provider, "model": config.model},
            resolved={"provider": resolved_provider, "model": resolved_model},
            outputContractRequested="one_shot_envelope_v3",
            providerAttempts=1,
            generationAttempts=generation_attempts,
        )
        detail = {
            "code": "provider_rate_limited" if provider_limited else "provider_failed",
            "message": f"AI translation failed ({kind}); inspect TP_TRACE for details",
            "providerAttempts": 1,
            "generationAttempts": generation_attempts,
            "automaticContentRetry": False,
            "automaticTransportRetry": False,
            "modelFallback": False,
            "schemaFallback": False,
        }
        headers = None
        if provider_limited:
            retry_sec = max(1.0, float(provider_retry_sec or 1.0))
            detail["retryAfterMs"] = int(retry_sec * 1000)
            headers = {"Retry-After": str(max(1, math.ceil(retry_sec)))}
        raise HTTPException(status_code=502, detail=detail, headers=headers) from exc

    text_full = str(result.get("aiTextFull") or "")
    if cancellation.is_cancelled(payload):
        event("v1.ai.translate.cancelled", {"units": len(units)}, ok=False)
        exc = RuntimeError("batch was cancelled while AI was running")
        trace_failure(
            "cancelled", exc, 409, units=len(units),
            providerMs=provider_timing.get("provider_ms", 0.0),
            providerAttempts=1,
        )
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    # `extract_paragraphs` returns (paragraphs, clean_text) or None when the
    # model answered without any markers at all. None is not "no translations"
    # — it means the protocol broke — so it is reported as every unit missing
    # rather than as an empty success.
    extracted_pair = markers.extract_paragraphs(text_full, len(units))
    extracted: list[str] = list(extracted_pair[0]) if extracted_pair else []

    # Two different things end up in `missing`, and they have different causes
    # and different fixes:
    #
    #   OMITTED  — the entry for that id is not in the answer at all. The
    #              output contract broke; the marker protocol lost a unit.
    #   DECLINED — the entry IS there and its text is the empty string. The
    #              contract held; the model used the "cannot be translated"
    #              escape hatch, which it reaches for on short interjections
    #              and SFX far more readily than the prompt intends.
    #
    # Both leave the source pixels on the page, which reads to the user as
    # "I asked for Thai and got Japanese". Telling them apart is what makes
    # that diagnosable: an omission is a protocol/provider problem, a decline
    # is a prompt problem. `omitted_ids` comes from the decoder, which alone
    # knows which ids were absent before alignment filled them with "".
    result_meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    omitted_from_answer = {str(item) for item in (result_meta.get("omitted_ids") or [])}
    translations: list[dict[str, str]] = []
    missing: list[str] = []
    declined: list[str] = []
    passthrough: list[str] = []
    for index, unit in enumerate(units):
        text = markers.normalize_unit_text(extracted[index] if index < len(extracted) else "")
        if _language_neutral_unit(unit["text"]):
            # Provider output is not authoritative for language-neutral
            # content, even when it emitted the marker. Keep the exact source
            # so '?' cannot become Thai prose and page '10' cannot be rewritten.
            translations.append({
                "id": unit["id"],
                "text": markers.normalize_unit_text(unit["text"]),
                "hash": unit_hash(unit["text"]),
            })
            passthrough.append(unit["id"])
        elif text:
            translations.append({"id": unit["id"], "text": text, "hash": unit_hash(unit["text"])})
        else:
            # Structurally present but empty text remains observable. The
            # client treats this image as terminal; no automatic AI retry.
            missing.append(unit["id"])
            if f"P{index}" not in omitted_from_answer:
                declined.append(unit["id"])

    glossary_delta: list[dict[str, str]] = []
    for unit, translated in zip(units, extracted):
        src = str(unit.get("text") or "").strip()
        tgt = markers.normalize_unit_text(translated)
        if ai_prompts.looks_like_term(src, tgt):
            glossary_delta.append({"src": src, "tgt": tgt})
        if len(glossary_delta) >= 12:
            break

    meta = result.get("meta") if isinstance(result.get("meta"), dict) else {}
    body = {
        "schema": RESULT_SCHEMA,
        "operationId": str(payload.get("operationId") or ""),
        "translations": translations,
        "missing": missing,
        "memoryDelta": {
            "characters": meta.get("characters") or [],
            "glossary": glossary_delta,
        },
        "meta": {
            "provider": meta.get("provider", ""),
            "model": meta.get("model", ""),
            "targetLang": meta.get("target_lang", target_lang),
            "units": len(units),
            "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
            "rateWaitMs": rate_wait_ms,
            "admissionWaitMs": admission_wait_ms,
            "providerMs": provider_timing.get("provider_ms", 0.0),
            # Said out loud so a page that came back blank is distinguishable
            # from a page the model simply had nothing to say about.
            "markersFound": bool(extracted_pair),
            "vision": bool(config.image_b64),
            "passthroughUnits": len(passthrough),
            "outputContract": meta.get("output_contract", ""),
            "responseShape": meta.get("response_shape", ""),
            "acceptedLosslessly": bool(meta.get("accepted_losslessly", False)),
            "contentModified": bool(meta.get("content_modified", False)),
            "omittedIds": list(meta.get("omitted_ids") or []),
            # Units whose entry arrived with an empty string. `missing` minus
            # `declinedIds` is the set the answer never mentioned.
            "declinedIds": declined,
            "rate": (
                {"gated": False, "adaptive": False, "unlimited": True, "rpm": 0, "burst": 0}
                if unlimited
                else ({"gated": False, "adaptive": False, "pinned": False,
                       "rpm": 0, "burst": 0, "waiting": 0}
                      if not rate["enabled"]
                      else rate_gate.snapshot(resolved_provider, config.model, config.api_key))
            ),
            "providerAttempts": 1,
            "generationAttempts": 1,
            "httpAttempts": 1,
            "providerHttpStatuses": [200],
            "automaticContentRetry": False,
            "automaticTransportRetry": False,
            "modelFallback": False,
            "schemaFallback": False,
            "aiFlow": meta.get("ai_flow", ""),
            **prompt_meta,
        },
    }

    if key:
        _ledger_put(key, body)

    event(
        "v1.ai.translate",
        {
            "units": len(units),
            "translated": len(translations),
            "missing": len(missing),
            "missing_ids": missing,
            "omitted_ids": body["meta"]["omittedIds"],
            "declined_ids": declined,
            "provider": body["meta"]["provider"],
            "model": body["meta"]["model"],
            "dt_ms": body["meta"]["dt_ms"],
            "rate_wait_ms": body["meta"]["rateWaitMs"],
            "rpm_now": body["meta"]["rate"].get("rpm"),
            "admission_wait_ms": body["meta"]["admissionWaitMs"],
            "provider_ms": body["meta"]["providerMs"],
        },
        ok=not missing,
    )
    # Name the thing this request actually spent its life on. Every number
    # needed for this was already in the trace, but only as three separate
    # durations that a reader had to compare by hand — so "the page was slow"
    # and "the page was queued behind its own API key" looked identical.
    waits = {
        "rate_gate": float(rate_wait_ms),
        "provider": float(body["meta"]["providerMs"] or 0.0),
        "admission": float(admission_wait_ms),
    }
    dominant_wait = max(waits, key=lambda k: waits[k]) if max(waits.values()) > 0 else "none"
    trace.write(
        "api", "api/routes/ai_v1.py", "ai_translate_v1", "<-",
        {"translated": len(translations), "missing": len(missing),
         "dominantWait": dominant_wait,
         # Queue state when this request JOINED, not after it drained.
         "rateRpmOnEntry": rate_entry.get("rpm", 0),
         "rateQueueDepthOnEntry": rate_entry.get("waiting", 0),
         "rateOkStreakOnEntry": rate_entry.get("okStreak", 0),
         "rateOkStreakTarget": rate_entry.get("okStreakTarget", 0),
         "missingIds": missing, "omittedIds": body["meta"]["omittedIds"],
         "declinedIds": declined,
         "passthroughIds": passthrough,
         "provider": body["meta"]["provider"], "model": body["meta"]["model"],
         "dt_ms": body["meta"]["dt_ms"],
         "rateWaitMs": body["meta"]["rateWaitMs"],
         "admissionWaitMs": body["meta"]["admissionWaitMs"],
         "providerMs": body["meta"]["providerMs"],
         "rate": body["meta"]["rate"],
         "vision": body["meta"]["vision"],
         "markersFound": body["meta"]["markersFound"],
         "outputContract": body["meta"]["outputContract"],
         "responseShape": body["meta"]["responseShape"],
         "acceptedLosslessly": body["meta"]["acceptedLosslessly"],
         "contentModified": body["meta"]["contentModified"],
         "providerAttempts": body["meta"]["providerAttempts"],
         "generationAttempts": body["meta"]["generationAttempts"],
         "httpAttempts": body["meta"]["httpAttempts"],
         "automaticContentRetry": False,
         "automaticTransportRetry": False,
         "modelFallback": False,
         "schemaFallback": False,
         "aiFlow": body["meta"]["aiFlow"],
         "passthroughUnits": body["meta"]["passthroughUnits"],
         "memoryCharacters": len(body["memoryDelta"]["characters"]),
         "memoryGlossary": len(body["memoryDelta"]["glossary"]),
         **prompt_meta},
        trace_id=trace_id,
    )
    return body


@router.get("/v1/ai/schema")
async def ai_schema() -> dict:
    """The request/result schemas and the limits a client must respect."""
    return {
        "ok": True,
        "request": REQUEST_SCHEMA,
        "result": RESULT_SCHEMA,
        "limits": {
            "maxUnits": MAX_UNITS,
            "maxUnitChars": MAX_UNIT_CHARS,
            "maxTotalChars": MAX_TOTAL_CHARS,
        },
        "hasServerKey": bool(settings.ai_api_key),
    }


# Re-exported for the tests: parsing is part of the contract this endpoint
# promises, not an implementation detail callers may ignore.
__all__ = ["router", "unit_hash", "parsing"]
