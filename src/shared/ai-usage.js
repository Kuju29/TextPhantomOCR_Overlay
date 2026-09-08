import { createUsageCommitQueue } from "./ai/usage-commit-queue.js";
import { getStorage, setStorage } from "./storage.js";
import { TOKEN_FIELDS, token, decimal, addDecimal, aggregateUsage, usageIsComplete } from "./ai/usage-values.js";

export const AI_USAGE_STORAGE_KEY = "aiUsageV1";
export const AI_USAGE_VERSION = 1;
export const AI_USAGE_SESSION_LIMIT = 20;
export const AI_USAGE_DELTA_LIMIT = 200;
const blankLedger = () => ({
  version: AI_USAGE_VERSION,
  active: null,
  selection: null,
  models: {},
  seen: {},
  pending: {},
  pendingOverflow: 0,
});
const nullableToken = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

// Provider failures do not all carry telemetry at the same nesting level.
// Normalize only the documented envelopes; never estimate missing token counts.
export function failureUsageDetails(errorLike) {
  const root = errorLike && typeof errorLike === "object" ? errorLike : {};
  const structural =
    root.structuralDetails && typeof root.structuralDetails === "object"
      ? root.structuralDetails
      : {};
  const success = root.meta && typeof root.meta === "object" ? root.meta : {};
  const generation =
    structural.generationMeta && typeof structural.generationMeta === "object"
      ? structural.generationMeta
      : root.generationMeta && typeof root.generationMeta === "object"
        ? root.generationMeta
        : {};
  const diagnostics =
    root.diagnostics && typeof root.diagnostics === "object"
      ? root.diagnostics
      : {};
  const usage =
    [
      generation.usage,
      structural.usage,
      success.usage,
      root.usage,
      diagnostics.usage,
    ].find((value) => value && typeof value === "object") || {};
  // A later Local batch may fail after earlier batches were already billed.
  // accumulatedUsage means completed *prior* batches, while usage above means
  // the current failed generation. Read one accumulated envelope by precedence
  // so mirrored diagnostics/generationMeta references are never double-counted.
  const accumulated =
    [
      generation.accumulatedUsage,
      structural.accumulatedUsage,
      diagnostics.accumulatedUsage,
      root.accumulatedUsage,
    ].find((value) => value && typeof value === "object") || {};
  const first = (...values) =>
    values.find(
      (value) => value !== undefined && value !== null && value !== "",
    );
  const combinedToken = (...keys) => {
    const current = nullableToken(first(...keys.map((key) => usage[key])));
    const prior = nullableToken(first(...keys.map((key) => accumulated[key])));
    if (current == null) return prior;
    if (prior == null || accumulated === usage) return current;
    return current + prior;
  };
  const attemptsValue = Number(
    first(
      root.generationAttempts,
      root.generation_attempts,
      generation.generationAttempts,
      generation.generation_attempts,
    ),
  );
  const completeUsage = Object.keys(accumulated).length && accumulated !== usage
    ? aggregateUsage([accumulated, usage]) : usage;
  return {
    usage: completeUsage,
    provider: String(
      first(
        structural.resolvedProvider,
        structural.resolved_provider,
        generation.resolvedProvider,
        generation.resolved_provider,
        success.resolvedProvider,
        success.resolved_provider,
        success.provider,
        generation.provider,
        structural.provider,
        root.resolvedProvider,
        root.resolved_provider,
        root.provider,
      ) || "",
    ),
    model: String(
      first(
        structural.resolvedModel,
        structural.resolved_model,
        generation.resolvedModel,
        generation.resolved_model,
        success.resolvedModel,
        success.resolved_model,
        success.model,
        generation.model,
        generation.usedModel,
        generation.used_model,
        structural.model,
        root.resolvedModel,
        root.resolved_model,
        root.model,
      ) || "",
    ),
    baseUrl: String(
      first(
        structural.resolvedBaseUrl,
        structural.resolved_base_url,
        generation.baseUrl,
        generation.base_url,
        success.baseUrl,
        success.base_url,
        structural.baseUrl,
        structural.base_url,
        root.baseUrl,
        root.base_url,
      ) || "",
    ),
    inputTokens: combinedToken(
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
    ),
    outputTokens: combinedToken(
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
    ),
    totalTokens: combinedToken("totalTokens", "total_tokens"),
    providerMs: Number(
      first(
        generation.providerMs,
        generation.provider_ms,
        structural.providerMs,
        structural.provider_ms,
        diagnostics.providerMs,
        diagnostics.provider_ms,
      ),
    ),
    totalMs: Number(
      first(
        generation.totalMs,
        generation.total_ms,
        structural.totalMs,
        structural.total_ms,
        diagnostics.totalMs,
        diagnostics.total_ms,
      ),
    ),
    finishReason: String(
      first(
        generation.finishReason,
        generation.finish_reason,
        structural.finishReason,
        structural.finish_reason,
        diagnostics.finishReason,
        diagnostics.finish_reason,
        root.finishReason,
        root.finish_reason,
      ) || "",
    ),
    generationAttempts:
      Number.isInteger(attemptsValue) && attemptsValue > 0 ? attemptsValue : 0,
  };
}

