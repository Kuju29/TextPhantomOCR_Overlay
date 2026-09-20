"""Append complete source/answer turns; no warm-up, summarizer or old-path fallback."""
from __future__ import annotations
from dataclasses import replace
import hashlib
import json
import math

from .mode import POLICY
from .origins import current_origins, branch_history, boundaries
from .store import current, execution_scope, MAX_HISTORY_CHARS, cancelled
from .messages import history_parts
from backend.ai import wire_trace, trace_preview
from backend.ai.workload import estimate_provider_input, positive

INTRO = {
    "th": "นี่คือการแปลต่อเนื่องในเอกสารเดียวกัน ตอบเฉพาะ ID ในข้อความผู้ใช้ล่าสุด หากมีคำแปลก่อนหน้าที่สำเร็จอยู่ในประวัตินี้ ให้ใช้เป็นหลักเพื่อคงศัพท์ น้ำเสียง และรูปแบบให้ต่อเนื่อง แต่ต้นฉบับปัจจุบันที่ชัดเจนมีน้ำหนักเหนือกว่าเสมอ",
    "ja": "同じ文書の翻訳を続けます。最後のユーザーメッセージのIDだけを返してください。この履歴に成功した以前の訳がある場合だけ、用語・口調・表現の一貫性の主な基準として使い、現在の明確な原文を常に優先してください。",
    "en": "Continue translating this document. Return only IDs in the latest user message. When successful prior translations are present in this history, use them as the primary consistency reference for terminology, voice and phrasing, while always giving clear current source text precedence.",
}

