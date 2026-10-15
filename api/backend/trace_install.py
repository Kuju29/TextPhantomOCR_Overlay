"""Wrap every backend module's functions for tracing, in one place.

``TP_TRACE=1`` deliberately keeps only explicit route/stage decision notes.
Those notes retain the workflow and timings without turning every helper call
into browser/API/file-I/O load during a large batch.

Called once from ``main.py`` at import time, after every module is loaded. The
list below is the WHOLE backend, module by module, so a new file that is not
here is a hole in the trace — which is why the test in
``tests/test_trace.py`` walks the package and fails when one is missing.
Deleting a line from this list to quiet that test is how a trace stops being
trustworthy; add the module, or add it to ``SKIP_MODULES`` with the reason.

What is deliberately NOT traced
-------------------------------
Functions called per pixel, per glyph or per polygon vertex. One line each
would make the trace file larger than the image it describes and slow the
render enough to change the behaviour being traced. They are named in
``HOT_FUNCTIONS`` with the reason, so "why is this function missing" has an
answer in the source rather than in someone's memory.
"""

from __future__ import annotations

import importlib

from backend import trace

# Modules whose functions are wrapped. Grouped the way a request travels.
MODULES: tuple[str, ...] = (
    # entry
    "backend.api.middleware",
    "backend.api.routes.translate_v1",
    "backend.api.routes.translate",
    "backend.api.routes.ai_v1",
    "backend.api.routes.ai",
    "backend.api.routes.lens_v1",
    "backend.api.routes.lens_groups",
    "backend.api.routes.logs",
    "backend.api.routes.health",
    "backend.api.routes.meta",
    "backend.security",
    # admission + queue
    "backend.jobs.admission",
    "backend.jobs.queue",
    "backend.jobs.cache",
    "backend.jobs.fonts",
    # the pipeline itself
    "backend.jobs.pipeline",
    "backend.warmup",
    # lens
    "backend.lens.client",
    "backend.lens.cookie",
    "backend.lens.document",
    "backend.lens.languages",
    "backend.lens.proto",
    "backend.lens.tree",
    # ai
    "backend.ai.translation.invocation",
    "backend.ai.resolve",
    "backend.ai.provider_resolution",
    "backend.ai.prompts",
    "backend.ai.parsing",
    "backend.ai.markers",
    "backend.ai.rategate",
    "backend.ai.provider_registry",
    "backend.ai.transports.openai_chat",
    "backend.ai.providers.local_openai_runtime",
    "backend.ai.providers.cloud_gemini",
    "backend.ai.providers.cloud_anthropic",
    "backend.ai.clients.base",
    # render
    "backend.render.ai_tree.builder",
    "backend.render.ai_tree.geometry",
    "backend.render.ai_tree.orientation",
    "backend.render.ai_tree.spans",
    "backend.render.colors",
    "backend.render.erase",
    "backend.render.erase_boxes",
    "backend.render.font_config",
    "backend.render.fonts",
    "backend.render.geometry",
    "backend.render.layout",
    "backend.render.patch",
    "backend.render.region",
    "backend.render.relayout",
    "backend.render.text_utils",
    "backend.render.components.typography",
    "backend.render.html.ai",
    "backend.render.html.css",
    "backend.render.html.geometry",
    "backend.render.html.lens",
    "backend.render.html.overlay",
    # utils
    "backend.utils.images",
    "backend.utils.text",
)

# Modules left out on purpose, with the reason. The test reads this.
SKIP_MODULES: dict[str, str] = {
    "backend.ai.login.login_auth": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_entitlement": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_http": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_native": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_oauth_common": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_observability": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_profiles": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_chatgpt": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_claude": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_contract": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_deepseek": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_gemini": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_huggingface": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_openrouter": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_provider_registry": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_routes": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_session_store": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.ai.login.login_translation": "Login has explicit metadata-only stage diagnostics; generic argument/return tracing could expose OAuth credentials",
    "backend.trace": "the tracer cannot trace itself without recursing",
    "backend.diagnostic_retention": "trace storage accounting cannot trace its own writes without recursing",
    "backend.trace_install": "this file",
    "backend.log": "the logger; tracing it would trace every trace",
    "backend.logfile": "writes the other log file; same recursion risk",
    "backend.config": "read once at import, before tracing is installed",
    "backend.cli": "not part of the server request path",
    "backend.main": "wiring only; its work is in the routers above",
    "backend.cancellation": "small state holder; routes trace cancellation decisions",
}

