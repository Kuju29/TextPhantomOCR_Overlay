import { createUsageCommitQueue } from "./ai/usage-commit-queue.js";
import { getStorage, removeStorage, setStorage } from "./storage.js";
import { TOKEN_FIELDS, token, decimal, addDecimal, aggregateUsage, usageIsComplete } from "./ai/usage-values.js";
import { priceGeneration } from "./ai/pricing/calculate.js";
import { routeRateKey } from "./ai/pricing/providers.js";
import { money, sumMoney, lessMoney } from "./ai/pricing/money.js";
import { bangkokDate, convertThb } from "./ai/pricing/fx.js";

export const AI_USAGE_STORAGE_KEY = "aiUsageV1";
export const AI_USAGE_RECEIPT_PREFIX = "aiUsageReceiptV1:";
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
  days: {},
  dailyInitialized: true,
  pricing: { overrides: {}, liveRates: {}, fx: null },
});
const nullableToken = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const compactStoredRecord = (value) => Object.fromEntries(
  Object.entries(value || {}).filter(([, item]) => item !== null && item !== ""),
);

// One selection rule for the ledger writer and its diagnostic reader.
function generationSelection(event) {
  const runtime = event?.runtime === "local" ? "local" : "cloud";
  const provider = String(event?.provider || "unknown").trim() || "unknown";
  const resolvedModel = String(event?.model || "unknown").trim() || "unknown";
  const requestedModel = String(event?.requestedModel || "").trim();
  const modelName = requestedModel && requestedModel.toLowerCase() !== "auto" ? requestedModel : resolvedModel;
  return { runtime, provider, resolvedModel, requestedModel, modelName };
}

// Normalize documented provider envelopes only; never estimate missing token counts.
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
              .slice(-AI_USAGE_DELTA_LIMIT).map((d) => compactStoredRecord(d))
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
  const seen = raw.seen && typeof raw.seen === "object" ? { ...raw.seen } : {};
  // Retained deltas already provide exact replay/enrichment evidence. Keeping
  // the same long dedupe identity in `seen` duplicated every active receipt
  // and made each chrome.storage write grow much faster than the visible
  // history. `seen` is only the overflow index for deltas/sessions no longer
  // retained in the ledger.
  for (const model of Object.values(models))
    for (const session of model.sessions)
      for (const delta of session.deltas || [])
        if (delta?.dedupeKey) delete seen[delta.dedupeKey];
  const days = raw.days && typeof raw.days === "object" && !Array.isArray(raw.days)
    ? Object.fromEntries(Object.entries(raw.days).filter(([date, day]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && day && typeof day === "object").sort(([a],[b]) => a.localeCompare(b)).slice(-400)) : {};
  const pricing = raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {};
  const normalized = { version: AI_USAGE_VERSION, active, selection, models,
    pending: { ...(raw.pending || {}) }, pendingOverflow: Number(raw.pendingOverflow) || 0,
    seen, days, dailyInitialized: true,
    pricing: { overrides: { ...(pricing.overrides || {}) },
      liveRates: Object.fromEntries(Object.entries(pricing.liveRates || {}).slice(-128)),
      fx: pricing.fx || null } };
  if (raw.dailyInitialized !== true) {
    // Upgrade older ledgers from retained individual observations only. Old
    // evicted requests cannot be reconstructed and are explicitly marked.
    for (const model of Object.values(models)) for (const session of model.sessions)
      for (const delta of session.deltas || []) applyDay(normalized, delta, 1, true);
  }
  return normalized;
}

