export class LocalAiError extends Error {
  constructor(
    message,
    {
      code = "local_ai_error",
      status = 0,
      retryable = false,
      attempted = false,
      diagnostics = null,
    } = {},
  ) {
    super(message);
    this.name = "LocalAiError";
    this.code = code;
    this.status = Number(status) || 0;
    this.retryable = retryable === true;
    this.providerAttempts = attempted ? 1 : 0;
    this.generationAttempts = attempted ? 1 : 0;
    this.requestDispatched = attempted === true;
    this.providerResponded = false;
    if (diagnostics && typeof diagnostics === "object")
      this.diagnostics = diagnostics;
  }
}
