import { instructionPack, formatInstruction } from "../prompt-language.js";
export const SCHEMA_OBJECT_CONTRACT = "tp.translation.schema-object/1";
export const COMPACT_RECORDS_CONTRACT = "tp.translation.compact-records/1";

function exactIds(ids) {
  const values = (ids || []).map((value) => String(value || ""));
  const legacy = values.every(id=>/^P[0-9]{1,6}$/.test(id));
  const image = values.every(id=>/^I[1-9][0-9]{0,6}_P[0-9]{1,6}$/.test(id));
  if (!values.length || (!legacy && !image) || new Set(values).size!==values.length)
    throw new TypeError("Translation output IDs must be one unique supported ID family");
  if (legacy && values.some((id,index)=>id!==`P${index}`))
    throw new TypeError("Translation output IDs must be contiguous P0..Pn");
  return values;
}

export function translationObjectSchema(ids) {
  const values = exactIds(ids);
  return {
    type: "object",
    properties: Object.fromEntries(values.map((id) => [id, { type: "string", minLength: 1 }])),
    required: values,
    additionalProperties: false,
  };
}

export function selectLocalOutputContract({ provider, model, modelCapabilities } = {}) {
  const providerId = String(provider || "").trim().toLowerCase();
  const modelId = String(model || "").trim();
  const structured = modelCapabilities?.structuredOutput;
  const supported = structured?.supported === true &&
    structured?.contract === SCHEMA_OBJECT_CONTRACT;
  if (supported) {
    return {
      kind: "schema_object",
      version: SCHEMA_OBJECT_CONTRACT,
      reason: String(structured.reason || "confirmed_provider_model_capability"),
      capabilitySource: String(structured.source || "model_capabilities"),
    };
  }
  return {
    kind: "compact_records",
    version: COMPACT_RECORDS_CONTRACT,
    reason: structured?.supported === false
      ? "provider_model_schema_unsupported"
      : "provider_model_schema_unconfirmed",
    capabilitySource: String(structured?.source || "none"),
    provider: providerId,
    model: modelId,
  };
}

export function exactOutputInstruction(ids, contract, targetLang = "") {
  const values = exactIds(ids);
  return formatInstruction(instructionPack(targetLang)[contract?.kind === "schema_object" ? "schemaOutput" : "markerOutput"], { ids: values.join(", ") });
}
