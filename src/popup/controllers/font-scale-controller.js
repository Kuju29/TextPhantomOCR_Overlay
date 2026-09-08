const MIN = 0.5;
const MAX = 2;
const STEP = 0.1;

export function createFontScaleController({ els, persist, broadcast }) {
  let timer = null;

  const clamp = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 1;
    return Math.min(MAX, Math.max(MIN, number));
  };

  const render = (value) => {
    const scale = clamp(value);
    const percent = Math.round(scale * 100);
    if (els.fontScaleRange) els.fontScaleRange.value = String(percent);
    if (els.fontScaleValue) els.fontScaleValue.textContent = `${percent}%`;
  };

  const save = (value) => {
    const scale = clamp(value);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await persist({ fontScale: scale });
      broadcast({ type: "FONT_SCALE_CHANGED", fontScale: scale });
    }, 150);
  };

  const changeBy = (delta) => {
    const current = els.fontScaleRange
      ? Number(els.fontScaleRange.value) / 100
      : 1;
    const next = clamp(current + delta);
    render(next);
    save(next);
  };

  const bind = () => {
    els.fontScaleRange?.addEventListener("input", (event) => {
      const scale = Number(event.target.value) / 100;
      render(scale);
      save(scale);
    });
    els.fontScaleDown?.addEventListener("click", () => changeBy(-STEP));
    els.fontScaleUp?.addEventListener("click", () => changeBy(STEP));
    els.fontScaleReset?.addEventListener("click", () => {
      render(1);
      save(1);
    });
  };

  return { bind, render };
}