export function usageKey(runtime, provider, model) {
  return [runtime, provider, model]
    .map((v) =>
      String(v || "unknown")
        .trim()
        .toLowerCase(),
    )
    .join("|");
}

export function normalizeUsageLedger(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw.version !== AI_USAGE_VERSION
  )
    return blankLedger();
  const models = {};
  for (const [key, value] of Object.entries(raw.models || {})) {
    if (!value || typeof value !== "object" || !Array.isArray(value.sessions))
      continue;
    const sessions = value.sessions
      .filter((s) => s && typeof s === "object" && s.id)
      .slice(-AI_USAGE_SESSION_LIMIT)
      .map((s) => ({
        ...s,
        ...coverageMigration(s),
        engines: { runsextension: 0, runsapi: 0, ...(s.engines || {}) },
        deltas: Array.isArray(s.deltas)
          ? s.deltas
              .filter((d) => d && typeof d === "object")
              .slice(-AI_USAGE_DELTA_LIMIT).map((d) => ({ ...d }))
          : [],
      }));
    if (sessions.length) models[key] = { ...value, sessions };
  }
  const active =
    raw.active &&
    models[raw.active.selectionKey]?.sessions.some(
      (s) => s.id === raw.active.sessionId,
    )
      ? {
          selectionKey: raw.active.selectionKey,
          sessionId: raw.active.sessionId,
        }
      : null;
  const selected =
    raw.selection && typeof raw.selection === "object" ? raw.selection : null;
  const selection =
    selected &&
    selected.provider &&
    selected.model &&
    Number.isFinite(Number(selected.boundaryAt))
      ? {
          runtime: selected.runtime === "local" ? "local" : "cloud",
          provider: String(selected.provider),
          model: String(selected.model),
          selectionKey: usageKey(
            selected.runtime,
            selected.provider,
            selected.model,
          ),
          boundaryAt: Number(selected.boundaryAt),
          reason: String(selected.reason || "model_switch"),
          pendingReset:
            selected.pendingReset &&
            Number.isFinite(Number(selected.pendingReset.at)) &&
            selected.pendingReset.id
              ? {
                  at: Number(selected.pendingReset.at),
                  id: String(selected.pendingReset.id),
                }
              : null,
        }
      : null;
  return { version: AI_USAGE_VERSION, active, selection, models, pending: { ...(raw.pending || {}) }, pendingOverflow: Number(raw.pendingOverflow) || 0, seen: raw.seen && typeof raw.seen === "object" ? { ...raw.seen } : {} };
}

