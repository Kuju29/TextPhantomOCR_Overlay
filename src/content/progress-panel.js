(function(){
  const TP=window.__TP;if(!TP||TP.bail)return;
  // Selected-interface-language copy (shared/page-ui-text.js); English without it.
  const pt=(source,values)=>globalThis.TPPageText?globalThis.TPPageText.t(source,values)
    :String(source).replace(/\{([a-z]+)\}/g,(match,name)=>values&&name in values?String(values[name]):match);
  let root=null,main=null,textEl=null,body=null,toggleBtn=null,timer=0,hideTimer=0,paintTimer=0,latest=null,pending=null,collapsed=true,pageStarted=Date.now();
  const versions=new Map(),batchStates=new Map(),terminalDeadlines=new Map();
  const TERMINAL=new Set(['done','skipped','error','cancelled']);
  const processingDone=batch=>batch?.processingComplete===true && batch?.lifecycle==='completed';
  const repairActive=batch=>!batch?.processingComplete && !['cancelled','failed','empty'].includes(batch?.lifecycle) && ['collecting','repairing','repair_request','repair_wave','repair_circuit_open','applying','apply_pending'].includes(String(batch?.repair?.phase||''));
  const batchActive=batch=>!['cancelled','failed','empty'].includes(batch?.lifecycle) && (batch?.lifecycle==='discovering'||(batch?.placement?.released===true&&Number(batch?.placement?.waiting)>0)||(!processingDone(batch)&&(repairActive(batch)||Number(batch?.terminal||0)<Number(batch?.total||0))));
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
  // label/action name the English copy; each combination is one authored phrase.
  const LANE_TEXT={Lens:{run:'Lens reading text {done}/{total}',queue:'Lens reading text {done}/{total} · Lens queue {count}',wait:'Lens waiting {count} · {done}/{total}'},
    Group:{run:'Group grouping text {done}/{total}',queue:'Group grouping text {done}/{total} · Group queue {count}',wait:'Group waiting {count} · {done}/{total}'}};
  const simpleLaneSummary=(batch,laneName,label,action)=>{
    const lane=laneSet(batch,laneName);if(!lane.running.length&&!lane.queued.length)return '';
    const copy=LANE_TEXT[label],values={done:lane.finished,total:lane.total,count:lane.queued.length};
    if(lane.running.length){
      if(copy)return pt(lane.queued.length?copy.queue:copy.run,values);
      const queue=lane.queued.length?` · ${label} queue ${lane.queued.length}`:'';
      return `${label} ${action} ${lane.finished}/${lane.total}${queue}`;
    }
    return copy?pt(copy.wait,values):`${label} waiting ${lane.queued.length} · ${lane.finished}/${lane.total}`;
  };
  const AI_FUNCTION_LABEL=Object.freeze({
    waiting_slot:'waiting for slot',preparing_request:'preparing request',sending_request:'sending request',
    waiting_response_text:'waiting for response text',generating_response:'generating · receiving text',
    waiting_provider_terminal:'waiting for final usage',
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
  // Live provider-stream phase of the request (API progress rows).
  // The thinking timer advances on the 500 ms tick between updates.
  const STREAM_STOP_TEXT=Object.freeze({ai_thinking_too_long:'AI thought too long — stopping',
    ai_output_no_progress:'No new lines — stopping',ai_stream_ceiling:'Safety time limit — stopping'});
  const streamPhaseText=(lane,units)=>{
    const phase=lane?.function==='provider_stream'?lane.streamPhase:null;if(!phase)return '';
    if(phase.phase==='waiting')return pt('Waiting for provider…');
    if(phase.phase==='thinking'){
      const received=Number(phase.receivedAt)||Date.now(),ms=(Number(phase.phaseElapsedMs)||0)+Math.max(0,Date.now()-received);
      return pt('AI is thinking… ({seconds}s)',{seconds:Math.floor(ms/1000)});
    }
    if(phase.phase==='writing'){
      const done=Math.max(0,Number(phase.linesDone)||0),total=Number(phase.linesTotal)||Number(units)||0;
      return total?pt('Translating {done}/{total} lines',{done:Math.min(done,total),total}):pt('Translating {done} lines',{done});
    }
    return stopPhaseText(phase);
  };
  const stopPhaseText=phase=>phase.phase==='stopping'&&STREAM_STOP_TEXT[phase.reason]?pt(STREAM_STOP_TEXT[phase.reason]):pt('No response — stopping');
  // A provider stop stays readable for at least 1.5 s even when the page's
  // error arrives right after it. Display only: the work is never delayed.
  const STOP_HOLD_MS=1500,stopSeen=new Map();
  const heldStopText=batch=>{
    const now=Date.now();let text='';
    for(const item of itemsOf(batch)){
      const phase=item?.progress?.ai?.streamPhase;
      if(!phase||(phase.phase!=='stalled'&&phase.phase!=='stopping'))continue;
      const received=Number(phase.receivedAt)||0;if(!received||now-received>10000)continue;
      const key=`${batch?.id}:${item?.imageKey||item?.label}:${received}`;
      if(!stopSeen.has(key)){stopSeen.set(key,now);while(stopSeen.size>64)stopSeen.delete(stopSeen.keys().next().value);}
      if(now-stopSeen.get(key)<STOP_HOLD_MS)text=stopPhaseText(phase);
    }
    return text;
  };
  // Reader page numbers (1-based) of the pages in one AI request.
  const pageNumber=item=>{
    const index=Number(item?.pageIndex);if(item?.pageIndex!=null&&Number.isSafeInteger(index)&&index>=0)return index+1;
    const n=Number(String(item?.label||'').match(/\d+/)?.[0]);return Number.isSafeInteger(n)&&n>0?n:0;
  };
  const pagesText=items=>{
    const count=items.length;if(!count)return '';
    const numbers=[...new Set(items.map(pageNumber))].sort((a,b)=>a-b);
    if(numbers.includes(0))return pt(count===1?' (1 page)':' ({count} pages)',{count});
    const ranges=[];
    for(let i=0;i<numbers.length;){let j=i;while(j+1<numbers.length&&numbers[j+1]===numbers[j]+1)j++;ranges.push(i===j?String(numbers[i]):`${numbers[i]}–${numbers[j]}`);i=j+1;}
    if(ranges.length>3)return pt(' ({count} pages)',{count});
    return pt(numbers.length===1?' (page {pages})':' (pages {pages})',{pages:ranges.join(', ')});
  };
  // The shared API limited this browser install; work goes on by itself.
  const rateWaitText=batch=>{
    const left=(Number(batch?.rateWait?.until)||0)-Date.now();
    return left>0?pt('Server busy — waiting {seconds}s before continuing',{seconds:Math.ceil(left/1000)}):'';
  };
  const aiSummary=batch=>{
    const lane=laneSet(batch,'ai');if(!lane.running.length&&!lane.queued.length)return '';
    if(!lane.running.length)return pt('AI waiting for slot {count}p',{count:lane.queued.length});
    const active=lane.running.map(item=>item?.progress?.ai||{});
    const mostRecentTurn=Math.max(...active.map(x=>Number(x.turn)||0),0);
    const focus=active.find(x=>Number(x.turn)===mostRecentTurn && x.function)||active.find(x=>x.function)||active[0]||{};
    // turn_complete is emitted when the provider closes, before the ready
    // queue projects its answer to every page. Other rows may still have a
    // stale receiving_response function; their AI/repair ownership is intact.
    // The repair coordinator may be in "collecting" for the entire initial
    // provider request; that phase alone is not a repair generation.
    const repairGenerating=repairActive(batch) && batch?.repair?.phase!=='collecting';
    if(batch?.conversation?.phase==='turn_complete' && !repairGenerating &&
       Number(batch.conversation.turn)>=mostRecentTurn)
      return pt('AI reply complete · delivering page results');
    const fn=pt(aiFunction(focus)),conversation=active.some(x=>x.conversation===true);
    const units=conversation?Math.max(...active.map(x=>Number(x.unitCount)||0),0):active.reduce((sum,x)=>sum+(Number(x.unitCount)||0),0);
    // Name the pages of the request the counts belong to (one provider
    // request may cover several pages); page/unit totals stay in traces.
    const stamp=focus?.function==='provider_stream'?Number(focus?.streamPhase?.receivedAt)||0:0;
    let requestItems=stamp?lane.running.filter(item=>Number(item?.progress?.ai?.streamPhase?.receivedAt)===stamp)
      :conversation?lane.running.filter(item=>(Number(item?.progress?.ai?.turn)||0)===mostRecentTurn):lane.running;
    if(!requestItems.length)requestItems=lane.running;
    const pages=pagesText(requestItems);
    const live=streamPhaseText(focus,units);
    if(live){
      let text=`${live}${pages}`;
      const waiting=Math.max(...active.map(x=>Number(x.queuedPageCount)||0),0,lane.queued.length);
      if(waiting>0)text+=pt(' · queue {count}p',{count:waiting});
      return text;
    }
    const elapsed=oldestElapsed(lane.running);
    // The running lane belongs to the whole request, including pages that
    // already received a provisional overlay while later pages stream in.
    let text=pt(conversation?'AI request {function}':'AI {function}',{function:fn})+pages;
    if(elapsed)text+=` · ${elapsed}`;
    const hinted=Math.max(...active.map(x=>Number(x.queuedPageCount)||0),0),queue=Math.max(hinted,lane.queued.length);
    if(queue>0)text+=pt(' · queue {count}p',{count:queue});
    return text;
  };
  const insertSummary=batch=>{
    const lane=laneSet(batch,'insert');if(!lane.running.length&&!lane.queued.length)return '';
    if(lane.running.length)return pt(lane.queued.length?'Insert placing {count}p · Insert queue {queue}':'Insert placing {count}p',{count:lane.running.length,queue:lane.queued.length});
    return pt('Insert waiting {count}p',{count:lane.queued.length});
  };
  const resultAlerts=batch=>{
    const items=itemsOf(batch),counts={skipped:0,error:0,cancelled:0};
    for(const item of items){const state=String(item?.progress?.result?.state||'pending');if(state in counts)counts[state]++;}
    const stats=batch?.stats||{};counts.skipped=Math.max(counts.skipped,Number(stats.skipped||0)+Number(stats.scanSkipped||0));
    counts.error=Math.max(counts.error,Number(stats.error)||0);counts.cancelled=Math.max(counts.cancelled,Number(stats.aborted)||0);
    const parts=[];if(counts.skipped)parts.push(pt('skip {count}',{count:counts.skipped}));if(counts.error)parts.push(pt('error {count}',{count:counts.error}));if(counts.cancelled)parts.push(pt('cancel {count}',{count:counts.cancelled}));return parts;
  };
  const batchElapsed=batch=>{
    const start=Number(batch?.startedAt)||Date.now(),end=processingDone(batch)
      ? (Number(batch?.completedAt)||Number(batch?.ts)||Date.now())
      : batchActive(batch)?Date.now():(Number(batch?.completedAt)||Number(batch?.ts)||Date.now());
    return fmtMs(Math.max(0,end-start));
  };
  const compactText=batch=>{
    const items=itemsOf(batch),total=Math.max(Number(batch?.total)||0,items.length),terminal=items.filter(item=>item?.terminal||TERMINAL.has(String(item?.progress?.overall?.state||''))).length;
    const inserted=items.filter(item=>item?.inserted===true).length;
    const display=value=>globalThis.TPPageText?.display?.(value) ?? value;
    if (!total) return batch?.lifecycle==='discovering' ? display('TextPhantom: discovering images…')
      : `TextPhantom: ${display(batch?.stage || (batch?.lifecycle==='cancelled' ? 'Cancelled' : 'No eligible images'))}`;
    const parts=[pt('TextPhantom: inserted {inserted}/{total}',{inserted,total})];
    if(batch?.lifecycle==='cancelled')parts.push(pt('cancelled'));
    else if(batch?.processingComplete)parts.push(pt(batch?.placement?.waiting ? 'processing complete · {done}/{total} pages processed · {count} saved for display'
      : 'processing complete · {done}/{total} pages processed',{done:terminal,total,count:batch?.placement?.waiting}));
    const lens=simpleLaneSummary(batch,'lens','Lens','reading text');if(lens)parts.push(lens);
    const group=simpleLaneSummary(batch,'grouping','Group','grouping text');if(group)parts.push(group);
    const repair=batch?.repair||{};
    if(Number(repair.failedUnits)>0) {
      const remaining=Number(repair.unresolved)||0,values={done:Number(repair.repaired)||0,total:repair.failedUnits};
      if(repair.phase==='done')parts.push(pt(remaining?'Repair complete {done}/{total} · unresolved {count}':'Repair complete {done}/{total}',{...values,count:remaining}));
      else if(repair.phase==='apply_pending' && batch?.processingComplete)parts.push(pt(Number(repair.unappliedRepairedUnits)>0?'Repair translated {done}/{total} · {count} unit(s) ready when displayed'
        :'Repair translated {done}/{total}',{...values,count:repair.unappliedRepairedUnits}));
      else if(repairActive(batch))parts.push(pt(repair.phase==='collecting'?'Repair waiting · {done}/{total} fixed':'Repair active · {done}/{total} fixed',values));
    }
    let held='';
    if(!processingDone(batch)){
      const wait=batch?.lifecycle==='cancelled'?'':rateWaitText(batch);if(wait)parts.splice(1,0,wait);
      const ai=aiSummary(batch);held=heldStopText(batch);
      if(held&&!ai.includes(held))parts.push(held);else{held='';if(ai)parts.push(ai);}
      const insert=insertSummary(batch);if(insert)parts.push(insert);
    }
    if(held)return parts.join(' · ');
    parts.push(...resultAlerts(batch));
    if(total>0&&batch?.lifecycle!=="cancelled"&&batch?.placement?.waiting&&processingDone(batch))
      parts.splice(1,0,pt('AI finished in {time}',{time:batchElapsed(batch)}));
    else if(total>0&&batch?.lifecycle!=="cancelled"&&(!batch?.placement?.waiting&&(processingDone(batch)||(terminal>=total&&!repairActive(batch)))))
      parts.splice(1,0,pt('done {time}',{time:batchElapsed(batch)}));
    return parts.join(' · ');
  };


  function setCollapsed(value){
    const opening=collapsed && !value;
    collapsed=Boolean(value);if(!body||!toggleBtn||!main||!root||!textEl)return;
    if(opening && latest)renderDetails(latest);
    body.style.display=collapsed?'none':'block';
    toggleBtn.textContent=collapsed?'+':'−';
    toggleBtn.title=pt(collapsed?'Show per-image TextPhantom progress':'Hide per-image TextPhantom progress');
    toggleBtn.setAttribute('aria-expanded',String(!collapsed));
    toggleBtn.setAttribute('aria-label',pt(collapsed?'Show TextPhantom details':'Hide TextPhantom details'));
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
    const laneDetail=String(lane?.detail||'').trim(),baseDetail=globalThis.TPPageText?.display?.(laneDetail) ?? laneDetail,queueWait=Number(lane?.queueWaitMs)||0,detail=[baseDetail,queueWait>0?pt('queue {time}',{time:fmtMs(queueWait)}):''].filter(Boolean).join(' · ');wrap.appendChild(stateMain);
    if(detail&&state.cls!=='done'&&state.cls!=='skipped'&&state.cls!=='idle'){const sub=css(document.createElement('div'),{marginTop:'2px',color:'#aeb0b8',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',fontSize:'10px'});sub.textContent=detail;sub.title=detail;wrap.appendChild(sub);}
    wrap.dataset.startedAt=String(Number(lane?.startedAt)||Number(lane?.queuedAt)||0);wrap.dataset.finishedAt=String(Number(lane?.finishedAt)||0);wrap.dataset.state=String(lane?.state||'idle');return wrap;
  };
  function resultCell(item){
    const result=item?.progress?.result||{},cell=css(document.createElement('div'),{minWidth:'0',padding:'5px 6px',borderLeft:'1px solid rgba(255,255,255,.06)'}),state=String(result.state||'pending'),resultMain=document.createElement('div');resultMain.textContent=pt(state==='done'?'✓ done':state==='skipped'?'skip':state==='error'?'✕ error':state==='cancelled'?'cancel':'…');css(resultMain,{fontWeight:'700',color:state==='error'?'#ffb4b4':state==='done'?'#d8ffd8':state==='skipped'?'#d0d0d5':'#bbb'});cell.appendChild(resultMain);
    const detail=String(result.detail||item?.error||'').trim();if(detail&&state!=='done'){const sub=css(document.createElement('div'),{marginTop:'2px',fontSize:'10px',color:'#aeb0b8',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'});sub.textContent=detail;sub.title=detail;cell.appendChild(sub);}return cell;
  }
  function renderDetails(batch){
    if(!body)return;const scrollTop=body.scrollTop;body.textContent='';
    const grid=css(document.createElement('div'),{display:'grid',gridTemplateColumns:'54px 76px minmax(100px,1fr) minmax(100px,1fr) minmax(130px,1.25fr) minmax(100px,1fr) minmax(90px,1fr)',minWidth:'720px'});
    for(const title of ['Page','Total','Lens','Group','AI / queue','Insert','Result']){const h=css(document.createElement('div'),{padding:'5px 6px',position:'sticky',top:'0',zIndex:'1',background:'#18181b',fontWeight:'700',color:'#ddd',borderBottom:'1px solid rgba(255,255,255,.1)'});h.textContent=pt(title);grid.appendChild(h);}
    const items=itemsOf(batch).slice();items.sort((a,b)=>Number(a.terminal)-Number(b.terminal)||Number(a?.label?.match(/\d+/)?.[0]||999)-Number(b?.label?.match(/\d+/)?.[0]||999));
    for(const item of items){const p=item.progress||{},rowCells=[],page=css(document.createElement('div'),{padding:'6px',fontWeight:'700',borderBottom:'1px solid rgba(255,255,255,.05)'});page.textContent=item.label?String(item.label).replace('Image ','#'):pt('Image');rowCells.push(page);rowCells.push(laneCell(p.overall,'overall'),laneCell(p.lens,'lens'),laneCell(p.grouping,'grouping'),laneCell(p.ai,'ai'),laneCell(p.insert,'insert'),resultCell(item));for(const c of rowCells){c.style.borderBottom='1px solid rgba(255,255,255,.05)';grid.appendChild(c);}}
    body.appendChild(grid);body.scrollTop=scrollTop;
  }
  function render(batch){
    latest=batch;if(!batch)return;
    const active=batchActive(batch);
    const deadline=active ? 0 : (terminalDeadlines.get(batch.id) || Date.now()+6000);
    // A late placement/status receipt after the terminal grace period must
    // not reopen the box for a single paint and immediately hide it again.
    if(!active && deadline<=Date.now())return;
    if(!ensure())return;if(hideTimer){clearTimeout(hideTimer);hideTimer=0;}
    updateCompact(batch);if(!collapsed)renderDetails(batch);setCollapsed(collapsed);
    if(!active) {
      terminalDeadlines.set(batch.id,deadline);
      while(terminalDeadlines.size>128)terminalDeadlines.delete(terminalDeadlines.keys().next().value);
      hideTimer=setTimeout(()=>{
        hideTimer=0;
        if(batchActive(chooseVisible()) || (pending && batchActive(pending)))return;
        if(root)root.style.display='none';TP.setToastProgressMode?.(false);
        if(timer){clearInterval(timer);timer=0;}
      },Math.max(0,deadline-Date.now()));
    } else terminalDeadlines.delete(batch.id);
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
    pageStarted=Date.now();collapsed=true;versions.clear();batchStates.clear();terminalDeadlines.clear();latest=pending=null;if(hideTimer)clearTimeout(hideTimer);hideTimer=0;if(paintTimer)clearTimeout(paintTimer);paintTimer=0;if(timer)clearInterval(timer);timer=0;
    TP.setToastProgressMode?.(false);root=main=textEl=body=toggleBtn=null;
  };
  window.addEventListener('pagehide',()=>{
    document.removeEventListener('keydown',onDocumentKeydown,true);
    document.removeEventListener('pointerdown',onDocumentPointerDown,true);
    clearInterval(timer);TP.clearBatchProgress?.();
  },{once:true});
})();
