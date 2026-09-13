// One read + one durable write for an ordered burst, under the existing browser
// lock. No cached ledger across commits and no fire-and-forget accounting.
export function createUsageCommitQueue({read,write,normalize,lock,clock=()=>performance.now(),maxBatch=32}) {
  const pending=[];let running=false;
  const safe=(fn,...args)=>{try{fn?.(...args);}catch{}};
  async function drain(){
    while(pending.length){
      const batch=pending.splice(0,maxBatch),queuedAt=clock();
      let timings={};
      try{
        const value=await lock(async()=>{
          const began=clock();const raw=await read();const readAt=clock();
          // Admit arrivals while the authoritative read was pending, before
          // any reducer runs. Write-phase arrivals remain a fresh transaction.
          batch.push(...pending.splice(0, Math.max(0,maxBatch-batch.length)));
          let next=normalize(raw);
          const original=JSON.stringify(next);
          let encoded=original;
          const results=[];
          for(const task of batch){
            const before=next;
            try {
              // Reuse adjacent encodings only; even in-place reducers must
              // still be compared against their pre-reduction JSON snapshot.
              const beforeEncoded=task.onCommit ? (encoded ?? JSON.stringify(before)) : null;
              next=task.reduce(next);
              encoded=task.onCommit ? JSON.stringify(next) : null;
              const unchanged=task.onCommit ? beforeEncoded===encoded : undefined;
              results.push({before,next,unchanged});
            }
            catch(error) { results.push({error}); }
          }
          encoded ??= JSON.stringify(next);const computed=clock();
          if(original!==encoded)await write(next);
          const ended=clock();
          timings={lockMs:began-queuedAt,readMs:readAt-began,computeMs:computed-readAt,writeMs:ended-computed,batchSize:batch.length};
          return {next,results,unchanged:original===encoded,began,readAt};
        });
        batch.forEach((task,i)=>{
          const timing={...timings,
            lockMs:Math.max(0,value.began-Math.max(queuedAt,task.at)),
            readMs:Math.max(0,value.readAt-Math.max(value.began,task.at)),
            queueMs:Math.max(0,queuedAt-task.at),persistMs:clock()-task.at};
          const result=value.results[i];
          if(result.error){safe(task.onTiming,{...timing,failed:true});task.reject(result.error);}
          else {
            const callbackAt=clock();
            safe(task.onCommit,result,timing);
            timing.callbackMs=Math.max(0,clock()-callbackAt);
            timing.persistMs=Math.max(0,clock()-task.at);
            safe(task.onTiming,timing);
            task.resolve(result.next);
          }
        });
      }catch(error){
        for(const task of batch){safe(task.onTiming,{...timings,queueMs:Math.max(0,queuedAt-task.at),persistMs:clock()-task.at,failed:true});task.reject(error);}
      }
    }
    running=false;
  }
  return function commit(reduce,{onCommit,onTiming}={}){
    return new Promise((resolve,reject)=>{
      pending.push({reduce,onCommit,onTiming,resolve,reject,at:clock()});
      if(!running){running=true;queueMicrotask(()=>{void drain();});}
    });
  };
}