const newSession = (now, id) => ({
  id,
  startedAt: now,
  endedAt: null,
  resetReason: null,
  requests: 0,
  usageCoverageVersion: 2,
  reportedRequests: 0,
  incompleteRequests: 0,
  tokenCoverage: {},
  providerCostUsd: null,
  costReportedRequests: 0,
  successes: 0,
  failures: 0,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  sourceChars: 0,
  translatedUnits: 0,
  providerMs: 0,
  totalMs: 0,
  engines: { runsextension: 0, runsapi: 0 },
  deltas: [],
});

function closeActive(ledger, now, reason) {
  const active = ledger.active;
  const session =
    active &&
    ledger.models[active.selectionKey]?.sessions.find(
      (s) => s.id === active.sessionId,
    );
  if (session && session.endedAt == null)
    Object.assign(session, { endedAt: now, resetReason: reason });
}

export function applyUsageSelectionBoundary(
  raw,
  target,
  { now = Date.now() } = {},
) {
  const ledger = normalizeUsageLedger(raw);
  const runtime = target?.runtime === "local" ? "local" : "cloud";
  const provider = String(target?.provider || "unknown").trim() || "unknown";
  const model = String(target?.model || "auto").trim() || "auto";
  const reason =
    target?.reason === "provider_switch" ? "provider_switch" : "model_switch";
  closeActive(ledger, now, reason);
  ledger.active = null;
  ledger.selection = {
    runtime,
    provider,
    model,
    selectionKey: usageKey(runtime, provider, model),
    boundaryAt: now,
    reason,
    pendingReset: null,
  };
  return ledger;
}

const addToken = (current, incoming) => {
  const value = nullableToken(incoming);
  return value == null ? current : current == null ? value : current + value;
};

const normalizeDecimal = (v) => String(v).replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

const cleanId = (value) =>
  String(value || "")
    .trim()
    .slice(0, 160);
const generationIdentity = (event) =>
  cleanId(
    event?.usage?.receiptId || event?.receiptId || event?.providerGenerationId ||
      event?.idempotencyKey ||
      event?.operationId ||
      event?.requestId ||
      event?.traceId,
  );
const generationDedupeKey = (event, runtime, provider, model) => {
  const receipt = cleanId(event?.usage?.receiptId || event?.receiptId);
  if (receipt) return `receipt|${receipt}`;
  const identity = generationIdentity(event);
  if (!identity) return "";
  if (event?.providerGenerationId) return [runtime, provider, model, identity].join("|");
  const ordinal = Number.isInteger(event?.generationOrdinal)
    ? event.generationOrdinal
    : 0;
  return [runtime, provider, model, identity, ordinal]
    .map((v) => String(v))
    .join("|");
};

