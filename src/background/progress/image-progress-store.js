const LANES = Object.freeze(["overall", "lens", "grouping", "ai", "insert"]);
const TERMINAL = new Set(["done", "error", "cancelled", "skipped"]);

function laneState(lane = {}) {
  return {
    state: String(lane.state || "idle"),
    queuedAt: Number(lane.queuedAt) || 0,
    startedAt: Number(lane.startedAt) || 0,
    finishedAt: Number(lane.finishedAt) || 0,
    queueWaitMs: Number(lane.queueWaitMs) || 0,
    detail: String(lane.detail || "").slice(0, 180),
    function: String(lane.function || "").slice(0, 48),
    pageCount: Math.max(0, Number(lane.pageCount) || 0),
    unitCount: Math.max(0, Number(lane.unitCount) || 0),
    turn: Math.max(0, Number(lane.turn) || 0),
    queuedPageCount: Math.max(0, Number(lane.queuedPageCount) || 0),
    provider: String(lane.provider || "").slice(0, 48),
    model: String(lane.model || "").slice(0, 96),
    conversation: lane.conversation === true,
  };
}

export function createImageProgress(now = Date.now()) {
  return {
    updatedAt: now,
    overall: { state: "queued", queuedAt: now, startedAt: 0, finishedAt: 0, queueWaitMs: 0, detail: "Waiting" },
    lens: laneState(),
    grouping: laneState(),
    ai: laneState(),
    insert: laneState(),
    result: { state: "pending", detail: "", updatedAt: now },
  };
}

function ensure(progress, now) {
  const base = progress && typeof progress === "object" ? progress : createImageProgress(now);
  const next = { ...base, updatedAt: now };
  for (const lane of LANES) next[lane] = laneState(base[lane]);
  next.result = {
    state: String(base?.result?.state || "pending"),
    detail: String(base?.result?.detail || "").slice(0, 220),
    updatedAt: Number(base?.result?.updatedAt) || now,
  };
  return next;
}

function queueLane(progress, name, now, detail = "") {
  const lane = progress[name];
  if (TERMINAL.has(lane.state)) return;
  lane.state = "queued";
  if (!lane.queuedAt) lane.queuedAt = now;
  lane.detail = String(detail || lane.detail || "Waiting").slice(0, 180);
}

function runLane(progress, name, now, details = {}) {
  const lane = progress[name];
  if (TERMINAL.has(lane.state)) return;
  if (!lane.queuedAt) lane.queuedAt = now;
  lane.state = "running";
  if (!lane.startedAt) lane.startedAt = now;
  if (Number.isFinite(Number(details.queueWaitMs))) lane.queueWaitMs = Math.max(0, Number(details.queueWaitMs));
  const detail = String(details.stage || details.detail || lane.detail || "Running");
  lane.detail = detail.slice(0, 180);
  if (details.function) lane.function = String(details.function).slice(0, 48);
  if (Number.isFinite(Number(details.pageCount))) lane.pageCount = Math.max(0, Number(details.pageCount));
  if (Number.isFinite(Number(details.unitCount))) lane.unitCount = Math.max(0, Number(details.unitCount));
  if (Number.isFinite(Number(details.turn))) lane.turn = Math.max(0, Number(details.turn));
  if (Number.isFinite(Number(details.queuedPageCount))) lane.queuedPageCount = Math.max(0, Number(details.queuedPageCount));
  if (details.provider) lane.provider = String(details.provider).slice(0, 48);
  if (details.model) lane.model = String(details.model).slice(0, 96);
  if (details.conversation === true) lane.conversation = true;
}

function aiFunctionFromDetail(detail = "") {
  const value = String(detail).toLowerCase();
  if (value.includes("waiting for local ai model")) return "waiting_model";
  if (value.includes("connecting to local ai")) return "connecting";
  if (value.includes("local ai is thinking")) return "thinking";
  if (value.includes("local ai is generating") || value.includes("local ai responded")) return "receiving_response";
  if (value.includes("repair")) return value.includes("waiting") ? "repair_waiting" : "repairing";
  if (value.includes("recovering anchor")) return "recovering_context";
  return "";
}

