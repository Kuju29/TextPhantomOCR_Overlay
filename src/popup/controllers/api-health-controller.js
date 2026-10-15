import { createRecoveryBackoff } from "../../shared/retry-backoff.js";
import { configureDiagnosticsFromMeta, recordDiagnostic } from "../../shared/diagnostics.js";
import { canonicalSourceNames } from "../../shared/constants.js";
import { createApiDisplayCache } from './api-display-cache.js';
export function createApiHealthController({
  els,
  state,
  normalizeUrl,
  checkHealthOnce,
  fetchJson,
  paths,
  timeout,
  retryDelays,
  setStatus,
  setSelectOptions,
  orderLanguages,
  languages,
  sources,
  pinnedLanguages,
  persist,
  toggleUi,
  availabilityGate = null,
  paidAvailability = null,
  metaRetryDelayMs = 5000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  displayCache = createApiDisplayCache(),
}) {
  const inFlight = new Map();
  let metaSeq = 0;
  let disposed = false, metaRetryBase = '';
  // Metadata retries back off 5, 15, 30, then every 60 s (and retry at once
  // on the browser 'online' event) instead of every 5 s while the popup is open.
  const metaRecovery = createRecoveryBackoff({
    run: () => {
      const baseUrl = metaRetryBase;
      if (disposed || normalizeUrl(els.apiUrl.value) !== baseUrl) return;
      if (state.lastApiOk) void refreshMeta(baseUrl);
      else void check(baseUrl);
    },
    delays: [metaRetryDelayMs, metaRetryDelayMs * 3, metaRetryDelayMs * 6, metaRetryDelayMs * 12],
    setTimeoutFn, clearTimeoutFn,
  });
  const metaInFlight = new Map();
  let displayBase = '', displayOnline = null, displayRevision = 0;
  const matches = base => !disposed && normalizeUrl(els.apiUrl.value) === base;
  const restoreDisplay = async url => {
    const expected = displayRevision, healthSequence = state.healthSeq;
    const base = normalizeUrl(url), record = await displayCache.restore(base);
    if (!record || !matches(base) || expected !== displayRevision || healthSequence !== state.healthSeq) return false;
    displayBase = base; displayOnline = true;
    setStatus('ok', 'Online (previous check; updating)');
    return true;
  };
  const forgetDisplay = base => {
    const revision = ++displayRevision;
    displayBase = base; displayOnline = false;
    void displayCache.clear(base, () => revision === displayRevision && matches(base));
  };
  const stopMetaRetry = () => metaRecovery.cancel();
  const scheduleMetaRetry = (baseUrl) => {
    stopMetaRetry();
    if (disposed) return;
    if (baseUrl !== metaRetryBase) { metaRecovery.succeeded(); metaRetryBase = baseUrl; }
    metaRecovery.failed();
  };
  const invalidateMeta = () => {
    ++metaSeq;
    stopMetaRetry();
    state.metaCache = null;
    // Unknown/offline is not evidence that this API removed Paid.
    paidAvailability?.(null, normalizeUrl(els.apiUrl.value));
    recordDiagnostic("api.metadata.invalidated",{reason:"UNKNOWN_NOT_DISABLED"},normalizeUrl(els.apiUrl.value));
  };

  const scheduleRetry = (url, attempt) => {
    clearTimeout(state.retryTimer);
    if (attempt >= retryDelays.length) return;
    state.retryTimer = setTimeout(() => {
      if (normalizeUrl(els.apiUrl.value) === url) void check(url, attempt + 1);
    }, retryDelays[attempt]);
  };

  const refreshMeta = async (baseUrl) => {
    baseUrl = normalizeUrl(baseUrl);
    if (!baseUrl || disposed || normalizeUrl(els.apiUrl.value) !== baseUrl) return;
    const existing = metaInFlight.get(baseUrl);
    if (existing?.sequence === metaSeq) return existing.promise;
    stopMetaRetry();
    const sequence = ++metaSeq;
    const current = () => sequence === metaSeq && state.lastApiOk === true &&
      normalizeUrl(els.apiUrl.value) === baseUrl;
    const unavailable = () => {
      paidAvailability?.(null, baseUrl, {reason:'metadata_unavailable'});
      setStatus('error', 'API reachable, but service details could not be refreshed. Retrying automatically.');
      scheduleMetaRetry(baseUrl);
    };
    const promise = (async () => {
    try {
      const data = await fetchJson(`${baseUrl}${paths.META}`, null, timeout);
      if (!current()) return;
      if (data?.ok !== true) { unavailable(); return; }
      state.metaCache = data;
      metaRecovery.succeeded();
      configureDiagnosticsFromMeta(baseUrl, data);
      recordDiagnostic("api.metadata", {available:true,configured:!!data.paid?.configured,enabled:data.diagnostics?.log_file}, baseUrl);
      paidAvailability?.(data.paid?.configured === true || data.paid?.available === true, baseUrl);
      setStatus('ok', 'Online');
      const availableLanguages =
        Array.isArray(data.languages) && data.languages.length
          ? data.languages
          : languages;
      const availableSources =
        Array.isArray(data.sources) && data.sources.length
          ? data.sources
          : sources;
      setSelectOptions(
        els.lang,
        orderLanguages(availableLanguages, pinnedLanguages),
        {
          valueKey: "code",
          labelKey: "name",
          keepValue: state.desiredLang,
        },
      );
      setSelectOptions(els.sources, canonicalSourceNames(availableSources), {
        valueKey: "id",
        labelKey: "name",
        keepValue: state.desiredSources,
      });
      const patch = {};
      if (els.lang.value && els.lang.value !== state.desiredLang) {
        state.desiredLang = els.lang.value;
        patch.lang = state.desiredLang;
      }
      if (els.sources.value && els.sources.value !== state.desiredSources) {
        state.desiredSources = els.sources.value;
        patch.sources = state.desiredSources;
      }
      if (Object.keys(patch).length) await persist(patch);
      if (!current()) return;
      toggleUi();
    } catch {
      if (current()) unavailable();
    } finally {
      if (metaInFlight.get(baseUrl)?.sequence === sequence) metaInFlight.delete(baseUrl);
    }
    })();
    metaInFlight.set(baseUrl, { sequence, promise });
    return promise;
  };

  const check = async (url, attempt = 0) => {
    const cleaned = normalizeUrl(url);
    if (disposed) return;
    if (!cleaned) { invalidateMeta(); return; }
    const sequence = ++state.healthSeq;
    const current = () => sequence === state.healthSeq && matches(cleaned);
    // A fresh positive snapshot remains visible while verification happens;
    // do not make a healthy API appear to flap merely because the popup opened.
    if (!state.lastApiOk && (displayBase !== cleaned || displayOnline === null))
      setStatus(
        "loading",
        state.userInteractedApi ? "Checking API..." : "Waiting…",
      );
    try {
      let request = inFlight.get(cleaned);
      if (!request) {
        request = Promise.resolve(checkHealthOnce(cleaned)).finally(() => {
          if (inFlight.get(cleaned) === request) inFlight.delete(cleaned);
        });
        inFlight.set(cleaned, request);
      }
      const healthy = await request;
      if (!current()) return;
      state.lastApiOk = healthy;
      if (healthy) {
        const revision = ++displayRevision;
        displayBase = cleaned; displayOnline = true;
        void displayCache.remember(cleaned, Date.now(), () => current() && revision === displayRevision);
        availabilityGate?.success();
        toggleUi();
        clearTimeout(state.retryTimer);
        setStatus("ok", "Online");
        await refreshMeta(cleaned);
      } else {
        forgetDisplay(cleaned);
        invalidateMeta();
        availabilityGate?.failure();
        setStatus(
          "error",
          "Offline",
        );
        scheduleRetry(cleaned, attempt);
      }
    } catch (error) {
      if (!current()) return;
      state.lastApiOk = false;
      forgetDisplay(cleaned);
      invalidateMeta();
      availabilityGate?.failure();
      const message =
        error?.name === "AbortError"
          ? "Timed out"
          : error?.message || "Offline";
      setStatus(
        "error",
        message,
      );
      scheduleRetry(cleaned, attempt);
    }
  };

  const acceptSnapshot = (snapshot, expectedUrl) => {
    const cleaned = normalizeUrl(expectedUrl);
    if (!cleaned || disposed || normalizeUrl(els.apiUrl.value) !== cleaned) return false;
    const acceptedByGate = availabilityGate?.acceptSnapshot(
      snapshot,
      cleaned,
      normalizeUrl,
    );
    if (snapshot?.ok === false && snapshot?.fresh === true && normalizeUrl(snapshot.base) === cleaned) {
      state.lastApiOk = false;
      forgetDisplay(cleaned);
      setStatus('error', 'Offline (latest check)');
      return false;
    }
    if (
      snapshot?.ok !== true ||
      snapshot?.fresh !== true ||
      normalizeUrl(snapshot.base) !== cleaned
    ) return false;
    state.lastApiOk = true;
    const revision = ++displayRevision;
    displayBase = cleaned; displayOnline = true;
    void displayCache.remember(cleaned, Date.now(), () => matches(cleaned) && revision === displayRevision);
    setStatus("ok", "Online (recent check)");
    if (acceptedByGate === false) return false;
    // /health cache proves reachability only. Every new popup must discover
    // Paid and other capabilities even when it can reuse a healthy snapshot.
    void refreshMeta(cleaned);
    return true;
  };

  const markBrowserOffline = () => {
    const base = normalizeUrl(els.apiUrl.value);
    ++state.healthSeq;
    state.lastApiOk = false; forgetDisplay(base);
    setStatus('error', 'Browser offline');
    invalidateMeta(); availabilityGate?.failure({ definitive: true });
  };

  const dispose = () => {
    disposed = true; ++metaSeq; ++state.healthSeq;
    metaRecovery.dispose(); clearTimeout(state.retryTimer);
  };
  return { check, refreshMeta, acceptSnapshot, restoreDisplay, markBrowserOffline, invalidateMeta, dispose };
}
