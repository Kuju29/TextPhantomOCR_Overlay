// Per-image progress badges are disabled by policy.
//
// Only actionable IMAGE_ERROR badges should appear on an individual image.
// Keep no-op hooks for compatibility with older background packets and so a
// future opt-in progress UI can reuse the existing message contract.
(function(){
 const TP=window.__TP;if(!TP||TP.bail)return;
 function removeLegacy(){
   try{document.querySelectorAll('.tp-image-status').forEach(node=>node.remove());}catch{}
 }
 removeLegacy();
 TP.updateImageStatus=_msg=>({ok:true,disabled:true});
 TP.clearImageStatuses=removeLegacy;
 TP.imageStatusHeight=_img=>0;
 window.addEventListener('pagehide',removeLegacy,{once:true});
})();
