// Small ZIP STORE writer for already-compressed images. No CDN, worker, API,
// binary-string copies, or whole-archive ArrayBuffer. CRC reads one MiB at a time.
// ZIP32 limits fail explicitly; never split a user's Download all into files.
(function () {
  'use strict';
  const TP=window.__TP;
  if (!TP || TP.bail || window.top!==window) return;
  const api=TP.downloads ||= {}, MAX=0xffffffff;
  const crcTable=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0;}
  const check=signal=>{if(signal?.aborted)throw new DOMException('Download cancelled','AbortError');};
  const fatal=message=>Object.assign(new Error(message),{code:'DOWNLOAD_ZIP_LIMIT'});
  function entryName(value){
    let name=String(value).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/g,'');
    if(!name || name==='.' || name==='..')name='image';
    if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
    // Keep a leaf filename extractable on Windows, including UTF-8 Thai names.
    const encoder=new TextEncoder(),parts=/^(.*?)(\.[^.]{1,10})?$/.exec(name),ext=parts[2]||'';
    let stem=Array.from(parts[1]);
    while(encoder.encode(stem.join('')+ext).length>220)stem.pop();
    return (stem.join('')||'image')+ext;
  }
  async function crc32(blob,signal){
    let crc=0xffffffff;
    for(let start=0;start<blob.size;start+=1048576){
      check(signal);const bytes=new Uint8Array(await blob.slice(start,start+1048576).arrayBuffer());check(signal);
      for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    check(signal);return (crc^0xffffffff)>>>0;
  }
  function header(size,signature){const bytes=new Uint8Array(size),view=new DataView(bytes.buffer);view.setUint32(0,signature,true);return {bytes,view};}
  class ImageZip {
    constructor(){this.parts=[];this.entries=[];this.names=new Set();this.offset=0;this.closed=false;}
    async add(filename,blob,signal){
      check(signal);
      if(this.closed)throw new Error('ZIP is already closed');
      if(!(blob instanceof Blob))throw new Error('ZIP image is not a Blob');
      let name=entryName(filename),base=name,n=1;
      while(this.names.has(name.toLowerCase())){const dot=base.lastIndexOf('.');name=dot>0?`${base.slice(0,dot)} (${++n})${base.slice(dot)}`:`${base} (${++n})`;}
      const encoded=new TextEncoder().encode(name);
      const next=this.offset+30+encoded.length+blob.size;
      const central=this.entries.reduce((sum,e)=>sum+46+e.encoded.length,0)+46+encoded.length;
      if(this.entries.length>=65534 || blob.size>=MAX || next+central+22>=MAX)
        throw fatal('This ZIP exceeds ZIP32 limits (under 4 GiB and 65,535 entries). No archive was saved.');
      const crc=await crc32(blob,signal);check(signal);
      const date=new Date(),year=Math.max(1980,Math.min(2107,date.getFullYear()));
      const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),day=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
      const {bytes,view}=header(30,0x04034b50);
      view.setUint16(4,20,true);view.setUint16(6,0x800,true); // UTF-8, STORE (method zero)
      view.setUint16(10,time,true);view.setUint16(12,day,true);view.setUint32(14,crc,true);
      view.setUint32(18,blob.size,true);view.setUint32(22,blob.size,true);view.setUint16(26,encoded.length,true);
      this.parts.push(bytes,encoded,blob);this.entries.push({name,encoded,crc,size:blob.size,time,day,offset:this.offset});
      this.names.add(name.toLowerCase());this.offset=next;return name;
    }
    finish(signal){
      check(signal);if(this.closed)throw new Error('ZIP is already closed');
      if(!this.entries.length)throw new Error('No images could be added; no ZIP was saved');
      const central=[];let size=0;
      for(const e of this.entries){
        const {bytes,view}=header(46,0x02014b50);
        view.setUint16(4,20,true);view.setUint16(6,20,true);view.setUint16(8,0x800,true);
        view.setUint16(12,e.time,true);view.setUint16(14,e.day,true);view.setUint32(16,e.crc,true);
        view.setUint32(20,e.size,true);view.setUint32(24,e.size,true);view.setUint16(28,e.encoded.length,true);
        view.setUint32(42,e.offset,true);central.push(bytes,e.encoded);size+=46+e.encoded.length;
      }
      const {bytes,view}=header(22,0x06054b50);
      view.setUint16(8,this.entries.length,true);view.setUint16(10,this.entries.length,true);
      view.setUint32(12,size,true);view.setUint32(16,this.offset,true);
      const blob=new Blob([...this.parts,...central,bytes],{type:'application/zip'});this.dispose();return blob;
    }
    dispose(){this.parts=[];this.entries=[];this.names.clear();this.closed=true;}
  }
  Object.assign(api,{ImageZip,zipEntryName:entryName});
})();
