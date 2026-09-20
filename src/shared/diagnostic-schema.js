// Shared, pure wire schema for background modules and classic content scripts.
// Only system-defined enums, generated IDs and finite numbers survive this path.
(function (root) {
  const events = new Set(['render_timing','page_visibility','stream_timing','page_stream_timing','usage_ledger','local_context','local_discovery','workload_observed','workload_profile','workload_persisted','capacity_changed','capacity_selected','route_capability','barrier_recovery',
    'unknown','translation_budget','translation_result','pre_provider_timing','checkpoint_timing','usage_commit_timing','request_timing','settings_effective','image_status','geometry_snapshot','group_membership','geometry_overlap','ruby_filter','orientation_fallback']);
  const reasons = new Set(['stream_observed','records_complete','dom_enqueued','dom_acknowledged','page_validated','translation_success','provider_charged_failure','repair','discovery_joined','models_loaded','verification_started','verification_reused','metadata_check_started','ui_applied','stale_discard','whole_page_fits','remaining_page_fits','per_request_input_limit','per_request_context_window','per_request_output_budget','learned_record_target','learned_output_target','end_of_page','oversize_single_unit','storage_write_unconfirmed','storage_retry_scheduled','storage_recovered','repair_structure_no_capacity_claim','isolated_short_incomplete_no_capacity_claim','structure_observed_no_capacity_claim','reduce_records_after_repeated_structure_failures','unchanged','changed','initial','success','failed','cancelled','unknown','not_applicable','deadline',
    'sync_supported','legacy_supported','capability_unavailable','loaded','cold_start','version_mismatch','invalid_profile','expired_profile','storage_unavailable','snapshot_written',
    'profile_matches_execution','unconfirmed_contract_cold_start','execution_identity_reset_before_dispatch',
    'unplanned_execution_observation_ignored','unconfirmed_execution_observation_ignored',
    'grow_output_after_valid_near_full_batches','grow_records_after_valid_full_batches','shrink_after_output_length',
    'shrink_records_after_structural_failure','resolved_provider_model_or_contract_changed','stale_observation_no_resize',
    'user_policy','runtime_capacity_hint','provider_backpressure','provider_success','restored_batch','rate_gate_defer','server_admission_defer','stored_capacity','main_columns','overlap_detected',
    'prepared','dispatch','progress','finished','request_ready','usage_pending','http_started','http_headers','response_complete','http_failed','persistence_failed','body_failed',
    'complete_at_limit_no_reduction','grow_output_after_valid_near_full_batches','grow_records_after_valid_full_batches','language_failure_observed_no_budget_claim','reduce_next_workload_after_truncation','reduce_records_after_incomplete_structure','stale_target_observation_no_reduction','source_geometry','clean_geometry','group_geometry','render_geometry','detected_ruby','ambiguous_kept','standalone_bounds',
    'acknowledged','unconfirmed_ack','source_unavailable','wrong_language','malformed','no_text','no_translatable_text']);
  const states = new Set(['planned','applied','rejected','unchanged','pending','persisted','memory_only','failed','unknown','not_applicable']);
  const phases = new Set(['waiting','scanning','downloading','lens','grouping','ai_queued','ai_generating','server_processing',
    'usage_pending','http_wait','validating','validated','rendering','repair_wait','repairing','repair_applying','apply_pending','apply_failed','done','partial','error','cancelled']);
  const contracts = new Set(['json_schema_object_v1','compact_markers_v1','plain_records_v1','native_json_schema','compact_markers','unconfirmed','unknown']);
  const numeric = new Set(['observedAt','readableSourceMs','canvasReadMs','erasePaintMs','encodeMs','backgroundMs','layoutMs','domApplyMs','renderMs','visibilityChanges','framesObserved','contentChunks','firstContentMs','lastContentMs','lastFrameMs','protocolTerminalMs','streamEndedMs','maxInterFrameGapMs','maxInterContentGapMs','maxReadWaitMs','tailAfterContentMs','frameProcessingMs','maxFrameProcessingMs','deltaCallbackMs','maxDeltaCallbackMs','wireWriteMs','maxWireWriteMs','recordsCompleteAt','validatedAt','validationMs','domEnqueuedAt','domAckAt','completeToAckMs','contentReceivedAt','renderStartedAt','renderFinishedAt','contentToAckMs','domQueueMs','streamRevision','pageOrder','probeMs','metadataMs','evidenceAgeMs','requests','inputTokens','outputTokens','totalTokens','generationAttempts','beforeRequests','afterRequests','beforeTotalTokens','afterTotalTokens','runtimeContext','modelContext','requestedContext','contextCeiling','contextRequired','estimatedInput','estimatedOutput','reasoningReserve','completionAvailable','contextLimit','outputLimit','inputLimit','actualInput','actualOutput','actualReasoning','cachedInput','missingCount','pageUnits','requestUnits','pageEstimatedInput','pageEstimatedOutput','pageReasoningReserve','pageCompletionAvailable','outputTarget','recordTarget','revision','epoch','samples','count','eligibleSamples','window','ceiling','running','queued',
    'unitCount','batchIndex','total','accepted','applied','failed','pending','fallbackCount','wrongLanguageCount','structuralCount','removedCount','retainedCount','totalRows','chunk','chunks','capturedRows',
    'pauseMs','parentIndex','itemIndex','spanIndex','rawIndex','queueMs','lockMs','readMs','computeMs','writeMs','persistMs','httpMs','headersMs','bodyMs','elapsedMs','status','httpAttempts','batchSize','sequence',
    'callbackMs','usageCallbackMs','requestSetupMs','headersToFirstByteMs','headersToFirstContentMs','contentToTerminalMs','fingerprintMs','workloadOpenMs','checkpointPreparedMs','checkpointDispatchMs','checkpointMs','pageTranslationToTransportHandoffMs',
    'fontScale','temperature','maxOutput','glossaryItems','characterItems','previousItems','x','y','w','h','rotation']);
  const ids = new Set(['receiptId','generationId','pageId','sessionId','batchId','runId','imageId','jobId','requestId','operationId','profileId','traceId','parentId','id','ref']);
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
      else if(k==='boundary')out[k]=['transport_reader','decoded_transport_reader'].includes(x)?x:'unknown';
      else if(k==='terminalKind')out[k]=['none','protocol_done','provider_done','provider_terminal','finish_reason'].includes(x)?x:'none';
      else if(k==='reason')out[k]=reasons.has(x)?x:'unknown';
      else if(k==='connectionStage')out[k]=['list_models','verify_model','model_metadata','save_snapshot','result','ui_apply'].includes(x)?x:'unknown';
      else if(k==='verificationStatus')out[k]=['passed','timeout','rejected','invalid_output','unreachable','thinking_required','not_tested','model_unavailable','unsupported_model','not_selected'].includes(x)?x:'unknown';
      else if(k==='errorCode')out[k]=['local_ai_unreachable','local_ai_timeout','local_ai_discovery_failed','local_ai_invalid_response','local_ai_http_error','local_ai_invalid_adapter','local_ai_empty_models','local_models_empty','local_models_http_error','invalid_local_endpoint','local_provider_response_contract','ai_endpoint_missing','cancelled'].includes(x)?x:'unknown';
      else if(k==='constraintScope')out[k]=['per_request','reliability','account_window','runtime_concurrency','unknown'].includes(x)?x:'unknown';
      else if(k==='instructionLocale')out[k]=['th','en','ja'].includes(x)?x:'en';
      else if(k==='memoryMode')out[k]=['off','terms','full','legacy_filtered'].includes(x)?x:'unknown';
      else if(k==='estimateKind')out[k]=['script_weight_calibrated_from_valid_provider_usage','script_weight_with_output_calibration'].includes(x)?x:'unknown';
      else if(k==='contextPolicy')out[k]=x==='ollama-request-context-v1'?x:'unknown';
      else if(k==='contextReason')out[k]=['bounded_growth','bounded_limit','model_limit_unknown','current_window'].includes(x)?x:'unknown';
      else if(k==='cacheStatus')out[k]=['not_reported','reported_hit','reported_zero'].includes(x)?x:'not_reported';
      else if(k==='resultStatus')out[k]=['complete_at_contract_boundary','incomplete_ids','wrong_language','output_truncated','cancelled','transport_failure','protocol_failure','rate_limited','input_budget_rejected','unverified'].includes(x)?x:'unverified';
      else if(k==='attemptKind')out[k]=['initial','repair'].includes(x)?x:'initial';
      else if(k==='phase')out[k]=phases.has(x)?x:'waiting';
      else if(k==='contract')out[k]=contracts.has(x)?x:'unknown';
      else if(['persistence','decisionStatus'].includes(k))out[k]=states.has(x)?x:'unknown';
      else if(k==='sourceKind')out[k]=['original','translated','ai'].includes(x)?x:'unknown';
      else if(k==='engine')out[k]=['extension','api'].includes(x)?x:'unknown';
      else if(k==='route')out[k]=['direct-local','server','api','extension'].includes(x)?x:'unknown';
      else if(k==='thinking')out[k]=['on','off','auto','default','minimum','minimal','low','medium','high','xhigh','max','ultra','unknown'].includes(x)?x:'unknown';
      else if(k==='direction')out[k]=['h','v','tilted','unknown'].includes(x)?x:'unknown';
      else if(k==='effectiveFrom')out[k]=['next_request','current_request','current_image','next_job','unknown'].includes(x)?x:'unknown';
      else if(['hidden','hiddenAtStart','hiddenAtFinish','replayed','deduplicated','idempotent','contextVerified','requestDispatched','ready','reused','retryable','metadataOnly','wholePage','hardFits','reliabilityFits','cacheReported','examplesEnabled','changed','complete','pageImage','memoryEnabled','traceEnabled','rotated','eraseEnabled','unlimited'].includes(k))out[k]=typeof x==='boolean'?x:null;
    }
    return out;
  }
  function sanitize(v){
    if(!v || v.schema!=='tp.audit/1')return null;
    return {schema:'tp.audit/1',event:events.has(v.event)?v.event:'unknown',...part(v)};
  }
  // A fixed, bounded layout record bypasses generic 12-key shortening, not privacy.
  function sanitizePromptLayout(v) {
    if (!v || v.schema !== 'tp.prompt_layout/1') return null;
    const out = {schema:'tp.prompt_layout/1'};
    const counts = ['systemStyleCopies','userStyleCopies','styleChars','systemChars','userStaticChars','userPersistentStaticChars','bootstrapExamplesChars','dynamicChars'];
    const hashes = ['styleSha256','systemSha256','userStaticSha256','userPersistentStaticSha256','staticPrefixSha256'];
    const enums = {styleRole:['user','system','both','absent','unknown'], instructionLocale:['th','en','ja'],
      memoryMode:['off','terms','full','legacy_filtered'], countUnit:['unicode_characters'],
      styleCountScope:['instruction_blocks'], cacheSupport:['unknown']};
    for (const k of counts) if (k in v) out[k]=Number.isSafeInteger(v[k])&&v[k]>=0?v[k]:null;
    for (const k of hashes) if (k in v) out[k]=typeof v[k]==='string'&&/^[a-f0-9]{64}$/.test(v[k])?v[k]:null;
    for (const [k, allowed] of Object.entries(enums)) if (k in v) out[k]=allowed.includes(v[k])?v[k]:'unknown';
    for (const k of ['examplesEnabled','examplesIncluded','cacheHit']) if (k in v) out[k]=typeof v[k]==='boolean'?v[k]:null;
    for (const k of ['targetLang','sourceLang']) if (k in v) out[k]=typeof v[k]==='string'&&/^(?:[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}|mixed|auto|)$/.test(v[k])?v[k]:'unknown';
    if ('policyVersion' in v) out.policyVersion=typeof v.policyVersion==='string'&&/^(?:system-style-single-owner|system-style-human-bootstrap|user-style-single-owner|localized-page-first)-\d{4}(?:\.\d{1,2}){3}$/.test(v.policyVersion)?v.policyVersion:'unknown';
    if ('operationId' in v) out.operationId=pickId(v.operationId);
    return out;
  }
  function sanitizeCacheCoordination(v) {
    if (!v || v.schema !== 'tp.cache_coordination/1') return null;
    const out = {schema:'tp.cache_coordination/1'};
    const enums = {
      phase:['waiting','admitted','dispatch','finished'],
      mode:['best_effort','observe_only','runtime_managed','disabled','unsupported','missing_prefix'],
      role:['leader','observer','follower','reuse','passive','bypass'],
      reason:['cold_group','recent_group','leader_pending','leader_terminal','leader_failed','leader_cancelled',
        'wait_limit','wait_disabled','runtime_managed','disabled','unsupported','missing_prefix',
        'follower_cancelled','registry_expired','registry_evicted','released',
        'new_group','next_request','lease_expired','leader_active','leader_capacity'],
      releaseReason:['leader_terminal','leader_failed','leader_cancelled','wait_limit','wait_disabled',
        'runtime_managed','registry_expired','registry_evicted','stale_completion',
        'lease_expired','lease_superseded','observation_complete'],
      registryScope:['api_process','extension_worker'],
      coordinationPolicy:['observe_no_wait'],namespaceScope:['credential_endpoint_model_prefix'],
      leaderLeaseState:['active','released','expired','superseded','not_tracked'],
      cacheStatus:['not_reported','reported_hit','reported_zero'],missReason:['unknown'],
    };
    for(const [k, values] of Object.entries(enums)) if(k in v) out[k]=values.includes(v[k])?v[k]:null;
    for(const k of ['groupId','staticPrefixSha256']) if(k in v) out[k]=typeof v[k]==='string'&&/^[a-f0-9]{64}$/.test(v[k])?v[k]:null;
    for(const k of ['coordinationId','leaderCoordinationId','operationId']) if(k in v) out[k]=pickId(v[k]);
    for(const k of ['waitMs','waitLimitMs','retentionMs','previousCompletions','cachedInputTokens',
      'leaderLeaseMs','observationLimit','activeLeaderLimit','observationOrder','previousObservationOrder','previousObservationAgeMs']) if(k in v)
      out[k]=typeof v[k]==='number'&&Number.isFinite(v[k])&&v[k]>=0&&v[k]<=Number.MAX_SAFE_INTEGER?metric(v[k]):null;
    for(const k of ['reusedGroup','previousCacheHit','requestDispatched','terminalCompleted','observationRecorded','latestObservationApplied']) if(k in v) out[k]=typeof v[k]==='boolean'?v[k]:null;
    if('providerCacheReady' in v) out.providerCacheReady=null;
    if('providerCacheTtlMs' in v) out.providerCacheTtlMs=null;
    for(const k of ['targetLang','sourceLang']) if(k in v) out[k]=typeof v[k]==='string'&&/^(?:[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}|mixed|auto|)$/.test(v[k])?v[k]:'unknown';
    return out;
  }
  const CONVERSATION_SPEC={"enums":{"mode":["independent","conversation"],"path":["independent","conversation"],"phase":["queued","acquired","prepared","finished","failed"],"policy":["conversation-append-2026.9.14.9","conversation-ready-2026.9.14.10","conversation-human-bootstrap-2026.9.15.1","conversation-immutable-anchor-2026.9.15.2","conversation-cache-affinity-pages-2026.9.15.3"],"scopeStatus":["ready","scope_missing","expired_lane_recovered"],"rolloverReason":["none","prefix_changed","request_profile_changed","context_budget","history_storage_budget","source_changed","source_replayed","source_order_rewound"],"branch":["initial","repair"],"orderPolicy":["request_arrival","document_enqueue"],"commitStatus":["pending","pending_commit","committed","not_applicable","ephemeral_not_retained","history_storage_limit","stale_lease_not_committed","read_only_repair","not_committed_invalid_output","not_committed_cancelled","not_committed_stale_lease","not_committed_storage_error","not_committed_cancelled_or_failed","not_committed_failed","branched_without_new_turn"],"providerCacheStatus":["not_reported","reported_hit","reported_zero"],"storage":["api_sqlite","ephemeral","local_indexeddb","local_memory","history_storage_limit","api_memory"],"historyQuality":["structural_and_script_checks_not_human_approved"],"planner":["conversation_cross_page","conversation_request"],"providerAffinityStatus":["awaiting_first_provider","pinned_from_committed_turn","matched","route_changed"]},"numeric":["historyRevision","turnIndex","historyTurns","historyMessages","historyChars","historyEstimatedTokens","estimatedInput","currentUserChars","queueWaitMs","pageQueueWaitMs","pageOrder","trimmedTurns","contextLimit","outputReserve","providerCallsAdded","cachedInputTokens","actualInputTokens","actualOutputTokens","formattingWhitespaceChars","unexpectedProseChars","pageCount","unitCount","bootstrapExamplesChars"],"booleans":["staticUserRepeated","legacyFallback","bootstrapExamplesIncluded","bootstrapExamplesPersisted"]};
  function sanitizeConversation(v) {
    if(!v || v.schema!=="tp.conversation/1")return null;
    const spec=CONVERSATION_SPEC,out={schema:"tp.conversation/1"};
    for(const [key,allowed] of Object.entries(spec.enums)) if(key in v)out[key]=allowed.includes(v[key])?v[key]:null;
    for(const key of spec.numeric) if(key in v)out[key]=typeof v[key]==="number"&&Number.isFinite(v[key])&&v[key]>=0&&v[key]<=Number.MAX_SAFE_INTEGER?metric(v[key]):null;
    for(const key of spec.booleans)if(key in v)out[key]=typeof v[key]==="boolean"?v[key]:null;
    for(const key of ["scope","historySha256","prefixSha256"])if(key in v)out[key]=typeof v[key]==="string"&&(/^(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(v[key])||key==="scope"&&v[key]==="ephemeral")?v[key]:null;
    if("historyMessageRoles" in v)out.historyMessageRoles=typeof v.historyMessageRoles==="string"&&v.historyMessageRoles.length<=4096&&/^(?:user,assistant(?:,user,assistant)*)?$/.test(v.historyMessageRoles)?v.historyMessageRoles:null;
    for(const key of ["hfInferenceProviderAffinity","resolvedUpstreamProvider"])if(key in v)out[key]=typeof v[key]==="string"&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v[key])?v[key]:null;
    return out;
  }
  const BATCH_SPEC={"enums":{"planner":["conversation_cross_page"],"phase":["queued","dispatch","distributed","page_projection","failed"],"splitReason":["ready_queue_drained","request_source_limit","output_reliability_estimate","per_request_budget","learned_record_target","learned_output_target","oversize_single_unit","per_request_input_limit","per_request_context_window","per_request_output_budget","request_source_limit_before_page","conversation_page_record_target","conversation_page_output_target","whole_page_over_soft_target","anchor_recovery_retry","anchor_recovery_exhausted","hard_application_source_limit_partial_page","hard_provider_budget_partial_page","per_request_input_limit_before_page","per_request_context_window_before_page","per_request_output_budget_before_page","conversation_anchor_one_page"],"queueReason":["ready","waiting_for_source_order","waiting_for_previous_turn","context_boundary","image_boundary","repeated_page_boundary"],"usageOwner":["provider_request"],"mappingStatus":["validated","rejected"],"idPolicy":["source_opaque_wire_pn","conversation_image_unit_v1"],"failureCode":["ai_conversation_origin_invalid","invalid_request","other"],"failureStage":["conversation_mapping","api_request_validation","provider","unknown"],"validationReason":["invalid_page_list","invalid_page_origin","incomplete_mapping","invalid_wire_id","duplicate_wire_id","invalid_source_id","duplicate_source_id","too_many_wire_ids","invalid_page_id","duplicate_page_id","invalid_fingerprint","source_order_mismatch","image_id_mismatch"],"conversationCapacity":["anchor","continuation_cache_candidate","continuation_cache_miss","continuation_prefix_assumed","continuation_cache_confirmed","continuation_cache_strong","continuation_reliability_restricted","continuation_latency_limited","anchor_one_page","continuation_token_budget"],"anchorRecovery":["retry_same_anchor","exhausted_stop_chain"],"schedulingPolicy":["webpage_order"]},"numeric":["pageCount","unitCount","requestUnitCount","readyPageCount","readyUnitCount","firstOrder","lastOrder","estimatedInput","predictedOutput","mappedUnits","cancelledUnits","missingUnits","providerCallsAdded","providerRequestCount","requestMs","batchTotalMs","checkpointBeforeMs","providerRoundTripMs","projectionMs","readyQueueWaitMs","previousTurnWaitMs","sourceOrderWaitMs","apiHttpStatus","cacheRatio"],"booleans":["legacyFallback","requestDispatched","cacheConfirmed"]};
  function sanitizeConversationBatch(v){
    if(!v || v.schema!=="tp.conversation_batch/1")return null;
    const out={schema:"tp.conversation_batch/1"};
    for(const [k,allowed] of Object.entries(BATCH_SPEC.enums))if(k in v)out[k]=allowed.includes(v[k])?v[k]:null;
    for(const k of BATCH_SPEC.numeric)if(k in v)out[k]=typeof v[k]==="number"&&Number.isFinite(v[k])&&v[k]>=0&&v[k]<=Number.MAX_SAFE_INTEGER?metric(v[k]):null;
    for(const k of BATCH_SPEC.booleans)if(k in v)out[k]=typeof v[k]==="boolean"?v[k]:null;
    if("validationField" in v)out.validationField=typeof v.validationField==='string' && v.validationField.length<=120 && /^conversation\.origins(?:\.[a-zA-Z0-9]+)*$/.test(v.validationField)?v.validationField:null;
    if("batchId" in v)out.batchId=pickId(v.batchId);
    return out;
  }
  root.TPAuditSchema=Object.freeze({sanitize,sanitizePromptLayout,sanitizeCacheCoordination,sanitizeConversation,sanitizeConversationBatch,events:Object.freeze([...events]),reasons:Object.freeze([...reasons])});
})(globalThis);
