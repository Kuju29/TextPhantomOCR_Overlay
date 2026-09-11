"""Local-file pipeline runner + debug dumper.

Runs the full translation pipeline on an image file **without starting the
HTTP server**, and writes every intermediate artefact to a directory so the
Lens trees and the generated AI tree can be inspected and compared.

Usage::

    # single image
    python -m backend.cli 19.jpg --lang th --source ai --ai-key AIza...
    python -m backend.cli 19.jpg --lang th --source ai --ai-key AIza... \\
        --lens-json debug/lens_raw.json          # replay a saved Lens response

    # 6-way cross translation — translate each image into every other
    # image's language (eng->jp, eng->th, jp->eng, jp->th, th->eng, th->jp)
    python -m backend.cli eng.jpg jp.jpg th.jpg --source ai --ai-key AIza... \\
        --out-dir "debug-{name}-new2" \\
        --lens-json "debug-{name}-new1/lens_raw.json"

Outputs (in ``--out-dir``, default ``debug/``):

    lens_raw.json            raw Google Lens response (replayable)
    original_tree.json       canonical source tree used by AI
    original_tree_raw.json   untouched Lens "original" render tree
    translated_tree.json     Lens "translated" render tree
    ai_tree.json             the AI tree this pipeline built
    original_text.txt        }
    translated_text.txt      } the three layers' plain text
    ai_text.txt              }
    ai_meta.json             provider / model / marker-repair info
    ai_prompt_system.txt     }
    ai_prompt_user_0.txt     } what was actually sent to the AI
    ai_prompt_user_1.txt     }   (the reference-translation block, if any)
    ai_raw_response.txt      the AI's raw reply before sanitisation
    erased.png               background image with original text erased
    preview_original.html    }
    preview_translated.html  } standalone HTML previews (open in a browser)
    preview_ai.html          }
    summary.txt              tree stats + timings
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import base64, argparse, json, mimetypes, re, subprocess, sys, tempfile, time

from backend.ai.translation.contracts import AiConfig
from backend.config import settings
from backend.lens.languages import normalize as normalize_lang
from backend.lens.tree import tree_stats

def _write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

def _write_text(path: Path, text: str) -> None:
    path.write_text(str(text or ""), encoding="utf-8")

def _bounded_diagnostics(value: Any, depth: int = 0) -> Any:
    """Make exception diagnostics safe and finite for a durable CLI artifact."""
    if depth >= 6:
        return "[TRUNCATED_DEPTH]"
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for index, (raw_key, child) in enumerate(value.items()):
            if index >= 64:
                result["_truncated_keys"] = len(value) - 64
                break
            key = str(raw_key)[:160]
            normalized = key.lower().replace("-", "_")
            if any(secret in normalized for secret in ("api_key", "authorization", "credential", "secret", "token")):
                result[key] = "[REDACTED]"
            else:
                result[key] = _bounded_diagnostics(child, depth + 1)
        return result
    if isinstance(value, (list, tuple, set)):
        sequence = list(value)
        result = [_bounded_diagnostics(child, depth + 1) for child in sequence[:128]]
        if len(sequence) > 128:
            result.append({"_truncated_items": len(sequence) - 128})
        return result
    if isinstance(value, str):
        return value if len(value) <= 2000 else value[:2000] + "[TRUNCATED]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:2000]

def _safe_error_message(exc: BaseException) -> str:
    """Keep useful local context without persisting credentials from errors."""
    message = str(exc)
    if type(exc).__name__ == "DetectorFreeGroupingError":
        return message
    message = re.sub(r"https?://[^\s]+", "[REDACTED_URL]", message, flags=re.IGNORECASE)
    message = re.sub(
        r"(?i)\b(api[_-]?key|authorization|credential|secret|token)\b\s*[:=]\s*[^\s,;]+",
        lambda match: f"{match.group(1)}=[REDACTED]",
        message,
    )
    message = re.sub(r"(?i)\bbearer\s+[^\s,;]+", "Bearer [REDACTED]", message)
    return message[:2000] + ("[TRUNCATED]" if len(message) > 2000 else "")

def _write_failure(
    out_dir: Path,
    lens_data: Any,
    exc: BaseException,
    *,
    engine: str,
    stage: str,
) -> None:
    """Persist a failed diagnostic run without disguising it as a result."""
    out_dir.mkdir(parents=True, exist_ok=True)
    if isinstance(lens_data, dict):
        _write_json(out_dir / "lens_raw.json", lens_data)
    details: dict[str, Any] = {}
    diagnostics = getattr(exc, "details", None)
    if isinstance(diagnostics, dict) and diagnostics:
        details = _bounded_diagnostics(diagnostics)
    grouping_failure = type(exc).__name__ == "DetectorFreeGroupingError"
    error = {
        "schema": "tp.cli-error/1",
        "engine": engine,
        "stage": stage,
        "code": "grouping_failed" if grouping_failure else "pipeline_failed",
        "exception": type(exc).__name__,
        "message": _safe_error_message(exc),
        "details": details,
        "retryable": False,
    }
    _write_json(out_dir / "error.json", error)
    _write_text(
        out_dir / "summary.txt",
        "TextPhantom diagnostic run: FAILED\n"
        f"engine : {engine}\n"
        f"stage  : {stage}\n"
        f"code   : {error['code']}\n"
        f"error  : {error['message']}\n"
        "See error.json and lens_raw.json. The CLI did not fall back to the other engine.\n",
    )

def _prewarm_fonts(lang: str) -> tuple[bool, str, str]:
    """Warm CLI fonts without letting missing glyph coverage abort startup."""
    from backend.jobs.fonts import resolve_font_pair
    from backend.render.fonts import UnsupportedFontError, is_truetype, pick_font

    thai_font, latin_font = resolve_font_pair(lang)
    try:
        probe = pick_font("กa", thai_font, latin_font, 64)
    except UnsupportedFontError as exc:
        print(
            f"[cli] WARNING: font prewarm degraded ({exc}); continuing with "
            "geometry-only layout fallback for unsupported text.",
            file=sys.stderr,
        )
        return False, thai_font, latin_font
    if not is_truetype(probe):
        print(
            "[cli] WARNING: font prewarm produced no validated scalable font; "
            "continuing with geometry-only layout fallback.",
            file=sys.stderr,
        )
        return False, thai_font, latin_font
    print(f"[cli] fonts ok: thai={thai_font} latin={latin_font}")
    return True, thai_font, latin_font

def _data_uri_to_bytes(data_uri: str) -> bytes:
    """Decode a ``data:...;base64,`` URI to raw bytes (empty on failure)."""
    s = str(data_uri or "")
    if "base64," not in s:
        return b""
    b64 = s.split("base64,", 1)[1]
    try:
        return base64.b64decode(b64 + "=" * ((4 - len(b64) % 4) % 4))
    except Exception:
        return b""

def _standalone_html(title: str, bg_data_uri: str, overlay_html: str, css: str, base_w: int, base_h: int) -> str:
    """Wrap a layer's overlay markup + erased background into a viewable HTML file."""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>{title}</title>
