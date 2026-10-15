import { classifyThinkingState, sendsProviderDefault } from '../../shared/thinking-state.js';
import { getLoginSession } from '../../shared/login-session.js';
import { createLoginServiceController } from "./login-service-controller.js";
import { diagnosticFetch, recordDiagnostic, diagnosticId } from "../../shared/diagnostics.js";
/** Customer sign-in. Capability, connectivity and session validity are separate.
 * Only GET status/me recover automatically; never replay an OTP or paid job.
 */
import { createInlineAccount } from "../../paid/inline.js";
import { configuredAccountBase } from "../../paid/client.js";
import { normalizeUrl } from "../../shared/url.js";
import { UI_LANGUAGE_KEY, normalizeUiLanguage } from "../../shared/ui-language.js";
import { createPaidModelPricing, paidModelRates, paidQuoteFailureMessage } from "./paid-model-pricing.js";
import { setUiTemplate, setUiText, uiTemplate } from "../../shared/ui-template.js";
import { accountViewScope, createPaidViewCache, isPermanentPaidQuoteFailure, validPaidAccountView,
  paidModelInventoryReady, paidInventoryDisplay, paidInventoryFailureMessage } from "../../paid/view-cache.js";
import { paidEntry, PAID_PROFILE_KEY } from '../../shared/paid-profile.js';
import { installId, installHeaders } from '../../paid/install-id.js';
import { changedTopics } from '../../shared/change-signals.js';
import { createRecoveryBackoff } from '../../shared/retry-backoff.js';
import { AI_USAGE_STORAGE_KEY } from '../../shared/ai-usage.js';
import { PAID_ROUTE_OUTCOME_KEY, paidRouteFailureCode, samePaidRoute } from '../../shared/paid-route-outcome.js';

function safeApiBase(value) {
  const raw = normalizeUrl(value);
  if (!raw) return "";
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) return "";
  return url.protocol === "https:" ||
    (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ? raw : "";
}
const text = (el, value) => { if (el) el.textContent = value; };
const show = (el, value) => { if (el) el.style.display = value ? "" : "none"; };

export function isActionPopup({extension=globalThis.chrome?.extension||globalThis.browser?.extension,
  page=globalThis.window,protocol=globalThis.location?.protocol}={}) {
  try {
    if(typeof extension?.getViews==='function')return extension.getViews({type:'popup'}).includes(page);
  }catch{}
  // Browser implementations without getViews still load this document as the
  // extension action; ordinary web previews keep their viewport constraints.
  return ['chrome-extension:','moz-extension:'].includes(protocol);
}