export function recordProviderGeneration(
  raw,
  event,
  { now = Date.now(), id = () => crypto.randomUUID() } = {},
) {
  const ledger = normalizeUsageLedger(raw);
  const pendingKey = event?.operationId ? `${event.engine || "runsextension"}|${cleanId(event.operationId)}` : "";
  if (event?.pending === true) {
    if (pendingKey) ledger.pending[pendingKey] = {
      runtime: event.runtime === "local" ? "local" : "cloud",
      provider: String(event.provider || "unknown"), model: String(event.model || "unknown"),
      at: now, reason: String(event.pendingReason || "awaiting_provider_usage"),
    };
    const keys = Object.keys(ledger.pending);
    if (keys.length > 1024) { delete ledger.pending[keys[0]]; ledger.pendingOverflow++; }
    return ledger;
  }
  if (pendingKey) delete ledger.pending[pendingKey];
  if (event?.resolvePending === true) return ledger;
  if (
    !event ||
    event.dispatched === false ||
    event.cancelledBeforeDispatch === true ||
    (event.replayed === true && !event?.usage?.receiptId && !event?.receiptId &&
      !event?.usage?.generations?.some(g => g?.receiptId))
  ) {
    return ledger;
  }
  const generationUsages = event?.usage?.generations || event?.generationUsage;
  if (Array.isArray(generationUsages) && generationUsages.length) {
    return generationUsages.reduce((value, usage, generationOrdinal) => recordProviderGeneration(value,
      { ...event, ...usage, ...Object.fromEntries(TOKEN_FIELDS.map(k => [k, token(usage?.[k])])),
        providerCostUsd: decimal(usage?.providerCostUsd), usageStatus: usage?.usageStatus || (usageIsComplete(usage) ? "reported" : "incomplete"),
        usage, generationUsage: null, requests: 1, generationOrdinal,
        generationAttempts: 1, failures: event.success === false ? 1 : undefined }, { now, id }), ledger);
  }
  event = { ...(event?.usage || {}), ...event };
  const runtime = event?.runtime === "local" ? "local" : "cloud";
  const provider = String(event?.provider || "unknown").trim() || "unknown";
  const resolvedModel = String(event?.model || "unknown").trim() || "unknown";
  const requestedModel = String(event?.requestedModel || "").trim();
  // Group the comparison UI by the explicitly requested selection, while
  // retaining the actual serving model on each receipt/delta. Do not guess
  // aliases from string similarity (and keep auto-model resolution unchanged).
  const modelName = requestedModel && requestedModel.toLowerCase() !== "auto"
    ? requestedModel : resolvedModel;
  const key = usageKey(runtime, provider, modelName);
  const engine = event?.engine === "runsapi" ? "runsapi" : "runsextension";
  const dedupeKey = generationDedupeKey(event, runtime, provider, modelName);
  if (dedupeKey) {
    for (const entry of Object.values(ledger.models)) {
      for (const saved of entry.sessions) {
        const previous = saved.deltas?.find(d => d.dedupeKey === dedupeKey);
        if (previous) {
          // Same generation reported again: enrich missing observations only.
          // Conflicting known values never become a second request/charge.
          let changed = false;
          const next = { ...previous };
          for (const keyName of TOKEN_FIELDS) {
            const incoming = token(event[keyName]);
            if (next[keyName] == null && incoming != null) { next[keyName] = incoming; changed = true; }
            else if (incoming != null && next[keyName] != null && incoming !== next[keyName]) {
              next.usageStatus = "inconsistent"; changed = true;
            }
          }
          const newCost = decimal(event.providerCostUsd);
          if (next.providerCostUsd == null && newCost != null) {
            next.providerCostUsd = newCost;
            saved.providerCostUsd = addDecimal(saved.providerCostUsd, newCost);
            saved.costReportedRequests += previous.requests;
            changed = true;
          }
          if (event.usageStatus === "reported" && next.usageStatus !== "inconsistent" && next.usageStatus !== "reported") {
            next.usageStatus = "reported"; changed = true;
          }
          if (newCost != null && previous.providerCostUsd != null && normalizeDecimal(newCost) !== normalizeDecimal(previous.providerCostUsd)) {
            next.usageStatus = "inconsistent"; changed = true;
            if (!previous.costConflict) saved.costReportedRequests -= previous.requests;
            next.costConflict = true;
          }
          if (!changed) return ledger;
          for (const keyName of TOKEN_FIELDS) {
            const old = token(previous[keyName]), incoming = token(next[keyName]);
            if (old == null && incoming != null) {
              saved[keyName] = addToken(saved[keyName], incoming);
              saved.tokenCoverage[keyName] = (saved.tokenCoverage[keyName] || 0) + previous.requests;
            }
          }
          const wasComplete = usageIsComplete(previous);
          if (event.usageStatus === "reported" && next.usageStatus !== "inconsistent") next.usageStatus = "reported";
          const isComplete = usageIsComplete(next);
          if (wasComplete !== isComplete) {
            saved.reportedRequests += isComplete ? previous.requests : -previous.requests;
            saved.incompleteRequests += isComplete ? -previous.requests : previous.requests;
          }
          Object.assign(previous, next);
          return ledger;
        }
      }
    }
    // Keep dedupe identities after the visible 200-row history rolls over.
    if (Object.hasOwn(ledger.seen, dedupeKey)) return ledger;
  }
  const eventStartedAt = Number.isFinite(Number(event?.startedAt))
    ? Number(event.startedAt)
    : now;
  const selection = ledger.selection;
  const selectedMatch =
    !selection ||
    (selection.runtime === runtime &&
      selection.provider.toLowerCase() === provider.toLowerCase() &&
      (selection.model.toLowerCase() === "auto" ||
        selection.model.toLowerCase() === modelName.toLowerCase()));
  const historicalCompletion =
    Boolean(selection) &&
    (!selectedMatch || eventStartedAt < selection.boundaryAt);
  const activeSession =
    ledger.active &&
    ledger.models[ledger.active.selectionKey]?.sessions.find(
      (s) => s.id === ledger.active.sessionId,
    );
  const staleCompletion =
    historicalCompletion ||
    (ledger.active?.selectionKey !== key &&
      activeSession &&
      eventStartedAt < activeSession.startedAt);
  if (!staleCompletion && ledger.active?.selectionKey !== key) {
    closeActive(ledger, now, "model_switch");
    ledger.active = null;
  }
  const model = (ledger.models[key] ||= {
    provider,
    model: modelName,
    runtime,
    sessions: [],
  });
  let session = staleCompletion
    ? model.sessions.at(-1)
    : ledger.active &&
      model.sessions.find((s) => s.id === ledger.active.sessionId);
  if (!session) {
    const pendingReset = !staleCompletion && selection?.pendingReset;
    session = newSession(
      pendingReset?.at ?? eventStartedAt,
      pendingReset?.id || id(),
    );
    if (staleCompletion)
      Object.assign(session, { endedAt: now, resetReason: "model_switch" });
    model.sessions.push(session);
    model.sessions = model.sessions.slice(-AI_USAGE_SESSION_LIMIT);
    if (!staleCompletion)
      ledger.active = { selectionKey: key, sessionId: session.id };
  }
  if (!staleCompletion && selection) {
    ledger.selection = {
      ...selection,
      runtime,
      provider,
      model: modelName,
      selectionKey: key,
      pendingReset: null,
    };
  }
  const requests = Math.max(
    1,
    Number.isInteger(event?.requests) ? event.requests : 1,
  );
  const failures = Math.max(
    0,
    Math.min(
      requests,
      Number.isInteger(event?.failures)
        ? event.failures
        : event?.success === false
          ? requests
          : 0,
    ),
  );
  session.requests += requests;
  session.failures += failures;
  session.successes += requests - failures;
  const complete = usageIsComplete(event);
  session.reportedRequests += complete ? requests : 0;
  session.incompleteRequests += complete ? 0 : requests;
  for (const keyName of TOKEN_FIELDS) {
    session[keyName] = addToken(session[keyName], event?.[keyName]);
    if (token(event?.[keyName]) != null) session.tokenCoverage[keyName] = (session.tokenCoverage[keyName] || 0) + requests;
  }
  if (decimal(event?.providerCostUsd) != null) {
    session.providerCostUsd = addDecimal(session.providerCostUsd, event.providerCostUsd);
    session.costReportedRequests += requests;
  }
  for (const keyName of [
    "sourceChars",
    "translatedUnits",
    "providerMs",
    "totalMs",
  ]) {
    const value = Number(event?.[keyName]);
    if (Number.isFinite(value) && value >= 0) session[keyName] += value;
  }
  session.engines[engine] += requests;
  const reason = [
    "translation_success",
    "provider_charged_failure",
    "repair",
  ].includes(event?.reason)
    ? event.reason
    : failures > 0
      ? "provider_charged_failure"
      : "translation_success";
  session.deltas.push({
    id: cleanId(event?.deltaId) || id(),
    dedupeKey,
    sessionId: session.id,
    traceId: cleanId(event?.traceId),
    requestId: cleanId(event?.requestId),
    operationId: cleanId(event?.operationId),
    provider,
    model: modelName,
    resolvedModel,
    runtime,
    engine,
    ...Object.fromEntries(TOKEN_FIELDS.map(k => [k, token(event?.[k])])),
    usageStatus: event?.usageStatus || (complete ? "reported" : "incomplete"),
    providerCostUsd: decimal(event?.providerCostUsd),
    receiptId: cleanId(event?.usage?.receiptId || event?.receiptId),
    inputTokens: nullableToken(event?.inputTokens),
    outputTokens: nullableToken(event?.outputTokens),
    totalTokens: nullableToken(event?.totalTokens),
    reason,
    requests,
    failures,
    generationAttempts: Math.max(
      0,
      Number(event?.generationAttempts) || requests,
    ),
    replayed: false,
    idempotent: Boolean(dedupeKey),
    idempotencyKey: cleanId(event?.idempotencyKey),
    timestamp: now,
  });
  session.deltas = session.deltas.slice(-AI_USAGE_DELTA_LIMIT);
  if (dedupeKey) ledger.seen[dedupeKey] = now;
  const entries = Object.entries(ledger.seen);
  if (entries.length > 8192) ledger.seen = Object.fromEntries(entries.sort((a,b) => b[1]-a[1]).slice(0,8192));
  return ledger;
}

