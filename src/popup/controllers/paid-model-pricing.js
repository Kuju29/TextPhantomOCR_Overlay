/** Display-only server rates. Billing and rounding remain owned by Center. */
import {formatPaidTpRate} from '../../shared/paid-price-format.js';
function validPrice(quote) {
  if (quote?.status !== "estimated" || quote.unit !== "TP_PER_1000_TOKENS") return null;
  const valid = value => typeof value === "string" && value.length <= 80 && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
  if (!valid(quote.input_tp) || !valid(quote.output_tp)) return null;
  return quote;
}
function displayPrice(model) {
  const paired=validPrice(model?.pricing),catalogue=validPrice(model?.catalogue_pricing);
  // A catalogue estimate stays useful when the selected options have no quote.
  // It never supplies route readiness, quote tokens or billing authority.
  return paired && (paired.basis!=='paired_endpoint_metadata'||model?.route_price_sync?.status==='current'||!catalogue)
    ? {quote:paired,source:paired.basis==='paired_endpoint_metadata'?'paired':'catalogue'}
    : catalogue ? {quote:catalogue,source:'catalogue'} : null;
}
export function paidQuoteFailureMessage(code) {
  if(code==='PAID_MODEL_PAUSED')return 'This model is temporarily paused. Choose a different model or try again later.';
  if(code==='PAID_MODEL_PARAMETER_UNSUPPORTED')return 'Selected options are unavailable for this model. Change options or choose a different model.';
  if(code==='PAID_THINKING_UNSUPPORTED')return 'This model does not support the selected thinking level. Choose Lowest available or a different model.';
  if(code==='PAID_THINKING_UNVERIFIED')return 'The model\'s thinking options could not be verified. Refresh balance to try again or contact support.';
  if(code==='PAID_IMAGE_UNSUPPORTED')return 'Page images are not supported for this model. Turn off Send page image to AI or choose a different model.';
  if(code==='PAID_OUTPUT_UNSUPPORTED')return 'This model cannot provide the required answer size. Choose a different model or contact support.';
  if(code==='PAID_ROUTE_UNAVAILABLE')return 'No priced route is available for the selected options. Choose a different model or contact support.';
  if(code==='PAID_PRICE_REFRESHING')return 'Current route prices are updating. Refresh balance to try again.';
  return 'Could not check the current route price. Refresh balance to try again or contact support.';
}
export function paidModelRates(model) {
  const display=displayPrice(model);
  if(!display)return null;
  const quote=display.quote;
  const format = value => formatPaidTpRate(value, quote.tariff_basis === 'conditional_ceiling');
  return {input: format(quote.input_tp), output: format(quote.output_tp)};
}

