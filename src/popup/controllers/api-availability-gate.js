const DEFAULT_FAILURES_TO_BLOCK = 2;
const DEFAULT_RECOVERY_POLL_MS = 5000;
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 60000;

/**
 * Popup-only front gate for features which require the TextPhantom API.
 * Local-AI connectivity is deliberately outside this state machine: even the
 * direct-local route still needs the API for Lens/grouping, but a failed Local
 * Connect probe must never mark the API offline.
 */
export function createApiAvailabilityGate({
  els,
  checkApi,
  failuresToBlock = DEFAULT_FAILURES_TO_BLOCK,
  recoveryPollMs = DEFAULT_RECOVERY_POLL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  now = Date.now,
  snapshotMaxAgeMs = DEFAULT_SNAPSHOT_MAX_AGE_MS,
}) {
  let state = "unknown";
  let consecutiveFailures = 0;
  let recoveryTimer = null;
  const disabledBeforeGate = new Map();

  const gatedControls = () => [els.translatePanel, els.aiPanel]
    .filter(Boolean)
    .flatMap((panel) => [...panel.querySelectorAll("button, input, select, textarea")])
    .filter((control) => control !== els.apiGateTranslateOpen && control !== els.apiGateAiOpen);

  const render = () => {
    const blocked = state === "offline";
    for (const banner of [els.apiGateTranslate, els.apiGateAi].filter(Boolean)) {
      banner.hidden = !blocked;
      banner.setAttribute?.("aria-hidden", String(!blocked));
    }
    for (const control of gatedControls()) {
      if (blocked) {
        if (!disabledBeforeGate.has(control))
          disabledBeforeGate.set(control, Boolean(control.disabled));
        control.disabled = true;
        control.setAttribute?.("data-api-offline", "true");
      } else if (disabledBeforeGate.has(control)) {
        control.disabled = disabledBeforeGate.get(control);
        disabledBeforeGate.delete(control);
        control.removeAttribute?.("data-api-offline");
      }
    }
  };

  const stopRecovery = () => {
    if (recoveryTimer !== null) clearIntervalFn(recoveryTimer);
    recoveryTimer = null;
  };

  const startRecovery = () => {
    if (recoveryTimer !== null) return;
    recoveryTimer = setIntervalFn(() => void checkApi(), recoveryPollMs);
  };

  const success = () => {
    consecutiveFailures = 0;
    state = "online";
    stopRecovery();
    render();
  };

  const failure = ({ definitive = false } = {}) => {
    consecutiveFailures += 1;
    // Browser-offline is definitive. Network/health failures require two
    // consecutive observations so one startup timeout cannot lock the UI.
    if (definitive || consecutiveFailures >= failuresToBlock) {
      state = "offline";
      render();
      startRecovery();
    } else if (state !== "online") {
      state = "suspect";
    }
  };

  const acceptSnapshot = (snapshot, expectedUrl, normalizeUrl = (x) => x) => {
    const expected = normalizeUrl(expectedUrl);
    if (!expected || normalizeUrl(snapshot?.base) !== expected) return false;
    if (snapshot?.ok === true && snapshot?.fresh === true) {
      success();
      return true;
    }
    // A recent negative background result is evidence, but intentionally only
    // the first failure; the live probe provides hysteresis confirmation.
    const snapshotAge = now() - Number(snapshot?.ts || 0);
    if (
      snapshot?.ok === false &&
      Number(snapshot?.ts) > 0 &&
      snapshotAge >= 0 &&
      snapshotAge <= snapshotMaxAgeMs
    ) failure();
    return false;
  };

  const openApiSettings = () => els.tabTools?.click?.();
  els.apiGateTranslateOpen?.addEventListener?.("click", openApiSettings);
  els.apiGateAiOpen?.addEventListener?.("click", openApiSettings);

  return {
    success,
    failure,
    acceptSnapshot,
    apply: render,
    dispose: stopRecovery,
    snapshot: () => ({ state, consecutiveFailures, recoveryPolling: recoveryTimer !== null }),
  };
}
