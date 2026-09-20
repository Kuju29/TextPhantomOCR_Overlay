import { observeLocalPrefix } from "../cache-coordination.js";
import { completedLineContract } from "../contracts/marker-completion.js";
import { decodedLines } from "../direct-local/stream-reader.js";

function emitWire(wireTrace, stage, value) {
  try { Promise.resolve(wireTrace?.(stage, value)).catch(() => {}); } catch {}
}

export async function readProviderResponse(response, adapter, {
  expectedIds = [], signal = null, trace = null, onProgress = null, wireTrace = null,
  dispatchStartedAt = null, headersReceivedAt = null, emitTranslationDeltas = false,
} = {}) {
  const started = Number.isFinite(dispatchStartedAt) ? dispatchStartedAt : performance.now();
  const headersAt = Number.isFinite(headersReceivedAt) ? headersReceivedAt : performance.now();
  if (!adapter.isStreamingResponse(response)) {
    let raw;
    try { raw = String(await response.text()); }
    catch (error) {
      const failedAt = performance.now();
      error.diagnostics = { ...(error.diagnostics || {}),
        providerMs: failedAt - started, dispatchToHeadersMs: headersAt - started,
        firstByteMs: null, firstContentMs: null, lastContentMs: null,
        terminalMs: failedAt - started, bodyReadComplete: false,
        providerTerminalComplete: false };
      emitWire(wireTrace, "providerResponse", { mode: "body", status: response.status,
        raw: "", bodyReadComplete: false, providerTerminalComplete: false,
        complete: false, timing: { dispatchToHeadersMs: headersAt - started,
          firstByteMs: null, firstContentMs: null, lastContentMs: null,
          terminalMs: failedAt - started }, error: { name: String(error?.name || "Error"),
          message: String(error?.message || error), code: String(error?.code || "") } });
      throw error;
    }
    const bodyReadAt = performance.now();
    const timing = { dispatchToHeadersMs: headersAt - started, firstByteMs: null,
      firstContentMs: null, lastContentMs: null, terminalMs: bodyReadAt - started };
    emitWire(wireTrace, "providerResponse", { mode: "body", status: response.status, raw,
      bodyReadComplete: true, providerTerminalComplete: true, complete: true, timing });
    emitWire(wireTrace, "providerAssembled", { text: raw, complete: true,
      source: "non_stream_http_body" });
    return { raw, streaming: false, ...timing, bodyReadComplete: true,
      providerTerminalComplete: true,
      chunks: 1, terminalCompleted: true,
      terminalEvidence: "non_stream_body_read", malformedFrameCount: 0, malformedFrameSubtypes: [] };
  }
  let content = "", chunks = 0, firstByteMs = null, firstContentMs = null, lastContentMs = null, lastProgressAt = 0;
  const rawChunks = [];
  // Reader-observed gaps include scheduling; they are not labeled network time.
  let frameAt = null, processedAt = null, protocolTerminalMs = null, contentChunks = 0;
  let maxInterFrameGapMs = 0, maxInterContentGapMs = 0, maxReadWaitMs = 0;
  let frameProcessingMs = 0, maxFrameProcessingMs = 0, deltaCallbackMs = 0, maxDeltaCallbackMs = 0;
  const deliverProgress = (event) => {
    const before = performance.now();
    try { onProgress?.(event); }
    finally { const ms = performance.now() - before; deltaCallbackMs += ms;
      maxDeltaCallbackMs = Math.max(maxDeltaCallbackMs, ms); }
  };
  const streamTimingAt = (endedAt) => ({schema: "tp.stream-timing/1", boundary: "decoded_transport_reader",
    framesObserved: chunks, contentChunks, firstContentMs, lastContentMs,
    lastFrameMs: frameAt == null ? null : frameAt - started, protocolTerminalMs,
    streamEndedMs: endedAt - started, maxInterFrameGapMs, maxInterContentGapMs, maxReadWaitMs,
    tailAfterContentMs: lastContentMs == null ? null : endedAt - started - lastContentMs,
    frameProcessingMs, maxFrameProcessingMs, deltaCallbackMs, maxDeltaCallbackMs});
  let reasoningChars = 0, reasoningObserved = false, terminal = false, providerDone = false;
  let completionEvidence = "", firstAllIdsMs = null, earlyCompletionMs = null;
  let drainDeadline = null, drainStatus = null, drainElapsedMs = null;
  let malformedFrameCount = 0, providerStreamErrorCode = null;
  const malformedFrameSubtypes = new Set();
  const envelope = adapter.emptyEnvelope();
  const progress = (state, details = {}, force = false) => {
    const now = performance.now();
    if (!force && now - lastProgressAt < 350) return;
    lastProgressAt = now; deliverProgress({ state, ...details });
  };
  const observeCompletion = () => {
    if (!expectedIds.length || completionEvidence) return false;
    const present = new Set([...content.matchAll(/(?:^|\n)[ \t]*<<(?:TP_(P\d+)|(I[1-9][0-9]{0,6}_P[0-9]{1,6})):/gu)].map((m) => m[1] || m[2]));
    if (firstAllIdsMs == null && expectedIds.every((id) => present.has(id))) firstAllIdsMs = performance.now() - started;
    const evidence = completedLineContract(content, expectedIds);
    if (!evidence) return false;
    completionEvidence = evidence; earlyCompletionMs = performance.now() - started;
    if (!emitTranslationDeltas && adapter.shouldDrainAfterCompletion(providerDone)) drainDeadline = performance.now() + adapter.drainGraceMs;
    return true;
  };
  const consume = (line) => {
    const event = adapter.normalizeLine(line);
    if (event.kind === "empty") return;
    if (event.kind === "terminal") { terminal = true; protocolTerminalMs = performance.now() - started; return; }
    if (event.kind === "provider_error") { providerStreamErrorCode = event.code; trace?.("AI local provider stream error", {
      streamMode: adapter.streamMode, providerErrorCode: event.code }); return; }
    if (event.kind === "malformed") { malformedFrameCount += 1; malformedFrameSubtypes.add(event.subtype);
      trace?.("AI local malformed stream frame", { streamMode: adapter.streamMode,
        validatorSubtype: event.subtype, frameChars: event.chars }); return; }
    adapter.mergeEnvelope(envelope, event.item);
    if (event.providerDone) { providerDone = true; protocolTerminalMs = performance.now() - started; }
    if (event.reasoning) { reasoningObserved = true; reasoningChars += event.reasoning.length; }
    if (event.content) {
      content += event.content;
      // Translation data is lossless and never subject to UI status throttling.
      // Keep consuming the same request for terminal usage and conversation history.
      const contentAt = (frameAt ?? performance.now()) - started;
      if (lastContentMs != null) maxInterContentGapMs = Math.max(maxInterContentGapMs, contentAt - lastContentMs);
      lastContentMs = contentAt; contentChunks += 1;
      if (emitTranslationDeltas) deliverProgress({ state: "translation_delta", text: event.content });
      if (firstContentMs == null) { firstContentMs = contentAt;
        progress("first_response", { chunks, firstContentMs: Math.round(firstContentMs) }, true); }
      else progress("generating", { chunks });
    } else if (firstContentMs == null) progress(event.reasoning ? "thinking" : "waiting_for_model", { chunks });
  };
  let cancel = null, streamFailure = null;
  let bodyReadComplete = false;
  try {
    for await (const batch of decodedLines(response.body, { signal, deadline: () => drainDeadline })) {
      cancel = batch.cancel;
      if (batch.deadlineReached) { drainStatus = "timeout";
        drainElapsedMs = performance.now() - (drainDeadline - adapter.drainGraceMs);
        try { Promise.resolve(cancel?.(adapter.drainCancelReason)).catch(() => {}); } catch {} break; }
      const receivedAt = performance.now();
      if (frameAt != null) maxInterFrameGapMs = Math.max(maxInterFrameGapMs, receivedAt - frameAt);
      if (processedAt != null) maxReadWaitMs = Math.max(maxReadWaitMs, receivedAt - processedAt);
      frameAt = receivedAt;
      try {
        chunks += 1; if (firstByteMs == null) firstByteMs = performance.now() - started;
        rawChunks.push(String(batch.rawChunk ?? batch.lines.join("\n")));
        for (const line of batch.lines) {
          consume(line); observeCompletion();
          // Provider protocol completion is authoritative even if translation
          // records are incomplete. Ignore any bytes following that terminal.
          if (terminal || providerDone) break;
        }
        if (terminal || providerDone) {
          try { Promise.resolve(cancel?.(adapter.completionCancelReason)).catch(() => {}); } catch {}
          break;
        }
        if (chunks <= 3 || (chunks & (chunks - 1)) === 0 || chunks % 100 === 0)
          trace?.("AI local stream progress", { streamMode: adapter.streamMode, chunks,
            firstByteMs: Math.round(firstByteMs || 0), firstContentMs: firstContentMs == null ? null : Math.round(firstContentMs) });
      } finally {
        processedAt = performance.now();
        const ms = processedAt - receivedAt;
        frameProcessingMs += ms; maxFrameProcessingMs = Math.max(maxFrameProcessingMs, ms);
      }
    }
    bodyReadComplete = !(terminal || providerDone || drainStatus === "timeout");
  } catch (error) {
    streamFailure = error;
    throw error;
  } finally {
    if (streamFailure) {
      const failedAt = performance.now();
      try {
        streamFailure.observedUsage = { ...adapter.usage(adapter.finalizeEnvelope(envelope, content)), usageStatus: "incomplete" };
      } catch {} // A malformed response is never replaced by estimated usage.
      streamFailure.diagnostics = { ...(streamFailure.diagnostics || {}),
        providerMs: failedAt - started, dispatchToHeadersMs: headersAt - started,
        firstByteMs, firstContentMs, lastContentMs, terminalMs: failedAt - started,
        streamTiming: streamTimingAt(failedAt), bodyReadComplete: false, providerTerminalComplete: false };
      emitWire(wireTrace, "providerResponse", { mode: "stream", status: response.status,
        chunks: rawChunks, bodyReadComplete: false, providerTerminalComplete: false,
        complete: false, timing: { dispatchToHeadersMs: headersAt - started,
          firstByteMs, firstContentMs, lastContentMs, terminalMs: failedAt - started,
          streamTiming: streamTimingAt(failedAt) },
        error: { name: String(streamFailure?.name || "Error"),
          message: String(streamFailure?.message || streamFailure), code: String(streamFailure?.code || "") } });
      emitWire(wireTrace, "providerAssembled", { text: content,
        complete: false, providerTerminalComplete: false,
        source: "decoded_stream_content" });
    }
  }
  observeCompletion();
  if (completionEvidence && adapter.recordsDrainStatus && drainStatus == null) {
    drainStatus = providerDone ? "terminal_received" : "stream_closed";
    drainElapsedMs = drainDeadline == null ? 0 : performance.now() - (drainDeadline - adapter.drainGraceMs);
  }
  const terminalAt = performance.now();
  const streamTiming = streamTimingAt(terminalAt);
  const data = adapter.finalizeEnvelope(envelope, content);
  const finishReason = adapter.finishReason(data);
  const normalFinish = /^(?:stop|end_turn|completed|complete)$/i.test(finishReason);
  const terminalCompleted = adapter.terminalCompleted({ providerDone, terminal, normalFinish });
  emitWire(wireTrace, "providerResponse", { mode: "stream", status: response.status,
    chunks: rawChunks, bodyReadComplete,
    providerTerminalComplete: terminalCompleted, complete: terminalCompleted,
    reconstructedEnvelope: JSON.stringify(data),
    timing: { dispatchToHeadersMs: headersAt - started, firstByteMs, firstContentMs,
      lastContentMs, terminalMs: terminalCompleted ? terminalAt - started : null, streamTiming } });
  emitWire(wireTrace, "providerAssembled", { text: content,
    complete: terminalCompleted, providerTerminalComplete: terminalCompleted,
    source: "decoded_stream_content" });
  return { raw: JSON.stringify(data), data, streaming: true, firstByteMs, firstContentMs, chunks, streamTiming,
    bodyReadComplete, providerTerminalComplete: terminalCompleted,
    reasoningObserved, reasoningChars, terminalCompleted,
    terminalEvidence: providerDone ? "provider_done" : terminal ? "protocol_done" : normalFinish ? "finish_reason" : "none",
    earlyCompleted: false, completionEvidence: completionEvidence || null, firstAllIdsMs, earlyCompletionMs,
    dispatchToHeadersMs: headersAt - started, lastContentMs,
    terminalMs: terminalCompleted ? terminalAt - started : null,
    drainStatus, drainTimeoutMs: adapter.recordsDrainStatus && completionEvidence ? adapter.drainGraceMs : null,
    drainElapsedMs, malformedFrameCount, malformedFrameSubtypes: [...malformedFrameSubtypes], providerStreamErrorCode };
}