function finishLane(progress, name, now, state = "done", detail = "") {
  const lane = progress[name];
  if (TERMINAL.has(lane.state) && lane.finishedAt) return;
  if (!lane.startedAt && state === "done") lane.startedAt = lane.queuedAt || now;
  lane.state = state;
  lane.finishedAt = lane.finishedAt || now;
  if (detail) lane.detail = String(detail).slice(0, 180);
}

function finishPrior(progress, phase, now) {
  if (["grouping_queued", "grouping", "ai_queued", "ai_generating", "rendering", "done"].includes(phase)) {
    if (["queued", "running"].includes(progress.lens.state)) finishLane(progress, "lens", now, "done", "Lens complete");
  }
  if (["ai_queued", "ai_generating", "rendering", "done"].includes(phase)) {
    if (["queued", "running"].includes(progress.grouping.state)) finishLane(progress, "grouping", now, "done", "Grouping complete");
    else if (progress.grouping.state === "idle") finishLane(progress, "grouping", now, "skipped", "Not needed");
  }
  if (["rendering", "done"].includes(phase)) {
    if (["queued", "running"].includes(progress.ai.state)) finishLane(progress, "ai", now, "done", "AI complete");
    else if (progress.ai.state === "idle") finishLane(progress, "ai", now, "skipped", "Not needed");
  }
}

export function reduceImageProgress(previous, phase, details = {}, now = Date.now()) {
  const next = ensure(previous, now);
  const normalized = String(phase || "waiting");
  const stage = String(details.stage || details.detail || "").slice(0, 180);
  if (normalized !== "error" && normalized !== "cancelled") finishPrior(next, normalized, now);

  switch (normalized) {
    case "waiting":
      queueLane(next, "overall", now, stage || "Waiting");
      break;
    case "scanning":
    case "downloading":
      runLane(next, "overall", now, { ...details, stage: stage || (normalized === "downloading" ? "Loading image" : "Preparing image") });
      break;
    case "lens_queued":
      runLane(next, "overall", now, { stage: "Processing" });
      queueLane(next, "lens", now, stage || "Waiting for Lens");
      break;
    case "lens":
      runLane(next, "overall", now, { stage: "Processing" });
      runLane(next, "lens", now, { ...details, stage: stage || "Reading text" });
      break;
    case "grouping_queued":
      queueLane(next, "grouping", now, stage || "Waiting to group text");
      break;
    case "grouping":
      runLane(next, "grouping", now, { ...details, stage: stage || "Grouping text" });
      break;
    case "ai_queued":
      queueLane(next, "ai", now, stage || "Waiting for AI slot");
      next.ai.function = "waiting_slot";
      break;
    case "ai_generating": {
      const detail = stage || "Preparing AI request";
      runLane(next, "ai", now, { ...details, stage: detail, function: aiFunctionFromDetail(detail) || "preparing_request" });
      break;
    }
    case "server_processing":
      runLane(next, "overall", now, { stage: stage || "Server pipeline" });
      runLane(next, "ai", now, { ...details, stage: stage || "Server Lens/AI pipeline", function: "server_pipeline" });
      break;
    case "rendering":
      runLane(next, "insert", now, { ...details, stage: stage || "Placing translation", function: "placing" });
      break;
    case "done": {
      if (["queued", "running"].includes(next.insert.state)) finishLane(next, "insert", now, "done", stage || "Inserted");
      else if (next.insert.state === "idle") finishLane(next, "insert", now, "skipped", "No DOM insert needed");
      finishLane(next, "overall", now, "done", "Complete");
      const skipped = String(details.status || "") === "skipped" || /no text|skip/i.test(String(details.lastError || ""));
      next.result = { state: skipped ? "skipped" : "done", detail: String(details.lastError || stage || (skipped ? "Skipped" : "Done")).slice(0, 220), updatedAt: now };
      break;
    }
    case "error": {
      const error = String(details.lastError || stage || "Processing failed").slice(0, 220);
      const active = ["insert", "ai", "grouping", "lens", "overall"].find(name => ["queued", "running"].includes(next[name].state));
      if (active) finishLane(next, active, now, "error", error);
      finishLane(next, "overall", now, "error", error);
      next.result = { state: "error", detail: error, updatedAt: now };
      break;
    }
    case "cancelled": {
      const reason = String(details.lastError || stage || "Cancelled").slice(0, 220);
      const active = ["insert", "ai", "grouping", "lens"].find(name => ["queued", "running"].includes(next[name].state));
      if (active) finishLane(next, active, now, "cancelled", reason);
      finishLane(next, "overall", now, "cancelled", reason);
      next.result = { state: "cancelled", detail: reason, updatedAt: now };
      break;
    }
  }
  return next;
}

