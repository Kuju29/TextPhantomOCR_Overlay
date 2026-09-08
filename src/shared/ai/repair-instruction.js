/** Trusted per-attempt instructions; never changes the user's saved Style. */
export function wrongLanguageRepairInstruction(targetInstruction, reason = '') {
  if (reason !== 'wrong_target_script') return '';
  return 'REPAIR — WRONG TARGET LANGUAGE\n' +
    'The previous response for these failed units was rejected because it used the wrong target language.\n' +
    String(targetInstruction) + '\n' +
    'Translate the supplied failed units afresh, including titles and dialogue. Render source-script names in the target writing system when appropriate. Do not echo the source or leave foreign-script prose in the translation.\n' +
    'Keep every supplied ID exactly once and obey the existing output contract. Return translations only, with no explanation of the repair.';
}
