"""Append complete source/answer turns; no warm-up, summarizer or old-path fallback."""
from __future__ import annotations
from dataclasses import replace
import hashlib
import json
import math

from .mode import POLICY
from .origins import current_origins, branch_history, boundaries
from .store import current, execution_scope, MAX_HISTORY_CHARS
from backend.ai import wire_trace, trace_preview
from backend.ai.workload import estimate_provider_input, observed_input_scale, positive

INTRO = {
    "th": "นี่คือการแปลต่อเนื่องในเอกสารเดียวกัน ตอบเฉพาะ ID ในข้อความผู้ใช้ล่าสุด หากมีคำแปลก่อนหน้าที่สำเร็จอยู่ในประวัตินี้ ให้ใช้เป็นหลักเพื่อคงศัพท์ น้ำเสียง และรูปแบบให้ต่อเนื่อง แต่ต้นฉบับปัจจุบันที่ชัดเจนมีน้ำหนักเหนือกว่าเสมอ",
    "ja": "同じ文書の翻訳を続けます。最後のユーザーメッセージのIDだけを返してください。この履歴に成功した以前の訳がある場合だけ、用語・口調・表現の一貫性の主な基準として使い、現在の明確な原文を常に優先してください。",
    "en": "Continue translating this document. Return only IDs in the latest user message. When successful prior translations are present in this history, use them as the primary consistency reference for terminology, voice and phrasing, while always giving clear current source text precedence.",
}


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def emit(evidence):
    trace_preview.note("AI translation path", evidence)
    wire_trace.write_json("03_conversation_path.json", evidence)


def execute(invoke, source, target_lang, ai, **kwargs):
    # HTTP/API-job boundaries acquire before AI admission. Direct library users
    # can still invoke safely: there is no outer admission slot in that case.
    with execution_scope(ai, target_lang, kwargs.get("cancel_check")):
        return invoke(source, target_lang, ai, **kwargs)


def _history_messages(turns):
    """Replay provider-visible committed bytes; never rebuild old user turns."""
    result = []
    for turn in turns:
        result.append({"role": "user", "text": turn["user"],
                       **({"image_b64": turn["image"], "image_mime": turn.get("mime", "image/jpeg")} if turn.get("image") else {})})
        result.append({"role": "assistant", "text": turn["assistant"]})
    return result


