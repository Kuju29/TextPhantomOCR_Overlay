(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const scopes = new Set();
  let scale = 1;

  function clamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? Math.min(2, Math.max(0.5, number))
      : 1;
  }

  function apply() {
    for (const scope of scopes) {
      if (!scope?.isConnected) scopes.delete(scope);
      else scope.style.setProperty("--tp-font-scale", String(scale));
    }
    try {
      TP.mdApplyFontScaleAll?.(scale);
    } catch {}
  }

  function set(value) {
    scale = clamp(value);
    apply();
  }

  TP.overlayFontScale = {
    register(scope) {
      if (!scope) return;
      scopes.add(scope);
      scope.style.setProperty("--tp-font-scale", String(scale));
    },
    unregister(scope) {
      scopes.delete(scope);
    },
  };

  try {
    chrome.storage.local.get("fontScale", (items) =>
      set(items?.fontScale ?? 1),
    );
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes?.fontScale)
        set(changes.fontScale.newValue);
    });
    chrome.runtime.onMessage?.addListener((message) => {
      if (message?.type === "FONT_SCALE_CHANGED") set(message.fontScale);
    });
  } catch {
    set(1);
  }
})();