/** Words typed in the model search; every word must appear in the name or id. */
export function paidModelMatches(item, query) {
  const words = String(query || "").toLowerCase().normalize("NFKC").split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${item?.name || ""} ${item?.id || ""}`.toLowerCase().normalize("NFKC");
  return words.every(word => hay.includes(word));
}

export function createPaidModelPricing(els) {
  let signature = "";
  const picker = els.aiPaidModelPicker;
  if (!picker) return {render() {}};
  const summary = picker.querySelector("summary"), search = els.aiPaidModelSearch;
  summary.addEventListener("click", event => {
    if (els.aiPaidModel.disabled) event.preventDefault();
  });
  // Type to search inside the same model picker.
  const applyFilter = () => {
    const query = search?.value || "";
    let shown = 0;
    for (const button of els.aiPaidModelOptions?.children || []) {
      const visible = paidModelMatches({name: button.dataset?.modelName, id: button.dataset?.modelId}, query);
      button.hidden = !visible;
      if (visible) shown++;
    }
    if (els.aiPaidModelEmpty) els.aiPaidModelEmpty.hidden = shown > 0;
    return shown;
  };
  const visibleOptions = () => [...(els.aiPaidModelOptions?.children || [])].filter(button => !button.hidden && !button.disabled);
  if (search) {
    search.addEventListener("input", applyFilter);
    search.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault?.(); visibleOptions()[0]?.click(); }
      else if (event.key === "ArrowDown") { event.preventDefault?.(); visibleOptions()[0]?.focus(); }
      else if (event.key === "Escape") { event.preventDefault?.(); picker.open = false; summary.focus(); }
    });
  }
  picker.addEventListener("toggle", () => {
    if (picker.open) { search?.focus(); search?.select?.(); }
    else if (search && search.value) { search.value = ""; applyFilter(); }
  });
  // Typing while the closed picker has focus opens it and starts the search.
  summary.addEventListener("keydown", event => {
    if (!search || els.aiPaidModel.disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    if (typeof event.key === "string" && event.key.length === 1 && event.key !== " ") {
      event.preventDefault?.();
      picker.open = true;
      search.value = event.key;
      applyFilter();
      search.focus();
    }
  });
  els.aiPaidModelOptions?.addEventListener("keydown", event => {
    const rows = visibleOptions(), index = rows.indexOf(event.target);
    if (event.key === "ArrowDown" && index >= 0) { event.preventDefault?.(); rows[Math.min(rows.length - 1, index + 1)]?.focus(); }
    else if (event.key === "ArrowUp" && index >= 0) { event.preventDefault?.(); (index === 0 ? search : rows[index - 1])?.focus(); }
    else if (event.key === "Escape") { event.preventDefault?.(); picker.open = false; summary.focus(); }
  });
  return {
    render(models, selected, verified, displayLoaded=false) {
      const model = models?.find(item => item.id === selected);
      const rates = paidModelRates(model);
      const display=displayPrice(model),source=display?.source;
      els.aiPaidModelName.textContent = model?.name || model?.id || "Select model…";
      picker.querySelector("summary").setAttribute("aria-disabled", String(!verified));
      if (!verified) picker.open = false;
      const next = JSON.stringify([models, selected, verified]);
      if (next !== signature) {
        signature = next;
        els.aiPaidModelOptions.replaceChildren(...(models || []).map(item => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "paid-model-option";
          button.disabled = !verified || item.availability?.available === false;
          button.setAttribute("aria-pressed", String(item.id === selected));
          button.dataset.modelName = String(item.name || "");
          button.dataset.modelId = String(item.id || "");
          const quote = paidModelRates(item);
          const basis = displayPrice(item);
          button.title = basis?.quote?.tariff_basis === 'conditional_ceiling'
            ? 'Published tier ceiling' : basis?.source === 'paired' ? 'Paired route estimate' : 'Catalogue comparison';
          const prefix = basis?.quote?.tariff_basis === 'conditional_ceiling' ? '≤' : '≈';
          if (item.availability?.available === false) button.title = 'Temporarily paused · choose another model';
          for (const value of [item.name || item.id, quote ? `${prefix} ${quote.input}` : "—", quote ? `${prefix} ${quote.output}` : "—"]) {
            const span = document.createElement("span");
            span.setAttribute("translate", "no");
            span.textContent = value;
            button.append(span);
          }
          button.addEventListener("click", () => {
            els.aiPaidModel.value = item.id;
            els.aiPaidModel.dispatchEvent(new Event("change", {bubbles: true}));
            picker.open = false;
            if (search) { search.value = ""; }
            picker.querySelector("summary").focus();
          });
          return button;
        }));
        applyFilter();  // A refreshed list keeps the words already typed.
      }
      const prefix = display?.quote?.tariff_basis === 'conditional_ceiling' ? '≤' : '≈';
      els.aiPaidModelInput.textContent = rates ? `${prefix} ${rates.input} TP` : "—";
      els.aiPaidModelOutput.textContent = rates ? `${prefix} ${rates.output} TP` : "—";
      const ceiling=paidModelRates({pricing:display?.quote?.routing_ceiling && {...display.quote.routing_ceiling,tariff_basis:'conditional_ceiling'}});
      const requestFee=display?.quote?.routing_ceiling?.request_tp ?? display?.quote?.request_tp;
      const feeText=typeof requestFee==='string' && /^\d+(?:\.\d+)?$/.test(requestFee) && Number(requestFee)>0
        ? ` Up to ${formatPaidTpRate(requestFee,true)} TP fixed fee per request.` : '';
      const details=(ceiling ? `Route comparison; allowed routes up to Input ${ceiling.input}, Output ${ceiling.output} TP per 1,000 tokens. Final charge uses reported cost.` : '')+feeText;
      els.aiPaidModelInput.title=details; els.aiPaidModelOutput.title=details;
      els.aiPaidModelPriceStatus.textContent = model?.availability?.available === false ? "This model is temporarily paused. Choose another model or refresh later." : !verified && !displayLoaded ? "Refresh your account to check current rates."
        : rates ? !verified ? 'Previously loaded base rates · updating'
          : model?.price_sync?.status==='stale' ? 'Prior base rates · price update unavailable'
          : source==='paired' ? model?.route_price_sync?.status==='current'
            ? display.quote.tariff_basis==='conditional_ceiling'
              ? 'Published tier ceiling · final charge from reported usage'
              : 'Current paired route estimate · final charge from reported usage' : 'Previous paired route estimate · checking prices'
          : model?.route_price_sync?.error_code ? 'Catalogue estimate · selected route unavailable'
          : model?.route_price_sync?.status==='refreshing' ? 'Catalogue estimate · checking the selected route'
          : model?.price_sync?.status==='current' ? 'Automatically updated catalogue rates · route prices may differ'
          : "Estimated base rates · before caching"
        : "Price estimate unavailable. Actual usage is recorded in Account details.";
      if (rates && model?.availability?.available !== false) els.aiPaidModelPriceStatus.append(document.createTextNode(" · TP per 1,000 tokens; cache and actual usage affect the final charge."));
      if (verified && source === 'paired' && model?.route_price_sync?.status === 'current' &&
          display.quote.tariff_basis === 'conditional_ceiling' && validPrice(model?.catalogue_pricing)) {
        const comparison = paidModelRates({pricing:model.catalogue_pricing});
        const label = document.createElement('span'), amounts = document.createElement('span');
        label.textContent = 'Catalogue comparison';
        amounts.setAttribute('translate', 'no');
        amounts.textContent = ` ≈ ${comparison.input} / ${comparison.output} TP`;
        els.aiPaidModelPriceStatus.append(document.createTextNode(' · '), label, amounts);
      }
    },
  };
}
