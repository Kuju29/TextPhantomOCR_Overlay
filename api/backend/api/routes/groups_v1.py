"""Paragraph grouping as a service the EXTENSION calls (v1).

``POST /v1/groups``
    The extension sends an image and the Lens tree it decoded itself, and gets
    back the SAME tree with two things added: a ``_tb_block`` stamp on every
    paragraph the detector could place, and ``bubble_groups`` — the paragraphs
    merged back into one unit per bubble.

Why this exists, and why it returns a tree rather than boxes
------------------------------------------------------------
The extension owns orchestration. ONNX is one of the few
things a browser genuinely cannot do: the detector is a 6 MB model driven by
`onnxruntime`, and that does not go in a content script.

But raw boxes are useless without the thing that consumes them.
``render/groups.py`` is a thousand lines of ruby detection, CJK rules, glyph
ratio tests and a gap-jump splitter. Returning the MERGED tree means none of
that has to be written again in JavaScript, and it costs the API nothing extra
because ONNX already has to run here.

What the merge actually is
--------------------------
Not "grouping text". Lens splits ONE vertical Japanese sentence into a
paragraph per column; this undoes that split. Skip it and the AI is handed the
columns separately, translates each fragment on its own, and the page comes
back as unreadable noise that looks like a bad model rather than a missing
step.

Horizontal pages never need it — ``groups.py:398`` cuts on
``_para_axis(para) != "v"`` — so the extension decides whether to call at all
(`src/shared/lens-axis.js`). This endpoint does not second-guess that: a caller
that sends a horizontal page gets its tree back with no merges and a warning
saying so, not a silent no-op.

The trap this endpoint exists to refuse
---------------------------------------
``annotate_paragraph_blocks`` needs ``bounds_px`` on every paragraph. Without
it, it stamps NOTHING and returns 0 — and under ``tb_authority=True`` an
unstamped paragraph never merges with anything. The page comes back with its
columns intact, no error anywhere, and the symptom is "the merge doesn't work"
investigated in ``groups.py``, which is fine.

So a tree with no usable ``bounds_px`` is REFUSED, with the count. See
:func:`_require_bounds`.
"""

from __future__ import annotations

import io
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from backend import trace
from backend.jobs.admission import AdmissionRejected, identity_of
from backend.log import event
from backend.lens.tree import iter_paragraphs
from backend.render import textblocks_pass
from backend.render.region import paragraph_reading_axis

router = APIRouter()

SCHEMA = "tp.bubble-groups/1"

# A page is a page. Anything much past this is not a manga page, and decoding
# it would cost more memory than the grouping saves.
MAX_IMAGE_BYTES = 24 * 1024 * 1024

# A dense page decodes to a few kilobytes of tree (measured: 2,618 bytes for 11
# paragraphs). A megabyte is not a Lens tree.
MAX_TREE_PARAGRAPHS = 2000

# These five moved to backend/render/textblocks_pass.py so the API-server
# engine runs the SAME first-pass/second-look/recovery as this endpoint. The
# names stay here because the rest of this file (and its tests) call them.
_retry_strategy = textblocks_pass.retry_strategy
_detect_retry_blocks = textblocks_pass.detect_retry_blocks
_para_rect = textblocks_pass.para_rect
_vertical_with_bounds = textblocks_pass.vertical_with_bounds
_clear_block_stamps = textblocks_pass.clear_block_stamps
_conservative_block_neighbor = textblocks_pass.conservative_block_neighbor
_recover_unstamped_vertical = textblocks_pass.recover_unstamped_vertical
MAX_FORCED_RETRY_ROIS = textblocks_pass.MAX_FORCED_RETRY_ROIS


def _resolve_image_bytes(payload: dict, identity: str, store: Any,
                         decode_b64: Any) -> tuple[bytes, str]:
    """Resolve artifact-first input while retaining the legacy data URI path."""
    token = str(payload.get("imageArtifactToken") or "").strip()
    data_uri = str(payload.get("imageDataUri") or "")
    if token:
        # Token-first is strict: a supplied but invalid token is a contract
        # error even when legacy bytes are also present. Silent fallback would
        # hide expiry/scope bugs and make artifact metrics untrustworthy.
        return store.get(token, identity), "hit"
    if data_uri:
        return decode_b64(data_uri.split(",", 1)[-1]), "legacy"
    raise ValueError("`imageArtifactToken` or `imageDataUri` is required")


