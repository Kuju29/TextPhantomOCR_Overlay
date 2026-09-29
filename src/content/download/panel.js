// Approved compact panel: one ZIP for all, a single image for each row.
(function () {
  'use strict';
  const TP=window.__TP;
  if(!TP || TP.bail || window.top!==window || TP.downloads?.panelInstalled)return;
  const api=TP.downloads;api.panelInstalled=true;
  const KEY='downloadImagesEnabled';
  let host=null,els={},rows=[],kind=api.preferences.snapshot().kind,open=false,job=null,cleanup=null,enableRevision=0;
  let preferenceWrite=0,lastIndividual=api.preferences.snapshot().individual;
  const completed=new WeakMap();
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
  function icon(name){
    const paths={download:'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',close:'m6 6 12 12M6 18 18 6',chevron:'m6 9 6 6 6-6',refresh:'M20 7v5h-5M4 17v-5h5M18 5a8 8 0 0 0-13 3m1 11a8 8 0 0 0 13-3',check:'m5 12 4 4L19 6'};
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
    const p=document.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',paths[name]||paths.download);svg.append(p);return svg;
  }
  function button(text,cls,action,label=text){const n=el('button',cls,text);n.type='button';if(label)n.setAttribute('aria-label',label);if(action)n.addEventListener('click',action);return n;}
  const eligible=(which=kind)=>rows.filter(r=>r.available[which]);
  const nameOf=r=>'Page '+String(r.number).padStart(2,'0');
  const doneKey=(k,p)=>`${k}:${p.format}:${p.format==='jpeg'||p.format==='webp'?p.quality:''}`;
  function setOpen(value,focus=false){
    if(!host)return;open=!!value;els.panel.hidden=!open;els.toggle.setAttribute('aria-expanded',String(open));
    els.toggle.setAttribute('aria-label',open?'Minimize download images':'Open download images');
    if(focus){if(open)(els.tabs.find(b=>b.dataset.kind===kind&&!b.disabled)||els.refresh).focus();else els.toggle.focus();}
  }
  function refresh(){
    if(job)return;
    try{rows=api.scan();update();}catch(e){rows=[];update();status('Could not read image list',e.message,true);}
  }
  async function persist(patch){
    const revision=++preferenceWrite;
    if(host){els.prefStatus.textContent='Saving…';els.prefStatus.classList.remove('error');}
    try{await api.preferences.set(patch);if(host && revision===preferenceWrite)els.prefStatus.textContent='Saved in this browser';}
    catch{if(host && revision===preferenceWrite){els.prefStatus.textContent='Could not save settings. Try changing the option again.';els.prefStatus.classList.add('error');}}
  }
  function update(){
    if(!host)return;
    const prefs=api.preferences.snapshot(),active=eligible(),busy=!!job;
    for(const b of els.tabs){const k=b.dataset.kind;b.disabled=busy||!eligible(k).length;b.setAttribute('aria-selected',String(k===kind));b.tabIndex=k===kind?0:-1;}
    els.content.setAttribute('aria-labelledby','tp-download-tab-'+kind);
    els.count.textContent=active.length+' image'+(active.length===1?'':'s')+' available';
    els.allLabel.textContent=`Download all · ZIP (${active.length})`;els.all.disabled=busy||!active.length;els.refresh.disabled=busy;
    els.format.value=prefs.format;els.format.disabled=busy;
    els.quality.value=prefs.quality;els.quality.disabled=busy;els.qualityValue.value=prefs.quality+'%';
    els.qualityRow.hidden=!['jpeg','webp'].includes(prefs.format);
    els.formatNote.textContent=prefs.format==='auto'?'Default: Text overlays → PNG; other images keep their existing format.'
      :prefs.format==='jpeg'?'JPEG: transparent areas become white. Converted animations use one frame.'
      :prefs.format==='webp'?'WebP: quality controls file size. Converted animations use one frame.'
      :'PNG: lossless image encoding. Converted animations use one frame.';
    const scope=active.find(r=>r.text)?.scope,fontScale=scope?Math.round((Number(getComputedStyle(scope).getPropertyValue('--tp-font-scale'))||1)*100):null;
    els.note.textContent=kind==='translated'?`Existing Text and Image translations.${fontScale!==null?`\nOverlay font size ${fontScale}% · matches v1.2 export.`:''}`:
      kind==='clean'?'Existing cleaned Text-overlay backgrounds only.\nNo new erasing or processing.':'Original sources in this document, not translated layers.\nLazy sources are read without changing the page.';
    els.sumCount.textContent=String(active.length);els.list.replaceChildren();
    if(!active.length)els.list.append(el('div','empty','No images available for this type.'));
    for(const row of active){
      const item=el('div','asset-row'),thumb=el('div','thumb',String(row.number)),copy=el('div','asset-copy');thumb.setAttribute('aria-hidden','true');
      const format=prefs.format==='auto'?(kind==='translated'&&!row.rasterUrl?'PNG':'source format'):prefs.format.toUpperCase();
      const type=kind==='clean'?'Text background':kind==='original'?'Original':row.rasterUrl?'Image translation':'Text overlay';
      copy.append(el('b','',nameOf(row)),el('small','',`${type} · ${format}`));
      const done=completed.get(row.img)?.has(doneKey(kind,prefs));if(done)item.classList.add('is-previewed');
      const save=button('','icon-button',()=>start([row],false),`Download ${kind} ${nameOf(row)}`);save.title=save.getAttribute('aria-label');save.disabled=busy;save.append(icon(done?'check':'download'));
      item.append(thumb,copy,save);els.list.append(item);
    }
    const missing=kind==='original'?rows.filter(r=>!r.available.original).length:0;
    els.blocked.hidden=!missing;els.blocked.textContent=`${missing} original source${missing===1?'':'s'} unavailable · not included`;
  }
  function status(title,detail,error=false){
    if(!host)return;els.jobBox.hidden=false;els.jobTitle.textContent=title;els.jobDetail.textContent=detail;els.jobBox.classList.toggle('error',error);
  }
  function stop(){
    if(!job)return;job.controller.abort();
    status('Cancelling download','No unfinished ZIP will be saved. Translation is not affected.');els.cancel.disabled=true;
  }
  async function start(selected,archive){
    if(job||!selected.length)return;
    const prefs=api.preferences.snapshot();
    const current={controller:new AbortController(),kind,archive,...{format:prefs.format,quality:prefs.quality},title:document.title,href:location.href,instance:TP.pageInstanceId};job=current;
    els.cancel.hidden=false;els.cancel.disabled=false;els.dot.hidden=false;els.dot.textContent='0';els.fill.style.width='0%';
    status(archive?'Preparing ZIP':'Preparing image','Only existing image sources are read.');update();
    const nav=setInterval(()=>{if(location.href!==current.href || TP.pageInstanceId!==current.instance)current.controller.abort();},250);
    const pagehide=()=>current.controller.abort();window.addEventListener('pagehide',pagehide,{once:true});
    try{
      const result=await api.runDownload([...selected],{...current,signal:current.controller.signal},p=>{
        if(!host)return;
        if(p.phase==='progress'){els.fill.style.width=(p.index/p.total*100)+'%';els.dot.textContent=String(p.index);}
        else status(p.phase==='finishing'?'Finalizing ZIP':`${p.phase==='packing'?'Adding to ZIP':'Preparing'} ${p.index} / ${p.total}`,p.row?nameOf(p.row):'One archive will be sent to the browser.');
      });
      for(const row of result.prepared){let done=completed.get(row.img);if(!done){done=new Set();completed.set(row.img,done);}done.add(doneKey(current.kind,current));}
      const failureText=result.failures.slice(0,8).map(f=>`Page ${f.fileNumber}: ${f.error}`).join('\n');
      const detail=archive?(result.handedOff?`1 ZIP handed to your browser · ${result.prepared.length} / ${result.total} images included.`:'0 / '+result.total+' images available. No ZIP was saved.')
        :`${result.prepared.length} / ${result.total} file handed to your browser.`;
      status(result.failures.length?'Finished with unavailable images':'Sent to browser',detail+
        (failureText?'\n'+failureText+(result.failures.length>8?`\n+${result.failures.length-8} more failures`:''):'')+
        (archive&&result.handedOff&&result.failures.length?'\nThis ZIP is incomplete. See _download-errors.txt inside.':'')+
        (result.handedOff?'\nCheck browser downloads for the saved file.':''),result.failures.length>0);
    }catch(error){
      const cancelled=current.controller.signal.aborted||error.name==='AbortError';
      status(cancelled?'Download cancelled':'Download failed',cancelled?'No unfinished ZIP was saved. Translation continues unchanged.':error.message,true);
    }finally{
      clearInterval(nav);window.removeEventListener('pagehide',pagehide);if(job===current)job=null;
      if(host){els.cancel.hidden=true;els.dot.hidden=true;kind=api.preferences.snapshot().kind;update();}
    }
  }
  function show(){
    if(host?.isConnected || !document.documentElement)return;
    host=el('div');host.id='tp-download-control';
    for(const [k,v] of Object.entries({position:'fixed',right:'0px',bottom:'0px',width:'0px',height:'0px',display:'block',visibility:'visible',opacity:'1','z-index':'2147483647','pointer-events':'none'}))host.style.setProperty(k,v,'important');
    const shadow=host.attachShadow({mode:'open'}),style=el('style');style.textContent=api.panelCss;
    const root=el('div');root.id='download-root';els={};
    const panel=els.panel=el('section','download-panel');panel.id='tp-download-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');panel.setAttribute('aria-labelledby','tp-download-title');
    const header=el('header','panel-heading'),logo=el('span','mini-logo','TP'),title=el('strong','','Download images');title.id='tp-download-title';
    const close=button('','icon-button',()=>setOpen(false,true),'Minimize download panel');close.title='Minimize — does not cancel downloads';close.append(icon('close'));header.append(logo,title,close);
    panel.append(header,el('div','panel-subtitle','Existing images only. No new translation.'));
    const tabs=el('div','type-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Download type');els.tabs=[];
    for(const [k,label] of [['translated','Translated'],['clean','Text removed'],['original','Original']]){
      const b=button(label,'',()=>{kind=k;els.jobBox.hidden=true;void persist({kind:k});update();});b.dataset.kind=k;b.id='tp-download-tab-'+k;b.setAttribute('role','tab');b.setAttribute('aria-controls','tp-download-content');
      if(k==='clean')b.title='Requires an existing cleaned background from a Text overlay';
      b.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();
        const enabled=els.tabs.filter(x=>!x.disabled);if(!enabled.length)return;
        const i=enabled.indexOf(b),next=e.key==='Home'?enabled[0]:e.key==='End'?enabled.at(-1):enabled[(i+(e.key==='ArrowRight'?1:-1)+enabled.length)%enabled.length];
        if(next){next.click();next.focus();}
      });els.tabs.push(b);tabs.append(b);
    }
    panel.append(tabs);
    const content=els.content=el('div');content.id='tp-download-content';content.setAttribute('role','tabpanel');
    const counts=el('div','count-row'),label=el('span','count-label mono');els.count=el('span');label.append(el('span','status-dot'),els.count);
    const refreshButton=els.refresh=button('','refresh',refresh,'Refresh existing image list');refreshButton.append(icon('refresh'),document.createTextNode(' Refresh'));counts.append(label,refreshButton);
    els.note=el('div','mode-note');
    const options=el('div','export-options'),formatRow=el('label','option-row');formatRow.append(el('span','','Image format'));
    els.format=el('select');els.format.setAttribute('aria-label','Image format');
    for(const [value,label] of [['auto','Auto · current default'],['png','PNG'],['jpeg','JPEG (.jpg)'],['webp','WebP']]){const o=el('option','',label);o.value=value;els.format.append(o);}
    els.format.addEventListener('change',()=>void persist({format:els.format.value}));formatRow.append(els.format);
    els.qualityRow=el('label','option-row');els.qualityRow.append(el('span','','Quality'));
    const qualityControls=el('span','quality-controls');els.quality=el('input');els.quality.type='range';els.quality.min='1';els.quality.max='100';els.quality.step='1';els.quality.setAttribute('aria-label','Image quality');els.qualityValue=el('output');
    els.quality.addEventListener('input',()=>{els.qualityValue.value=els.quality.value+'%';});
    els.quality.addEventListener('change',()=>void persist({quality:Number(els.quality.value)}));qualityControls.append(els.quality,els.qualityValue);els.qualityRow.append(qualityControls);
    els.formatNote=el('div','format-note');els.prefStatus=el('div','prefs-status','Saved in this browser');els.prefStatus.setAttribute('role','status');
    options.append(formatRow,els.qualityRow,els.formatNote,els.prefStatus);
    els.all=button('','download-all',()=>start(eligible(),true));els.allLabel=el('span');els.all.append(icon('download'),els.allLabel);
    els.jobBox=el('div','job-box');els.jobBox.hidden=true;els.jobBox.setAttribute('role','status');els.jobBox.setAttribute('aria-live','polite');
    const top=el('div','job-top');els.jobTitle=el('strong');els.cancel=button('Cancel','',stop);els.cancel.hidden=true;top.append(els.jobTitle,els.cancel);
    const track=el('div','track');els.fill=el('div','fill');track.append(els.fill);els.jobDetail=el('div','job-detail');els.jobDetail.style.whiteSpace='pre-line';els.jobBox.append(top,track,els.jobDetail);
    const individual=els.individual=el('details','individual'),summary=el('summary'),summaryText=el('span','','Individual images ');els.sumCount=el('span','sum-count mono');summaryText.append(els.sumCount);summary.append(summaryText,icon('chevron'));els.list=el('div','image-list');individual.append(summary,els.list);
    individual.open=api.preferences.snapshot().individual;lastIndividual=individual.open;
    individual.addEventListener('toggle',()=>{if(host&&api.preferences.snapshot().individual!==individual.open)void persist({individual:individual.open});});
    els.blocked=el('div','blocked-note');els.blocked.hidden=true;
    content.append(counts,els.note,options,els.all,els.jobBox,individual,els.blocked);panel.append(content,el('footer','panel-footer','Current document · refresh after scrolling to load more'));
    const fabWrap=el('div','fab-wrap');els.toggle=button('','fab',()=>{if(!open)refresh();setOpen(!open);},'Open download images');els.toggle.title='Download images · TextPhantom';els.toggle.setAttribute('aria-controls',panel.id);els.toggle.append(icon('download'));
    els.dot=el('span','fab-dot mono');els.dot.hidden=true;fabWrap.append(els.toggle,el('span','fab-tooltip','Download images'),els.dot);
    root.append(panel,fabWrap);shadow.append(style,root);document.documentElement.append(host);setOpen(false);update();
    const escape=e=>{if(e.key==='Escape'&&open){setOpen(false,true);e.stopPropagation();}};
    const outside=e=>{if(open&&!e.composedPath().includes(host))setOpen(false);};
    document.addEventListener('keydown',escape,true);document.addEventListener('pointerdown',outside,true);
    root.addEventListener('click',e=>e.stopPropagation());root.addEventListener('mousedown',e=>e.stopPropagation());
    cleanup=()=>{document.removeEventListener('keydown',escape,true);document.removeEventListener('pointerdown',outside,true);};
  }
  function enable(value){if(value)show();else{stop();cleanup?.();cleanup=null;host?.remove();host=null;rows=[];open=false;}}
  api.preferences.subscribe(prefs=>{
    if(host && prefs.individual!==lastIndividual)els.individual.open=prefs.individual;
    lastIndividual=prefs.individual;
    if(!job){kind=prefs.kind;update();}
  });
  try{
    chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[KEY]){enableRevision++;enable(changes[KEY].newValue===true);}});
    chrome.storage.local.get(KEY,values=>{void chrome.runtime.lastError;if(!enableRevision&&values?.[KEY]===true)enable(true);});
    if(!document.documentElement)document.addEventListener('DOMContentLoaded',()=>{
      chrome.storage.local.get(KEY,values=>{void chrome.runtime.lastError;if(values?.[KEY]===true)enable(true);});
    },{once:true});
  }catch{/* Invalidated extension context never changes the publisher DOM. */}
})();