function applyDay(ledger, delta, direction = 1, migrated = false) {
  const date = bangkokDate(delta.timestamp || Date.now());
  const day = (ledger.days[date] ||= { date, requests:0, failures:0, incompleteRequests:0,
    inputTokens:0, outputTokens:0, totalTokens:0, cachedInputTokens:0,
    tokenCoverage:{}, pricedRequests:0, unpricedRequests:0, cacheUnknownRequests:0,
    reportedUsd:"0", estimatedUsd:"0", usd:"0", thb:"0", thbCoveredRequests:0, migratedPartial:false });
  const requests = delta.requests || 1;
  day.requests += direction * requests;
  day.failures += direction * (delta.failures || 0);
  if (["upper_bound_cache_unreported", "estimated_posthoc_cache_unknown"].includes(delta.price?.status))
    day.cacheUnknownRequests = (day.cacheUnknownRequests || 0) + direction * requests;
  if (!usageIsComplete(delta)) day.incompleteRequests += direction * requests;
  for (const field of TOKEN_FIELDS) if (token(delta[field]) !== null) {
    day[field] = (day[field] || 0) + direction * delta[field];
    day.tokenCoverage[field] = (day.tokenCoverage[field] || 0) + direction * requests;
  }
  const usd = money(delta.price?.usd);
  if (usd === null) day.unpricedRequests += direction * requests;
  else {
    day.pricedRequests += direction * requests;
    const bucket = delta.price.source === "provider" ? "reportedUsd" : "estimatedUsd";
    day[bucket] = direction > 0 ? sumMoney(day[bucket], usd) : lessMoney(day[bucket], usd);
    day.usd = direction > 0 ? sumMoney(day.usd, usd) : lessMoney(day.usd, usd);
    const thb = money(delta.price?.thb);
    if (thb !== null) {
      day.thb = direction > 0 ? sumMoney(day.thb, thb) : lessMoney(day.thb, thb);
      day.thbCoveredRequests += direction * requests;
    }
  }
  if (migrated) day.migratedPartial = true;
  const keys = Object.keys(ledger.days).sort();
  for (const stale of keys.slice(0, Math.max(0, keys.length - 400))) delete ledger.days[stale];
}

