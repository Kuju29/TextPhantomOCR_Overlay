export const SCHEMA_OBJECT_CONTRACT = "tp.translation.schema-object/1";
export const COMPACT_RECORDS_CONTRACT = "tp.translation.compact-records/1";

function exactIds(ids) {
  const values = (ids || []).map((value) => String(value || ""));
  if (!values.length || values.some((id, index) => id !== `P${index}`))
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
  void targetLang;
  if (contract?.kind === "schema_object")
    return "OUTPUT — tp.translation.schema-object/1\n" +
      "Return only the JSON object required by the supplied schema. " +
      `Its keys must be exactly ${values.join(", ")}; each value is that unit's complete non-empty translation. ` +
      "Do not add, omit, merge, split or rename records. Do not insert manual line breaks for visual layout.";
  return "OUTPUT — tp.translation.compact-records/1\n" +
    `Return every supplied ID exactly once as <<TP_Pn:translated text>>. Expected IDs: ${values.join(", ")}. ` +
    "Record order is irrelevant because results are matched by ID. Do not add, omit, merge, split or rename records. " +
    "Do not insert manual line breaks inside a payload. Return only the records, with no JSON, markdown, commentary or explanations.";
}
