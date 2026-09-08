"""HTTP orchestration for detector-free Lens paragraph grouping.

This module deliberately owns no detector lifecycle, admission queue, retry, or
geometric fallback.  It validates one request, decodes its image once, and
invokes the fail-closed detector-free service once.
"""

from __future__ import annotations

import hashlib
import io
import re
import time
from typing import Any

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool

from backend import trace
from backend.api.errors import (
    failure_event,
    merged_request_correlation,
    payload as error_payload,
)
from backend.application.groups_request import resolve_image_bytes
from backend.grouping.detector_free_service import (
    DetectorFreeGroupingError,
    group_vertical_lens,
)
from backend.grouping.ai_source_tree import AiSourceTreeError, build_ai_source_tree
from backend.jobs.admission import identity_of
from backend.log import event


SCHEMA = "tp.canonical-grouping-response/1"
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_TREE_PARAGRAPHS = 2000
CANONICAL_ROUTE = "/v2/engine/runsextension/groups"


def _safe_structural_id(value: Any) -> str:
    raw = str(value)[:512]
    if re.fullmatch(r"p[0-9]{1,12}", raw):
        return raw
    digest = hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:12]
    return f"id#{digest}"


def _safe_failure_details(exc: DetectorFreeGroupingError) -> dict[str, Any]:
    """Expose useful structural diagnostics without returning source text."""
    details = exc.details if isinstance(exc.details, dict) else {}
    safe: dict[str, Any] = {"groupingCode": exc.code}
    unresolved = details.get("unresolvedIds")
    if isinstance(unresolved, list):
        safe["unresolvedIds"] = [
            _safe_structural_id(value) for value in unresolved[:200]]
        safe["unresolvedCount"] = len(unresolved)
    for key in ("reason",):
        value = details.get(key)
        if value not in (None, ""):
            safe[key] = str(value)[:300]
    for key in ("rawId", "rubyId", "baseId"):
        value = details.get(key)
        if value not in (None, ""):
            safe[key] = _safe_structural_id(value)
    errors = details.get("errors")
    if isinstance(errors, list):
        safe["groupingErrors"] = [str(value)[:300] for value in errors[:50]]
    return safe


def _paragraph_count(tree: dict[str, Any]) -> int:
    paragraphs = tree.get("paragraphs")
    if not isinstance(paragraphs, list):
        raise HTTPException(status_code=400, detail="`tree.paragraphs` must be a list")
    if not paragraphs:
        raise HTTPException(
            status_code=400,
            detail="`tree.paragraphs` is empty — there is nothing to group",
        )
    if not all(isinstance(paragraph, dict) for paragraph in paragraphs):
        raise HTTPException(
            status_code=400,
            detail="every entry in `tree.paragraphs` must be an object",
        )
    if len(paragraphs) > MAX_TREE_PARAGRAPHS:
        raise HTTPException(
            status_code=413,
            detail=(f"tree has {len(paragraphs)} paragraphs "
                    f"(max {MAX_TREE_PARAGRAPHS})"),
        )
    return len(paragraphs)


def _decode_image(raw: bytes):
    from PIL import Image
    from backend.jobs.stages.image_prepare import image_to_rgb
    with Image.open(io.BytesIO(raw)) as source:
        return image_to_rgb(source)


def _group_on_worker(tree, image, raw_to_document):
    from backend.jobs.runtime import cpu_slot
    with cpu_slot():
        return group_vertical_lens(tree, *image.size, image=image,
                                   raw_to_document=raw_to_document)