function applySessionPrice(session, delta, direction) {
  const totals = (session.priceTotals ||= { usd:"0", reportedUsd:"0", estimatedUsd:"0", thb:"0", thbCoveredRequests:0, pricedRequests:0, unpricedRequests:0 });
  const usd = money(delta.price?.usd), requests = delta.requests || 1;
  if (usd === null) totals.unpricedRequests += direction * requests;
  else {
    totals.pricedRequests += direction * requests;
    const bucket = delta.price.source === "provider" ? "reportedUsd" : "estimatedUsd";
    totals[bucket] = direction > 0 ? sumMoney(totals[bucket], usd) : lessMoney(totals[bucket], usd);
    totals.usd = direction > 0 ? sumMoney(totals.usd, usd) : lessMoney(totals.usd, usd);
    const thb = money(delta.price?.thb);
    if (thb !== null) {
      totals.thb = direction > 0 ? sumMoney(totals.thb, thb) : lessMoney(totals.thb, thb);
      totals.thbCoveredRequests = (totals.thbCoveredRequests || 0) + direction * requests;
    }
  }
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
  priceTotals: { usd:"0", reportedUsd:"0", estimatedUsd:"0", thb:"0", thbCoveredRequests:0, pricedRequests:0, unpricedRequests:0 },
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

const rememberEvictedDedupe = (ledger, key, now) => {
  // This is an already constructed key, not a raw identity. Its provider/model
  // prefix may make it longer than cleanId's limit. Preserve exactly what the
  // retained delta used so replay lookup still works after history rolls over.
  const value = String(key || "").trim();
  if (value) ledger.seen[value] = now;
};
const capSeenDedupe = (ledger) => {
  const entries = Object.entries(ledger.seen);
  if (entries.length > 8192)
    ledger.seen = Object.fromEntries(
      entries.sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8192),
    );
};
const rememberEvictedSessions = (ledger, sessions, now) => {
  for (const session of sessions || [])
    for (const delta of session?.deltas || [])
      rememberEvictedDedupe(ledger, delta?.dedupeKey, now);
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
    const hasAggregateFailures = Number.isInteger(event.failures) || event.success === false;
    const failedGenerations = Math.max(0, Math.min(generationUsages.length,
      Number.isInteger(event.failures) ? event.failures : event.success === false ? generationUsages.length : 0));
    return generationUsages.reduce((value, usage, generationOrdinal) => recordProviderGeneration(value,
      { ...event, ...usage, ...Object.fromEntries(TOKEN_FIELDS.map(k => [k, token(usage?.[k])])),
        providerCostUsd: decimal(usage?.providerCostUsd), usageStatus: usage?.usageStatus || (usageIsComplete(usage) ? "reported" : "incomplete"),
        usage, generationUsage: null, requests: 1, generationOrdinal,
        // Preserve the aggregate failure count when splitting a charged event.
        // Prior completed batches precede the failed tail in accumulated usage.
        generationAttempts: 1, failures: hasAggregateFailures
          ? (generationOrdinal >= generationUsages.length - failedGenerations ? 1 : 0)
          : undefined }, { now, id }), ledger);
  }
  event = { ...(event?.usage || {}), ...event };
  const { runtime, provider, resolvedModel, requestedModel, modelName } = generationSelection(event);
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
          // An arriving final usage or charge may enrich an earlier incomplete
          // receipt. Replace exactly one old contribution in both aggregates.
          if (changed) {
            const previousCopy = { ...previous };
            const newPrice = priceGeneration({ ...next, runtime: next.runtime,
              provider: next.provider, resolvedModel: next.resolvedModel || next.model }, ledger.pricing);
            if (newPrice.source === "provider" || money(previous.price?.usd) === null) {
              next.price = newPrice;
              if (ledger.pricing?.fx?.rate) {
                next.price.fx = ledger.pricing.fx;
                next.price.thb = convertThb(next.price.usd, ledger.pricing.fx);
              }
            }
            applyDay(ledger, previousCopy, -1);
            applySessionPrice(saved, previousCopy, -1);
            applyDay(ledger, next);
            applySessionPrice(saved, next, 1);
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
    if (model.sessions.length > AI_USAGE_SESSION_LIMIT) {
      const evicted = model.sessions.splice(
        0,
        model.sessions.length - AI_USAGE_SESSION_LIMIT,
      );
      rememberEvictedSessions(ledger, evicted, now);
      capSeenDedupe(ledger);
    }
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
  const delta = compactStoredRecord({
    id: cleanId(event?.deltaId) || id(),
    dedupeKey,
    sessionId: session.id,
    traceId: cleanId(event?.traceId),
    requestId: cleanId(event?.requestId),
    operationId: cleanId(event?.operationId),
    jobId: cleanId(event?.jobId),
    batchId: cleanId(event?.batchId),
    provider,
    model: modelName,
    resolvedModel,
    runtime,
    engine,
    ...Object.fromEntries(TOKEN_FIELDS.map(k => [k, token(event?.[k])])),
    usageStatus: event?.usageStatus || (complete ? "reported" : "incomplete"),
    providerCostUsd: decimal(event?.providerCostUsd),
    upstreamProvider: String(event?.upstreamProvider || "").slice(0, 80),
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
    timestamp: Number.isFinite(Number(event?.observedAt)) && Number(event.observedAt) > 0
      ? Number(event.observedAt) : now,
    imageCount: Number.isSafeInteger(event?.imageCount) ? Math.max(0, event.imageCount) : null,
    pageNumbers: Array.isArray(event?.pageNumbers) ? event.pageNumbers.filter(v => Number.isSafeInteger(v) && v >= 0).slice(0, 60) : null,
  });
  delta.price = priceGeneration(delta, ledger.pricing);
  if (ledger.pricing?.fx?.rate) {
    delta.price.fx = ledger.pricing.fx;
    delta.price.thb = convertThb(delta.price.usd, ledger.pricing.fx);
  }
  session.deltas.push(delta);
  applyDay(ledger, delta);
  applySessionPrice(session, delta, 1);
  if (session.deltas.length > AI_USAGE_DELTA_LIMIT) {
    const evicted = session.deltas.splice(
      0,
      session.deltas.length - AI_USAGE_DELTA_LIMIT,
    );
    for (const delta of evicted)
      rememberEvictedDedupe(ledger, delta?.dedupeKey, now);
  }
  // The retained delta is the canonical lookup/enrichment record. `seen` only
  // tracks identities that have fallen out of retained history.
  if (dedupeKey) delete ledger.seen[dedupeKey];
  capSeenDedupe(ledger);
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
  const evicted = model.sessions.splice(0, Math.max(0, model.sessions.length - AI_USAGE_SESSION_LIMIT));
  rememberEvictedSessions(ledger, evicted, now);
  capSeenDedupe(ledger);
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
        priceTotals: session.priceTotals || null,
      })),
    )
    .sort((left, right) => right.startedAt - left.startedAt);
}

