/**
 * TextPhantom visual user guide.
 *
 * Screenshots and callout positions come from guide-data.js, which
 * scripts/guide/capture-guide.py generates from the real popup. This file
 * draws the numbered circles over each image (so the images carry no text),
 * numbers the matching explanation lists and links the two together.
 */
(() => {
  "use strict";
  const data = window.TP_GUIDE_DATA;
  const shots = data && typeof data === "object" ? data.shots || {} : {};

  function version() {
    try {
      const value = globalThis.chrome?.runtime?.getManifest?.()?.version;
      const el = document.getElementById("guide-version");
      if (el && value) el.textContent = value;
    } catch {
      /* Opened outside the extension: no version to show. */
    }
  }

  function setActive(shotId, key, on) {
    for (const el of document.querySelectorAll(`[data-shot="${shotId}"] [data-key="${key}"]`))
      el.classList.toggle("is-active", on);
  }

  function renderShot(figure) {
    const id = figure.dataset.shot;
    const shot = shots[id];
    const list = document.querySelector(`ol.callout-list[data-shot="${id}"]`);
    if (!shot) {
      console.error(`[TextPhantom guide] no screenshot data for "${id}"`);
      figure.hidden = true;
      return;
    }
    const frame = document.createElement("div");
    frame.className = "shot-frame";
    const img = document.createElement("img");
    img.src = shot.img;
    img.alt = shot.alt || "";
    img.width = shot.width;
    img.height = shot.height;
    img.loading = "lazy";
    img.decoding = "async";
    // Highlight boxes live in a clipped layer; the numbered dots may overhang the edge.
    const mask = document.createElement("div");
    mask.className = "shot-mask";
    frame.append(img, mask);

    const items = new Map([...(list?.querySelectorAll(":scope > li[data-key]") || [])]
      .map((li) => [li.dataset.key, li]));
    shot.callouts.forEach((callout, index) => {
      const n = String(index + 1);
      const li = items.get(callout.key);
      const targetId = `${id}--${callout.key}`;
      if (li) {
        li.id = targetId;
        li.dataset.n = n;
        li.tabIndex = -1;
      } else {
        console.error(`[TextPhantom guide] "${id}" has no explanation for callout "${callout.key}"`);
      }
      const box = document.createElement("div");
      box.className = "callout-box";
      box.dataset.key = callout.key;
      Object.assign(box.style, {
        left: `${callout.box.x}%`, top: `${callout.box.y}%`,
        width: `${callout.box.w}%`, height: `${callout.box.h}%`,
      });
      const dot = document.createElement("a");
      dot.className = "callout";
      dot.dataset.key = callout.key;
      dot.href = `#${targetId}`;
      dot.textContent = n;
      const label = li?.querySelector("b")?.textContent?.trim();
      dot.setAttribute("aria-label", label ? `ข้อ ${n}: ${label}` : `ข้อ ${n}`);
      dot.style.left = `${callout.x}%`;
      dot.style.top = `${callout.y}%`;
      dot.addEventListener("click", (event) => {
        if (!li) return;
        event.preventDefault();
        history.replaceState(null, "", `#${targetId}`);
        li.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        li.focus({ preventScroll: true });
        flash(id, callout.key);
      });
      mask.append(box);
      frame.append(dot);
    });
    for (const [key, li] of items) {
      if (!li.dataset.n) {
        console.error(`[TextPhantom guide] "${id}" explanation "${key}" has no callout`);
        continue;
      }
      for (const [name, on] of [["mouseenter", true], ["mouseleave", false], ["focusin", true], ["focusout", false]])
        li.addEventListener(name, () => setActive(id, key, on));
    }
    for (const dot of frame.querySelectorAll(".callout")) {
      const key = dot.dataset.key;
      for (const [name, on] of [["mouseenter", true], ["mouseleave", false], ["focus", true], ["blur", false]])
        dot.addEventListener(name, () => setActive(id, key, on));
    }
    figure.append(frame);
    if (shot.alt) {
      const caption = document.createElement("figcaption");
      caption.textContent = shot.alt;
      caption.setAttribute("aria-hidden", "true"); // Same text as the image alt.
      figure.append(caption);
    }
  }

  let flashTimer = 0;
  function flash(id, key) {
    clearTimeout(flashTimer);
    setActive(id, key, true);
    flashTimer = setTimeout(() => setActive(id, key, false), 1600);
  }

  function tableOfContents(toc = document.getElementById("toc"), toggle = document.getElementById("toc-toggle")) {
    if (!toc) return;
    const links = [...toc.querySelectorAll('a[href^="#"]')];
    const close = () => {
      toc.classList.remove("is-open");
      toggle?.setAttribute("aria-expanded", "false");
    };
    toggle?.addEventListener("click", () => {
      // One toggle in the top bar; it opens the contents of the visible tab.
      if (toc.closest("[data-guide-panel]")?.hidden) return;
      const open = toc.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
      if (open) links[0]?.focus();
    });
    for (const link of links) link.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && toc.classList.contains("is-open")) { close(); toggle?.focus(); }
    });
    const sections = links.map((link) => document.getElementById(link.getAttribute("href").slice(1))).filter(Boolean);
    if (!("IntersectionObserver" in window) || !sections.length) return;
    const visible = new Set();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const current = sections.find((section) => visible.has(section.id));
      if (!current) return;
      for (const link of links)
        link.setAttribute("aria-current", String(link.getAttribute("href") === `#${current.id}`));
    }, { rootMargin: "-80px 0px -55% 0px" });
    for (const section of sections) observer.observe(section);
  }

  // ---------- top-level tabs (10495): "คู่มือการใช้งาน" | "Privacy & data" ----------
  // guide.html#privacy (or #privacy-…, or ?tab=privacy) opens the Privacy tab.
  // The tab is reflected in the URL: #privacy for Privacy, no hash for the guide.
  const isPrivacyTarget = (hash) => /^#privacy(?:-|$)/.test(hash || "");
  function currentTab() {
    if (isPrivacyTarget(location.hash)) return "privacy";
    if (new URLSearchParams(location.search).get("tab") === "privacy" && !location.hash) return "privacy";
    return "guide";
  }
  function showTab(name, { updateUrl = false } = {}) {
    for (const button of document.querySelectorAll("button[data-guide-tab]")) {
      const on = button.dataset.guideTab === name;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    for (const panel of document.querySelectorAll("[data-guide-panel]")) panel.hidden = panel.dataset.guidePanel !== name;
    document.body.dataset.guideCurrent = name;
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.delete("tab");
      url.hash = name === "privacy" ? "privacy" : "";
      history.replaceState(null, "", url.href.replace(/#$/, ""));
    }
    document.dispatchEvent(new CustomEvent("tp-guide-tab", { detail: { tab: name } }));
  }
  function tabs() {
    const buttons = [...document.querySelectorAll("button[data-guide-tab]")];
    for (const button of buttons) {
      button.addEventListener("click", () => {
        showTab(button.dataset.guideTab, { updateUrl: true });
        window.scrollTo({ top: 0 });
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = buttons.indexOf(button);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus(); buttons[next].click();
      });
    }
    window.addEventListener("hashchange", () => {
      const name = isPrivacyTarget(location.hash) ? "privacy" : location.hash ? "guide" : document.body.dataset.guideCurrent;
      if (name && name !== document.body.dataset.guideCurrent) showTab(name);
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    });
    showTab(currentTab());
  }

  // Shared with the Privacy tab (guide/privacy.js), which draws its own shots.
  window.TPGuide = Object.freeze({ renderShot, tableOfContents, showTab });

  version();
  for (const figure of document.querySelectorAll("#guide-panel figure.shot[data-shot]")) renderShot(figure);
  tableOfContents();
  tabs();
  // Re-apply a deep link once the callout lists have their ids.
  if (location.hash && !isPrivacyTarget(location.hash)) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
})();
