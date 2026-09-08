(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const id = "textphantom_overlay_css";
  const hardening =
    ".tp-ol-root{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;transform-origin:0 0!important;}" +
    ".tp-ol-scope{position:absolute!important;left:0!important;top:0!important;pointer-events:none!important;display:block!important;opacity:1!important;visibility:visible!important;overflow:visible!important;}" +
    ".tp-ol-scope *{box-sizing:border-box!important;pointer-events:none!important;}" +
    ".tp-ol-container{position:relative!important;display:inline-block!important;line-height:0!important;overflow:visible!important;}";

  TP.ensureOverlayStyle = (cssText = "") => {
    let element = document.getElementById(id);
    if (!element) {
      element = document.createElement("style");
      element.id = id;
      element.type = "text/css";
      document.head.appendChild(element);
    }
    const css = String(cssText || "").trim();
    if (css && !element.textContent.includes(css))
      element.appendChild(document.createTextNode(`\n${css}\n`));
    if (!element.textContent.includes(hardening))
      element.appendChild(document.createTextNode(hardening));
  };
})();
