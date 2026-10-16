// Structural unit-layout trace for a translation job (extracted from jobs.js
// without behaviour change; the trace keeps its "background/jobs.js" source).
import { note as traceNote } from "../../shared/trace.js";
import { translationUnits } from "../../shared/lens-document.js";

// Structural trace only: IDs, reading order and geometry. Never include OCR
// or translated strings, so TP_TRACE can diagnose reversal and rotation signs
// without exporting page dialogue.
export function traceUnitLayout(doc, traceId, phase, imageId = "") {
  if (!traceId) return;
  const paragraphs = Array.isArray(doc?.paragraphs) ? doc.paragraphs : [];
  const paragraphById = new Map(
    paragraphs.map((paragraph) => [String(paragraph?.id || ""), paragraph]),
  );
  const groupByMember = new Map();
  for (const group of Array.isArray(doc?.canonicalOriginalTree?.paragraphs)
    ? doc.canonicalOriginalTree.paragraphs
    : []) {
    for (const id of group?.source?.documentParagraphIds || [])
      groupByMember.set(String(id), group);
  }
  const units = translationUnits(doc);
  for (let offset = 0; offset < units.length; offset += 10) {
    traceNote(
      "background/jobs.js",
      "unitLayout",
      {
        phase,
        imageId: String(imageId || ""),
        offset,
        units: units.slice(offset, offset + 10).map((unit, localIndex) => {
          const paragraphIds = (unit?.paragraphIds || []).map(String);
          const group = paragraphIds
            .map((id) => groupByMember.get(id))
            .find(Boolean);
          const members = paragraphIds.map((paragraphId) => {
            const paragraph = paragraphById.get(paragraphId);
            const rotations = (paragraph?.items || paragraph?.lensItems || [])
              .map((item) => Number(item?.box?.rotation_deg ?? item?.rotation))
              .filter(Number.isFinite);
            return {
              paragraphId,
              inputRotations: rotations,
              inputSigns: rotations.map((rotation) => Math.sign(rotation)),
            };
          });
          const memberRotations = members.flatMap(
            (member) => member.inputRotations,
          );
          const groupRotation = Number(group?.rotation);
          // Groups carry the server-selected output rotation. Ungrouped units
          // preserve Lens geometry, so the first finite member rotation is the
          // renderer's input rather than reporting an unhelpful null.
          const outputRotation = Number.isFinite(groupRotation)
            ? groupRotation
            : memberRotations[0];
          return {
            index: offset + localIndex,
            id: String(unit?.id || ""),
            paragraphIds,
            readingOrder: paragraphIds,
            members,
            direction: String(group?.direction || ""),
            outputRotation: Number.isFinite(outputRotation)
              ? outputRotation
              : null,
            outputSign: Number.isFinite(outputRotation)
              ? Math.sign(outputRotation)
              : null,
            outputRotationSource: Number.isFinite(groupRotation)
              ? "group"
              : "lens",
          };
        }),
      },
      traceId,
    );
  }
}