def _require_bounds(tree: dict) -> int:
    """Refuse a tree the detector could not possibly stamp. Returns the count.

    A 400, not a 503: a tree without ``bounds_px`` is a client that built it
    wrong, and posting the identical bytes again will fail identically. A 503
    would tell the extension "come back later", which is the wrong advice and
    would turn a decoder bug into a retry loop.
    """
    paragraphs = [para for _, para in iter_paragraphs(tree)]
    if not paragraphs:
        raise HTTPException(
            status_code=400,
            detail="`tree.paragraphs` is empty — there is nothing to group",
        )
    usable = sum(1 for para in paragraphs if _para_rect(para) is not None)
    if usable == 0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"none of the {len(paragraphs)} paragraph(s) carry a usable `bounds_px`, "
                "so the detector can stamp nothing and no paragraph would merge. "
                "This would come back as a tree with its columns intact and no error — "
                "see the note in `api/backend/api/routes/groups_v1.py`."
            ),
        )
    return usable


def _plausible_multi_column_neighbor(a: dict, b: dict) -> bool:
    """A generous ambiguity superset of the renderer's geometry merge rule.

    False authorizes identity, so this must prefer false negatives *against*
    identity: widths up to 1.8x, the renderer's 1.3-glyph gap and 55% overlap,
    plus top/staircase uncertainty are all treated as a plausible pair.
    """
    ra, rb = _para_rect(a), _para_rect(b)
    if ra is None or rb is None:
        return True
    ax1, ay1, ax2, ay2 = ra
    bx1, by1, bx2, by2 = rb
    aw, bw = ax2 - ax1, bx2 - bx1
    ah, bh = ay2 - ay1, by2 - by1
    glyph = max(aw, bw, 1.0)
    if max(aw, bw) / max(1.0, min(aw, bw)) > 1.8:
        return False
    gap = max(0.0, max(ax1, bx1) - min(ax2, bx2))
    if gap > 1.3 * glyph:
        return False
    overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
    overlap_ratio = overlap / max(1.0, min(ah, bh))
    if overlap_ratio >= 0.55:
        return True
    # A shifted top can be a real staircase rather than a separate bubble.
    # With no pixel/model evidence, close similar-width columns remain
    # ambiguous across the full top-offset range; only spatial separation may
    # prove identity safe.
    return True


def _uncovered_have_plausible_pair(tree: dict) -> bool:
    """Whether zero-hit vertical paragraphs might be columns of one bubble.

    This is a proof guard, not another detector.  Identity is safe only when
    every vertical paragraph has usable geometry and no pair satisfies the
    deliberately wider ambiguity predicate used for zero-hit safety.
    Missing bounds therefore remain ambiguous and can never authorize the
    identity path.
    """
    vertical = [
        para for _, para in iter_paragraphs(tree)
        if paragraph_reading_axis(para.get("items") or []) == "v"
    ]
    if not vertical or any(_para_rect(para) is None for para in vertical):
        return True
    return any(
        _plausible_multi_column_neighbor(vertical[i], vertical[j])
        for i in range(len(vertical))
        for j in range(i + 1, len(vertical))
    )


def _coverage(tree: dict, recovered: list[int] | None = None) -> dict[str, Any]:
    vertical = [
        para
        for _, para in iter_paragraphs(tree)
        if paragraph_reading_axis(para.get("items") or []) == "v"
    ]
    vertical_with_bounds = [para for para in vertical if _para_rect(para) is not None]
    stamped = [para for para in vertical if para.get("_tb_block") is not None]
    uncovered = [
        int(para.get("para_index", -1))
        for para in vertical
        if para.get("_tb_block") is None
    ]
    total = len(vertical)
    recovered_count = len(recovered or [])
    return {
        "vertical": total,
        "verticalWithBounds": len(vertical_with_bounds),
        "stampedVertical": len(stamped),
        "modelStampedVertical": max(0, len(stamped) - recovered_count),
        "recoveredVertical": recovered_count,
        "uncoveredVertical": len(uncovered),
        "uncoveredParaIndices": uncovered,
        "ratio": round(len(stamped) / total, 4) if total else 1.0,
        "complete": not uncovered,
    }


