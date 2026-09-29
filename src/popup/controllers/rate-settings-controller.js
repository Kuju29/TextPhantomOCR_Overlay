export function createRateSettingsController({
  els,
  constants,
  persist,
  toggleUi,
}) {
  const { presets, fallback, rpmMin, rpmMax, burstMin, burstMax } = constants;

  const providerPreset = () =>
    presets[
      String(els.aiProvider?.value || "")
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
    els.ratePresetHint.textContent = `${prefix}: ${value.rpm}/min, burst ${value.burst}${note}.${warning}` +
      (capInvalid ? " Manual cap incomplete: enter RPM and burst or turn the cap off before translating." :
        incomplete ? " Manual cap off: enter RPM and burst, then turn it on." : "");
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
    await persist({ [key]: value, ...(incomplete ? { rateLimitEnabled: false } : {}) });
    const rpm = Number(els.rateRpm?.value || 0);
    const burst = Number(els.rateBurst?.value || 0);
    if (rpm > 0 && burst > rpm && els.rateBurst) {
      els.rateBurst.value = String(rpm);
      await persist({ rateBurst: rpm });
    }
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

  return { bind, renderHint, renderLocalHint };
}
