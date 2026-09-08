import { containsRtl, isCjkDominant, roundHalfEven } from "../text-metrics.js";
import { VERTICAL_TILT_DEG } from "./vertical-layout.js";

export function makeLine(
  ownerDocument,
  geometry,
  text,
  fontPx,
  onDark = false,
  extraClasses = [],
  paraId = "",
) {
  const line = ownerDocument.createElement("div");
  if (paraId) line.setAttribute?.("data-tp-para", String(paraId));
  const classes = ["tp-line"];
  if (onDark) classes.push("tp-on-dark");
  const vertical =
    geometry.upright === true ||
    (geometry.sideways !== true && Math.abs(geometry.rotation) > VERTICAL_TILT_DEG && isCjkDominant(text));
  if (vertical) classes.push("vert");
  if (containsRtl(text)) classes.push("rtl");
  line.className = classes.concat(extraClasses).join(" ");
  const lineHeight = roundHalfEven(fontPx * 1.05);
  line.style.cssText =
    `left:${geometry.leftPct.toFixed(4)}%;top:${geometry.topPct.toFixed(4)}%;` +
    `width:${geometry.widthPct.toFixed(4)}%;height:${geometry.heightPct.toFixed(4)}%;` +
    (vertical ? "" : `transform:rotate(${geometry.rotation.toFixed(4)}deg);`) +
    `font-size:calc(var(--tp-font-scale,1) * ${fontPx}px);` +
    `line-height:calc(var(--tp-font-scale,1) * ${lineHeight}px);`;
  line.textContent = text;
  return line;
}