def _paid_transport_fits(system, user, prior, current_image):
    """Match the paired Center's message envelope without decoding old images.

    Old turns may roll over; the current source/image must still reach Center
    intact for its authoritative syntax, MIME and decompression checks.
    """
    texts = [system, user, *(m["text"] for m in prior)]
    images = [m.get("image_b64", "") for m in prior if m.get("image_b64")]
    if current_image:
        images.append(current_image)
    sizes = [len(v) * 3 // 4 - (2 if v.endswith("==") else 1 if v.endswith("=") else 0) for v in images]
    return (len(prior) + 2 <= 100 and all(len(t) <= 60000 for t in texts)
            and sum(map(len, texts)) <= 180000 and len(images) <= 32
            and all(n <= 4 * 1024 * 1024 for n in sizes)
            and sum(sizes) <= 10 * 1024 * 1024)


def prepare(request, layout, ai):
    lease = current()
    if lease is None:
        raise RuntimeError("Conversation path entered without an execution scope")
    from backend.ai.provider_registry import provider_registry
    from .store import ConversationError
    spec = provider_registry.require(request.provider)
    transport = spec.conversation_transport
    if transport not in ("message_replay", "native_response_cursor"):
        error = ConversationError("The selected provider has no verified Conversation transport")
        error.code = "ai_conversation_unsupported"
        raise error
    native = transport == "native_response_cursor"
    if native and (not callable(getattr(spec.adapter, "conversation_cursor", None)) or
                   not callable(getattr(spec.adapter, "conversation_result_error", None))):
        error = ConversationError("The selected provider has no validated native Conversation adapter")
        error.code = "ai_conversation_unsupported"
        raise error
    full = "\n\n".join(request.user_parts)
    static_len = layout["userStaticChars"]
    persistent_len = min(static_len, int(layout.get("userPersistentStaticChars", static_len)))
    template_static, dynamic = full[:static_len], full[static_len+2:]
    locale = layout["instructionLocale"]
    origins = current_origins(ai.conversation or {}, getattr(lease,"source_texts",[]))
    conversation_source = str((request.cache_context or {}).get("conversationSource") or "")
    image_records = bool(conversation_source and (request.cache_context or {}).get("conversationRecordProtocol") == "tp.translation.image-records/1")
    if image_records:
        # The whole first User static prefix is an immutable anchor. Examples can
        # appear before the final I#_P# contract without requiring positional
        # reconstruction on later turns.
        persistent_template = template_static
        bootstrap_example_chars = int(layout.get("bootstrapExamplesChars", 0) or 0)
        bootstrap_examples = "<persisted-in-anchor>" if bootstrap_example_chars else ""
    else:
        persistent_template = template_static[:persistent_len]
        bootstrap_examples = ""
        if static_len > persistent_len:
            if template_static[persistent_len:persistent_len+2] != "\n\n":
                raise ValueError("conversation_bootstrap_example_boundary_mismatch")
            bootstrap_examples = template_static[persistent_len+2:]
    # Snapshot runtime memory/context in the first User anchor only. Updating
    # Series memory must not change compatibility or become a fresh instruction.
    bootstrap_context = ""
    if image_records:
        from backend.ai.prompts.instruction_packs import instruction_pack
        bootstrap_context = dynamic.rsplit(conversation_source, 1)[0].rstrip() if conversation_source in dynamic else ""
        bootstrap_context = bootstrap_context.removesuffix(instruction_pack(locale)["sourceHeading"]).rstrip()
        dynamic = conversation_source
    else:
        dynamic = boundaries(origins, locale) + dynamic
    intro = INTRO
    static = persistent_template + "\n\n" + intro.get(locale, intro["en"])
    anchor_static = static if image_records else static + (("\n\n" + bootstrap_examples) if bootstrap_examples else "")
    prefix = _hash(request.system_text + "\0" + anchor_static)
    # Resolve happens after lane selection. An "auto" model or a refreshed
    # model revision must never inherit a different executed model's history.
    compatibility = _hash(json.dumps([prefix, request.provider, request.model,
        request.base_url, request.model_capabilities.get("limits", {}).get("modelRevision", ""),
        bool(request.response_schema)], ensure_ascii=False))
    history = list(lease.history)
    start_count = len(history)
    reason = "none"
    if lease.prefix and lease.prefix != compatibility:
        history = []
        reason = "request_profile_changed"
    if (ai.conversation or {}).get("branch") != "repair":
        selected, automatic_reason = branch_history(history, origins, (ai.conversation or {}).get("orderPolicy", "request_arrival"))
        if automatic_reason != "none":
            history, reason = selected, automatic_reason
            # Retire stale/future turns even if this new answer is invalid.
            lease.history=list(history); lease.prefix=compatibility
            lease.dirty=True; lease.branch_only=True
    bounds = dict(request.model_capabilities.get("limits") or {})
    context = positive(bounds.get("contextTokens"))
    # Ollama's loaded allocation is not its architectural limit. Reuse the
    # existing bounded-growth policy; never allocate arbitrary model maxima.
    if request.provider == "ollama":
        from backend.ai.providers.ollama_context import plan_ollama_context
        plan = plan_ollama_context(bounds, {"estimatedInput": 10**9})
        if plan:
            context = plan["evidence"]["contextCeiling"]
    reserve = max(384, positive(request.workload.get("predictedOutput")) or 384) + (positive(request.workload.get("reasoningReserve")) or 0)
    reserve = min(8192, reserve + max(256, math.ceil(reserve*.5)))
    # Unknown limits get a bounded history allowance, not an invented provider
    # context limit. The normal adapter's guard remains authoritative afterwards.
    max_input = min(positive(bounds.get("maxInputTokens")) or math.inf,
                    context-reserve-128 if context else 32768)
    # A small context window with Thai text can be overestimated severalfold.
    # Calibrate only after this exact private model scope reports actual input.
    # The floor leaves ample headroom and unknown/image/schema traffic keeps the
    # original conservative estimate. The provider adapter uses the same lease
    # when checking the composed request immediately before network dispatch.
    samples = [(turn.get('inputTokens'), turn.get('rawEstimatedInput')) for turn in history]
    can_calibrate = (request.provider in ('openrouter', 'openai') and context and
                     context <= 16384 and not request.image_b64 and not request.response_schema)
    scale = observed_input_scale(samples) if can_calibrate else 1.0
    lease.input_estimate_scale = scale
    trimmed = start_count-len(history)
    native_budget_trimmed = 0
    def compose(turns):
        # Normal continuation is immutable append-only replay. If context trimming
        # removes the original anchor, re-anchor the oldest retained turn once;
        # cache continuity is already broken by that trim.
        effective = [dict(turn) for turn in turns]
        if effective and not effective[0].get("anchor"):
            effective[0]["user"] = "\n\n".join(filter(None, (anchor_static, bootstrap_context, effective[0]["user"])))
            effective[0]["bootstrapContext"] = bootstrap_context
            effective[0]["anchor"] = True
        prior = _history_messages(effective)
        initial_anchor = anchor_static + (("\n\n" + bootstrap_context) if bootstrap_context else "")
        user = dynamic if effective else initial_anchor + "\n\n" + dynamic
        estimate = estimate_provider_input(system=request.system_text,
            parts=[user], history=prior,
            schema=dict(request.response_schema) if request.response_schema else None,
            image=bool(request.image_b64))
        return prior, user, estimate, effective
    messages, user, estimate, effective_history = compose(history)
    # Only discard WHOLE old turns. Current source is never truncated; static
    # instructions are reattached exactly once at the new history boundary.
    def paid_over_budget():
        return request.provider == "paid" and not _paid_transport_fits(request.system_text, user, messages, request.image_b64)
    while history and (estimate > max_input or paid_over_budget() or len(json.dumps(history, ensure_ascii=False)) + len(full) + len(request.image_b64) > MAX_HISTORY_CHARS-65536):
        reason = ("paid_transport_budget" if paid_over_budget() else
                  "context_budget" if estimate > max_input else "history_storage_budget")
        history.pop(0)
        trimmed += 1
        native_budget_trimmed += 1
        messages, user, estimate, effective_history = compose(history)
    if request.provider == "paid" and len(json.dumps(effective_history, ensure_ascii=False)) + len(user) + len(request.image_b64) > MAX_HISTORY_CHARS - 65536:
        # A page larger than the retained-history budget must not spend customer
        # credits and only afterwards discover it strands this document's lane.
        error = ConversationError("This page exceeds the Conversation history capacity; reduce the page image size before retrying. No provider request was sent")
        error.code = "ai_conversation_history_capacity"
        raise error
    provider_cursor = ""
    if native:
        # The native server owns earlier messages. A cursor after a budget
        # trim would still reference those discarded turns, defeating the
        # context guard. Start a visible new thread with the full anchor.
        if native_budget_trimmed:
            history = []
            trimmed = start_count
            reason = "native_context_rollover"
            messages, user, estimate, effective_history = compose(history)
        else:
            provider_cursor = spec.adapter.conversation_cursor(effective_history)
    last_upstream = ""
    for turn in reversed(effective_history):
        candidate = str(turn.get("upstreamProvider") or "").strip().lower()
        if candidate:
            last_upstream = candidate[:64]
            break
    base_estimate = estimate_provider_input(system=request.system_text, parts=[anchor_static + "\n\n" + dynamic],
        schema=dict(request.response_schema) if request.response_schema else None, image=bool(request.image_b64))
    ev = {"schema": "tp.conversation/1", "phase":"prepared", "policy": POLICY, "mode": "conversation",
        "path": "conversation", "scope": lease.key[:24] or "ephemeral", "scopeStatus": lease.reason,
        "pageCount":len(origins),"unitCount":request.unit_count,"planner":"conversation_cross_page" if (ai.conversation or {}).get("origins") else "conversation_request",
        "historyRevision": lease.revision, "turnIndex": lease.revision+1,
        "historyTurns": len(history), "historyMessages": len(messages),
        "historyChars": sum(len(m["text"]) for m in messages),
        "rawEstimatedInput": math.ceil(estimate / scale), "inputEstimateScale": scale,
        "historyEstimatedTokens": max(0, estimate-base_estimate), "estimatedInput": estimate,
        "currentUserChars": len(user), "staticUserRepeated": not bool(history),
        "bootstrapExamplesIncluded": bool(bootstrap_examples),
        "bootstrapExamplesPersisted": bool(bootstrap_examples and history and history[0].get("anchor")), "bootstrapExamplesChars": bootstrap_example_chars if image_records else len(bootstrap_examples) if bootstrap_examples else 0,
        "queueWaitMs": round(lease.wait_ms, 3), "trimmedTurns": trimmed, "rolloverReason": reason,
        "historySha256": _hash(json.dumps(messages, ensure_ascii=False, sort_keys=True)),
        "prefixSha256": prefix, "branch": (ai.conversation or {}).get("branch", "initial"),
        "orderPolicy": (ai.conversation or {}).get("orderPolicy", "request_arrival"),
        "commitStatus": "pending", "providerCacheStatus": "not_reported",
        "storage": "api_memory" if lease.store else "ephemeral", "historyQuality": "structural_and_script_checks_not_human_approved",
        "historyMessageRoles": ",".join(m["role"] for m in messages),
        "contextLimit": context, "outputReserve": reserve,
        "providerState": "linked" if provider_cursor else "new",
        "continuationTransport": transport,
        "providerCallsAdded": 0, "legacyFallback": False,
        "recordProtocol": "tp.translation.image-records/1" if image_records else "tp.translation.compact-records/1",
        "continuationUserOcrOnly": bool(image_records and history and dynamic.strip() == conversation_source.strip()),
        "bootstrapContextIncluded": bool(not history and bootstrap_context),
        "bootstrapContextChars": len(bootstrap_context) if not history else 0,
        "memoryDelivery": "first_turn_only" if layout.get("memoryMode") in ("terms", "full") else "off",
        "repairInstructionChars": 0,
        # HF Router is intentionally left in automatic fastest/failover mode.
        # The previous upstream is diagnostics only and must never become a
        # hidden routing input for the next turn.
        "hfInferenceProviderAffinity": None,
        "lastObservedUpstreamProvider": last_upstream or None,
        "providerAffinityStatus": "router_auto_fastest" if request.provider == "huggingface" else "not_applicable"}
    effective_static = anchor_static
    effective_layout = dict(layout)
    effective_layout.update({
        "examplesIncluded": bool(ev["bootstrapExamplesIncluded"]),
        "userStaticChars": len(effective_static),
        "userPersistentStaticChars": len(static),
        "bootstrapExamplesChars": ev["bootstrapExamplesChars"],
        "dynamicChars": len(dynamic),
        "userStaticSha256": _hash(effective_static),
        "userPersistentStaticSha256": _hash(static),
        "staticPrefixSha256": _hash(request.system_text + "\0" + effective_static),
    })
    lease.prepared = {"history": effective_history, "prefix": compatibility, "dynamic": dynamic, "bootstrap_context": bootstrap_context, "current_user": user,
        "image": request.image_b64, "mime": request.image_mime, "evidence": ev,"origins":origins,
        "prompt_layout": effective_layout, "provider_affinity": "",
        "continuation_transport": transport, "provider_id": spec.provider_id,
        "last_observed_upstream": last_upstream}
    lease.evidence = ev
    emit(ev)
    wire_trace.write_json("03_conversation_messages.json", {
        "schema": "tp.conversation_messages/1", "history": messages,
        "currentOrigins":origins, "origins": [{"pages":t.get("pages",[]),"pageId":t.get("pageId", ""), "pageIndex":t.get("pageIndex"),
            "assistantSha256":_hash(t["assistant"]), "sourceSha256":_hash(t["user"])} for t in effective_history],
        "currentUser": user, "systemSha256": _hash(request.system_text),
        "scope": ev["scope"], "turnIndex": ev["turnIndex"]})
    # Output budgets still depend on CURRENT source, not history size. Adapters
    # receive history separately and include it only in input/context guards.
    workload = dict(request.workload)
    workload.update(version=1, estimatedInput=estimate)
    if not positive(workload.get("predictedOutput")):
        from backend.ai.workload import text_weight
        workload["predictedOutput"] = max(128, min(4096, sum(text_weight(str(t)) for t in getattr(lease, "source_texts", []))*2 + request.unit_count*16))
    return replace(request, user_parts=(user,), history_messages=tuple(messages), workload=workload,
        previous_response_id=provider_cursor,
        cache_context={**dict(request.cache_context), "staticPrefixSha256":effective_layout["staticPrefixSha256"],
            "translationMode":"conversation", "conversationPolicy":POLICY,
            "conversationScope":lease.key,
            **({"webchatTrimmedTurns":trimmed, "webchatRolloverReason":reason} if (ai.conversation or {}).get("webchatRunId") else {}),
            # The invocation passes resolved mode in request.thinking. Keep
            # original user intent so native LM Studio cannot mistake an
            # unresolved Minimum or clamped Off for requested Default.
            **({"providerThinkingPreference": getattr(ai, "thinking", request.thinking)}
               if native and spec.provider_id == "lmstudio" else {})})


def _history_assistant_text(result_text, meta, prepared, translated, source_texts):
    """Keep exact provider bytes unless a line-bounded marker defect was salvaged.

    Replaying a malformed marker teaches the next turn the broken grammar.  When
    the decoder proved the damage is confined to physical lines, retain only the
    accepted non-empty records in canonical compact form.
    """
    from backend.ai import markers
    if "seriesSummaryStatus" not in meta and not (meta.get("redundant_closing_delimiter_chars") or meta.get("record_header_recovery_count") or
            meta.get("malformed_output_record_count") and meta.get("malformed_output_recoverable") is True):
        return str(result_text or "")
    values = list(translated[0] if translated else [])
    wire_ids = []
    for origin in prepared.get("origins") or []:
        wire_ids.extend(str(value) for value in (origin.get("unitIds") or []))
    if len(wire_ids) != len(source_texts):
        wire_ids = [f"P{i}" for i in range(len(source_texts))]
    records = []
    for wire_id, value in zip(wire_ids, values):
        text = markers.normalize_unit_text(value)
        if not text:
            continue
        records.append(f"{markers.record_open(wire_id)}:{text}{markers.SUFFIX}")
    if meta.get("seriesSummary"):
        records.append(f"<<TP_MEMO:{meta['seriesSummary']}>>")
    return "\n".join(records)


def finish(result, decoded, ai, source_texts, target_lang, cancel_check=None):
    lease = current()
    prepared = lease.prepared
    from backend.ai.provider_registry import provider_registry
    # AiConfig may name `auto` even after invocation has selected and billed a
    # concrete provider. Finish the same adapter that prepared this lease.
    spec = provider_registry.require(prepared["provider_id"])
    native = prepared["continuation_transport"] == "native_response_cursor"
    ev = prepared["evidence"]
    meta = decoded.get("meta") or {}
    usage = meta.get("usage") or {}
    replayed = spec.provider_id == 'paid' and meta.get('centerOperationReplayed') is True
    cached = usage.get("cachedInputTokens")
    ev["providerCacheStatus"] = "not_requested" if replayed else "not_reported" if cached is None else "reported_hit" if cached > 0 else "reported_zero"
    ev["cachedInputTokens"] = 0 if replayed else cached
    ev["actualInputTokens"] = 0 if replayed else usage.get("inputTokens")
    ev["actualOutputTokens"] = 0 if replayed else usage.get("outputTokens")
    if replayed:
        ev['centerOperationReplayed'] = True
    endpoint_delivery = usage.get("promptDelivery")
    if isinstance(endpoint_delivery, dict):
        ev.update(continuationTransport=endpoint_delivery["transport"],
                  providerState="new" if endpoint_delivery["firstTurn"] else "linked",
                  effectiveWireSystemChars=endpoint_delivery["systemChars"],
                  effectiveWireUserChars=endpoint_delivery["currentUserChars"],
                  staticUserRepeated=endpoint_delivery["firstTurn"],
                  continuationUserOcrOnly=endpoint_delivery["continuationUserOcrOnly"],
                  bootstrapContextIncluded=endpoint_delivery["firstTurn"] and ev["bootstrapContextIncluded"],
                  repairInstructionChars=0)
    ev["providerCallsAdded"] = 0 if replayed else max(1, int(meta.get("generationAttempts") or meta.get("generation_attempts") or meta.get("providerAttempts") or meta.get("provider_attempts") or 1))
    resolved_upstream = str(getattr(result, "upstream_provider", "") or "").strip().lower()[:64]
    ev["resolvedUpstreamProvider"] = resolved_upstream or None
    # Conversation history is a transport/cache transcript, not the final page-quality
    # ledger.  A terminal marker response may contain scattered missing or wrong-
    # language units; those belong to the existing page/repair path and must not
    # invalidate the whole chat turn.  Only structurally ambiguous output is barred
    # from history because replaying it would make the next provider request unsafe.
    from backend.ai import markers
    translated = markers.extract_paragraphs(decoded.get("aiTextFull", ""), len(source_texts))
    structural_usable = (
        result.terminal_completed is True
        and not any(meta.get(k) for k in ("ignored_output_ids", "duplicate_output_ids", "unexpected_prose_chars"))
        and (not meta.get("malformed_output_record_count") or meta.get("malformed_output_recoverable") is True)
        and bool(translated)
        and any(str(v).strip() for v in translated[0])
    )
    canonicalized = bool(meta.get("malformed_output_record_count") or meta.get("redundant_closing_delimiter_chars") or meta.get("record_header_recovery_count"))
    native_recoverable_partial = native and canonicalized and structural_usable
    if native and canonicalized:
        structural_usable = False
    ev["formattingWhitespaceChars"] = meta.get("formatting_whitespace_chars", 0)
    ev["unexpectedProseChars"] = meta.get("unexpected_prose_chars", 0)
    ev["redundantClosingDelimiterChars"] = meta.get("redundant_closing_delimiter_chars", 0)
    ev["recordHeaderRecoveryCount"] = meta.get("record_header_recovery_count", 0)
    ev["commitStatus"] = "not_committed_invalid_output"
    if callable(cancel_check) and cancel_check():
        ev["commitStatus"] = "not_committed_cancelled"
    elif lease.lost:
        ev["commitStatus"] = "not_committed_stale_lease"
    elif native_recoverable_partial:
        # The decoder can still return valid units to the page repair path,
        # but the server-side response_id points to the *raw* malformed reply.
        # Leave the previous accepted cursor/history untouched: the next
        # request continues from that cursor (or starts with a new anchor).
        ev["commitStatus"] = "not_committed_native_transcript_invalid"
        ev["providerState"] = "transcript_invalid"
        if getattr(lease, "branch_only", False):
            # A replay may have retired later accepted turns in prepare().
            # Store.release must commit that branch without a new assistant
            # turn, but its "branched_without_new_turn" storage status must
            # not overwrite the returned partial answer's invalid-turn status.
            lease.evidence = dict(ev)
    elif native and not structural_usable:
        # A native cursor points to the provider's raw answer, so an unusable
        # or rewritten transcript cannot be accepted as a continuation.
        ev["commitStatus"] = "not_committed_native_transcript_invalid"
        ev["providerState"] = "transcript_invalid"
        raise spec.adapter.conversation_result_error(result, reason="transcript_invalid",
            malformed_count=meta.get("malformed_output_record_count") or 0)
    elif structural_usable:
        if native:
            error = spec.adapter.conversation_result_error(result, reason="cursor_missing")
            if error is not None:
                # A success without a cursor would strand the next turn after
                # visible output; keep the provider's usage and report failure.
                ev["commitStatus"] = "not_committed_provider_cursor_missing"
                ev["providerState"] = "cursor_missing"
                raise error
        lease.branch_only=False
        history_assistant = _history_assistant_text(result.text, meta, prepared, translated, source_texts)
        turn = {"pages":prepared["origins"],"user": prepared["current_user"], "anchor": not bool(prepared["history"]), "bootstrapContext": prepared["bootstrap_context"] if not prepared["history"] else "", "assistant": history_assistant,
                "image": prepared["image"], "mime": prepared["mime"],
                "pageId": (ai.conversation or {}).get("pageId", ""),
                "pageIndex": (ai.conversation or {}).get("pageIndex"),
                "inputTokens": usage.get("inputTokens"), "rawEstimatedInput": ev["rawEstimatedInput"],
                "outputTokens": usage.get("outputTokens"),
                "upstreamProvider": resolved_upstream}
        if native:
            turn["providerResponseId"] = result.provider_response_id
        lease.history = prepared["history"] + [turn]
        lease.prefix = prepared["prefix"]
        lease.dirty = True
        ev["commitStatus"] = "pending_commit" if lease.store else "ephemeral_not_retained"
    lease.decoded = decoded
    lease.commit_status = ev["commitStatus"]
    decoded["meta"]["conversation"] = ev
    decoded["meta"]["translationMode"] = "conversation"
    decoded["meta"]["ai_flow"] = ev["planner"]
    decoded["meta"]["promptLayoutScope"] = "effective_provider_request"
    emit(ev)
