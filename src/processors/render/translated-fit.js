/** Discrete row fit for target-only reflow. Not a token count or a global font cap. */
import { MIN_FONT_PX, fitParagraphFontSizeHorizontal, glyphWidthRatio, roundHalfEven } from "../text-metrics.js";
export function fitTranslatedBlockFont(block, text, imgW, imgH) {
  const width=block.widthPct*imgW/100, height=block.heightPct*imgH/100;
  const ratio=glyphWidthRatio(text);
  let font=fitParagraphFontSizeHorizontal(block.widthPct,block.heightPct,text,imgW,imgH);
  const tokens=String(text).split(/(\s+)/u).filter(Boolean);
  for (;font>MIN_FONT_PX;font--) {
    const available=width-.2*font;
    if (available<=0) continue;
    let rows=1, used=0, space=0;
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        const breaks=(token.match(/\n/gu)||[]).length;
        if (breaks) { rows+=breaks; used=0; }
        space=breaks?0:.33*font;
        continue;
      }
      let length=Array.from(token).length*ratio*font;
      if (used && used+space+length>available) { rows++; used=0; space=0; }
      if (length>available) {
        const parts=Math.ceil(length/available);
        rows+=parts-1; length-=available*(parts-1);
      }
      used+= (used?space:0)+length; space=0;
    }
    if (rows*roundHalfEven(font*1.05)+.4*font<=height) break;
  }
  return font;
}
