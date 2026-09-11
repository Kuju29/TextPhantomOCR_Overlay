function versionParts(value) {
  const text = String(value || "").trim();
  if (!/^\d+(?:\.\d+){1,3}$/.test(text)) return null;
  return text.split(".").map(Number);
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function createUpdateBannerController({ els, getDefaults, getCurrentVersion } = {}) {
  async function refresh() {
    if (!els.updateBanner) return false;
    els.updateBanner.hidden = true;
    try {
      const defaults = await getDefaults();
      const latest = String(defaults?.latestVersion || "").trim();
      if (compareVersions(getCurrentVersion(), latest) !== -1) return false;
      const updateUrl = String(defaults?.updateUrl || "").trim();
      if (!/^https:\/\//i.test(updateUrl)) return false;
      els.updateBanner.href = updateUrl;
      els.updateBanner.textContent = `Version ${latest} is available. Please update TextPhantom.`;
      els.updateBanner.hidden = false;
      return true;
    } catch {
      return false;
    }
  }

  return { refresh };
}
