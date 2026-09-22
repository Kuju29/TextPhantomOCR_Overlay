import { isTracing } from "../../shared/trace.js";
import { attachTpError } from "../../shared/error-contract.js";
import { classifyJobError } from "../images.js";
import { geometryDiagnostics, groupDiagnostics } from "../../shared/geometry-diagnostics.js";
import {
  attachCanonicalOriginalTree,
  canRenderFaithfully,
  translationUnits,
} from "../../shared/lens-document.js";
import {
  authoritativeLensImageSize,
  decodeLensResponse,
} from "../../shared/lens-decode.js";
import {
  groupingTreeFingerprint,
} from "../../shared/grouping-result.js";

// Kept as the pipeline-facing name; the implementation lives at the shared
// contract boundary so the Extension and API hash the exact same projection.
export const rawTreeFingerprint = groupingTreeFingerprint;

export function createLensDirectPath({
  fetchFromUrl,
  fetchFromTab,
  fetchLensRaw,
  groupParagraphs,
  runStage,
  markPhase,
  trace,
  traceLayout,
  getTrace,
  log,
}) {
  async function imageBytesFor(payload, tabId, frameId, signal) {
    signal?.throwIfAborted();
    const inline = String(payload?.imageDataUri || "").trim();
    let dataUri = inline;
    if (!dataUri.startsWith("data:")) {
      const src = String(payload?.src || "").trim();
      if (!src) return null;
      dataUri = await fetchFromUrl(src, payload?.context?.page_url || "", signal).catch(
        async (error) => {
          signal?.throwIfAborted();
          if (/\bHTTP 403\b/i.test(error?.message || "") && tabId)
            return fetchFromTab(tabId, src, frameId || 0, signal);
          throw error;
        },
      );
    }
    signal?.throwIfAborted();
    if (!dataUri) return null;
    const response = await fetch(dataUri, { signal });
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    return {
      bytes,
      mime: response.headers.get("content-type") || "image/jpeg",
      dataUri,
    };
  }

  return async function runLensDirectPath(
    base,
    payload,
    {
      tabId,
      frameId,
      jobId = "",
      signal = null,
      decline = {},
      capabilities = null,
    },
  ) {
    const stop = (reason) => {
      if (reason instanceof Error) decline.error = reason;
      decline.reason = String(
        reason?.message || reason || "the local route declined this image",
      );
      return null;
    };
    if (payload?.mode !== "lens_text") return stop("not a lens_text job");
    if (!payload?.render?.lensDocument)
      return stop("this job did not ask for a local document");
    // Virtual readers can own source bytes before an IMG is mounted. The DOM
    // dimensions are diagnostic hints only; /v1/lens/raw already reports the
    // authoritative dimensions of the uploaded image (also after orientation).
    const domSize = payload?.naturalSize;
    const hasDomSize = Number(domSize?.width) > 0 && Number(domSize?.height) > 0;

    let image;
    try {
      image = await imageBytesFor(payload, tabId, frameId, signal);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      const status = Number(error?.tpError?.httpStatus || error?.status) || 0;
      return stop(attachTpError(new Error(
        `could not read the image bytes: ${error?.message || String(error)}`,
        { cause: error },
      ), {
        code: status ? "IMG_SOURCE_UNREACHABLE" : "IMG_READ_FAILED",
        origin: "browser",
        stage: "image_read",
        httpStatus: status,
        retryable: !classifyJobError(error).permanent,
        ...error?.tpError,
        traceId: String(payload?.context?.tp_trace || ""),
        imageId: String(payload?.metadata?.image_id || ""),
        batchId: String(payload?.metadata?.batch_id || ""),
        jobId,
      }));
    }
    if (!image) return stop(attachTpError(new Error("the image reader returned nothing to upload"), {
      code: "IMG_READ_FAILED", origin: "browser", stage: "image_read", retryable: true,
      traceId: String(payload?.context?.tp_trace || ""), jobId,
      imageId: String(payload?.metadata?.image_id || ""),
      batchId: String(payload?.metadata?.batch_id || ""),
    }));

    const traceId = String(payload?.context?.tp_trace || "");
    const imageId = String(payload?.metadata?.image_id || "");
    const batchId = String(payload?.metadata?.batch_id || "");
    let lens;
    let lensImageSize;
    let imageArtifactToken = "";
    try {
      markPhase(jobId, "lens_queued");
      trace(
        "imageStage",
        { stage: "lens", state: "queued", imageId },
        traceId,
      );
      const answer = await runStage(
        "lens:direct",
        () =>
          fetchLensRaw(base, {
            imageBytes: image.bytes,
            mime: image.mime,
            lang: payload.lang,
            signal,
            traceId: traceId || getTrace() || "",
            batchId,
            jobId,
            imageId,
            tabSession: String(payload?.context?.tp_tab_session || ""),
            apiUnlimited: payload?.limits?.apiUnlimited === true,
            capabilities,
          }),
        {
          signal, stage: "lens", imageId, traceId,
          onGranted: ({ queueWaitMs, accumulatedQueueWaitMs, attempt }) => {
            markPhase(jobId, "lens", {
              stage: "Reading text with Lens", queueWaitMs, accumulatedQueueWaitMs, attempt,
            });
            trace("imageStage", { stage: "lens", state: "started", imageId,
              queueWaitMs, accumulatedQueueWaitMs, attempt }, traceId);
          },
        },
      );
      trace(
        "imageStage",
        { stage: "lens", state: "finished", imageId },
        traceId,
      );
      lens = answer?.lens;
      if (!lens || typeof lens !== "object")
        throw new Error("the raw Lens reply carried no `lens` object");
      lensImageSize = authoritativeLensImageSize(answer?.image);
      imageArtifactToken = String(answer?.imageArtifact?.token || "").trim();
      trace(
        "lensImageDimensions",
        {
          authoritative: lensImageSize,
          domNatural: hasDomSize ? {
            width: Number(domSize.width),
            height: Number(domSize.height),
          } : null,
          mismatch: hasDomSize ? (
            lensImageSize.width !== Number(domSize.width) ||
            lensImageSize.height !== Number(domSize.height)
          ) : null,
          artifactToken: imageArtifactToken ? "present" : "absent",
        },
        traceId,
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const structured = error?.tpError || attachTpError(error, {
        code: "LENS_FAILED", origin: "extension", category: "processing", stage: "lens",
        retryable: !classifyJobError(error).permanent, traceId, imageId, batchId, jobId,
      }).tpError;
      trace("lensFailure", {
        schema: structured.schema || "tp.error/1",
        code: String(structured.code || "LENS_FAILED"),
        origin: String(structured.origin || "extension"),
        category: String(structured.category || "processing"),
        stage: String(structured.stage || "lens"),
        httpStatus: Number(structured.httpStatus) || 0,
        upstreamStatus: Number(structured.upstreamStatus) || 0,
        retryable: structured.retryable === true,
        requestId: String(structured.requestId || ""),
        correlationId: String(structured.correlationId || ""),
        upstream: String(structured.upstream || ""),
        errorType: String(error?.name || "Error"),
        imageId, batchId, jobId,
      }, traceId);
      log.warn("lens upload failed for this image; extension route stopped", {
        error: error?.message || String(error),
        permanent: Boolean(error?.permanent),
      });
      return stop(error);
    }

    let decoded;
    try {
      decoded = decodeLensResponse(lens, {
        width: lensImageSize.width,
        height: lensImageSize.height,
        targetLang: payload.lang,
        source: String(payload.source || "translated"),
        diagnostic: isTracing() ? event => trace("sourceGeometry", { ...event, scope:{imageId,batchId} }, traceId) : null,
      });
    } catch (error) {
      return stop(
        `local Lens decode threw ${error?.name || "Error"}: ${error?.message || String(error)}`,
      );
    }
    if (decoded.warnings.length) {
      trace("lensDecodeDiagnostics", { warnings: decoded.warnings }, traceId);
      const unexpected = decoded.warnings.filter(w => !String(w).startsWith("original: removed Japanese furigana"));
      if (unexpected.length) log.warn("lens decode dropped part of this page", {
        src: payload?.src, warnings: unexpected,
      });
    }
    const needsSourceGrouping = decoded.groups.needed && payload.source !== "translated";
    trace(
      "groupingDecision",
      {
        state: needsSourceGrouping ? "requested" : "skipped",
        needsGroups: needsSourceGrouping,
        reason: payload.source === "translated" ? "translated_geometry_only" : String(decoded.groups.reason || ""),
        counts: decoded.groups.counts || null,
        imageId,
        batchId,
      },
      traceId,
    );

    let document = decoded.document;
    let canonicalOriginalTree = null;
    let orientationFallbackCount = 0;
    if (needsSourceGrouping) {
      let grouped;
      let expectedTreeFingerprint;
      try {
        markPhase(jobId, "grouping_queued");
        trace("groupingStage", { state: "queued", imageId, batchId }, traceId);
        if (!image.dataUri)
          throw new Error(
            "the image reader returned no data URI to group with",
          );
        expectedTreeFingerprint = await rawTreeFingerprint(decoded.trees.grouping);
        grouped = await runStage(
          "groups:partition",
          () =>
            groupParagraphs(base, {
              imageDataUri: image.dataUri,
              imageArtifactToken,
              tree: decoded.trees.grouping,
              rawToDocument: decoded.groupingRawToDocument,
              context: {
                tp_trace: traceId,
                tp_tab_session: String(payload?.context?.tp_tab_session || ""),
                batch_id: batchId,
              },
              jobId,
              imageId,
              batchId,
              traceId,
              signal,
              apiUnlimited: payload?.limits?.apiUnlimited === true,
              capabilities,
            }),
          {
            signal, stage: "grouping", imageId, traceId,
            onGranted: ({ queueWaitMs, accumulatedQueueWaitMs, attempt }) => {
              markPhase(jobId, "grouping", {
                stage: "Grouping text", queueWaitMs, accumulatedQueueWaitMs, attempt,
              });
              trace("groupingStage", { state: "started", imageId, batchId,
                queueWaitMs, accumulatedQueueWaitMs, attempt }, traceId);
            },
          },
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        trace(
          "groupingStage",
          {
            state: "failed",
            imageId,
            batchId,
            errorName: String(error?.name || "Error"),
            permanent: error?.permanent === true,
          },
          traceId,
        );
        return stop(error);
      }
      try {
        const groupingResult = grouped?.groupingResult;
        if (!groupingResult) throw new Error("grouping response carried no groupingResult");
        if (
          String(grouped?.tree?.sourceTreeFingerprint || "") !==
          String(expectedTreeFingerprint)
        ) {
          throw new Error("AI source tree fingerprint does not match the decoded Lens tree");
        }
        document = attachCanonicalOriginalTree(document, grouped?.tree);
        canonicalOriginalTree = grouped?.tree;
        orientationFallbackCount = (groupingResult.groups || []).filter(g => g.orientationFallback === 'standalone_bounds').length;
      } catch (error) {
        return stop(
          `the grouping result does not fit this document: ${error?.code || error?.message || String(error)}`,
        );
      }
      if (isTracing()) {
        for (const event of geometryDiagnostics(canonicalOriginalTree, {width:lensImageSize.width, height:lensImageSize.height, reason:"group_geometry"}))
          trace("groupGeometry", {...event,scope:{imageId,batchId}},traceId);
        for (const event of groupDiagnostics(grouped.groupingResult, lensImageSize.width, lensImageSize.height))
          trace("groupMembership", {...event,scope:{imageId,batchId}},traceId);
      }
      traceLayout(document, traceId, "post-grouping", imageId);
      trace(
        "groupingAttached",
        {
          state: "grouped",
          status: String(grouped.groupingResult.status),
          imageId,
          batchId,
          groups: Array.isArray(canonicalOriginalTree?.paragraphs)
            ? canonicalOriginalTree.paragraphs.length
            : 0,
          units: translationUnits(document).length,
        },
        traceId,
      );
    }

    const requestedSource = String(payload.source || "translated");
    const fidelity = canRenderFaithfully(
      document,
      requestedSource === "ai" ? "original" : requestedSource,
    );
    if (!fidelity.ok)
      return stop(
        `the local renderer cannot draw this document: ${fidelity.reason}`,
      );
    return {
      mode: payload.mode,
      backgroundMode: "boxes",
      diagnosticSummary: {orientationFallbackCount},
      eraseBoxes: decoded.eraseBoxes,
      sourceImageDataUri: image.dataUri,
      lensDocument: document,
      layout: payload?.layout || null,
      htmlMeta: {
        baseW: lensImageSize.width,
        baseH: lensImageSize.height,
        format: "tp",
        path: "lens_direct",
      },
      originalTextFull: String(lens?.originalTextFull || ""),
      metadata: payload.metadata,
      perf: { path: "lens_raw" },
      ...(payload?.debug?.raw === true
        ? {
            debugLens: {
              canonicalOriginalTree,
              imageSize: lensImageSize,
              raw: lens,
              trees: decoded.trees,
              groups: decoded.groups,
              warnings: decoded.warnings,
            },
          }
        : {}),
    };
  };
}