def _merge_verdict(
    coverage: dict[str, Any], blocks: list, with_bounds: int,
    retry: dict[str, Any] | None = None, *, tree: dict | None = None,
) -> dict[str, Any]:
    """Return the caller-facing safety verdict for one grouping result."""
    uncovered_indices = list(coverage.get("uncoveredParaIndices") or [])
    uncovered = {
        "indices": uncovered_indices,
        "disposition": "none" if not uncovered_indices else "fragment_risk",
    }
    if coverage["complete"] and coverage["modelStampedVertical"] > 0:
        authority = "model+recovery" if coverage["recoveredVertical"] else "model"
        return {
            "applied": True, "usable": True, "outcome": "complete",
            "authority": authority, "uncovered": uncovered, "reason": "",
        }
    # One vertical Lens paragraph is already one indivisible translation unit:
    # there is no second column with which it could form an unfinished sentence.
    # When the first ONNX plan already inspected that paragraph individually and
    # found no block, repeating the same crop adds no evidence. Accept the tree
    # unchanged and say that the authority is identity, not the detector.
    #
    # Do not generalise this to two uncovered vertical paragraphs. They may be
    # two columns of one bubble, which is exactly the fragment failure this route
    # exists to prevent.
    identity_safe = (
        coverage["vertical"] == 1
        and coverage["verticalWithBounds"] == 1
        and coverage["stampedVertical"] == 0
        and coverage["uncoveredVertical"] == 1
        and not blocks
        and str((retry or {}).get("reason") or "") in {
            # Old spelling is accepted for callers/tests replaying a saved
            # response; new responses distinguish no boxes from bad overlap.
            "already_individual_no_model_hits",
            "already_individual_no_blocks",
        }
    )
    if identity_safe:
        return {
            "applied": True, "usable": True, "outcome": "identity",
            "authority": "identity",
            "uncovered": {"indices": uncovered_indices, "disposition": "safe_identity"},
            "reason": "single vertical paragraph is already one complete translation unit",
        }
    # Generalise identity only from geometry, never from a paragraph count or a
    # coverage percentage. If none of the zero-hit columns can plausibly be a
    # neighbour of another, leaving every paragraph as its own unit is faithful.
    zero_hit_identity_safe = (
        coverage["modelStampedVertical"] == 0
        and coverage["uncoveredVertical"] == coverage["vertical"]
        and tree is not None
        and not _uncovered_have_plausible_pair(tree)
    )
    if zero_hit_identity_safe:
        return {
            "applied": True, "usable": True, "outcome": "identity",
            "authority": "identity_geometry",
            "uncovered": {"indices": uncovered_indices, "disposition": "safe_identity"},
            "reason": "vertical paragraphs have no plausible multi-column neighbour pair",
        }
    if coverage["uncoveredVertical"]:
        # Preserve the deployed partial policy, but state it as contract data:
        # the client no longer infers usability from coverage/authority fields.
        partial_usable = coverage["modelStampedVertical"] > 0
        return {
            "applied": False, "usable": partial_usable,
            "outcome": "partial" if partial_usable else "unusable",
            "authority": "partial",
            "uncovered": uncovered,
            "reason": (
                f"grouping covered {coverage['stampedVertical']} of "
                f"{coverage['vertical']} vertical paragraph(s); "
                f"{coverage['uncoveredVertical']} would be translated as fragments"
            ),
        }
    if not blocks:
        return {
            "applied": False, "usable": False, "outcome": "unusable",
            "authority": "none",
            "uncovered": uncovered,
            "reason": "the detector found no text blocks on this image",
        }
    return {
        "applied": False, "usable": False, "outcome": "unusable",
        "authority": "none",
        "uncovered": uncovered,
        "reason": (
            f"the detector found {len(blocks)} block(s) but none covered "
            f"half of any of the {with_bounds} paragraph(s) with bounds"
        ),
    }


