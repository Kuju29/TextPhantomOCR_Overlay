// One content-owned result path for a logical reader run. It never invokes OCR
// or AI. Worker batching/session ownership remains the 19.23 authority.
(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;
  const classify = TP.readerClassification;
  let current = null;
  const MAX_STAGED_CHARS = 256 * 1024 * 1024;
  const stale = reason => ({ok:true, applied:false, stale:true, reason});
  function live(run) {
    return !!run && run === current && !run.cancelled && run.pageInstanceId === TP.pageInstanceId && (run.plan.adapter==='kagane' ? TP.kagane.isCurrent(run.plan) : run.href === location.href);
  }
  function notify(type, detail) {
    try { chrome.runtime.sendMessage({type, ...detail}, () => void chrome.runtime.lastError); } catch {}
  }
  function cancel(reason = 'cancelled', report = false, keepKaganeDisplay = false) {
    const run = current;
    if (!run) return;
    TP.log.info('reader run cancelled', {runId:run.id, reason,
      adapter:run.plan.adapter,visibility:document.visibilityState,
      rootConnected:run.plan.root?.isConnected===true,pageInstanceId:run.pageInstanceId,
      stagedResults:run.results.size,unresolved:run.unresolved.size});
    TP.scanDiag?.emit('reader.run_cancelled',{reason,runId:run.id,
      knownSources:run.sources.size,stagedResults:run.results.size});
    run.cancelled = true;
    TP.clearReaderImageErrors?.(run.id);
    run.controller.abort();
    run.observer?.disconnect();
    run.recoveryObserver?.disconnect();
    clearTimeout(run.recoveryTimer);
    run.intersection?.disconnect();
    clearTimeout(run.retryTimer);
    if (run.visibilityChanged) document.removeEventListener('visibilitychange',run.visibilityChanged);
    if(run.watchRoot && run.sourceLoaded)run.watchRoot.removeEventListener('load',run.sourceLoaded,true);
    clearTimeout(run.timer);
    for (const [img, handler] of run.loads) img.removeEventListener('load', handler);
    // Cancelling processing invalidates future inserts, not a translation
    // already visible on its unchanged image. A retired layer cannot migrate
    // to a different image or chapter.
    if (!keepKaganeDisplay || run.plan.adapter!=='kagane')
      TP.overlayMount?.retireReaderOverlays?.([...run.results.keys()].map(id =>
        ({key:generation(run,id).targetKey,source:run.sources.get(id)})));
    run.results.clear(); run.bindings.clear(); run.loads.clear(); run.pending.clear(); run.unresolved.clear(); run.observedSlots.clear();
    current = null;
    if (report) notify('TP_READER_CANCELLED', {readerRunId:run.id, reason});
  }
  function owner(run, id) {
    id=String(id);
    if (!run.plan.root.isConnected) return null;
    const slot=run.plan.slots.get(id);
    if (slot?.isConnected && run.plan.root.contains(slot) && classify.number(slot,run.plan.attr)===id) return slot;
    // A missed removal must not leave us holding a dead slot forever. Query
    // only this known identity, inside this run's root; never fall back to URL.
    const label=(slot && classify.number(slot,run.plan.attr)===id ? slot.getAttribute(run.plan.attr) : '') ||
      (run.plan.attr==='aria-label' ? `Page ${id}` : id);
    const matches=[...run.plan.root.querySelectorAll(`[${run.plan.attr}="${CSS.escape(label)}"]`)]
      .filter(el => !classify.own(el) && el.matches(run.plan.selector) && classify.number(el,run.plan.attr)===id);
    if (matches.length!==1) return null;
    run.plan.slots.set(id,matches[0]);return matches[0];
  }
  function target(run, id) {
    const img = (classify.surface || classify.image)(owner(run,id));
    if (img) run.targetPages.set(img, String(id));
    return img;
  }
  function diagnostic(run, row, reason, timing = {}, state = '') {
    TP.traceNoteFor?.(row?.message?.tpTrace || '', 'content/reader/runtime.js', state ? `readerPlacement_${state}` : 'readerPlacement', {
      schema:'tp.audit/1', event:'image_status', reason,
      scope:{runId:run.id, pageId:`p${row?.message?.generation?.readerPageId || 0}`},
      timing, counts:{pending:run.unresolved.size},
    });
  }
  function generation(run, id) {
    return {pageInstanceId:run.pageInstanceId, readerRunId:run.id, readerPageId:String(id),
      targetKey:run.plan.adapter==='kagane'
        ? `tp-reader:kagane:${run.plan.seriesId}:${run.plan.chapterId}:${id}`
        : `tp-reader:${run.id}:${id}`};
  }
  function keyPage(run,key) {
    const prefix=run.plan.adapter==='kagane'
      ? `tp-reader:kagane:${run.plan.seriesId}:${run.plan.chapterId}:`
      : `tp-reader:${run.id}:`;
    return typeof key==='string' && key.startsWith(prefix) ? key.slice(prefix.length) : '';
  }
  function validates(img, stamp) {
    const run = current;
    if (!run || !live(run) || stamp.readerRunId !== run.id || stamp.pageInstanceId !== run.pageInstanceId)
      return {ok:false,reason:'reader generation changed'};
    if (!img?.isConnected || target(run,stamp.readerPageId) !== img)
      return {ok:false,reason:'logical page is not mounted'};
    const expected = run.sources.get(String(stamp.readerPageId));
    const actual = img.matches('canvas') ? classify.source(owner(run,stamp.readerPageId)) :
      TP.normUrl(TP.alphaManga?.keyedUrl(img.currentSrc || img.src || '') ||
        TP.mangaMirai?.keyedUrl(img.currentSrc || img.src || '',img) ||
        TP.kManga?.keyedUrl(img.currentSrc || img.src || '') || img.currentSrc || img.src || '');
    const row = run.results.get(String(stamp.readerPageId));
    if (actual && expected && actual !== expected && actual !== row?.appliedSource &&
        !TP.isReaderEquivalentSource?.(actual,expected) &&
        !TP.kagane?.ownsSource(run.plan,stamp.readerPageId,expected)) return {ok:false,reason:'logical page source changed'};
    return {ok:true,reason:''};
  }
  function errorTarget(run,id) {
    const img=target(run,id);
    if (img && !validates(img,generation(run,id)).ok) return null;
    const rect=img?.getBoundingClientRect();
    return rect && rect.width>=2 && rect.height>=2 ? img : owner(run,id);
  }
  function errorCurrent(anchor,stamp) {
    const run=current, id=String(stamp?.readerPageId || '');
    if (!live(run) || stamp.readerRunId!==run.id || stamp.pageInstanceId!==run.pageInstanceId || !run.sources.has(id))
      return {ok:false,reason:'reader generation changed'};
    if (!anchor?.isConnected || (anchor!==owner(run,id) && anchor!==target(run,id)))
      return {ok:false,reason:'logical page is not mounted'};
    const img=target(run,id);
    return img ? validates(img,stamp) : {ok:true,reason:''};
  }
  TP.findReaderErrorTarget = stamp => live(current) && stamp?.readerRunId===current.id
    ? errorTarget(current,String(stamp.readerPageId)) : null;
  TP.readerErrorCurrent = errorCurrent;

  // One small safety net feeds the EXISTING placement queue. It has no access
  // to acquisition/OCR/AI. Placed pages are removed; hidden tabs do not poll.
  function watchPending(run,id) {
    const slot=owner(run,id), old=run.observedSlots.get(id);
    if (old===slot) return;
    if (old) {run.intersection?.unobserve(old);run.observedSlots.delete(id);}
    if (!slot || typeof IntersectionObserver!=='function') return;
    if (!run.intersection) run.intersection=new IntersectionObserver(entries=>{
      if (!live(run)) return;
      const ids=[];
      for (const entry of entries) {
        const page=classify.number(entry.target,run.plan.attr);
        if (entry.isIntersecting && run.unresolved.has(page) && run.observedSlots.get(page)===entry.target) ids.push(page);
      }
      schedule(run,ids);
    },{root:null,rootMargin:'250px',threshold:0});
    run.observedSlots.set(id,slot);run.intersection.observe(slot);
  }
  function retryPending(run) {
    if (!live(run) || !run.unresolved.size || run.retryTimer || document.hidden) return;
    run.retryTimer=setTimeout(()=>{
      run.retryTimer=0;
      if (!live(run)) {if(run===current)cancel('reader_navigation',true);return;}
      if (!run.plan.root.isConnected) {waitForKaganeRoot(run);return;}
      if (document.hidden) return;
      const ids=[...run.unresolved].slice(0,8);
      for(const id of ids) {
        run.unresolved.delete(id);run.unresolved.add(id); // bounded round-robin
        watchPending(run,id);
      }
      run.retryDelay=Math.min(5000,run.retryDelay*2);
      schedule(run,ids);retryPending(run);
    },run.retryDelay);
  }
  function waiting(run,id,row,state) {
    run.unresolved.add(id);
    const kind=target(run,id)?.tagName || 'NONE', signature=`${row.version}:${state}:${kind}`;
    if (row.waitSignature!==signature) {
      row.waitSignature=signature;
      diagnostic(run,row,state==='source_mismatch'?'source_unavailable':'unconfirmed_ack',{},`${state}_${kind.toLowerCase()}`);
      TP.log.info('reader placement waiting',{runId:run.id,pageId:id,state,target:kind});
      TP.scanDiag?.emit('reader.placement_waiting',{pageId:id,state,target:kind,
        expected:TP.scanDiag.describeSource(run.sources.get(id)),
        actual:TP.scanDiag.describeSource(classify.source(owner(run,id)))});
    }
    watchPending(run,id);retryPending(run);
    return {ok:true,stored:true,pending:true,applied:false,reason:state};
  }
  function resolved(run,id,row) {
    run.unresolved.delete(id);row.waitSignature='';
    const slot=run.observedSlots.get(id);
    if(slot){run.intersection?.unobserve(slot);run.observedSlots.delete(id);}
    if (!run.unresolved.size) {
      clearTimeout(run.retryTimer);run.retryTimer=0;run.retryDelay=750;
      run.intersection?.disconnect();run.intersection=null;run.observedSlots.clear();
    }
  }
  function sameKaganeChapter(run, plan) {
    return run?.plan.adapter==='kagane' && plan?.adapter==='kagane' &&
      run.pageInstanceId===TP.pageInstanceId && TP.kagane.isCurrent(run.plan) &&
      run.plan.origin===plan.origin && run.plan.seriesId===plan.seriesId &&
      run.plan.chapterId===plan.chapterId && run.plan.ids.length===plan.ids.length &&
      run.plan.ids.every((id,i)=>id===plan.ids[i]);
  }
  function rebindKaganeRoot(run, plan) {
    if (!sameKaganeChapter(run,plan)) return false;
    const old=run.plan;
    run.observer?.disconnect();run.observer=null;
    if(run.watchRoot && run.sourceLoaded)run.watchRoot.removeEventListener('load',run.sourceLoaded,true);
    run.watchRoot=null;
    run.intersection?.disconnect();run.intersection=null;run.observedSlots.clear();
    plan.kagane=old.kagane;
    plan.sourceDiagnostics=old.sourceDiagnostics;
    run.plan=plan;
    run.recoveryObserver?.disconnect();run.recoveryObserver=null;
    clearTimeout(run.recoveryTimer);run.recoveryTimer=0;
    observe(run);
    TP.scanDiag?.emit('kagane.reader_remounted',{runId:run.id,results:run.results.size});
    TP.log.info('reader root rebound',{runId:run.id,visibility:document.visibilityState,
      stagedResults:run.results.size});
    schedule(run,run.results.keys());
    return true;
  }
  function recoverKaganeRoot(run) {
    run.recoveryTimer=0;
    if (!live(run)) {if(run===current)cancel('reader_navigation',true);return;}
    if (run.plan.root.isConnected) {
      run.recoveryObserver?.disconnect();run.recoveryObserver=null;
      observe(run);schedule(run,run.results.keys());return;
    }
    const plan=classify.detect();
    if (plan) rebindKaganeRoot(run,plan);
  }
  function waitForKaganeRoot(run) {
    if (run.plan.adapter!=='kagane') {cancel('reader_scope_changed',true);return;}
    if (run.recoveryObserver) return;
    TP.log.info('reader root detached',{runId:run.id,visibility:document.visibilityState,
      stagedResults:run.results.size});
    run.observer?.disconnect();run.observer=null;
    if(run.watchRoot && run.sourceLoaded)run.watchRoot.removeEventListener('load',run.sourceLoaded,true);
    run.watchRoot=null;
    run.intersection?.disconnect();run.intersection=null;run.observedSlots.clear();
    clearTimeout(run.retryTimer);run.retryTimer=0;
    const check=()=>{if (!run.recoveryTimer)run.recoveryTimer=setTimeout(()=>recoverKaganeRoot(run),0);};
    run.recoveryObserver=new MutationObserver(check);
    run.recoveryObserver.observe(document.documentElement,{childList:true,subtree:true});
    check();
  }
  // One drain per run, not a new four-worker group for every mutation callback.
  // Busy pages retain a dirty bit so a mount/load during async rendering is not
  // lost. Only logical pages actually touched are queued, never a chapter scan.
  function schedule(run, ids) {
    if (!live(run)) return;
    for (const id of ids) {
      const row = run.results.get(id);
      if (!row) continue;
      if (row.busy) row.dirty = true;
      else run.pending.add(id);
    }
    if (!run.pending.size || run.timer || run.activePlaces >= 4) return;
    run.timer = setTimeout(() => {
      run.timer = 0;
      while (live(run) && run.activePlaces < 4 && run.pending.size) {
        const id = run.pending.values().next().value;
        run.pending.delete(id);
        run.activePlaces++;
        void place(run,id).catch(error => {
          if (live(run)) TP.log.warn('reader placement failed', {pageId:id,error:error.message});
        }).finally(() => {
          run.activePlaces--;
          schedule(run,[]);
        });
      }
    }, 0);
  }
  function touch(run, node, ids, descendants = false) {
    if (!node || node.nodeType !== 1 || classify.own(node)) return;
    if (!node.isConnected) {
      const removed=node.matches?.('img,canvas') ? [node] : descendants ? [...node.querySelectorAll('img,canvas')] : [];
      for (const img of removed) {
        const id=run.targetPages.get(img); if(id) ids.add(id);
        const handler=run.loads.get(img);
        if(handler){img.removeEventListener('load',handler);run.loads.delete(img);}
      }
    }
    const add = el => {
      const slot = el.matches?.(run.plan.selector) ? el : el.closest?.(run.plan.selector);
      if (!slot) return;
      const id = classify.number(slot,run.plan.attr);
      if (!run.plan.slots.has(id)) {
        if (slot.isConnected && slot.matches(run.plan.selector)) cancel('reader_scope_changed',true);
        return;
      }
      if (slot.isConnected) run.plan.slots.set(id,slot);
      ids.add(id);
    };
    if (node.isConnected && !run.plan.root.contains(node)) return;
    add(node);
    if (descendants) for (const el of node.querySelectorAll?.(`${run.plan.selector},img,canvas`) || []) add(el);
  }
  function observe(run) {
    if (run.observer || typeof MutationObserver !== 'function') return;
    run.observer = new MutationObserver(records => {
      if (!live(run)) { if (run === current) cancel('reader_navigation',true); return; }
      if (!run.plan.root.isConnected) { waitForKaganeRoot(run); return; }
      const ids = new Set();
      for (const m of records) {
        if (!run.plan.root.contains(m.target)) continue;
        if (classify.own(m.target)) {
          if (m.type==='childList' && [...m.removedNodes].some(n=>n.nodeType===1 && n.matches?.('.tp-ol-clean-img')))
            touch(run,m.target.closest('.tp-ol-root')?.parentElement,ids);
          continue;
        }
        if (m.type === 'attributes') {
          const record = run.results.get(classify.number(m.target.closest?.(run.plan.selector) || m.target,run.plan.attr));
          if (m.attributeName === 'src' && record?.message?.type === 'REPLACE_IMAGE' &&
              record.element === m.target && record.appliedSource === TP.normUrl(m.target.src)) continue;
          touch(run,m.target,ids);
        } else {
          const nodes = [...m.addedNodes,...m.removedNodes].filter(n => n.nodeType === 1 && !classify.own(n));
          if (!nodes.length) {
            // The publisher can remove our overlay while keeping its IMG. That
            // is not an insertion made by us; recheck only its owning page.
            if ([...m.removedNodes].some(n => n.nodeType === 1 && n.matches?.('.tp-ol-root,.tp-ol-clean-img')))
              touch(run,m.target,ids);
            continue;
          }
          // Never descend into the mutation target (which may be the full reader).
          touch(run,m.target,ids);
          for (const node of nodes) touch(run,node,ids,true);
        }
      }
      for (const id of ids) {
        const record = run.results.get(id);
        if (record?.element && !record.element.isConnected) {
          if (run.plan.adapter!=='kagane')
            TP.overlayMount?.dropHtmlOverlay?.(generation(run,id).targetKey);
          TP.clearImageError?.(record.element);
          record.element = null;
        }
      }
      schedule(run,ids);
    });
    // Source changes can signify a chapter replacement without a URL change.
    // Inspect only the loaded IMG's logical slot, while other pages are still processing.
    run.watchRoot=run.plan.root;
    run.sourceLoaded=event=>{
      const img=event.target;if(!live(run)||!img?.matches?.('img')||classify.own(img))return;
      const slot=img.closest?.(run.plan.selector),id=slot&&classify.number(slot,run.plan.attr);
      if (!run.sources.has(id) || target(run,id)!==img) return;
      const observed=classify.source(slot);
      if (observed && img.complete && img.naturalWidth>=140 && img.naturalHeight>=140 &&
          observed!==run.sources.get(id) && !validates(img,generation(run,id)).ok) {
        TP.scanDiag?.emit('reader.source_changed',{pageId:id,
          expected:TP.scanDiag.describeSource(run.sources.get(id)),
          actual:TP.scanDiag.describeSource(observed)});
        cancel('reader_source_changed',true);
        return;
      }
      // Also handles reused IMG nodes and load completion after a fast remount,
      // even if a removed-node cleanup detached the one-shot load listener.
      schedule(run,[id]);
    };
    run.watchRoot.addEventListener('load',run.sourceLoaded,true);
    // The stable parent catches replacement of the reader root itself.
    run.observer.observe(run.watchRoot,
      {childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset','data-src','data-original','data-lazy-src','width','height',run.plan.attr]});
    if (run.plan.root.parentElement) run.observer.observe(run.plan.root.parentElement,{childList:true});
    if (!run.visibilityChanged) {
      run.visibilityChanged=()=>{
        TP.log.info('reader visibility changed',{runId:run.id,state:document.visibilityState,
          rootConnected:run.plan.root?.isConnected===true,stagedResults:run.results.size});
        if (document.hidden) {clearTimeout(run.retryTimer);run.retryTimer=0;return;}
        run.retryDelay=750;retryPending(run);
        schedule(run,[...run.unresolved].slice(0,8));
      };
      document.addEventListener('visibilitychange',run.visibilityChanged);
    }
    // Keep observing after all current images are placed: later remount is real work.
  }
  async function start(plan, selectedImage = null, mode = '', lang = '') {
    // A new request still gets its own run ID and cancels the old worker batch.
    // Only completed/staged display data is handed to the new Kagane run.
    const previous=current;
    const carry=previous && live(previous) && sameKaganeChapter(previous,plan) &&
      previous.mode===mode && previous.lang===lang && previous.plan.kagane?.lease &&
      previous.sources.size===plan.ids.length
      ? {sources:new Map(previous.sources),kagane:previous.plan.kagane,
        diagnostics:previous.plan.sourceDiagnostics,
        results:[...previous.results].filter(([,row])=>row.message?.type!=='IMAGE_ERROR'),
        bindings:new Map(previous.bindings)} : null;
    cancel('new_run',true,!!carry);
    const run = {id:crypto.randomUUID(),plan,href:location.href,pageInstanceId:TP.pageInstanceId,
      mode,lang,
      sources:new Map(),results:new Map(),bindings:new Map(),loads:new Map(),pending:new Set(),
      targetPages:new WeakMap(),activePlaces:0,unresolved:new Set(),observedSlots:new Map(),
      intersection:null,retryTimer:0,retryDelay:750,
      controller:new AbortController(),cancelled:false,processingComplete:false,observer:null,timer:0,chars:0};
    current = run;
    observe(run);
    if (carry) {
      plan.kagane=carry.kagane;plan.sourceDiagnostics=carry.diagnostics;
      run.sources=carry.sources;
      if (selectedImage) {
        const slot=selectedImage.matches(plan.selector)?selectedImage:selectedImage.closest(plan.selector);
        const id=classify.number(slot,plan.attr);
        if (!run.sources.has(id)) {cancel('reader_selected_source_unavailable');throw Error('READER_SELECTED_SOURCE_UNAVAILABLE');}
        run.ids=[id];
      } else run.ids=plan.ids;
      for (const [id,row] of carry.results) {
        const stamp=generation(run,id);
        run.results.set(id,{...row,message:{...row.message,generation:stamp},
          element:row.element?.isConnected?row.element:null,busy:false,dirty:false,
          attempts:0,carryover:true,waitSignature:''});
        run.chars+=row.size;
        const binding=carry.bindings.get(id);
        if (binding) run.bindings.set(id,{...binding,generation:stamp});
      }
      TP.scanDiag?.emit('kagane.display_carried',{runId:run.id,results:run.results.size});
      TP.overlayMount?.scheduleHtmlOverlayUpdate?.();
      schedule(run,run.results.keys());
      return run;
    }
    const timeout = setTimeout(() => run.controller.abort(), 20000);
    try {
      if (selectedImage && plan.adapter!=='kagane') {
        const slot = selectedImage.matches(plan.selector) ? selectedImage : selectedImage.closest(plan.selector);
        const id = classify.number(slot,plan.attr), src = classify.source(slot);
        if (!id || !src) throw new Error('READER_SELECTED_SOURCE_UNAVAILABLE');
        run.sources.set(id,src); run.ids=[id];
      } else {
        const startedAt=Date.now();
        run.sources = await classify.sources(plan,run.controller.signal); run.ids = plan.ids;
        if(selectedImage){
          const slot=selectedImage.matches(plan.selector)?selectedImage:selectedImage.closest(plan.selector);
          const id=classify.number(slot,plan.attr);
          if(!run.sources.has(id))throw Error('READER_SELECTED_SOURCE_UNAVAILABLE');
          run.ids=[id];
          if(plan.adapter!=='kagane')run.sources=new Map([[id,run.sources.get(id)]]);
        }
        const missing = run.ids.filter(id => !run.sources.has(id));
        const detail={profile:plan.profile,total:run.ids.length,resolved:run.ids.filter(id=>run.sources.has(id)).length,
          missingPages:missing.slice(0,40),elapsedMs:Date.now()-startedAt,...plan.sourceDiagnostics};
        try { if (TP.scanDiag?.active()) TP.scanDiag.emit('reader.source_barrier', {
          profile:plan.profile,total:run.ids.length,resolved:run.ids.filter(id=>run.sources.has(id)).length,
          missingCount:missing.length,missingPages:missing,
          inline:plan.sourceDiagnostics?.inline || 'not_checked',
          bridge:plan.sourceDiagnostics?.bridge || 'not_checked',
          propsFound:plan.sourceDiagnostics?.propsFound || 0,
          propsResolved:plan.sourceDiagnostics?.propsResolved || 0,
          elapsedMs:detail.elapsedMs,
          pages:run.ids.slice(0,250).map(id=>({pageId:id,
            source:TP.scanDiag.describeSource(run.sources.get(id)),
            target:classify.surface(plan.slots.get(id))?.tagName || 'NONE'})),
        }); } catch {} // Observability cannot turn discovery into an error.
        TP.traceNote?.('content/reader/runtime.js','readerSources_'+plan.profile,
          {schema:'tp.audit/1',event:'route_capability',reason:missing.length?'source_unavailable':'prepared',
            scope:{runId:run.id},counts:{total:run.ids.length,accepted:run.ids.filter(id=>run.sources.has(id)).length,missingCount:missing.length},
            timing:{readMs:detail.elapsedMs}});
        if (missing.length) {
          TP.log.warn('reader sources incomplete',detail);
          const why=plan.sourceDiagnostics;
          throw Object.assign(new Error(`READER_SOURCE_UNAVAILABLE: ${missing.length}/${run.ids.length} logical pages have no source; profile=${plan.profile}`+
            (why ? `; inline=${why.inline}; bridge=${why.bridge}` : '')),
            {code:'READER_SOURCE_UNAVAILABLE',missing});
        }
        TP.log.info('reader sources ready',detail);
      }
      if (run.plan!==plan && plan.kagane) {
        run.plan.kagane=plan.kagane;
        run.plan.sourceDiagnostics=plan.sourceDiagnostics;
      }
      if (!live(run)) throw new DOMException('Reader navigation','AbortError');
      TP.traceNote?.('content/reader/runtime.js','readerClassified_DYNAMIC',{schema:'tp.audit/1',event:'route_capability',reason:'prepared',scope:{runId:run.id},counts:{total:run.ids.length}});
      TP.log.info('reader classified', {type:'DYNAMIC',profile:plan.profile,total:run.ids.length,barrier:false,placement:'ready_first'});
      return run;
    } catch (error) { if (current === run) cancel(error.message); throw error; }
    finally { clearTimeout(timeout); }
  }
  function payload(run, id, mode, lang, menu) {
    const img = target(run,id);
    const p = TP.buildPayload({original_image_url:run.sources.get(id),generation:generation(run,id),
      position:img ? TP.buildPositionFromElement(img) : null,
      naturalSize:{width:img?.naturalWidth || (img?.matches('canvas') ? img.width : 0) || run.plan.kagane?.rows.get(id)?.width || 0,height:img?.naturalHeight || (img?.matches('canvas') ? img.height : 0) || run.plan.kagane?.rows.get(id)?.height || 0},
      background:mode === 'lens_text' && TP.clientBackgroundEnabled ? 'boxes' : 'image'},mode,lang,menu,'logical_reader');
    p.context.page_index = run.plan.ids.indexOf(id);
    p.reader = {runId:run.id,pageId:id,profile:run.plan.profile,barrier:false,
      compositionHint:/^(?:www\.)?comix\.to$/i.test(location.hostname) ?
        (/[?&]v3(?:[=&]|$)/i.test(String(run.sources.get(id) || '')) ? 'scrambled' :
          run.plan.compositionHints?.get(id) || (img?.matches?.('canvas') ? 'scrambled' : 'unknown')) : 'unknown',
      ...(run.plan.adapter ? {adapter:run.plan.adapter} : {}),
      total:run.ids.length,acquisition:run.plan.adapter==='kagane'?['KAGANE_PAGE']:['DEFAULT','REFERER','DOM']};
    return p;
  }
  TP.collectReaderImages = async (mode,lang) => {
    const plan = classify.detect(); if (!plan) return null;
    TP.scanDiag?.emit('route.selected', {route:'DYNAMIC',profile:plan.profile,
      selector:plan.selector,attr:plan.attr,logicalPages:plan.ids.length});
    TP.scanDiag?.snapshot('before_source_discovery');
    const run = await start(plan,null,mode,lang);
    return {items:run.ids.map(id => payload(run,id,mode,lang,'page_scan')),
      stats:{candidates:run.ids.length,accepted:run.ids.length,skipped:0,duplicates:0,reasons:{}}};
  };
  TP.buildReaderImagePayload = async (img,mode,lang) => {
    const plan = classify.detect(); if (!plan || !img.closest?.(plan.selector)) return null;
    const run = await start(plan,img,mode,lang);
    return payload(run,run.ids[0],mode,lang,'img_one');
  };
  TP.findReaderTarget = stamp => live(current) && stamp?.readerRunId === current?.id ? target(current,stamp.readerPageId) : null;
  TP.readerCurrent = validates;
  TP.noteReaderAppliedSource = (img,src) => {
    const run=current;if(!run)return;
    const slot=img.closest?.(run.plan.selector), id=slot && classify.number(slot,run.plan.attr), rec=run.results.get(id);
    if(rec) rec.appliedSource=TP.normUrl(src);
  };
  TP.readerOriginalFor = key => {
    const run=current;if(!run)return '';
    return run.sources.get(keyPage(run,key)) || '';
  };
  TP.readerImageForKey = key => {
    const run=current;if(!run || !live(run))return null;
    const id=keyPage(run,key);
    if (!run.sources.has(id)) return null;
    const img=target(run,id);
    return validates(img,generation(run,id)).ok ? img : null;
  };
  TP.cancelReaderRun = cancel;
  TP.readerOwnsRun = id => current?.id === id && live(current);

  function placedReceipt(run,id,row,receipt,remount) {
    TP.scanDiag?.emit('reader.placed',{pageId:id,kind:row.message.type,
      drawn:row.message.type !== 'IMAGE_ERROR' && receipt?.drawn!==false,
      remount});
    notify('TP_READER_PLACED',{readerRunId:run.id,pageId:id,pageInstanceId:run.pageInstanceId,
      translationRun:row.message.translationRun || null,
      provisional:row.message.result?.meta?.provisional === true,
      drawn:row.message.type !== 'IMAGE_ERROR' && receipt?.drawn!==false,kind:row.message.type});
  }
  function placementFailed(run,id,row,error,version) {
    if (!live(run) || run.results.get(id)!==row || row.version!==version) return stale('reader result superseded');
    const anchor=errorTarget(run,id);
    const text=error?.message || String(error || 'Reader placement rejected');
    const first=row.failureVersion!==version || row.failureTarget!==row.attemptTarget;
    if(first) {
      row.failureVersion=version;row.failureTarget=row.attemptTarget;
      TP.log.warn('reader placement failed',{runId:run.id,pageId:id,error});
      diagnostic(run,row,'failed',{},'placement_failed');
      notify('TP_READER_PLACEMENT_FAILED',{readerRunId:run.id,pageId:id,pageInstanceId:run.pageInstanceId,
        translationRun:row.message.translationRun || null,error:text});
    }
    // Do not run the renderer again to display its own failure. The original
    // result stays stored, so a new target/result may recover without OCR/AI.
    if(anchor && errorCurrent(anchor,row.message.generation).ok && (first || !TP.hasImageError?.(anchor))) {
      TP.markImageError?.(row.message.original,{schema:'tp.error/1',code:'INSERT_FAILED',
        userMessage:'ไม่สามารถแทรกผลแปลบนภาพได้'},row.message.generation);
    }
    row.lastPlacementError=error;resolved(run,id,row);
    return {ok:false,applied:false,error:text};
  }
  async function place(run,id) {
    if (!live(run)) return null;
    const row = run.results.get(id);
    if (!row || row.busy) return null;
    const isError=row.message.type==='IMAGE_ERROR';
    const img=isError ? errorTarget(run,id) : target(run,id);
    if (!img) return waiting(run,id,row,'waiting_target');
    const canvas=img.matches('canvas');
    if (!isError && !canvas && (!img.complete || !img.naturalWidth || !img.naturalHeight)) {
      if (!run.loads.has(img)) {
        const loaded=()=>{run.loads.delete(img);schedule(run,[id]);};
        run.loads.set(img,loaded);img.addEventListener('load',loaded,{once:true});
      }
      return waiting(run,id,row,'waiting_load');
    }
    const stamp = row.message.generation;
    const currentTarget=()=>isError ? errorTarget(run,id) : target(run,id);
    const stillCurrent=()=>isError ? errorCurrent(img,stamp) : validates(img,stamp);
    if (!stillCurrent().ok) {
      TP.overlayMount?.dropHtmlOverlay?.(stamp.targetKey);row.element=null;
      return waiting(run,id,row,'source_mismatch');
    }
    const rect=img.getBoundingClientRect();
    if (rect.width<2 || rect.height<2) return waiting(run,id,row,'waiting_size');
    const intact = row.message.type === 'REPLACE_IMAGE'
      ? TP.overlayMount?.hasRasterOverlay?.(stamp.targetKey,img) === true
      : row.message.type === 'OVERLAY_HTML'
        ? TP.overlayMount?.hasHtmlOverlay?.(stamp.targetKey,img) === true
        : isError ? TP.hasImageError?.(img) === true : true;
    if (row.element === img && row.appliedVersion === row.version && (intact || (!isError && row.receipt?.drawn===false))) {
      resolved(run,id,row);return row.receipt;
    }
    const attemptKey=`${row.version}:${canvas ? img.width+':'+img.height : img.currentSrc || img.src}:${rect.width}:${rect.height}`;
    if(row.attemptTarget!==img || row.attemptKey!==attemptKey) {
      row.attemptTarget=img;row.attemptKey=attemptKey;row.attempts=0;
    }
    // Failed local rendering is retried at most three times for the same target
    // and result. Real remount/source/size/result changes allow a fresh attempt.
    if(row.attempts>=3) return placementFailed(run,id,row,row.lastPlacementError,row.version);
    row.busy=true; row.dirty=false;row.attempts++;
    if(row.waitSignature) diagnostic(run,row,'dispatch',{},`replay_scheduled_${canvas?'canvas':'img'}`);
    const version=row.version, startedAt=Date.now();
    try {
      const binding=run.bindings.get(id);
      if(binding && !isError) await TP.applyInsertMessage({...binding,readerReplay:true,readerReplayTarget:img});
      const receipt=await TP.applyInsertMessage({...row.message,readerReplay:true,readerReplayTarget:img});
      if(!live(run) || run.results.get(id)!==row || version!==row.version) return stale('reader result superseded');
      if (!img.isConnected || currentTarget()!==img) {
        if (run.plan.adapter!=='kagane') TP.overlayMount?.dropHtmlOverlay?.(stamp.targetKey);
        return waiting(run,id,row,'waiting_target');
      }
      if (!stillCurrent().ok) {
        TP.overlayMount?.dropHtmlOverlay?.(stamp.targetKey);row.element=null;
        return waiting(run,id,row,'source_mismatch');
      }
      if (receipt?.ok && receipt.applied === true && !receipt.stale) {
        if(row.element && row.element!==img) TP.clearImageError?.(row.element);
        if(!isError && row.failureVersion) TP.clearImageError?.(errorTarget(run,id));
        row.failureVersion=0;row.lastPlacementError=null;
        row.element=img; row.appliedVersion=version;row.receipt=receipt;
        row.appliedSource=canvas ? run.sources.get(id) : TP.normUrl(row.message.type === "REPLACE_IMAGE" ? img.src : (img.currentSrc || img.src));
        row.attempts=0;resolved(run,id,row);
        TP.log.info('reader result placed',{pageId:id,runId:run.id,remount:row.everPlaced===true});
        const remount=row.everPlaced===true;
        row.everPlaced=true;
        diagnostic(run,row,'acknowledged',{elapsedMs:Date.now()-startedAt},`replay_applied_${canvas?'canvas':'img'}`);
        if (!row.carryover) placedReceipt(run,id,row,receipt,remount);
      } else {
        row.lastPlacementError=receipt?.error || 'Reader placement rejected';
        if (row.attempts>=3 && !receipt?.stale) return placementFailed(run,id,row,row.lastPlacementError,version);
        if(receipt?.stale) row.attempts=0;
        return waiting(run,id,row,receipt?.stale?'replay_skipped_stale':'waiting_apply');
      }
      return receipt;
    } catch(error) {
      if(!live(run) || run.results.get(id)!==row || row.version!==version) return stale('reader result superseded');
      if(currentTarget()!==img || !stillCurrent().ok) {
        row.attempts=0;return waiting(run,id,row,'waiting_target');
      }
      row.lastPlacementError=error;
      if(row.attempts>=3) return placementFailed(run,id,row,error,version);
      return waiting(run,id,row,'waiting_apply');
    } finally {
      row.busy=false;
      if(row.dirty || row.version!==version || currentTarget()!==img)schedule(run,[id]);
    }
  }
  TP.stageReaderInsert = async msg => {
    const run=current, stamp=msg?.generation, id=String(stamp?.readerPageId || '');
    if (!run || !live(run) || stamp.readerRunId!==run.id || stamp.pageInstanceId!==run.pageInstanceId || !run.sources.has(id))
      return stale('reader run no longer owns this result');
    const prior=run.bindings.get(id), binding=msg.translationRun;
    if(msg.type === 'TP_TRANSLATION_BIND') {
      run.bindings.set(id,msg);return {ok:true,stored:true,applied:false};
    }
    if(binding && prior?.translationRun && (binding.runId!==prior.translationRun.runId || binding.generationId!==prior.translationRun.generationId))
      return stale('reader translation binding changed');
    const row=run.results.get(id), before=row?.message?.translationRun;
    if(before?.phase==='repair' && binding?.phase==='initial' &&
        before.runId===binding.runId && before.generationId===binding.generationId)
      return stale('initial result after repair');
    // A replay of the same final revision is placement-only, never processing.
    if(row && binding?.phase==='repair' && before?.revision===binding.revision && before?.runId===binding.runId)
      return (await place(run,id)) || {ok:true,stored:true,pending:true,applied:false};
    const size=JSON.stringify(msg).length;
    if(run.chars - (row?.size || 0) + size > MAX_STAGED_CHARS)
      return {ok:false,applied:false,error:'READER_RESULT_MEMORY_LIMIT'};
    run.chars += size - (row?.size || 0);
    const next=row || {element:null,appliedVersion:0,version:0,busy:false,dirty:false,everPlaced:false};
    Object.assign(next,{message:msg,size,version:next.version+1,carryover:false});run.results.set(id,next);
    // A ready page is independent of the chapter's processing/repair boundary.
    // Absent surfaces remain staged for the same existing remount queue.
    const receipt=await place(run,id);
    if(receipt?.applied || receipt?.stale || receipt?.ok===false)return receipt;
    diagnostic(run,next,'prepared');
    return {ok:true,stored:true,pending:true,applied:false,readerStaged:true};
  };
  TP.releaseReaderPlacement = async id => {
    const run=current;if(!run || !live(run) || run.id!==id)return stale('reader release cancelled');
    if(!run.processingComplete)TP.log.info('reader processing complete',{runId:id,results:run.results.size,total:run.ids.length});
    // This message closes processing, not permission to show a ready image.
    // Keep the protocol ACK for worker restart/repair receipt recovery.
    run.processingComplete=true;
    TP.traceNote?.('content/reader/runtime.js','readerProcessingComplete',{
      schema:'tp.audit/1',event:'barrier_recovery',reason:'finished',
      scope:{runId:run.id},counts:{total:run.ids.length,accepted:run.results.size},
    });
    for(const [page,row] of run.results) {
      const isError=row.message.type==='IMAGE_ERROR';
      const anchor=isError ? errorTarget(run,page) : target(run,page);
      if(!row.carryover && row.element===anchor && row.appliedVersion===row.version && row.receipt &&
          (isError ? errorCurrent(anchor,row.message.generation) : validates(anchor,row.message.generation)).ok)
        placedReceipt(run,page,row,row.receipt);
    }
    schedule(run,[...run.results.keys()]);
    return {ok:true,released:true,processingComplete:true};
  };
  TP.readReaderDomImage = async msg => {
    const run=current;if(!run || !live(run) || msg.readerRunId!==run.id || run.sources.get(String(msg.pageId))!==msg.url)
      return {ok:false,error:'READER_SOURCE_STALE'};
    try {
      if(run.plan.adapter==='kagane'){
        const result=await TP.kagane.read(run.plan,String(msg.pageId),run.controller.signal);
        return live(run)?result:{ok:false,error:'READER_SOURCE_STALE'};
      }
      const slot=owner(run,String(msg.pageId));
      const surface=classify.surface(slot);
      const canvases=msg.compositionHint==='scrambled' && /^(?:www\.)?comix\.to$/i.test(location.hostname)
        ? [...(slot?.matches?.('canvas') ? [slot] : slot?.querySelectorAll?.('canvas') || [])]
          .filter(el=>!classify.own(el) && el.width>=140 && el.height>=140) : [];
      const painted=surface?.matches?.('canvas') ? surface : canvases.length===1 ? canvases[0] : null;
      if(painted?.width>=140 && painted.height>=140){
        // The site already assembled this page. Read its own displayed canvas
        // in the isolated content world instead of fetching scrambled bytes.
        try {
          const dataUri=painted.toDataURL('image/png');
          const prefix='data:image/png;base64,';
          if(!dataUri.startsWith(prefix)||dataUri.length<256)throw Error('DOM_COMPOSITE_EMPTY');
          const png=atob(dataUri.slice(prefix.length,prefix.length+36));
          const size=(offset)=>((png.charCodeAt(offset)<<24)|(png.charCodeAt(offset+1)<<16)|
            (png.charCodeAt(offset+2)<<8)|png.charCodeAt(offset+3))>>>0;
          if(size(16)!==painted.width||size(20)!==painted.height)throw Error('DOM_COMPOSITE_SIZE_MISMATCH');
          if(dataUri.length>36*1024*1024)throw Error('DOM_IMAGE_TOO_LARGE');
          if(!live(run))throw new DOMException('Reader cancelled','AbortError');
          return {ok:true,dataUri,composition:'rendered_canvas'};
        }catch(error){
          if(msg.compositionHint==='scrambled')throw error;
        }
      }
      if(msg.compositionHint==='scrambled' ||
          (/^(?:www\.)?comix\.to$/i.test(location.hostname) && !surface?.matches?.('img')))
        throw Error('DOM_COMPOSITE_NOT_MOUNTED');
      // Do not read the displayed cross-origin IMG: it may taint a canvas.
      const fresh=new Image();fresh.crossOrigin='anonymous';fresh.decoding='async';
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish(new Error('DOM_CORS_TIMEOUT')),12000);
        const aborted=()=>finish(new DOMException('Reader cancelled','AbortError'));
        const finish=error=>{clearTimeout(timer);run.controller.signal.removeEventListener('abort',aborted);
          fresh.onload=fresh.onerror=null;if(error){fresh.src='';reject(error);}else resolve();};
        fresh.onload=()=>finish();fresh.onerror=()=>finish(new Error('DOM_CORS_UNAVAILABLE'));
        run.controller.signal.addEventListener('abort',aborted,{once:true});fresh.src=msg.url;
        if(run.controller.signal.aborted)aborted();
      });
      if(!live(run))throw new DOMException('Reader cancelled','AbortError');
      if(!fresh.naturalWidth || fresh.naturalWidth*fresh.naturalHeight>80_000_000)throw new Error('DOM_IMAGE_TOO_LARGE');
      const canvas=document.createElement('canvas');canvas.width=fresh.naturalWidth;canvas.height=fresh.naturalHeight;
      const ctx=canvas.getContext('2d');if(!ctx)throw new Error('DOM_CANVAS_UNAVAILABLE');ctx.drawImage(fresh,0,0);
      const dataUri=canvas.toDataURL('image/png');canvas.width=canvas.height=0;
      if(dataUri.length>36*1024*1024)throw new Error('DOM_IMAGE_TOO_LARGE');
      return {ok:true,dataUri};
    } catch(error) {return {ok:false,error:error.message};}
  };
  window.addEventListener('pagehide',(event)=>{
    if (current) TP.log.info('reader pagehide',{runId:current.id,
      persisted:event.persisted===true,visibility:document.visibilityState});
    cancel('pagehide',true);
  });
})();