REPAIR_NOTE = {
    "th": "นี่คือรอบซ่อมของเอกสารเดียวกัน ตอบเฉพาะ ID ในข้อความผู้ใช้ล่าสุด ใช้ประวัติคำแปลก่อนหน้าก็ต่อเมื่อมีอยู่จริงในคำขอนี้ มิฉะนั้นให้ยึดบริบทที่แนบและต้นฉบับปัจจุบัน ห้ามสมมติว่ามีประวัติที่ไม่ได้ส่งมา ID ที่ส่งมาซ่อมอาจมีเลขขาดช่วง ให้คัดลอก ID แต่ละรายการตามต้นฉบับและแปลเฉพาะข้อความที่อยู่ใน marker เดียวกัน ห้ามเรียงเลขใหม่ ห้ามเลื่อนคำแปลไปเติมช่องว่าง และห้ามนำข้อความบริบทมาเป็นรายการคำตอบ หากแปลรายการใดไม่ได้ ให้คง ID เดิมและตอบว่างเฉพาะรายการนั้น",
    "ja": "同じ文書の修復要求です。最後のユーザーメッセージのIDだけを返してください。以前の訳はこの要求に実際に含まれている場合だけ参照し、なければ添付された文脈と現在の原文を基準にしてください。送られていない履歴を仮定しないでください。 修復対象のIDは連番とは限りません。各IDをそのままコピーし、同じマーカー内の原文だけを訳してください。番号の振り直し、欠番を埋めるための訳の移動、文脈を回答対象にすることは禁止です。訳せない項目は同じIDで空欄にしてください。",
    "en": "This is a repair request for the same document. Return only IDs in the latest user message. Use prior translations only when they are actually present in this request; otherwise rely on the supplied context and current source. Do not assume unseen translation history. Repair IDs may have gaps. Copy each ID exactly and translate only the source inside that same marker. Never renumber, shift translations to fill gaps, or return context as target records. When an item cannot be translated, keep its original ID with an empty value.",
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


def prepare(request, layout, ai):
    lease = current()
    if lease is None:
        raise RuntimeError("Conversation path entered without an execution scope")
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
    # Normal continuation is deliberately OCR-only. All task/output/image-ID
    # semantics and human examples live in the immutable first User anchor.
    # Repair appends to the same chat, retaining the immutable prefix.
    if image_records and (ai.conversation or {}).get("branch") != "repair":
        dynamic = conversation_source
    elif image_records:
        dynamic = dynamic.rsplit(conversation_source, 1)[0].rstrip() + "\n" + conversation_source if conversation_source in dynamic else conversation_source
    else:
        dynamic = boundaries(origins,locale) + dynamic
    if (ai.conversation or {}).get("branch") == "repair":
        dynamic = REPAIR_NOTE.get(locale, REPAIR_NOTE["en"]) + "\n\n" + dynamic
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
    trimmed = start_count-len(history)
    def compose(turns):
        # Normal continuation is immutable append-only replay. If context trimming
        # removes the original anchor, re-anchor the oldest retained turn once;
        # cache continuity is already broken by that trim.
        effective = [dict(turn) for turn in turns]
        if effective and not effective[0].get("anchor"):
            effective[0]["user"] = anchor_static + "\n\n" + effective[0]["user"]
            effective[0]["anchor"] = True
        prior = _history_messages(effective)
        user = dynamic if effective else anchor_static + "\n\n" + dynamic
        estimate = estimate_provider_input(system=request.system_text,
            parts=[user], history=prior,
            schema=dict(request.response_schema) if request.response_schema else None,
            image=bool(request.image_b64))
        return prior, user, estimate, effective
    messages, user, estimate, effective_history = compose(history)
    # Only discard WHOLE old turns. Current source is never truncated; static
    # instructions are reattached exactly once at the new history boundary.
    while history and (estimate > max_input or len(json.dumps(history, ensure_ascii=False)) + len(full) + len(request.image_b64) > MAX_HISTORY_CHARS-65536):
        history.pop(0)
        trimmed += 1
        reason = "context_budget" if estimate > max_input else "history_storage_budget"
        messages, user, estimate, effective_history = compose(history)
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
        "historyEstimatedTokens": max(0, estimate-base_estimate), "estimatedInput": estimate,
        "currentUserChars": len(user), "staticUserRepeated": not bool(history),
        "bootstrapExamplesIncluded": bool(bootstrap_examples),
        "bootstrapExamplesPersisted": bool(bootstrap_examples and history and history[0].get("anchor")), "bootstrapExamplesChars": len(bootstrap_examples) if bootstrap_examples else 0,
        "queueWaitMs": round(lease.wait_ms, 3), "trimmedTurns": trimmed, "rolloverReason": reason,
        "historySha256": _hash(json.dumps(messages, ensure_ascii=False, sort_keys=True)),
        "prefixSha256": prefix, "branch": (ai.conversation or {}).get("branch", "initial"),
        "orderPolicy": (ai.conversation or {}).get("orderPolicy", "request_arrival"),
        "commitStatus": "pending", "providerCacheStatus": "not_reported",
        "storage": "api_memory" if lease.store else "ephemeral", "historyQuality": "structural_and_script_checks_not_human_approved",
        "historyMessageRoles": ",".join(m["role"] for m in messages),
        "contextLimit": context, "outputReserve": reserve,
        "providerCallsAdded": 0, "legacyFallback": False,
        "recordProtocol": "tp.translation.image-records/1" if image_records else "tp.translation.compact-records/1",
        "continuationUserOcrOnly": bool(image_records and history),
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
    lease.prepared = {"history": effective_history, "prefix": compatibility, "dynamic": dynamic, "current_user": user,
        "image": request.image_b64, "mime": request.image_mime, "evidence": ev,"origins":origins,
        "prompt_layout": effective_layout, "provider_affinity": "",
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
        cache_context={**dict(request.cache_context), "staticPrefixSha256":effective_layout["staticPrefixSha256"],
            "translationMode":"conversation", "conversationPolicy":POLICY,
            "conversationScope":lease.key})


def _history_assistant_text(result_text, meta, prepared, translated, source_texts):
    """Keep exact provider bytes unless a line-bounded marker defect was salvaged.

    Replaying a malformed marker teaches the next turn the broken grammar.  When
    the decoder proved the damage is confined to physical lines, retain only the
    accepted non-empty records in canonical compact form.
    """
    from backend.ai import markers
    if not (meta.get("malformed_output_record_count") and meta.get("malformed_output_recoverable") is True):
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
    return "\n".join(records)


def finish(result, decoded, ai, source_texts, target_lang, cancel_check=None):
    lease = current()
    prepared = lease.prepared
    ev = prepared["evidence"]
    meta = decoded.get("meta") or {}
    usage = meta.get("usage") or {}
    cached = usage.get("cachedInputTokens")
    ev["providerCacheStatus"] = "not_reported" if cached is None else "reported_hit" if cached > 0 else "reported_zero"
    ev["cachedInputTokens"] = cached
    ev["actualInputTokens"] = usage.get("inputTokens")
    ev["actualOutputTokens"] = usage.get("outputTokens")
    ev["providerCallsAdded"] = max(1, int(meta.get("generationAttempts") or meta.get("generation_attempts") or meta.get("providerAttempts") or meta.get("provider_attempts") or 1))
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
    ev["formattingWhitespaceChars"] = meta.get("formatting_whitespace_chars", 0)
    ev["unexpectedProseChars"] = meta.get("unexpected_prose_chars", 0)
    ev["commitStatus"] = "not_committed_invalid_output"
    branch = (ai.conversation or {}).get("branch")
    if callable(cancel_check) and cancel_check():
        ev["commitStatus"] = "not_committed_cancelled"
    elif lease.lost:
        ev["commitStatus"] = "not_committed_stale_lease"
    elif structural_usable:
        lease.branch_only=False
        history_assistant = _history_assistant_text(result.text, meta, prepared, translated, source_texts)
        turn = {"pages":prepared["origins"],"user": prepared["current_user"], "anchor": not bool(prepared["history"]), "assistant": history_assistant,
                "image": prepared["image"], "mime": prepared["mime"],
                "pageId": (ai.conversation or {}).get("pageId", ""),
                "pageIndex": (ai.conversation or {}).get("pageIndex"),
                "inputTokens": usage.get("inputTokens"), "outputTokens": usage.get("outputTokens"),
                "upstreamProvider": resolved_upstream}
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
