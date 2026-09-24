// Opt-in edge drawer; both entry points dispatch the same worker action.
(function () {
  const TP=window.__TP;
  if(!TP || TP.bail || window.top!==window)return;
  const KEY='translateAllButtonEnabled';
  let host=null,cleanup=null;
  function show(){
    if(host?.isConnected || !document.documentElement)return;
    const owner=document.createElement('div');host=owner;owner.id='tp-translate-all-control';
    const shadow=owner.attachShadow({mode:'open'}),style=document.createElement('style');
    style.textContent=`:host{all:initial;position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483646;pointer-events:none;direction:ltr}
      .drawer{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 0;transform:translateX(calc(100% - 10px));transition:transform .2s ease;pointer-events:auto}
      .drawer[data-open="true"]{transform:translateX(0)}
      button{all:unset;box-sizing:border-box;flex-shrink:0;cursor:pointer;font:600 12px/1.3 system-ui,sans-serif}
      .handle{display:flex;align-items:center;justify-content:center;width:10px;height:36px;border-radius:8px 0 0 8px;background:rgba(99,102,241,.55);transition:background .2s}
      .handle::after{content:'';width:3px;height:20px;background:#e0e7ff;border-radius:3px}
      [data-open="true"] .handle{background:transparent}
      [data-open="true"] .handle::after{background:#a5b4fc}
      .action{visibility:hidden;display:flex;align-items:center;gap:7px;white-space:nowrap;padding:10px 13px;color:#f8fafc;background:#252a43;border:1px solid #626a92;border-radius:12px;box-shadow:0 4px 16px #0004}
      [data-open="true"] .action{visibility:visible}
      button:hover{filter:brightness(1.15)}button:focus-visible{outline:2px solid #a5b4fc;outline-offset:2px}
      button:disabled{opacity:.7;cursor:wait}@media(prefers-reduced-motion:reduce){.drawer{transition:none}}`;
    const drawer=document.createElement('div');drawer.className='drawer';
    const handle=document.createElement('button');handle.type='button';handle.className='handle';
    handle.title='Open TextPhantom';handle.setAttribute('aria-label','Open translation controls');
    handle.setAttribute('aria-controls','translate-all-action');
    const button=document.createElement('button');button.type='button';button.className='action';button.id='translate-all-action';
    button.textContent='🔍 Translate all';button.setAttribute('aria-label','Translate all images on this page');
    let busy=false;
    const open=value=>{drawer.setAttribute('data-open',String(value));handle.setAttribute('aria-expanded',String(value));button.tabIndex=value?0:-1;};
    open(false);
    drawer.addEventListener('pointerenter',event=>{if(event.pointerType!=='touch')open(true);});
    drawer.addEventListener('pointerleave',event=>{if(event.pointerType!=='touch' && !shadow.activeElement?.matches(':focus-visible'))open(false);});
    drawer.addEventListener('focusin',()=>open(true));
    drawer.addEventListener('focusout',event=>{if(!drawer.contains(event.relatedTarget))open(false);});
    handle.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();open(true);});
    const outside=event=>{if(!event.composedPath().includes(owner))open(false);};
    const escape=event=>{if(event.key==='Escape'){open(false);shadow.activeElement?.blur();}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
    cleanup=()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);};
    button.addEventListener('mousedown',event=>event.stopPropagation());
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopPropagation();if(busy)return;
      busy=true;button.disabled=true;button.textContent='⏳ Finding images';
      const reset=()=>{busy=false;button.disabled=false;button.textContent='🔍 Translate all';};
      try{chrome.runtime.sendMessage({type:'TP_RUN_TRANSLATE_ALL'},response=>{
        const error=chrome.runtime.lastError;
        if(error || response?.ok===false)TP.showToast?.(`TextPhantom: ${response?.error || error?.message || 'Cannot start translation'}`,5000);
        reset();
      });}catch(error){TP.showToast?.(`TextPhantom: ${error.message}`,5000);reset();}
    });
    drawer.append(handle,button);shadow.append(style,drawer);document.documentElement.append(owner);
  }
  function setEnabled(value){if(value)show();else{cleanup?.();cleanup=null;host?.remove();host=null;}}
  try{
    chrome.storage.local.get(KEY,items=>{void chrome.runtime.lastError;if(items?.[KEY])show();});
    chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes[KEY])setEnabled(Boolean(changes[KEY].newValue));});
  }catch{}
})();
