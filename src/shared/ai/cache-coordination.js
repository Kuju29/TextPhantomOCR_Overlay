import '../diagnostic-schema.js';

// Only process-local observations; runtime KV cache, routing and credentials
// remain separate. No waits, warm-ups, reloads, timers or invented counters.
let salt;
const encoder = new TextEncoder();
async function keyOf(parts) {
  if (!salt) salt = crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', await salt, encoder.encode(JSON.stringify(parts)));
  return [...new Uint8Array(signature)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const id = () => crypto.randomUUID().replaceAll('-','');
const safe = value => globalThis.TPAuditSchema.sanitizeCacheCoordination(value);

export function createLocalPrefixObserver({clock=()=>performance.now(),leaseMs=120000,maxGroups=1024,maxActive=1024}={}) {
  const observations=new Map(),leaders=new Map();let sequence=0;
  for(const value of [leaseMs,maxGroups,maxActive]) if(!Number.isSafeInteger(value)||value<=0)throw new TypeError('Invalid prefix observation bound');
  return async function observe({url,model,headers={},payload,layout,trace,revision='',operationId=''}) {
    if(!/^[a-f0-9]{64}$/.test(layout?.staticPrefixSha256||''))return null;
    const key=await keyOf([url,model,Object.entries(headers).sort(([a],[b])=>a.localeCompare(b)),
      layout.staticPrefixSha256,layout.targetLang,layout.sourceLang,
      payload.format||payload.response_format||null,revision,payload.think??null,payload.options?.num_ctx??null]);
    const now=clock(),requestId=id(),order=++sequence;
    const old=leaders.get(key),expired=!!old&&old.deadline<=now;
    while(leaders.size&&leaders.values().next().value.deadline<=now)leaders.delete(leaders.keys().next().value);
    let observation=observations.get(key),reused=!!observation;
    if(!observation){
      if(observations.size>=maxGroups)observations.delete(observations.keys().next().value);
      observation={completions:0,lastHit:null,lastOrder:0,observedAt:null};
    }
    observations.delete(key);observations.set(key,observation);
    let leader=leaders.get(key),role='observer',reason='leader_active';
    if(!leader&&leaders.size<maxActive){
      leader={id:requestId,deadline:now+leaseMs};leaders.set(key,leader);
      role='leader';reason=expired?'lease_expired':reused?'next_request':'new_group';
    }else if(!leader)reason='leader_capacity';
    const data={schema:'tp.cache_coordination/1',phase:'admitted',mode:'runtime_managed',
      role,reason,registryScope:'extension_worker',groupId:key,coordinationId:requestId,
      leaderCoordinationId:leader?.id??null,operationId:operationId||null,staticPrefixSha256:layout.staticPrefixSha256,
      targetLang:layout.targetLang,sourceLang:layout.sourceLang,waitMs:0,waitLimitMs:0,retentionMs:null,
      coordinationPolicy:'observe_no_wait',namespaceScope:'credential_endpoint_model_prefix',providerCacheTtlMs:null,
      leaderLeaseMs:leaseMs,leaderLeaseState:leader?'active':'not_tracked',observationLimit:maxGroups,activeLeaderLimit:maxActive,
      observationOrder:order,previousObservationOrder:observation.lastOrder,observationRecorded:null,latestObservationApplied:null,
      previousObservationAgeMs:observation.observedAt===null?null:Math.max(0,now-observation.observedAt),
      reusedGroup:reused,previousCompletions:observation.completions,previousCacheHit:observation.lastHit,
      providerCacheReady:null,cacheStatus:'not_reported',cachedInputTokens:null,requestDispatched:false,
      terminalCompleted:null,releaseReason:null,missReason:'unknown'};
    const emit=()=>{try{trace?.('cacheCoordination',safe(data));}catch{}};
    let finished=false;emit();
    return {
      snapshot:()=>safe(data),
      dispatched(){if(data.requestDispatched)return;data.phase='dispatch';data.requestDispatched=true;emit();},
      finish(usage={},complete=false,reason="provider_terminal"){
        if(finished)return safe(data);finished=true;
        const cached=usage?.cachedInputTokens,input=usage?.inputTokens;
        const reported=Number.isSafeInteger(cached)&&cached>=0&&(!Number.isSafeInteger(input)||cached<=input);
        data.phase='finished';data.terminalCompleted=complete===true;
        data.cachedInputTokens=reported?cached:null;
        data.cacheStatus=!reported?'not_reported':cached>0?'reported_hit':'reported_zero';
        data.observationRecorded=observations.get(key)===observation&&data.requestDispatched;
        data.latestObservationApplied=false;
        if(data.observationRecorded){
          if(complete)observation.completions++;
          if(order>=observation.lastOrder){
            observation.lastHit=reported?cached>0:null;observation.lastOrder=order;observation.observedAt=clock();data.latestObservationApplied=true;
          }
        }
        if(role==='leader'){
          if(leaders.get(key)!==leader){data.leaderLeaseState='superseded';data.releaseReason='lease_superseded';}
          else{
            leaders.delete(key);const expired=clock()>=leader.deadline;
            data.leaderLeaseState=expired?'expired':'released';
            data.releaseReason=expired?'lease_expired':complete?'leader_terminal':reason==='cancelled'?'leader_cancelled':'leader_failed';
          }
        }else{
          data.releaseReason='observation_complete';
          if(leader&&leaders.get(key)!==leader)data.leaderLeaseState='superseded';
        }
        emit();return safe(data);
      },
    };
  };
}
export const observeLocalPrefix=createLocalPrefixObserver();
