import {createManualProviderViewCache,manualProviderViewScope} from './manual-provider-view-cache.js';
import {manualModelBlock,manualModelBlockMessage} from '../../shared/ai/manual-model-block.js';
export function createProviderMetaController({
  els,
  state,
  api,
  constants,
  provider,
  profile,
  local,
  normalizeUrl,
  setModelOptions,
  setFieldMessage,
  toggleUi,
  viewCache=createManualProviderViewCache(),
  readModelBlock=manualModelBlock,
}) {
  let displayView=null,displayScope='',silentRefresh=false;
  let resolveTimer = null;
  const resolveCache = new Map();
  const resolveInFlight = new Map();
  const RESOLVE_TTL_MS = 60_000;

  const canUse = () =>
    els.mode.value === "lens_text" &&
    String(els.sources.value || "").trim() === "ai";

  const setModelBlocked = (blocked) => {
    state.aiModelBlocked = Boolean(blocked);
  };

  // Capture the complete popup context before async work, including a revision
  // so A -> B -> A cannot revive a response started before the intervening edit.
  const selectionSnapshot = () => ({
    apiUrl: normalizeUrl(els.apiUrl?.value || ""),
    provider: String(els.aiProvider?.value || "").trim(),
    endpoint: String(els.aiBaseUrl?.value || "").trim(),
    model: String(els.aiModel?.value || "").trim(),
    credential: String(els.aiKey?.value || "").trim(),
    language: String(els.lang?.value || "en"),
  });
  const selectionMatches = (snapshot) =>
    canUse() && JSON.stringify(snapshot) === JSON.stringify(selectionSnapshot());

  const saveCapabilities = async (capabilities, snapshot, isCurrent) => {
    if (!isCurrent()) return false;
    if (capabilities && typeof capabilities === "object" &&
        !Array.isArray(capabilities) && Object.keys(capabilities).length && snapshot.credential) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot.credential));
      if (!isCurrent()) return false;
      const accountHash = Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      await profile.saveModelCapabilities(capabilities, accountHash, {
        provider: snapshot.provider, endpoint: snapshot.endpoint, model: snapshot.model,
      }, isCurrent);
    }
    return isCurrent();
  };

  const renderStatus = () => {
    if (!canUse() || !(state.lastAiResolve || displayView?.resolve)) return;
    // Local discovery owns this field and has no cloud provider protocol.
    // Saving a Local model or reopening the popup must not overwrite its
    // concrete availability message with "Backend: unknown transport".
    if (provider.isLocal(els.aiProvider?.value)) return;
    const data = silentRefresh&&displayView?displayView.resolve:state.lastAiResolve || displayView.resolve;
    const id = String(data.provider || els.aiProvider?.value || "").trim();
    const name = provider.label(id || "provider");
    const protocol = provider.protocolLabel(data.provider_protocol);
    if (data.configuration_status === "pending") {
      setFieldMessage(els.aiKeyWrap, "warn", "Enter an API key to load account models.");
      setFieldMessage(els.aiModelWrap, "info", "Waiting for provider configuration.");
      return;
    }
    if (data.error === "provider_key_mismatch") {
      setFieldMessage(
        els.aiProviderWrap,
        "error",
        "✕ The API key belongs to a different provider",
      );
      setFieldMessage(
        els.aiModelWrap,
        "error",
        "✕ Model list was not requested",
      );
      return;
    }
    if (data.error === "unsafe_base_url") {
      setFieldMessage(els.aiProviderWrap, "", "");
      setFieldMessage(
        els.aiModelWrap,
        "error",
        "✕ This endpoint requires your own API key",
      );
      return;
    }
    if (data.error === "ai_provider_endpoint_conflict") {
      setFieldMessage(els.aiProviderWrap, "error",
        "✕ This Cloud provider has a Local AI server URL. Select the matching Local AI provider, or reselect the Cloud provider to restore its endpoint.");
      setFieldMessage(els.aiModelWrap, "error",
        "✕ Model list was not requested because the provider and server URL conflict.");
      return;
    }
    setFieldMessage(
      els.aiProviderWrap,
      data.backend_supported === false ? "error" : "",
      data.backend_supported === false
        ? `✕ ${name} is not implemented by this API build`
        : "",
    );
    if (els.aiKeyWrap?.style.display !== "none") {
      const keyMessages = {
        valid: ["info", `✓ Live ${name} model list loaded`],
        invalid: ["error", `✕ ${name} rejected this API key`],
        forbidden: ["error", `✕ ${name} denied account/model access`],
        missing: ["warn", "⚠ Enter an API key to load account models"],
        unverified: ["warn", `⚠ Could not verify the key with ${name}`],
      };
      const message = keyMessages[data.key_status];
      if (message) setFieldMessage(els.aiKeyWrap, ...message);
    }
    let type = "info";
    let text = "";
    if (data.backend_supported === false)
      [type, text] = ["error", "✕ Backend transport is unavailable"];
    else if (data.key_status === "invalid")
      [type, text] = ["error", `✕ API key rejected • Backend: ${protocol}`];
    else if (data.key_status === "forbidden")
      [type, text] = [
        "error",
        `✕ Account/model access denied • Backend: ${protocol}`,
      ];
    else if (data.models_source === "live" && data.models_verified) {
      const candidates = Array.isArray(data.model_candidates) ? data.model_candidates : [];
      const usable = candidates.filter((item) => item?.eligibility === "usable").length;
      text = `✓ ${usable} compatible model${usable === 1 ? "" : "s"} • Backend: ${protocol}`;
      if (data.model_status === "unavailable")
        [type, text] = [
          "error",
          `✕ Selected model is unavailable • Backend: ${protocol}`,
        ];
    } else {
      [type, text] = [
        "warn",
        `⚠ Live model list unavailable • Backend: ${protocol}`,
      ];
    }
    // Manual models are not probed when selected (10491). A real translation
    // that failed deterministically for this key leaves a mark; show the same
    // message the page showed until the user re-selects the model or changes
    // the key/provider.
    const model = String(els.aiModel?.value || "").trim();
    const block = state.manualModelBlock;
    if (block && block.provider === id && block.model === model) {
      const { userMessage, code } = manualModelBlockMessage(block.row);
      type = "error";
      text += ` • ✕ ${userMessage} · ${code}`;
      text += " • Select another model, or select this model again to retry";
    }
    setFieldMessage(els.aiModelWrap, type, text);
  };

  // Read the deterministic-failure mark for the exact current Manual selection.
  const loadBlock = async (selection, isCurrent) => {
    let row = null;
    try {
      row = await readModelBlock({ provider: selection.provider, baseUrl: selection.endpoint,
        apiKey: selection.credential, model: selection.model });
    } catch {}
    if (!isCurrent()) return false;
    state.manualModelBlock = row ? { provider: selection.provider, model: selection.model, row } : null;
    return true;
  };

  // A mark written by the background (first translation failed) or cleared
  // by a re-selection while the popup is open.
  const refreshBlock = async () => {
    if (!canUse() || provider.isLocal(els.aiProvider?.value) || !state.lastAiResolve) return;
    const sequence = state.aiMetaSeq;
    const selection = selectionSnapshot();
    if (!await loadBlock(selection, () => sequence === state.aiMetaSeq && selectionMatches(selection))) return;
    const usable = Array.isArray(state.lastAiResolve?.model_candidates) &&
      state.lastAiResolve.model_candidates.some((row) => row?.eligibility === "usable" && row.id === selection.model);
    setModelBlocked(!usable || Boolean(state.manualModelBlock));
    renderStatus();
    toggleUi();
  };

  const refresh = async ({automatic=false,displayOnly=false}={}) => {
    if(!automatic){resolveCache.clear();void viewCache.clear(displayScope);}
    if (!canUse()) {
      setModelOptions([], { placeholder: "Select model…" });
      state.lastAiResolve = null;
      state.manualModelBlock = null;
      setModelBlocked(false);
      return;
    }
    const sequence = ++state.aiMetaSeq;
    let selection = selectionSnapshot();
    const isCurrent = () => sequence === state.aiMetaSeq && selectionMatches(selection);
    setModelBlocked(true);
    state.manualModelBlock = null;
    displayView=null;silentRefresh=false;
    const selectedProvider = String(els.aiProvider?.value || "").trim();
    const selectedBaseUrl = String(els.aiBaseUrl?.value || "").trim();
    if (!selectedProvider) {
      setModelBlocked(true);
      setModelOptions([], { placeholder: "Select a provider first" });
      setFieldMessage(els.aiProviderWrap, "warn", "Select a provider.");
      toggleUi();
      return;
    }
    setFieldMessage(els.aiProviderWrap, "", "");
    if (provider.isLocal(selectedProvider)) {
      // Check availability live; the worker reuses a verified, still-loaded model.
      if(displayOnly){await local.restoreDisplay?.();return;}
      if (state.localConnectInFlight) return;
      // Selection-driven discovery: Custom ownership is verified by the connection controller.
      await local.connect({ automatic, implicit: true });
      return;
    }
    const base = normalizeUrl(els.apiUrl.value);
    if (!base) {
      setModelBlocked(true);
      toggleUi();
      return;
    }
    const key = String(els.aiKey.value || "").trim();
    if (!key) {
      state.lastAiResolve = { provider: selectedProvider, key_status: "missing",
        configuration_status: "pending", models_verified: false, models: [], model_candidates: [] };
      setModelBlocked(true);
      setModelOptions([], { placeholder: "Enter API key to load models", selectFirst: false });
      renderStatus();
      toggleUi();
      return;
    }
    const cachedScope=await manualProviderViewScope(selection);
    if(!isCurrent())return;
    displayScope=cachedScope;
    if(automatic){
      displayView=await viewCache.restore(cachedScope,'cloud',{allowStale:true});
      if(!isCurrent())return;
      silentRefresh=Boolean(displayView);
      if(displayView){setModelOptions(displayView.models,{keepValue:selection.model,selectFirst:false});renderStatus();}
    }else void viewCache.clear(cachedScope);
    if(displayOnly)return;
    // A previously listed provider/model must never remain usable while a
    // different provider/account/model catalogue is still being refreshed.
    // The fresh catalogue (and no deterministic-failure mark) releases it;
    // no generation request is sent to verify the selected model (10491).
    setModelBlocked(true);
    toggleUi();
    if(!silentRefresh)setFieldMessage(
      els.aiModelWrap,
      "info",
      "⏳ Loading models for this provider…",
    );
    const currentModel =
      String(els.aiModel.value || "").trim() || state.desiredAiModel || "auto";
    try {
      const body = {
          api_key: key,
          model: currentModel,
          lang: els.lang.value || "en",
          provider: selectedProvider,
          base_url: selectedBaseUrl,
        };
      const identity = JSON.stringify([
        base,
        selectedProvider,
        selectedBaseUrl,
        key,
        body.lang,
        currentModel,
      ]);
      const cached = resolveCache.get(identity);
      let data;
      if (cached && Date.now() - cached.ts < RESOLVE_TTL_MS) data = cached.data;
      else {
        let request = resolveInFlight.get(identity);
        if (!request) {
          request = api.fetchJson(
            `${base}${constants.paths.AI_RESOLVE}`,
            body,
            constants.metaTimeout,
          ).then((result) => {
            resolveCache.set(identity, { ts: Date.now(), data: result });
            return result;
          }).finally(() => {
            if (resolveInFlight.get(identity) === request)
              resolveInFlight.delete(identity);
          });
          resolveInFlight.set(identity, request);
        }
        data = await request;
      }
      if (!isCurrent()) return;
      state.lastAiResolve = data || null;
      const candidates = data?.models_verified && Array.isArray(data.model_candidates)
        ? data.model_candidates : [];
      const usableCandidates = candidates.filter((candidate) =>
        candidate && typeof candidate === "object" &&
        candidate.eligibility === "usable" && String(candidate.id || "").trim(),
      );
      const usableModels = usableCandidates.map((candidate) => String(candidate.id).trim());
      const selectedCapability =
        data?.model_capabilities && typeof data.model_capabilities === "object"
          ? data.model_capabilities
          : {};
      let preferred =
        (state.modelDirty
          ? String(els.aiModel.value || "").trim()
          : String(state.desiredAiModel || "").trim()) || currentModel;
      const requestedWasAuto = ["", "auto"].includes(String(data?.requested_model || currentModel).toLowerCase());
      if (requestedWasAuto && data?.model) preferred = String(data.model).trim();
      const explicitUnavailable =
        data?.models_verified === true &&
        preferred && !usableModels.includes(preferred) && !requestedWasAuto;
      // The picker is provider-authoritative. Never append a stored/typed model
      // that the current provider/account did not return as compatible.
      setModelOptions(usableCandidates, {
        keepValue: explicitUnavailable ? "" : preferred || String(data?.model || "").trim(),
        placeholder:
          data?.key_status === "missing"
            ? "Enter API key to load models"
            : explicitUnavailable
              ? "Saved model unavailable — choose a verified model"
              // The disabled first row is listed above the models in the
              // open picker; it must not claim there are none.
              : usableCandidates.length ? "Select model…" : "No compatible models available",
        selectFirst: requestedWasAuto && !explicitUnavailable,
      });
      setModelBlocked(true);
      state.lastResolvedProvider =
        String(data?.provider || "").trim() || state.lastResolvedProvider;
      state.lastResolvedKey = key;
      // Auto model selection above is an intentional synchronous UI update.
      // Subsequent user edits still invalidate this new captured selection.
      selection = selectionSnapshot();
      if (selection.model && usableModels.includes(selection.model)) {
        await profile.activateResolvedModel?.(selection.model, isCurrent);
        if (!isCurrent()) return;
      }
      if (selection.model === String(data?.model || "").trim() &&
          !await saveCapabilities(selectedCapability, selection, isCurrent)) return;
      if (!isCurrent()) return;
      if (!await loadBlock(selection, isCurrent)) return;
      const selectedNow = String(els.aiModel?.value || "").trim();
      setModelBlocked(!(selectedNow && usableModels.includes(selectedNow)) || Boolean(state.manualModelBlock));
      silentRefresh=false;displayView=null;
      toggleUi();
      renderStatus();
      const finalScope=await manualProviderViewScope(selection);
      if(!isCurrent())return;
      await viewCache.remember(finalScope,{kind:'cloud',resolve:state.lastAiResolve,models:state.lastAiResolve?.model_candidates?.filter(row=>row.eligibility==='usable') || []},isCurrent,[key]);
    } catch {
      if (isCurrent()) {
        const previous=displayView;silentRefresh=false;
        state.lastAiResolve = null;
        if(previous)setModelOptions(previous.models,{keepValue:selection.model,selectFirst:false});
        else setModelOptions([], { placeholder: "Model list could not be verified" });
        setModelBlocked(true);
        toggleUi();
        setFieldMessage(
          els.aiModelWrap,
          "warn",
          "⚠ Couldn’t verify this provider’s model list. Translation is paused until models can be checked.",
        );
        // The previous models stay visible on reopen, labelled unverified.
        const failed={kind:'cloud',resolve:{...(previous?.resolve || {provider:selectedProvider,backend_supported:true}),
          key_status:'unverified',models_verified:false,models_source:'none'},models:previous?.models || []};
        await viewCache.remember(cachedScope,failed,isCurrent,[key]);
      }
    }
  };

  const schedule = ({ immediate = false } = {}) => {
    clearTimeout(resolveTimer);
    if (immediate) void refresh();
    else resolveTimer = setTimeout(refresh, 350);
  };
  const cancelSchedule = () => clearTimeout(resolveTimer);

  return {
    canUse,
    refresh,
    schedule,
    cancelSchedule,
    refreshBlock,
    renderStatus,
    restoreDisplay:()=>refresh({automatic:true,displayOnly:true}),
  };
}
