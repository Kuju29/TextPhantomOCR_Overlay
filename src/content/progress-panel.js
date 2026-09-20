(function(){
  const TP=window.__TP;if(!TP||TP.bail)return;
  let root=null,main=null,textEl=null,body=null,toggleBtn=null,timer=0,hideTimer=0,paintTimer=0,latest=null,pending=null,collapsed=true,pageStarted=Date.now();
  const versions=new Map(),batchStates=new Map();
  const TERMINAL=new Set(['done','skipped','error','cancelled']);
  const repairActive=batch=>['collecting','repairing','repair_request','repair_wave','repair_circuit_open','applying','apply_pending','blocked'].includes(String(batch?.repair?.phase||''));
  const batchActive=batch=>repairActive(batch)||Number(batch?.terminal||0)<Number(batch?.total||0);
  const chooseVisible=()=>{const all=[...batchStates.values()];const active=all.filter(batchActive).sort((a,b)=>(Number(b.startedAt)||0)-(Number(a.startedAt)||0));if(active.length)return active[0];return all.sort((a,b)=>(Number(b.ts)||0)-(Number(a.ts)||0))[0]||null;};
  const fmtMs=ms=>{ms=Math.max(0,Number(ms)||0);if(ms<1000)return `${Math.round(ms)}ms`;const sec=ms/1000;return `${sec>=10?sec.toFixed(0):sec.toFixed(1)}s`;};
  const nowMs=lane=>{const start=Number(lane?.startedAt)||Number(lane?.queuedAt)||0;if(!start)return 0;return Math.max(0,(Number(lane?.finishedAt)||Date.now())-start);};
  const stateText=lane=>{const state=String(lane?.state||'idle');const elapsed=fmtMs(nowMs(lane));if(state==='idle')return {main:'—',cls:'idle'};if(state==='queued')return {main:`Q ${elapsed}`,cls:'queued'};if(state==='running')return {main:`RUN ${elapsed}`,cls:'running'};if(state==='done')return {main:`✓ ${elapsed}`,cls:'done'};if(state==='skipped')return {main:'skip',cls:'skipped'};if(state==='error')return {main:'ERR',cls:'error'};if(state==='cancelled')return {main:'cancel',cls:'cancelled'};return {main:state,cls:'idle'};};
  const css=(el,values)=>{Object.assign(el.style,values);return el;};
  const itemsOf=batch=>Array.isArray(batch?.items)?batch.items:[];
  const laneSet=(batch,laneName)=>{
    const items=itemsOf(batch),total=Math.max(Number(batch?.total)||0,items.length);
    const state=item=>String(item?.progress?.[laneName]?.state||'idle');
    const running=items.filter(item=>state(item)==='running');
    const queued=items.filter(item=>state(item)==='queued');
    const finished=items.filter(item=>TERMINAL.has(state(item))).length;
    return {items,total,running,queued,finished};
  };
  const oldestElapsed=items=>{
    const starts=(items||[]).map(item=>{const lane=item?.progress?.ai||{};return Number(lane.startedAt)||Number(lane.queuedAt)||0;}).filter(Boolean);
    return starts.length?fmtMs(Math.max(0,Date.now()-Math.min(...starts))):'';
  };
  const simpleLaneSummary=(batch,laneName,label,action)=>{
    const lane=laneSet(batch,laneName);if(!lane.running.length&&!lane.queued.length)return '';
    if(lane.running.length){
      const queue=lane.queued.length?` · ${label} queue ${lane.queued.length}`:'';
      return `${label} ${action} ${lane.finished}/${lane.total}${queue}`;
    }
    return `${label} waiting ${lane.queued.length} · ${lane.finished}/${lane.total}`;
  };
  const AI_FUNCTION_LABEL=Object.freeze({
    waiting_slot:'waiting for slot',preparing_request:'preparing request',sending_request:'sending request',
    waiting_response:'waiting response',receiving_response:'receiving response',validating_result:'validating result',
    connecting:'connecting',waiting_model:'waiting for model',thinking:'thinking',recovering_context:'recovering context',
    preparing_next_turn:'preparing next turn',repair_waiting:'repair waiting for batch',repairing:'preparing repair',
    repair_waiting_response:'repair waiting response',server_pipeline:'server processing',
  });
  const aiFunction=(lane={})=>{
    const key=String(lane.function||'');if(AI_FUNCTION_LABEL[key])return AI_FUNCTION_LABEL[key];
    const detail=String(lane.detail||'').toLowerCase();
    if(detail.includes('waiting response'))return 'waiting response';
    if(detail.includes('sending'))return 'sending request';
    if(detail.includes('validating'))return 'validating result';
    if(detail.includes('repair'))return detail.includes('waiting')?'repair waiting':'repairing';
    if(detail.includes('generating')||detail.includes('responded'))return 'receiving response';
    if(detail.includes('model'))return 'waiting for model';
    if(detail.includes('connecting'))return 'connecting';
    return 'working';
  };
  const aiSummary=batch=>{
    const lane=laneSet(batch,'ai');if(!lane.running.length&&!lane.queued.length)return '';
    if(!lane.running.length)return `AI waiting for slot ${lane.queued.length}p`;
    const active=lane.running.map(item=>item?.progress?.ai||{}),focus=active.find(x=>x.function)||active[0]||{};
    const fn=aiFunction(focus),conversation=active.some(x=>x.conversation===true);
    let pages=0,units=0;
    if(conversation){pages=Math.max(...active.map(x=>Number(x.pageCount)||0),lane.running.length);units=Math.max(...active.map(x=>Number(x.unitCount)||0),0);}
    else {pages=lane.running.length;units=active.reduce((sum,x)=>sum+(Number(x.unitCount)||0),0);}
    const scope=units>0?`${pages}p/${units}u`:`${pages}p`;
    const elapsed=oldestElapsed(lane.running);
    let text=`AI ${fn} ${scope}`;
    if(elapsed)text+=` · ${elapsed}`;
    const hinted=Math.max(...active.map(x=>Number(x.queuedPageCount)||0),0),queue=Math.max(hinted,lane.queued.length);
    if(queue>0)text+=` · queue ${queue}p`;
    return text;
  };
  const insertSummary=batch=>{
    const lane=laneSet(batch,'insert');if(!lane.running.length&&!lane.queued.length)return '';
    if(lane.running.length){const queue=lane.queued.length?` · Insert queue ${lane.queued.length}`:'';return `Insert placing ${lane.running.length}p${queue}`;}
    return `Insert waiting ${lane.queued.length}p`;
  };
  const resultAlerts=batch=>{
    const items=itemsOf(batch),counts={skipped:0,error:0,cancelled:0};
    for(const item of items){const state=String(item?.progress?.result?.state||'pending');if(state in counts)counts[state]++;}
    const stats=batch?.stats||{};counts.skipped=Math.max(counts.skipped,Number(stats.skipped||0)+Number(stats.scanSkipped||0));
    counts.error=Math.max(counts.error,Number(stats.error)||0);counts.cancelled=Math.max(counts.cancelled,Number(stats.aborted)||0);
    const parts=[];if(counts.skipped)parts.push(`skip ${counts.skipped}`);if(counts.error)parts.push(`error ${counts.error}`);if(counts.cancelled)parts.push(`cancel ${counts.cancelled}`);return parts;
  };
  const batchElapsed=batch=>{
    const start=Number(batch?.startedAt)||Date.now(),end=batchActive(batch)?Date.now():(Number(batch?.ts)||Date.now());return fmtMs(Math.max(0,end-start));
  };
  const compactText=batch=>{
    const items=itemsOf(batch),total=Math.max(Number(batch?.total)||0,items.length),terminal=items.filter(item=>item?.terminal||TERMINAL.has(String(item?.progress?.overall?.state||''))).length;
    const inserted=items.filter(item=>item?.inserted===true).length;
    const parts=[`TextPhantom: inserted ${inserted}/${total}`];
    const lens=simpleLaneSummary(batch,'lens','Lens','reading text');if(lens)parts.push(lens);
    const group=simpleLaneSummary(batch,'grouping','Group','grouping text');if(group)parts.push(group);
    const repair=batch?.repair||{};
    if(Number(repair.failedUnits)>0) {
      const remaining=Number(repair.unresolved)||0;
      if(repair.phase==='done')parts.push(`Repair complete ${Number(repair.repaired)||0}/${repair.failedUnits}${remaining?` · unresolved ${remaining}`:''}`);
      else if(repairActive(batch))parts.push(`Repair ${repair.phase==='collecting'?'waiting':'active'} · ${Number(repair.repaired)||0}/${repair.failedUnits} fixed`);
    }
    const ai=aiSummary(batch);if(ai)parts.push(ai);
    const insert=insertSummary(batch);if(insert)parts.push(insert);
    parts.push(...resultAlerts(batch));
    if(total>0&&terminal>=total&&!repairActive(batch))parts.splice(1,0,`done ${batchElapsed(batch)}`);
    return parts.join(' · ');
  };


  function setCollapsed(value){
    collapsed=Boolean(value);if(!body||!toggleBtn||!main||!root||!textEl)return;
    body.style.display=collapsed?'none':'block';
    toggleBtn.textContent=collapsed?'+':'−';
    toggleBtn.title=collapsed?'Show per-image TextPhantom progress':'Hide per-image TextPhantom progress';
    toggleBtn.setAttribute('aria-expanded',String(!collapsed));
    toggleBtn.setAttribute('aria-label',collapsed?'Show TextPhantom details':'Hide TextPhantom details');
    main.style.borderBottom=collapsed?'0':'1px solid rgba(255,255,255,.10)';
    root.style.width=collapsed?'auto':'min(1180px, calc(100vw - 20px))';
    root.style.maxWidth=collapsed?'68vw':'calc(100vw - 20px)';
    root.style.maxHeight=collapsed?'none':'46vh';
    textEl.style.whiteSpace='nowrap';
  }

  const collapseDetails=()=>{if(!collapsed)setCollapsed(true);};
  const onDocumentKeydown=event=>{if(event?.key==='Escape')collapseDetails();};
  const onDocumentPointerDown=event=>{
    if(collapsed||!root?.isConnected)return;
    const target=event?.target;
    if(target&&root.contains(target))return;
    setCollapsed(true);
  };
  document.addEventListener('keydown',onDocumentKeydown,true);
  document.addEventListener('pointerdown',onDocumentPointerDown,true);

  function ensure(){
    const host=TP.getToastProgressHost?.();if(!host)return false;
    if(root!==host.root){root=host.root;main=host.main;textEl=host.text;toggleBtn=host.toggle;body=host.details;}
    TP.setToastProgressMode?.(true);
    if(toggleBtn.dataset.tpProgressBound!=='1'){
      toggleBtn.dataset.tpProgressBound='1';
      toggleBtn.addEventListener('click',()=>setCollapsed(!collapsed));
    }
    setCollapsed(collapsed);
    if(!timer)timer=setInterval(tick,500);
    return true;
  }

  function updateCompact(batch){
    if(!batch||!ensure())return;
    const value=compactText(batch);textEl.textContent=value;textEl.title=value;
    root.style.display='block';
  }

  const laneCell=(lane,name)=>{
    const wrap=document.createElement('div');wrap.className='tp-pg-cell';css(wrap,{minWidth:'0',padding:'5px 6px',borderLeft:'1px solid rgba(255,255,255,.06)'});
    const state=stateText(lane),stateMain=document.createElement('div');stateMain.dataset.role='state';stateMain.dataset.lane=name;stateMain.textContent=state.main;css(stateMain,{fontWeight:state.cls==='running'||state.cls==='error'?'700':'600',whiteSpace:'nowrap',color:state.cls==='error'?'#ffb4b4':state.cls==='running'?'#fff':state.cls==='done'?'#d8ffd8':state.cls==='queued'?'#ffe7a3':'#c8c8ce'});
    const baseDetail=String(lane?.detail||'').trim(),queueWait=Number(lane?.queueWaitMs)||0,detail=[baseDetail,queueWait>0?`queue ${fmtMs(queueWait)}`:''].filter(Boolean).join(' · ');wrap.appendChild(stateMain);
    if(detail&&state.cls!=='done'&&state.cls!=='skipped'&&state.cls!=='idle'){const sub=css(document.createElement('div'),{marginTop:'2px',color:'#aeb0b8',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',fontSize:'10px'});sub.textContent=detail;sub.title=detail;wrap.appendChild(sub);}
    wrap.dataset.startedAt=String(Number(lane?.startedAt)||Number(lane?.queuedAt)||0);wrap.dataset.finishedAt=String(Number(lane?.finishedAt)||0);wrap.dataset.state=String(lane?.state||'idle');return wrap;
  };
  function resultCell(item){
    const result=item?.progress?.result||{},cell=css(document.createElement('div'),{minWidth:'0',padding:'5px 6px',borderLeft:'1px solid rgba(255,255,255,.06)'}),state=String(result.state||'pending'),resultMain=document.createElement('div');resultMain.textContent=state==='done'?'✓ done':state==='skipped'?'skip':state==='error'?'✕ error':state==='cancelled'?'cancel':'…';css(resultMain,{fontWeight:'700',color:state==='error'?'#ffb4b4':state==='done'?'#d8ffd8':state==='skipped'?'#d0d0d5':'#bbb'});cell.appendChild(resultMain);
    const detail=String(result.detail||item?.error||'').trim();if(detail&&state!=='done'){const sub=css(document.createElement('div'),{marginTop:'2px',fontSize:'10px',color:'#aeb0b8',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});sub.textContent=detail;sub.title=detail;cell.appendChild(sub);}return cell;
  }
  function renderDetails(batch){
    if(!body)return;body.textContent='';
    const grid=css(document.createElement('div'),{display:'grid',gridTemplateColumns:'54px 76px minmax(100px,1fr) minmax(100px,1fr) minmax(130px,1.25fr) minmax(100px,1fr) minmax(90px,1fr)',minWidth:'720px'});
    for(const title of ['Page','Total','Lens','Group','AI / queue','Insert','Result']){const h=css(document.createElement('div'),{padding:'5px 6px',position:'sticky',top:'0',zIndex:'1',background:'#18181b',fontWeight:'700',color:'#ddd',borderBottom:'1px solid rgba(255,255,255,.1)'});h.textContent=title;grid.appendChild(h);}
    const items=itemsOf(batch).slice();items.sort((a,b)=>Number(a.terminal)-Number(b.terminal)||Number(a?.label?.match(/\d+/)?.[0]||999)-Number(b?.label?.match(/\d+/)?.[0]||999));
    for(const item of items){const p=item.progress||{},rowCells=[],page=css(document.createElement('div'),{padding:'6px',fontWeight:'700',borderBottom:'1px solid rgba(255,255,255,.05)'});page.textContent=String(item.label||'Image').replace('Image ','#');rowCells.push(page);rowCells.push(laneCell(p.overall,'overall'),laneCell(p.lens,'lens'),laneCell(p.grouping,'grouping'),laneCell(p.ai,'ai'),laneCell(p.insert,'insert'),resultCell(item));for(const c of rowCells){c.style.borderBottom='1px solid rgba(255,255,255,.05)';grid.appendChild(c);}}
    body.appendChild(grid);
  }
  function render(batch){
    latest=batch;if(!batch||!ensure())return;if(hideTimer){clearTimeout(hideTimer);hideTimer=0;}
    updateCompact(batch);renderDetails(batch);setCollapsed(collapsed);
    const terminal=Number(batch.terminal)||0,total=Number(batch.total)||0;if(total>0&&terminal>=total&&!repairActive(batch))hideTimer=setTimeout(()=>{if(root)root.style.display='none';TP.setToastProgressMode?.(false);if(timer){clearInterval(timer);timer=0;}},6000);
  }
  function tick(){
    if(!root?.isConnected||root.style.display==='none')return;if(latest)updateCompact(latest);
    if(collapsed)return;
    body?.querySelectorAll('.tp-pg-cell').forEach(cell=>{const state=cell.dataset.state;if(state!=='running'&&state!=='queued')return;const start=Number(cell.dataset.startedAt)||0;if(!start)return;const elapsed=Date.now()-start,stateMain=cell.querySelector('[data-role="state"]');if(!stateMain)return;stateMain.textContent=state==='running'?`RUN ${fmtMs(elapsed)}`:`Q ${fmtMs(elapsed)}`;});
  }
  TP.updateBatchProgress=batch=>{
    if(!batch?.id)return;if(batch.pageInstanceId&&TP.pageInstanceId&&batch.pageInstanceId!==TP.pageInstanceId)return;if(Number(batch.startedAt)&&Number(batch.startedAt)<pageStarted)return;
    const seq=Number(batch.sequence)||0,prev=versions.get(String(batch.id))||0;if(seq&&seq<=prev)return;if(seq)versions.set(String(batch.id),seq);while(versions.size>128)versions.delete(versions.keys().next().value);
    batchStates.set(String(batch.id),batch);while(batchStates.size>16)batchStates.delete(batchStates.keys().next().value);pending=chooseVisible();if(paintTimer)return;paintTimer=setTimeout(()=>{paintTimer=0;const next=pending;pending=null;render(next);},80);
  };
  TP.clearBatchProgress=()=>{
    pageStarted=Date.now();collapsed=true;versions.clear();batchStates.clear();latest=pending=null;if(hideTimer)clearTimeout(hideTimer);hideTimer=0;if(paintTimer)clearTimeout(paintTimer);paintTimer=0;if(timer)clearInterval(timer);timer=0;
    TP.setToastProgressMode?.(false);root=main=textEl=body=toggleBtn=null;
  };
  window.addEventListener('pagehide',()=>{
    document.removeEventListener('keydown',onDocumentKeydown,true);
    document.removeEventListener('pointerdown',onDocumentPointerDown,true);
    clearInterval(timer);TP.clearBatchProgress?.();
  },{once:true});
})();