// Compatibility for pure ledger callers. Runtime call sites use the named
// provider-generation boundary below so probes/discovery cannot enter usage.
export const recordUsage = recordProviderGeneration;

export function resetActiveUsage(
  raw,
  { now = Date.now(), id = () => crypto.randomUUID() } = {},
) {
  const ledger = normalizeUsageLedger(raw);
  const key = ledger.selection?.selectionKey || ledger.active?.selectionKey;
  if (!key) return ledger;
  if (!ledger.models[key]) {
    ledger.active = null;
    ledger.selection = {
      ...ledger.selection,
      pendingReset: { at: now, id: id() },
    };
    return ledger;
  }
  const model = ledger.models[key];
  closeActive(ledger, now, "manual");
  const session = newSession(now, id());
  model.sessions.push(session);
  model.sessions = model.sessions.slice(-AI_USAGE_SESSION_LIMIT);
  ledger.active = { selectionKey: key, sessionId: session.id };
  if (ledger.selection)
    ledger.selection = { ...ledger.selection, pendingReset: null };
  return ledger;
}

export function usageRows(raw) {
  const ledger = normalizeUsageLedger(raw);
  return Object.entries(ledger.models)
    .map(([key, model]) => {
      const current =
        model.sessions.find(
          (s) =>
            ledger.active?.selectionKey === key &&
            ledger.active.sessionId === s.id,
        ) || model.sessions.at(-1);
      const prior = model.sessions.filter((s) => s !== current);
      return { key, ...model, current, prior, priorSessions: prior.length };
    })
    .sort(
      (a, b) =>
        Number(b.current?.startedAt || 0) - Number(a.current?.startedAt || 0),
    );
}

