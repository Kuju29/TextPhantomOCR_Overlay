// Pure completion detector for TextPhantom's plain-record wire contract.
// Kept provider-neutral so Ollama and OpenAI-compatible transports cannot
// drift in when they decide a complete translation has arrived.
export function completedLineContract(text, expectedIds) {
  // Match the strict decoder: one terminal LF/CRLF is formatting; additional
  // blank records (and a lone terminal CR) must still fail completion.
  const source = String(text || "").replace(/\r?\n$/u, "").replace(/\r\n?/g, "\n");
  if (/[\u0085\u2028\u2029]/u.test(source)) return "";
  const records = source
    .split("\n")
    .map((line) => /^[ \t]*<<TP_(P\d+):(.*)>>[ \t]*$/u.exec(line));
  if (
    records.length === expectedIds.length &&
    records.every(Boolean) &&
    records.every((match) => match[2].trim() && !/<<TP_P\d+:/u.test(match[2]))
  ) {
    const ids = records.map((match) => match[1]);
    if (
      new Set(ids).size === ids.length &&
      ids.every((id) => expectedIds.includes(id))
    ) {
      return "all_id_records_closed";
    }
  }
  return "";
}
