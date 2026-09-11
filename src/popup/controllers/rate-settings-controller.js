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
    els.ratePresetHint.textContent = `${prefix}: ${value.rpm}/min, burst ${value.burst}${note}.${warning}`;
    els.ratePresetHint.dataset.warn = warning ? "1" : "";
  };

  const saveNumber = async (element, key, min, max) => {
    if (!element) return;
    const raw = String(element.value || "").trim();
    const parsed = Number(raw);
    let value = raw && Number.isFinite(parsed) ? Math.floor(parsed) : 0;
    if (value > 0) value = Math.min(max, Math.max(min, value));
    element.value = value > 0 ? String(value) : "";
    await persist({ [key]: value });
    const rpm = Number(els.rateRpm?.value || 0);
    const burst = Number(els.rateBurst?.value || 0);
    if (rpm > 0 && burst > rpm && els.rateBurst) {
      els.rateBurst.value = String(rpm);
      await persist({ rateBurst: rpm });
    }
    renderHint();
  };

  const bind = () => {
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
        await persist({ rateLimitEnabled: checked });
      }
      renderHint();
      toggleUi();
    });
    els.rateProfile?.addEventListener("change", async () => {
      const profile = els.rateProfile.value;
      const preset = providerPreset() || fallback;
      const factor = { stable: 0.5, balanced: 1, fast: 1.5 }[profile];
      const rateRpm = factor ? Math.max(1, Math.round(preset.rpm * factor)) : 0;
      const rateBurst = factor
        ? Math.max(1, Math.round(preset.burst * factor))
        : 0;
      if (profile !== "custom") {
        if (els.rateRpm) els.rateRpm.value = "";
        if (els.rateBurst) els.rateBurst.value = "";
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

  return { bind, renderHint };
}
