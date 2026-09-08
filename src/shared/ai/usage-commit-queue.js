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
          let next=normalize(raw);const original=JSON.stringify(next);
          const results=[];
          for(const task of batch){
            const before=next;
            try { next=task.reduce(next); results.push({before,next}); }
            catch(error) { results.push({error}); }
          }
          const encoded=JSON.stringify(next);const computed=clock();
          if(original!==encoded)await write(next);
          const ended=clock();
          timings={lockMs:began-queuedAt,readMs:readAt-began,computeMs:computed-readAt,writeMs:ended-computed,batchSize:batch.length};
          return {next,results,unchanged:original===encoded};
        });
        batch.forEach((task,i)=>{
          const timing={...timings,queueMs:Math.max(0,queuedAt-task.at),persistMs:clock()-task.at};
          const result=value.results[i];
          if(result.error){safe(task.onTiming,{...timing,failed:true});task.reject(result.error);}
          else {safe(task.onTiming,timing);safe(task.onCommit,result,timing);task.resolve(result.next);}
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