// Read-only, newest-first view of every retained session. Keep nullable token
// counters intact: an unavailable provider counter must never look like zero.
export function usageHistoryRows(raw) {
  const ledger = normalizeUsageLedger(raw);
  const activeKey = ledger.active?.selectionKey || "";
  const activeId = ledger.active?.sessionId || "";
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  return Object.entries(ledger.models)
    .flatMap(([selectionKey, model]) =>
      model.sessions.map((session) => ({
        id: String(session.id),
        selectionKey,
        runtime: model.runtime === "local" ? "local" : "cloud",
        provider: String(model.provider || "unknown"),
        model: String(model.model || "unknown"),
        startedAt: Number.isFinite(Number(session.startedAt))
          ? Number(session.startedAt)
          : 0,
        endedAt: Number.isFinite(Number(session.endedAt))
          ? Number(session.endedAt)
          : null,
        resetReason: String(session.resetReason || ""),
        current:
          selectionKey === activeKey &&
          session.id === activeId &&
          session.endedAt == null,
        requests: count(session.requests),
        successes: count(session.successes),
        failures: count(session.failures),
        ...usageDisplay(session),
        inputTokens: nullableToken(session.inputTokens),
        outputTokens: nullableToken(session.outputTokens),
        totalTokens: nullableToken(session.totalTokens),
        extensionRequests: count(session.engines?.runsextension),
        apiRequests: count(session.engines?.runsapi),
      })),
    )
    .sort((left, right) => right.startedAt - left.startedAt);
}