export async function dispatchProviderRequest(adapter, request, context) {
  const setupStarted = performance.now();
  context.onProgress?.({ state: "connecting" });
  const url = adapter.requestUrl(request), headers = adapter.headers(request), payload = adapter.payload(request);
  const thinkingApplied = typeof adapter.thinkingApplied === "function"
    ? adapter.thinkingApplied(request.thinkingMode, {
        model: request.model, reasoning: request.thinkingCapability, payload,
      })
    : request.thinkingMode === "default" ? "provider_default" : "unverified";
  const cacheLease = await observeLocalPrefix({url,model:request.model,headers,payload,
    layout:context.cacheContext,trace:context.trace,revision:context.cacheRevision || "",operationId:context.cacheOperationId || ""});
  emitWire(context.wireTrace, "providerRequest", { url, method: "POST", headers, body: payload,
    ...(cacheLease ? {cacheCoordination:cacheLease.snapshot()} : {}) });
  const requestBody = JSON.stringify(payload);
  const started = performance.now();
  const requestSetupMs = started - setupStarted;
  let response;
  try {
    if (context.signal?.aborted) throw context.signal.reason || new DOMException("Cancelled", "AbortError");
    cacheLease?.dispatched();
    response = await fetch(url, {
      method: "POST", headers, cache: "no-store", credentials: "omit",
      redirect: "error", signal: context.signal, body: requestBody,
    });
  } catch (error) {
    error.cacheCoordination = cacheLease?.finish({}, false, context.signal?.aborted ? "cancelled" : "failed");
    error.requestDispatched = cacheLease ? cacheLease.snapshot().requestDispatched : !context.signal?.aborted;
    error.providerResponded = false;
    const failedAt = performance.now();
    error.diagnostics = { ...(error.diagnostics || {}),
      providerMs: failedAt - started, dispatchToHeadersMs: null,
      firstByteMs: null, firstContentMs: null, lastContentMs: null,
      terminalMs: failedAt - started, bodyReadComplete: false,
      providerTerminalComplete: false };
    throw error;
  }
  const headersReceivedAt = performance.now();
  context.onProgress?.({ state: "waiting_for_model" });
  let stream;
  try { stream = await readProviderResponse(response, adapter, {
    ...context, dispatchStartedAt: started, headersReceivedAt,
  }); }
  catch (error) {
    error.cacheCoordination = cacheLease?.finish(error.observedUsage || {}, false, context.signal?.aborted ? "cancelled" : "failed");
    error.requestDispatched = true;
    error.providerResponded = true;
    error.status = Number(response.status || 0);
    throw error;
  }
  const providerMs = Number.isFinite(stream.terminalMs)
    ? stream.terminalMs
    : Math.max(0, performance.now() - started);
  // These are client-observed intervals on one monotonic clock. In particular,
  // dispatch-to-headers includes server work and is never labeled network time.
  stream.requestSetupMs = requestSetupMs;
  stream.headersToFirstByteMs = Number.isFinite(stream.firstByteMs)
    ? Math.max(0, stream.firstByteMs - stream.dispatchToHeadersMs) : null;
  stream.headersToFirstContentMs = Number.isFinite(stream.firstContentMs)
    ? Math.max(0, stream.firstContentMs - stream.dispatchToHeadersMs) : null;
  stream.contentToTerminalMs = Number.isFinite(stream.lastContentMs) && Number.isFinite(stream.terminalMs)
    ? Math.max(0, stream.terminalMs - stream.lastContentMs) : null;
  try { context.trace?.("requestTiming", {schema:"tp.audit/1", event:"request_timing", reason:"response_complete",
    route:"direct-local", timing:{requestSetupMs, httpMs:providerMs,
      headersMs:stream.dispatchToHeadersMs, headersToFirstByteMs:stream.headersToFirstByteMs,
      headersToFirstContentMs:stream.headersToFirstContentMs, contentToTerminalMs:stream.contentToTerminalMs},
    });
    if(stream.streamTiming) context.trace?.("streamTiming",{schema:"tp.audit/1",event:"stream_timing",reason:"stream_observed",
      operationId:context.cacheOperationId || "",timing:stream.streamTiming});
  } catch {}
  let observedUsage = {};
  try { observedUsage = adapter.usage(stream.data || {}); } catch {} // Diagnostics never replace a provider/protocol error.
  const cacheCoordination = cacheLease?.finish(observedUsage, response.ok && stream.terminalCompleted === true);
  return { response, stream, providerMs, cacheCoordination, thinkingApplied };
}

export async function getProviderJson(url, { signal = null, timeoutMs = 10000, optional = false } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Local AI model discovery timed out")),
    Math.max(1000, Number(timeoutMs) || 10000));
  try {
    const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" },
      cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
    if (!response.ok) {
      if (optional) return null;
      const error = new Error(`Local AI model discovery failed (HTTP ${response.status})`);
      error.status = response.status; throw error;
    }
    try { return await response.json(); } catch { if (optional) return null; throw new Error("Local AI model list was not JSON"); }
  } finally { clearTimeout(timer); signal?.removeEventListener?.("abort", abort); }
}
