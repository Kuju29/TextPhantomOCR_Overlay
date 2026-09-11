// Shared, pure wire schema for background modules and classic content scripts.
// Only system-defined enums, generated IDs and finite numbers survive this path.
(function (root) {
  const events = new Set(['workload_observed','workload_profile','workload_persisted','capacity_changed','capacity_selected','route_capability','barrier_recovery',
    'unknown','request_timing','settings_effective','image_status','geometry_snapshot','group_membership','geometry_overlap','ruby_filter','orientation_fallback']);
  const reasons = new Set(['unchanged','changed','initial','success','failed','cancelled','unknown','not_applicable','deadline',
    'sync_supported','legacy_supported','capability_unavailable','loaded','cold_start','version_mismatch','invalid_profile','expired_profile','storage_unavailable','snapshot_written',
    'profile_matches_execution','unconfirmed_contract_cold_start','execution_identity_reset_before_dispatch',
    'unplanned_execution_observation_ignored','unconfirmed_execution_observation_ignored',
    'grow_output_after_valid_near_full_batches','grow_records_after_valid_full_batches','shrink_after_output_length',
    'shrink_records_after_structural_failure','resolved_provider_model_or_contract_changed','stale_observation_no_resize',
    'user_policy','runtime_capacity_hint','provider_backpressure','provider_success','restored_batch','rate_gate_defer','server_admission_defer','stored_capacity','main_columns','overlap_detected',
    'request_ready','usage_pending','http_started','http_headers','response_complete','http_failed','persistence_failed',
    'complete_at_limit_no_reduction','grow_output_after_valid_near_full_batches','grow_records_after_valid_full_batches','language_failure_observed_no_budget_claim','reduce_next_workload_after_truncation','reduce_records_after_incomplete_structure','stale_target_observation_no_reduction','source_geometry','clean_geometry','group_geometry','render_geometry','detected_ruby','ambiguous_kept','standalone_bounds',
    'acknowledged','unconfirmed_ack','source_unavailable','wrong_language','malformed','no_text','no_translatable_text']);
  const states = new Set(['planned','applied','rejected','unchanged','pending','persisted','memory_only','failed','unknown','not_applicable']);
  const phases = new Set(['waiting','scanning','downloading','lens','grouping','ai_queued','ai_generating','server_processing',
    'usage_pending','http_wait','validating','validated','rendering','repair_wait','repairing','repair_applying','apply_pending','apply_failed','done','partial','error','cancelled']);
  const contracts = new Set(['json_schema_object_v1','compact_markers_v1','plain_records_v1','native_json_schema','compact_markers','unconfirmed','unknown']);
  const numeric = new Set(['outputTarget','recordTarget','revision','epoch','samples','count','eligibleSamples','window','ceiling','running','queued',
    'unitCount','batchIndex','total','accepted','applied','failed','pending','fallbackCount','wrongLanguageCount','structuralCount','removedCount','retainedCount','totalRows','chunk','chunks','capturedRows',
    'pauseMs','parentIndex','itemIndex','spanIndex','rawIndex','queueMs','lockMs','readMs','computeMs','writeMs','persistMs','httpMs','headersMs','bodyMs','elapsedMs','status','httpAttempts','batchSize','sequence',
    'fontScale','temperature','maxOutput','glossaryItems','characterItems','previousItems','x','y','w','h','rotation']);
  const ids = new Set(['batchId','runId','imageId','jobId','requestId','operationId','profileId','traceId','parentId','id','ref']);
  const idPattern = /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|t[a-z0-9]{8,40}|(?:p|g|P|R|c|i)\d+(?:[-:]\w{1,12})?|tr:\d+|(?:ai|repair):[a-f0-9-]{16,64}(?::[a-zA-Z0-9-]{1,64}){0,5})$/;
  function pickId(v){ return typeof v==='string' && v.length<=240 && idPattern.test(v) ? v : null; }
  function metric(v) {return typeof v==='number' && Number.isFinite(v) ? Math.round(v*1000)/1000 : null;}
  function part(v,depth=0){
    if(!v || typeof v!=='object' || Array.isArray(v) || depth>3)return {};
    const out={};
    for(const [k,x] of Object.entries(v).slice(0,40)){
      if(numeric.has(k))out[k]=metric(x);
      else if(ids.has(k))out[k]=pickId(x);
      else if(k==='ids' && Array.isArray(x))out[k]=x.slice(0,12).map(pickId);
      else if(['before','after','timing','counts','planned','effective','observed','scope','evidence'].includes(k))out[k]=part(x,depth+1);
      else if(k==='rows' && Array.isArray(x))out[k]=x.slice(0,12).map(row=>part(row,depth+1));
      else if(k==='reason')out[k]=reasons.has(x)?x:'unknown';
      else if(k==='phase')out[k]=phases.has(x)?x:'waiting';
      else if(k==='contract')out[k]=contracts.has(x)?x:'unknown';
      else if(['persistence','decisionStatus'].includes(k))out[k]=states.has(x)?x:'unknown';
      else if(k==='sourceKind')out[k]=['original','translated','ai'].includes(x)?x:'unknown';
      else if(k==='engine')out[k]=['extension','api'].includes(x)?x:'unknown';
      else if(k==='route')out[k]=['direct-local','server','api','extension'].includes(x)?x:'unknown';
      else if(k==='thinking')out[k]=['on','off','auto','default','unknown'].includes(x)?x:'unknown';
      else if(k==='direction')out[k]=['h','v','tilted','unknown'].includes(x)?x:'unknown';
      else if(k==='effectiveFrom')out[k]=['next_request','current_request','current_image','next_job','unknown'].includes(x)?x:'unknown';
      else if(['changed','complete','pageImage','memoryEnabled','traceEnabled','rotated','eraseEnabled','unlimited'].includes(k))out[k]=typeof x==='boolean'?x:null;
    }
    return out;
  }
  function sanitize(v){
    if(!v || v.schema!=='tp.audit/1')return null;
    return {schema:'tp.audit/1',event:events.has(v.event)?v.event:'unknown',...part(v)};
  }
  root.TPAuditSchema=Object.freeze({sanitize,events:Object.freeze([...events]),reasons:Object.freeze([...reasons])});
})(globalThis);
