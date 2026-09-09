import { laneKeyFor, setLaneCapacityHint } from "../scheduler.js";

export function applyRuntimeCapacityHints(caps, payload) {
  // The API reports the slots each of its lanes currently holds. Matching the
  // Lens lane to that number keeps the queue on this side, where it is visible,
  // instead of inside the API where the extension cannot see or measure it.
  const lensSlots =
    Number(caps?.adaptive?.lens?.limit) || Number(caps?.capacity?.limit) || 0;
  if (lensSlots > 0) setLaneCapacityHint("lens:direct", lensSlots);
  // Grouping is a server-owned detector-free stage. Mirror its advertised
  // admission width so this browser keeps only its own backlog; cross-user
  // fairness remains authoritative on the API and is never duplicated here.
  const groupSlots = Number(caps?.capacityGroups?.limit) || 0;
  if (Number.isSafeInteger(groupSlots) && groupSlots > 0)
    setLaneCapacityHint("groups:partition", groupSlots);
  const aiSlots =
    Number(caps?.adaptive?.ai?.limit) || Number(caps?.capacityAi?.limit) || 0;
  if (
    aiSlots > 0 &&
    payload?.mode === "lens_text" &&
    payload?.source === "ai"
  ) {
    const activeBurst =
      payload?.rate?.enabled === true ? Number(payload?.rate?.burst) || 0 : 0;
    setLaneCapacityHint(laneKeyFor(payload), aiSlots, activeBurst);
  }
}