<style>
  html,body{{margin:0;background:#111;}}
  .tp-export{{position:relative;width:min(100vw,{base_w}px);margin:0 auto;}}
  .tp-export>img{{display:block;width:100%;height:auto;}}
  .tp-export .tp-ol-root{{position:absolute!important;inset:0!important;display:block!important;}}
  .tp-export .tp-ol-scope{{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;}}
  {css}
</style></head>
<body><div class="tp-export" style="aspect-ratio:{base_w}/{base_h}">
  <img src="{bg_data_uri}" alt="background" />
  <div class="tp-ol-root"><div class="tp-ol-scope">{overlay_html}</div></div>
</div></body></html>"""

def _dump(
    result: dict[str, Any], lens_data: dict[str, Any], out_dir: Path, *, source: str
) -> None:
    """Write every inspectable artefact from a pipeline result."""
    out_dir.mkdir(parents=True, exist_ok=True)
    # A successful rerun must not inherit the failure verdict from an older
    # invocation that used the same diagnostic directory.
    (out_dir / "error.json").unlink(missing_ok=True)

    _write_json(out_dir / "lens_raw.json", lens_data)

    original = result.get("original") or {}
    translated = result.get("translated") or {}
    ai = result.get("Ai") or {}

    raw_original_tree = original.get("originalTree") or {}
    canonical_original_tree = result.get("canonicalOriginalTree") or {}
    # ``original_tree.json`` is the logical, grouped source tree used by AI.
    # Raw Lens geometry remains available explicitly for fingerprint/erase QA.
    _write_json(
        out_dir / "original_tree.json",
        canonical_original_tree or raw_original_tree,
    )
    _write_json(out_dir / "original_tree_raw.json", raw_original_tree)
    _write_json(out_dir / "translated_tree.json", translated.get("translatedTree") or {})
    _write_json(out_dir / "ai_tree.json", ai.get("aiTree") or {})

    _write_text(out_dir / "original_text.txt", result.get("originalTextFull") or "")
    _write_text(out_dir / "translated_text.txt", result.get("translatedTextFull") or "")
    _write_text(out_dir / "ai_text.txt", result.get("AiTextFull") or "")

    # Split the AI meta: keep the verbose request/response in dedicated files
    # so ai_meta.json stays small and readable.
    meta = dict(ai.get("meta") or {})
    debug_req = meta.pop("debug_request", None)
    debug_resp = meta.pop("debug_response_raw", None)
    debug_req_first = meta.pop("debug_request_first", None)
    debug_resp_first = meta.pop("debug_response_raw_first", None)
    debug_first_text = meta.pop("debug_first_attempt_text", None)
    _write_json(out_dir / "ai_meta.json", meta)

    def _dump_request(prefix: str, req: dict | None, raw: str | None) -> None:
        if req:
            _write_text(out_dir / f"{prefix}prompt_system.txt", req.get("system_text") or "")
            for i, part in enumerate(req.get("user_parts") or []):
                _write_text(out_dir / f"{prefix}prompt_user_{i}.txt", part)
        if raw is not None:
            _write_text(out_dir / f"{prefix}raw_response.txt", raw)

    # Final attempt (what the AI tree was built from):
    _dump_request("ai_", debug_req, debug_resp)
    # First attempt (only present when a retry happened):
    if debug_req_first or debug_resp_first or debug_first_text:
        _dump_request("ai_first_", debug_req_first, debug_resp_first)
        if debug_first_text is not None:
            _write_text(out_dir / "ai_first_text.txt", debug_first_text)

    # The erased background image.
    erased = _data_uri_to_bytes(result.get("imageDataUri") or "")
    if erased:
        (out_dir / "erased.png").write_bytes(erased)

    # Standalone HTML previews — open these in a browser to see each layer.
    html_meta = result.get("htmlMeta") or {}
    base_w = int(html_meta.get("baseW") or 0) or 1000
    base_h = int(html_meta.get("baseH") or 0) or 1000
    css = result.get("htmlCss") or ""
    bg = result.get("imageDataUri") or ""
    if bg:
        previews = {
            "preview_original.html": ("Original", original.get("originalhtml") or ""),
            "preview_translated.html": ("Translated", translated.get("translatedhtml") or ""),
            "preview_ai.html": ("AI", ai.get("aihtml") or ""),
        }
        for filename, (title, overlay_html) in previews.items():
            if overlay_html:
                _write_text(
                    out_dir / filename,
                    _standalone_html(title, bg, overlay_html, css, base_w, base_h),
                )

    # Human-readable summary.
    summary = [
        f"image       : {result.get('mode')}",
        f"original    : {tree_stats(original.get('originalTree'))}",
        f"translated  : {tree_stats(translated.get('translatedTree'))}",
        f"ai          : {tree_stats(ai.get('aiTree'))}",
        f"ai meta     : {json.dumps(meta, ensure_ascii=False)}",
        f"perf        : {json.dumps(result.get('perf') or {}, ensure_ascii=False)}",
    ]

    # Per-paragraph length comparison + AI vs fallback provenance.
    translated_paras = (result.get("translatedTextFull") or "").split("\n\n")
    ai_paras = (result.get("AiTextFull") or "").split("\n\n")
    provenance = meta.get("marker_provenance") or []
    if translated_paras or ai_paras:
        summary.append("")
        summary.append("per-paragraph (chars: translated -> ai  | source):")
        n = max(len(translated_paras), len(ai_paras), len(provenance))
        for i in range(n):
            tr = translated_paras[i] if i < len(translated_paras) else ""
            aip = ai_paras[i] if i < len(ai_paras) else ""
            src = provenance[i] if i < len(provenance) else "ai"
            mark = "✓" if src == "ai" else "×"  # × = filled from Lens fallback
            summary.append(f"  P{i:02d}: {len(tr):4d} -> {len(aip):4d}  {mark}")

    _write_text(out_dir / "summary.txt", "\n".join(summary) + "\n")
    ai_selected = source == "ai"
    _write_json(out_dir / "run_status.json", {
        "schema": "tp.cli-run-status/1",
        "engine": "runsapi",
        "source": source,
        "structuralOk": True,
        # A translated/original structural run must never be reported as an AI
        # end-to-end success merely because its geometry can render.
        "aiEndToEnd": (
            "completed_to_render_artifact_browser_insertion_not_tested"
            if ai_selected else "not_tested_source_not_ai"
        ),
        "providerGenerationAttempts": (
            int(meta.get("generationAttempts") or 0) if ai_selected else 0
        ),
        "browserDom": "not_tested_requires_browser",
        "serviceWorkerSession": "not_tested_requires_browser",
        "deliveryInsertion": "not_tested_requires_browser",
    })

def _resolve_path_template(template: str, stem: str, multi: bool, base: str) -> Path:
    """Resolve a per-image output path.

    * ``{name}`` in ``template`` is replaced by the image stem — this lets a
      single ``--out-dir debug-{name}-new1`` expand to ``debug-eng-new1`` …
    * otherwise, when several images are processed, each gets its own
      ``<out-dir>/<stem>`` sub-directory so the dumps never collide;
    * a single image keeps the bare ``--out-dir`` for backwards compatibility.
    """
    if "{name}" in template:
        return Path(template.replace("{name}", stem))
    if multi:
        return Path(base) / stem
    return Path(base)

def _ai_tree_of(result: dict[str, Any]) -> dict[str, Any]:
    """The AI render tree of a pipeline result (empty dict when absent)."""
    ai = result.get("Ai") or {}
    tree = ai.get("aiTree")
    return tree if isinstance(tree, dict) else {}

# Map an image filename stem to a language code.  The 6-way cross run infers
# each image's source language from its filename ("eng.jpg" -> en, …).
_LANG_BY_STEM: dict[str, str] = {
    "en": "en", "eng": "en", "english": "en",
    "ja": "ja", "jp": "ja", "jpn": "ja", "japanese": "ja",
    "th": "th", "tha": "th", "thai": "th",
    "zh": "zh", "cn": "zh", "chinese": "zh",
    "ko": "ko", "kr": "ko", "korean": "ko",
}

def _infer_lang(stem: str) -> str:
    """Best-effort language code for an image whose name encodes its language.

    Matches the whole stem first ("eng" -> en), then a leading token
    ("eng_page01" -> en), and finally falls back to ``normalize_lang``.
    """
    s = (stem or "").strip().lower()
    if s in _LANG_BY_STEM:
        return _LANG_BY_STEM[s]
    for token in s.replace("-", "_").split("_"):
        if token in _LANG_BY_STEM:
            return _LANG_BY_STEM[token]
    for key, code in _LANG_BY_STEM.items():
        if s.startswith(key):
            return code
    return normalize_lang(s)

def _para_aabb_px(para: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """Axis-aligned bounding box of a paragraph in image pixels.

    Prefers ``para.bounds_px`` (set by both the Lens decoder and the AI tree
    builder); falls back to the union of the items' ``bounds_px``.
    """
    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        try:
            x1, y1, x2, y2 = (float(v) for v in bp)
            if x2 > x1 and y2 > y1:
                return x1, y1, x2, y2
        except (TypeError, ValueError):
            pass
    xs: list[float] = []
    ys: list[float] = []
    for it in para.get("items") or []:
        ibp = it.get("bounds_px")
        if isinstance(ibp, (list, tuple)) and len(ibp) == 4:
            try:
                xs.extend([float(ibp[0]), float(ibp[2])])
                ys.extend([float(ibp[1]), float(ibp[3])])
            except (TypeError, ValueError):
                continue
    if xs and ys:
        return min(xs), min(ys), max(xs), max(ys)
    return None

def _box_rows(tree: dict[str, Any], img_w: float, img_h: float) -> list[dict[str, Any]]:
    """Per-box layout summary of a render tree — position, line-breaks, text.

    Works for an AI tree *and* for a Lens original/translated tree, so an
    AI translation can be compared against the real target-language page.
    ``cx``/``cy`` are the box-centre as a percentage of the image (pages of
    different pixel sizes line up); ``lines`` is the item count — the
    artist's line-break / line-spacing signal.
    """
    w = float(img_w) or 1.0
    h = float(img_h) or 1.0
    rows: list[dict[str, Any]] = []
    for p in tree.get("paragraphs") or []:
        items = p.get("items") or []
        aabb = _para_aabb_px(p)
        if aabb is None:
            cx = cy = 0.0
        else:
            cx = (aabb[0] + aabb[2]) / 2.0 / w * 100.0
            cy = (aabb[1] + aabb[3]) / 2.0 / h * 100.0
        fs = int(p.get("para_font_size_px") or 0)
        if fs <= 0:
            heights = sorted(
                float((it.get("box") or {}).get("height") or 0.0) * h
                for it in items
                if str(it.get("text") or "").strip()
            )
            if heights:
                fs = int(round(heights[len(heights) // 2]))
        rows.append({
            "idx": p.get("para_index"),
            "cx": round(cx, 1),
            "cy": round(cy, 1),
            "lines": len(items),
            "font": fs,
            "rotated": bool(p.get("rotated")),
            "single_set": bool(p.get("is_single_set")),
            "text": (p.get("text") or "").strip(),
        })
    return rows

def _fmt_box_row(label: str, row: dict[str, Any] | None) -> str:
    """One aligned line describing a box for the pairwise comparison."""
    if row is None:
        return f"   {label:<5s} (no matching box)"
    flags = ("rot " if row["rotated"] else "    ") + ("single" if row["single_set"] else "multi ")
    text = row["text"].replace("\n", " ")
    if len(text) > 46:
        text = text[:45] + "…"
    return (
        f"   {label:<5s} lines={row['lines']:<2d} font={row['font']:<3d} "
        f"pos=({row['cx']:>5.1f}%,{row['cy']:>5.1f}%) {flags} \"{text}\""
    )

def _dims_of(result: dict[str, Any]) -> tuple[float, float]:
    """Image pixel size of a pipeline result (from ``htmlMeta``)."""
    meta = result.get("htmlMeta") or {}
    return float(meta.get("baseW") or 1) or 1.0, float(meta.get("baseH") or 1) or 1.0

def _write_comparison(
    runs: list[dict[str, Any]],
    originals: dict[str, dict[str, Any]],
    dims: dict[str, tuple[float, float]],
    path: Path,
) -> None:
    """Write the 6-way cross-translation comparison.

    Every ``run`` is one ``A -> B`` translation (image ``A`` translated into
    the language of image ``B``).  Because image ``B`` already exists as a
    real page in language ``B``, its *original* Lens tree is the ground-truth
    layout/wording the AI output should converge on — so each run is lined
    up box-by-box against that reference: position, line-breaks, text.
    """
    lines: list[str] = []
    lines.append("TextPhantom — 6-way cross-translation comparison")
    lines.append("=" * 64)
    lines.append("")

    # --- Per-run summary ---------------------------------------------------
    lines.append("runs (source image -> target language):")
    for r in runs:
        ai_tree = _ai_tree_of(r["result"])
        orient = ai_tree.get("orientation") or {}
        og = (r["result"].get("original") or {}).get("originalTree") or {}
        paras = ai_tree.get("paragraphs") or []
        n_rot = sum(1 for p in paras if p.get("rotated"))
        n_single = sum(1 for p in paras if p.get("is_single_set"))
        lines.append(
            f"  {r['src_stem']} -> {r['tgt_stem']}"
            f"  ({r['src_lang']} -> {r['tgt_lang']})"
        )
        lines.append(
            f"      structure  : original {tree_stats(og)} -> ai {tree_stats(ai_tree)}"
        )
        lines.append(
            "      orientation: image={i} target={t} rotates={r2}"
            "  ({nr} boxes rotated, {ns} single-set kept)".format(
                i=orient.get("image_orientation"),
                t=orient.get("target_orientation"),
                r2=orient.get("image_rotates"),
                nr=n_rot, ns=n_single,
            )
        )
    lines.append("")

    # --- Per-run detail: AI output vs the real target-language page --------
    lines.append("per-run detail — AI output vs the real target-language page:")
    lines.append("=" * 64)
    lines.append(
        "'ai'  = the source image translated by the pipeline; "
        "'ref' = the genuine page that already exists in the target language. "
        "Boxes are matched by position so divergent placement / line-breaks "
        "(the structure that needs adjusting) are visible."
    )
    lines.append("")
    for r in runs:
        ai_tree = _ai_tree_of(r["result"])
        src_w, src_h = dims.get(r["src_stem"], (1.0, 1.0))
        tgt_w, tgt_h = dims.get(r["tgt_stem"], (1.0, 1.0))
        ai_rows = _box_rows(ai_tree, src_w, src_h)
        ref_tree = originals.get(r["tgt_stem"]) or {}
        ref_rows = _box_rows(ref_tree, tgt_w, tgt_h)

        lines.append(f"---------- {r['src_stem']} -> {r['tgt_stem']} ----------")
        lines.append(
            f"   ai  = {r['src_stem']}.jpg translated to {r['tgt_lang']}"
            f"  ({len(ai_rows)} boxes)"
        )
        lines.append(
            f"   ref = {r['tgt_stem']}.jpg, the real {r['tgt_lang']} page"
            f"  ({len(ref_rows)} boxes)"
        )
        # Greedy nearest-centroid match — same page, so the closest box is
        # the same bubble even when the two trees split it differently.
        used: set[int] = set()
        for a in ai_rows:
            best_j: int | None = None
            best_d = 1.0e18
            for j, rf in enumerate(ref_rows):
                if j in used:
                    continue
                d = (a["cx"] - rf["cx"]) ** 2 + (a["cy"] - rf["cy"]) ** 2
                if d < best_d:
                    best_d, best_j = d, j
            rf = ref_rows[best_j] if best_j is not None else None
            if best_j is not None:
                used.add(best_j)
            lines.append(f"  box near ({a['cx']:.0f}%,{a['cy']:.0f}%)")
            lines.append(_fmt_box_row("ai", a))
            lines.append(_fmt_box_row("ref", rf))
            if rf is not None:
                deltas: list[str] = []
                if a["lines"] != rf["lines"]:
                    deltas.append(f"line-breaks {a['lines']}!={rf['lines']}")
                if abs(a["cx"] - rf["cx"]) > 8 or abs(a["cy"] - rf["cy"]) > 8:
                    deltas.append("position differs")
                if deltas:
                    lines.append("         Δ " + ", ".join(deltas))
        for j, rf in enumerate(ref_rows):
            if j in used:
                continue
            lines.append(
                f"  box near ({rf['cx']:.0f}%,{rf['cy']:.0f}%)  [ref-only]"
            )
            lines.append(_fmt_box_row("ref", rf))
        lines.append("")

    # --- Translation text per run ------------------------------------------
    lines.append("AI translation text per run:")
    lines.append("-" * 64)
    for r in runs:
        lines.append(f"<<< {r['src_stem']} -> {r['tgt_stem']} ({r['tgt_lang']}) >>>")
        lines.append((r["result"].get("AiTextFull") or "").rstrip())
        lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    _write_text(path, "\n".join(lines) + "\n")

    # JSON sibling — machine-readable for further analysis.
    json_obj = {
        "runs": [
            {
                "name": r["name"],
                "source_image": f"{r['src_stem']}.jpg",
                "target_image": f"{r['tgt_stem']}.jpg",
                "source_lang": r["src_lang"],
                "target_lang": r["tgt_lang"],
                "out_dir": str(r["out_dir"]),
                "orientation": _ai_tree_of(r["result"]).get("orientation") or {},
                "original": tree_stats(
                    (r["result"].get("original") or {}).get("originalTree") or {}
                ),
                "ai": tree_stats(_ai_tree_of(r["result"])),
                "ai_text": r["result"].get("AiTextFull") or "",
                "ai_boxes": _box_rows(
                    _ai_tree_of(r["result"]), *dims.get(r["src_stem"], (1.0, 1.0))
                ),
                "reference_boxes": _box_rows(
                    originals.get(r["tgt_stem"]) or {},
                    *dims.get(r["tgt_stem"], (1.0, 1.0)),
                ),
            }
            for r in runs
        ],
    }
    _write_json(path.with_suffix(".json"), json_obj)

def _lens_data_for(image_path: Path, lens_json_tmpl: str, fetch_lang: str) -> Any:
    """Replay a saved Lens response, or fetch one live, for ``image_path``."""
    stem = image_path.stem
    if lens_json_tmpl:
        lens_file = Path(lens_json_tmpl.replace("{name}", stem))
        print(f"[cli] {stem}: loaded Lens response from {lens_file}")
        return json.loads(lens_file.read_text(encoding="utf-8"))
    from backend.lens import client as lens_client

    print(f"[cli] {stem}: fetching Lens data …")
    return lens_client.fetch_lens_data(
        str(image_path), normalize_lang(fetch_lang), settings.firebase_url
    )

def _run_extension(args: argparse.Namespace, image_path: Path) -> int:
    """Dispatch one image to the real JavaScript extension pipeline modules."""
    if args.mode != "lens_text":
        print("error: --engine extension currently supports only --mode lens_text", file=sys.stderr)
        return 2
    if not str(args.api_url or "").strip():
        print("error: --engine extension requires --api-url", file=sys.stderr)
        return 2
    try:
        from PIL import Image
        with Image.open(image_path) as image:
            width, height = image.size
    except Exception as exc:
        print(f"error: could not read image dimensions: {exc}", file=sys.stderr)
        return 2

    stem = image_path.stem
    out_dir = _resolve_path_template(args.out_dir, stem, False, args.out_dir)
    lens_replay = None
    if args.lens_json:
        replay_path = Path(args.lens_json.replace("{name}", stem))
        try:
            lens_replay = json.loads(replay_path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"error: could not load --lens-json {replay_path}: {exc}", file=sys.stderr)
            return 2

    mime = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
    config = {
        "outDir": str(out_dir.resolve()),
        "apiUrl": str(args.api_url).strip().rstrip("/"),
        "imageName": image_path.name,
        "imageBase64": base64.b64encode(image_path.read_bytes()).decode("ascii"),
        "mime": mime,
        "width": int(width),
        "height": int(height),
        "lensReplay": lens_replay,
        "mode": args.mode,
        "source": args.source.strip().lower(),
        "lang": normalize_lang(args.lang),
        "ai": {
            "api_key": args.ai_key.strip(),
            "model": args.ai_model,
            "provider": args.ai_provider,
            "base_url": args.ai_base_url,
            "prompt": args.ai_prompt,
            "thinking": args.ai_thinking,
        },
    }
    project_root = Path(__file__).resolve().parents[2]
    driver = project_root / "scripts" / "cli-extension-driver.mjs"
    with tempfile.TemporaryDirectory(prefix="textphantom-cli-") as temp_dir:
        config_path = Path(temp_dir) / "request.json"
        config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        command = ["node", str(driver), str(config_path)]
        print(f"[cli] {stem}: running extension-owned pipeline …")
        try:
            completed = subprocess.run(command, cwd=project_root, check=False)
        except FileNotFoundError:
            print("error: Node.js was not found; --engine extension requires Node.js 18+", file=sys.stderr)
            return 2
    if completed.returncode:
        print(f"[cli] {stem}: extension diagnostics failed; inspect {out_dir.resolve() / 'error.json'}", file=sys.stderr)
        return int(completed.returncode)
    print(f"[cli] {stem}: wrote extension debug artefacts to {out_dir.resolve()}")
    return 0

def _run_cross(args: argparse.Namespace, image_paths: list[Path], ai_cfg: AiConfig) -> int:
    """6-way cross translation in a single invocation.

    Each image's source language is inferred from its filename, then every
    image is translated into the language of every *other* image (eng->jp,
    eng->th, jp->eng, jp->th, th->eng, th->jp).  Every run writes its own
    debug folder, and a comparison report lines each run up against the real
    page that already exists in the target language.
    """
    from backend.jobs.pipeline import process_image

    img_lang = {p.stem: _infer_lang(p.stem) for p in image_paths}
    print("[cli] inferred languages: "
          + ", ".join(f"{s}={l}" for s, l in img_lang.items()))

    # Lens data is loaded once per source image and reused for both targets.
    lens_cache: dict[str, Any] = {}

    def _lens(img: Path) -> Any:
        if img.stem not in lens_cache:
            lens_cache[img.stem] = _lens_data_for(img, args.lens_json, img_lang[img.stem])
        return lens_cache[img.stem]

    runs: list[dict[str, Any]] = []
    originals: dict[str, dict[str, Any]] = {}
    dims: dict[str, tuple[float, float]] = {}

    for src in image_paths:
        for tgt in image_paths:
            if src == tgt:
                continue
            src_lang, tgt_lang = img_lang[src.stem], img_lang[tgt.stem]
            if src_lang == tgt_lang:
                continue
            runname = f"{src.stem}2{tgt.stem}"
            print(f"[cli] {runname}: translating {src.name} -> {tgt_lang} …")
            out_dir = _resolve_path_template(args.out_dir, runname, True, args.out_dir)
            try:
                lens_data = _lens(src)
            except Exception as exc:
                _write_failure(out_dir, {}, exc, engine="runsapi", stage="lens")
                print(
                    f"[cli] {runname}: FAILED [{type(exc).__name__}] {_safe_error_message(exc)}\n"
                    f"[cli] diagnostic evidence: {out_dir.resolve()}",
                    file=sys.stderr,
                )
                return 1
            t0 = time.perf_counter()
            try:
                result = process_image(
                    str(src), tgt_lang, args.mode, ai_cfg,
                    source="ai",
                    lens_data=lens_data, capture_ai_request=True,
                )
            except Exception as exc:
                failure_stage = "grouping" if type(exc).__name__ == "DetectorFreeGroupingError" else "pipeline"
                _write_failure(out_dir, lens_data, exc, engine="runsapi", stage=failure_stage)
                print(
                    f"[cli] {runname}: FAILED [{type(exc).__name__}] {_safe_error_message(exc)}\n"
                    f"[cli] diagnostic evidence: {out_dir.resolve()}",
                    file=sys.stderr,
                )
                return 1
            result.setdefault("perf", {})["cli_total_ms"] = round(
                (time.perf_counter() - t0) * 1000, 1
            )
            _dump(result, lens_data if isinstance(lens_data, dict) else {}, out_dir, source="ai")
            print(f"[cli] {runname}: wrote debug artefacts to {out_dir.resolve()}")

            dims[src.stem] = _dims_of(result)
            originals[src.stem] = (result.get("original") or {}).get("originalTree") or {}
            runs.append({
                "name": runname,
                "src_stem": src.stem, "tgt_stem": tgt.stem,
                "src_lang": src_lang, "tgt_lang": tgt_lang,
                "result": result, "out_dir": out_dir,
            })

    if not runs:
        print("error: no cross-language pairs (all images share one language)",
              file=sys.stderr)
        return 2

    if "{name}" in args.out_dir:
        cmp_path = Path(args.out_dir.replace("{name}", "comparison")).with_suffix(".txt")
    else:
        cmp_path = Path(args.out_dir) / "comparison.txt"
    _write_comparison(runs, originals, dims, cmp_path)
    print(f"[cli] wrote 6-way comparison to {cmp_path.resolve()}")
    print()
    print(cmp_path.read_text(encoding="utf-8").rstrip())
    return 0

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="backend.cli",
        description="Run the TextPhantom pipeline on one or more local images. "
                    "Pass several images with --source ai to translate every "
                    "image into every other image's language (6-way cross run).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""engine examples:
  runs:API server (default; Python owns the complete pipeline):
    python -m backend.cli 6.jpg --engine api --lang th --out-dir debug-api-6

  runs:Extension (real extension JS decode/group/Cloud-AI modules and canonical routes):
    python -m backend.cli 6.jpg --engine extension --api-url http://127.0.0.1:7860 --lang th --out-dir debug-extension-6

  Reuse identical Lens input when comparing the two engines:
    python -m backend.cli 6.jpg --engine extension --api-url http://127.0.0.1:7860 --lens-json debug-api-6/lens_raw.json --lang th --out-dir debug-extension-6

limits:
  Extension mode is headless. It does not test browser DOM rendering, service-worker
  session ownership, page insertion, or direct Local-AI runtime. Test those boundaries
  in the installed extension. The CLI never falls back from one engine to the other.
""",
    )
    parser.add_argument("image", nargs="+", help="path(s) to image file(s)")
    parser.add_argument("--engine", default="api", choices=["api", "extension"],
                        help="pipeline owner: api=runs:API server, extension=runs:Extension (default: api)")
    parser.add_argument("--api-url", default="",
                        help="TextPhantom API base URL; required by --engine extension")
    parser.add_argument("--lang", default="th", help="target language for single-image runs (default: th)")
    parser.add_argument("--mode", default="lens_text", choices=["lens_text", "lens_images"])
    parser.add_argument("--source", default="translated", choices=["original", "translated", "ai"])
    parser.add_argument("--ai-key", default="", help="AI API key (required for --source ai)")
    parser.add_argument("--ai-model", default="auto")
    parser.add_argument("--ai-provider", default="auto")
    parser.add_argument("--ai-base-url", default="auto")
    parser.add_argument("--ai-thinking", default="off", type=lambda value:
                        "on" if str(value).strip().lower() == "on" else "off",
                        choices=["off", "on"])
    parser.add_argument(
        "--ai-prompt", default="",
        help="style prompt required by --source ai; no built-in fallback is used",
    )
    parser.add_argument(
        "--out-dir", default="debug",
        help="where to write the dump.  A {name} placeholder expands per run "
             "(e.g. debug-{name}-new2 -> debug-eng2jp-new2 …); without it each "
             "run/image gets its own <out-dir>/<name> sub-folder.",
    )
    parser.add_argument(
        "--lens-json", default="",
        help="replay a saved lens_raw.json instead of fetching.  A {name} "
             "placeholder picks the per-image file (debug-{name}-new1/lens_raw.json).",
    )
    args = parser.parse_args(argv)

    image_paths = [Path(p) for p in args.image]
    for image_path in image_paths:
        if not image_path.is_file():
            print(f"error: image not found: {image_path}", file=sys.stderr)
            return 2
    multi = len(image_paths) > 1
    source = args.source.strip().lower()

    if source == "ai" and not args.ai_prompt.strip():
        print(
            "error: --source ai requires --ai-prompt; no prompt fallback is used",
            file=sys.stderr,
        )
        return 2

    if args.engine == "extension":
        if multi:
            print("error: --engine extension currently accepts exactly one image per invocation", file=sys.stderr)
            return 2
        return _run_extension(args, image_paths[0])

    # Keep the extension diagnostic path independent from the Python renderer's
    # native dependencies. The full API engine imports them only when selected.
    from backend.jobs.pipeline import process_image

    # --- Font pre-warm ------------------------------------------------------
    # Without a real TTF, Pillow falls back to a bitmap font whose textbbox
    # ignores the requested size, which makes the fit-size calculation
    # explode (a 139px-tall box ends up with fs=688). Warm the fonts and
    # surface the situation loud and clear.
    # _fonts_ok, thai_font, latin_font = _prewarm_fonts(args.lang)

    # --- AI config ----------------------------------------------------------
    ai_cfg = None
    if args.mode == "lens_text" and source == "ai":
        api_key = args.ai_key.strip() or settings.ai_api_key
        if not api_key:
            print("error: --source ai needs --ai-key (or AI_API_KEY env)", file=sys.stderr)
            return 2
        ai_cfg = AiConfig(
            api_key=api_key,
            # The CLI runs on the operator's own machine, so whatever key and
            # base_url they pass are theirs to point wherever they like.
            user_key=True,
            model=args.ai_model,
            provider=args.ai_provider,
            base_url=args.ai_base_url,
            prompt_editable=args.ai_prompt,
            prompt_mode="replace",
            thinking=args.ai_thinking,
        )

    # --- 6-way cross translation (several images + AI) ----------------------
    if multi and source == "ai":
        return _run_cross(args, image_paths, ai_cfg)

    # --- Single-image / non-AI runs -----------------------------------------
    for image_path in image_paths:
        stem = image_path.stem
        out_dir = _resolve_path_template(args.out_dir, stem, multi, args.out_dir)
        try:
            lens_data = _lens_data_for(image_path, args.lens_json, args.lang)
        except Exception as exc:
            _write_failure(out_dir, {}, exc, engine="runsapi", stage="lens")
            print(
                f"[cli] {stem}: FAILED [{type(exc).__name__}] {_safe_error_message(exc)}\n"
                f"[cli] diagnostic evidence: {out_dir.resolve()}",
                file=sys.stderr,
            )
            return 1
        print(f"[cli] {stem}: running pipeline (mode={args.mode}, lang={args.lang}, source={source}) …")
        t0 = time.perf_counter()
        try:
            result = process_image(
                str(image_path), args.lang, args.mode, ai_cfg,
                source=source,
                lens_data=lens_data, capture_ai_request=True,
            )
        except Exception as exc:
            failure_stage = "grouping" if type(exc).__name__ == "DetectorFreeGroupingError" else "pipeline"
            _write_failure(out_dir, lens_data, exc, engine="runsapi", stage=failure_stage)
            print(
                f"[cli] {stem}: FAILED [{type(exc).__name__}] {_safe_error_message(exc)}\n"
                f"[cli] diagnostic evidence: {out_dir.resolve()}",
                file=sys.stderr,
            )
            return 1
        result.setdefault("perf", {})["cli_total_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        _dump(result, lens_data if isinstance(lens_data, dict) else {}, out_dir, source=source)
        print(f"[cli] {stem}: wrote debug artefacts to {out_dir.resolve()}")
        print((out_dir / "summary.txt").read_text(encoding="utf-8").rstrip())

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