export function currentUsage(raw, target = null) {
  const ledger = normalizeUsageLedger(raw);
  const selected = target?.provider
    ? {
        runtime: target.runtime === "local" ? "local" : "cloud",
        provider: String(target.provider || "unknown").trim() || "unknown",
        model: String(target.model || "auto").trim() || "auto",
      }
    : ledger.selection;
  if (!selected) return null;
  let key = usageKey(selected.runtime, selected.provider, selected.model);
  if (
    selected.model.toLowerCase() === "auto" &&
    ledger.selection?.selectionKey &&
    ledger.selection.runtime === selected.runtime &&
    ledger.selection.provider.toLowerCase() === selected.provider.toLowerCase()
  ) {
    key = ledger.selection.selectionKey;
  }
  const active =
    ledger.active?.selectionKey === key
      ? ledger.models[key]?.sessions.find(
          (session) => session.id === ledger.active.sessionId,
        )
      : null;
  const model = active ? ledger.models[key] : null;
  const pendingOperations = Object.values(ledger.pending).filter(p =>
    p.runtime === selected.runtime && p.provider.toLowerCase() === selected.provider.toLowerCase() &&
    (selected.model.toLowerCase() === "auto" || p.model.toLowerCase() === selected.model.toLowerCase())).length;
  return {
    pendingOperations, pendingOverflow: ledger.pendingOverflow,
    runtime: selected.runtime,
    provider: model?.provider || selected.provider,
    model: model?.model || selected.model,
    ...usageDisplay(active),
    requests: active?.requests || 0,
    inputTokens: active ? active.inputTokens : null,
    outputTokens: active ? active.outputTokens : null,
    totalTokens: active ? active.totalTokens : 0,
    tokensReported: Boolean(
      active && !pendingOperations && !ledger.pendingOverflow && active.incompleteRequests === 0 &&
        active.inputTokens != null &&
        active.outputTokens != null &&
        active.totalTokens != null,
    ),
    tokenStatus:
      pendingOperations || ledger.pendingOverflow ? "incomplete" :
      !active || active.requests === 0
        ? "not_used"
        : active.incompleteRequests === 0 && active.inputTokens != null &&
            active.outputTokens != null &&
            active.totalTokens != null
          ? "reported"
          : active.inputTokens != null ||
              active.outputTokens != null ||
              active.totalTokens != null
            ? "incomplete"
            : "unavailable",
  };
}