export function mergeProgressDetail(progress, patch = {}, now = Date.now()) {
  const next = ensure(progress, now);
  const progressEvent = patch?.progressEvent;
  if (progressEvent && typeof progressEvent === "object") {
    const laneName = String(progressEvent.lane || "");
    const state = String(progressEvent.state || "");
    const detail = String(progressEvent.detail || "");
    if (LANES.includes(laneName)) {
      if (state === "queued") queueLane(next, laneName, now, detail);
      else if (state === "running") runLane(next, laneName, now, { ...progressEvent, stage: detail });
      else if (["done", "error", "cancelled", "skipped"].includes(state)) finishLane(next, laneName, now, state, detail);
    }
    if (progressEvent.resultState) {
      next.result = { state: String(progressEvent.resultState), detail: detail.slice(0, 220), updatedAt: now };
    }
  }
  // This is a DOM receipt, not AI/accounting completion. A later conflict may
  // replace a provisional translation with a badge; keep Insert truthful.
  if (typeof patch?.insertionAck?.present === "boolean") {
    // An acknowledged error badge is not an intentionally skipped image.
    const terminalFailure = progressEvent?.lane === "insert" && ["error", "cancelled"].includes(progressEvent.state);
    next.insert = {...next.insert, state:terminalFailure ? progressEvent.state : patch.insertionAck.present ? "done" : "skipped",
      startedAt:next.insert.startedAt || now, finishedAt:now,
      detail:String(progressEvent?.detail || (patch.insertionAck.present ? "Placed on page" : "No translation layer")).slice(0,180)};
  }
  const aiPhase = String(patch?.phase || "");
  if (aiPhase) {
    const AI_PHASES = {
      usage_pending: ["preparing_request", "Preparing AI request"],
      sending_request: ["sending_request", "Sending AI request"],
      http_wait: ["waiting_response", "Request sent · waiting response"],
      response_headers: ["receiving_response", "Response received"],
      validating: ["validating_result", "Validating AI result"],
    };
    const mapped = AI_PHASES[aiPhase];
    if (mapped) runLane(next, "ai", now, {
      function: mapped[0], stage: mapped[1], unitCount: patch?.unitCount,
      provider: patch?.provider, model: patch?.model,
    });
  }
  const repairPhase = String(patch?.repairPhase || "");
  if (repairPhase && next.overall.state === "cancelled") return next;
  if (repairPhase) {
    if (repairPhase === "collecting") {
      queueLane(next, "ai", now, "Waiting for repair batch");
      next.ai.function = "repair_waiting";
      next.result = { state: "pending", detail: "Repair pending", updatedAt: now };
    } else if (["repairing", "repair_request", "repair_validation"].includes(repairPhase)) {
      const repairEvent = String(patch?.repairEvent || "");
      const preparing = repairPhase === "repair_request" && repairEvent === "instruction_selected";
      const detail = repairPhase === "repair_request" ? (preparing ? "Preparing repair request" : "Repair request sent · waiting response")
        : repairPhase === "repair_validation" ? "Validating repair result" : "Preparing repair request";
      const fn = repairPhase === "repair_request" ? (preparing ? "repairing" : "repair_waiting_response")
        : repairPhase === "repair_validation" ? "validating_result" : "repairing";
      // Repair is a new phase after a terminal initial AI pass.
      if (next.ai.state !== "cancelled" && TERMINAL.has(next.ai.state))
        next.ai = { ...laneState(), queuedAt: now };
      runLane(next, "ai", now, { stage: detail, function: fn });
      next.result = { state: "pending", detail: "Repairing failed units", updatedAt: now };
    } else if (["applying", "apply_pending"].includes(repairPhase)) {
      finishLane(next, "ai", now, "done", "Repair AI complete");
      if (next.insert.state !== "cancelled" && TERMINAL.has(next.insert.state))
        next.insert = { ...laneState(), queuedAt: now };
      runLane(next, "insert", now, { stage: repairPhase === "applying" ? "Placing repair results" : "Repair result waiting to place", function: repairPhase === "applying" ? "repair_placing" : "repair_waiting_insert" });
      next.result = { state: "pending", detail: "Repair placement pending", updatedAt: now };
    } else if (repairPhase === "done") {
      // Repair is the authoritative terminal outcome for a deferred initial
      // failure. It may legitimately recover a lane that was previously marked
      // error, so do not let finishLane's terminal guard leave Total/AI stuck.
      for (const [name, detail] of [["ai", "Repair complete"], ["insert", "Repair placed"], ["overall", "Complete"]]) {
        const lane = next[name];
        if (lane.state === "cancelled") continue;
        if (!lane.startedAt) lane.startedAt = lane.queuedAt || now;
        lane.state = "done"; lane.finishedAt = now; lane.detail = detail;
      }
      const unresolved = Math.max(0, Number(patch?.pending) || 0);
      next.result = { state: unresolved ? "error" : "done",
        detail: unresolved ? `Repair complete · ${unresolved} unresolved unit(s)` : "Repair complete", updatedAt: now };
    } else if (["apply_failed", "unavailable", "blocked"].includes(repairPhase)) {
      const detail = repairPhase === "blocked" ? "Repair paused" : repairPhase === "apply_failed" ? "Repair placement failed" : "Repair unavailable";
      next.result = { state: "error", detail, updatedAt: now };
    }
  }
  const conversation = patch?.conversation;
  if (conversation && typeof conversation === "object") {
    const phase = String(conversation.phase || "");
    const turn = Number(conversation.turn) || 0;
    const pageCount = Number(conversation.pageCount) || 0;
    const unitCount = Number(conversation.unitCount) || 0;
    if (phase === "translating") {
      runLane(next, "ai", now, {
        stage: `Conversation turn ${turn || 1}: preparing ${pageCount || 1} page${pageCount === 1 ? "" : "s"}, ${unitCount} units`,
        function: "preparing_request", pageCount: pageCount || 1, unitCount, turn: turn || 1,
        queuedPageCount: Math.max(0, Number(conversation.queuedPageCount) || 0), conversation: true,
      });
    } else if (phase === "anchor_recovering") {
      runLane(next, "ai", now, { stage: `Conversation turn ${turn || 1}: recovering anchor`, function: "recovering_context", turn: turn || 1, conversation: true });
    } else if (phase === "turn_complete") {
      if (next.ai.state === "running") {
        next.ai.detail = `Conversation turn ${turn || 1} complete · preparing next turn`;
        next.ai.function = "preparing_next_turn";
      }
    } else if (phase === "turn_failed") {
      if (next.ai.state === "running") {
        next.ai.detail = `Conversation turn ${turn || 1}: defects · waiting for repair`;
        next.ai.function = "repair_waiting";
      }
    }
  }
  if (patch?.provider || patch?.model) {
    const provider = String(patch.provider || "").trim();
    const model = String(patch.model || "").trim();
    const suffix = [provider, model].filter(Boolean).join(" / ");
    if (provider) next.ai.provider = provider.slice(0, 48);
    if (model) next.ai.model = model.slice(0, 96);
    if (suffix && ["queued", "running"].includes(next.ai.state) && !next.ai.detail.includes(suffix)) {
      next.ai.detail = `${next.ai.detail || "AI"} · ${suffix}`.slice(0, 180);
    }
  }
  return next;
}

function duration(lane, now) {
  const started = Number(lane?.startedAt) || Number(lane?.queuedAt) || 0;
  if (!started) return 0;
  const end = Number(lane?.finishedAt) || now;
  return Math.max(0, end - started);
}

export function publicImageProgress(progress, now = Date.now()) {
  const source = ensure(progress, now);
  const out = { updatedAt: source.updatedAt, result: { ...source.result } };
  for (const lane of LANES) {
    out[lane] = { ...source[lane], elapsedMs: duration(source[lane], now) };
  }
  return out;
}
