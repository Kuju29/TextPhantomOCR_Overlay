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
}) {
  const inFlight = new Map();

  const scheduleRetry = (url, attempt) => {
    clearTimeout(state.retryTimer);
    if (attempt >= retryDelays.length) return;
    state.retryTimer = setTimeout(() => {
      if (normalizeUrl(els.apiUrl.value) === url) void check(url, attempt + 1);
    }, retryDelays[attempt]);
  };

  const refreshMeta = async (baseUrl) => {
    try {
      const data = await fetchJson(`${baseUrl}${paths.META}`, null, timeout);
      if (!data?.ok) return;
      state.metaCache = data;
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
      setSelectOptions(els.sources, availableSources, {
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
      toggleUi();
    } catch {}
  };

  const check = async (url, attempt = 0) => {
    const cleaned = normalizeUrl(url);
    if (!cleaned) return;
    const sequence = ++state.healthSeq;
    // A fresh positive snapshot remains visible while verification happens;
    // do not make a healthy API appear to flap merely because the popup opened.
    if (!state.lastApiOk)
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
      if (sequence !== state.healthSeq) return;
      state.lastApiOk = healthy;
      if (healthy) {
        availabilityGate?.success();
        toggleUi();
        clearTimeout(state.retryTimer);
        setStatus("ok", "Online");
        void refreshMeta(cleaned);
      } else {
        availabilityGate?.failure();
        setStatus(
          "error",
          state.userInteractedApi ? "Health failed" : "Waiting…",
        );
        scheduleRetry(cleaned, attempt);
      }
    } catch (error) {
      if (sequence !== state.healthSeq) return;
      state.lastApiOk = false;
      availabilityGate?.failure();
      const message =
        error?.name === "AbortError"
          ? "Timed out"
          : error?.message || "Offline";
      setStatus(
        state.userInteractedApi ? "error" : "loading",
        state.userInteractedApi ? message : "Waiting…",
      );
      scheduleRetry(cleaned, attempt);
    }
  };

  const acceptSnapshot = (snapshot, expectedUrl) => {
    const cleaned = normalizeUrl(expectedUrl);
    const acceptedByGate = availabilityGate?.acceptSnapshot(
      snapshot,
      cleaned,
      normalizeUrl,
    );
    if (
      snapshot?.ok !== true ||
      snapshot?.fresh !== true ||
      normalizeUrl(snapshot.base) !== cleaned
    ) return false;
    state.lastApiOk = true;
    setStatus("ok", "Online (recent check)");
    return acceptedByGate !== false;
  };

  const markBrowserOffline = () =>
    availabilityGate?.failure({ definitive: true });

  return { check, refreshMeta, acceptSnapshot, markBrowserOffline };
}