const commitUsage = createUsageCommitQueue({
  read: async () => (await getStorage({ [AI_USAGE_STORAGE_KEY]: blankLedger() }))[AI_USAGE_STORAGE_KEY],
  write: next => setStorage({ [AI_USAGE_STORAGE_KEY]: next }),
  normalize: normalizeUsageLedger,
  lock: usageStorageLock,
});
export function persistProviderGeneration(event, { emitTrace = null, onTiming = null } = {}) {
  // Capture an immutable event before the asynchronous batch commit. Callers
  // cannot mutate an in-flight receipt or pending intent while storage waits.
  event = structuredClone(event);
  return commitUsage(before => recordProviderGeneration(before, event), {
    onTiming,
    onCommit: ({before, next}) => {
    if (typeof emitTrace === "function") {
      const unchanged = JSON.stringify(before) === JSON.stringify(next);
      const eventKey = usageKey(
        event?.runtime === "local" ? "local" : "cloud",
        event?.provider,
        event?.model,
      );
      const latest = (ledger) =>
        ledger.models[eventKey]?.sessions.at(-1) || null;
      const beforeSession = latest(before);
      const afterSession = latest(next);
      emitTrace("AI usage ledger delta", {
        sessionId: afterSession?.id || "",
        traceId: cleanId(event?.traceId),
        requestId: cleanId(event?.requestId),
        operationId: cleanId(event?.operationId),
        provider: String(event?.provider || "unknown"),
        model: String(event?.model || "unknown"),
        runtime: event?.runtime === "local" ? "local" : "cloud",
        engine: event?.engine === "runsapi" ? "runsapi" : "runsextension",
        reason: String(
          event?.reason ||
            (event?.success === false
              ? "provider_charged_failure"
              : "translation_success"),
        ),
        inputTokens: nullableToken(event?.inputTokens),
        outputTokens: nullableToken(event?.outputTokens),
        totalTokens: nullableToken(event?.totalTokens),
        generationAttempts: Number(
          event?.generationAttempts || event?.requests || 1,
        ),
        replayed: Boolean(event?.replayed),
        idempotent: Boolean(generationIdentity(event)),
        deduplicated: unchanged,
        beforeRequests: Number(beforeSession?.requests || 0),
        afterRequests: Number(afterSession?.requests || 0),
        beforeTotalTokens: beforeSession?.totalTokens ?? null,
        afterTotalTokens: afterSession?.totalTokens ?? null,
      });
    }
    },
  });
}
export const persistUsageEvent = persistProviderGeneration;
export function persistUsageReset() {
  return commitUsage(before => resetActiveUsage(before));
}
export function persistUsageSelectionBoundary(target) {
  target = structuredClone(target);
  return commitUsage(before => applyUsageSelectionBoundary(before, target));
}

function coverageMigration(session) {
  if (session.usageCoverageVersion === 2) return {
    tokenCoverage: { ...(session.tokenCoverage || {}) },
    reportedRequests: Number(session.reportedRequests) || 0,
    incompleteRequests: Number(session.incompleteRequests) || 0,
    providerCostUsd: decimal(session.providerCostUsd),
    costReportedRequests: Number(session.costReportedRequests) || 0,
  };
  const deltas = Array.isArray(session.deltas) ? session.deltas : [];
  const recorded = deltas.reduce((n,d) => n + (d.requests || 1),0);
  const fullHistory = recorded === session.requests;
  const reported = fullHistory ? deltas.filter(usageIsComplete).reduce((n,d) => n+(d.requests || 1),0) : 0;
  return { usageCoverageVersion: 2, reportedRequests: reported,
    incompleteRequests: Math.max(0, (session.requests || 0)-reported),
    tokenCoverage: fullHistory ? Object.fromEntries(TOKEN_FIELDS.map(k => [k,deltas.filter(d => token(d[k]) != null).reduce((n,d) => n+(d.requests || 1),0)])) : {},
    providerCostUsd: null, costReportedRequests: 0 };
}
function usageDisplay(session) {
  const s = session || {};
  return { ...Object.fromEntries(TOKEN_FIELDS.slice(3).map(k => [k, token(s[k])])),
    reportedRequests: s.reportedRequests || 0, incompleteRequests: s.incompleteRequests || 0,
    tokenCoverage: { ...(s.tokenCoverage || {}) }, providerCostUsd: decimal(s.providerCostUsd),
    costReportedRequests: s.costReportedRequests || 0, accountingScope: "translation_usage_not_customer_balance" };
}
async function usageStorageLock(fn) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request("textphantom-ai-usage-v2", fn);
  return fn(); // Non-browser test runtime. Browser UI is NOT the billing authority.
}
