/** Paid login and account UI; Manual Provider, key and model remain untouched. */
import { normalizeUrl } from "../../shared/url.js";

function safeApiBase(value) {
  const raw = normalizeUrl(value);
  if (!raw) return "";
  const url = new URL(raw);
  return url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ? raw : "";
}

export function createPaidServiceController({ els, state, getStorage, setStorage, toggleUi }) {
  let available = false, base = "", token = "", account = null;
  let mode = "manual", loading = false, selected = "", sessionBase = "";
  let loginReady = false, statusBase = "", statusCheckedAt = 0, statusRequestId = 0;
  let sending = false, verifying = false;
  const status = message => { if (els.aiPaidStatus) els.aiPaidStatus.textContent = message; };
  const active = () => available && mode === "paid";
  const apiBase = () => safeApiBase(base || els.apiUrl?.value);

  function syncLoginControls() {
    if (els.aiPaidSend) els.aiPaidSend.disabled = !active() || !loginReady || sending;
    if (els.aiPaidVerify) els.aiPaidVerify.disabled = !active() || !loginReady || verifying;
  }

  async function checkLoginStatus(force = false) {
    if (!active() || (token && account)) return;
    const target = apiBase();
    if (!force && target === statusBase && Date.now() - statusCheckedAt < 15000) return;
    const requestId = ++statusRequestId;
    statusBase = target;
    statusCheckedAt = Date.now();
    loginReady = false;
    syncLoginControls();
    status("กำลังตรวจสอบระบบส่งรหัสทางอีเมล…");
    try {
      const result = await request("/paid/auth/status");
      if (requestId !== statusRequestId || !active() || apiBase() !== target) return;
      loginReady = result.available === true;
      status(String(result.message || (loginReady ? "ระบบส่งรหัสพร้อมใช้งาน" : "ระบบส่งรหัสยังไม่พร้อม กรุณาติดต่อผู้ดูแล")));
    } catch (error) {
      if (requestId !== statusRequestId || !active() || apiBase() !== target) return;
      status(error.status ? error.message : "ตรวจสอบระบบ OTP ไม่ได้ กรุณาตรวจการเชื่อมต่อแล้วลองอีกครั้ง");
    } finally { syncLoginControls(); }
  }

  function keepSessionOnItsApi() {
    if (!token || sessionBase === apiBase()) return true;
    token = ""; account = null; selected = ""; sessionBase = "";
    void setStorage({ paidSessionToken: "", paidModel: "", paidApiBase: "" });
    status("API URL changed. Sign in again to use Paid.");
    loginReady = false;
    statusBase = "";
    return false;
  }

  function applyVisibility() {
    const showAi = els.mode?.value === "lens_text" && els.sources?.value === "ai";
    state.paidActive = showAi && active();
    state.paidReady = Boolean(state.paidActive && token && account && selected &&
      account.models?.some(item => item.id === selected && Number(item.eligible_tp) > 0) &&
      !account.paid_paused);
    if (els.aiServiceWrap) els.aiServiceWrap.style.display = showAi && available ? "" : "none";
    if (els.aiPaidPanel) els.aiPaidPanel.style.display = state.paidActive ? "" : "none";
    if (!state.paidActive) return;
    for (const wrap of [els.aiProviderWrap, els.aiKeyWrap, els.aiModelWrap, els.aiEndpointWrap]) {
      if (wrap) wrap.style.display = "none";
    }
    if (els.aiPaidLogin) els.aiPaidLogin.style.display = token && account ? "none" : "";
    if (els.aiPaidAccount) els.aiPaidAccount.style.display = token && account ? "" : "none";
    syncLoginControls();
    if (els.aiPageImageWrap) els.aiPageImageWrap.style.display = "none";
  }

  async function request(path, { body = null, authenticated = false } = {}) {
    const target = apiBase();
    if (!target) throw new Error("Paid requires an HTTPS API URL (or localhost)");
    const res = await fetch(target + path, { method: body === null ? "GET" : "POST",
      cache: "no-store", headers: { Accept: "application/json",
        ...(body !== null ? { "Content-Type": "application/json" } : {}),
        ...(authenticated && token ? { Authorization: "Bearer " + token } : {}) },
      body: body === null ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(String(data?.error?.message || `Paid request failed (${res.status})`));
      error.status = res.status;
      throw error;
    }
    return data;
  }

  async function refreshAccount() {
    if (!active() || !token || loading) return;
    loading = true;
    status("Loading account…");
    try {
      account = await request("/paid/me", { authenticated: true });
      if (els.aiPaidEmailLabel) els.aiPaidEmailLabel.textContent = account.email || "";
      if (els.aiPaidCredits) els.aiPaidCredits.textContent =
        `Credits: ${account.credits?.available || "0"} TP · Reserved: ${account.credits?.held || "0"} TP`;
      const models = Array.isArray(account.models) ? account.models : [];
      if (!models.some(x => x.id === selected)) selected = models[0]?.id || "";
      if (els.aiPaidModel) {
        els.aiPaidModel.replaceChildren(...models.map(x => {
          const option = document.createElement("option");
          option.value = x.id;
          option.textContent = `${x.name} · ${x.eligible_tp} TP available`;
          return option;
        }));
        els.aiPaidModel.value = selected;
      }
      await setStorage({ paidModel: selected });
      status(account.paid_paused ? "Paid is paused by the operator." :
        !models.length ? "No models are available for this account." :
        account.checkout_available ? "Account ready." :
        "Account ready. Online top-up is not open yet; the operator can add credits.");
    } catch (error) {
      account = null;
      if (error.status === 401) {
        token = "";
        await setStorage({ paidSessionToken: "" });
      }
      status(error.message);
      if (!token) void checkLoginStatus(true);
    } finally {
      loading = false;
      toggleUi();
    }
  }

  function setAvailability(value, apiBase) {
    available = value === true;
    base = safeApiBase(apiBase);
    if (!available) { loginReady = false; statusBase = ""; ++statusRequestId; }
    if (available) keepSessionOnItsApi();
    if (els.aiService) els.aiService.value = available && mode === "paid" ? "paid" : "manual";
    applyVisibility();
    if (active() && token) void refreshAccount();
    else if (active()) void checkLoginStatus();
    toggleUi();
  }

  async function initialize() {
    const values = await getStorage(["aiServiceMode", "paidSessionToken", "paidModel", "paidEmail", "paidApiBase"]);
    mode = values.aiServiceMode === "paid" ? "paid" : "manual";
    token = String(values.paidSessionToken || "");
    selected = String(values.paidModel || "");
    sessionBase = safeApiBase(values.paidApiBase);
    if (available) keepSessionOnItsApi();
    if (els.aiPaidEmail) els.aiPaidEmail.value = String(values.paidEmail || "");
    if (els.aiService) els.aiService.value = available && mode === "paid" ? "paid" : "manual";
    applyVisibility();
    if (active() && token) void refreshAccount();
    else if (active()) void checkLoginStatus();
    toggleUi();
  }

  els.aiService?.addEventListener("change", async () => {
    mode = els.aiService.value === "paid" ? "paid" : "manual";
    await setStorage({ aiServiceMode: mode });
    toggleUi();
    if (active() && token) void refreshAccount();
    else if (active()) void checkLoginStatus(true);
  });
  els.aiPaidCheck?.addEventListener("click", () => void checkLoginStatus(true));
  els.aiPaidSend?.addEventListener("click", async () => {
    if (!active() || !loginReady || sending) return;
    const email = String(els.aiPaidEmail?.value || "").trim();
    if (!email) return status("Enter your account email.");
    try {
      sending = true; syncLoginControls();
      await request("/paid/auth/request", { body: { email } });
      await setStorage({ paidEmail: email });
      status("If this email is allowed, a login code will arrive shortly.");
    } catch (error) {
      status(error.message);
      if (error.status === 503) void checkLoginStatus(true);
    } finally { sending = false; syncLoginControls(); }
  });
  els.aiPaidVerify?.addEventListener("click", async () => {
    if (!active() || !loginReady || verifying) return;
    const email = String(els.aiPaidEmail?.value || "").trim();
    const code = String(els.aiPaidCode?.value || "").trim();
    if (!/^[0-9]{6}$/.test(code)) return status("Enter the 6-digit email code.");
    try {
      verifying = true; syncLoginControls();
      const data = await request("/paid/auth/verify", { body: { email, code } });
      token = String(data.token || "");
      if (!token) throw new Error("Center did not create a session.");
      sessionBase = apiBase();
      await setStorage({ paidSessionToken: token, paidEmail: email, paidApiBase: sessionBase });
      if (els.aiPaidCode) els.aiPaidCode.value = "";
      await refreshAccount();
    } catch (error) { status(error.message); }
    finally { verifying = false; syncLoginControls(); }
  });
  els.aiPaidModel?.addEventListener("change", async () => {
    selected = String(els.aiPaidModel.value || "");
    await setStorage({ paidModel: selected });
    toggleUi();
  });
  els.aiPaidRefresh?.addEventListener("click", () => void refreshAccount());
  els.aiPaidLogout?.addEventListener("click", async () => {
    try { await request("/paid/auth/logout", { body: {}, authenticated: true }); }
    catch { /* Local sign-out still discards this device's token. */ }
    token = ""; account = null; selected = ""; sessionBase = "";
    await setStorage({ paidSessionToken: "", paidModel: "", paidApiBase: "" });
    status("Signed out."); toggleUi();
    void checkLoginStatus(true);
  });

  return { initialize, setAvailability, applyVisibility };
}
