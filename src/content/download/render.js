// Canvas renderer derived from the user's Export Test v1.2 (27.24). Uses a
// snapshot of computed styles; no OCR/layout/erasing or artificial box widening.
(function () {
  'use strict';
  const TP=window.__TP;
  if (!TP || TP.bail || window.top!==window) return;
  const api=TP.downloads ||= {};
  function captureLines(scope) {
    return api.visibleLines(scope).map(el=>{
      const cs=getComputedStyle(el);
      return {textContent:el.textContent,vertical:el.classList.contains('vert'),
        style:Object.fromEntries(['left','top','width','height','fontSize','transform'].map(k=>[k,el.style[k]])),
        computed:Object.fromEntries(['fontSize','lineHeight','fontStyle','fontWeight','fontFamily','color','transform'].map(k=>[k,cs[k]]))};
    });
  }
  function pctToFrac(v) {
    const n=parseFloat(String(v || '').replace('%',''));
    return Number.isFinite(n)?n/100:0;
  }

  function readRotateDeg(transform) {
    if (!transform || transform==='none') return 0;

    // Computed style normally returns matrix(...)
    let m=/matrix\(([^)]+)\)/.exec(transform);
    if (m) {
      const p=m[1].split(',').map(parseFloat);
      if (p.length>=4) {
        return (Math.atan2(p[1],p[0])*180)/Math.PI;
      }
    }

    // Fallback for inline rotate(...deg)
    m=/rotate\(\s*(-?\d+(?:\.\d+)?)deg\s*\)/i.exec(transform);
    return m ? Number(m[1]) : 0;
  }

  function wrapCanvasText(ctx,text,maxW) {
    const tokens=text.includes(' ')
      ? text.split(/(\s+)/)
      : [...text];

    const lines=[];
    let cur='';

    for (const tok of tokens) {
      const test=cur+tok;

      if (
        ctx.measureText(test).width>maxW &&
        cur.trim()
      ) {
        lines.push(cur.trim());
        cur=tok.trim()?tok:'';
      } else {
        cur=test;
      }
    }

    if (cur.trim()) lines.push(cur.trim());
    return lines.length?lines:[text];
  }

  function drawOverlayLine(ctx,el,W,H) {
    const text=(el.textContent || '').replace(/\u200b/g,'');
    if (!text.trim()) return;

    const st=el.style;

    const left=pctToFrac(st.left)*W;
    const top=pctToFrac(st.top)*H;
    const bw=pctToFrac(st.width)*W;
    const bh=pctToFrac(st.height)*H;

    // IMPORTANT:
    // 27.24 Overlay font size is implemented with:
    // font-size: calc(var(--tp-font-scale,1) * Npx)
    // getComputedStyle resolves the CURRENT user-selected scale for us.
    const cs=el.computed;

    let fontPx=parseFloat(cs.fontSize) || 0;

    if (!fontPx) {
      const m=/([0-9.]+)px/.exec(st.fontSize || '');
      fontPx=m?parseFloat(m[1]):16;
    }

    let linePx=parseFloat(cs.lineHeight);
    if (!Number.isFinite(linePx)) {
      linePx=fontPx*1.15;
    }

    const isVert=el.vertical;
    const rot=readRotateDeg(cs.transform || st.transform);

    ctx.save();

    ctx.translate(
      left+bw/2,
      top+bh/2
    );

    if (rot) {
      ctx.rotate(rot*Math.PI/180);
    }

    ctx.font =
      `${cs.fontStyle || 'normal'} ` +
      `${cs.fontWeight || 600} ` +
      `${fontPx}px ${cs.fontFamily || 'sans-serif'}`;

    ctx.fillStyle=cs.color || '#0f0f0f';
    ctx.textAlign='center';
    ctx.textBaseline='middle';

    // Mirror TP halo approximately.
    ctx.lineWidth=Math.max(2,fontPx*0.14);
    ctx.strokeStyle='rgba(255,255,255,0.95)';
    ctx.lineJoin='round';

    if (isVert) {
      const chars=[...text];
      const cell=linePx || fontPx*1.02;
      let y=-((chars.length-1)*cell)/2;

      for (const ch of chars) {
        ctx.strokeText(ch,0,y);
        ctx.fillText(ch,0,y);
        y+=cell;
      }
    } else {
      // EXACT box width. No artificial widening.
      const wrapped=wrapCanvasText(
        ctx,
        text,
        bw || W
      );

      const lh=linePx || fontPx*1.15;
      let y=-((wrapped.length-1)*lh)/2;

      for (const line of wrapped) {
        ctx.strokeText(line,0,y);
        ctx.fillText(line,0,y);
        y+=lh;
      }
    }

    ctx.restore();
  }

  Object.assign(api,{captureLines,drawOverlayLine});
})();
