export const OVERLAY_CSS = [
  ".tp-draw-root{position:absolute;inset:0;pointer-events:none;}",
  ".tp-draw-scope{position:absolute;inset:0;width:100%;height:100%;transform-origin:0 0;}",
  ".tp-src,.tp-src.notranslate{display:contents;}",
  ".tp-gtext{opacity:0;}",
  "html.translated-ltr .tp-src,html.translated-rtl .tp-src{visibility:hidden;}",
  "html.translated-ltr .tp-gtext,html.translated-rtl .tp-gtext{opacity:1;}",
  ".tp-line{position:absolute;display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:visible;box-sizing:border-box;transform-origin:center center;pointer-events:none;user-select:none;padding:0 .15em;" +
    'font-family:"Noto Sans CJK JP","Noto Sans CJK SC","Noto Sans CJK TC","Noto Sans CJK KR","Noto Sans JP","Noto Sans SC","Noto Sans TC","Noto Sans KR","Noto Sans Thai","Noto Sans Thai UI","Noto Sans Arabic","Noto Sans Hebrew","Noto Sans Devanagari","Noto Sans Bengali","Noto Sans Tamil","Noto Sans Telugu","Noto Sans Khmer","Noto Sans Lao","Noto Sans Myanmar","Noto Sans Georgian","Noto Sans Armenian","Noto Sans Ethiopic","Noto Sans","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Microsoft YaHei","Microsoft JhengHei","Malgun Gothic","Apple SD Gothic Neo","PingFang SC","PingFang TC",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;' +
    "font-weight:600;font-style:normal;letter-spacing:0;color:var(--tp-ink,rgba(15,15,15,.98));text-shadow:var(--tp-halo,0 0 2px rgba(255,255,255,.95),0 0 2px rgba(255,255,255,.95),0 0 3px rgba(255,255,255,.85),0 1px 1px rgba(0,0,0,.35));text-rendering:geometricPrecision;}",
  ".tp-on-dark{--tp-ink:rgba(248,248,248,.98);--tp-halo:0 0 2px rgba(0,0,0,.95),0 0 2px rgba(0,0,0,.95),0 0 3px rgba(0,0,0,.85),0 1px 1px rgba(255,255,255,.25);}",
  ".tp-line.vert{writing-mode:vertical-rl;text-orientation:upright;white-space:normal;padding:.15em 0;letter-spacing:0;}",
  ".tp-line.tp-bubble{white-space:normal;word-break:break-word;overflow-wrap:anywhere;text-align:center;padding:.2em .1em;}",
  ".tp-line.rtl{direction:rtl;unicode-bidi:isolate;}",
].join("");
