import { uiTemplate } from "../../shared/ui-template.js";

export function createRateSettingsController({
  els,
  constants,
  persist,
  toggleUi,
}) {
  const { presets, fallback, rpmMin, rpmMax, burstMin, burstMax } = constants;
  const write = persist;
  let paid = false, initialized = false, scopes = {};
  const keys = ['rateLimitEnabled', 'rateProfile', 'rateRpm', 'rateBurst'];
  const paidKey = key => 'paid' + key[0].toUpperCase() + key.slice(1);
  persist = async patch => {
    const mapped = {};
    for (const [key, value] of Object.entries(patch)) {
      if (keys.includes(key)) {
        if (initialized) scopes[paid ? 'paid' : 'manual'][key] = value;
        mapped[paid ? paidKey(key) : key] = value;
      } else mapped[key] = value;
    }
    if (paid && initialized && keys.some(k => Object.hasOwn(patch, k)))
      for (const k of keys) mapped[paidKey(k)] = scopes.paid[k];
    return write(mapped);
  };
  const setContext = (active, force = false) => {
    const changed = paid !== Boolean(active);
    paid = Boolean(active);
    if (!initialized || !changed && !force) return;
    const saved = scopes[paid ? 'paid' : 'manual'];
    if (els.rateLimitEnabled) els.rateLimitEnabled.checked = saved.rateLimitEnabled === true;
    if (els.rateProfile) els.rateProfile.value = saved.rateProfile || 'auto';
    if (els.rateRpm) els.rateRpm.value = saved.rateRpm > 0 ? String(saved.rateRpm) : '';
    if (els.rateBurst) els.rateBurst.value = saved.rateBurst > 0 ? String(saved.rateBurst) : '';
    renderHint();
  };
  const initialize = async stored => {
    const manual = {rateLimitEnabled: els.rateLimitEnabled?.checked === true,
      rateProfile: els.rateProfile?.value || 'auto', rateRpm: Number(els.rateRpm?.value || 0),
      rateBurst: Number(els.rateBurst?.value || 0)};
    // One-time compatibility seed: both modes start with the pre-upgrade cap.
    // After a Paid edit, only Paid's keys change.
    scopes = {manual, paid:Object.fromEntries(keys.map(k => [k, stored[paidKey(k)] ?? manual[k]]))};
    initialized = true;
    setContext(paid, true);
    await write(Object.fromEntries(keys.map(k => [paidKey(k), scopes.paid[k]])));
  };


  const providerPreset = () =>
    presets[
      String(els.aiService?.value === "paid" ? "paid" : els.aiProvider?.value || "")
        .trim()
        .toLowerCase()
    ] || null;

  const renderHint = () => {
    if (!els.ratePresetHint) return;
    const preset = providerPreset();
    const value = preset || fallback;
    const prefix = preset
      ? "Manual reference for this provider"
      : "Manual reference for an unlisted provider";
    const note = preset?.note ? ` — ${preset.note}` : "";
    const rpm = Number(els.rateRpm?.value || 0);
    const warning =
      rpm > 0 && rpm > value.rpm * 4
        ? ` ⚠️ ${rpm}/min is well above that. Pages may fail with 429.`
        : "";
    const incomplete = !Number(els.rateRpm?.value || 0) || !Number(els.rateBurst?.value || 0);
    const capInvalid = els.rateLimitEnabled?.checked && (incomplete || els.rateProfile?.value === "auto");
    if (els.aiService?.value === "paid") {
      els.ratePresetHint.textContent = !els.rateLimitEnabled?.checked
        ? "Optional Paid request pacing is off. Service limits still apply."
        : capInvalid
          ? "Paid request pacing is incomplete. Enter RPM and burst or turn pacing off."
          : `Paid request pacing: ${rpm}/min, burst ${Number(els.rateBurst?.value)}. Service limits still apply.`;
      if (els.rateLimitEnabled?.checked && !capInvalid &&
          typeof els.ratePresetHint.replaceChildren === "function" &&
          typeof els.ratePresetHint.ownerDocument?.createDocumentFragment === "function") {
        els.ratePresetHint.replaceChildren(uiTemplate(
          "Paid request pacing: {rpm}/min, burst {burst}. Service limits still apply.",
          { rpm, burst: Number(els.rateBurst?.value) },
        ));
      }
      els.ratePresetHint.dataset.warn = capInvalid ? "1" : "0";
      return;
    }
    const suffix = capInvalid ? " Manual cap incomplete: enter RPM and burst or turn the cap off before translating." :
      incomplete ? " Manual cap off: enter RPM and burst, then turn it on." : "";
    const doc = els.ratePresetHint.ownerDocument;
    if (typeof els.ratePresetHint.replaceChildren === "function" &&
        typeof doc?.createDocumentFragment === "function" && typeof doc.createTextNode === "function") {
      // Same copy as below, split so authored phrases translate and numbers stay protected.
      els.ratePresetHint.replaceChildren(...[
        uiTemplate(preset ? "Manual reference for this provider: {rpm}/min, burst {burst}"
          : "Manual reference for an unlisted provider: {rpm}/min, burst {burst}", { rpm: value.rpm, burst: value.burst }),
        note && " — ", note && preset.note, ".",
        warning && " ", warning && uiTemplate("⚠️ {rpm}/min is well above that. Pages may fail with 429.", { rpm }),
        suffix && " ", suffix.trim(),
      ].filter(Boolean).map((part) => typeof part === "string" ? doc.createTextNode(part) : part));
    } else els.ratePresetHint.textContent = `${prefix}: ${value.rpm}/min, burst ${value.burst}${note}.${warning}` + suffix;
    els.ratePresetHint.dataset.warn = warning ? "1" : "";
  };
  const renderLocalHint = () => {
    if (!els.aiLocalRateHint) return;
    const rpm = Number(els.aiLocalRateRpm?.value);
    const burst = Number(els.aiLocalRateBurst?.value);
    els.aiLocalRateHint.textContent = els.aiLocalRateEnabled?.checked &&
      (!Number.isInteger(rpm) || rpm < 1 || rpm > 600 ||
       !Number.isInteger(burst) || burst < 1 || burst > 60 || burst > rpm)
      ? "Manual cap incomplete: enter Local RPM and burst or turn the cap off before translating."
      : "";
  };

  const saveNumber = async (element, key, min, max) => {
    if (!element) return;
    const raw = String(element.value || "").trim();
    const parsed = Number(raw);
    let value = raw && Number.isFinite(parsed) ? Math.floor(parsed) : 0;
    if (value > 0) value = Math.min(max, Math.max(min, value));
    element.value = value > 0 ? String(value) : "";
    const incomplete = value === 0 && els.rateLimitEnabled?.checked;
    if (incomplete) els.rateLimitEnabled.checked = false;
    const patch = { [key]: value, ...(incomplete ? { rateLimitEnabled: false } : {}) };
    const rpm = Number(els.rateRpm?.value || 0);
    const burst = Number(els.rateBurst?.value || 0);
    if (rpm > 0 && burst > rpm && els.rateBurst) {
      els.rateBurst.value = String(rpm);
      patch.rateBurst = rpm;
    }
    await persist(patch);
    renderHint();
    if (incomplete) toggleUi();
  };

  const bind = () => {
    els.aiLocalRateEnabled?.addEventListener("change", async () => {
      if (els.aiLocalRateEnabled.checked) {
        const rpm = Number(els.aiLocalRateRpm?.value);
        const burst = Number(els.aiLocalRateBurst?.value);
        if (!Number.isInteger(rpm) || rpm < 1 || rpm > 600 ||
            !Number.isInteger(burst) || burst < 1 || burst > 60 || burst > rpm) {
          els.aiLocalRateEnabled.checked = false;
          renderLocalHint();
          toggleUi();
          return;
        }
      }
      await persist(els.aiLocalRateEnabled.checked
        ? { aiLocalRateLimitEnabled: true,
            aiLocalRateRpm: Number(els.aiLocalRateRpm?.value),
            aiLocalRateBurst: Number(els.aiLocalRateBurst?.value) }
        : { aiLocalRateLimitEnabled: false });
      renderLocalHint();
      toggleUi();
    });
    const saveLocal = async (element, key, min, max) => {
      if (!element) return;
      const raw = String(element.value || "").trim();
      const parsed = Number(raw);
      let value = raw && Number.isFinite(parsed) ? Math.floor(parsed) : 0;
      if (value > 0) value = Math.min(max, Math.max(min, value));
      element.value = value > 0 ? String(value) : "";
      const incomplete = value === 0 && els.aiLocalRateEnabled?.checked;
      if (incomplete) els.aiLocalRateEnabled.checked = false;
      await persist({ [key]: value, ...(incomplete ? { aiLocalRateLimitEnabled: false } : {}) });
      const rpm = Number(els.aiLocalRateRpm?.value || 0);
      if (rpm > 0 && Number(els.aiLocalRateBurst?.value || 0) > rpm) {
        els.aiLocalRateBurst.value = String(rpm);
        await persist({ aiLocalRateBurst: rpm });
      }
      if (incomplete) toggleUi();
      renderLocalHint();
    };
    els.aiLocalRateRpm?.addEventListener("change", () => saveLocal(els.aiLocalRateRpm, "aiLocalRateRpm", 1, 600));
    els.aiLocalRateBurst?.addEventListener("change", () => saveLocal(els.aiLocalRateBurst, "aiLocalRateBurst", 1, 60));
    els.rateLimitEnabled?.addEventListener("change", async () => {
      const checked = Boolean(els.rateLimitEnabled.checked);
      if (checked && els.rateProfile?.value === "auto") {
        const preset = providerPreset() || fallback;
        const rateRpm = Math.max(1, Math.round(preset.rpm));
        const rateBurst = Math.max(1, Math.min(rateRpm, Math.round(preset.burst)));
        els.rateProfile.value = "balanced";
        if (els.rateRpm) els.rateRpm.value = String(rateRpm);
        if (els.rateBurst) els.rateBurst.value = String(rateBurst);
        await persist({ rateLimitEnabled: true, rateProfile: "balanced",
          rateRpm, rateBurst });
      } else {
        if (checked && (!Number(els.rateRpm?.value) || !Number(els.rateBurst?.value))) {
          els.rateLimitEnabled.checked = false;
          renderHint();
          toggleUi();
          return;
        }
        await persist(checked
          ? { rateLimitEnabled: true, rateRpm: Number(els.rateRpm?.value),
              rateBurst: Number(els.rateBurst?.value) }
          : { rateLimitEnabled: false });
      }
      renderHint();
      toggleUi();
    });
    els.rateProfile?.addEventListener("change", async () => {
      const profile = els.rateProfile.value;
      const preset = providerPreset() || fallback;
      const factor = { stable: 0.5, balanced: 1, fast: 1.5 }[profile];
      const currentRpm = Number(els.rateRpm?.value || 0);
      const currentBurst = Number(els.rateBurst?.value || 0);
      const rateRpm = factor ? Math.max(1, Math.round(preset.rpm * factor))
        : profile === "custom" && Number.isInteger(currentRpm) ? currentRpm : 0;
      const rateBurst = factor ? Math.max(1, Math.round(preset.burst * factor))
        : profile === "custom" && Number.isInteger(currentBurst) ? currentBurst : 0;
      if (profile !== "custom") {
        if (els.rateRpm) els.rateRpm.value = profile === "auto" ? "" : String(rateRpm);
        if (els.rateBurst) els.rateBurst.value = profile === "auto" ? "" : String(rateBurst);
      }
      const providerManaged = profile === "auto";
      if (providerManaged && els.rateLimitEnabled)
        els.rateLimitEnabled.checked = false;
      await persist({ rateProfile: profile, rateRpm, rateBurst,
        ...(providerManaged ? { rateLimitEnabled: false } : {}) });
      renderHint();
      toggleUi();
    });
    els.rateRpm?.addEventListener("change", () =>
      saveNumber(els.rateRpm, "rateRpm", rpmMin, rpmMax),
    );
    els.rateBurst?.addEventListener("change", () =>
      saveNumber(els.rateBurst, "rateBurst", burstMin, burstMax),
    );
  };

  return { bind, renderHint, renderLocalHint, initialize, setContext };
}