async def group_paragraphs(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    """Validate and execute one detector-free Lens grouping request."""
    from backend.jobs.image_artifacts import ArtifactError, image_artifacts
    from backend.utils.images import b64_to_bytes

    started = time.perf_counter()
    requested_route = request.url.path
    route_meta = {
        "engine": "runsextension",
        "canonicalRoute": CANONICAL_ROUTE,
        "requestedRoute": requested_route,
        "compatibilityAlias": requested_route != CANONICAL_ROUTE,
    }
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    trace_id = str(context.get("tp_trace") or "")
    correlation = merged_request_correlation(request, {
        "batchId": context.get("batch_id"),
        "imageId": context.get("image_id"),
        "clientVersion": context.get("client_version"),
    })

    tree = payload.get("tree")
    if not isinstance(tree, dict):
        raise HTTPException(status_code=400, detail="`tree` must be the decoded Lens tree")
    paragraph_count = _paragraph_count(tree)

    raw_to_document = payload.get("rawToDocument")
    if raw_to_document is not None and not isinstance(raw_to_document, (list, dict)):
        raise HTTPException(
            status_code=400,
            detail="`rawToDocument` must be a list or object when supplied",
        )

    try:
        raw, artifact_outcome = resolve_image_bytes(
            payload, identity_of(payload), image_artifacts, b64_to_bytes,
        )
    except ArtifactError as exc:
        detail = error_payload(
            code=exc.code,
            message=str(exc),
            user_message="The temporary image expired. Please upload the image again.",
            origin="api",
            stage="image_artifact",
            category="input",
            retryable=False,
            http_status=exc.status,
            trace_id=trace_id,
            extra={"fallback": "resend `imageDataUri` or call `/v1/lens/raw` again"},
            correlation=correlation,
        )
        failure_event(requested_route, detail, **route_meta)
        raise HTTPException(status_code=exc.status, detail=detail) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"could not decode the image: {exc}"
        ) from exc

    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"image is {len(raw)} bytes (max {MAX_IMAGE_BYTES})",
        )
    try:
        image = await run_in_threadpool(_decode_image, raw)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400, detail=f"not a readable image: {exc}"
        ) from exc
    width, height = image.size

    try:
        service_result = await run_in_threadpool(
            _group_on_worker, tree, image, raw_to_document,
        )
    except DetectorFreeGroupingError as exc:
        status = 422
        safe_failure = _safe_failure_details(exc)
        trace.write(
            "api", "api/routes/lens_groups.py", "group_paragraphs", "!!",
            {**safe_failure, "paragraphs": paragraph_count,
             "imageArtifact": artifact_outcome},
            trace_id=trace_id,
        )
        detail = error_payload(
            code=exc.code,
            message="detector-free Lens grouping could not produce a usable result",
            user_message=(
                "The page layout could not be grouped without guessing. "
                "Translation was stopped before dispatch."
            ),
            origin="api",
            stage="lens_grouping",
            category="grouping_contract",
            retryable=False,
            http_status=status,
            trace_id=trace_id,
            extra=safe_failure,
            correlation=correlation,
        )
        failure_event(requested_route, detail, **route_meta)
        raise HTTPException(status_code=status, detail=detail) from exc

    grouping_result = service_result["grouping_result"]
    try:
        ai_source_tree = await run_in_threadpool(build_ai_source_tree, tree, grouping_result)
    except AiSourceTreeError as exc:
        detail = error_payload(
            code=exc.code,
            message="canonical original tree failed its structural contract",
            user_message=(
                "The OCR tree could not be normalized without losing text or geometry. "
                "Translation was stopped before dispatch."
            ),
            origin="api",
            stage="canonical_original_tree",
            category="grouping_contract",
            retryable=False,
            http_status=422,
            trace_id=trace_id,
            correlation=correlation,
        )
        failure_event(requested_route, detail, **route_meta)
        raise HTTPException(status_code=422, detail=detail) from exc
    debug = service_result["debug"]
    source_members = sum(
        len(group.get("sourceContract", {}).get("members", []))
        for group in grouping_result.get("groups", [])
    )
    canonical_coverage = grouping_result.get("coverage")
    coverage = {
        **(canonical_coverage if isinstance(canonical_coverage, dict) else {}),
        "paragraphs": paragraph_count,
        "sourceMembers": source_members,
        "groups": len(ai_source_tree.get("paragraphs") or []),
        "unresolved": len(grouping_result.get("unresolvedIds") or []),
        "complete": grouping_result.get("status") == "usable"
        and not grouping_result.get("unresolvedIds"),
    }
    merge = {
        "applied": True,
        "usable": True,
        "outcome": "detector_free_isolated" if debug.get("isolatedIds") else "detector_free_resolved",
        "authority": "lens_graph_partition",
        "uncovered": {"indices": [], "disposition": "none"},
        "reason": "orientation_standalone" if debug.get("isolatedIds") else "",
    }
    if debug.get("isolatedIds"):
        trace.write("api", "application/lens_grouping.py", "orientationRecovery", "note", {
            "code": "orientation_unresolved", "disposition": "standalone",
            "isolatedIds": debug["isolatedIds"], "recoverable": True,
        }, trace_id=trace_id)
    from backend.geometry_diagnostics import emit_group_diagnostics
    emit_group_diagnostics(grouping_result, width, height)
    total_ms = round((time.perf_counter() - started) * 1000, 1)

    event("lens_graph.grouping", {
        "paragraphs": paragraph_count,
        "groups": len(ai_source_tree.get("paragraphs") or []),
        "coverage": coverage,
        "merged": True,
        "usable": True,
        "outcome": merge["outcome"],
        "total_ms": total_ms,
        "imageArtifact": artifact_outcome,
        "artifactMetrics": image_artifacts.stats(),
        **route_meta,
    })
    trace.write(
        "api",
        "api/routes/lens_groups.py",
        "group_paragraphs",
        "<-",
        {
            "paragraphs": paragraph_count,
            "groups": len(ai_source_tree.get("paragraphs") or []),
            "coverage": coverage,
            "mergeApplied": True,
            "mergeUsable": True,
            "mergeOutcome": merge["outcome"],
            "mergeAuthority": merge["authority"],
            "total_ms": total_ms,
            "imageArtifact": artifact_outcome,
        },
        trace_id=trace_id,
    )
    return {
        "ok": True,
        "schema": SCHEMA,
        "image": {"width": width, "height": height},
        "groupingResult": grouping_result,
        "tree": ai_source_tree,
        "debug": debug,
        "coverage": coverage,
        "merge": merge,
        "paragraphs": paragraph_count,
        "totalMs": total_ms,
        "imageArtifact": artifact_outcome,
    }
