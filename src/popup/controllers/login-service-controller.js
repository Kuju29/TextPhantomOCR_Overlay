import { LOGIN_PENDING_AUTH, LOGIN_OUTCOME, loginAuthScope, loginCallbackMetadata } from "../../shared/login-auth.js";
import { getLoginSession, setLoginSession } from "../../shared/login-session.js";
import { createTab } from "../../shared/browser-api.js";
import {createLoginViewCache,authenticationOnlyStatus} from './login-view-cache.js';
import { setUiText, setUiTemplate } from "../../shared/ui-template.js";
import { setTip } from "../../shared/hover-tip.js";
import { loginModelUnavailable, loginModelPlanBadge } from "../../shared/login-profile.js";
import { COOKIE_LOGIN_PROVIDERS, DATA_CONSENT_REQUIRED, hasDataConsent } from "../../shared/data-consent.js";
import { dataConsentKnown, consentText } from "../../shared/data-consent-dialog.js";
import { readAccountSession, showConsentScreen, accountReplay } from "../../shared/account-gate.js";
/** Login is an own-account source. UI state never grants the add-on. */
const show = (el, visible) => {
  if (el) el.style.display = visible ? "" : "none";
};
const text = (el, value) => {
  if (el) el.textContent = value;
};
const safeProvider = (value) =>
  /^login_(chatgpt|claude|gemini|deepseek)$/.test(value);
