/**
 * The user guide's "Privacy & data" tab (10495).
 *
 * Everything shown here comes from shared/privacy-content.js — the SUMMARY is
 * the very text of the consent screen — so the wording is edited in one place.
 * Thai when uiLanguageV1 is "th" (or ?lang=th), English otherwise, with a TH/EN
 * switch. Works when guide.html is opened as a plain file: no chrome.* is
 * needed to render (the permission table then lists every browser build).
 * "Your choice" (Allow / Revoke) is added by privacy-choice.js inside the
 * extension only.
 */
(() => {
  "use strict";
  const P = window.TPPrivacyContent;
  const panel = document.getElementById("privacy-panel");
  const mount = document.getElementById("privacy-content");
  const toc = document.getElementById("privacy-toc");
  if (!P || !panel || !mount || !toc) return;
  const SHOT_GROUP = {
    "privacy-consent-th": "consent", "privacy-consent-en": "consent", "privacy-locked": "locked",
    "privacy-diagnostics": "diagnostics", "privacy-diagnostics-confirm-th": "diagnosticsConfirm",
    "privacy-diagnostics-confirm-en": "diagnosticsConfirm",
  };
  const PARTS = [["privacy-summary", "partSummary"], ["privacy-details", "partDetails"],
    ["privacy-permissions", "partPermissions"], ["privacy-choice", "partChoice"]];
  let lang = "en", renderedOnce = false;

  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "className") node.className = value; else node.setAttribute(key, value);
    }
    return node;
  };
  const heading = (n, text) => { const h = el("h2"); h.append(el("span", String(n), { className: "sec-no" }), document.createTextNode(text)); return h; };

  function manifest() {
    try { return globalThis.chrome?.runtime?.id ? globalThis.chrome.runtime.getManifest() : null; } catch { return null; }
  }

  /** The consent screen's text (SUMMARY) as a static block. */
  function summaryBlock(text) {
    const box = el("div", null, { className: "privacy-summary", id: "privacy-summary-text" });
    box.append(el("h3", text.title));
    for (const group of P.SUMMARY_GROUPS) {
      box.append(el("h4", text[group.heading]));
      const list = el("ul");
      for (const key of group.items) list.append(el("li", text[key], { "data-summary": key }));
      box.append(list);
    }
    box.append(el("p", text.note, { className: "privacy-note" }));
    const foot = el("p", text.foot + " · ", { className: "privacy-foot" });
    foot.append(el("a", text.link, { href: "#privacy-details" }));
    box.append(foot);
    return box;
  }

  function shotBlock(shotId, labels) {
    const block = el("div", null, { className: "shot-block" });
    const figure = el("figure", null, { className: "shot", "data-shot": shotId });
    const list = el("ol", null, { className: "callout-list", "data-shot": shotId });
    const group = labels.callouts[SHOT_GROUP[shotId]] || {};
    const shot = window.TP_GUIDE_DATA?.shots?.[shotId];
    for (const callout of shot?.callouts || []) {
      const item = el("li", null, { "data-key": callout.key });
      item.append(el("b", group[callout.key] || callout.key));
      list.append(item);
    }
    block.append(figure, list);
    return block;
  }

  function detailCard(item, labels) {
    const card = el("section", null, { className: "detail", id: "privacy-" + item.id });
    card.append(el("h3", item.title));
    for (const paragraph of item.paragraphs || []) card.append(el("p", paragraph));
    if (item.bullets?.length) {
      const list = el("ul");
      for (const bullet of item.bullets) list.append(el("li", bullet));
      card.append(list);
    }
    if (item.quote) card.append(el("blockquote", item.quote, { lang: "en" }));
    if (item.table) {
      const wrap = el("div", null, { className: "table-wrap" });
      const table = el("table", null, { className: "data-table" });
      const head = el("thead"), row = el("tr");
      for (const key of ["who", "what", "when"]) row.append(el("th", labels.table[key], { scope: "col" }));
      head.append(row);
      const body = el("tbody");
      for (const cells of item.table) {
        const tr = el("tr");
        cells.forEach((cell, index) => tr.append(el(index ? "td" : "th", cell, index ? {} : { scope: "row" })));
        body.append(tr);
      }
      table.append(head, body); wrap.append(table); card.append(wrap);
    }
    if (item.shots?.length) {
      const shots = el("div", null, { className: "privacy-shots" });
      for (const shotId of item.shots) shots.append(shotBlock(shotId, labels));
      card.append(shots);
    }
    return card;
  }

  function permissionsCard(labels) {
    const reasons = P.permissions(lang);
    const live = manifest();
    const rows = P.permissionRows(live);
    const kinds = { api: labels.kindApi, host: labels.kindHost, optional: labels.kindOptional,
      dataRequired: labels.kindData + " · " + labels.kindDataRequired, dataOptional: labels.kindData + " · " + labels.kindDataOptional };
    const frag = document.createDocumentFragment();
    frag.append(el("p", labels.partPermissionsLead), el("p", live ? labels.permissionsLive : labels.permissionsStatic, { className: "hint" }));
    const wrap = el("div", null, { className: "table-wrap" });
    const table = el("table", null, { className: "data-table", id: "privacy-permission-table" });
    const head = el("thead"), hr = el("tr");
    for (const text of [labels.colPermission, labels.colKind, labels.colWhy, ...(live ? [] : [labels.colBrowsers])]) hr.append(el("th", text, { scope: "col" }));
    head.append(hr);
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr", null, { "data-permission": row.name, "data-kind": row.kind });
      const name = el("th", null, { scope: "row" }); name.append(el("code", row.name));
      const kind = el("td"); kind.append(el("span", kinds[row.kind] || row.kind, { className: "perm-kind" }));
      tr.append(name, kind, el("td", reasons[row.name] || "—"));
      if (!live) tr.append(el("td", row.browsers.join(", ")));
      body.append(tr);
    }
    table.append(head, body); wrap.append(table); frag.append(wrap);
    return frag;
  }

  function choiceCard(labels) {
    const frag = document.createDocumentFragment();
    const body = el("div", null, { id: "privacy-choice-body", className: "choice-block" });
    // Replaced by privacy-choice.js inside the extension.
    body.append(el("p", labels.choiceOutside, { className: "choice-note" }));
    frag.append(body);
    return frag;
  }

  function skeleton() {
    const head = el("section", null, { className: "intro card", id: "privacy-top" });
    mount.append(head);
    PARTS.forEach(([id]) => mount.append(el("section", null, { className: "card", id, "aria-labelledby": id + "-title" })));
    const list = el("ol");
    for (const [id] of PARTS) { const li = el("li"); li.append(el("a", "", { href: "#" + id })); list.append(li); }
    toc.append(el("p", "", { className: "toc-title" }), list);
  }

  function render() {
    const labels = P.guide(lang), summary = P.summary(lang);
    panel.lang = lang === "th" ? "th" : "en";
    document.documentElement.dataset.privacyLang = lang;
    // Header with the TH/EN switch.
    const top = document.getElementById("privacy-top");
    const row = el("div", null, { className: "privacy-head" });
    row.append(el("h1", labels.heading));
    const switcher = el("div", null, { className: "lang-switch", role: "group", "aria-label": labels.language });
    for (const [value, label] of [["th", "ไทย"], ["en", "English"]]) {
      const button = el("button", label, { type: "button", "data-lang": value, "aria-pressed": String(value === lang), lang: value });
      button.addEventListener("click", () => setLanguage(value, { remember: true }));
      switcher.append(button);
    }
    row.append(switcher);
    top.replaceChildren(row, el("p", labels.lead, { className: "lead" }));
    // Parts.
    const content = {
      "privacy-summary": () => [el("p", labels.partSummaryLead, { className: "hint" }), summaryBlock(summary)],
      "privacy-details": () => { const grid = el("div", null, { className: "detail-grid" }); for (const item of P.details(lang)) grid.append(detailCard(item, labels)); return [grid]; },
      "privacy-permissions": () => [permissionsCard(labels)],
      "privacy-choice": () => [choiceCard(labels)],
    };
    PARTS.forEach(([id, key], index) => {
      const section = document.getElementById(id);
      const title = heading(index + 1, labels[key]); title.id = id + "-title";
      section.replaceChildren(title, ...content[id]());
    });
    toc.querySelector(".toc-title").textContent = labels.tabPrivacy;
    PARTS.forEach(([id, key], index) => { toc.querySelectorAll("a")[index].textContent = labels[key]; });
    // The captions follow the tab language (guide-data.js alt text is Thai).
    const captions = { consent: labels.shotConsent, locked: labels.shotLocked, diagnostics: labels.shotDiagnostics, diagnosticsConfirm: labels.shotDiagnosticsConfirm };
    for (const figure of mount.querySelectorAll("figure.shot[data-shot]")) {
      window.TPGuide?.renderShot(figure);
      const caption = captions[SHOT_GROUP[figure.dataset.shot]];
      if (!caption) continue;
      const img = figure.querySelector("img"); if (img) img.alt = caption;
      const text = figure.querySelector("figcaption"); if (text) text.textContent = caption;
    }
    if (!renderedOnce) { renderedOnce = true; window.TPGuide?.tableOfContents(toc, document.getElementById("toc-toggle")); }
    document.dispatchEvent(new CustomEvent("tp-privacy-lang", { detail: { lang } }));
  }

  function setLanguage(value, { remember = false } = {}) {
    lang = P.language(value);
    if (remember) {
      const url = new URL(location.href);
      url.searchParams.set("lang", lang);
      history.replaceState(null, "", url.href);
    }
    render();
  }

  async function initialLanguage() {
    const param = new URL(location.href).searchParams.get("lang");
    if (param === "th" || param === "en") return param;
    try {
      const area = globalThis.chrome?.storage?.local;
      if (!area?.get || !globalThis.chrome?.runtime?.id) return "en";
      const saved = await new Promise((resolve) => {
        const returned = area.get("uiLanguageV1", (value) => resolve(value || {}));
        if (returned && typeof returned.then === "function") returned.then((value) => resolve(value || {}), () => resolve({}));
      });
      return saved?.uiLanguageV1 === "th" ? "th" : "en";
    } catch { return "en"; }
  }

  skeleton();
  window.TPPrivacyGuide = Object.freeze({ get lang() { return lang; }, setLanguage });
  initialLanguage().then((value) => {
    setLanguage(value);
    // A deep link into this tab (#privacy-details …) once it is drawn.
    if (/^#privacy-/.test(location.hash)) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  });
})();