// The public History rows remain counters only. The opt-in request view exposes
// a small allowlist for Detailed and for expandable History, without trace IDs,
// URLs, source text, operation IDs or receipt IDs.
export function usageDetailedRows(raw) {
  const ledger = normalizeUsageLedger(raw);
  const visible = usageHistoryRows(ledger);
  const groupToken = value => {
    let hash = 2166136261;
    for (const char of String(value || "")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return String(hash >>> 0);
  };
  return visible.map(row => {
    const session = ledger.models[row.selectionKey]?.sessions.find(s => s.id === row.id);
    return { ...row, deltas: [...(session?.deltas || [])].reverse().map(d => ({
      timestamp: d.timestamp, failures: d.failures, requests: d.requests,
      inputTokens: d.inputTokens, cachedInputTokens: d.cachedInputTokens,
      cacheWriteInputTokens: d.cacheWriteInputTokens, outputTokens: d.outputTokens,
      thinkingTokens: d.thinkingTokens, totalTokens: d.totalTokens,
      imageCount: d.imageCount,
      groupKey: groupToken(d.jobId || d.batchId || d.operationId || d.requestId || d.id),
      price: d.price ? structuredClone(d.price) : null,
    })) };
  });
}

export function usageToday(raw, at = Date.now()) {
  const ledger = normalizeUsageLedger(raw);
  const date = bangkokDate(at);
  const day = ledger.days[date];
  return {date, ...(day || { requests:0, failures:0, incompleteRequests:0,
    inputTokens:0, outputTokens:0, totalTokens:0, cachedInputTokens:0,
    pricedRequests:0, unpricedRequests:0, cacheUnknownRequests:0,
    reportedUsd:"0", estimatedUsd:"0", usd:"0", thb:"0", thbCoveredRequests:0, tokenCoverage:{} }),
    fx: ledger.pricing?.fx || null, pendingOperations: Object.keys(ledger.pending || {}).length,
    pendingOverflow: ledger.pendingOverflow || 0 };
}

export async function persistPricingSettings(update) {
  return commitUsage(before => {
    const next = normalizeUsageLedger(before);
    const proposal = update(next.pricing);
    const priorRates = next.pricing.liveRates;
    next.pricing = { overrides: {...(proposal?.overrides || {})},
      liveRates: Object.fromEntries(Object.entries(proposal?.liveRates || {}).slice(-128)),
      fx: proposal?.fx || null };
    const newRates = Object.keys(next.pricing.liveRates).filter(key =>
      JSON.stringify(next.pricing.liveRates[key]) !== JSON.stringify(priorRates[key]));
    if (newRates.length) for (const model of Object.values(next.models)) for (const session of model.sessions) {
      if (!session.priceTotals) continue;
      for (const delta of session.deltas || []) {
        if (money(delta.price?.usd) !== null ||
          !newRates.includes(routeRateKey(model.provider,delta.resolvedModel || delta.model,delta.upstreamProvider))) continue;
        const live = next.pricing.liveRates[routeRateKey(model.provider,delta.resolvedModel || delta.model,delta.upstreamProvider)];
        if (bangkokDate(delta.timestamp) !== bangkokDate(live.fetchedAt)) continue;
        const recalculated = priceGeneration(delta,next.pricing);
        if (money(recalculated.usd) === null) continue;
        const previous = {...delta};
        delta.price = {...recalculated,source:"catalogue_after_request",status:recalculated.status === "upper_bound_cache_unreported"
          ? "estimated_posthoc_cache_unknown" : "estimated_posthoc"};
        if (next.pricing.fx?.rate) {delta.price.fx=next.pricing.fx;delta.price.thb=convertThb(delta.price.usd,next.pricing.fx);}
        applyDay(next,previous,-1);applySessionPrice(session,previous,-1);
        applyDay(next,delta);applySessionPrice(session,delta,1);
      }
    }
    return next;
  });
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
    sessionId: active?.id || null,
    startedAt: active?.startedAt || null,
    successes: active?.successes || 0,
    failures: active?.failures || 0,
    priceTotals: active?.priceTotals || null,
    requests: active?.requests || 0,
    inputTokens: active ? active.inputTokens : null,
    outputTokens: active ? active.outputTokens : null,
    totalTokens: active?.requests ? active.totalTokens : 0,
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

// Translation accounting uses a tiny durable receipt on the request path. The
// large aggregate ledger is a materialized view and is folded afterwards. A
// service-worker stop can delay the fold, but cannot lose a provider receipt.
// This keeps accounting durable without making every provider request wait for
// a read/normalize/stringify/write of the complete usage history.
const usageReceiptKeys = new Set();
const usageReceiptObservers = new Map();
let usageReceiptFlushTask = null;
let usageReceiptFlushRunning = null;
let usageReceiptFlushRequested = false;
let usageReceiptSequence = 0;
const usageReceiptClock = () => globalThis.performance?.now?.() ?? Date.now();
const usageReceiptId = () => globalThis.crypto?.randomUUID?.() ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const usageReceiptRank = event => event?.pending === true ? 0 : event?.resolvePending === true ? 2 : 1;
const usageReceiptTrace = (emitTrace, event, before, next, unchanged) => {
  if (typeof emitTrace !== "function") return;
  const observation = { ...(event?.usage || {}), ...event };
  const selection = generationSelection(observation);
  const eventKey = usageKey(selection.runtime, selection.provider, selection.modelName);
  const latest = ledger => ledger.models[eventKey]?.sessions.at(-1) || null;
  const beforeSession = latest(before);
  const afterSession = latest(next);
  emitTrace("AI usage ledger delta", {
    schema: "tp.audit/1", event: "usage_ledger",
    sessionId: afterSession?.id || "",
    traceId: cleanId(event?.traceId), requestId: cleanId(event?.requestId),
    operationId: cleanId(event?.operationId), provider: String(event?.provider || "unknown"),
    model: String(event?.model || "unknown"), runtime: event?.runtime === "local" ? "local" : "cloud",
    engine: event?.engine === "runsapi" ? "api" : "extension",
    reason: String(event?.pending === true ? "usage_pending" : event?.resolvePending === true ? "acknowledged" :
      event?.reason || (event?.success === false ? "provider_charged_failure" : "translation_success")),
    inputTokens: nullableToken(observation?.inputTokens), outputTokens: nullableToken(observation?.outputTokens),
    totalTokens: nullableToken(observation?.totalTokens),
    generationAttempts: event?.pending === true || event?.resolvePending === true ? 0 : Number(
      event?.generationAttempts || event?.requests || 1),
    replayed: Boolean(event?.replayed), idempotent: Boolean(generationIdentity(event)), deduplicated: unchanged,
    beforeRequests: Number(beforeSession?.requests || 0), afterRequests: Number(afterSession?.requests || 0),
    beforeTotalTokens: beforeSession?.totalTokens ?? null, afterTotalTokens: afterSession?.totalTokens ?? null,
  });
};

async function receiptSnapshot({ recover = false } = {}) {
  if (recover) {
    const all = await getStorage(null);
    const keys = Object.keys(all).filter(key => key.startsWith(AI_USAGE_RECEIPT_PREFIX));
    return { all, keys };
  }
  const keys = [...usageReceiptKeys];
  if (!keys.length) return { all: {}, keys };
  return { all: await getStorage([...keys, AI_USAGE_STORAGE_KEY]), keys };
}

export async function flushUsageReceiptJournal({ recover = false } = {}) {
  if (usageReceiptFlushRunning) return usageReceiptFlushRunning;
  usageReceiptFlushRunning = usageStorageLock(async () => {
    const { all, keys } = await receiptSnapshot({ recover });
    const records = keys.map(key => ({ key, value: all[key] }))
      .filter(item => item.value?.version === 1 && item.value?.event && item.value?.nonce)
      .sort((a, b) => Number(a.value.storedAt || 0) - Number(b.value.storedAt || 0) ||
        Number(a.value.sequence || 0) - Number(b.value.sequence || 0) ||
        usageReceiptRank(a.value.event) - usageReceiptRank(b.value.event) || a.key.localeCompare(b.key));
    if (!records.length) return { folded: 0, changed: false };
    const rawLedger = Object.hasOwn(all, AI_USAGE_STORAGE_KEY)
      ? all[AI_USAGE_STORAGE_KEY]
      : (await getStorage({ [AI_USAGE_STORAGE_KEY]: blankLedger() }))[AI_USAGE_STORAGE_KEY];
    let next = normalizeUsageLedger(rawLedger);
    const original = JSON.stringify(next);
    const observations = [];
    for (const record of records) {
      const before = next;
      const observer = usageReceiptObservers.get(record.value.nonce);
      const beforeEncoded = observer ? JSON.stringify(before) : null;
      next = recordProviderGeneration(next, record.value.event, {now: record.value.storedAt || Date.now()});
      const unchanged = observer ? beforeEncoded === JSON.stringify(next) : undefined;
      if (observer) observations.push({ observer, event: record.value.event, before, next, unchanged });
    }
    const changed = original !== JSON.stringify(next);
    if (changed) await setStorage({ [AI_USAGE_STORAGE_KEY]: next });
    await removeStorage(records.map(record => record.key));
    for (const record of records) {
      usageReceiptKeys.delete(record.key);
      usageReceiptObservers.delete(record.value.nonce);
    }
    for (const item of observations)
      usageReceiptTrace(item.observer.emitTrace, item.event, item.before, item.next, item.unchanged);
    return { folded: records.length, changed };
  }).finally(() => {
    usageReceiptFlushRunning = null;
    if (usageReceiptFlushRequested) scheduleUsageReceiptFlush();
  });
  return usageReceiptFlushRunning;
}

function scheduleUsageReceiptFlush() {
  usageReceiptFlushRequested = true;
  if (usageReceiptFlushTask != null || usageReceiptFlushRunning) return;
  usageReceiptFlushTask = setTimeout(() => {
    usageReceiptFlushTask = null;
    usageReceiptFlushRequested = false;
    void flushUsageReceiptJournal({ recover: true }).catch(() => {});
  }, 0);
}

async function persistUsageReceipt(event, { emitTrace = null, onTiming = null } = {}) {
  const started = usageReceiptClock();
  const immutable = structuredClone(event);
  immutable.observedAt ||= Date.now();
  const nonce = usageReceiptId();
  const key = `${AI_USAGE_RECEIPT_PREFIX}${nonce}`;
  const record = { version: 1, nonce, storedAt: Date.now(), sequence: ++usageReceiptSequence, event: immutable };
  const writeAt = usageReceiptClock();
  await setStorage({ [key]: record });
  const ended = usageReceiptClock();
  usageReceiptKeys.add(key);
  if (typeof emitTrace === "function") usageReceiptObservers.set(nonce, { emitTrace });
  try {
    onTiming?.({ lockMs: 0, readMs: 0, computeMs: Math.max(0, writeAt - started),
      writeMs: Math.max(0, ended - writeAt), batchSize: 1, queueMs: 0,
      persistMs: Math.max(0, ended - started), journaled: true });
  } catch {}
  // Initial dispatch intent stays as a compact receipt while the provider is
  // running. Terminal/uncertain events trigger a fold after this awaited
  // durable write has already completed.
  if (immutable?.pending !== true || immutable?.pendingReason === "local_transport_unconfirmed")
    scheduleUsageReceiptFlush();
  return immutable;
}

export function persistProviderGeneration(event, options = {}) {
  // Operation IDs are present on every real translation path. Keep the old
  // aggregate transaction only for compatibility callers that have no durable
  // request identity.
  const immutable = structuredClone(event);
  if (cleanId(immutable?.operationId)) return persistUsageReceipt(immutable, options);
  return commitUsage(before => recordProviderGeneration(before, immutable), {
    onTiming: options.onTiming,
    onCommit: typeof options.emitTrace === "function" ? ({ before, next, unchanged }) =>
      usageReceiptTrace(options.emitTrace, immutable, before, next, unchanged) : undefined,
  });
}
export const persistUsageEvent = persistProviderGeneration;
export async function persistUsageReset() {
  await flushUsageReceiptJournal({ recover: true });
  return commitUsage(before => resetActiveUsage(before));
}
export async function persistUsageSelectionBoundary(target) {
  await flushUsageReceiptJournal({ recover: true });
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