const providerNames = {login_chatgpt:"ChatGPT", login_gemini:"Gemini", login_claude:"Claude", login_deepseek:"DeepSeek"};
// Claude runs through this browser's own claude.ai tab and is supported.
// ChatGPT translation is available (Sign in with ChatGPT for paid plans, website tab for free).
const improvingProvider=value=>[].includes(value);
const browserTabProvider=value=>value==='login_claude'||value==='login_chatgpt';
const tabSite={login_claude:'claude.ai',login_chatgpt:'chatgpt.com'};
const stageMessage = value => ({callback_wait:"Waiting for provider sign-in", awaiting_provider:"Waiting for provider sign-in", session_validation:"Checking the provider website session", composer_detection:"Checking the provider chat input", provider_challenge:"Complete verification in the provider tab", browser_ready:"Provider website is ready", token_exchange:"Exchanging the authorization code", identity:"Verifying your provider account", model_catalogue:"Loading available models", entitlement:"Verifying your Login access", entitlement_recheck:"Rechecking your Login access", session_binding:"Connecting your account", provider_registration:"Checking provider configuration", status_network:"Status connection interrupted; retrying", chatgpt_official_consent:"Allow TextPhantom in the ChatGPT tab (Sign in with ChatGPT)", endpoint_validation:"Checking the connection from this browser"}[value] || "Verifying your connection");
// First model the account can use (a website-refused model is never auto-selected).
const firstUsable = rows => rows.find(row => !loginModelUnavailable(row))?.id || "";
const UNAVAILABLE_MODEL = "Not available on this account's plan";
// claude.ai's plan badges for disabled chat-picker models (10492 evidence).
const PLAN_LABELS = Object.freeze(["Needs Pro", "Needs Pro or Max"]);
const planLabel = badge => PLAN_LABELS.find(label => label.slice(label.indexOf(" ") + 1) === badge) || "";
// A shared API refuses cookie-session Logins (Gemini, DeepSeek).
const SHARED_COOKIE_REASON = "shared_deployment_cookie_session";
const sharedCookieDisabled = p => p?.reason === "disabled" && p?.disabled_reason === SHARED_COOKIE_REASON;
const SHARED_COOKIE_MESSAGE = "Not available on this shared API: this Login would send your website session cookies to a server other people use. Use your own local or self-hosted API.";
const SELECTED_UNAVAILABLE = "The selected model is not available on this account's plan (it may need an upgrade on the website). Choose another model; translation will not start with this one.";
const checkedModels = value => {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' ||
    typeof row.id !== 'string' || !row.id.trim() || row.id.length > 200) ||
    new Set(value.map(row => row.id)).size !== value.length)
    throw new Error('The provider returned an invalid model list. Previous models are shown; refresh to try again.');
  return value;
};
export function createLoginServiceController({
  els,
  state,
  request,
  getStorage,
  setStorage,
  toggleUi,
  beforeSwitch,
  onUsageSelection,
  readAuth = getLoginSession,
  writeAuth = setLoginSession,
  now = Date.now,
}) {
  let initialized = false,
    disposed = false,
    source = "tp",
    provider = "login_chatgpt",
    selected = "",
    session = null;
  let scope = "",
    verified = false,
    pending = false,
    loading = false,
    attempted = false,
    list = [],
    models = [],
    epoch = 0,
    flow = null,
    timer = null,
    lastFailure = "", lastLoadFailure = "",
    appliedOutcome = "";
  let authority=false,accountProblem=false,displayLoaded=false,displaySignedIn=false,cacheScope='',statusMessage='',statusKind='info',providerSignature='',modelSignature='';
  const viewCache=createLoginViewCache({read:readAuth,write:writeAuth,now});
  const displayCache=createLoginViewCache({read:getStorage,write:setStorage,now,displayOnly:true});
  const clearView=hash=>Promise.all([viewCache.clear(hash),displayCache.clear(hash)]);
  const rejectedFlows=new Set();
  const rejectFlow=id=>{if(!id)return;rejectedFlows.add(id);if(rejectedFlows.size>64)rejectedFlows.delete(rejectedFlows.values().next().value);};
  const signInAvailable=()=>{const item=list.find(row=>row.id===provider);return item?.sign_in_available??item?.available??false;};
  // The API decides availability; a provider still under test keeps its "not supported yet" label.
  const translationAvailable=()=>{const item=list.find(row=>row.id===provider);return item?.available===true&&item.translation_supported!==false;};
  const listeners = [];
  function listen(el, name, fn) {
    if (!el) return;
    el.addEventListener(name, fn);
    listeners.push(() => el.removeEventListener(name, fn));
  }
  const message = (value, kind = "info") => {
    statusMessage=value;statusKind=kind;
    setUiText(els.aiLoginStatus, value);
    els.aiLoginStatus?.setAttribute("data-kind", kind);
  };
  async function rememberView(expected=epoch){
    const savedScope=scope;if(!savedScope||disposed||expected!==epoch)return;
    const [apiBase,token]=JSON.parse(savedScope),hash=await loginAuthScope(apiBase,token);
    if(disposed||expected!==epoch||scope!==savedScope)return;
    cacheScope=hash;
    const live=async()=>{
      // 10495: the session only through the account gate.
      const current=await readAccountSession({read:getStorage,keys:['loginProvider','loginModel']});
      return !disposed&&expected===epoch&&scope===savedScope&&current.ok&&current.token===token&&
        current.base===apiBase&&current.values.loginProvider===provider&&String(current.values.loginModel||'')===selected;
    };
    const value={provider,selected,session,signedIn:displaySignedIn,list,models,status:statusMessage,kind:statusKind};
    await Promise.all([viewCache.remember(hash,value,live),displayCache.remember(hash,value,live)]);
  }
  const persist = async () => {
    const expected = epoch, savedScope = scope;
    const snapshot = {source,provider,model:selected,session:session ? structuredClone(session) : null};
    let connections;
    if (snapshot.session && verified && savedScope) {
      const [apiBase,token] = JSON.parse(savedScope);
      const key = await loginAuthScope(apiBase,token) + ":" + snapshot.provider;
      const saved = await readAuth(["loginConnectionsV2"]);
      connections = {...(saved.loginConnectionsV2 || {}), [key]:{session:snapshot.session,model:snapshot.model,verifiedAt:now()}};
      const ordered = Object.entries(connections).sort((a,b)=>(b[1]?.verifiedAt||0)-(a[1]?.verifiedAt||0));
      connections = Object.fromEntries(ordered.slice(0,32));
    }
    if (disposed || epoch !== expected || scope !== savedScope || provider !== snapshot.provider || selected !== snapshot.model) return;
    await writeAuth({loginSessionId:snapshot.session?.id || "", loginAccountId:snapshot.session?.account_id || "", ...(connections ? {loginConnectionsV2:connections} : {})});
    if (disposed || epoch !== expected || scope !== savedScope || provider !== snapshot.provider || selected !== snapshot.model) return;
    return setStorage({paidTranslationSource:snapshot.source,loginProvider:snapshot.provider,loginModel:snapshot.model});
  };
  const owned = (account) =>
    account?.addons?.entitlements?.some(
      (x) => x.code === "ai_login" && x.status === "active",
    ) === true;
  const failureText = error => [error.message || "AI Login failed.", error.code, error.stage && "Stage: " + error.stage,
    error.upstreamStatus && "Provider HTTP: " + error.upstreamStatus, (error.traceId || error.trace_id) && "Trace: " + (error.traceId || error.trace_id)].filter(Boolean).join(" · ");
  // .73: the remembered list is selectable until the API reports a problem
  // (its own load, or the account/service read the Paid controller reports).
  const memoryChoice = () => displayLoaded && !lastFailure && !lastLoadFailure && !accountProblem;
  function failure(error) { lastFailure = failureText(error); message(lastFailure, "warning"); }
  function clearLoadFailure() {
    if (lastLoadFailure && lastFailure === lastLoadFailure) lastFailure = '';
    lastLoadFailure = '';
  }
  function render() {
    const displaySession=Boolean(session)||displaySignedIn;
    state.paidTranslationSource = source;
    state.loginProvider = provider;
    state.loginModel = selected;
    state.loginSessionId = session?.id || "";
    state.loginAccountId = session?.account_id || "";
    state.loginDispatchModel =
      session && selected ? session.id + "/" + selected : "";
    state.loginAuthenticated = authority && verified && Boolean(session);
    state.loginSupportStatus=improvingProvider(provider)?'under_improvement':translationAvailable()?'supported':'unavailable';
    state.loginConnected = state.loginAuthenticated && translationAvailable() && models.some(row=>row.id===selected);
    state.loginModelCapabilities = state.loginConnected
      ? models.find((x) => x.id === selected)?.model_capabilities || {}
      : {};
    // The connected session's model row is the fresh AI think record.
    state.loginModelCapabilitiesFresh = state.loginConnected === true;
    // A saved model the website refused stays selected and visible, and
    // translation stops before sending anything (background resolver).
    state.loginModelUnavailable = loginModelUnavailable(models.find(row => row.id === selected));
    if (state.loginModelUnavailable && statusMessage !== SELECTED_UNAVAILABLE) message(SELECTED_UNAVAILABLE, "warning");
    if (els.aiPaidSource) els.aiPaidSource.value = source;
    if (els.aiLoginProvider) {
      const choices = list.length ? list : Object.entries(providerNames).map(([id,name]) => ({id,name}));
      const signature=JSON.stringify(choices.map(p=>[p.id,p.name,p.available,p.reason,p.disabled_reason,p.translation_supported,p.sign_in_available,list.length>0,p.id===provider&&displaySession]));
      if(signature!==providerSignature){providerSignature=signature;els.aiLoginProvider.replaceChildren(...choices.map(p => {
        const option = document.createElement("option"); option.value = p.id;
        option.textContent = p.name + (improvingProvider(p.id) ? " · Not supported yet" : !list.length ? p.id===provider&&displaySession ? "" : " · Checking…" : p.available ? "" : p.reason === "setup_required" ? " · Setup required" : sharedCookieDisabled(p) ? " · Own API only" : p.reason === "disabled" ? " · Disabled" : ["official_registration_required","endpoint_browser_proof_required","consumer_endpoint_not_implemented"].includes(p.reason) ? " · Endpoint unavailable" : " · Unavailable");
        return option;
      }));}
      els.aiLoginProvider.value = provider;
    }
    show(els.aiLoginProjectWrap, false);
    if (els.aiLoginConnect) {
      els.aiLoginConnect.disabled =
        pending || !authority || !signInAvailable();
      els.aiLoginConnect.textContent = pending && flow
        ? "Waiting for sign-in…"
        : displaySession
          ? "Reconnect"
          : "Sign in";
    }
    if (els.aiLoginRefresh) els.aiLoginRefresh.disabled = pending || !authority;
    if (els.aiLoginLogout) els.aiLoginLogout.disabled = pending || !authority;
    show(els.aiLoginLogout, Boolean(session));
    show(els.aiLoginCancel, Boolean(flow));
    show(els.aiLoginModelWrap, displaySession && (models.length > 0 || !improvingProvider(provider)));
    if (els.aiLoginModel) {
      const desired = selected;
      const signature=JSON.stringify(models.map(row=>[row.id,row.name,loginModelUnavailable(row),loginModelPlanBadge(row)]));
      if(signature!==modelSignature){modelSignature=signature;els.aiLoginModel.replaceChildren(
        ...models.map((item) => {
          const option = document.createElement("option");
          option.value = item.id;
          option.textContent = item.name || item.id;
          // Shown, but not selectable; a saved one stays visible as unavailable.
          if (loginModelUnavailable(item)) {
            option.disabled = true;
            option.setAttribute("data-unavailable", "plan");
            // The website's own plan badge when it names one (claude.ai: "Pro", "Pro or Max").
            const badge = loginModelPlanBadge(item);
            setUiText(option, (item.name || item.id) + " · " + (planLabel(badge) || UNAVAILABLE_MODEL + (badge ? " · " + badge : "")));
          }
          return option;
        }),
      );}
      els.aiLoginModel.value = desired;
      // A remembered model list is selectable immediately (saved and
      // re-validated by the background read) until the API reports a problem.
      els.aiLoginModel.disabled = !((verified && authority) || memoryChoice()) || !translationAvailable() || !models.some(row=>row.id===selected);
    }
    // 10496: what Login is and how the website tab is used is the explanation
    // of the "Provider" name (hover/focus/tap); only live state stays inline:
    // the signed-in line and, while signed in to a website-tab provider, the
    // warning that matters during translation (closing the tab stops it; the
    // page itself shows LOGIN_WORK_TAB_CLOSED when that happens).
    text(els.aiLoginAccount, displaySession ? "Signed in to your AI account" : "");
    const tabWarning = displaySession && browserTabProvider(provider) && !improvingProvider(provider);
    show(els.aiLoginSupport, tabWarning);
    if (tabWarning) setUiTemplate(els.aiLoginSupport, "Keep the {site} tab open while translating; closing it stops the translation.", { site: tabSite[provider] });
    else text(els.aiLoginSupport, "");
    setTip(els.aiLoginProviderTip, ["Use your own AI account",
      browserTabProvider(provider)?providerNames[provider]+" Login translates through one "+tabSite[provider]+" tab in this browser. An open one is used; if none is open, TextPhantom opens one in the background. TextPhantom never closes it — close it yourself when you are done. You can keep browsing other tabs. Keep the browser open and stay signed in; closing that tab during a translation stops it. If you translate before connecting, TextPhantom connects by itself.":
      "Your provider account quota applies. TP credits are not used."],
      { reason: improvingProvider(provider)?providerNames[provider]+" Login translation is not supported yet. It is under improvement. You can sign in and test translation; if the website requires browser checks, translation stops before anything is sent.":'' });
  }
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function discard({clearCache=false}={}) {
    rejectFlow(flow?.flow_id);
    if(clearCache&&cacheScope)void clearView(cacheScope);
    ++epoch;
    stop();
    pending = false;
    loading = false;
    attempted = false;
    verified = false;
    lastLoadFailure = '';
    list = [];
    models = [];
    session = null; displayLoaded=false;displaySignedIn=false;cacheScope='';
    scope = "";
    flow = null;
    lastFailure = "";
    appliedOutcome = "";
    message('');
    render();
  }
  async function applyOutcome(result, expected = epoch, fromLoad = false, initialDisplay = false) {
    if (!result || disposed || expected !== epoch || !scope || result.provider !== provider || !/^lgf_[a-f0-9]{48}$/.test(result.flow_id||'') || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) return false;
    if(rejectedFlows.has(result.flow_id))return false;
    if(flow&&(flow.flow_id!==result.flow_id||flow.expiresAt<=Date.now())){rejectFlow(result.flow_id);if(flow.expiresAt<=Date.now())rejectFlow(flow.flow_id);return false;}
    const savedScope = scope, [apiBase, token] = JSON.parse(savedScope);
    if (result.scope !== await loginAuthScope(apiBase, token) || disposed || expected !== epoch || scope !== savedScope) return false;
    const key = result.flow_id + ":" + result.status + ":" + (result.stage || "") + ":" + (result.code || "") + ":" + (result.sessionHttpStatus || "");
    if (key === appliedOutcome) return false;
    if (result.status === "failed") {
      appliedOutcome = key;
      stop(); flow = null; pending = loading;
      failure(result); render(); toggleUi(); return true;
    }
    if (result.status === "connected") {
      if (result.session?.transport === "web_endpoint" && result.endpoint_validation !== "identity_verified") return false;
      if (!/^lgs_[a-f0-9]{48}$/.test(result.session?.id || "") || result.session.provider !== provider || !/^[a-f0-9]{32}$/.test(result.session.account_id || "")) return false;
      let nextModels;
      try { nextModels = checkedModels(result.models ?? []); } catch { return false; }
      appliedOutcome = key;
      if (!fromLoad) ++epoch;
      stop(); flow = null; pending = fromLoad&&!initialDisplay; loading = fromLoad&&!initialDisplay;
      session = result.session;displaySignedIn=true; models = nextModels;
      if (!models.some(x => x.id === selected)) selected = firstUsable(models);
      verified = !fromLoad; lastFailure = "";
      await persist();
      message(authenticationOnlyStatus(provider)||(result.chatgpt_mode==="official"?"Connected with Sign in with ChatGPT. Translations use your ChatGPT plan.":
        result.chatgpt_mode==="website"?"Connected through the chatgpt.com website in this browser"+(result.chatgpt_reason==="official_unavailable"||result.chatgpt_reason==="official_denied"?" (Sign in with ChatGPT is not available for this account)":"")+". Keep the browser open; TextPhantom uses a background ChatGPT tab.":
        "Provider identity verified on the API. Translation has not been tested yet; your website account quota applies."));
      displayLoaded=true;if(!fromLoad||initialDisplay)await rememberView();
      render(); toggleUi(); await onUsageSelection?.();
      if (!fromLoad && !list.length && !disposed) void load(epoch);
      return true;
    }
    if (result.status === "processing") {appliedOutcome=key;message([stageMessage(result.stage)+"…",result.code,result.sessionHttpStatus && "Session HTTP: "+result.sessionHttpStatus,result.traceId && "Trace: "+result.traceId].filter(Boolean).join(" · "));}
    return false;
  }
  async function load(expected = epoch) {
    if (pending || loading || disposed || !scope || !authority) return;
    loading = true;
    attempted = true;
    pending = true;
    verified=false;
    if(!displayLoaded||lastFailure)message(lastFailure || "Checking Login providers on the selected API…", lastFailure ? "warning" : "info");
    render();toggleUi();
    try {
      const savedAuth = await readAuth([LOGIN_PENDING_AUTH, LOGIN_OUTCOME]);
      await applyOutcome(savedAuth[LOGIN_OUTCOME], expected, true);
      if (expected !== epoch || disposed) return;
      const requestedProvider=provider,requestedModel=selected;
      const selectionCurrent=async()=>{
        const current=await getStorage(['loginProvider','loginModel']);
        if(expected!==epoch||disposed)return false;
        const currentProvider=safeProvider(current.loginProvider)?current.loginProvider:'login_chatgpt';
        if(currentProvider!==requestedProvider||String(current.loginModel||'')!==requestedModel){
          storageListener({loginProvider:{newValue:current.loginProvider},loginModel:{newValue:current.loginModel}},'local');return false;
        }
        return true;
      };
      const data = await request("/login/providers", { authenticated: true });
      if (expected !== epoch || disposed || !await selectionCurrent()) return;
      if (!Array.isArray(data.providers) || data.providers.some(row => !row || typeof row !== 'object'))
        throw new Error('The provider returned an invalid provider list. Previous details are shown; refresh to try again.');
      list = data.providers.filter(x => /^login_(chatgpt|claude|gemini|deepseek)$/.test(x.id));
      render();
      const saved = list.find((x) => x.id === provider)?.session;
      session = saved || null;
      displaySignedIn=Boolean(session);
      if (session) {
        const data = await request(
          "/login/providers/" +
            provider +
            "/models?session_id=" +
            encodeURIComponent(session.id),
          { authenticated: true },
        );
        if (expected !== epoch || disposed || !await selectionCurrent()) return;
        const nextModels = checkedModels(data.models);
        models = nextModels;
        if (!models.some((x) => x.id === selected))
          selected = firstUsable(models);
        verified = true;
        clearLoadFailure();
        if (!lastFailure) message(
          models.length ? "Your provider account quota applies. TP credits are not used."
            : authenticationOnlyStatus(provider) || "No models are available for this provider account. Refresh to try again.",
          improvingProvider(provider) || models.length ? 'info' : 'warning',
        );
      } else {
        verified = false;
        models = [];
        clearLoadFailure();
        const current = list.find((x) => x.id === provider);
        if (!lastFailure) message(
          (current?.sign_in_available??current?.available)
            ? "Login opens the provider website. Your session will be sent to the selected API; translation runs through its endpoints. API: " + JSON.parse(scope)[0]
            : ["official_registration_required","endpoint_browser_proof_required","consumer_endpoint_not_implemented"].includes(current?.reason)
              ? "ChatGPT browser-session endpoint translation is not implemented in this version. OAuth/client-ID registration is not required for this transport."
            : current?.reason === "setup_required"
              ? "The selected API needs its provider Login registration configured before sign-in."
              : current?.reason === "provider_policy"
                ? "This provider does not support subscription Login in this application."
                : sharedCookieDisabled(current)
                  ? SHARED_COOKIE_MESSAGE
                : current?.reason === "disabled"
                  ? "This Login provider is disabled on the selected API."
                  : current?.reason === "unsupported" || current?.supported === false
                    ? "This provider has no supported Login integration."
                    : "Cannot reach this Login provider. Refresh shortly.",
          (current?.sign_in_available??current?.available) ? "info" : "warning",
        );
      }
      await persist();
      displayLoaded=true;await rememberView(expected);
      const savedFlow = savedAuth[LOGIN_PENDING_AUTH];
      if (expected !== epoch || disposed || !scope) return;
      const [apiBase, token] = JSON.parse(scope);
      const savedScope = await loginAuthScope(apiBase, token);
      if (expected !== epoch || disposed || scope !== JSON.stringify([apiBase, token])) return;
      if (
        savedFlow?.provider === provider &&
        savedFlow.expiresAt > Date.now() &&
        savedFlow.scope === savedScope
      ) {
        flow = savedFlow;
        if (!lastFailure) message("Complete sign-in on the provider website, then return here.");
        if (!["browser_webchat","web_endpoint"].includes(savedFlow.transport)) void poll(expected);
      }
    } catch (error) {
      if (expected === epoch) {
        verified = false;
        failure(error);
        lastLoadFailure = lastFailure;
      }
    } finally {
      if (expected === epoch) {
        loading = false;
        pending = Boolean(flow);
        if (lastFailure) message(lastFailure, "warning");
        render();
        toggleUi();
      }
    }
  }
  function sync({ active, account, accountVerified, apiBase, token, locked = false, serviceProblem = false }) {
    const displayRight=owned(account),hasRight=accountVerified&&displayRight;
    authority=hasRight;accountProblem=serviceProblem===true;
    show(els.aiPaidSourceWrap, active && displayRight);
    if(els.aiPaidSource)els.aiPaidSource.disabled=!hasRight;
    const login = active && source === "login";
    show(els.aiPaidTpModel, active && !login);
    show(els.aiLoginPanel, login);
    const next =
      active && displayRight && token && apiBase
        ? JSON.stringify([apiBase, token])
        : "";
    if (next !== scope) {
      discard({clearCache:Boolean(scope&&(!next&&accountVerified || next&&next!==scope))});
      scope = next;
    }
    // Locked (data use not allowed): the controls are grey; nothing is checked.
    if (login && locked) message('');
    else if (login && !hasRight && !(displayRight&&displayLoaded))
      message(
        accountVerified
          ? "AI Login access is inactive. Contact support."
          : "Verifying your AI Login access…",
        "warning",
      );
    if (initialized && login && scope && hasRight && !pending && !attempted) void load();
    render();
    return { source, ready: login && hasRight && state.loginConnected };
  }
  async function initialize(values,{apiBase='',token='',account=null}={}) {
    const expected=++epoch;
    stop();session=null;models=[];list=[];verified=false;authority=false;displayLoaded=false;displaySignedIn=false;attempted=false;loading=false;pending=false;flow=null;lastFailure='';appliedOutcome='';
    scope=apiBase&&token&&owned(account)?JSON.stringify([apiBase,token]):'';
    initialized=true;
    source=values.paidTranslationSource==='login'?'login':'tp';
    provider=safeProvider(values.loginProvider)?values.loginProvider:'login_chatgpt';
    selected=String(values.loginModel||'');
    const current=await getStorage(['loginProvider','loginModel','paidTranslationSource']);
    if(disposed||expected!==epoch)return;
    values={...values,...Object.fromEntries(Object.entries(current).filter(([key])=>['loginProvider','loginModel','paidTranslationSource'].includes(key)))};
    source = values.paidTranslationSource === "login" ? "login" : "tp";
    provider = safeProvider(values.loginProvider)
      ? values.loginProvider
      : "login_chatgpt";
    selected = String(values.loginModel || "");
    if(scope){
      const savedScope=scope,hash=await loginAuthScope(apiBase,token);
      const [cached,presentation]=await Promise.all([viewCache.restore(hash,provider,selected),displayCache.restore(hash,provider,selected)]);
      if(disposed||expected!==epoch||scope!==savedScope)return;
      cacheScope=hash;
      if(presentation){list=presentation.list;models=presentation.models;displaySignedIn=presentation.signedIn;displayLoaded=true;message(presentation.status,presentation.kind);}
      if(cached && (!values.loginSessionId || !cached.session || values.loginSessionId===cached.session.id)){
        list=cached.list;models=cached.models;session=cached.session;displaySignedIn=Boolean(session);displayLoaded=true;message(cached.status,cached.kind);
      }
      const saved=await readAuth([LOGIN_PENDING_AUTH,LOGIN_OUTCOME,'loginSessionId','loginAccountId']);
      if(disposed||expected!==epoch||scope!==savedScope)return;
      const savedFlow=saved[LOGIN_PENDING_AUTH];
      if(savedFlow?.provider===provider&&savedFlow.scope===hash&&savedFlow.expiresAt>Date.now())flow=savedFlow;
      const result=saved[LOGIN_OUTCOME];
      if(result?.status==='connected'&&result.session?.id===saved.loginSessionId&&result.session?.account_id===saved.loginAccountId)
        await applyOutcome(result,expected,true,true);
    }
    initialized = true;
    render();
  }
  async function flush() {
    const result = await beforeSwitch?.();
    return result?.ok !== false;
  }
  listen(els.aiLoginRefresh, "click", () => {
    if (!pending&&authority)void load();
  });
  listen(els.aiPaidSource, "change", async () => {
    const next = els.aiPaidSource.value === "login" ? "login" : "tp";
    if (!(await flush())) {
      els.aiPaidSource.value = source;
      return;
    }
    source = next;
    await persist();
    render();
    toggleUi();
    await onUsageSelection?.();
  });
  listen(els.aiLoginProvider, "change", async () => {
    const next = els.aiLoginProvider.value;
    if (!safeProvider(next) || !(await flush())) {
      els.aiLoginProvider.value = provider;
      return;
    }
    if (flow) {
      rejectFlow(flow.flow_id);
      try {
        await request("/login/providers/" + provider + "/auth/cancel", {
          body: { flow_id: flow.flow_id },
          authenticated: true,
        });
      } catch {}
      await writeAuth({ [LOGIN_PENDING_AUTH]: null, [LOGIN_OUTCOME]: null });
    }
    ++epoch;
    stop();
    flow = null;
    pending = false;
    loading = false;
    attempted = false;
    lastFailure = ""; appliedOutcome = "";
    provider = next;
    session = null;
    displaySignedIn=false;
    selected = "";
    models = [];
    verified = false;
    displayLoaded=false;if(cacheScope)await clearView(cacheScope);
    await persist();
    render();
    toggleUi();
    await load();
    await onUsageSelection?.();
  });
  listen(els.aiLoginModel, "change", async () => {
    const next = els.aiLoginModel.value;
    if(!((verified&&authority)||memoryChoice())||!translationAvailable()||!models.some(row=>row.id===next&&!loginModelUnavailable(row))){els.aiLoginModel.value=selected;return;}
    if (!(await flush())) {
      els.aiLoginModel.value = selected;
      return;
    }
    selected = next;
    if(cacheScope)await clearView(cacheScope);
    await persist();
    render();
    toggleUi();
    await onUsageSelection?.();
  });
  async function poll(expected) {
    if (disposed || expected !== epoch || !flow) return;
    const activeFlow = flow;
    try {
      if (activeFlow.expiresAt <= Date.now()) throw Object.assign(new Error("Sign-in expired. Start again."), {code:"login_auth_expired", terminal:true, stage:"callback_wait", traceId:activeFlow.traceId});
      const data = await request(
        "/login/providers/" +
          provider +
          "/auth/status?flow_id=" +
          encodeURIComponent(flow.flow_id),
        { authenticated: true, traceId:activeFlow.traceId || "" },
      );
      if (disposed || expected !== epoch) return;
      if (data.status === "connected") {
        const nextModels = checkedModels(data.models);
        session = data.session;
        displaySignedIn=Boolean(session);
        models = nextModels;
        selected = firstUsable(models);
        verified = true;
        flow = null;
        pending = false;
        await writeAuth({ [LOGIN_PENDING_AUTH]: null, [LOGIN_OUTCOME]: null });
        await persist();
        lastFailure = ""; message("Connected. Your provider account billing and quota apply.");
        displayLoaded=true;await rememberView(expected);
        render();
        toggleUi();
        await onUsageSelection?.();
        return;
      }
      message(stageMessage(data.stage) + "…" + (activeFlow.traceId ? " · Trace: " + activeFlow.traceId : ""));
      timer = setTimeout(() => void poll(expected), 1500);
    } catch (error) {
      if (expected === epoch) {
        const terminal = error.terminal === true || [400,401,403,404,410,422].includes(error.status);
        if (!terminal && activeFlow.expiresAt > Date.now()) {
          message("Status connection interrupted. Retrying…" + (activeFlow.traceId ? " · Trace: " + activeFlow.traceId : ""), "warning");
          timer = setTimeout(() => void poll(expected), 1500); return;
        }
        pending = false;
        flow = null;
        failure(error);
        await writeAuth({[LOGIN_PENDING_AUTH]:null, [LOGIN_OUTCOME]:{scope:activeFlow.scope,provider,flow_id:activeFlow.flow_id,status:"failed",expiresAt:Date.now()+300000,message:error.message,code:error.code,stage:error.stage,traceId:error.traceId || activeFlow.traceId,upstreamStatus:error.upstreamStatus}});
        render();
        toggleUi();
      }
    }
  }
  listen(els.aiLoginConnect, "click", async () => {
    if (pending || !scope || !authority || !signInAvailable()) return;
    const expected = ++epoch;
    const startScope = scope, startProvider = provider;
    // 10494/10495: every Login provider uses the TextPhantom account, so data
    // use must be allowed first. Gemini/DeepSeek also send that website's
    // session cookie: the consent screen's Allow click asks for the cookies
    // permission too (Firefox: one browser prompt). A click replayed after
    // Allow (the greyed button) already holds that answer.
    const cookies = COOKIE_LOGIN_PROVIDERS.includes(provider);
    const replay = accountReplay();
    let consent = replay ? true : dataConsentKnown();
    pending = true;
    render();
    try {
      if (consent === null) consent = await hasDataConsent();
      let granted;
      if (!cookies && consent === true) granted = true;
      else if (replay && cookies) granted = replay.permissions === true || await new Promise(resolve => {
        try { chrome.permissions.contains({permissions:["cookies"]}, value => resolve(!chrome.runtime.lastError && value === true)); } catch { resolve(false); }
      });
      else if (consent !== true) {
        const answer = await showConsentScreen(cookies ? {permissions:["cookies"]} : {});
        if (disposed || expected !== epoch || scope !== startScope || provider !== startProvider || !pending) return;
        if (!answer.consent) {pending=false;failure({code:DATA_CONSENT_REQUIRED,message:await consentText("declined")});render();return;}
        granted = !cookies || answer.permissions === true;
      } else {
        // Keep the permission request in the original click gesture; fence every await.
        const permission = new Promise(resolve => chrome.permissions.request({permissions:["cookies"]},
          granted => resolve(!chrome.runtime.lastError && granted === true)));
        granted = await permission;
      }
      if (disposed || expected !== epoch || scope !== startScope || provider !== startProvider || !pending) return;
      if (!granted) {pending=false;failure({code:"login_cookie_permission_required",message:"Allow provider session access to use endpoint Login."});render();return;}
      const flushed = await flush();
      if (disposed || expected !== epoch || scope !== startScope || provider !== startProvider || !pending) return;
      if (!flushed) {pending=false;render();return;}
      lastFailure = ""; appliedOutcome = "";
      message("Starting provider sign-in…");
      render();
      const data = await request(
        "/login/providers/" + provider + "/auth/start",
        { body: {}, authenticated: true },
      );
      if (disposed || expected !== epoch) return;
      if (data.transport === "web_endpoint") {
        const [apiBase, token] = JSON.parse(startScope);
        flow = {...data, provider, apiBase, scope:await loginAuthScope(apiBase, token), traceId:data.trace_id || "", expiresAt:Date.now()+300000};
        if (disposed || expected !== epoch || scope !== startScope || provider !== startProvider) return;
        await writeAuth({[LOGIN_PENDING_AUTH]:flow, [LOGIN_OUTCOME]:null});
        const reply = await new Promise((resolve,reject) => chrome.runtime.sendMessage({type:"TP_LOGIN_ENDPOINT_OPEN", flowId:flow.flow_id}, value => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message)); else resolve(value);
        }));
        if (disposed || expected !== epoch || scope !== startScope || provider !== startProvider || !pending || !flow) return;
        if (!reply?.ok) throw Object.assign(new Error(reply?.message || "Cannot open the provider website."), {code:reply?.code});
        message("Complete sign-in in the provider tab. Your session will be sent to the selected API; translation runs through its endpoints.");
        render(); return;
      }
      const url = new URL(data.url);
      if (
        url.protocol !== "https:" ||
        !["auth.openai.com", "accounts.google.com", "openrouter.ai", "huggingface.co"].includes(
          url.hostname,
        ) ||
        url.username ||
        url.password
      )
        throw new Error("Invalid provider sign-in URL.");
      const [apiBase, token] = JSON.parse(startScope);
      const oauthState = url.searchParams.get("state");
      if (
        !/^lgf_[a-f0-9]{48}$/.test(data.flow_id || "") ||
        !oauthState || url.searchParams.getAll("state").length !== 1 ||
        oauthState.length < 8 ||
        oauthState.length > 200
      )
        throw new Error("Invalid provider sign-in flow.");
      const callback = data.callback ? loginCallbackMetadata(provider, data.callback, apiBase) : null;
      if (!callback || url.searchParams.get(provider === "login_openrouter" ? "callback_url" : "redirect_uri") !== callback.uri)
        throw new Error("Invalid provider callback configuration.");
      const scopeHash = await loginAuthScope(apiBase, token);
      if (disposed || expected !== epoch || scope !== startScope || provider !== startProvider) return;
      flow = {
        ...(callback ? {callback} : {}),
        flow_id: data.flow_id,
        provider,
        state: oauthState,
        apiBase,
        scope: scopeHash,
        traceId: data.trace_id || "",
        expiresAt: Date.now() + 300000,
      };
      await writeAuth({ [LOGIN_PENDING_AUTH]: flow, [LOGIN_OUTCOME]: null });
      if (disposed || expected !== epoch || scope !== startScope || provider !== startProvider) return;
      if (globalThis.chrome?.tabs?.create) await createTab({ url: data.url });
      else globalThis.open?.(data.url, "_blank", "noopener");
      message("Complete sign-in on the provider website, then return here.");
      render();
      void poll(expected);
    } catch (error) {
      if (expected === epoch) {
        pending = false;
        failure(error);
        render();
      }
    }
  });
  listen(els.aiLoginCancel, "click", async () => {
    if (!flow) return;
    const previous = flow;
    rejectFlow(previous.flow_id);
    ++epoch;
    stop();
    loading = false;
    flow = null;
    pending = false;
    lastFailure = ""; appliedOutcome = "";
    await writeAuth({ [LOGIN_PENDING_AUTH]: null, [LOGIN_OUTCOME]: null });
    try {
      await request("/login/providers/" + provider + "/auth/cancel", {
        body: { flow_id: previous.flow_id },
        authenticated: true,
      });
    } catch {}
    message("Sign-in cancelled.");
    render();
    toggleUi();
  });
  listen(els.aiLoginLogout, "click", async () => {
    if (!session || !authority || !(await flush())) return;
    const previous = session, previousProvider = provider;
    rejectFlow(flow?.flow_id);
    const expected = ++epoch;
    stop();
    loading = false;
    verified = false;
    session = null;
    displaySignedIn=false;
    models = [];
    selected = "";
    flow = null;
    pending = false;
    lastFailure = ""; appliedOutcome = "";
    displayLoaded=false;if(cacheScope)await clearView(cacheScope);
    await writeAuth({ [LOGIN_PENDING_AUTH]: null, [LOGIN_OUTCOME]: null });
    await persist();
    render();
    toggleUi();
    try {
      // Forget the Sign in with ChatGPT token and close the background chat tabs.
      if (previousProvider === "login_chatgpt") await chrome.runtime.sendMessage({type:"TP_LOGIN_CHATGPT_FORGET"}).catch(()=>{});
      await request("/login/providers/" + previousProvider + "/logout", {
        body: { session_id: previous.id },
        authenticated: true,
      });
      if (!disposed && expected === epoch) message("Disconnected from TextPhantom. Your normal provider website login remains in the browser.");
    } catch (error) {
      if (!disposed && expected === epoch) message(error.message, "warning");
    }
    if (!disposed && expected === epoch) await onUsageSelection?.();
  });
  const storageListener = (changes, area) => {
    if(disposed)return;
    if(area==='session'){
      const handlesChanged=()=>['loginSessionId','loginAccountId'].some(key=>key in changes&&
        String(changes[key].newValue||'')!==String(key==='loginSessionId'?session?.id||'':session?.account_id||''));
      const invalidateHandles=()=>{if(!handlesChanged())return;const savedScope=scope;discard({clearCache:true});scope=savedScope;render();toggleUi();};
      if(changes[LOGIN_OUTCOME]?.newValue){
        const expected=epoch;
        // Background commits the opaque handles and outcome atomically. Let
        // their owned receipt settle before classifying this as another session.
        void applyOutcome(changes[LOGIN_OUTCOME].newValue,expected).then(applied=>{
          if(!applied&&!disposed&&expected===epoch)invalidateHandles();
        }).catch(()=>{if(!disposed&&expected===epoch)invalidateHandles();});
      }else invalidateHandles();
      return;
    }
    if(area!=='local'||disposed)return;
    const nextProvider=safeProvider(changes.loginProvider?.newValue)?changes.loginProvider.newValue:provider;
    const nextModel='loginModel' in changes?String(changes.loginModel.newValue||''):selected;
    const nextSource='paidTranslationSource' in changes?(changes.paidTranslationSource.newValue==='login'?'login':'tp'):source;
    if(nextProvider===provider&&nextModel===selected&&nextSource===source)return;
    const selectionChanged=nextProvider!==provider||nextModel!==selected;
    source=nextSource;
    if(selectionChanged){
      ++epoch;stop();pending=false;loading=false;attempted=false;verified=false;flow=null;lastFailure='';appliedOutcome='';
      if(cacheScope)void clearView(cacheScope);
      if(nextProvider!==provider){session=null;displaySignedIn=false;models=[];displayLoaded=false;message('Use your own AI account');}
      provider=nextProvider;selected=nextModel;
    }
    render();toggleUi();
  };
  globalThis.chrome?.storage?.onChanged?.addListener(storageListener);
  listeners.push(() => globalThis.chrome?.storage?.onChanged?.removeListener(storageListener));
  return {
    initialize,
    sync,
    invalidate(){authority=false;discard({clearCache:true});},
    dispose() {
      disposed = true;
      ++epoch;
      stop();
      for (const remove of listeners) remove();
    },
  };
}
