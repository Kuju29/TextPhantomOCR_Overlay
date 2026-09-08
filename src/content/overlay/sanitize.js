(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const blockedTags = new Set([
    "BASE",
    "BUTTON",
    "EMBED",
    "FORM",
    "IFRAME",
    "INPUT",
    "LINK",
    "META",
    "OBJECT",
    "SCRIPT",
    "STYLE",
    "TEXTAREA",
  ]);
  const blockedAttributes = new Set([
    "action",
    "formaction",
    "href",
    "poster",
    "src",
    "srcdoc",
    "xlink:href",
  ]);

  function fragment(html) {
    const clean = String(html || "")
      .replace(/<<TP_P\d+>>/g, "")
      .replace(/<<TP_P/g, "");
    const parsed = new DOMParser().parseFromString(clean, "text/html");
    for (const element of [...parsed.body.querySelectorAll("*")]) {
      if (blockedTags.has(element.tagName)) {
        element.remove();
        continue;
      }
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;
        if (
          name.startsWith("on") ||
          blockedAttributes.has(name) ||
          (name === "style" &&
            /(?:expression\s*\(|url\s*\(|@import|javascript\s*:)/i.test(value))
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    const result = document.createDocumentFragment();
    while (parsed.body.firstChild) {
      result.appendChild(document.importNode(parsed.body.firstChild, true));
      parsed.body.firstChild.remove();
    }
    return result;
  }

  TP.overlaySanitize = {
    fill(scope, html) {
      scope.replaceChildren(fragment(html));
    },
    fragment,
  };
})();
