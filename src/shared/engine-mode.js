// Keep the user's saved choice separate from the engine currently available
// to extension surfaces. Re-enabling runsapi should require changing only this
// flag; callers must never overwrite the saved preference as a fallback.
export const RUNS_API_AVAILABLE = false;

export function normalizeEngineModePreference(value) {
  return value === "api" ? "api" : "extension";
}

export function effectiveEngineMode(preference) {
  const normalized = normalizeEngineModePreference(preference);
  return RUNS_API_AVAILABLE ? normalized : "extension";
}