@router.post("/v1/groups")
async def group_paragraphs(payload: dict[str, Any], request: Request) -> dict:
    """Run the detector on one image and merge its tree's paragraphs.

    ``imageDataUri`` (required) — the page, so ONNX has something to look at.
    ``tree``          (required) — the Lens tree the extension decoded, with
                                   ``bounds_px`` on its paragraphs.
    """
    # Imported here, not at module scope: a capabilities probe or a text-only
    # deployment must not pay for loading numpy/Pillow/onnxruntime.
    from PIL import Image

    from backend.jobs.pipeline import _CPU_GATE, _image_to_rgb
    from backend.jobs.image_artifacts import ArtifactError, image_artifacts
    from backend.render.groups import group_paragraphs_into_bubbles
    from backend.render.relayout import build_vertical_rois
    from backend.render.textblocks import (
        annotate_paragraph_blocks,
        available as textblocks_available,
        dedupe_text_blocks,
        detect_text_blocks_in_rois,
    )
    from backend.utils.images import b64_to_bytes

    started = time.perf_counter()
    identity = identity_of(payload)
    context = payload.get("context")
    trace_id = str((context if isinstance(context, dict) else {}).get("tp_trace") or "")

    if not textblocks_available():
        # Said, not faked. A client that got its tree back unmerged would group
        # the page by columns and never know the model was missing — and the
        # symptom would be "the AI translates fragments", investigated in the
        # prompt. 503 because this one IS transient: deploy the model and the
        # same request succeeds.
        raise HTTPException(
            status_code=503,
            detail="the text-block model is not loaded on this server",
        )

    tree = payload.get("tree")
    if not isinstance(tree, dict):
        raise HTTPException(status_code=400, detail="`tree` must be the decoded Lens tree")
    paragraph_count = len(tree.get("paragraphs") or [])
    if paragraph_count > MAX_TREE_PARAGRAPHS:
        raise HTTPException(
            status_code=413,
            detail=f"tree has {paragraph_count} paragraphs (max {MAX_TREE_PARAGRAPHS})",
        )
    with_bounds = _require_bounds(tree)

    try:
        raw, artifact_outcome = _resolve_image_bytes(
            payload, identity, image_artifacts, b64_to_bytes
        )
    except ArtifactError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": str(exc),
                    "fallback": "resend `imageDataUri` or call `/v1/lens/raw` again"},
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decode the image: {exc}") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"image is {len(raw)} bytes (max {MAX_IMAGE_BYTES})",
        )

    try:
        with Image.open(io.BytesIO(raw)) as src_image:
            image = _image_to_rgb(src_image)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"not a readable image: {exc}") from exc
    width, height = image.size

    # The CPU lane, NOT the Lens lane.
    #
    # ONNX is ~445 ms of compute; a Lens upload is 3.7 s of network sleep. While
    # this call sat in the Lens lane, one image's grouping held a slot the next
    # image's upload could have used — on the lane whose only job is keeping
    # uploads in flight. Separate lanes let a page be grouped WHILE other pages
    # are uploading, which is the parallelism that was missing.
    #
    # `_CPU_GATE` inside still serialises the actual compute: two ONNX runs on
    # 2 vCPU do not go faster than one, and pretending otherwise just moves the
    # queue somewhere nobody can see it.
    gate = request.app.state.cpu_admission_gate
    timings: dict = {}
    try:
        async with gate.slot(identity):
            import asyncio

            def _run() -> tuple[list, int, int, int, list[int], list, dict]:
                with trace.scope(trace_id):
                    # The detector serialises itself on its own session lock, so
                    # the CPU gate is taken around it for the same reason the
                    # pipeline takes it: to keep this from starving other jobs'
                    # erase/render work on a 2-vCPU box.
                    _CPU_GATE.acquire()
                    try:
                        _clear_block_stamps(tree)
                        rois = build_vertical_rois(tree, width, height)
                        blocks = detect_text_blocks_in_rois(image, rois, timings=timings)
                        stamped = annotate_paragraph_blocks(tree, blocks)
                        initial_stamped = stamped
                        initial_vertical_stamped = _coverage(tree)["stampedVertical"]
                        retry_meta: dict[str, Any] = {
                            "attempted": False,
                            "uncoveredBefore": _coverage(tree)["uncoveredVertical"],
                            "roiCandidates": 0,
                            "roiCalls": 0,
                            "blocks": 0,
                            "reason": "",
                            "initialOutcome": (
                                "qualified_blocks" if stamped > 0 else
                                "blocks_no_qualifying_overlap" if blocks else
                                "no_blocks"
                            ),
                        }

                        # Targeted second look: the first pass can see a large
                        # bubble but miss one or two narrow columns after a full
                        # page resize. Re-run only the missing regions, enlarged
                        # to model resolution. These are still model decisions;
                        # no geometric grouping authority is introduced.
                        missing = [
                            para for para in _vertical_with_bounds(tree)
                            if para.get("_tb_block") is None
                        ]
                        retry_rois = build_vertical_rois(
                            {"paragraphs": missing}, width, height
                        ) if missing else []
                        # A no-box pass that already used the exact same crops
                        # has no new evidence to gain by repeating them. Boxes
                        # with zero qualifying stamps are different: a full-page
                        # view can produce materially different block geometry.
                        # Partial coverage retries narrower remaining crops.
                        retry_strategy = _retry_strategy(
                            stamped=stamped,
                            blocks=len(blocks),
                            roi_calls=int(timings.get("roi_calls") or 0),
                            retry_candidates=len(retry_rois),
                        )
                        if retry_strategy != "none":
                            retry_timings: dict[str, Any] = {}
                            # For unqualified individual-crop hits the helper
                            # selects a full-page view; it never repeats those
                            # crops and expects their geometry to change.
                            retry_blocks = _detect_retry_blocks(
                                detect_text_blocks_in_rois, image, retry_rois,
                                retry_strategy, retry_timings,
                            )
                            retry_meta = {
                                "attempted": True,
                                "uncoveredBefore": len(missing),
                                "roiCandidates": len(retry_rois),
                                "roiCalls": retry_timings.get("roi_calls", 0),
                                "blocks": len(retry_blocks),
                                "reason": retry_strategy,
                                "detectorReason": retry_timings.get("roi_reason", ""),
                                "initialOutcome": (
                                    "qualified_blocks" if stamped > 0 else
                                    "blocks_no_qualifying_overlap" if blocks else
                                    "no_blocks"
                                ),
                                "inferMs": retry_timings.get("infer_ms"),
                            }
                            if retry_blocks:
                                # For the alternate full-page view, prefer its
                                # geometry when dedupe sees a near-duplicate of
                                # the unqualified crop box. Otherwise the old
                                # under-box can mask the evidence we retried for.
                                ordered_blocks = (
                                    [*retry_blocks, *blocks]
                                    if retry_strategy == "full_page_after_unqualified_hits"
                                    else [*blocks, *retry_blocks]
                                )
                                blocks = dedupe_text_blocks(ordered_blocks)
                                _clear_block_stamps(tree)
                                stamped = annotate_paragraph_blocks(tree, blocks)
                        elif retry_rois:
                            retry_meta.update({
                                "roiCandidates": len(retry_rois),
                                "reason": "already_individual_no_blocks",
                            })
                        recovered = _recover_unstamped_vertical(tree)
                        # `tb_authority=True`: the detector is the SOLE decision
                        # maker for vertical grouping. No geometric rule may
                        # override it — mixed decision paths made a bad group
                        # impossible to attribute to a rule.
                        #
                        # `base_img` is deliberately NOT passed. The only rule
                        # that reads pixels (`_ink_barrier_between`) lives in
                        # the geometric branch, which model authority skips
                        # before it is reached — so the extension never has to
                        # send an erased page back.
                        groups = group_paragraphs_into_bubbles(
                            tree, width, height, None, True
                        )
                        return (
                            blocks, stamped, initial_stamped,
                            initial_vertical_stamped, recovered, groups, retry_meta,
                        )
                    finally:
                        _CPU_GATE.release()

            (
                blocks, stamped, initial_stamped,
                initial_vertical_stamped, recovered, groups, retry_meta,
            ) = await asyncio.get_running_loop().run_in_executor(
                request.app.state.cpu_executor, _run
            )
    except AdmissionRejected as exc:
        event("v1.groups.busy", {"identity": identity}, ok=False)
        raise HTTPException(
            status_code=503,
            detail={"code": "server_busy", "stage": "onnx",
                    "message": str(exc), "retryable": True,
                    "retryAfterMs": int(exc.retry_after_sec * 1000)},
            headers={"Retry-After": str(exc.retry_after_sec)},
        ) from exc

    total_ms = round((time.perf_counter() - started) * 1000, 1)

    # Did the model actually decide anything?
    #
    # `stamped == 0` returns the tree UNCHANGED — every column its own group,
    # which is byte-for-byte what a page that needed no merging looks like. The
    # caller has to be able to tell those apart without parsing warning strings,
    # because the two demand opposite actions: one is ready to translate, the
    # other must not be sent to the AI at all (unmerged Japanese columns come
    # back as fragments). So the verdict is a FIELD.
    coverage = _coverage(tree, recovered)
    merge = _merge_verdict(coverage, blocks, with_bounds, retry_meta, tree=tree)

    warnings: list[str] = []
    if coverage["uncoveredVertical"] and not merge["applied"]:
        warnings.append(merge["reason"])
    if retry_meta.get("attempted"):
        if retry_meta.get("reason") == "full_page_after_unqualified_hits":
            warnings.append(
                "alternate full-page ONNX retry checked detector boxes that "
                "did not qualify against any paragraph"
            )
        else:
            warnings.append(
                "targeted ONNX retry checked "
                f"{retry_meta.get('roiCalls', 0)} crop(s) for "
                f"{retry_meta.get('uncoveredBefore', 0)} initially uncovered vertical paragraph(s)"
            )
    if recovered:
        warnings.append(
            f"conservative geometry recovery attached {len(recovered)} vertical paragraph(s) "
            "to one unambiguous neighbouring model block"
        )
    if initial_vertical_stamped < coverage["verticalWithBounds"]:
        # Keep the raw detector count separate from conservative recovery so
        # diagnostics can tell which path covered each paragraph.
        warnings.append(
            f"the detector initially placed {initial_vertical_stamped} of "
            f"{coverage['verticalWithBounds']} vertical paragraph(s) with bounds; "
            f"targeted retry placed {coverage['modelStampedVertical']} before conservative recovery; "
            f"final vertical coverage is {coverage['stampedVertical']} of {coverage['vertical']}"
        )
    if with_bounds < paragraph_count:
        warnings.append(
            f"{paragraph_count - with_bounds} paragraph(s) carry no usable `bounds_px` "
            "and were not considered for merging"
        )
    axes = [paragraph_reading_axis(p.get("items") or []) for _, p in iter_paragraphs(tree)]
    if "v" not in axes:
        # Not an error — but the caller is supposed to have decided this before
        # spending ~450 ms of ONNX on it. A silent no-op here would hide a
        # client whose axis rule had drifted from `groups.py:398`.
        warnings.append(
            "no paragraph reads vertically, so nothing could merge — "
            "this page did not need /v1/groups"
        )

    event(
        "v1.groups",
        {
            "paragraphs": paragraph_count,
            "withBounds": with_bounds,
            "stamped": stamped,
            "initial_stamped": initial_stamped,
            "initial_vertical_stamped": initial_vertical_stamped,
            "blocks": len(blocks),
            "groups": len(groups),
            "merged": merge["applied"],
            "usable": merge["usable"],
            "outcome": merge["outcome"],
            "vertical": axes.count("v"),
            "coverage": coverage,
            "roi_reason": timings.get("roi_reason"),
            "roi_candidates": timings.get("roi_candidates"),
            "roi_calls": timings.get("roi_calls"),
            "infer_ms": timings.get("infer_ms"),
            "total_ms": total_ms,
            "retry": retry_meta,
            "imageArtifact": artifact_outcome,
            "artifactMetrics": image_artifacts.stats(),
        },
    )
    trace.write(
        "api",
        "api/routes/groups_v1.py",
        "group_paragraphs",
        "<-",
        {
            "paragraphs": paragraph_count,
            "withBounds": with_bounds,
            "stamped": stamped,
            "initialStamped": initial_stamped,
            "initialStampedVertical": initial_vertical_stamped,
            "blocks": len(blocks),
            "groups": len(groups),
            "coverage": coverage,
            "mergeApplied": merge["applied"],
            "mergeUsable": merge["usable"],
            "mergeOutcome": merge["outcome"],
            "mergeAuthority": merge["authority"],
            "uncovered": merge["uncovered"],
            "mergeReason": merge["reason"],
            "warnings": warnings,
            "roiReason": timings.get("roi_reason"),
            "roiCandidates": timings.get("roi_candidates"),
            "roiCalls": timings.get("roi_calls"),
            "total_ms": total_ms,
            "retry": retry_meta,
            "imageArtifact": artifact_outcome,
            "artifactMetrics": image_artifacts.stats(),
        },
        trace_id=trace_id,
    )

    result = {
        "ok": True,
        "schema": SCHEMA,
        "image": {"width": width, "height": height},
        # The tree, mutated in place by both calls above: `_tb_block` on the
        # paragraphs and `bubble_groups` on the root.
        "tree": tree,
        "groups": groups,
        # Whether the model decided anything — see the note above. A caller
        # that sends `applied: false` groups to an AI is translating fragments.
        "merge": merge,
        "paragraphs": paragraph_count,
        "withBounds": with_bounds,
        "stamped": stamped,
        "initialStamped": initial_stamped,
        "initialStampedVertical": initial_vertical_stamped,
        "blocks": len(blocks),
        "coverage": coverage,
        "inferMs": timings.get("infer_ms"),
        "totalMs": total_ms,
        "retry": retry_meta,
        "imageArtifact": artifact_outcome,
    }
    if warnings:
        result["warnings"] = warnings
    return result