export function createPaidServiceController({ els, state, getStorage, setStorage, toggleUi,
  recheckApi = null, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  recoveryMs = 5000, requestTimeoutMs = 20000, onProfileContext = null, beforeSwitch = null,
  onUsageSelection = null,
}) {
  let available = false, capability = null, base = "", knownBase = "";
  let token = "", account = null, accountVerified = false, selected = "", sessionBase = "", email = "";
  let mode = "manual", initialized = false, disposed = false, loginReady = false, registrationEnabled = true;
  let loading = false, statusLoading = false, sending = false, verifying = false, reconnecting = false;
  let identityEpoch = 0, accountRequestId = 0, statusRequestId = 0, statusCheckedAt = 0;
  let serviceIssue = "", metadataIssue = "", challenge = null, cooldownTimer = null;
  let priceRefreshTimer=null;
  let profilePriceRevision=0, priceRefreshPending=false;
  // 10491: a saved quote failure is display only and is asked again (once) on
  // popup open/visible, the account/prices change token, a changed Center
  // catalogue, a model change or a Paid translation result. Never by timer.
  // quoteOwed stays set until a quote is actually asked, so a refresh that a
  // concurrent profile/storage write restarts cannot drop the re-ask.
  let quoteOwed=false, lastCatalogue='';
  const listeners = [];
  const viewCache = createPaidViewCache({read:getStorage,write:setStorage,now});
  let viewScope = "";
  const ownSessionWrites = new Map();
  const modelPricing = createPaidModelPricing(els);
  const loginController = createLoginServiceController({els,state,request,getStorage,setStorage,toggleUi,beforeSwitch,onUsageSelection,now});
  function listen(el, name, handler) { if (!el?.addEventListener) return; el.addEventListener(name, handler); listeners.push(() => el.removeEventListener?.(name, handler)); }
  function accountViewport(open) {
    const surface=isActionPopup()?'popup':'page';
    if(globalThis.document?.documentElement)globalThis.document.documentElement.dataset.paidSurface=surface;
    if(globalThis.document?.body)globalThis.document.body.dataset.paidSurface=surface;
    globalThis.document?.documentElement?.classList?.toggle('paid-account-open',Boolean(open));
    globalThis.document?.body?.classList?.toggle('paid-account-open',Boolean(open));
    els.aiPaidPanel?.classList?.toggle('paid-browsing',Boolean(open));
  }
  const inlineAccount = createInlineAccount({mount: els.aiPaidInline, read:getStorage, write:setStorage,
    onVisibility:open=>{accountViewport(open);if(initialized&&!disposed) toggleUi();},
    onBalance:()=>{
      if(!initialized||disposed)return;
      // A newly credited order or entitlement can arrive while an older /me
      // read is pending. Queue a fresh owned read after it; inline display
      // data never grants main-account or model authority.
      if(loading)priceRefreshPending=true;
      else void refreshAccount();
    },
    onSignout:()=>els.aiPaidLogout?.click(),
    onSessionExpired:async id=>{
      if(disposed||token!==id.token||sessionBase!==id.base)return;
      cancelRequests();stopTimer();
      await clearSession();
      toggleUi();status("Your session has expired. Sign in again to continue.","warning");
      const expiredEpoch=identityEpoch;
      await checkLoginStatus(true);
      if(!disposed&&identityEpoch===expiredEpoch&&!token&&loginReady)
        status("Your session has expired. Sign in again to continue.","warning");
    }});
  async function deviceHint() {
    // One random install id for the whole browser profile (tpInstallIdV1); an
    // older per-API paidDeviceIds id is reused. Untrusted anti-abuse hint, never authentication.
    if (!apiBase()) return undefined;
    return installId({ read: getStorage, write: setStorage });
  }
  const pending = new Set();
  const active = () => mode === "paid";
  const inputBase = () => safeApiBase(els.apiUrl?.value);
  const configuredApiBase = () => Boolean(inputBase() && inputBase() === configuredAccountBase({
    customApiUrl: state.lastSavedApiUrl,
    apiUrlDefault: state.apiDefaults?.defaultApiUrl,
  }));
  const apiBase = () => base && base === inputBase() && configuredApiBase() ? base : "";
  // message: text (authored phrases and " · Trace: …" details are split into
  // separate text nodes) or {template, values} with protected runtime values.
  const status = (message, kind = "info") => {
    if (message && typeof message === "object") setUiTemplate(els.aiPaidStatus, message.template, message.values);
    else setUiText(els.aiPaidStatus, message);
    els.aiPaidStatus?.setAttribute?.("data-kind", kind);
  };
  // Bounded recovery (5, 15, 30, then every 60 s while open; at once on the
  // browser 'online' event) instead of a fixed 10 s retry; nothing while hidden.
  const recovery = createRecoveryBackoff({
    run: () => {
      if (!retryNeeded()) return;
      if (globalThis.document?.visibilityState === "hidden") return; // visibilitychange resumes
      if (token) void refreshAccount(); else void checkLoginStatus(true);
    },
    delays: [recoveryMs, recoveryMs * 3, recoveryMs * 6, recoveryMs * 12],
    setTimeoutFn, clearTimeoutFn });
  const stopTimer = () => recovery.succeeded();
  const stopCooldown = () => { if (cooldownTimer !== null) clearTimeoutFn(cooldownTimer); cooldownTimer = null; };
  const stopPriceRefresh=()=>{if(priceRefreshTimer!==null)clearTimeoutFn(priceRefreshTimer);priceRefreshTimer=null;};
  const selectedQuoteFailure=()=>account?.models?.find(x=>x.id===selected)?.route_quote_failure||null;
  function queueRefresh(forceQuote=false){
    if(forceQuote)quoteOwed=true;
    if(loading)priceRefreshPending=true;
    else void refreshAccount();
  }
  // No periodic timer: balance and prices are re-read when the popup opens, the
  // model changes, a Paid translation finished (usage ledger, debounced) and when
  // the account/prices change token moves on any response (shared/change-signals.js).
  const priceRefreshEligible=()=>initialized&&!disposed&&available&&state.paidActive&&token&&accountVerified&&
    state.paidTranslationSource!=='login'&&apiBase()&&globalThis.document?.visibilityState!=='hidden';
  function schedulePriceRefresh(){ if(!priceRefreshEligible()) stopPriceRefresh(); }
  let lastSignalRefresh=0,accountReadAt=0;
  // A token that moved on our own /paid/me answer already came with fresh data.
  const OWN_READ_MS=3000;
  function signalRefresh(reason,{gapMs=0,delayMs=0,force=false}={}){
    if(!priceRefreshEligible())return;
    if(gapMs&&now()-lastSignalRefresh<gapMs)return;
    stopPriceRefresh();
    const run=()=>{priceRefreshTimer=null;if(!priceRefreshEligible())return;lastSignalRefresh=now();
      queueRefresh(force==='if_failed'?Boolean(selectedQuoteFailure()):force);};
    if(!delayMs){run();return;}
    priceRefreshTimer=setTimeoutFn(run,delayMs);priceRefreshTimer?.unref?.();
  }
  function changeSignal(changes,area){
    if(area!=='local'||disposed)return;
    const topics=changedTopics(changes);
    if((topics.includes('account')||topics.includes('prices'))&&!loading&&now()-accountReadAt>OWN_READ_MS)signalRefresh('change_token',{force:true});
    // A Paid translation recorded usage: re-read balance once it settles. A
    // saved quote failure is asked again: the translation went through.
    if(changes[AI_USAGE_STORAGE_KEY]&&state.paidActive)signalRefresh('usage',{gapMs:60000,delayMs:5000,force:'if_failed'});
    if(changes[PAID_ROUTE_OUTCOME_KEY])void applyRouteOutcome(changes[PAID_ROUTE_OUTCOME_KEY].newValue);
  }
  // The real Paid translation result replaces the saved quote state.
  async function applyRouteOutcome(row){
    if(disposed||!accountVerified||state.paidTranslationSource==='login'||!samePaidRoute(row,apiBase(),selected))return;
    const item=account?.models?.find(x=>x.id===selected);
    if(!item)return;
    const code=paidRouteFailureCode(row.code);
    if(!code){ if(item.route_quote_failure)queueRefresh(true); return; }
    const epoch=identityEpoch,model=selected,revision=profilePriceRevision;
    const context=await quoteContext(item,paidEntry(await getStorage([PAID_PROFILE_KEY]),apiBase(),model).profile);
    if(disposed||epoch!==identityEpoch||model!==selected||revision!==profilePriceRevision)return;
    item.pricing={status:'unavailable',unit:'TP_PER_1000_TOKENS',input_tp:null,output_tp:null,basis:'paired_endpoint_metadata'};
    item.route_price_sync={...item.route_price_sync,status:'unavailable',error_code:code,account_policy_verified:false};
    item.route_quote_failure={code,context,...(row.message?{message:String(row.message).slice(0,300)}:{})};
    accountStatus();toggleUi();
    if(viewScope)await viewCache.remember(viewScope,'me',account);
  }
  const cancelRequests = () => {
    stopPriceRefresh();
    priceRefreshPending=false;
    ++identityEpoch; ++accountRequestId; ++statusRequestId;
    for (const controller of pending) controller.abort();
    pending.clear(); loading = statusLoading = sending = verifying = false;
  };
  const retryNeeded = () => initialized && !disposed && available && active() &&
    (token ? !accountVerified || (state.paidTranslationSource !== 'login' && (account?.paid_paused || account?.paid_restriction?.blocked)) : !loginReady);

  function scheduleRecovery() {
    if (!retryNeeded()) { stopTimer(); return; }
    if (recovery.pending || loading || statusLoading) return;
    recovery.failed();
  }

  function syncLoginControls() {
    const busy = sending || verifying;
    const ready = available && active() && loginReady && !busy && !token;
    if (els.aiPaidSend) { els.aiPaidSend.disabled = !ready; text(els.aiPaidSend, sending ? "Sending code…" : "Continue with email"); }
    if (els.aiPaidVerify) { els.aiPaidVerify.disabled = !ready; text(els.aiPaidVerify, verifying ? "Signing in…" : "Verify & sign in"); }
    if (els.aiPaidEmail) els.aiPaidEmail.disabled = busy;
    if (els.aiPaidCode) els.aiPaidCode.disabled = verifying;
    if (els.aiPaidChangeEmail) els.aiPaidChangeEmail.disabled = busy;
    const remaining = Math.max(0, Math.ceil(((challenge?.resendAt || 0) - now()) / 1000));
    if (els.aiPaidResend) {
      els.aiPaidResend.disabled = !ready || remaining > 0;
      if (!sending && remaining) setUiTemplate(els.aiPaidResend, "Resend in {seconds}s", {seconds: remaining});
      else text(els.aiPaidResend, sending ? "Sending…" : "Resend code");
    }
    if (els.aiPaidRefresh) els.aiPaidRefresh.disabled = loading || reconnecting;
    if (els.aiPaidCheck) { els.aiPaidCheck.disabled = reconnecting; text(els.aiPaidCheck, reconnecting ? "Checking…" : "Try again"); }
    stopCooldown();
    if (challenge && !token && active() && remaining > 0 && !disposed) {
      cooldownTimer = setTimeoutFn(syncLoginControls, 1000);
      cooldownTimer?.unref?.();
    }
  }

  function renderAccount() {
    text(els.aiPaidEmailLabel, account?.email || email || "Your account");
    text(els.aiPaidCredits, account
      ? `${(() => { try { return BigInt(account.credits?.available || "0").toLocaleString("en-US"); } catch { return "—"; } })()} TP`
      : "— TP");
    const processing = account?.models?.some(item => item.wallet_processing === true);
    if (account && els.aiPaidHeld?.ownerDocument && els.aiPaidHeld?.replaceChildren) {
      els.aiPaidHeld.replaceChildren(uiTemplate(processing
        ? "Processing: {credits} TP temporarily locked; unused credits return after this request."
        : "Reserved: {credits} TP", {credits:account.credits?.held || "0"}));
    } else text(els.aiPaidHeld, account ? (processing ? `Processing: ${account.credits?.held || "0"} TP temporarily locked; unused credits return after this request.` : `Reserved: ${account.credits?.held || "0"} TP`) : "Checking your balance…");
    text(els.aiPaidAccountState, account ? (account?.paid_restriction?.blocked ? "Paid restricted · signed in" : account?.paid_paused ? "Service paused · signed in" : "Signed in") : "Reconnecting…");
    els.aiPaidAccountState?.setAttribute?.("data-kind", !account || account?.paid_paused || account?.paid_restriction?.blocked ? "warning" : "success");
    const modelsVerified = accountVerified && paidModelInventoryReady(account);
    // The remembered list is selectable at once; the choice is saved and
    // re-validated by the background /paid/me (a missing model is replaced).
    // Once the server has reported a problem the list is display-only again.
    const modelsShown = Boolean(account?.models?.length) && paidModelInventoryReady(account) &&
      !metadataIssue && !serviceIssue && capability !== false;
    if (els.aiPaidModel) els.aiPaidModel.disabled = !(modelsVerified || modelsShown);
    modelPricing.render(account?.models, selected, modelsVerified,Boolean(account));
  }

  function applyVisibility() {
    const showAi = els.mode?.value === "lens_text" && els.sources?.value === "ai";
    const sameKnownApi = configuredApiBase() && knownBase === inputBase();
    state.paidActive = showAi && active();
    state.paidAccountOpen = false;
    const loginSelection = loginController.sync({active: state.paidActive, account, accountVerified, apiBase: inputBase(), token});
    show(els.aiPaidStatus, !accountVerified || loginSelection.source !== 'login');
    if (accountVerified && loginSelection.source === 'login') {
      text(els.aiPaidAccountState, 'Signed in');
      els.aiPaidAccountState?.setAttribute?.('data-kind','success');
    }
    state.paidReady = Boolean(available && state.paidActive && token && accountVerified && paidModelInventoryReady(account) && selected &&
      // A saved route quote (or its failure) is display only, never a gate:
      // Center admission decides on the real request (10491).
      account?.models?.some(item => item.id === selected && item.availability?.available !== false && (item.price_sync?.automatic!==true||item.price_sync.status==='current') &&
        (Number(item.eligible_tp) > 0 || item.wallet_processing === true)) && !account.paid_paused && !account.paid_restriction?.blocked);
    if (loginSelection.source === "login") state.paidReady = Boolean(available && state.paidActive && token && accountVerified && loginSelection.ready);
    state.paidModel = selected;
    state.paidModelCapabilities = accountVerified && paidModelInventoryReady(account) ? account?.models?.find(item => item.id === selected)?.model_capabilities || {} : {};
    // A record exists only when this verified Center catalogue lists the
    // selected model. Without one, AI think shows "Checking model…".
    state.paidModelCapabilitiesFresh = Boolean(accountVerified && paidModelInventoryReady(account) &&
      selected && account?.models?.some(item => item.id === selected));
    state.paidPause = accountVerified && loginSelection.source !== 'login' ? (account?.paid_restriction?.blocked ? account.paid_restriction : account?.paid_status || (account?.paid_paused ? {code: "PAID_PAUSED"} : null)) : null;
    const paidItem = accountVerified && paidModelInventoryReady(account) ? account?.models?.find(item => item.id === selected) : null;
    onProfileContext?.({active: state.paidActive, apiBase: inputBase() || sessionBase || knownBase,
      // Display default for the token ceiling: Center > AI > model > ceiling.
      requestCeiling: Number.isSafeInteger(paidItem?.max_output) ? paidItem.max_output : null,
      source: loginSelection.source, provider: state.loginProvider, accountScope: state.loginAccountId,
      model: loginSelection.source === "login" ? state.loginModel || "auto" : selected || "auto",
      capabilities: loginSelection.source === "login" ? state.loginModelCapabilities : state.paidModelCapabilities});
    // A saved Paid choice always keeps its recovery/Manual controls visible.
    // Remembered capability is presentation only, never authorization to send.
    show(els.aiServiceWrap, showAi && (active() || available || (sameKnownApi && capability !== false)));
    show(els.aiPaidPanel, state.paidActive);
    let notice = "";
    if (state.paidActive) {
      if (!configuredApiBase()) notice = "Save the selected API URL in Tools to connect this account. Your Paid selection is kept.";
      else if (capability === false) notice = "Paid is not available on this API. Choose Manual or try again later.";
      else if (metadataIssue) notice = metadataIssue;
      else if (!available && !account) notice = "Connecting to your API… Your account and Paid selection are kept. Retrying automatically.";
      else notice = serviceIssue;
    }
    show(els.aiPaidUnavailable, Boolean(notice));
    text(els.aiPaidConnectionMessage || els.aiPaidUnavailable, notice);
    if (!state.paidActive) { inlineAccount?.sync({active:false}); accountViewport(false);stopTimer(); stopCooldown();stopPriceRefresh(); return; }
    for (const wrap of [els.aiProviderWrap, els.aiKeyWrap, els.aiModelWrap, els.aiEndpointWrap,
      els.aiLocalAdapterWrap, els.aiLocalCapacityWrap, els.aiLocalManualConcurrencyWrap,
      els.aiLocalModelHint, els.aiLocalRateWrap]) show(wrap, false);
    for (const wrap of [els.aiThinkingWrap, els.aiPromptWrap, els.aiCharactersWrap,
      els.aiPageImageWrap, els.aiRateWrap, els.aiTranslationModeWrap]) show(wrap, true);
    // Login shows AI thinking too: native Login models and DeepSeek web use
    // it; a website without a verified switch shows it read-only.
    show(els.aiThinkingWrap, true);
    // Paid: the Center's model ceiling is the default. Login: OFF keeps
    // the current automatic size; ON uses the user's number for this model.
    show(els.aiTokenCeilingWrap, true);
    show(els.aiPaidLogin, !token);
    inlineAccount?.sync({active:state.paidActive,base:sessionBase,token:sessionBase===inputBase()?token:""});
    const browsing = inlineAccount?.isOpen() === true;
    state.paidAccountOpen = browsing;
    show(els.aiPaidAccount, Boolean(token) && !browsing);
    accountViewport(browsing);
    if (browsing) for (const wrap of [els.aiThinkingWrap, els.aiPromptWrap, els.aiCharactersWrap,
      els.aiPageImageWrap, els.aiRateWrap, els.aiTranslationModeWrap, els.aiTokenCeilingWrap]) show(wrap, false);
    const codeStep = Boolean(challenge && challenge.apiBase === inputBase());
    show(els.aiPaidEmailStep, !codeStep);
    show(els.aiPaidCodeStep, codeStep);
    text(els.aiPaidTitle, codeStep ? "Verify your email" : registrationEnabled ? "Sign in or create account" : "Sign in to TextPhantom");
    text(els.aiPaidSubtitle, codeStep ? (registrationEnabled ? "Enter the 6-digit code. First time? This creates your account." : "Enter the 6-digit code to sign in.") : (registrationEnabled ? "Continue with email. Your account is created after verification." : "New registrations are closed. Existing customers can sign in."));
    text(els.aiPaidCodeEmail, challenge?.email || "");
    renderAccount(); syncLoginControls(); scheduleRecovery();schedulePriceRefresh();
  }

  async function request(path, { body = null, authenticated = false, traceId = "" } = {}) {
    const target = apiBase(), epoch = identityEpoch, requestToken = token;
    if (!target || !available) { recordDiagnostic("paid.request.not_sent",{path,reason:"API_UNAVAILABLE",outcome:"blocked"},target); throw new Error("Check the API connection before continuing."); }
    if (authenticated && (!token || sessionBase !== target)) { recordDiagnostic("paid.request.not_sent",{path,reason:"SESSION_SCOPE_MISMATCH",outcome:"blocked"},target); throw new Error("Sign in on this API before continuing."); }
    const requireCurrentSession = async () => {
      const current = await getStorage(["paidSessionToken", "paidApiBase"]);
      if (!disposed && epoch === identityEpoch && (String(current.paidSessionToken || "") !== requestToken || safeApiBase(current.paidApiBase) !== target)) {
        storageChanged({paidSessionToken:{newValue:current.paidSessionToken},paidApiBase:{newValue:current.paidApiBase}}, "local", true);
      }
      if (disposed || epoch !== identityEpoch)
        throw Object.assign(new Error("Discarded an outdated Paid response."), {code:"STALE_PAID_RESPONSE"});
    };
    // Check the stored identity as well as the event epoch: another extension
    // surface can commit an account change before onChanged is delivered.
    if (authenticated) await requireCurrentSession();
    const controller = new AbortController();
    pending.add(controller);
    const timer = setTimeoutFn(() => controller.abort(), requestTimeoutMs);
    timer?.unref?.();
    try {
      const install = await installHeaders({ read: getStorage, write: setStorage });
      const res = await diagnosticFetch(target + path, { method: body === null ? "GET" : "POST",
        cache: "no-store", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { Accept: "application/json", ...install, ...(traceId ? {"X-TP-Trace-ID":traceId} : {}), ...(body !== null ? { "Content-Type": "application/json" } : {}),
          ...(authenticated ? { Authorization: "Bearer " + requestToken } : {}) },
        body: body === null ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (authenticated) await requireCurrentSession();
      if (!res.ok) {
        const error = new Error(String(data?.error?.message || `Paid request failed (${res.status}).`));
        error.status = res.status; error.code = data?.error?.code || "PAID_REQUEST_FAILED";
        error.traceId = data?.error?.trace_id || res.tpTraceId;
        error.terminal = data?.error?.terminal === true;
        error.stage = data?.error?.stage;
        error.upstreamStatus = data?.error?.upstream_status;
        recordDiagnostic("paid.response.rejected", {trace_id:error.traceId, error_code:error.code, http_status:res.status, outcome:"rejected", path,
          stage:error.stage,upstream_status:error.upstreamStatus,provider_reason:data?.error?.provider_reason,terminal:error.terminal,retryable:data?.error?.retryable}, target);
        if (error.traceId && !path.startsWith('/login/')) error.message += ` · Trace: ${error.traceId}`;
        throw error;
      }
      if (!data || typeof data !== "object") throw new Error("The service returned an invalid response. Try again.");
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeout = new Error("Connection timed out; the outcome is unknown. Check before resending." + (traceId ? ` · Trace: ${traceId}` : ""));
        timeout.code = "PAID_TIMEOUT"; timeout.traceId = traceId; throw timeout;
      }
      throw error;
    } finally {
      clearTimeoutFn(timer); pending.delete(controller);
      if (disposed || epoch !== identityEpoch || target !== apiBase()) {
        recordDiagnostic("paid.response.discarded",{reason:"STALE_RESPONSE",path},target);
        const error = new Error("Discarded an outdated Paid response.");
        error.code = "STALE_PAID_RESPONSE"; throw error;
      }
    }
  }

  async function checkLoginStatus(force = false) {
    if (!available || !active() || token || statusLoading || !initialized) return;
    if (!force && loginReady && now() - statusCheckedAt < 15000) return;
    const id = ++statusRequestId;
    statusLoading = true;
    try {
      const result = await request("/paid/auth/status");
      if (id !== statusRequestId) return;
      statusCheckedAt = now(); loginReady = result.available === true; registrationEnabled = result.registration_enabled !== false;
      recordDiagnostic("paid.login.readiness",{available:loginReady,error_code:result.code||"",outcome:loginReady?"ok":"unavailable"},apiBase());
      serviceIssue = loginReady ? "" : String(result.message || "Email sign-in is not ready. Contact the operator.");
      if (!loginReady) status(serviceIssue, "warning");
      else if (!challenge) status("");
    } catch (error) {
      if (id !== statusRequestId || error.code === "STALE_PAID_RESPONSE") return;
      loginReady = false;
      serviceIssue = error.status && error.status < 500 ? error.message :
        "The payment server is temporarily unavailable. Your settings are kept. Reconnecting automatically.";
      status("You can continue when the connection is restored.", "warning");
    } finally {
      if (id === statusRequestId) { statusLoading = false; toggleUi(); }
    }
  }

  async function clearSession() {
    recordDiagnostic("paid.session.cleared",{action:"clear_session"},apiBase());
    const previousScope = viewScope;
    viewScope = "";
    loginController.invalidate();
    token = ""; account = null; accountVerified = false; selected = ""; sessionBase = "";
    await writeSession({ paidSessionToken: "", paidModel: "", paidApiBase: "" });
    await viewCache.clear(previousScope);
  }

  async function writeSession(patch) {
    // Storage events may arrive before the write promise resolves. Recognize
    // this controller's commit without cancelling its own successful OTP flow.
    const entries = [];
    for (const key of ["paidSessionToken", "paidApiBase"]) {
      if (!(key in patch)) continue;
      const entry = {value:patch[key]};
      const queue = ownSessionWrites.get(key) || [];
      queue.push(entry); ownSessionWrites.set(key, queue.slice(-8));
      entries.push([key, entry]);
    }
    try { await setStorage(patch); }
    catch (error) {
      for (const [key, entry] of entries) {
        const queue = ownSessionWrites.get(key) || [];
        ownSessionWrites.set(key, queue.filter(item => item !== entry));
      }
      throw error;
    }
  }

  async function quoteContext(item,profile) {
    const raw=JSON.stringify([item.id,item.max_output,item.catalogue_pricing,item.pricing?.model_revision,
      item.pricing?.policy_revision,item.route_price_sync?.revision,item.model_capabilities,profile.thinking,profile.pageImage]);
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
    return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }
  function accountStatus() {
    const item=account?.models?.find(x=>x.id===selected);
    const error=item?.availability?.available===false ? 'PAID_MODEL_PAUSED' : item?.route_price_sync?.error_code;
    const centerMessage=error&&error===item?.route_quote_failure?.code?item.route_quote_failure.message:'';
    status(account?.paid_restriction?.blocked ? account.paid_restriction.reason === "refund_pending" ? "Paid is temporarily paused while your refund is calculated and confirmed. Your account and history remain available." : "Paid is restricted while the operator reviews a refund/dispute. Contact the operator. You can still view your account and history." : account?.paid_paused ? "Paid translation is temporarily paused. Your account is signed in and your credits remain available. Please try again later." :
      !paidModelInventoryReady(account) ? paidInventoryFailureMessage(account) :
      !account?.models?.length ? "No models are enabled for this account. Contact the operator." : error?centerMessage||paidQuoteFailureMessage(error):"",error||!paidModelInventoryReady(account)?'warning':'info');
  }
  async function refreshAccount({forceQuote=false}={}) {
    if(forceQuote)quoteOwed=true;
    if (!available || !active() || !token || loading || !initialized) return;
    stopPriceRefresh();
    const id = ++accountRequestId;
    const quoteRevision=profilePriceRevision;
    loading = true;
    try {
      let data = await request("/paid/me", { authenticated: true });
      if (id !== accountRequestId) return;
      if (!data.email || !validPaidAccountView(data, {requireModels:true})) throw new Error("The service returned an incomplete account. Try again.");
      data = paidInventoryDisplay(data, account);
      // A changed Center catalogue is a change signal: ask the quote again.
      const catalogue=JSON.stringify((data.models||[]).map(m=>[m.id,m.availability,m.max_output,m.pricing,m.catalogue_pricing,m.price_sync,m.model_capabilities]));
      const catalogueChanged=catalogue!==lastCatalogue;lastCatalogue=catalogue;
      serviceIssue = "";
      const currentScope = viewScope || await accountViewScope(sessionBase, token);
      if (id !== accountRequestId || disposed) return;
      viewScope = currentScope;
      const models = data.models;
      if (!models.some(item => item.id === selected)) selected = models[0]?.id || "";
      const needsQuote=data.price_quote_available===true && paidModelInventoryReady(data) && selected &&
        models.find(item=>item.id===selected)?.availability?.available!==false && state.paidTranslationSource!=='login';
      const priorFailure=account?.models?.find(x=>x.id===selected)?.route_quote_failure;
      const selectedItem=models.find(x=>x.id===selected);
      if(needsQuote)selectedItem.route_price_sync={...selectedItem.route_price_sync,status:'refreshing',account_policy_verified:false};
      account=data;accountVerified=true;email=data.email;
      if (els.aiPaidModel) {
        els.aiPaidModel.replaceChildren(...models.map(item => {
          const option = document.createElement("option");option.value=item.id;option.textContent=item.name||item.id;option.disabled=item.availability?.available===false;return option;
        }));els.aiPaidModel.value=selected;
      }
      // Publish fresh catalogue data without waiting for the selected route.
      // The route above remains unverified until its exact quote succeeds.
      accountStatus();toggleUi();
      await setStorage({paidModel:selected});
      if(id!==accountRequestId||disposed)return;
      await viewCache.remember(currentScope,'me',data);
      if(id!==accountRequestId||disposed)return;
      if(needsQuote){
        const quotedModel=selected;
        const entry=paidEntry(await getStorage([PAID_PROFILE_KEY]),apiBase(),quotedModel);
        if(id!==accountRequestId||disposed||quotedModel!==selected||quoteRevision!==profilePriceRevision)return;
        const item=models.find(x=>x.id===quotedModel);
        const context=await quoteContext(item,entry.profile);
        if(id!==accountRequestId||disposed||quotedModel!==selected||quoteRevision!==profilePriceRevision)return;
        if(!quoteOwed&&!catalogueChanged&&priorFailure?.context===context){
          item.route_quote_failure=priorFailure;
          item.route_price_sync={...item.route_price_sync,status:'unavailable',error_code:priorFailure.code,account_policy_verified:false};
        }else{
        try{
          quoteOwed=false;
          const quote=await request('/paid/price-quote',{authenticated:true,body:{model:quotedModel,
            max_tokens:Math.min(32768,item.max_output||8192),temperature:0.7,
            // A model without an AI think control is quoted (and sent)
            // with the provider default: Center receives no `thinking` field.
            ...(sendsProviderDefault(classifyThinkingState(item?.model_capabilities?.reasoning,{fresh:true}))
              ?{}:{thinking:entry.profile.thinking}),image:entry.profile.pageImage==='always'}});
          if(id!==accountRequestId||disposed||quotedModel!==selected||quoteRevision!==profilePriceRevision)return;
          const latest=paidEntry(await getStorage([PAID_PROFILE_KEY]),apiBase(),quotedModel);
          if(id!==accountRequestId||disposed||quotedModel!==selected||quoteRevision!==profilePriceRevision)return;
          if(latest.profile.thinking!==entry.profile.thinking||latest.profile.pageImage!==entry.profile.pageImage){
            profilePriceRevision++;priceRefreshPending=true;return;
          }
          if(!paidModelRates({pricing:quote?.pricing})||quote?.route?.basis!=='paired_endpoint_metadata')throw new Error('Invalid price quote');
          item.pricing={...quote.pricing};
          item.route_price_sync={status:'current',checked_at:quote.route.checked_at,revision:quote.route.revision,account_policy_verified:false};
          delete item.route_quote_failure;
        }catch(error){
          if(id!==accountRequestId||disposed||error.code==='STALE_PAID_RESPONSE'||quotedModel!==selected||quoteRevision!==profilePriceRevision)return;
          if(error.status===401)throw error;
          item.pricing={status:'unavailable',unit:'TP_PER_1000_TOKENS',input_tp:null,output_tp:null,basis:'paired_endpoint_metadata'};
          const code=/^PAID_[A-Z_]{1,80}$/.test(error.code||'')?error.code:'PAID_PRICE_CHECK_UNAVAILABLE';
          item.route_price_sync={...item.route_price_sync,status:code==='PAID_PRICE_REFRESHING'?'refreshing':'unavailable',error_code:code,account_policy_verified:false};
          if(isPermanentPaidQuoteFailure(code))item.route_quote_failure={code,context};
        }
        }
      }
      if(quoteRevision!==profilePriceRevision)return;
      account=data;accountVerified=true;email=data.email;
      await viewCache.remember(currentScope,'me',data);
      if(id!==accountRequestId||disposed||quoteRevision!==profilePriceRevision)return;
      accountStatus();
    } catch (error) {
      if (id !== accountRequestId || error.code === "STALE_PAID_RESPONSE") return;
      accountVerified = false;
      if (error.status === 401) {
        await clearSession();
        status("Your session has expired. Sign in again to continue.", "warning");
        const expiredEpoch = identityEpoch;
        await checkLoginStatus(true);
        if (!disposed && expiredEpoch === identityEpoch && !token)
          status("Your session has expired. Sign in again to continue.", "warning");
      } else {
        serviceIssue = error.status && error.status < 500 ? error.message :
          "The payment server is temporarily unavailable. You are not signed out. Reconnecting automatically.";
        status(account ? "Showing the last loaded balance. Translation is paused until reconnected." : "Restoring your saved session…", "warning");
      }
    } finally {
      if (id === accountRequestId) { loading = false; accountReadAt = now(); toggleUi(); }
      if(id===accountRequestId&&priceRefreshPending&&!disposed){priceRefreshPending=false;queueMicrotask(()=>void refreshAccount());}
    }
  }

  function setAvailability(value, reportedBase, details) {
    const nextBase = safeApiBase(reportedBase || els.apiUrl?.value);
    const nextAvailable = value === true && configuredApiBase() && nextBase === inputBase();
    const changed = nextBase !== base;
    const recovered = nextAvailable && !available;
    metadataIssue = details?.reason === 'metadata_unavailable'
      ? 'Could not refresh account and model availability. Showing previous values; translation is paused. Retrying automatically.' : '';
    if (changed || value === false) {
      cancelRequests(); accountVerified = false; loginReady = false; statusCheckedAt = 0;
      serviceIssue = ""; stopTimer();
      if (changed) capability = null;
    }
    base = nextBase;
    available = Boolean(nextAvailable);
    if (value === true || value === false) capability = value;
    if (!available) { accountVerified = false; loginReady = false; }
    if (available) {
      knownBase = base;
      void setStorage({ paidServiceApiBase: base });
      // Never forward a customer's token to a newly selected API, including a
      // token without a saved origin from an old install.
      if (token && sessionBase !== base) {
        void clearSession(); challenge = null;
        void setStorage({ paidPendingLogin: null });
        status("API URL changed. Sign in again on this service.", "warning");
      }
    }
    if (changed && account && sessionBase !== nextBase) {
      account = null; void viewCache.clear(viewScope); viewScope = "";
    }
    if (els.aiService) els.aiService.value = mode;
    toggleUi();
    if (initialized && active() && available && (recovered || changed)) {
      if (token) void refreshAccount(); else void checkLoginStatus(true);
    }
  }

  async function initialize() {
    const expected = identityEpoch;
    const values = {...await getStorage(["paidTranslationSource", "loginProvider", "loginModel", "aiServiceMode", "paidSessionToken", "paidModel", "paidEmail", "paidApiBase", "paidServiceApiBase", "paidPendingLogin", "paidDeviceIds"]),
      ...await getLoginSession(["loginSessionId", "loginAccountId"]).catch(()=>({}))};
    if (disposed || expected !== identityEpoch) return;
    mode = values.aiServiceMode === "paid" ? "paid" : "manual";
    token = String(values.paidSessionToken || ""); selected = String(values.paidModel || "");
    sessionBase = safeApiBase(values.paidApiBase); email = String(values.paidEmail || "");
    if (token && sessionBase && sessionBase === inputBase() && configuredApiBase()) {
      const restoredScope = await accountViewScope(sessionBase, token);
      if (disposed || expected !== identityEpoch) return;
      const restored = await viewCache.restore(restoredScope, 'me', {allowStale:true});
      if (disposed || expected !== identityEpoch) return;
      const current = await getStorage(["paidSessionToken", "paidApiBase"]);
      if (disposed || expected !== identityEpoch) return;
      if (String(current.paidSessionToken || "") !== token || safeApiBase(current.paidApiBase) !== sessionBase) {
        storageChanged({paidSessionToken:{newValue:current.paidSessionToken},paidApiBase:{newValue:current.paidApiBase}}, "local", true);
        return;
      }
      viewScope = restoredScope;
      account = restored;
      if (account && els.aiPaidModel) {
        els.aiPaidModel.replaceChildren(...account.models.map(item => {
          const option = document.createElement("option"); option.value = item.id; option.textContent = item.name || item.id; return option;
        }));
        els.aiPaidModel.value = selected;
      }
    }
    await loginController.initialize(values,{apiBase:token&&sessionBase===inputBase()&&configuredApiBase()?sessionBase:'',token,account});
    if (disposed || expected !== identityEpoch) return;
    knownBase = safeApiBase(values.paidServiceApiBase) || sessionBase || knownBase;
    const saved = values.paidPendingLogin;
    challenge = saved && safeApiBase(saved.apiBase) === inputBase() && saved.expiresAt > now() &&
      saved.expiresAt <= now() + 30 * 60000 && typeof saved.email === "string" ? saved : null;
    if (els.aiPaidEmail) els.aiPaidEmail.value = email;
    if (els.aiService) els.aiService.value = mode;
    initialized = true;
    if (challenge?.traceId && /^[A-Za-z0-9_-]{1,120}$/.test(challenge.traceId)) status({template: "Request received; email delivery not confirmed. Support reference: {reference}", values: {reference: challenge.traceId}});
    if (available && token && sessionBase !== apiBase()) await clearSession();
    toggleUi();
    if (active() && available) {
      if (token) await refreshAccount({forceQuote:true}); else await checkLoginStatus(true);
    }
  }

  async function reconnect() {
    if (reconnecting || disposed) return;
    reconnecting = true; syncLoginControls();
    try {
      // A successful health snapshot is not a Paid catalogue. Always re-read
      // the same API's metadata before resuming account requests.
      await recheckApi?.();
      if (available) { if (token) await refreshAccount({forceQuote:true}); else await checkLoginStatus(true); }
    } finally { reconnecting = false; toggleUi(); }
  }

  async function sendCode(event, resend = false) {
    event?.preventDefault?.();
    const flowId=diagnosticId();
    recordDiagnostic("paid.otp.submit",{trace_id:flowId,action:resend?"resend":"request_code",available,configured:loginReady,session_present:!!token},apiBase());
    if (!active() || !available || !loginReady || sending || verifying || token) {
      recordDiagnostic("paid.otp.not_sent",{trace_id:flowId,reason:!active()?"MANUAL_MODE":!available?"API_UNAVAILABLE":!loginReady?"EMAIL_NOT_READY":token?"ALREADY_SIGNED_IN":"REQUEST_IN_PROGRESS",outcome:"blocked"},apiBase());return;
    }
    if (resend && (!challenge || challenge.resendAt > now())) {
      recordDiagnostic("paid.otp.not_sent",{trace_id:flowId,reason:"LOCAL_RESEND_COOLDOWN",outcome:"blocked"},apiBase());return;
    }
    const value = String(resend ? challenge.email : els.aiPaidEmail?.value || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
      recordDiagnostic("paid.otp.not_sent",{trace_id:flowId,reason:"EMAIL_INPUT_INVALID",outcome:"blocked"},apiBase());
      status("Enter a valid email address.", "error"); els.aiPaidEmail?.focus?.(); return;
    }
    const epoch = identityEpoch;
    sending = true; syncLoginControls();
    try {
      recordDiagnostic("paid.otp.requested",{trace_id:flowId,action:"request_code"},apiBase());
      const deviceId = await deviceHint();
      const language = await getStorage([UI_LANGUAGE_KEY]);
      const uiLanguage = normalizeUiLanguage(language?.[UI_LANGUAGE_KEY]) || "en";
      if (epoch !== identityEpoch) return;
      const result = await request("/paid/auth/request", { traceId:flowId, body: { email: value, ui_language: uiLanguage, ...(deviceId ? { device_id: deviceId } : {}) } });
      if (result.ok !== true) throw new Error("The service could not request a code. Try again.");
      email = value;
      // UI continuity only. The server owns actual OTP expiry/rate limits.
      const cooldown = Math.min(600, Math.max(60, Number(result.resend_after_seconds) || 60));
      recordDiagnostic("paid.otp.receipt", { trace_id: flowId, outcome: "received", request_status: result.request_status || "received", delivery_status: result.delivery_status || "unconfirmed", retry_after_ms: cooldown * 1000 }, apiBase());
      challenge = { apiBase: apiBase(), email, traceId: flowId, resendAt: now() + cooldown * 1000, expiresAt: now() + 10 * 60000 };
      await setStorage({ paidEmail: email, paidPendingLogin: challenge });
      if (epoch !== identityEpoch) return;
      status({template: "Request received. Delivery is not confirmed yet. No code? Share this reference with support: {reference}", values: {reference: flowId}});
      if (els.aiPaidCode) els.aiPaidCode.value = "";
      toggleUi(); els.aiPaidCode?.focus?.();
    } catch (error) {
      if (epoch !== identityEpoch || error.code === "STALE_PAID_RESPONSE") return;
      status(error.message, "error");
      if (!error.status || error.status >= 500) { loginReady = false; serviceIssue = "Connection interrupted. Check your inbox before requesting another code."; }
    } finally { if (epoch === identityEpoch) { sending = false; toggleUi(); } }
  }

  async function verifyCode(event) {
    event?.preventDefault?.();
    const flowId=diagnosticId();
    recordDiagnostic("paid.otp.verify_submit",{trace_id:flowId,available,configured:loginReady,session_present:!!token},apiBase());
    if (!active() || !available || !loginReady || verifying || sending || token) {
      recordDiagnostic("paid.otp.verify_not_sent",{trace_id:flowId,reason:!available?"API_UNAVAILABLE":!loginReady?"EMAIL_NOT_READY":"INVALID_UI_STATE",outcome:"blocked"},apiBase());return;
    }
    const value = String(challenge?.email || els.aiPaidEmail?.value || "").trim();
    const code = String(els.aiPaidCode?.value || "").trim();
    if (!/^[0-9]{6}$/.test(code)) { recordDiagnostic("paid.otp.verify_not_sent",{trace_id:flowId,reason:"CODE_FORMAT_INVALID",outcome:"blocked"},apiBase()); status("Enter the 6-digit email code.", "error"); return; }
    const epoch = identityEpoch;
    verifying = true; syncLoginControls();
    try {
      recordDiagnostic("paid.otp.verify_requested",{trace_id:flowId,action:"verify_code",code_present:!!code},apiBase());
      const data = await request("/paid/auth/verify", { traceId:flowId, body: { email: value, code } });
      const nextToken = String(data.token || "");
      if (!nextToken) throw new Error("The service did not create a session. Try again.");
      const nextSessionBase = apiBase();
      await writeSession({ paidSessionToken: nextToken, paidEmail: value, paidApiBase: nextSessionBase, paidPendingLogin: null });
      if (epoch !== identityEpoch) return;
      token = nextToken; email = value; sessionBase = nextSessionBase; challenge = null;
      if (els.aiPaidCode) els.aiPaidCode.value = "";
      recordDiagnostic("paid.otp.verified", { trace_id: flowId, outcome: "verified", registered: data.registered === true }, apiBase());
      status(data.registered ? "Account created. Loading your credits…" : "Restoring your account…"); toggleUi();
      await refreshAccount();
    } catch (error) {
      if (epoch !== identityEpoch || error.code === "STALE_PAID_RESPONSE") return;
      status(error.message, "error");
      if (!error.status || error.status >= 500) { loginReady = false; serviceIssue = "Connection interrupted. Your code has not been retried automatically."; }
    } finally { if (epoch === identityEpoch) { verifying = false; toggleUi(); } }
  }

  listen(els.aiService, "change", async () => {
    const flushed = await beforeSwitch?.();
    if (flushed?.ok === false) { els.aiService.value = mode; status("Could not save current AI settings. Service was not changed.", "error"); return; }
    mode = els.aiService.value === "paid" ? "paid" : "manual";
    recordDiagnostic("paid.mode.changed",{mode},apiBase());
    cancelRequests(); stopTimer();
    await setStorage({ aiServiceMode: mode }); toggleUi();
    await onUsageSelection?.();
    if (active() && available) { if (token) void refreshAccount(); else void checkLoginStatus(true); }
    else if (active()) void reconnect();
  });
  listen(els.aiPaidCheck, "click", () => void reconnect());
  // Real forms support Enter, autocomplete and native accessibility. The click
  // fallback keeps controller consumers without form wrappers compatible.
  if (els.aiPaidEmailStep) listen(els.aiPaidEmailStep, "submit", sendCode);
  else listen(els.aiPaidSend, "click", sendCode);
  if (els.aiPaidCodeStep) listen(els.aiPaidCodeStep, "submit", verifyCode);
  else listen(els.aiPaidVerify, "click", verifyCode);
  listen(els.aiPaidResend, "click", event => void sendCode(event, true));
  listen(els.aiPaidChangeEmail, "click", async () => {
    if (sending || verifying) return;
    challenge = null; stopCooldown();
    await setStorage({ paidPendingLogin: null });
    if (els.aiPaidCode) els.aiPaidCode.value = "";
    status(""); toggleUi(); els.aiPaidEmail?.focus?.();
  });
  listen(els.aiPaidCode, "input", () => {
    els.aiPaidCode.value = els.aiPaidCode.value.replace(/[^0-9]/g, "").slice(0, 6);
  });
  listen(els.aiPaidModel, "change", async () => {
    if (!account?.models?.length || !paidModelInventoryReady(account) || els.aiPaidModel.disabled) return;
    const flushed = await beforeSwitch?.();
    if (flushed?.ok === false) { els.aiPaidModel.value = selected; status("Could not save current AI settings. Model was not changed.", "error"); return; }
    stopPriceRefresh();selected = String(els.aiPaidModel.value || "");profilePriceRevision++;
    const item=account?.models?.find(x=>x.id===selected);
    if(item&&state.paidTranslationSource!=='login')item.route_price_sync={...item.route_price_sync,status:'refreshing',error_code:undefined,account_policy_verified:false};
    await setStorage({ paidModel: selected }); accountStatus();toggleUi();
    queueRefresh(true);
    await onUsageSelection?.();
  });
  const openAccount = async tab => {
    if (!token || sessionBase !== inputBase() || !configuredApiBase()) { status("Sign in on the saved API before opening your account.", "warning"); return; }
    try { await inlineAccount?.open(tab); }
    catch (error) { status(error.message || "Could not open the account page.", "error"); }
  };
  for(const control of [els.aiThinking,els.aiPageImage])listen(control,'change',()=>{
    if(accountVerified&&state.paidTranslationSource!=='login'){
      profilePriceRevision++;
      if(loading)priceRefreshPending=true;else queueMicrotask(()=>void refreshAccount());
    }
  });
  listen(els.aiPaidBuy, "click", () => void openAccount("buy"));
  listen(els.aiPaidDetails, "click", () => void openAccount("details"));
  listen(els.aiPaidRefresh, "click", () => void reconnect());
  listen(els.aiPaidLogout, "click", async () => {
    const canRevoke = available && token && sessionBase === apiBase();
    cancelRequests();
    // Clear this device immediately even if server-side revocation is offline.
    const revocation = canRevoke ? request("/paid/auth/logout", { body: {}, authenticated: true }).catch(() => {}) : Promise.resolve();
    await inlineAccount?.close({forget:true}); await clearSession(); challenge = null;
    await setStorage({ paidPendingLogin: null });
    status("Signed out on this device."); toggleUi();
    void revocation;
    if (active() && available) void checkLoginStatus(true);
  });
  const storageChanged = (changes, area, storedMismatch = false) => {
    if (disposed || area !== "local") return;
    let identityChanged = storedMismatch;
    for (const [key, current] of [["paidSessionToken", token], ["paidApiBase", sessionBase]]) {
      if (!(key in changes)) continue;
      const next = String(changes[key].newValue || "");
      const queue = ownSessionWrites.get(key) || [];
      const index = queue.findIndex(item => String(item.value || "") === next);
      if (index >= 0) { queue.splice(index, 1); continue; }
      if (next !== current) identityChanged = true;
    }
    const oldConfigured = configuredAccountBase({customApiUrl:state.lastSavedApiUrl,apiUrlDefault:state.apiDefaults?.defaultApiUrl});
    if ("customApiUrl" in changes) state.lastSavedApiUrl = String(changes.customApiUrl.newValue || "");
    if ("apiUrlDefault" in changes) {
      state.apiDefaults = {...state.apiDefaults,defaultApiUrl:String(changes.apiUrlDefault.newValue || "")};
    }
    const nextConfigured = configuredAccountBase({customApiUrl:state.lastSavedApiUrl,apiUrlDefault:state.apiDefaults?.defaultApiUrl});
    const apiChanged = oldConfigured !== nextConfigured;
    if (!identityChanged && !apiChanged) {
      if(PAID_PROFILE_KEY in changes&&accountVerified&&state.paidTranslationSource!=='login'){
        profilePriceRevision++;
        if(loading)priceRefreshPending=true;else void refreshAccount();
      }
      return;
    }
    const previousScope = viewScope;
    cancelRequests(); stopTimer(); stopCooldown();
    // Revoke authority and remove the former account before any asynchronous
    // storage/cache read can restore the replacement account.
    initialized = false;
    token = sessionBase = email = selected = viewScope = "";
    account = null; accountVerified = loginReady = false;
    loginController.invalidate();
    challenge = null; serviceIssue = ""; statusCheckedAt = 0;
    if (apiChanged) {
      available = false; capability = null;
      if (inputBase() === oldConfigured && els.apiUrl) els.apiUrl.value = nextConfigured;
    }
    state.paidReady = false;
    renderAccount(); toggleUi();
    if (previousScope) void viewCache.clear(previousScope);
    const expected = identityEpoch;
    void initialize().catch(error => {
      if (!disposed && expected === identityEpoch) {
        status(error.message || "Could not restore the selected account.", "warning"); toggleUi();
      }
    });
    if (apiChanged) void recheckApi?.();
  };
  globalThis.chrome?.storage?.onChanged?.addListener?.(storageChanged);
  listeners.push(() => globalThis.chrome?.storage?.onChanged?.removeListener?.(storageChanged));
  globalThis.chrome?.storage?.onChanged?.addListener?.(changeSignal);
  listeners.push(() => globalThis.chrome?.storage?.onChanged?.removeListener?.(changeSignal));
  listen(els.apiUrl,'input',stopPriceRefresh);
  // Back in view (a pinned settings tab): one re-read, then only on signals.
  listen(globalThis.document,'visibilitychange',()=>{
    if(globalThis.document?.visibilityState==='hidden'){stopPriceRefresh();return;}
    if(retryNeeded()){stopTimer();scheduleRecovery();if(token)void refreshAccount({forceQuote:true});else void checkLoginStatus(true);}
    else signalRefresh('visible',{gapMs:60000,force:true});
  });
  function dispose() { recordDiagnostic("paid.ui.closed",{pending:pending.size},apiBase()); disposed = true; loginController.dispose(); for (const remove of listeners.splice(0)) remove(); inlineAccount?.dispose(); accountViewport(false);stopTimer(); stopCooldown(); cancelRequests(); }
  return { initialize, setAvailability, applyVisibility, reconnect, dispose };
}
