// Download all = one ZIP handoff; individual image = one image handoff.
// Nothing here creates translations, discovers extra pages, or writes image data to storage.
(function () {
  'use strict';
  const TP=window.__TP;
  if (!TP || TP.bail || window.top!==window) return;
  const api=TP.downloads ||= {};
  const check=signal=>{if(signal?.aborted)throw new DOMException('Download cancelled','AbortError');};
  const safeError=error=>String(error?.message||'Image unavailable').replace(/(?:https?:|blob:|data:)[^\s]*/gi,'[source]').slice(0,300);
  async function runDownload(rows,{kind,archive=false,format='auto',quality=92,title=document.title,signal},progress=()=>{}){
    if(!['translated','clean','original'].includes(kind))throw new Error('Unknown download type');
    const selected=rows.filter(row=>row.available[kind]);
    if(!selected.length)throw new Error('No images available for this type');
    if(!archive && selected.length!==1)throw new Error('Individual downloads require one image');
    const zip=archive?new api.ImageZip():null,failures=[],prepared=[];
    let filename='';
    try{
      for(const [index,row] of selected.entries()){
        check(signal);progress({phase:'preparing',index:index+1,total:selected.length,row});
        try{
          const result=await api.render(row,kind,signal,{format,quality});check(signal);
          filename=api.filename(row,kind,result.ext,title);
          if(zip){progress({phase:'packing',index:index+1,total:selected.length,row});await zip.add(filename,result.blob,signal);}
          else api.save(result.blob,filename,signal);
          prepared.push(row);
        }catch(error){
          if(error.name==='AbortError' || signal?.aborted || error.code==='DOWNLOAD_ZIP_LIMIT')throw error;
          failures.push({page:row.number,fileNumber:row.fileNumber,error:safeError(error)});
        }
        progress({phase:'progress',index:index+1,total:selected.length,row});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      check(signal);
      if(zip && prepared.length){
        if(failures.length){
          const report=['TextPhantom download — incomplete archive',`${prepared.length} / ${selected.length} images included.`,
            `Type: ${kind}; format: ${format}`, 'No translation or erasing was started.', '',
            ...failures.map(f=>`Page ${f.fileNumber}: ${f.error}`)].join('\n');
          await zip.add('_download-errors.txt',new Blob([report],{type:'text/plain;charset=utf-8'}),signal);
        }
        progress({phase:'finishing',index:selected.length,total:selected.length});
        const blob=zip.finish(signal);check(signal);
        filename=api.archiveFilename(kind,title,failures.length>0);api.save(blob,filename,signal);
      }
      return {prepared,failures,total:selected.length,archive,filename,handedOff:prepared.length>0};
    }finally{zip?.dispose();}
  }
  api.runDownload=runDownload;
})();
