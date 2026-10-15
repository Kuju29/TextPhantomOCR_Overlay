/** Browser-owned send/wait state survives popup and service-worker suspension. */
(() => {
  if (globalThis.TPWebchatDOM) return;
  const turns = new Map();
  const failure = (code,message,stage) => Object.assign(new Error(message),{code,stage});
  const visible = el => Boolean(el?.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const all = selectors => [...new Set(selectors.flatMap(s => [...document.querySelectorAll(s)]))].filter(visible);
  const one = selectors => all(selectors)[0];
  const text = el => String(el?.innerText || el?.textContent || '').trim();
  const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const config = provider => {
    const p = globalThis.TPWebchatProviders?.[provider];
    if (!p || location.origin !== p.origin) throw failure('login_origin_invalid','The provider tab changed origin. Reconnect.','browser_origin');
    return p;
  };
  async function probe(provider) {
    const p = config(provider), composer = one(p.composer);
    const challenge = [...document.querySelectorAll('iframe')].some(el=>visible(el) && /captcha|challenge/i.test(el.src || ''));
    const facts={composer_present:Boolean(composer),composer_enabled:Boolean(composer && !composer.disabled && composer.getAttribute('aria-disabled') !== 'true'),challenge_present:challenge,identity_present:false};
    const waiting=(code,stage)=>({ready:false,code,stage,...facts});
    if (challenge) return waiting('login_challenge','provider_challenge');
    const accountElement=one(p.account);
    let account = [text(accountElement),accountElement?.getAttribute('aria-label'),accountElement?.getAttribute('title'),accountElement?.getAttribute('data-account-id')].filter(Boolean).join(' ').trim();
    let authenticated = Boolean(accountElement && account.length > 2 && !/^(profile|account|google account|open (profile|account|user) menu)$/i.test(account));
    if (provider === 'login_chatgpt') {
      try {
        const response = await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)});
        facts.session_http_status=response.status;
        if(!response.ok)return waiting('login_session_http_error','session_validation');
        if(!/\bjson\b/i.test(response.headers.get('content-type') || ''))return waiting('login_session_content_invalid','session_validation');
        const value = await response.json();
        authenticated = typeof value?.user?.id === 'string' && value.user.id.trim().length > 0;
        account = authenticated ? value.user.id : '';
      } catch(error) { return waiting(error.name === 'TimeoutError' || error.name === 'AbortError'?'login_session_probe_timeout':'login_session_probe_failed','session_validation'); }
    } else if (provider === 'login_deepseek') {
      try { const raw = JSON.parse(localStorage.getItem('userToken') || 'null'); authenticated = typeof raw?.value === 'string' && raw.value.length >= 8; account = authenticated ? raw.value : ''; }
      catch { authenticated = false; }
    }
    facts.identity_present=authenticated;
    if (!authenticated) return waiting('login_required','session_validation');
    if(!composer)return waiting('login_composer_missing','composer_detection');
    if(!facts.composer_enabled)return waiting('login_composer_disabled','composer_detection');
    // Never return vendor tokens, passwords, cookies or account labels.
    return {ready:true,stage:'browser_ready',...facts,accountFingerprint:await hash(provider+'\0'+account),
      modelLabel:text(one(p.model)).slice(0,160),thinkingPolicy:'website_managed',
      busy:Boolean(one(p.stop)),empty:all(p.user).length === 0 && all(p.assistant).length === 0};
  }
  const report = (row,stage) => {
    row.stage = stage;
    try { chrome.runtime.sendMessage({type:'TP_LOGIN_WEBCHAT_STAGE',turnId:row.id,stage},()=>void chrome.runtime.lastError); } catch {}
  };
  // Plan limit notices (ChatGPT free plan) end the wait instead of a timeout.
  const LIMIT=/you['’]ve (?:hit|reached) (?:the |your |our )?(?:free plan |message )?limit|usage limit (?:reached|for)|reached the current usage cap/i;
  const limitText = () => all(['[role="alert"]','[role="dialog"]','[data-testid*="limit" i]']).slice(-6).map(text).join(' ').slice(0,4000);
  const thinkingSelector='[data-role="thinking"],[data-testid*="thinking"],.thinking-content,.ds-think-content';
  function answerNodes(p) {
    return all(p.assistant).filter(el => !el.closest(thinkingSelector))
      .filter(el => !all(p.user).some(user=>user === el || user.contains(el)));
  }
  function answerText(p,el) {
    const final=oneWithin(el,p.final);
    // ChatGPT is asked to answer in a code block (its formatter strips <<ID:text>>
    // records to ">"); the code text is exactly what the model wrote.
    if(final && p.id === 'login_chatgpt'){const code=[...final.querySelectorAll('pre code')].map(node=>node.textContent || '').filter(value=>value.trim());if(code.length)return code.join('\n').trim();}
    if(final)return text(final);
    const clone=el.cloneNode(true);for(const block of clone.querySelectorAll(thinkingSelector))block.remove();return text(clone);
  }
  function oneWithin(el,selectors) { for (const selector of selectors) {const candidate=[...el.querySelectorAll(selector)].find(node=>visible(node) && !node.closest(thinkingSelector));if(candidate)return candidate;} return null; }
  function sendControl(p,composer) {
    if(p.id !== 'login_chatgpt')return one(p.send);
    const form=composer.closest('form');
    const candidates=form?[...new Set([...p.send,'button[type="submit"]'].flatMap(selector=>[...form.querySelectorAll(selector)]))]:all(p.send);
    const enabled=candidates.filter(el=>visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if(enabled.length > 1)throw failure('login_send_ambiguous','More than one Send control belongs to the ChatGPT composer. No message was sent.','prompt_submit');
    return enabled[0];
  }
  async function execute(command) {
    const {provider,turnId,prompt,accountFingerprint,modelLabel} = command;
    const p = config(provider);
    const existing = turns.get(turnId);
    if (existing) {
      if (existing.prompt !== prompt) throw failure('login_turn_conflict','Turn identity contains different text.','prompt_submit');
      return existing.promise;
    }
    if ([...turns.values()].some(x=>!x.ended)) throw failure('login_tab_busy','This provider tab is already translating.','browser_ready');
    if (turns.size > 24) for(const [id,row] of turns) { if(row.ended)turns.delete(id); if(turns.size <= 16)break; }
    const row = {id:turnId,prompt,stage:'browser_ready',ended:false,cancelled:false};
    turns.set(turnId,row);
    row.promise = (async () => {
      const current = await probe(provider);
      if (!current.ready || current.accountFingerprint !== accountFingerprint) throw failure('login_account_changed','The provider account changed or signed out. Reconnect.','session_validation');
      if (modelLabel && current.modelLabel !== modelLabel) throw failure('login_model_changed','The website model changed. Refresh your Login connection.','model_selection');
      // This Login channel uses the website's own controls. TextPhantom neither
      // applies a saved API Thinking level nor changes a website toggle.
      if (current.busy) throw failure('login_tab_busy','The provider is still generating another answer.','browser_ready');
      const before = new Set(answerNodes(p)), users = all(p.user);
      const composer = one(p.composer);
      if (row.cancelled) throw failure('login_cancelled','Translation cancelled.','prompt_submit');
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(composer,prompt);
        composer.dispatchEvent(new Event('input',{bubbles:true}));
      } else {
        const selection=getSelection(),range=document.createRange(); range.selectNodeContents(composer); selection.removeAllRanges();selection.addRange(range);
        if (!document.execCommand('insertText',false,prompt)) { composer.textContent=prompt; composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt})); }
      }
      await pause(100);
      if (row.cancelled) throw failure('login_cancelled','Translation cancelled.','prompt_submit');
      const send=sendControl(p,composer);
      if(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') send.click();
      else if(provider === 'login_deepseek') {composer.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));composer.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}));}
      else throw failure('login_send_unavailable','The website Send control is unavailable.','prompt_submit');
      // From here a lost acknowledgement is ambiguous: never resend automatically.
      const began=Date.now(); let sawBusy=false,sawUser=false,sawNew=false,last='',stableAt=0,replyReported=false,submittedReported=false,accountCheckedAt=0;
      // Tab ready (<= 45 s) + answer (<= 170 s) stays within the API relay deadline (230 s).
      while(Date.now()-began < 170000) {
        if(row.cancelled) {one(p.stop)?.click();throw failure('login_cancelled','Translation cancelled.','reply_wait');}
        config(provider);
        if(Date.now()-accountCheckedAt >= 2000) {
          accountCheckedAt=Date.now();
          const verified=await probe(provider);
          if(!verified.ready || verified.accountFingerprint !== accountFingerprint) {one(p.stop)?.click();throw failure('login_account_changed','The provider account changed while waiting. Reconnect.','session_validation');}
        }
        const busy=Boolean(one(p.stop)); sawBusy ||= busy;
        const newerUsers=all(p.user).filter(el=>!users.includes(el));
        // A long prompt may be shown collapsed; its start identifies the turn.
        sawUser ||= newerUsers.some(el=>text(el).replace(/\s+/g,' ').includes(prompt.trim().replace(/\s+/g,' ').slice(0,120)));
        if(LIMIT.test(limitText())) {one(p.stop)?.click();throw failure('login_quota_exceeded','The website says the usage limit of this account is reached.','reply_wait');}
        if(sawUser && !submittedReported){report(row,'submitted');submittedReported=true;}
        const candidates=answerNodes(p).filter(el=>!before.has(el));
        const value=candidates.length ? answerText(p,candidates.at(-1)) : '';
        if(value) {sawNew=true;if(!replyReported){report(row,'reply_started');replyReported=true;}}
        if(value !== last) {last=value;stableAt=Date.now();}
        // No partial success on timeout. Need matching submitted turn and an
        // observed busy -> idle transition, plus stable new final text.
        if(sawUser && sawNew && sawBusy && !busy && value && Date.now()-stableAt >= 1000) {
          report(row,'reply_finished'); return {text:value,completion:'busy_to_idle',stage:'reply_finished'};
        }
        if(!sawUser && Date.now()-began > 20000) throw failure('login_submit_unconfirmed','Could not confirm this prompt in the website conversation. It will not be resent automatically.','prompt_submit');
        await pause(200);
      }
      throw failure('login_reply_timeout','The website did not provide a verified completed answer.','reply_wait');
    })().finally(()=>{row.ended=true;});
    return row.promise;
  }
  const api = globalThis.TPWebchatDOM = {probe,execute,cancel(id){const row=turns.get(id);if(row)row.cancelled=true;},status(id){const row=turns.get(id);return row?{stage:row.stage,ended:row.ended}:null;}};
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id !== chrome.runtime.id || message?.type !== 'TP_LOGIN_WEBCHAT_DOM')return;
    if(message.action === 'cancel'){api.cancel(message.turnId);reply({ok:true});return false;}
    if(message.action === 'status'){reply({ok:true,state:api.status(message.turnId)});return false;}
    const action=message.action === 'probe'?probe(message.provider):message.action === 'execute'?execute(message):Promise.reject(failure('login_command_invalid','Invalid browser chat command.','browser_command'));
    action.then(value=>reply({ok:true,...value}),error=>reply({ok:false,code:error.code || 'login_dom_error',stage:error.stage || 'browser_command',message:error.message}));return true;
  });
})();
