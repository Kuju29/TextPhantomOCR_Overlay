// Export preferences belong to the extension, not to a publisher's localStorage.
// Separate scalar keys avoid one tab overwriting unrelated settings in another.
(function () {
  'use strict';
  const TP=window.__TP;
  if (!TP || TP.bail || window.top!==window) return;
  const api=TP.downloads ||= {};
  const defaults={format:'auto',quality:92,kind:'translated',individual:false};
  const keys={format:'downloadImageFormat',quality:'downloadImageQuality',kind:'downloadSelectedTab',individual:'downloadIndividualExpanded'};
  const normalize=(field,value)=>field==='format' ? (['auto','png','jpeg','webp'].includes(value)?value:'auto')
    : field==='quality' ? (typeof value==='number' && Number.isFinite(value)?Math.max(1,Math.min(100,Math.round(value))):92)
    : field==='kind' ? (['translated','clean','original'].includes(value)?value:'translated') : value===true;
  const state={...defaults},revisions={},listeners=new Set();
  let pending=Promise.resolve();
  const snapshot=()=>({...state});
  const notify=()=>{for(const fn of listeners)fn(snapshot());};
  const ready=new Promise(resolve=>{
    try {
      chrome.storage.onChanged.addListener((changes,area)=>{
        if(area!=='local')return;
        let changed=false;
        for(const [field,key] of Object.entries(keys))if(changes[key]){
          revisions[field]=(revisions[field]||0)+1;
          state[field]=normalize(field,changes[key].newValue);changed=true;
        }
        if(changed)notify();
      });
      chrome.storage.local.get(Object.values(keys),values=>{
        const error=chrome.runtime.lastError;
        if(!error)for(const [field,key] of Object.entries(keys))if(!revisions[field])state[field]=normalize(field,values?.[key]);
        notify();resolve(snapshot());
      });
    } catch { resolve(snapshot()); }
  });
  function set(patch){
    const values={};
    for(const [field,value] of Object.entries(patch))if(keys[field]){
      revisions[field]=(revisions[field]||0)+1;
      state[field]=normalize(field,value);values[keys[field]]=state[field];
    }
    notify();
    // No debounce: initiate writes in event order and expose failures to the UI.
    const write=()=>new Promise((resolve,reject)=>{
      try{chrome.storage.local.set(values,()=>{const error=chrome.runtime.lastError;error?reject(new Error(error.message)):resolve(snapshot());});}
      catch(error){reject(error);}
    });
    const result=pending.then(write,write);pending=result.catch(()=>{});return result;
  }
  api.preferences={ready,snapshot,set,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
})();
