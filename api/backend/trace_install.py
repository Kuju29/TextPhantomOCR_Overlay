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
import pkgutil

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
    "backend.api.routes.blocks_v1",
    "backend.api.routes.groups_v1",
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
    "backend.ai.translate",
    "backend.ai.resolve",
    "backend.ai.providers",
    "backend.ai.prompts",
    "backend.ai.parsing",
    "backend.ai.markers",
    "backend.ai.rategate",
    "backend.ai.throttle",
    "backend.ai.config",
    "backend.ai.clients.openai_compat",
    "backend.ai.clients.gemini",
    "backend.ai.clients.anthropic",
    "backend.ai.clients.base",
    # render
    "backend.render.build_ai_tree",
    "backend.render.bubble",
    "backend.render.colors",
    "backend.render.erase",
    "backend.render.erase_boxes",
    "backend.render.font_config",
    "backend.render.fonts",
    "backend.render.geometry",
    "backend.render.groups",
    "backend.render.layout",
    "backend.render.patch",
    "backend.render.region",
    "backend.render.relayout",
    "backend.render.text_metrics",
    "backend.render.text_utils",
    "backend.render.textblocks",
    "backend.render.tp_html",
    # utils
    "backend.utils.images",
    "backend.utils.text",
)

# Modules left out on purpose, with the reason. The test reads this.
SKIP_MODULES: dict[str, str] = {
    "backend.trace": "the tracer cannot trace itself without recursing",
    "backend.trace_install": "this file",
    "backend.log": "the logger; tracing it would trace every trace",
    "backend.logfile": "writes the other log file; same recursion risk",
    "backend.config": "read once at import, before tracing is installed",
    "backend.cli": "not part of the server request path",
    "backend.main": "wiring only; its work is in the routers above",
    "backend.cancellation": "small state holder; routes trace cancellation decisions",
}

# Per-module functions that would flood the file or expose private text. Each
# entry says why, and
# every name is checked against the real module by `tests/test_trace.py` —
# because the first version of this list was written from memory and NINE of
# its ten names did not exist. A skip list of imaginary functions silently
# skips nothing, and the flood it was meant to prevent arrives anyway.
HOT_FUNCTIONS: dict[str, tuple[str, ...]] = {
    # Prompt composition, provider payloads and their text returns are private
    # page/series content. Explicit route notes retain model, timings, hashes,
    # counts and outcomes without serialising source or translated dialogue.
    "backend.api.routes.ai_v1": ("ai_translate_v1",),
    "backend.api.routes.ai": ("resolve", "prompt_default"),
    "backend.ai.translate": ("translate",),
    "backend.ai.resolve": ("resolve", "prompt_default"),
    "backend.ai.prompts": (
        "lang_style", "build_glossary_block", "build_series_block",
        "build_speaker_block", "build_prev_context_block", "build_character_block",
        "build_system_text", "build_system_split", "build_user_parts",
    ),
    "backend.ai.parsing": (
        "strip_wrappers", "parse_json", "parse_character_memo",
        "parse_speaker_pairs", "parse_text",
    ),
    "backend.ai.markers": (
        "apply", "expected_count", "translation_schema", "parse_translation_object",
        "extract_indices", "split_memo", "has_complete_sequence",
        "normalize_unit_text", "sanitize", "extract_paragraphs",
        "has_meaningful_text", "clamp_runaway_repeats",
        "clamp_output_repeats",
    ),
    "backend.ai.throttle": ("generate_with_backoff",),
    "backend.ai.clients.openai_compat": ("generate",),
    "backend.ai.clients.gemini": ("generate",),
    "backend.ai.clients.anthropic": ("generate",),
    "backend.render.tp_html": (
        "fit_item_font_size", "render_tree_overlay", "ai_tree_to_tp_html",
        "lens_tree_to_lens_html",
    ),
    # Returns the raw Lens Cookie header. Function-level return tracing would
    # put AEC/NID values under the generic key `ret`, bypassing name-based
    # secret redaction. Route/stage notes still record cookie refresh outcome.
    "backend.lens.cookie": ("get",),
    # One call PER CHARACTER of every string measured. Measured 2026-08-07 on
    # one 11-paragraph page: 90 of the 215 render trace lines were `is_rtl_char`
    # alone, and that page has almost no text.
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
    "backend.render.groups": ("direction_is_vertical_hint", "canvas_is_oversized"),
    # The protobuf decoder, called per FIELD and per BYTE. Measured on a real
    # 26-image run: 64,464 lines from `read_varint` and 10,384 from `parse` —
    # 36% of a 43 MB file — and every one of them said the same thing. Worse,
    # they were actively misleading: a child's "entered" line is written on the
    # parent's clock, so `parse` appeared to cost 17.4 ms per call while
    # `read_varint` itself showed 0.0 s, and the file read as "the protobuf
    # parser is 70% of the runtime". It is not. That was the tracer.
    #
    # What anyone actually needs is the RESULT of the decode, and `lens/tree.py`
    # is still traced, so the paragraphs and items that came out are all there.
    "backend.lens.proto": (
        "read_varint", "parse", "f32", "to_hex", "get_float_field",
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


def all_backend_modules() -> set[str]:
    """Every module under ``backend`` — what the coverage test compares against."""
    import backend

    found = set()
    for info in pkgutil.walk_packages(backend.__path__, prefix="backend."):
        if info.ispkg:
            continue
        found.add(info.name)
    return found