# Per-module functions that would flood the file or expose private text; each
# entry says why. Names must exist in the module: a stale name silently skips
# nothing.
HOT_FUNCTIONS: dict[str, tuple[str, ...]] = {
    # Prompt composition, provider payloads and their text returns are private
    # page/series content. Explicit route notes retain model, timings, hashes,
    # counts and outcomes without serialising source or translated dialogue.
    "backend.api.routes.ai_v1": ("ai_translate_v1",),
    "backend.api.routes.ai": ("resolve", "prompt_default"),
    "backend.ai.translation.invocation": ("translate",),
    "backend.ai.resolve": ("resolve", "prompt_default"),
    "backend.ai.prompts": (
        "lang_style", "build_glossary_block", "build_series_block",
        "build_speaker_block", "build_prev_context_block", "build_character_block",
        "build_system_text", "build_system_split", "build_user_parts",
    ),
    "backend.ai.parsing": (
        "parse_character_memo",
    ),
    "backend.ai.markers": (
        "apply", "expected_count", "translation_schema",
        "extract_indices", "split_memo", "has_complete_sequence",
        "normalize_unit_text", "sanitize", "extract_paragraphs",
        "has_meaningful_text", "clamp_runaway_repeats",
        "clamp_output_repeats",
    ),
    "backend.ai.transports.openai_chat": ("execute_chat_completion",),
    "backend.ai.providers.cloud_gemini": ("generate",),
    "backend.ai.providers.cloud_anthropic": ("generate",),
    "backend.render.components.typography": ("fit_item_font_size",),
    "backend.render.html.overlay": ("render_tree_overlay",),
    # Returns the raw Lens Cookie header. Function-level return tracing would
    # put AEC/NID values under the generic key `ret`, bypassing name-based
    # secret redaction. Route/stage notes still record cookie refresh outcome.
    "backend.lens.cookie": ("get",),
    # One call PER CHARACTER of every string measured; would dominate the trace.
    "backend.render.text_utils": ("is_thai_char", "is_rtl_char"),
    # Per item/glyph fitting helpers. A 14-minute diagnostic run produced over
    # 100,000 lines from these helpers alone. The enclosing group/layout/render
    # functions retain inputs, outputs and total duration, so stage detail is
    # preserved without the tracer becoming the workload.
    "backend.render.region": ("classify_item_axis", "box_rotation_deg"),
    "backend.render.layout": (
        "count_text_length", "tokens_with_spaces", "collapse_intra_script_spaces",
    ),
    "backend.render.colors": (
        "relative_luminance", "contrast_ratio", "pick_bw_text_color", "median_rgba",
    ),
    # The protobuf decoder, called per FIELD and per BYTE: it would dominate
    # the file, and tracer overhead lands on the parent's clock. The decoded
    # RESULT is still visible because `lens/tree.py` is traced.
    "backend.lens.proto": (
        "read_varint", "parse", "f32", "get_float_field",
        "looks_like_span", "looks_like_geom", "is_item_message",
        "extract_span", "extract_item_geom_spans", "get_points_from_geom",
        "extract_items_from_paragraph",
    ),
}

def install() -> dict[str, int]:
    """Wrap everything. Returns module -> number of functions wrapped."""
    if not trace.full_enabled():
        return {}
    wrapped: dict[str, int] = {}
    for name in MODULES:
        try:
            module = importlib.import_module(name)
        except Exception:  # noqa: BLE001 - an optional dep missing must not stop the server
            continue
        count = trace.wrap_module(module, skip=HOT_FUNCTIONS.get(name, ()))
        if count:
            wrapped[name] = count
    trace.write("api", "trace_install.py", "install", "..",
                {"modules": len(wrapped), "functions": sum(wrapped.values())})
    return wrapped

