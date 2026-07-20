/**
 * Popup tab switcher (classic script — MV3 CSP forbids inline scripts).
 *
 * Pure presentation: shows one `.panel` at a time and remembers the last
 * active tab in localStorage. All app logic stays in popup.js.
 */
(() => {
  const STORAGE_KEY = "tp.popup.tab";
  const tabs = [...document.querySelectorAll(".tabs .tab")];
  const panels = [...document.querySelectorAll(".panels .panel")];
  if (!tabs.length || !panels.length) return;

  /**
   * @param {string} name
   * @param {{focus?: boolean}} [opts]
   */
  function activate(name, { focus = false } = {}) {
    for (const tab of tabs) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const panel of panels) {
      panel.classList.toggle("active", panel.id === `panel-${name}`);
    }
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      /* private mode — fine */
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab.dataset.tab));
  }

  // Left/Right arrow keys move between tabs (standard tablist behaviour).
  document.querySelector(".tabs")?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const current = tabs.findIndex((t) => t.classList.contains("active"));
    if (current < 0) return;
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(current + delta + tabs.length) % tabs.length];
    activate(next.dataset.tab, { focus: true });
    e.preventDefault();
  });

  // Let popup.js switch tabs programmatically (e.g. when the "Ai option" tab
  // is hidden because Source is no longer AI).
  window.__tpActivateTab = activate;

  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  const known = tabs.some((t) => t.dataset.tab === saved);
  activate(known ? saved : "translate");
})();
