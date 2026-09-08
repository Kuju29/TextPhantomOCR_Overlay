import { aggregateUsage } from "./ai/usage-values.js";
// Provider-agnostic per-image validation and one bounded repair generation.
export async function runContentValidatedTranslation({
  translate,
  units,
  operationBase,
  contentDefects,
  onGenerationAttempt = () => {},
  collectMemoryDelta = () => {},
  traceAttempt = () => {},
  traceScripts = () => {},
  warn = () => {},
  beforeRepair = async () => {},
  isCancelled = () => false,
  repair = { enabled: true },
  preserveWrongLanguagePartial = false,
}) {
  let outcome;
  let firstOutcome = null;
  let repairAttempted = false;
  let repairReason = "";
  const repairOperationId = `${operationBase}:repair-1`;
  const preserveValidatedPartial = (
    initialOutcome,
    initialDefects,
    repairFailure = null,
  ) => {
    const unresolved = new Set(
      [
        ...(initialDefects?.missing || []),
        ...(initialDefects?.wrongLanguage || []),
      ].map(String),
    );
    const translations = (initialOutcome?.translations || []).filter(
      (item) =>
        !unresolved.has(String(item?.id)) && String(item?.text || "").trim(),
    );
    if (!translations.length) return null;
    return {
      ...initialOutcome,
      translations,
      missing: [...unresolved],
      meta: {
        ...(initialOutcome?.meta || {}),
        repairAttempted: true,
        repairAccepted: false,
        repairReason,
        repairFailureCode: String(
          repairFailure?.code || "invalid_model_output",
        ),
        unresolvedIds: [...unresolved],
      },
    };
  };
  const combinedMeta = (initial = {}, repaired = {}) => {
    const a =
      initial?.usage && typeof initial.usage === "object" ? initial.usage : {};
    const b =
      repaired?.usage && typeof repaired.usage === "object"
        ? repaired.usage
        : {};
    const addTiming = (key) =>
      [initial?.[key], repaired?.[key]]
        .filter(Number.isFinite)
        .reduce((sum, value) => sum + Number(value), 0);
    return {
      ...initial,
      ...repaired,
      usage: aggregateUsage([a, b]),
      generationUsage: [a, b],
      providerMs: addTiming("providerMs"),
      providerParseMs: addTiming("providerParseMs"),
      providerHttpStatuses: [
        ...(Array.isArray(initial?.providerHttpStatuses)
          ? initial.providerHttpStatuses
          : []),
        ...(Array.isArray(repaired?.providerHttpStatuses)
          ? repaired.providerHttpStatuses
          : []),
      ],
      generationAttempts: 2,
      providerAttempts: 2,
    };
  };

  const throwIfCancelled = (phase) => {
    if (!isCancelled()) return;
    traceAttempt("cancelled", repairAttempted ? 2 : 1, {
      phase,
      cancelRequestedAt: Date.now(),
      repairSuppressedByCancel: phase === "repair_dispatch",
      requestAttempted: false,
      generationIntent: false,
    });
    throw new DOMException("The operation was aborted", "AbortError");
  };
  throwIfCancelled("initial_dispatch");
  traceAttempt("start", 1, { requestAttempted: true, generationIntent: true });
  try {
    outcome = await translate(units, operationBase);
  } catch (error) {
    throwIfCancelled("initial_response");
    // A selected-contract mismatch means the model used a different grammar.
    // Retrying that would hide the fault. Only decoded current-grammar
    // partials reach the subset-repair path below.
    const selectedContractMismatch =
      error?.code === "AI_OUTPUT_CONTRACT_MISMATCH";
    const structural =
      !selectedContractMismatch &&
      (error?.code === "invalid_model_output" ||
        error?.name === "ModelOutputContractError" ||
        Boolean(error?.structuralDetails || error?.diagnostics?.responseShape));
    if (
      repair?.enabled !== false &&
      structural &&
      Number(error?.generationAttempts || error?.providerAttempts || 1) > 0
    ) {
      firstOutcome = null;
      repairReason = "structurally_undecodable";
      traceAttempt("result", 1, {
        accepted: false,
        generationStarted: true,
        generationAttempts: Number(
          error?.generationAttempts || error?.providerAttempts || 1,
        ),
        code: String(error?.code || "invalid_model_output"),
        observedShape: String(error?.diagnostics?.observedShape || "unknown"),
        validatorSubtype: String(error?.diagnostics?.validatorSubtype || "unknown"),
        missingIds: Array.isArray(error?.diagnostics?.missingIds)
          ? error.diagnostics.missingIds
          : units.map((unit) => String(unit?.id)),
      });
      await beforeRepair({
        reason: repairReason,
        defectiveIds: units.map((u) => String(u?.id)),
        repairUnits: units,
      });
      throwIfCancelled("repair_dispatch");
      repairAttempted = true;
      traceAttempt("repair_start", 2, {
        reason: repairReason,
        requestAttempted: true,
        generationIntent: true,
        fullContext: true,
        unitCount: units.length,
      });
      outcome = await translate(units, repairOperationId);
      if (Number(outcome?.meta?.generationAttempts || 0) > 0)
        onGenerationAttempt();
      collectMemoryDelta(outcome);
      throwIfCancelled("repair_validation");
      const repairedDefects = contentDefects(outcome, units);
      traceAttempt("repair_result", 2, {
        reason: repairReason,
        accepted: !repairedDefects.invalid,
        generationStarted: Number(outcome?.meta?.generationAttempts || 0) > 0,
        generationAttempts: Number(outcome?.meta?.generationAttempts || 0),
        missingIds: repairedDefects.missing,
        wrongLanguageIds: repairedDefects.wrongLanguage,
      });
      if (repairedDefects.invalid)
        throw Object.assign(new Error("AI whole-image repair was invalid"), {
          code: "invalid_model_output",
          contentRepairAttempted: true,
          contentRepairReason: repairReason,
          generationAttempts:
            Number(error?.generationAttempts || 1) +
            Number(outcome?.meta?.generationAttempts || 1),
        });
      const initialMeta =
        error?.generationMeta ||
        error?.structuralDetails?.generationMeta ||
        error?.diagnostics?.generationMeta ||
        {};
      outcome = {
        ...outcome,
        meta: {
          ...combinedMeta(initialMeta, outcome?.meta || {}),
          repairAttempted: true,
          repairAccepted: true,
          repairReason,
          repairFullContext: true,
        },
      };
      return { outcome, firstOutcome, repairAttempted, repairReason };
    }
    // jobs.js historically owns a second malformed-output repair branch. This
    // sentinel tells that older caller the policy has already made its choice,
    // while accurately stating that no repair generation was attempted.
    if (
      repair?.enabled !== true &&
      Number(error?.generationAttempts || error?.providerAttempts || 0) > 0
    ) {
      error.contentRepairAttempted = true;
      error.contentRepairSkipped = true;
      error.contentRepairReason = "disabled_by_default";
    }
    throw error;
  }
  if (Number(outcome?.meta?.generationAttempts || 0) > 0) onGenerationAttempt();
  collectMemoryDelta(outcome);
  throwIfCancelled("initial_validation");
  traceScripts(outcome?.translations, "initial_response");
  firstOutcome = outcome;
  const defects = contentDefects(outcome, units);
  traceAttempt("result", 1, {
    generationStarted: Number(outcome?.meta?.generationAttempts || 0) > 0,
    generationAttempts: Number(outcome?.meta?.generationAttempts || 0),
    contractVersion: String(
      outcome?.meta?.associationContractVersion ||
        outcome?.meta?.contractVersion ||
        "",
    ),
    missingIds: defects.missing,
    wrongLanguageIds: defects.wrongLanguage,
    languageDiagnostics: defects.languageDiagnostics,
    accepted: !defects.invalid,
  });
  if (!defects.invalid)
    return { outcome, firstOutcome, repairAttempted, repairReason };

  repairReason = defects.wrongLanguage.length
    ? "wrong_target_script"
    : "missing_or_empty_units";
  if (repair?.enabled === false) {
    traceAttempt("repair_skipped", 2, {
      reason: repairReason,
      repairEnabled: false,
      requestAttempted: false,
      generationIntent: false,
      generationAttempts: 0,
      missingIds: defects.missing,
      wrongLanguageIds: defects.wrongLanguage,
      languageDiagnostics: defects.languageDiagnostics,
    });
    if (defects.wrongLanguage.length) {
      if (preserveWrongLanguagePartial)
        return { outcome, firstOutcome, repairAttempted, repairReason };
      throw Object.assign(
        new Error("AI output used the wrong target language"),
        {
          code: "wrong_language_output",
          generationAttempts: Number(outcome?.meta?.generationAttempts || 0),
          providerAttempts: Number(
            outcome?.meta?.providerAttempts ||
              outcome?.meta?.generationAttempts ||
              0,
          ),
          requestDispatched: true,
          providerResponded: true,
          contentRepairAttempted: false,
          contentRepairReason: "wrong_target_script",
          diagnostics: {
            validatorSubtype: "wrong_target_script",
            wrongLanguageIds: defects.wrongLanguage,
            languageDiagnostics: defects.languageDiagnostics,
          },
        },
      );
    }
    return { outcome, firstOutcome, repairAttempted, repairReason };
  }

  const defectiveIds = new Set(
    [...defects.missing, ...defects.wrongLanguage].map(String),
  );
  const repairUnits = units.filter((unit) =>
    defectiveIds.has(String(unit?.id)),
  );
  await beforeRepair({
    reason: repairReason,
    defectiveIds: [...defectiveIds],
    repairUnits,
  });
  throwIfCancelled("repair_dispatch");
  repairAttempted = true;
  traceAttempt("repair_start", 2, {
    reason: repairReason,
    requestAttempted: true,
    generationIntent: true,
    fullContext: false,
    unitCount: repairUnits.length,
    defectiveIds: [...defectiveIds],
  });
  try {
    const repaired = await translate(repairUnits, repairOperationId);
    if (Number(repaired?.meta?.generationAttempts || 0) > 0)
      onGenerationAttempt();
    throwIfCancelled("repair_validation");
    const repairedDefects = contentDefects(repaired, repairUnits);
    traceScripts(repaired?.translations, "repair_response");
    traceAttempt("repair_result", 2, {
      reason: repairReason,
      generationStarted: Number(repaired?.meta?.generationAttempts || 0) > 0,
      generationAttempts: Number(repaired?.meta?.generationAttempts || 0),
      contractVersion: String(
        repaired?.meta?.associationContractVersion ||
          repaired?.meta?.contractVersion ||
          "",
      ),
      missingIds: repairedDefects.missing,
      wrongLanguageIds: repairedDefects.wrongLanguage,
      languageDiagnostics: repairedDefects.languageDiagnostics,
      accepted: !repairedDefects.invalid,
    });
    throwIfCancelled("merge");
    const unresolvedRepair = new Set([
      ...(repairedDefects.missing || []),
      ...(repairedDefects.wrongLanguage || []),
    ].map(String));
    const counts = new Map();
    for (const item of repaired.translations || []) {
      const id = String(item?.id);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    // Salvage only unique, requested, individually validated records. A
    // duplicate poisons that ID; an extra ID never crosses the merge boundary.
    const repairedById = new Map((repaired.translations || [])
      .filter((item) => {
        const id = String(item?.id);
        return defectiveIds.has(id) && counts.get(id) === 1 &&
          !unresolvedRepair.has(id) && String(item?.text || "").trim();
      })
      .map((item) => [String(item.id), item]));
    const initialById = new Map((outcome.translations || [])
      .filter((item) => !defectiveIds.has(String(item?.id)))
      .map((item) => [String(item.id), item]));
    const translations = units.map((unit) =>
      defectiveIds.has(String(unit.id))
        ? repairedById.get(String(unit.id))
        : initialById.get(String(unit.id))).filter(Boolean);
    const returned = new Set(translations.map((item) => String(item.id)));
    const missing = units.filter((unit) => !returned.has(String(unit.id)))
      .map((unit) => String(unit.id));
    if (!translations.length)
      throw Object.assign(new Error(
        repairReason === "wrong_target_script"
          ? "AI returned every translatable unit outside the selected target language"
          : "AI content repair left no valid translations",
      ), {
        code: repairReason === "wrong_target_script"
          ? "wrong_language_output"
          : "invalid_model_output",
        contentRepairAttempted: true,
        contentRepairReason: repairReason,
        diagnostics: repairReason === "wrong_target_script"
          ? {
              validatorSubtype: "wrong_target_script",
              rejectedUnits: units.length,
              expectedUnits: units.length,
              repairAttempted: true,
            }
          : undefined,
        generationMeta: combinedMeta(outcome?.meta || {}, repaired?.meta || {}),
      });
    outcome = {
      ...outcome,
      translations,
      missing,
      meta: {
        ...combinedMeta(outcome?.meta || {}, repaired?.meta || {}),
        repairAttempted: true,
        repairAccepted: missing.length === 0,
        repairReason,
        unresolvedIds: missing,
      },
    };
    if (!missing.length) collectMemoryDelta(repaired);
    else warn(Object.assign(new Error("AI content repair left unresolved units"), {
      code: "invalid_model_output", diagnostics: { missingIds: missing },
    }));

  } catch (repairError) {
    if (repairError?.name === "AbortError" || isCancelled()) throw repairError;
    traceAttempt("repair_result", 2, {
      reason: repairReason,
      accepted: false,
      generationStarted: Number(repairError?.generationAttempts || 0) > 0,
      generationAttempts: Number(repairError?.generationAttempts || 0),
      code: String(repairError?.code || ""),
      ...(repairError?.diagnostics &&
      typeof repairError.diagnostics === "object"
        ? repairError.diagnostics
        : {}),
    });
    warn(repairError);
    const partial = preserveValidatedPartial(outcome, defects, repairError);
    if (!partial) throw repairError;
    outcome = partial;
  }
  return { outcome, firstOutcome, repairAttempted, repairReason };
}
